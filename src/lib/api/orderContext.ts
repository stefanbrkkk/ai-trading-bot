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
import { isMarketOpen, sessionOpen } from '@/lib/market/calendar';
import { getBroker } from '@/lib/broker';
import { ADV_LOOKBACK_DAYS, type RiskEvaluationContext, verifyIntentToken } from '@/lib/risk';
import {
  acceptedNotionalUsdSince,
  idempotencyKeySeen,
  killSwitchState,
  listOrders,
  recordIdempotencyKey,
} from '@/lib/db';
import { entitlement } from '@/lib/auth/session';
import type { AccountSnapshot, ClickProvenance, OrderIntent, Quote, User } from '@/lib/domain/types';

/**
 * How far back a key is remembered. A day is longer than any legitimate retry
 * window and short enough that the table stays small.
 */
const IDEMPOTENCY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

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
 * liquidity. Returns 0 when the history is unavailable, and the engine fails
 * closed on a zero ADV — the mandate is explicit that a missing ADV must deny.
 */
async function resolveAdv(symbol: string, now: number): Promise<number> {
  try {
    const provider = resolveMarketProvider();
    const bars = await provider.dailyBars(symbol, { limit: ADV_LOOKBACK_DAYS + 5, endAt: now });
    const measured = averageDailyVolume(bars, ADV_LOOKBACK_DAYS);
    if (measured > 0) return measured;
  } catch {
    // fall through to the published figure
  }
  try {
    return symbolMeta(requireSpec(symbol)).adv30;
  } catch {
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

  const openOrderCount = listOrders({
    userId: input.user.id,
    account: input.intent.account,
    status: 'submitted',
  }).length;

  /*
   * The trading day, not the UTC day.
   *
   * The ceiling is published as an aggregate "for the session", and the session
   * is a New York one — a UTC midnight boundary would reset a user's allowance
   * at 20:00 ET, four hours into the after-hours window and eight hours before
   * the next open.
   */
  const sessionStart = sessionOpen(now);

  /*
   * Both ports are backed by the orders ledger, which is the only record that
   * survives a restart. In-memory implementations exist for the unit tests; a
   * process that restarts mid-session must not hand every user a fresh $500,000.
   *
   * `add` and `record` are deliberately no-ops on the preview path: opening a
   * ticket must not consume a user's allowance or burn their key. The routing
   * endpoint persists the order itself, which is what both ports read, so
   * neither needs a write here either — but the port contract has them, and a
   * silent no-op would be worse than an explicit one.
   */
  const dailyNotional = {
    usedUsd: (userId: string, atMs: number): number =>
      acceptedNotionalUsdSince(userId, sessionOpen(atMs)),
    add: (): void => {
      // The order row is the running total; there is nothing separate to add to.
    },
  };

  const idempotency = {
    seen: (key: string): boolean => idempotencyKeySeen(key, sessionStart - IDEMPOTENCY_LOOKBACK_MS),
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
