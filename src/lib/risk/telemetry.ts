/**
 * Forensic telemetry — the six mandatory audit fields, SPIFFE identity, and the
 * zero-trust correlation record.
 *
 * The compliance mandate is explicit that this subsystem is evidence, not
 * observability: "the backend must be designed for forensic defensibility in a
 * legal setting, not merely high-throughput routing." Its stress case is an
 * arbitration in which the platform has to reconstruct a flash-crash sequence to
 * the millisecond — click at 10:01:45.123, payload dispatched at .125, broker
 * 503 at .201, error shown on screen at .203 — and prove from its own records
 * that a human, not an algorithm, initiated the order.
 *
 * Every one of the six fields is therefore required by construction rather than
 * optional: `recordOrderTelemetry` cannot be called without a user id and
 * session token, a click provenance, the raw outbound payload, and a slot for
 * the broker's status and body.
 */

import { createHash } from 'node:crypto';

import type { ClickProvenance } from '@/lib/domain/types';
import type {
  ErrorPresentationEntry,
  OrderTelemetryRecord,
  RiskAuditPort,
  SvidIssuanceEntry,
} from '@/lib/risk/ports';

// ─────────────────────────────────────────────────────────────────────────────
//  SPIFFE identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Internal modules that touch an order payload. Each gets a unique cryptographic
 * identity so the ledger can prove exactly which piece of software handled the
 * payload before it left the platform.
 */
export type TelemetryService =
  | 'risk-engine'
  | 'order-router'
  | 'paper-broker'
  | 'alpaca-broker'
  | 'admin-console'
  | 'rate-limiter'
  | 'intent-token'
  | 'signal-pipeline';

/** SPIFFE trust domain for the platform's internal workloads. */
export const SPIFFE_TRUST_DOMAIN = 'aurelius.local';

/** Namespace every order-path workload lives in. */
export const SPIFFE_NAMESPACE = 'trading';

/**
 * SPIFFE ID in the standard `spiffe://<trust-domain>/ns/<namespace>/sa/<service>`
 * workload form, so the identities are consistent with SPIRE's Kubernetes
 * registration convention rather than being an ad-hoc string scheme.
 */
export function spiffeId(service: TelemetryService): string {
  return `spiffe://${SPIFFE_TRUST_DOMAIN}/ns/${SPIFFE_NAMESPACE}/sa/${service}`;
}

/** The identity attached to every RiskDecision this subsystem produces. */
export const RISK_ENGINE_SPIFFE_ID = spiffeId('risk-engine');
export const ORDER_ROUTER_SPIFFE_ID = spiffeId('order-router');
export const ADMIN_CONSOLE_SPIFFE_ID = spiffeId('admin-console');
export const RATE_LIMITER_SPIFFE_ID = spiffeId('rate-limiter');
export const INTENT_TOKEN_SPIFFE_ID = spiffeId('intent-token');

/** PLATFORM POLICY: SVIDs are short-lived, matching SPIRE's default rotation. */
export const SVID_TTL_MS = 60 * 60 * 1_000;

/**
 * Issues (and records) an SVID for a workload. The mandate requires the ledger
 * to hold "the exact SVID issuance" next to the risk engine's decision; the
 * serial is a deterministic digest of identity plus issuance instant so that
 * replaying the ledger reproduces the same document rather than a fresh random
 * one that no longer matches the stored record.
 */
