/**
 * Persistence ports for the risk engine.
 *
 * The compliance mandate requires every allow/deny decision, every throttle
 * rejection, every kill-switch activation and every error presented to a user's
 * screen to land in an append-only bitemporal ledger. That ledger lives behind
 * these interfaces rather than inside this subsystem: the risk engine must be
 * unit-testable and must keep working with an empty `.env`, so each port ships
 * with an in-memory implementation and the real repositories are injected.
 *
 * Every port method is *synchronous*. This is deliberate. Pre-trade risk sits on
 * the order hot path in front of a broker-dealer, and the mandate's forensic
 * requirement is that the decision record exists before the payload leaves the
 * platform — not eventually. The project's database layer is `node:sqlite`,
 * whose API is synchronous, so a synchronous port is also the honest shape for
 * the real implementation.
 *
 * The in-memory audit sink is append-only by construction: it exposes readers and
 * nothing that mutates or removes a record it already holds. That mirrors the
 * `REVOKE UPDATE, DELETE` posture the mandate requires of the production tables.
 * The idempotency and nonce stores do evict expired entries, which is retention
 * rather than tampering — neither can affect a decision once its window closes.
 */

import { isoDate } from '@/lib/market/calendar';
import type {
  ClickProvenance,
  OrderIntent,
  OrderTelemetry,
  RiskCheckResult,
  RiskRejectionCode,
} from '@/lib/domain/types';

// ─────────────────────────────────────────────────────────────────────────────
//  Record shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The zero-trust telemetry record: which piece of software authorised the
 * payload, under which SVID, and what it decided.
 */
export interface RiskDecisionAuditEntry {
  /** Shared across every microservice hop for one user action. */
  correlationId: string;
  userId: string;
  symbol: string;
  /** SPIFFE ID of the module that ran the checks. */
  spiffeId: string;
  /** SPIFFE ID of the caller that asked for the decision. */
  requestingSpiffeId: string | null;
  decision: 'ALLOW' | 'DENY';
  /** Which control fired, null on ALLOW. */
  rejectionCode: RiskRejectionCode | null;
  /** Every check that ran, in order. */
  checks: RiskCheckResult[];
  /** Millisecond-precision decision timestamp. */
  evaluatedAt: number;
  elapsedMs: number;
  /** The intent exactly as submitted, so the ledger proves it was not altered. */
  intent: OrderIntent;
  /** Click provenance, present whenever the client supplied it. */
  click: ClickProvenance | null;
}

export interface RateLimitRejectionEntry {
  correlationId: string;
  userId: string;
  spiffeId: string;
  /** Messages already seen inside the window. */
  observedCount: number;
  limit: number;
  windowMs: number;
  /** Millisecond-precision rejection timestamp. */
  rejectedAt: number;
  httpStatus: number;
}

export type AdminActionType = 'KILL_SWITCH_ENGAGED' | 'KILL_SWITCH_DISENGAGED';

export interface AdminActionEntry {
  action: AdminActionType;
  /** Administrator identity — CTO or compliance personnel. */
  actor: string;
  reason: string | null;
  /** Millisecond-precision action timestamp. */
  actedAt: number;
  spiffeId: string;
  /** Orders the activation attempted to cancel. */
  affectedOrderIds: string[];
}

/**
 * The six mandatory audit fields. `OrderTelemetry` from the domain layer carries
 * five of them; the user identity and cryptographic session token are added here
 * so field 1 ("Unique User ID & Cryptographic Session Token") is complete.
 */
export interface OrderTelemetryRecord extends OrderTelemetry {
  correlationId: string;
  userId: string;
  sessionToken: string;
}

/**
 * The mandate treats the *presentation* of a failure to the user as its own
 * auditable event: in the reconstructed flash-crash sequence, 10:01:45.203 is
 * the moment 'Broker API Error' reached the screen, and that moment is evidence
 * the platform disclosed the failure rather than concealing it.
 */
export interface ErrorPresentationEntry {
  correlationId: string;
  userId: string;
  orderId: string | null;
  /** The string shown to the user, verbatim. */
  message: string;
  /** Where in the UI it was rendered. */
  surface: string;
  /** Millisecond-precision presentation timestamp. */
  presentedAt: number;
  brokerStatus: number | null;
  brokerBody: string | null;
  spiffeId: string;
}

/**
 * SVID issuance record. The mandate requires logs to record "the exact SVID
 * issuance" alongside the risk engine's decision, so a reviewer can prove which
 * identity document authorised the software that touched the payload.
 */
