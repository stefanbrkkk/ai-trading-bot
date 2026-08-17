/**
 * Broker adapter contract.
 *
 * The compliance mandate treats the broker boundary as the platform's evidentiary
 * edge: audit field 5 is "the exact string of data … sent to the broker API" and
 * field 6 is "the exact acknowledgment receipt, error code, or order ID returned
 * by the broker-dealer (e.g., 200 OK or 503 Service Unavailable)". Both fields
 * have to survive failures, which drives the single most important decision in
 * this file:
 *
 *   NO ADAPTER METHOD EVER THROWS.
 *
 * Every call resolves to a `BrokerResult` carrying the exact HTTP status and the
 * parsed body, success or failure. An exception would destroy the status and body
 * the ledger is required to hold, and would let a broker outage propagate as a
 * 500 instead of the disclosed 'Broker API Error' the user must be shown — the
 * exact sequence the flash-crash reconstruction turns on (broker 503 at
 * 10:01:45.201, error on screen at .203).
 *
 * A transport failure with no HTTP response is reported as status 0 with `error`
 * populated, rather than being dressed up as a 5xx the broker never sent.
 */

import type {
  AccountSnapshot,
  OrderSide,
  OrderStatus,
  OrderType,
  Position,
  Quote,
  TimeInForce,
} from '@/lib/domain/types';

export type BrokerName = 'paper' | 'alpaca';

/** Whether fills are simulated in-process or reach a real venue. */
export type BrokerMode = 'paper' | 'live';

/** Status used when no HTTP response was received at all. */
export const NO_HTTP_RESPONSE = 0;

export interface BrokerCallContext {
  /** Correlation ID shared across every hop of the user action. */
  correlationId: string;
  userId: string;
  /**
   * Kill-switch abort signal. Adapters attach it to their outbound requests, so
   * engaging the switch severs in-flight POSTs instead of waiting them out.
   */
  signal?: AbortSignal;
  /** Millisecond dispatch instant, injected so telemetry and fills agree. */
  dispatchedAt?: number;
}

/**
 * The outbound order, already validated by the risk engine.
 *
 * Quantity is a plain number and the prices are the user's own: the adapter
 * layer's contract is to transmit these unaltered, since the stored raw payload
 * is the evidence that the platform did not modify a user parameter.
 */
export interface BrokerOrderRequest {
  /** Idempotency key echoed to the broker as its client order id. */
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limitPrice: number | null;
  stopPrice: number | null;
  timeInForce: TimeInForce;
  account: 'paper' | 'live';
}

export interface BrokerOrderAck {
  brokerOrderId: string;
  clientOrderId: string;
  status: OrderStatus;
  filledQuantity: number;
  averageFillPrice: number | null;
  /** Broker-side acceptance instant, millisecond precision. */
  acknowledgedAt: number;
}

export interface BrokerCancelAck {
  brokerOrderId: string;
  status: OrderStatus;
  canceledAt: number;
}

/**
 * Uniform result envelope. `status` and `body` are the two mandatory audit
 * fields; `data` is the typed projection for the application; `rawRequest` is the
 * verbatim outbound JSON string for audit field 5.
 */
export interface BrokerResult<T> {
  ok: boolean;
  /** Exact HTTP status, or NO_HTTP_RESPONSE when the transport failed. */
  status: number;
  /** Parsed response body; `{ raw: string }` when the body was not JSON. */
  body: Record<string, unknown> | null;
  data: T | null;
  /** Transport or parse failure description; null on an HTTP round-trip. */
  error: string | null;
  latencyMs: number;
  /** Outbound payload as an object, for the ledger. */
  requestPayload: Record<string, unknown> | null;
  /** Outbound payload as the exact serialised string that was transmitted. */
  rawRequest: string | null;
}

export interface BrokerDescriptor {
  name: BrokerName;
  mode: BrokerMode;
  /** Human-readable endpoint, or 'in-process' for the paper broker. */
  endpoint: string;
  /**
   * Objective capability facts only. The mandate forbids describing any route as
   * 'best price' or 'preferred', because doing so would assume the broker-dealer
   * duty of best execution.
   */
  supportsCancel: boolean;
  supportsFractional: boolean;
}

