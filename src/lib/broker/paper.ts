/**
 * The paper broker — the default execution venue.
 *
 * BUILD_CONTRACT requires the platform to be fully functional with an empty
 * `.env`, and the compliance mandate requires a 14-day paper sandbox before live
 * routing is unlocked. This adapter is therefore not a mock: it holds real cash,
 * real signed positions, real average entries and real realised P&L, and it fills
 * against the supplied NBBO through an explicit microstructure model. A stub that
 * always filled at the mid would make every downstream number — the account
 * snapshot the risk engine's buying-power check reads, the P&L the UI shows —
 * quietly fictional.
 *
 * The fill model has three parts, and all three are deterministic:
 *
 *   TOUCH PRICING     A buy pays the offer, a sell receives the bid. Nothing
 *                     crosses at the mid, because nothing crosses at the mid.
 *   IMPACT            Slippage grows with the square root of participation in the
 *                     displayed size at the touch, the standard concave impact
 *                     shape. Always adverse — a paper account that occasionally
 *                     got a better price than the market would flatter every
 *                     backtest that reads it.
 *   PARTIAL FILLS     An order larger than the depth reachable at the touch fills
 *                     what is there and rests as `partially_filled`.
 *
 * Randomness comes from `createRng` seeded per client order id, so a given order
 * always produces the same fill regardless of how many orders preceded it. That
 * is what makes the forensic ledger reproducible.
 */

import type {
  AccountSnapshot,
  OrderStatus,
  Position,
  Quote,
} from '@/lib/domain/types';
import { isoDate } from '@/lib/market/calendar';
import { createRng } from '@/lib/quant/rng';
import { clamp } from '@/lib/quant/stats';
import { MAINTENANCE_MARGIN_RATE } from '@/lib/risk/limits';
import {
  InMemoryBrokerState,
  isTerminalStatus,
  type BrokerAdapter,
  type BrokerCallContext,
  type BrokerCancelAck,
  type BrokerDescriptor,
  type BrokerOrderAck,
  type BrokerOrderRequest,
  type BrokerResult,
  type BrokerStatePort,
  type PaperAccountState,
  type PaperOrderRecord,
  type QuoteSource,
} from '@/lib/broker/types';

// ─────────────────────────────────────────────────────────────────────────────
//  Model parameters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PLATFORM POLICY. Opening sandbox balance. Deliberately not $100,000: that is
 * the figure in the mandate's prohibited-advice example (5% of a $100,000 balance
 * = $5,000), and reusing it in the codebase would invite exactly the confusion
 * the prohibition is about.
 */
export const PAPER_STARTING_CASH_USD = 250_000;

/** Fixed cost of crossing, in basis points — latency and fee drag at the touch. */
export const PAPER_BASE_SLIPPAGE_BPS = 1;

/** Impact coefficient: bps of slippage at 100% participation in the touch. */
export const PAPER_IMPACT_BPS = 8;

/** Standard deviation of the seeded slippage jitter, in basis points. */
export const PAPER_SLIPPAGE_NOISE_BPS = 0.75;

/** Cap on modelled slippage, so a thin quote cannot produce an absurd fill. */
export const PAPER_MAX_SLIPPAGE_BPS = 75;

/**
 * Depth reachable in a single instant, as a multiple of the displayed size at the
 * touch. Above this the order fills what is available and rests — which is how a
 * real order behaves, and is what makes the partial-fill path exercisable.
 */
export const PAPER_TOUCH_DEPTH_MULTIPLE = 2.5;

/** Retail equity commission. Zero, matching the named API partners. */
export const PAPER_COMMISSION_PER_SHARE = 0;

export interface PaperBrokerOptions {
  state?: BrokerStatePort;
  /** NBBO source. Without it the broker reports market data unavailable. */
  quotes?: QuoteSource;
  clock?: () => number;
  /** Seed prefix for the slippage stream. */
  seed?: string;
  startingCashUsd?: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isoStamp(ms: number): string {
  return new Date(ms).toISOString();
}

function ok<T>(
  status: number,
  body: Record<string, unknown>,
  data: T,
  latencyMs: number,
  requestPayload: Record<string, unknown> | null,
): BrokerResult<T> {
  return {
    ok: true,
    status,
    body,
    data,
    error: null,
    latencyMs,
    requestPayload,
    rawRequest: requestPayload === null ? null : JSON.stringify(requestPayload),
  };
}

function refused<T>(
  status: number,
  body: Record<string, unknown>,
  latencyMs: number,
  requestPayload: Record<string, unknown> | null,
  error: string | null = null,
): BrokerResult<T> {
  return {
    ok: false,
    status,
    body,
    data: null,
    error,
    latencyMs,
    requestPayload,
    rawRequest: requestPayload === null ? null : JSON.stringify(requestPayload),
  };
}

interface FillPlan {
  /** Shares filled immediately; 0 when the order rests. */
  quantity: number;
  price: number;
  slippageBps: number;
  /** True when a stop was breached by the last trade. */
  triggered: boolean;
}

export class PaperBroker implements BrokerAdapter {
  readonly name = 'paper' as const;
  readonly mode = 'paper' as const;