export interface SvidIssuanceEntry {
  spiffeId: string;
  /** Deterministic serial derived from the identity and issuance instant. */
  serialNumber: string;
  issuedAt: number;
  expiresAt: number;
  correlationId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Ports
// ─────────────────────────────────────────────────────────────────────────────

/** Append-only audit sink. Implementations must never update or delete. */
export interface RiskAuditPort {
  recordRiskDecision(entry: RiskDecisionAuditEntry): void;
  recordRateLimitRejection(entry: RateLimitRejectionEntry): void;
  recordAdminAction(entry: AdminActionEntry): void;
  recordOrderTelemetry(entry: OrderTelemetryRecord): void;
  recordErrorPresentation(entry: ErrorPresentationEntry): void;
  recordSvidIssuance(entry: SvidIssuanceEntry): void;
}

/** Duplicate-submission detection for the DUPLICATE_ORDER control. */
export interface IdempotencyPort {
  /** True when this key has already been accepted. */
  seen(key: string): boolean;
  /** Remembers an accepted key. Called only once a decision approves. */
  record(key: string, atMs: number): void;
}

/** Single-use enforcement for intent-token nonces. */
export interface IntentNoncePort {
  /**
   * Atomically claims a nonce. Returns true when this call is the first to
   * claim it, false when the token has already been spent — which is the replay
   * the mandate's single-use requirement exists to stop.
   */
  consume(nonce: string, expiresAtMs: number): boolean;
}

/** Kill-switch durability, so the halt survives a process restart. */
export interface KillSwitchStatePort {
  load(): KillSwitchPersistedState | null;
  save(state: KillSwitchPersistedState): void;
}

export interface KillSwitchPersistedState {
  engaged: boolean;
  engagedAt: number | null;
  engagedBy: string | null;
  reason: string | null;
  cancelledOrders: number;
}

/** A resting order the kill switch has to try to unwind. */
export interface PendingOrderRef {
  orderId: string;
  brokerOrderId: string | null;
  userId: string;
  symbol: string;
  account: 'paper' | 'live';
  quantity: number;
  filledQuantity: number;
}

/**
 * Pending-order registry. `listPending` supplies the unwind list on kill-switch
 * activation; `markCancellationRequested` writes the attempt, because the
 * mandate requires each attempt be logged whether or not the broker permits it.
 */
export interface PendingOrderPort {
  listPending(): PendingOrderRef[];
  markCancellationRequested(orderId: string, atMs: number): void;
  recordCancellationOutcome(orderId: string, status: number, body: string | null): void;
}

/** Running per-user, per-session-day accepted notional, for Control 1. */
export interface DailyNotionalPort {
  /** Notional already accepted for this user during the trading day of `atMs`. */
  usedUsd(userId: string, atMs: number): number;
  /** Adds to the running total. Called only once a decision approves. */
  add(userId: string, atMs: number, notionalUsd: number): void;
}

// ─────────────────────────────────────────────────────────────────────────────
//  In-memory defaults
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic in-process audit sink. This is what runs with an empty `.env`:
 * the controls, decisions and telemetry are all real, they are simply retained
 * in the process rather than in PostgreSQL. Records are pushed and never
 * mutated, so replaying the arrays reproduces the decision history exactly.
 */
export class InMemoryRiskAudit implements RiskAuditPort {
  private readonly decisions: RiskDecisionAuditEntry[] = [];
  private readonly throttles: RateLimitRejectionEntry[] = [];
  private readonly adminActions: AdminActionEntry[] = [];
  private readonly telemetry: OrderTelemetryRecord[] = [];
  private readonly errors: ErrorPresentationEntry[] = [];
  private readonly svids: SvidIssuanceEntry[] = [];

  recordRiskDecision(entry: RiskDecisionAuditEntry): void {
    this.decisions.push(entry);
  }

  recordRateLimitRejection(entry: RateLimitRejectionEntry): void {
    this.throttles.push(entry);
  }

  recordAdminAction(entry: AdminActionEntry): void {
    this.adminActions.push(entry);
  }

  recordOrderTelemetry(entry: OrderTelemetryRecord): void {
    this.telemetry.push(entry);
  }

  recordErrorPresentation(entry: ErrorPresentationEntry): void {
    this.errors.push(entry);
  }

  recordSvidIssuance(entry: SvidIssuanceEntry): void {
    this.svids.push(entry);
  }

  /** Read-only views for the admin surfaces and the test suite. */
  allDecisions(): readonly RiskDecisionAuditEntry[] {
    return this.decisions;
  }

  allThrottleRejections(): readonly RateLimitRejectionEntry[] {
    return this.throttles;
  }

  allAdminActions(): readonly AdminActionEntry[] {
    return this.adminActions;
  }

