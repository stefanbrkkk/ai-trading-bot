/**
 * Assembles the risk-evaluation context for an order.
 *
 * Shared by the pre-flight preview and the routing endpoint so that the preview a
 * user sees and the decision that actually gates their order are produced from
 * the *same* inputs. If those diverged, the preview would be a guess, and a user
 * who was told "approved" and then rejected would have a legitimate complaint.
 *
 * The only difference between the two paths is `commit`: the preview reserves
 * nothing, so opening the ticket cannot consume a user's daily notional quota or
 * burn an idempotency key.
 */

import { averageDailyVolume } from '@/lib/quant/indicators';
import { resolveMarketProvider } from '@/lib/market/provider';
import { requireSpec, symbolMeta } from '@/lib/market/universe';
import { fromNewYork, isMarketOpen, toNewYork } from '@/lib/market/calendar';
import { getBroker } from '@/lib/broker';
import { ADV_LOOKBACK_DAYS, type RiskEvaluationContext, verifyIntentToken } from '@/lib/risk';
import { ceilingReferencePrice, orderNotionalUsd } from '@/lib/risk/engine';
import {
  acceptedNotionalUsdSince,
  idempotencyKeySeen,
  killSwitchState,
  listOpenOrders,
  recordIdempotencyKey,
} from '@/lib/db';
import { entitlement } from '@/lib/auth/session';
import type { AccountSnapshot, ClickProvenance, OrderIntent, Quote, User } from '@/lib/domain/types';

/**
 * How far back a key is remembered. A day is longer than any legitimate retry
 * window and short enough that the table stays small.
 */
const IDEMPOTENCY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * UTC millisecond of 00:00 New York on the calendar day containing `utcMs`.
 *
 * The exchange-local day is the window every daily allowance in the platform is
 * measured over, and it is not the UTC day and not the trading session. See the
 * note at its use site for what anchoring one of these counters at the 09:30
 * open did to it.
 */
function newYorkDayStart(utcMs: number): number {
  const parts = toNewYork(utcMs);
  return fromNewYork(parts.year, parts.month, parts.day, 0);
}

/**
 * The notional an approved order charges against its user's daily allowance.
 *
 * Not the figure the ticket displays, and the difference is the point. The
 * ticket shows `notionalReferencePrice` — the price the user typed, or the last
 * trade for a market order — because that is the number they entered and are
 * owed. Every ceiling in `evaluateOrder` is measured against something else:
 * `ceilingReferencePrice`, the worst price the order can credibly transact at,
 * so a marketable sell limit is sized at the bid it would hit rather than at the
 * limit it was typed at.
 *
 * The daily allowance is enforced by summing the `notional_cents` column of the
 * orders ledger — that row *is* the running total, which is why the engine's
 * `DailyNotionalPort.add` has nothing to add to — so this is what the routing
 * endpoint has to write into it. Persisting the stated price instead made the
 * platform check in one currency and charge in another: the engine tested a
 * marketable SELL 700 AAPL @ 133.61 against the bid, $99,225, and the ledger
 * recorded the $93,527 the limit implied. At 6.1% an order that compounds —
 * fifty-four such orders showed $498,584 of usage while carrying $530,475 of
 * credible exposure, all of it under a published $500,000 brake.
 *
 * It lives here, beside the port that reads the column back, so there is exactly
 * one definition of the figure rather than two that can drift apart.
 * `ceilingReferencePrice` already falls back to the user's own price when the
 * quote offers no side to take, and returns null only when the order cannot be
 * priced at all — the case the engine fails closed on long before an approval.
 */
export function quotaNotionalUsd(intent: OrderIntent, quote: Quote | null): number | null {
  const reference = ceilingReferencePrice(intent, quote);
  return reference === null ? null : orderNotionalUsd(intent, reference);
}

export interface OrderContextInput {
  user: User;
  intent: OrderIntent;
  click: ClickProvenance | null;
  intentToken: string | null;
  idempotencyKey: string | null;
  correlationId: string;
  /** True for the routing endpoint, false for the preview. */
  commit: boolean;
  now?: number;
}

export interface OrderContextResult {
  context: RiskEvaluationContext;
  quote: Quote | null;
  account: AccountSnapshot | null;
  adv30: number;
  /** Why the account snapshot is missing, when it is. */
  accountError: string | null;
}

/**
 * The 30-day ADV used by the liquidity limiter.
 *
 * Measured from the actual bar history rather than read from the universe
 * metadata, because the limiter's whole purpose is to reflect *current* tradable
 * liquidity rather than the figure the universe was built with.
 *
 * The distinction that matters is between "we could not measure" and "we
 * measured, and it is zero". Those are not the same fact, and treating them
 * alike is what made this function wrong: `if (measured > 0)` sent both down the
 * fallback path, so a name that had genuinely stopped trading — halted,
 * delisted, or simply never printing — was handed the published figure from the
 * universe spec and passed the participation check as though it were liquid.
 *
 * So a measurement is now trusted whenever one was possible, zero included, and
 * the published figure is reached only when there is no history to measure. The
 * engine denies on a zero ADV, which is what the mandate requires; that arm is
 * now reachable, where before the fallback made it dead code for every symbol in
 * the universe.
 */
async function resolveAdv(symbol: string, now: number): Promise<number> {
  try {
    const provider = resolveMarketProvider();
    const bars = await provider.dailyBars(symbol, { limit: ADV_LOOKBACK_DAYS + 5, endAt: now });
    if (bars.length > 0) return averageDailyVolume(bars, ADV_LOOKBACK_DAYS);
  } catch {
    // No history to measure — fall through to the published figure.
  }
  try {
    return symbolMeta(requireSpec(symbol)).adv30;
  } catch {
    // Not in the universe at all. Deny.
    return 0;
  }
}