  private readonly state: BrokerStatePort;
  private readonly quotes: QuoteSource | undefined;
  private readonly clock: () => number;
  private readonly seed: string;
  private readonly startingCash: number;

  constructor(options: PaperBrokerOptions = {}) {
    this.state = options.state ?? new InMemoryBrokerState();
    this.quotes = options.quotes;
    this.clock = options.clock ?? (() => Date.now());
    this.seed = options.seed ?? 'aurelius-paper-broker';
    this.startingCash = options.startingCashUsd ?? PAPER_STARTING_CASH_USD;
  }

  describe(): BrokerDescriptor {
    return {
      name: this.name,
      mode: this.mode,
      endpoint: 'in-process',
      supportsCancel: true,
      supportsFractional: false,
    };
  }

  async submitOrder(
    request: BrokerOrderRequest,
    ctx: BrokerCallContext,
  ): Promise<BrokerResult<BrokerOrderAck>> {
    const start = this.clock();
    const now = ctx.dispatchedAt ?? start;
    const payload = outboundPayload(request);

    // Kill-switch severance. The mandate requires active outbound POSTs to be cut
    // rather than completed, and 503 is the mandated status for a halted platform.
    if (ctx.signal?.aborted === true) {
      return refused(
        503,
        { message: '503 Service Unavailable', code: 'routing_halted' },
        0,
        payload,
      );
    }

    // A simulator must never be presented as a live venue.
    if (request.account === 'live') {
      return refused(
        403,
        { message: 'live routing is not available on the paper broker', code: 'wrong_account' },
        0,
        payload,
      );
    }

    if (this.state.getOrder(paperOrderId(request.clientOrderId)) !== null) {
      return refused(
        409,
        { message: 'client order id has already been used', code: 'duplicate_client_order_id' },
        0,
        payload,
      );
    }

    const quote = this.quotes?.(request.symbol, now) ?? null;
    if (quote === null) {
      return refused(
        422,
        { message: `market data unavailable for ${request.symbol}`, code: 'no_market_data' },
        0,
        payload,
      );
    }

    const plan = this.planFill(request, quote);
    const account = this.loadOrSeed(request.account, ctx.userId, now);

    if (plan.quantity > 0) {
      this.applyFill(account, request, plan, now);
      this.state.saveAccount(ctx.userId, account);
    }

    const status: OrderStatus =
      plan.quantity === 0
        ? 'submitted'
        : plan.quantity < request.quantity
          ? 'partially_filled'
          : 'filled';

    const record: PaperOrderRecord = {
      brokerOrderId: paperOrderId(request.clientOrderId),
      clientOrderId: request.clientOrderId,
      account: request.account,
      userId: ctx.userId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      quantity: request.quantity,
      filledQuantity: plan.quantity,
      averageFillPrice: plan.quantity > 0 ? plan.price : null,
      limitPrice: request.limitPrice,
      stopPrice: request.stopPrice,
      timeInForce: request.timeInForce,
      status,
      submittedAt: now,
      updatedAt: now,
      slippageBps: plan.slippageBps,
    };
    this.state.putOrder(record);

    const ack: BrokerOrderAck = {
      brokerOrderId: record.brokerOrderId,
      clientOrderId: record.clientOrderId,
      status,
      filledQuantity: record.filledQuantity,
      averageFillPrice: record.averageFillPrice,
      acknowledgedAt: now,
    };

    return ok(200, orderBody(record, plan.triggered), ack, this.clock() - start, payload);
  }