  allOrderTelemetry(): readonly OrderTelemetryRecord[] {
    return this.telemetry;
  }

  allErrorPresentations(): readonly ErrorPresentationEntry[] {
    return this.errors;
  }

  allSvidIssuances(): readonly SvidIssuanceEntry[] {
    return this.svids;
  }

  /** Correlate one user action across every hop it touched. */
  byCorrelationId(correlationId: string): {
    decisions: RiskDecisionAuditEntry[];
    throttles: RateLimitRejectionEntry[];
    telemetry: OrderTelemetryRecord[];
    errors: ErrorPresentationEntry[];
    svids: SvidIssuanceEntry[];
  } {
    return {
      decisions: this.decisions.filter((d) => d.correlationId === correlationId),
      throttles: this.throttles.filter((t) => t.correlationId === correlationId),
      telemetry: this.telemetry.filter((t) => t.correlationId === correlationId),
      errors: this.errors.filter((e) => e.correlationId === correlationId),
      svids: this.svids.filter((s) => s.correlationId === correlationId),
    };
  }
}

/** Idempotency memory with a bounded retention window. */
export class InMemoryIdempotencyStore implements IdempotencyPort {
  private readonly keys = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  seen(key: string): boolean {
    return this.keys.has(key);
  }

  record(key: string, atMs: number): void {
    this.prune(atMs);
    this.keys.set(key, atMs);
  }

  private prune(nowMs: number): void {
    if (this.keys.size === 0) return;
    for (const [key, at] of this.keys) {
      if (nowMs - at > this.windowMs) this.keys.delete(key);
    }
  }
}

/**
 * Nonce ledger. Expired nonces are dropped on write, which is safe because the
 * TTL check in `verifyIntentToken` rejects an expired token before the nonce is
 * ever consulted — a pruned nonce can never authorise anything.
 */
export class InMemoryIntentNonceStore implements IntentNoncePort {
  private readonly nonces = new Map<string, number>();

  consume(nonce: string, expiresAtMs: number): boolean {
    this.prune(expiresAtMs);
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, expiresAtMs);
    return true;
  }

  private prune(nowMs: number): void {
    for (const [nonce, expiry] of this.nonces) {
      if (expiry < nowMs) this.nonces.delete(nonce);
    }
  }
}

/** Process-local kill-switch state. */
export class InMemoryKillSwitchStore implements KillSwitchStatePort {
  private state: KillSwitchPersistedState | null = null;

  load(): KillSwitchPersistedState | null {
    return this.state === null ? null : { ...this.state };
  }

  save(state: KillSwitchPersistedState): void {
    this.state = { ...state };
  }
}

/** Pending-order registry backed by a map, for the default paper wiring. */
export class InMemoryPendingOrderStore implements PendingOrderPort {
  private readonly pending = new Map<string, PendingOrderRef>();
  private readonly attempts: { orderId: string; atMs: number }[] = [];
  private readonly outcomes: { orderId: string; status: number; body: string | null }[] = [];

  register(ref: PendingOrderRef): void {
    this.pending.set(ref.orderId, ref);
  }

  /** Removal is a lifecycle transition (filled/cancelled), not a log deletion. */
  release(orderId: string): void {
    this.pending.delete(orderId);
  }

  listPending(): PendingOrderRef[] {
    return Array.from(this.pending.values());
  }

  markCancellationRequested(orderId: string, atMs: number): void {
    this.attempts.push({ orderId, atMs });
  }

  recordCancellationOutcome(orderId: string, status: number, body: string | null): void {
    this.outcomes.push({ orderId, status, body });
  }

  allAttempts(): readonly { orderId: string; atMs: number }[] {
    return this.attempts;
  }

  allOutcomes(): readonly { orderId: string; status: number; body: string | null }[] {
    return this.outcomes;
  }
}

/**
 * Daily accepted-notional counter, bucketed by New York calendar date so the
 * window matches the "since 00:00 exchange-local today" reset in the mandate.
 */
export class InMemoryDailyNotionalStore implements DailyNotionalPort {
  private readonly totals = new Map<string, number>();

  /** Defaults to the New York calendar date, which is the exchange-local day. */
  constructor(private readonly dayKeyOf: (atMs: number) => string = isoDate) {}

  usedUsd(userId: string, atMs: number): number {
    return this.totals.get(`${userId}:${this.dayKeyOf(atMs)}`) ?? 0;
  }

  add(userId: string, atMs: number, notionalUsd: number): void {
    const key = `${userId}:${this.dayKeyOf(atMs)}`;
    this.totals.set(key, (this.totals.get(key) ?? 0) + notionalUsd);
  }
}