export interface BrokerAdapter {
  readonly name: BrokerName;
  readonly mode: BrokerMode;
  describe(): BrokerDescriptor;
  submitOrder(
    request: BrokerOrderRequest,
    ctx: BrokerCallContext,
  ): Promise<BrokerResult<BrokerOrderAck>>;
  cancelOrder(brokerOrderId: string, ctx: BrokerCallContext): Promise<BrokerResult<BrokerCancelAck>>;
  getAccount(
    account: 'paper' | 'live',
    ctx: BrokerCallContext,
  ): Promise<BrokerResult<AccountSnapshot>>;
  getPositions(account: 'paper' | 'live', ctx: BrokerCallContext): Promise<BrokerResult<Position[]>>;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Paper-broker persistence port
// ─────────────────────────────────────────────────────────────────────────────

export interface PaperPositionState {
  symbol: string;
  /** Signed: negative for a short. */
  quantity: number;
  averageEntry: number;
  realisedPnl: number;
  openedAt: number;
}

export interface PaperAccountState {
  account: 'paper' | 'live';
  cash: number;
  realisedPnl: number;
  positions: PaperPositionState[];
  /** New York calendar date the day-P&L baseline belongs to. */
  dayKey: string;
  /** Equity at the start of `dayKey`, for the day-P&L figure. */
  dayStartEquity: number;
}

export interface PaperOrderRecord {
  brokerOrderId: string;
  clientOrderId: string;
  account: 'paper' | 'live';
  userId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  filledQuantity: number;
  averageFillPrice: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  timeInForce: TimeInForce;
  status: OrderStatus;
  submittedAt: number;
  updatedAt: number;
  /** Realised slippage in basis points against the touch, for the fill report. */
  slippageBps: number;
}

/**
 * Full account and order bookkeeping for the paper broker.
 *
 * Held behind a port so the same deterministic fill engine runs against an
 * in-memory store with an empty `.env` and against the real repositories once
 * wired. Synchronous for the same reason the risk ports are: fills happen on the
 * order hot path and the project's database layer is `node:sqlite`.
 */
export interface BrokerStatePort {
  loadAccount(account: 'paper' | 'live', userId: string): PaperAccountState | null;
  saveAccount(userId: string, state: PaperAccountState): void;
  putOrder(record: PaperOrderRecord): void;
  getOrder(brokerOrderId: string): PaperOrderRecord | null;
  listOrders(account: 'paper' | 'live', userId: string): PaperOrderRecord[];
}

/** Market-data source the paper broker fills against. */
export type QuoteSource = (symbol: string, atMs: number) => Quote | null;

/**
 * In-memory bookkeeping. Deterministic and complete: positions, cash, realised
 * P&L and every order live here, so the paper account behaves like an account
 * rather than a mock that always succeeds.
 */
export class InMemoryBrokerState implements BrokerStatePort {
  private readonly accounts = new Map<string, PaperAccountState>();
  private readonly orders = new Map<string, PaperOrderRecord>();

  private key(account: 'paper' | 'live', userId: string): string {
    return `${account}:${userId}`;
  }

  loadAccount(account: 'paper' | 'live', userId: string): PaperAccountState | null {
    const state = this.accounts.get(this.key(account, userId));
    if (!state) return null;
    return { ...state, positions: state.positions.map((p) => ({ ...p })) };
  }

  saveAccount(userId: string, state: PaperAccountState): void {
    this.accounts.set(this.key(state.account, userId), {
      ...state,
      positions: state.positions.map((p) => ({ ...p })),
    });
  }

  putOrder(record: PaperOrderRecord): void {
    this.orders.set(record.brokerOrderId, { ...record });
  }

  getOrder(brokerOrderId: string): PaperOrderRecord | null {
    const found = this.orders.get(brokerOrderId);
    return found ? { ...found } : null;
  }

  listOrders(account: 'paper' | 'live', userId: string): PaperOrderRecord[] {
    return Array.from(this.orders.values())
      .filter((o) => o.account === account && o.userId === userId)
      .sort((a, b) => a.submittedAt - b.submittedAt);
  }
}

/** Order statuses from which no further transition is possible. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  'filled',
  'canceled',
  'rejected_risk',
  'broker_error',
];

export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}