  async cancelOrder(
    brokerOrderId: string,
    ctx: BrokerCallContext,
  ): Promise<BrokerResult<BrokerCancelAck>> {
    const start = this.clock();
    const now = ctx.dispatchedAt ?? start;
    const record = this.state.getOrder(brokerOrderId);

    if (record === null) {
      return refused(404, { message: 'order not found', code: 'not_found' }, 0, null);
    }
    if (isTerminalStatus(record.status)) {
      // 422 mirrors the broker behaviour the kill switch has to tolerate: a
      // resting order that filled a millisecond before the halt cannot be pulled
      // back, and the ledger records the refusal rather than pretending it worked.
      return refused(
        422,
        { message: `order is not cancelable in status ${record.status}`, code: 'not_cancelable' },
        0,
        null,
      );
    }

    const cancelled: PaperOrderRecord = { ...record, status: 'canceled', updatedAt: now };
    this.state.putOrder(cancelled);
    const ack: BrokerCancelAck = {
      brokerOrderId,
      status: 'canceled',
      canceledAt: now,
    };
    return ok(200, orderBody(cancelled, false), ack, this.clock() - start, null);
  }

  async getAccount(
    account: 'paper' | 'live',
    ctx: BrokerCallContext,
  ): Promise<BrokerResult<AccountSnapshot>> {
    const start = this.clock();
    const now = ctx.dispatchedAt ?? start;
    if (account === 'live') {
      return refused(
        403,
        { message: 'live account is not available on the paper broker', code: 'wrong_account' },
        0,
        null,
      );
    }
    const snapshot = this.snapshot(account, ctx.userId, now);
    return ok(200, accountBody(snapshot), snapshot, this.clock() - start, null);
  }

  async getPositions(
    account: 'paper' | 'live',
    ctx: BrokerCallContext,
  ): Promise<BrokerResult<Position[]>> {
    const start = this.clock();
    const now = ctx.dispatchedAt ?? start;
    if (account === 'live') {
      return refused(
        403,
        { message: 'live account is not available on the paper broker', code: 'wrong_account' },
        0,
        null,
      );
    }
    const positions = this.snapshot(account, ctx.userId, now).positions;
    return ok(
      200,
      { positions: positions.map((p) => ({ symbol: p.symbol, qty: p.quantity })) },
      positions,
      this.clock() - start,
      null,
    );
  }

  /** Resting orders, for the kill switch's unwind list and the blotter. */
  openOrders(account: 'paper' | 'live', userId: string): PaperOrderRecord[] {
    return this.state
      .listOrders(account, userId)
      .filter((o) => o.status === 'submitted' || o.status === 'partially_filled');
  }

  /** Account snapshot in domain form, marked at the supplied instant. */
  snapshot(account: 'paper' | 'live', userId: string, atMs: number): AccountSnapshot {
    const state = this.loadOrSeed(account, userId, atMs);
    const positions: Position[] = state.positions.map((p) => {
      const quote = this.quotes?.(p.symbol, atMs) ?? null;
      const marketPrice = quote !== null && quote.last > 0 ? quote.last : p.averageEntry;
      const marketValue = p.quantity * marketPrice;
      const unrealisedPnl = p.quantity * (marketPrice - p.averageEntry);
      const denominator = Math.abs(p.quantity * p.averageEntry);
      return {
        symbol: p.symbol,
        quantity: p.quantity,
        averageEntry: round2(p.averageEntry),
        marketPrice: round2(marketPrice),
        marketValue: round2(marketValue),
        unrealisedPnl: round2(unrealisedPnl),
        unrealisedPnlPercent: denominator > 0 ? unrealisedPnl / denominator : 0,
        realisedPnl: round2(p.realisedPnl),
        openedAt: p.openedAt,
        account,
      };
    });

    const marketValueTotal = positions.reduce((acc, p) => acc + p.marketValue, 0);
    const grossExposure = positions.reduce((acc, p) => acc + Math.abs(p.marketValue), 0);
    const equity = state.cash + marketValueTotal;
    const unrealisedTotal = positions.reduce((acc, p) => acc + p.unrealisedPnl, 0);

    // Roll the day-P&L baseline on the first read of a new New York session, so
    // the figure means "since this session opened" rather than "since inception".
    const today = isoDate(atMs);
    if (state.dayKey !== today) {
      state.dayKey = today;
      state.dayStartEquity = equity;
      this.state.saveAccount(userId, state);
    }

    return {
      account,
      cash: round2(state.cash),
      equity: round2(equity),
      // Settled cash only. The sandbox extends no margin: an account that
      // pretended to have leverage would let the risk engine's buying-power check
      // approve orders the real account could not fund.
      buyingPower: round2(Math.max(0, state.cash)),
      grossExposure: round2(grossExposure),
      netExposure: round2(marketValueTotal),
      maintenanceMargin: round2(grossExposure * MAINTENANCE_MARGIN_RATE),
      dayPnl: round2(equity - state.dayStartEquity),
      totalPnl: round2(state.realisedPnl + unrealisedTotal),
      positions,
      updatedAt: atMs,
    };
  }