export async function buildOrderContext(input: OrderContextInput): Promise<OrderContextResult> {
  const now = input.now ?? Date.now();
  const symbol = input.intent.symbol.toUpperCase();
  const provider = resolveMarketProvider();
  const broker = getBroker();
  const gate = entitlement(input.user);

  const [quote, adv30, accountResult] = await Promise.all([
    provider.quote(symbol, now).catch(() => null),
    resolveAdv(symbol, now),
    broker
      .getAccount(input.intent.account, {
        correlationId: input.correlationId,
        userId: input.user.id,
        dispatchedAt: now,
      })
      .catch(() => null),
  ]);

  const account = accountResult?.data ?? null;
  const accountError = account
    ? null
    : (accountResult?.error ??
      'The broker did not return an account snapshot, so the pre-trade margin check cannot pass.');

  // Verify without consuming on the preview path; the routing endpoint consumes.
  const verification =
    input.intentToken === null
      ? null
      : verifyIntentToken(
          input.intentToken,
          {
            userId: input.user.id,
            symbol,
            side: input.intent.side,
            quantity: input.intent.quantity,
            orderType: input.intent.type,
          },
          { now, consume: input.commit },
        );

  /*
   * Every order still working, not only the ones marked 'submitted'.
   *
   * The open-order cap is sold on bounding the size of the worst-case unwind,
   * and the unwind the kill switch actually performs walks 'pending_risk',
   * 'submitted' and 'partially_filled'. `listOpenOrders` is that same set, which
   * is the point: the cap and the unwind must be counting the same rows.
   *
   * Counting only 'submitted' made a partial fill invisible to it. The paper
   * book fills what the touch can absorb and leaves the remainder resting —
   * a 15,277-share BYND order filled 1,787 and left 13,490 working — nothing in
   * the platform ever transitions that row further, and 'partially_filled' is
   * not a terminal status, so those orders sit in the unwind list and accumulate
   * across sessions while the cap reads them as zero.
   */
  const openOrderCount = listOpenOrders(input.user.id).filter(
    (order) => order.account === input.intent.account,
  ).length;

  /*
   * The exchange-local calendar day, not the UTC day and not the session.
   *
   * A UTC midnight boundary would reset a user's allowance at 20:00 ET, four
   * hours into the after-hours window and eight hours before the next open. So
   * the window is a New York one — but it starts at New York midnight, not at
   * the 09:30 open, and that distinction is the whole of a defect this line
   * carried. `sessionOpen(now)` is a *future* instant for every pre-market
   * request, and the ledger sums `created_at >= since`, so a row written at
   * 08:00 ET was excluded from the total not merely until 09:30 but for the rest
   * of the day. Twenty resting day orders totalling $1.99M were accepted
   * pre-market against a published $500,000 ceiling while `usedUsd` read zero
   * throughout, and still read zero when re-queried that afternoon; the only
   * control that ever fired was the open-order cap.
   *
   * `InMemoryDailyNotionalStore`, the reference implementation the unit tests
   * drive the engine with, has always bucketed by New York calendar date. This
   * is that same window, so the two implementations no longer disagree about
   * what a day is.
   */
  const dayStart = newYorkDayStart(now);

  /*
   * Both ports are backed by the orders ledger, which is the only record that
   * survives a restart. In-memory implementations exist for the unit tests; a
   * process that restarts mid-session must not hand every user a fresh $500,000.
   *
   * `add` is a genuine no-op, and the reason is worth stating precisely because
   * the engine calls it under a comment about reserving quota: `usedUsd` sums
   * the `notional_cents` column, so the order row the routing endpoint persists
   * *is* the running total and there is no second place to add to. That endpoint
   * therefore writes that column at the ceiling reference price — the same
   * figure `evaluateOrder` measures the ceiling against — because a quota
   * checked in one currency and charged in another is not a quota.
   *
   * `record` is a no-op on the preview path for the same reason opening a ticket
   * must not consume an allowance: the preview reserves nothing.
   */
  const dailyNotional = {
    usedUsd: (userId: string, atMs: number): number =>
      acceptedNotionalUsdSince(userId, newYorkDayStart(atMs)),
    add: (): void => {
      // The order row is the running total; there is nothing separate to add to.
    },
  };

  const idempotency = {
    seen: (key: string): boolean => idempotencyKeySeen(key, dayStart - IDEMPOTENCY_LOOKBACK_MS),
    record: (key: string, atMs: number): void => {
      if (!input.commit) return;
      recordIdempotencyKey(key, input.user.id, atMs, null);
    },
  };

  const context: RiskEvaluationContext = {
    userId: input.user.id,
    correlationId: input.correlationId,
    now,
    killSwitchEngaged: safeKillSwitch(),
    subscription: { status: gate.status, liveTradingUnlocked: gate.live },
    click: input.click,
    intentToken: verification,
    instrument: { tradable: isTradable(symbol), adv30 },
    marketOpen: isMarketOpen(now),
    openOrderCount,
    idempotencyKey: input.idempotencyKey,
    dailyNotional,
    idempotency,
    quote,
    account,
    requestingSpiffeId: 'spiffe://aurelius.local/ns/platform/sa/api-gateway',
    commit: input.commit,
  };

  return { context, quote, account, adv30, accountError };
}

function isTradable(symbol: string): boolean {
  try {
    const spec = requireSpec(symbol);
    // The benchmark ETF is published for reference but is not part of the
    // tradable set, so an order against it is rejected rather than routed.
    return !spec.isBenchmark;
  } catch {
    return false;
  }
}

function safeKillSwitch(): boolean {
  try {
    return killSwitchState().engaged;
  } catch {
    return false;
  }
}