export function issueSvid(
  service: TelemetryService,
  issuedAt: number,
  deps: { audit?: RiskAuditPort; correlationId?: string; ttlMs?: number } = {},
): SvidIssuanceEntry {
  const id = spiffeId(service);
  const ttl = deps.ttlMs ?? SVID_TTL_MS;
  const entry: SvidIssuanceEntry = {
    spiffeId: id,
    serialNumber: digest(['svid', id, issuedAt], 24),
    issuedAt,
    expiresAt: issuedAt + ttl,
    correlationId: deps.correlationId ?? null,
  };
  deps.audit?.recordSvidIssuance(entry);
  return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Correlation
// ─────────────────────────────────────────────────────────────────────────────

function digest(parts: readonly (string | number | boolean)[], length: number): string {
  return createHash('sha256').update(parts.join('')).digest('hex').slice(0, length);
}

/**
 * Correlation ID spanning every microservice hop for one user action.
 *
 * Derived rather than random. Two reasons: BUILD_CONTRACT bans unseeded
 * randomness, and — more importantly — a derived ID means a forensic replay of
 * the ledger recomputes the identifier from the underlying facts (who clicked,
 * on what, at which millisecond) instead of having to trust that a stored random
 * value was never rewritten.
 */
export function correlationId(parts: readonly (string | number | boolean)[]): string {
  return `cor_${digest(parts, 32)}`;
}

/** Correlation ID for an order-routing action, keyed on the click that caused it. */
export function orderCorrelationId(input: {
  userId: string;
  symbol: string;
  side: string;
  clickTsMs: number;
  nonce: string;
}): string {
  return correlationId([input.userId, input.symbol, input.side, input.clickTsMs, input.nonce]);
}

// ─────────────────────────────────────────────────────────────────────────────
//  The six mandatory audit fields
// ─────────────────────────────────────────────────────────────────────────────

/** Message shown when the broker fails. Verbatim from the mandate. */
export const BROKER_ERROR_MESSAGE = 'Broker API Error';

/** Message shown when the pre-trade capital check blocks. Verbatim. */
export const INSUFFICIENT_FUNDS_MESSAGE = 'Insufficient Funds / Margin Limit Exceeded';

/** Message shown while the kill switch is engaged. */
export const SERVICE_UNAVAILABLE_MESSAGE = '503 Service Unavailable';

export interface OrderTelemetryInput {
  /** Field 1a — the authenticated account that initiated the action. */
  userId: string;
  /** Field 1b — cryptographic session token, defending against hijack claims. */
  sessionToken: string;
  orderId: string;
  correlationId: string;
  /** Field 2 — millisecond stamps across click → API → broker acknowledgement. */
  clientClickMs: number;
  serverReceivedMs: number;
  riskCompletedMs: number;
  brokerDispatchedMs: number;
  brokerAcknowledgedMs: number | null;
  /** Field 3 — the physical network and device the request came from. */
  ipAddress: string;
  userAgent: string;
  /** Field 4 — X/Y cursor coordinates proving affirmative physical intent. */
  click: ClickProvenance;
  /** Field 5 — the exact outbound JSON string (ticker, price, size, order type). */
  rawPayload: string;
  /** Field 6 — the broker's status and response body, verbatim. */
  brokerStatus: number | null;
  brokerBody: string | null;
  /** SPIFFE identity of the routing module that dispatched the payload. */
  spiffeId?: string;
}

/**
 * Builds and persists the mandatory audit record for one routing event.
 *
 * The record is assembled from what actually happened rather than from the
 * request that was intended: `rawPayload` is the serialised bytes handed to the
 * broker, and `brokerStatus`/`brokerBody` are whatever came back — including a
 * transport failure — because the evidentiary value lies in the record matching
 * reality even when reality was a failure.
 */
export function recordOrderTelemetry(
  input: OrderTelemetryInput,
  deps: { audit?: RiskAuditPort } = {},
): OrderTelemetryRecord {
  const record: OrderTelemetryRecord = {
    orderId: input.orderId,
    correlationId: input.correlationId,
    userId: input.userId,
    sessionToken: input.sessionToken,
    timestamps: {
      clientClick: input.clientClickMs,
      serverReceived: input.serverReceivedMs,
      riskCompleted: input.riskCompletedMs,
      brokerDispatched: input.brokerDispatchedMs,
      brokerAcknowledged: input.brokerAcknowledgedMs,
    },
    spiffeId: input.spiffeId ?? ORDER_ROUTER_SPIFFE_ID,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    click: input.click,
    rawPayload: input.rawPayload,
    brokerStatus: input.brokerStatus,
    brokerBody: input.brokerBody,
  };
  deps.audit?.recordOrderTelemetry(record);
  return record;
}

export interface ErrorPresentationInput {
  correlationId: string;
  userId: string;
  orderId: string | null;
  /** The exact string rendered — e.g. 'Broker API Error'. */
  message: string;
  /** Which surface rendered it, e.g. 'order_ticket'. */
  surface: string;
  presentedAt: number;
  brokerStatus?: number | null;
  brokerBody?: string | null;
  spiffeId?: string;
}

/**
 * Records the act of showing a failure to the user.
 *
 * This is an audit event in its own right, not a duplicate of the broker
 * response: the mandate's reconstruction has a distinct entry at 10:01:45.203
 * for "updates the UI to display 'Broker API Error,' and records the prompt
 * presentation of this error to the user's screen". It is the platform's proof
 * that it disclosed the failure promptly instead of silently swallowing it — the
 * exact allegation the $50,000 stop-loss arbitration scenario turns on.
 */
export function recordErrorPresentation(
  input: ErrorPresentationInput,
  deps: { audit?: RiskAuditPort } = {},
): ErrorPresentationEntry {
  const entry: ErrorPresentationEntry = {
    correlationId: input.correlationId,
    userId: input.userId,
    orderId: input.orderId,
    message: input.message,
    surface: input.surface,
    presentedAt: input.presentedAt,
    brokerStatus: input.brokerStatus ?? null,
    brokerBody: input.brokerBody ?? null,
    spiffeId: input.spiffeId ?? ORDER_ROUTER_SPIFFE_ID,
  };
  deps.audit?.recordErrorPresentation(entry);
  return entry;
}

/**
 * Serialises the outbound broker payload for field 5.
 *
 * Keys are emitted in a fixed order so the stored string is byte-stable: an
 * audit record whose serialisation varies between runs is weaker evidence,
 * because a reviewer cannot tell a re-serialisation from an alteration.
 */
export function serialiseOutboundPayload(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).sort();
  const ordered: Record<string, unknown> = {};
  for (const key of keys) ordered[key] = payload[key];
  return JSON.stringify(ordered);
}

/**
 * Truncates a broker body for storage while flagging that it was truncated.
 * PLATFORM POLICY: bodies are evidence, so the cap is generous and the marker is
 * explicit — a silently clipped body would be indistinguishable from a body the
 * broker actually sent.
 */
export const MAX_STORED_BROKER_BODY_CHARS = 16_384;

export function boundBrokerBody(body: string | null): string | null {
  if (body === null) return null;
  if (body.length <= MAX_STORED_BROKER_BODY_CHARS) return body;
  return `${body.slice(0, MAX_STORED_BROKER_BODY_CHARS)}…[truncated ${body.length - MAX_STORED_BROKER_BODY_CHARS} chars]`;
}