  private loadOrSeed(
    account: 'paper' | 'live',
    userId: string,
    atMs: number,
  ): PaperAccountState {
    const existing = this.state.loadAccount(account, userId);
    if (existing !== null) return existing;
    const seeded: PaperAccountState = {
      account,
      cash: this.startingCash,
      realisedPnl: 0,
      positions: [],
      dayKey: isoDate(atMs),
      dayStartEquity: this.startingCash,
    };
    this.state.saveAccount(userId, seeded);
    return seeded;
  }

  /**
   * Decides what fills, at what price.
   *
   * Marketable-limit orders never fill worse than their limit — that is the
   * contract of a limit order, and violating it would mean the platform executed
   * outside a user-supplied parameter.
   */
  private planFill(request: BrokerOrderRequest, quote: Quote): FillPlan {
    const buy = request.side === 'buy';
    const touchPrice = buy ? quote.ask : quote.bid;
    const touchSize = buy ? quote.askSize : quote.bidSize;
    if (!(touchPrice > 0)) return { quantity: 0, price: 0, slippageBps: 0, triggered: false };

    const stopTriggered =
      request.stopPrice === null
        ? true
        : buy
          ? quote.last >= request.stopPrice
          : quote.last <= request.stopPrice;

    let marketable: boolean;
    switch (request.type) {
      case 'market':
        marketable = true;
        break;
      case 'limit':
        marketable =
          request.limitPrice !== null &&
          (buy ? quote.ask <= request.limitPrice : quote.bid >= request.limitPrice);
        break;
      case 'stop':
        marketable = stopTriggered;
        break;
      case 'stop_limit':
        marketable =
          stopTriggered &&
          request.limitPrice !== null &&
          (buy ? quote.ask <= request.limitPrice : quote.bid >= request.limitPrice);
        break;
      default:
        marketable = false;
        break;
    }

    if (!marketable) {
      return { quantity: 0, price: 0, slippageBps: 0, triggered: stopTriggered };
    }

    const reachable = Math.max(1, Math.floor(Math.max(1, touchSize) * PAPER_TOUCH_DEPTH_MULTIPLE));
    const fillQuantity = Math.min(request.quantity, reachable);

    const rng = createRng(`${this.seed}:fill:${request.clientOrderId}`);
    const participation = fillQuantity / Math.max(1, touchSize);
    const jitter = Math.abs(rng.normal()) * PAPER_SLIPPAGE_NOISE_BPS;
    const slippageBps = clamp(
      PAPER_BASE_SLIPPAGE_BPS + PAPER_IMPACT_BPS * Math.sqrt(participation) + jitter,
      0,
      PAPER_MAX_SLIPPAGE_BPS,
    );

    // Slippage is always adverse: a buy pays up, a sell gives up.
    const raw = touchPrice * (1 + (buy ? 1 : -1) * (slippageBps / 10_000));
    let price = round2(raw);
    if (request.limitPrice !== null && (request.type === 'limit' || request.type === 'stop_limit')) {
      price = buy ? Math.min(price, request.limitPrice) : Math.max(price, request.limitPrice);
    }

    return {
      quantity: fillQuantity,
      price: round2(Math.max(0.01, price)),
      slippageBps: round2(slippageBps),
      triggered: stopTriggered,
    };
  }

  /**
   * Applies a fill to cash and positions.
   *
   * Handles adds, partial reductions, exact closes and outright flips, because a
   * position book that only understood opening trades would report a fictional
   * average entry the moment a user sold half a position — and that average entry
   * feeds the P&L the platform publishes.
   */
  private applyFill(
    state: PaperAccountState,
    request: BrokerOrderRequest,
    plan: FillPlan,
    now: number,
  ): void {
    const signed = request.side === 'buy' ? plan.quantity : -plan.quantity;
    const commission = plan.quantity * PAPER_COMMISSION_PER_SHARE;
    state.cash = state.cash - signed * plan.price - commission;

    const index = state.positions.findIndex((p) => p.symbol === request.symbol);
    if (index === -1) {
      state.positions.push({
        symbol: request.symbol,
        quantity: signed,
        averageEntry: plan.price,
        realisedPnl: -commission,
        openedAt: now,
      });
      state.realisedPnl -= commission;
      return;
    }

    const existing = state.positions[index];
    const adding = existing.quantity === 0 || Math.sign(existing.quantity) === Math.sign(signed);
    let realised = -commission;

    if (adding) {
      const absExisting = Math.abs(existing.quantity);
      const absAdded = Math.abs(signed);
      existing.averageEntry =
        (absExisting * existing.averageEntry + absAdded * plan.price) / (absExisting + absAdded);
      existing.quantity += signed;
    } else {
      const closedQuantity = Math.min(Math.abs(signed), Math.abs(existing.quantity));
      const perShare =
        existing.quantity > 0 ? plan.price - existing.averageEntry : existing.averageEntry - plan.price;
      realised += closedQuantity * perShare;
      const remaining = existing.quantity + signed;
      // A flip re-bases the average entry on the new side's fill price; anything
      // else keeps the entry of the surviving shares.
      if (Math.sign(remaining) !== 0 && Math.sign(remaining) !== Math.sign(existing.quantity)) {
        existing.averageEntry = plan.price;
      }
      existing.quantity = remaining;
    }

    existing.realisedPnl += realised;
    state.realisedPnl += realised;
    if (existing.quantity === 0) state.positions.splice(index, 1);
  }
}

/** Deterministic broker order id, readable in the audit trail. */
export function paperOrderId(clientOrderId: string): string {
  return `paper-${clientOrderId}`;
}

/**
 * The outbound payload. Field names mirror the broker REST contract so the string
 * stored in the ledger matches what a live venue would have received: audit field
 * 5's enumerated contents are Ticker, Price, Size and Order Type.
 */
export function outboundPayload(request: BrokerOrderRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    symbol: request.symbol,
    qty: String(request.quantity),
    side: request.side,
    type: request.type,
    time_in_force: request.timeInForce,
    client_order_id: request.clientOrderId,
  };
  if (request.limitPrice !== null) payload.limit_price = String(request.limitPrice);
  if (request.stopPrice !== null) payload.stop_price = String(request.stopPrice);
  return payload;
}

/** Order status in the broker REST vocabulary. */
function wireStatus(status: OrderStatus): string {
  switch (status) {
    case 'filled':
      return 'filled';
    case 'partially_filled':
      return 'partially_filled';
    case 'canceled':
      return 'canceled';
    case 'broker_error':
      return 'rejected';
    default:
      return 'new';
  }
}

function orderBody(record: PaperOrderRecord, triggered: boolean): Record<string, unknown> {
  return {
    id: record.brokerOrderId,
    client_order_id: record.clientOrderId,
    created_at: isoStamp(record.submittedAt),
    submitted_at: isoStamp(record.submittedAt),
    updated_at: isoStamp(record.updatedAt),
    filled_at: record.filledQuantity > 0 ? isoStamp(record.updatedAt) : null,
    asset_class: 'us_equity',
    symbol: record.symbol,
    qty: String(record.quantity),
    filled_qty: String(record.filledQuantity),
    filled_avg_price: record.averageFillPrice === null ? null : String(record.averageFillPrice),
    order_type: record.type,
    type: record.type,
    side: record.side,
    time_in_force: record.timeInForce,
    limit_price: record.limitPrice === null ? null : String(record.limitPrice),
    stop_price: record.stopPrice === null ? null : String(record.stopPrice),
    status: wireStatus(record.status),
    stop_triggered: triggered,
    slippage_bps: record.slippageBps,
    venue: 'aurelius-paper',
  };
}

function accountBody(snapshot: AccountSnapshot): Record<string, unknown> {
  return {
    account_number: `PAPER-${snapshot.account.toUpperCase()}`,
    status: 'ACTIVE',
    currency: 'USD',
    cash: String(snapshot.cash),
    equity: String(snapshot.equity),
    buying_power: String(snapshot.buyingPower),
    maintenance_margin: String(snapshot.maintenanceMargin),
    long_market_value: String(snapshot.netExposure),
    daytrading_buying_power: String(snapshot.buyingPower),
    pattern_day_trader: false,
    trading_blocked: false,
  };
}
