/**
 * Typed repositories — the only place in the platform that writes SQL.
 *
 * Every function here uses prepared statements (cached per connection by the
 * driver) and returns `@/lib/domain/types` shapes wherever one exists, so
 * callers never see a row. The conversions that happen at this boundary are the
 * ones the schema comment describes: cents ⇄ dollars for ledger money, 0/1 ⇄
 * boolean, and TEXT ⇄ JSON.
 *
 * Reads that reconstruct a domain object with metadata (a `FeatureValue` needs a
 * label, group and unit) pull that metadata from the feature registry rather
 * than duplicating it in the database — one source of truth, and no chance of a
 * stored label drifting from the one the UI renders.
 *
 * ── Every export here has a caller ──────────────────────────────────────────
 *
 * That is now an invariant, and it did not use to be one: of 147 exported
 * functions, 81 were referenced nowhere else in the repository — not in `src`,
 * not in `scripts`, not in the tests, not in the E2E suite, not in the docs.
 * Whole subsystems were included: a model registry (`putModel`, `activateModel`,
 * `getNnWeights`, …) beside an ensemble that is actually persisted as a JSON
 * file by `engine/store.ts`; backtest storage beside a backtester that returns
 * its result to the caller; a publication table writer beside the decision, set
 * out at length in `engine/service.ts`, that the daily Top 5 is deliberately
 * *never* persisted because "a durable cache of a derived value can always
 * outlive its derivation".
 *
 * That last one is why this is not merely untidy. A plausible, well-documented
 * `publishRanking` sitting in the repository layer is an invitation to reinstate
 * exactly the defect that three separate cache-key revisions failed to fix. Dead
 * code that contradicts a live decision is worse than no code, so it is gone;
 * git history has it if the subsystem is ever built for real.
 *
 * `tests/fix-db-misc.test.ts` re-derives the reachability check and fails if an
 * export loses its last caller, so the claim in this paragraph stays checkable
 * rather than becoming another comment that used to be true.
 */

import { createHash, randomUUID } from 'node:crypto';

import { getDb } from '@/lib/db/client';
import type { SqlRow, SqlStatement, SqlValue } from '@/lib/db/driver';
import {
  bool,
  bytesOrNull,
  enumOr,
  flag,
  fromCents,
  jsonColumn,
  jsonText,
  jsonTextOrNull,
  num,
  numOrNull,
  str,
  strOrNull,
  toCents,
} from '@/lib/db/row';
import { monthBucket } from '@/lib/db/schema';
import type {
  AccountSnapshot,
  AgentInference,
  AltDataEvent,
  Bar,
  FeatureValue,
  KillSwitchState,
  LatencyBreakdown,
  Order,
  OrderSide,
  OrderStatus,
  OrderTelemetry,
  OrderType,
  Position,
  Quote,
  RagSourceType,
  RegimeLabel,
  RiskCheckResult,
  RiskDecision,
  RiskRejectionCode,
  Signal,
  SignalDirection,
  SignalDriver,
  SubscriptionStatus,
  SymbolMeta,
  TimeInForce,
  TosAcceptance,
  User,
  UserRole,
} from '@/lib/domain/types';
import { FEATURE_DEFINITIONS, featureDefinition } from '@/lib/engine/features';

// ─────────────────────────────────────────────────────────────────────────────
//  Shared plumbing
// ─────────────────────────────────────────────────────────────────────────────

function stmt(sql: string): SqlStatement {
  return getDb().prepare(sql);
}

function tx<T>(body: () => T): T {
  return getDb().transaction(body);
}

/** `?, ?, ?` for an IN clause of `count` bound values. */
function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

function changes(result: { changes: number | bigint }): number {
  return typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;
}

// Allowed-value lists for narrowing reads back into closed domain unions. Typed
// against the union, so a literal that stops being valid fails the build.
const USER_ROLES: readonly UserRole[] = ['trader', 'admin'];
const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'none',
];
const SIGNAL_DIRECTIONS: readonly SignalDirection[] = ['long', 'short', 'flat'];
const REGIME_LABELS: readonly RegimeLabel[] = [
  'trending_bull',
  'trending_bear',
  'mean_reverting',
  'high_volatility',
  'low_volatility_drift',
  'illiquid',
];
const ORDER_SIDES: readonly OrderSide[] = ['buy', 'sell'];
const ORDER_TYPES: readonly OrderType[] = ['market', 'limit', 'stop', 'stop_limit'];
const TIME_IN_FORCES: readonly TimeInForce[] = ['day', 'gtc', 'ioc', 'fok'];
const ACCOUNT_KINDS: readonly ('paper' | 'live')[] = ['paper', 'live'];
const ORDER_STATUSES: readonly OrderStatus[] = [
  'pending_risk',
  'rejected_risk',
  'submitted',
  'partially_filled',
  'filled',
  'canceled',
  'broker_error',
];
const AGENT_ARCHITECTURES: readonly AgentInference['architecture'][] = ['tft', 'bilstm', 'lstm'];
const DRIVER_DIRECTIONS: readonly SignalDriver['direction'][] = ['positive', 'negative'];
const RAG_SOURCE_TYPES: readonly RagSourceType[] = [
  'sec_10k',
  'sec_10q',
  'sec_8k',
  'sec_13f',
  'sec_form4',
  'earnings_transcript',
  'analyst_note',
  'news',
  'social_x',
  'reddit',
];
const SUBSCRIPTION_PROVIDERS: readonly ('stripe' | 'simulated')[] = ['stripe', 'simulated'];

// ─────────────────────────────────────────────────────────────────────────────
//  Users, sessions, consent, billing
// ─────────────────────────────────────────────────────────────────────────────

export interface UpsertUserInput {
  id?: string;
  email: string;
  displayName: string;
  role?: UserRole;
  createdAt?: number;
  passwordHash?: string | null;
  passwordSalt?: string | null;
  liveTradingUnlocked?: boolean;
  tosAcceptedAt?: number | null;
  tosVersion?: string | null;
}

export interface UserCredentials {
  userId: string;
  passwordHash: string | null;
  passwordSalt: string | null;
}

const USER_SELECT = `SELECT
    u.id, u.email, u.display_name, u.role, u.created_at,
    u.live_trading_unlocked, u.tos_accepted_at, u.tos_version,
    s.status AS sub_status, s.trial_ends_at AS sub_trial_ends_at,
    s.current_period_end AS sub_current_period_end, s.price_cents AS sub_price_cents,
    s.provider AS sub_provider, s.external_id AS sub_external_id
  FROM users u
  LEFT JOIN subscriptions s ON s.user_id = u.id`;

function userFromRow(row: SqlRow): User {
  const status = strOrNull(row, 'sub_status');
  return {
    id: str(row, 'id'),
    email: str(row, 'email'),
    displayName: str(row, 'display_name'),
    role: enumOr(row, 'role', USER_ROLES, 'trader'),
    createdAt: num(row, 'created_at'),
    subscription: {
      status:
        status === null ? 'none' : enumOr(row, 'sub_status', SUBSCRIPTION_STATUSES, 'none'),
      trialEndsAt: numOrNull(row, 'sub_trial_ends_at'),
      currentPeriodEnd: numOrNull(row, 'sub_current_period_end'),
      priceUsdPerMonth: fromCents(num(row, 'sub_price_cents', 0)),
      provider:
        strOrNull(row, 'sub_provider') === null
          ? null
          : enumOr(row, 'sub_provider', SUBSCRIPTION_PROVIDERS, 'simulated'),
      externalId: strOrNull(row, 'sub_external_id'),
    },
    liveTradingUnlocked: bool(row, 'live_trading_unlocked'),
    tosAcceptedAt: numOrNull(row, 'tos_accepted_at'),
    tosVersion: strOrNull(row, 'tos_version'),
  };
}

export function upsertUser(input: UpsertUserInput): User {
  const now = Date.now();
  const id = input.id ?? randomUUID();
  stmt(
    `INSERT INTO users
       (id, email, display_name, role, created_at, updated_at, password_hash, password_salt,
        live_trading_unlocked, tos_accepted_at, tos_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET
       display_name = excluded.display_name,
       role = excluded.role,
       updated_at = excluded.updated_at,
       password_hash = COALESCE(excluded.password_hash, users.password_hash),
       password_salt = COALESCE(excluded.password_salt, users.password_salt),
       live_trading_unlocked = excluded.live_trading_unlocked,
       tos_accepted_at = COALESCE(excluded.tos_accepted_at, users.tos_accepted_at),
       tos_version = COALESCE(excluded.tos_version, users.tos_version)`,
  ).run(
    id,
    input.email,
    input.displayName,
    input.role ?? 'trader',
    input.createdAt ?? now,
    now,
    input.passwordHash ?? null,
    input.passwordSalt ?? null,
    flag(input.liveTradingUnlocked ?? false),
    input.tosAcceptedAt ?? null,
    input.tosVersion ?? null,
  );
  const user = findUserByEmail(input.email);
  if (user === null) {
    throw new Error(`[aurelius/db] user ${input.email} vanished immediately after upsert`);
  }
  return user;
}

export function findUserById(id: string): User | null {
  const row = stmt(`${USER_SELECT} WHERE u.id = ?`).get(id);
  return row === undefined ? null : userFromRow(row);
}

export function findUserByEmail(email: string): User | null {
  const row = stmt(`${USER_SELECT} WHERE u.email = ?`).get(email);
  return row === undefined ? null : userFromRow(row);
}

export function listUsers(limit = 500): User[] {
  return stmt(`${USER_SELECT} ORDER BY u.created_at ASC LIMIT ?`)
    .all(limit)
    .map(userFromRow);
}

export function setUserRole(userId: string, role: UserRole): void {
  stmt('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, Date.now(), userId);
}

export function setLiveTradingUnlocked(userId: string, unlocked: boolean): void {
  stmt('UPDATE users SET live_trading_unlocked = ?, updated_at = ? WHERE id = ?').run(
    flag(unlocked),
    Date.now(),
    userId,
  );
}

export function getUserCredentials(userId: string): UserCredentials | null {
  const row = stmt('SELECT id, password_hash, password_salt FROM users WHERE id = ?').get(userId);
  if (row === undefined) return null;
  return {
    userId: str(row, 'id'),
    passwordHash: strOrNull(row, 'password_hash'),
    passwordSalt: strOrNull(row, 'password_salt'),
  };
}

export interface SessionRecord {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
  ipAddress: string;
  userAgent: string;
}

function sessionFromRow(row: SqlRow): SessionRecord {
  return {
    token: str(row, 'token'),
    userId: str(row, 'user_id'),
    createdAt: num(row, 'created_at'),
    expiresAt: num(row, 'expires_at'),
    lastSeenAt: num(row, 'last_seen_at'),
    revokedAt: numOrNull(row, 'revoked_at'),
    ipAddress: str(row, 'ip_address'),
    userAgent: str(row, 'user_agent'),
  };
}

export interface CreateSessionInput {
  token: string;
  userId: string;
  expiresAt: number;
  createdAt?: number;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * What actually goes in the `sessions.token` column.
 *
 * The cookie's own value used to, which made the ledger a bearer-credential
 * store: a single read primitive over the database — a leaked `.data/` backup, a
 * validator bypass on the query surface — was immediate impersonation of every
 * signed-in user, no cracking required.
 *
 * The digest is enough for every operation the table supports. Lookups are by
 * exact token, so a preimage-resistant hash of a 32-byte random value is a
 * perfect substitute for it, and there is nothing to slow down: the token has
 * full entropy already, so a KDF would only cost latency on every request.
 *
 * Applied at this boundary rather than at the call sites so a future caller
 * cannot forget. The raw token never leaves the cookie.
 */
function sessionDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(input: CreateSessionInput): SessionRecord {
  const createdAt = input.createdAt ?? Date.now();
  stmt(
    `INSERT INTO sessions
       (token, user_id, created_at, expires_at, last_seen_at, revoked_at, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    sessionDigest(input.token),
    input.userId,
    createdAt,
    input.expiresAt,
    createdAt,
    input.ipAddress ?? '',
    input.userAgent ?? '',
  );
  return {
    token: input.token,
    userId: input.userId,
    createdAt,
    expiresAt: input.expiresAt,
    lastSeenAt: createdAt,
    revokedAt: null,
    ipAddress: input.ipAddress ?? '',
    userAgent: input.userAgent ?? '',
  };
}

/** The session-cookie check: present, unrevoked and unexpired. */
export function findActiveSession(token: string, now = Date.now()): SessionRecord | null {
  const row = stmt(
    'SELECT * FROM sessions WHERE token = ? AND revoked_at IS NULL AND expires_at > ?',
  ).get(sessionDigest(token), now);
  return row === undefined ? null : sessionFromRow(row);
}

export function touchSession(token: string, at = Date.now()): void {
  stmt('UPDATE sessions SET last_seen_at = ? WHERE token = ?').run(at, sessionDigest(token));
}

export function revokeSession(token: string, at = Date.now()): void {
  stmt('UPDATE sessions SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL').run(
    at,
    sessionDigest(token),
  );
}

export interface TosAcceptanceRecord extends TosAcceptance {
  id: string;
  deviceFootprint: string;
}

/**
 * Persists the clickwrap consent record and stamps the user row in the same
 * transaction, so the onboarding gate and the non-repudiation evidence can never
 * disagree about whether terms were accepted.
 */
export function recordTosAcceptance(
  input: TosAcceptance & { id?: string; deviceFootprint?: string },
): TosAcceptanceRecord {
  const record: TosAcceptanceRecord = {
    id: input.id ?? randomUUID(),
    userId: input.userId,
    version: input.version,
    acceptedAt: input.acceptedAt,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    scrolledToBottom: input.scrolledToBottom,
    scrollDurationMs: input.scrollDurationMs,
    click: input.click,
    deviceFootprint: input.deviceFootprint ?? '',
  };
  tx(() => {
    stmt(
      `INSERT INTO tos_acceptances
         (id, user_id, version, accepted_at, ip_address, user_agent, device_footprint,
          scrolled_to_bottom, scroll_duration_ms, click_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id,
      record.userId,
      record.version,
      record.acceptedAt,
      record.ipAddress,
      record.userAgent,
      record.deviceFootprint,
      flag(record.scrolledToBottom),
      record.scrollDurationMs,
      jsonText(record.click),
    );
    stmt('UPDATE users SET tos_accepted_at = ?, tos_version = ?, updated_at = ? WHERE id = ?').run(
      record.acceptedAt,
      record.version,
      record.acceptedAt,
      record.userId,
    );
  });
  return record;
}

function tosFromRow(row: SqlRow): TosAcceptanceRecord {
  return {
    id: str(row, 'id'),
    userId: str(row, 'user_id'),
    version: str(row, 'version'),
    acceptedAt: num(row, 'accepted_at'),
    ipAddress: str(row, 'ip_address'),
    userAgent: str(row, 'user_agent'),
    deviceFootprint: str(row, 'device_footprint'),
    scrolledToBottom: bool(row, 'scrolled_to_bottom'),
    scrollDurationMs: num(row, 'scroll_duration_ms'),
    click: jsonColumn(row, 'click_json', {
      clickX: 0,
      clickY: 0,
      viewportWidth: 0,
      viewportHeight: 0,
      clickedAt: num(row, 'accepted_at'),
      trusted: false,
      targetId: '',
    }),
  };
}

export function listTosAcceptances(userId: string): TosAcceptanceRecord[] {
  return stmt('SELECT * FROM tos_acceptances WHERE user_id = ? ORDER BY accepted_at ASC')
    .all(userId)
    .map(tosFromRow);
}

export interface SubscriptionRecord {
  id: string;
  userId: string;
  status: SubscriptionStatus;
  trialEndsAt: number | null;
  currentPeriodEnd: number | null;
  priceCents: number;
  provider: 'stripe' | 'simulated' | null;
  externalId: string | null;
  createdAt: number;
  updatedAt: number;
}

function subscriptionFromRow(row: SqlRow): SubscriptionRecord {
  return {
    id: str(row, 'id'),
    userId: str(row, 'user_id'),
    status: enumOr(row, 'status', SUBSCRIPTION_STATUSES, 'none'),
    trialEndsAt: numOrNull(row, 'trial_ends_at'),
    currentPeriodEnd: numOrNull(row, 'current_period_end'),
    priceCents: num(row, 'price_cents'),
    provider:
      strOrNull(row, 'provider') === null
        ? null
        : enumOr(row, 'provider', SUBSCRIPTION_PROVIDERS, 'simulated'),
    externalId: strOrNull(row, 'external_id'),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at'),
  };
}

export function upsertSubscription(
  input: Omit<SubscriptionRecord, 'id' | 'createdAt' | 'updatedAt'> & {
    id?: string;
    createdAt?: number;
  },
): SubscriptionRecord {
  const now = Date.now();
  stmt(
    `INSERT INTO subscriptions
       (id, user_id, status, trial_ends_at, current_period_end, price_cents, provider,
        external_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       status = excluded.status,
       trial_ends_at = excluded.trial_ends_at,
       current_period_end = excluded.current_period_end,
       price_cents = excluded.price_cents,
       provider = excluded.provider,
       external_id = excluded.external_id,
       updated_at = excluded.updated_at`,
  ).run(
    input.id ?? randomUUID(),
    input.userId,
    input.status,
    input.trialEndsAt,
    input.currentPeriodEnd,
    input.priceCents,
    input.provider,
    input.externalId,
    input.createdAt ?? now,
    now,
  );
  const record = findSubscription(input.userId);
  if (record === null) {
    throw new Error(`[aurelius/db] subscription for ${input.userId} missing after upsert`);
  }
  return record;
}

export function findSubscription(userId: string): SubscriptionRecord | null {
  const row = stmt('SELECT * FROM subscriptions WHERE user_id = ?').get(userId);
  return row === undefined ? null : subscriptionFromRow(row);
}

export interface PaymentRecord {
  id: string;
  userId: string;
  subscriptionId: string | null;
  amountCents: number;
  currency: string;
  status: string;
  provider: string;
  externalId: string | null;
  paidAt: number;
  periodStart: number | null;
  periodEnd: number | null;
  raw: Record<string, unknown> | null;
}

export function insertPayment(input: Omit<PaymentRecord, 'id'> & { id?: string }): PaymentRecord {
  const record: PaymentRecord = { ...input, id: input.id ?? randomUUID() };
  stmt(
    `INSERT INTO payments
       (id, user_id, subscription_id, amount_cents, currency, status, provider, external_id,
        paid_at, period_start, period_end, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.userId,
    record.subscriptionId,
    record.amountCents,
    record.currency,
    record.status,
    record.provider,
    record.externalId,
    record.paidAt,
    record.periodStart,
    record.periodEnd,
    jsonTextOrNull(record.raw),
  );
  return record;
}

function paymentsTotalCents(userId: string, since: number, until = Date.now()): number {
  const row = stmt(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments
       WHERE user_id = ? AND status = 'succeeded' AND paid_at >= ? AND paid_at <= ?`,
  ).get(userId, since, until);
  return row === undefined ? 0 : num(row, 'total');
}

/**
 * The Terms of Service cap aggregate liability at the subscription fees paid in
 * the preceding three months (digest-compliance §MUST IMPLEMENT: "Maintain a
 * queryable immutable subscription payment history so the trailing-three-month
 * liability cap can be computed for any claim date"). Computing it here, from the
 * payment ledger, is what makes the clause enforceable for an arbitrary claim
 * date instead of an estimate.
 */
export function liabilityCapCents(userId: string, claimDate = Date.now()): number {
  const claim = new Date(claimDate);
  const start = Date.UTC(
    claim.getUTCFullYear(),
    claim.getUTCMonth() - 3,
    claim.getUTCDate(),
    claim.getUTCHours(),
    claim.getUTCMinutes(),
    claim.getUTCSeconds(),
    claim.getUTCMilliseconds(),
  );
  return paymentsTotalCents(userId, start, claimDate);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Symbols and market data
// ─────────────────────────────────────────────────────────────────────────────

const UPSERT_SYMBOL = `INSERT INTO symbols
    (symbol, name, sector, industry, market_cap_cents, adv30, shares_outstanding, exchange,
     is_benchmark, reference_beta, dividend_yield, optionable, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (symbol) DO UPDATE SET
    name = excluded.name, sector = excluded.sector, industry = excluded.industry,
    market_cap_cents = excluded.market_cap_cents, adv30 = excluded.adv30,
    shares_outstanding = excluded.shares_outstanding, exchange = excluded.exchange,
    is_benchmark = excluded.is_benchmark, reference_beta = excluded.reference_beta,
    dividend_yield = excluded.dividend_yield, optionable = excluded.optionable,
    updated_at = excluded.updated_at`;

function symbolParams(meta: SymbolMeta, at: number): SqlValue[] {
  return [
    meta.symbol,
    meta.name,
    meta.sector,
    meta.industry,
    toCents(meta.marketCap),
    Math.round(meta.adv30),
    Math.round(meta.sharesOutstanding),
    meta.exchange,
    flag(meta.isBenchmark),
    meta.referenceBeta,
    meta.dividendYield,
    flag(meta.optionable),
    at,
  ];
}

export function upsertSymbols(metas: readonly SymbolMeta[], at = Date.now()): number {
  return tx(() => {
    const statement = stmt(UPSERT_SYMBOL);
    for (const meta of metas) statement.run(...symbolParams(meta, at));
    return metas.length;
  });
}

export function insertDailyBars(symbol: string, bars: readonly Bar[]): number {
  return tx(() => {
    const statement = stmt(
      `INSERT INTO bars_daily
         (symbol, ts, month_bucket, open, high, low, close, volume, vwap, trades)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (symbol, ts) DO UPDATE SET
         open = excluded.open, high = excluded.high, low = excluded.low,
         close = excluded.close, volume = excluded.volume,
         vwap = excluded.vwap, trades = excluded.trades`,
    );
    for (const bar of bars) {
      statement.run(
        symbol,
        bar.time,
        monthBucket(bar.time),
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        Math.round(bar.volume),
        bar.vwap ?? null,
        bar.trades ?? null,
      );
    }
    return bars.length;
  });
}

const UPSERT_QUOTE = `INSERT INTO quotes_snapshot
    (symbol, ts, bid, ask, bid_size, ask_size, last, last_size, volume, previous_close)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (symbol, ts) DO UPDATE SET
    bid = excluded.bid, ask = excluded.ask, bid_size = excluded.bid_size,
    ask_size = excluded.ask_size, last = excluded.last, last_size = excluded.last_size,
    volume = excluded.volume, previous_close = excluded.previous_close`;

function quoteParams(quote: Quote): SqlValue[] {
  return [
    quote.symbol,
    quote.timestamp,
    quote.bid,
    quote.ask,
    Math.round(quote.bidSize),
    Math.round(quote.askSize),
    quote.last,
    Math.round(quote.lastSize),
    Math.round(quote.volume),
    quote.previousClose,
  ];
}

export function insertQuotes(quotes: readonly Quote[]): number {
  return tx(() => {
    const statement = stmt(UPSERT_QUOTE);
    for (const quote of quotes) statement.run(...quoteParams(quote));
    return quotes.length;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Alternative data, features, catalog
// ─────────────────────────────────────────────────────────────────────────────

const INSERT_ALT_EVENT = `INSERT INTO alt_events
    (id, symbol, stream, ts, value, confidence, headline, source, payload_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    value = excluded.value, confidence = excluded.confidence,
    headline = excluded.headline, source = excluded.source, payload_json = excluded.payload_json`;

function altParams(event: AltDataEvent): SqlValue[] {
  return [
    event.id,
    event.symbol,
    event.stream,
    event.timestamp,
    event.value,
    event.confidence,
    event.headline,
    event.source,
    jsonTextOrNull(event.payload),
  ];
}

export function insertAltEvents(events: readonly AltDataEvent[]): number {
  return tx(() => {
    const statement = stmt(INSERT_ALT_EVENT);
    for (const event of events) statement.run(...altParams(event));
    return events.length;
  });
}

export function writeFeatureValues(
  symbol: string,
  asOf: number,
  values: readonly FeatureValue[],
): number {
  return tx(() => {
    const statement = stmt(
      `INSERT INTO feature_values (symbol, as_of, feature_key, value, normalised, state)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (symbol, as_of, feature_key) DO UPDATE SET
         value = excluded.value, normalised = excluded.normalised, state = excluded.state`,
    );
    for (const value of values) {
      statement.run(symbol, asOf, value.key, value.value, value.normalised, value.state);
    }
    return values.length;
  });
}

/**
 * Mirrors the feature registry into `feature_catalog`. The registry is the
 * source of truth in process; the table exists so the CSR-RAG schema pruner and
 * the schema explorer can retrieve over the same descriptions through SQL.
 */
export function syncFeatureCatalog(definitions = FEATURE_DEFINITIONS): number {
  return tx(() => {
    const statement = stmt(
      `INSERT INTO feature_catalog
         (key, label, short_label, feature_group, unit, description, formula, sql_column,
          aliases_json, in_model, display_precision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         label = excluded.label, short_label = excluded.short_label,
         feature_group = excluded.feature_group, unit = excluded.unit,
         description = excluded.description, formula = excluded.formula,
         sql_column = excluded.sql_column, aliases_json = excluded.aliases_json,
         in_model = excluded.in_model, display_precision = excluded.display_precision`,
    );
    for (const definition of definitions) {
      statement.run(
        definition.key,
        definition.label,
        definition.shortLabel,
        definition.group,
        definition.unit,
        definition.description,
        definition.formula,
        definition.sqlColumn,
        jsonText(definition.aliases),
        flag(definition.inModel),
        definition.precision,
      );
    }
    return definitions.length;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Signals, drivers, agents
// ─────────────────────────────────────────────────────────────────────────────

function signalFromRow(
  row: SqlRow,
  drivers: SignalDriver[],
  agents: AgentInference[],
): Signal {
  const latency = jsonColumn<LatencyBreakdown>(row, 'latency_json', {
    stages: [],
    totalMs: num(row, 'latency_total_ms'),
    budgetMs: 150,
    withinBudget: true,
  });
  return {
    id: str(row, 'id'),
    symbol: str(row, 'symbol'),
    generatedAt: num(row, 'generated_at'),
    direction: enumOr(row, 'direction', SIGNAL_DIRECTIONS, 'flat'),
    conviction: num(row, 'conviction'),
    probability: num(row, 'probability'),
    horizonDays: num(row, 'horizon_days'),
    expectedReturn: num(row, 'expected_return'),
    expectedReturnLow: num(row, 'expected_return_low'),
    expectedReturnHigh: num(row, 'expected_return_high'),
    referencePrice: num(row, 'reference_price'),
    levels: {
      entryZoneLow: num(row, 'entry_zone_low'),
      entryZoneHigh: num(row, 'entry_zone_high'),
      invalidation: num(row, 'invalidation'),
      target1: num(row, 'target1'),
      target2: num(row, 'target2'),
    },
    strategy: strOrNull(row, 'strategy'),
    strategiesFired: jsonColumn<string[]>(row, 'strategies_fired_json', []),
    regime: enumOr(row, 'regime', REGIME_LABELS, 'low_volatility_drift'),
    drivers,
    agents,
    features: jsonColumn<FeatureValue[]>(row, 'features_json', []),
    thesis: str(row, 'thesis'),
    counterThesis: str(row, 'counter_thesis'),
    latency,
    attributionResidual: num(row, 'attribution_residual'),
    modelVersion: str(row, 'model_version'),
  };
}

function driverFromRow(row: SqlRow): SignalDriver {
  const definition = featureDefinition(str(row, 'feature_key'));
  return {
    featureKey: str(row, 'feature_key'),
    label: str(row, 'label'),
    group: definition?.group ?? 'regime',
    value: num(row, 'value'),
    shap: num(row, 'shap'),
    share: num(row, 'share'),
    direction: enumOr(row, 'direction', DRIVER_DIRECTIONS, 'positive'),
    state: str(row, 'state'),
    narrative: str(row, 'narrative'),
  };
}

function agentFromRow(row: SqlRow): AgentInference {
  return {
    name: str(row, 'name'),
    architecture: enumOr(row, 'architecture', AGENT_ARCHITECTURES, 'lstm'),
    timeframeMinutes: num(row, 'timeframe_minutes'),
    probability: num(row, 'probability'),
    expectedReturn: num(row, 'expected_return'),
    lower: numOrNull(row, 'lower'),
    upper: numOrNull(row, 'upper'),
    attention: jsonColumn<number[] | null>(row, 'attention_json', null),
    variableWeights: jsonColumn<number[] | null>(row, 'variable_weights_json', null),
    sequenceLength: num(row, 'sequence_length'),
    epoch: num(row, 'epoch'),
    publishedSequence: num(row, 'published_sequence'),
  };
}

/**
 * Writes the signal and its explanation atomically, and mirrors the feature
 * snapshot into `feature_values` so `v_equity_snapshot` — the relation InvestGPT
 * queries — is populated by the act of publishing a signal rather than by a
 * second, skippable step.
 */
export function insertSignal(signal: Signal): Signal {
  tx(() => {
    stmt(
      `INSERT INTO signals
         (id, symbol, generated_at, direction, conviction, probability, horizon_days,
          expected_return, expected_return_low, expected_return_high, reference_price,
          entry_zone_low, entry_zone_high, invalidation, target1, target2, strategy,
          strategies_fired_json, regime, thesis, counter_thesis, latency_json,
          latency_total_ms, attribution_residual, model_version, features_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         conviction = excluded.conviction, probability = excluded.probability,
         direction = excluded.direction, thesis = excluded.thesis,
         counter_thesis = excluded.counter_thesis, features_json = excluded.features_json,
         latency_json = excluded.latency_json, latency_total_ms = excluded.latency_total_ms,
         attribution_residual = excluded.attribution_residual`,
    ).run(
      signal.id,
      signal.symbol,
      signal.generatedAt,
      signal.direction,
      signal.conviction,
      signal.probability,
      signal.horizonDays,
      signal.expectedReturn,
      signal.expectedReturnLow,
      signal.expectedReturnHigh,
      signal.referencePrice,
      signal.levels.entryZoneLow,
      signal.levels.entryZoneHigh,
      signal.levels.invalidation,
      signal.levels.target1,
      signal.levels.target2,
      signal.strategy,
      jsonText(signal.strategiesFired),
      signal.regime,
      signal.thesis,
      signal.counterThesis,
      jsonText(signal.latency),
      signal.latency.totalMs,
      signal.attributionResidual,
      signal.modelVersion,
      jsonText(signal.features),
    );

    stmt('DELETE FROM signal_drivers WHERE signal_id = ?').run(signal.id);
    const driverStatement = stmt(
      `INSERT INTO signal_drivers
         (signal_id, ordinal, feature_key, label, feature_group, value, shap, share,
          direction, state, narrative)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    signal.drivers.forEach((driver, ordinal) => {
      driverStatement.run(
        signal.id,
        ordinal,
        driver.featureKey,
        driver.label,
        driver.group,
        driver.value,
        driver.shap,
        driver.share,
        driver.direction,
        driver.state,
        driver.narrative,
      );
    });

    stmt('DELETE FROM signal_agents WHERE signal_id = ?').run(signal.id);
    const agentStatement = stmt(
      `INSERT INTO signal_agents
         (signal_id, name, architecture, timeframe_minutes, probability, expected_return,
          lower, upper, attention_json, variable_weights_json, sequence_length, epoch,
          published_sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const agent of signal.agents) {
      agentStatement.run(
        signal.id,
        agent.name,
        agent.architecture,
        agent.timeframeMinutes,
        agent.probability,
        agent.expectedReturn,
        agent.lower,
        agent.upper,
        jsonTextOrNull(agent.attention),
        jsonTextOrNull(agent.variableWeights),
        agent.sequenceLength,
        agent.epoch,
        agent.publishedSequence,
      );
    }

    if (signal.features.length > 0) {
      writeFeatureValues(signal.symbol, signal.generatedAt, signal.features);
    }
  });
  return signal;
}

/** Batched hydration: one query for all drivers, one for all agents. */
function hydrateSignals(rows: readonly SqlRow[]): Signal[] {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => str(row, 'id'));
  const marks = placeholders(ids.length);

  const driversById = new Map<string, SignalDriver[]>();
  for (const row of stmt(
    `SELECT * FROM signal_drivers WHERE signal_id IN (${marks}) ORDER BY signal_id, ordinal ASC`,
  ).all(...ids)) {
    const id = str(row, 'signal_id');
    const bucket = driversById.get(id) ?? [];
    bucket.push(driverFromRow(row));
    driversById.set(id, bucket);
  }

  const agentsById = new Map<string, AgentInference[]>();
  for (const row of stmt(
    `SELECT * FROM signal_agents WHERE signal_id IN (${marks})
       ORDER BY signal_id, timeframe_minutes ASC`,
  ).all(...ids)) {
    const id = str(row, 'signal_id');
    const bucket = agentsById.get(id) ?? [];
    bucket.push(agentFromRow(row));
    agentsById.set(id, bucket);
  }

  return rows.map((row) => {
    const id = str(row, 'id');
    return signalFromRow(row, driversById.get(id) ?? [], agentsById.get(id) ?? []);
  });
}

export function getSignal(id: string): Signal | null {
  const row = stmt('SELECT * FROM signals WHERE id = ?').get(id);
  if (row === undefined) return null;
  return hydrateSignals([row])[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Risk decisions, orders, telemetry, intent tokens
// ─────────────────────────────────────────────────────────────────────────────

export interface RiskDecisionContext {
  id?: string;
  orderId?: string | null;
  userId: string;
  symbol: string;
  correlationId?: string | null;
}

export interface RiskDecisionRecord extends RiskDecisionContext {
  id: string;
  decision: RiskDecision;
}

export function insertRiskDecision(
  decision: RiskDecision,
  context: RiskDecisionContext,
): RiskDecisionRecord {
  const id = context.id ?? randomUUID();
  stmt(
    `INSERT INTO risk_decisions
       (id, order_id, user_id, symbol, approved, checks_json, rejection_code, rejection_json,
        evaluated_at, elapsed_ms, spiffe_id, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    context.orderId ?? null,
    context.userId,
    context.symbol,
    flag(decision.approved),
    jsonText(decision.checks),
    decision.rejection?.code ?? null,
    jsonTextOrNull(decision.rejection),
    decision.evaluatedAt,
    decision.elapsedMs,
    decision.spiffeId,
    context.correlationId ?? null,
  );
  return { ...context, id, decision };
}

function riskDecisionFromRow(row: SqlRow): RiskDecisionRecord {
  const checks = jsonColumn<RiskCheckResult[]>(row, 'checks_json', []);
  return {
    id: str(row, 'id'),
    orderId: strOrNull(row, 'order_id'),
    userId: str(row, 'user_id'),
    symbol: str(row, 'symbol'),
    correlationId: strOrNull(row, 'correlation_id'),
    decision: {
      approved: bool(row, 'approved'),
      checks,
      rejection: jsonColumn<RiskCheckResult | null>(row, 'rejection_json', null),
      evaluatedAt: num(row, 'evaluated_at'),
      spiffeId: str(row, 'spiffe_id'),
      elapsedMs: num(row, 'elapsed_ms'),
    },
  };
}

export interface RiskDecisionQuery {
  userId?: string;
  orderId?: string;
  approved?: boolean;
  since?: number;
  limit?: number;
}

export function listRiskDecisions(query: RiskDecisionQuery = {}): RiskDecisionRecord[] {
  const clauses = ['evaluated_at >= ?'];
  const params: SqlValue[] = [query.since ?? 0];
  if (query.userId !== undefined) {
    clauses.push('user_id = ?');
    params.push(query.userId);
  }
  if (query.orderId !== undefined) {
    clauses.push('order_id = ?');
    params.push(query.orderId);
  }
  if (query.approved !== undefined) {
    clauses.push('approved = ?');
    params.push(flag(query.approved));
  }
  params.push(query.limit ?? 100);
  return stmt(
    `SELECT * FROM risk_decisions WHERE ${clauses.join(' AND ')}
       ORDER BY evaluated_at DESC LIMIT ?`,
  )
    .all(...params)
    .map(riskDecisionFromRow);
}

/** Rejection histogram for the compliance console. */
export function rejectionCounts(since = 0): { code: RiskRejectionCode; count: number }[] {
  return stmt(
    `SELECT rejection_code AS code, COUNT(*) AS n FROM risk_decisions
       WHERE rejection_code IS NOT NULL AND evaluated_at >= ?
       GROUP BY rejection_code ORDER BY n DESC`,
  )
    .all(since)
    .map((row) => ({ code: str(row, 'code') as RiskRejectionCode, count: num(row, 'n') }));
}

export interface OrderWriteMeta {
  /** Order notional in cents, for the per-order and per-day ceilings. */
  notionalCents?: number;
  intentToken?: string | null;
  correlationId?: string | null;
  /** Existing risk-decision row; one is written from `order.riskDecision` if absent. */
  riskDecisionId?: string | null;
}

const ORDER_COLUMNS = `id, user_id, symbol, side, type, quantity, limit_price, stop_price,
  time_in_force, account, status, filled_quantity, average_fill_price, notional_cents,
  created_at, updated_at, signal_id, risk_decision_id, intent_token, broker_request_json,
  broker_status, broker_response_json, broker_order_id, correlation_id`;

/**
 * Writes the order and, unless one is supplied, the risk decision that cleared
 * it — in a single transaction, because an order row that is not joinable to a
 * risk decision is exactly the gap the Market Access Rule shield is supposed to
 * make impossible.
 */
export function insertOrder(order: Order, meta: OrderWriteMeta = {}): Order {
  tx(() => {
    let riskDecisionId = meta.riskDecisionId ?? null;
    if (riskDecisionId === null) {
      riskDecisionId = insertRiskDecision(order.riskDecision, {
        orderId: order.id,
        userId: order.userId,
        symbol: order.symbol,
        correlationId: meta.correlationId ?? null,
      }).id;
    }
    stmt(
      `INSERT INTO orders (${ORDER_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      order.id,
      order.userId,
      order.symbol,
      order.side,
      order.type,
      Math.round(order.quantity),
      order.limitPrice,
      order.stopPrice,
      order.timeInForce,
      order.account,
      order.status,
      Math.round(order.filledQuantity),
      order.averageFillPrice,
      meta.notionalCents ?? 0,
      order.createdAt,
      order.updatedAt,
      order.signalId,
      riskDecisionId,
      meta.intentToken ?? null,
      jsonTextOrNull(order.brokerRequest),
      order.brokerStatus,
      jsonTextOrNull(order.brokerResponse),
      order.brokerOrderId,
      meta.correlationId ?? null,
    );
  });
  return order;
}

export interface OrderExecutionUpdate {
  status?: OrderStatus;
  filledQuantity?: number;
  averageFillPrice?: number | null;
  brokerStatus?: number | null;
  brokerResponse?: Record<string, unknown> | null;
  brokerOrderId?: string | null;
  updatedAt?: number;
}

/**
 * Order rows carry current execution state, so they are updatable — the
 * immutable record of every transition lives in `audit_events` and the
 * bitemporal ledger, which is where the no-UPDATE guarantee is required.
 */
export function updateOrderExecution(orderId: string, update: OrderExecutionUpdate): void {
  const assignments: string[] = ['updated_at = ?'];
  const params: SqlValue[] = [update.updatedAt ?? Date.now()];
  if (update.status !== undefined) {
    assignments.push('status = ?');
    params.push(update.status);
  }
  if (update.filledQuantity !== undefined) {
    assignments.push('filled_quantity = ?');
    params.push(Math.round(update.filledQuantity));
  }
  if (update.averageFillPrice !== undefined) {
    assignments.push('average_fill_price = ?');
    params.push(update.averageFillPrice);
  }
  if (update.brokerStatus !== undefined) {
    assignments.push('broker_status = ?');
    params.push(update.brokerStatus);
  }
  if (update.brokerResponse !== undefined) {
    assignments.push('broker_response_json = ?');
    params.push(jsonTextOrNull(update.brokerResponse));
  }
  if (update.brokerOrderId !== undefined) {
    assignments.push('broker_order_id = ?');
    params.push(update.brokerOrderId);
  }
  params.push(orderId);
  stmt(`UPDATE orders SET ${assignments.join(', ')} WHERE id = ?`).run(...params);
}

const NEUTRAL_RISK_DECISION: RiskDecision = {
  approved: false,
  checks: [],
  rejection: null,
  evaluatedAt: 0,
  spiffeId: 'spiffe://aurelius/unattributed',
  elapsedMs: 0,
};

function orderFromRow(row: SqlRow, riskDecision: RiskDecision): Order {
  return {
    id: str(row, 'id'),
    userId: str(row, 'user_id'),
    symbol: str(row, 'symbol'),
    side: enumOr(row, 'side', ORDER_SIDES, 'buy'),
    type: enumOr(row, 'type', ORDER_TYPES, 'market'),
    quantity: num(row, 'quantity'),
    limitPrice: numOrNull(row, 'limit_price'),
    stopPrice: numOrNull(row, 'stop_price'),
    timeInForce: enumOr(row, 'time_in_force', TIME_IN_FORCES, 'day'),
    account: enumOr(row, 'account', ACCOUNT_KINDS, 'paper'),
    status: enumOr(row, 'status', ORDER_STATUSES, 'pending_risk'),
    filledQuantity: num(row, 'filled_quantity'),
    averageFillPrice: numOrNull(row, 'average_fill_price'),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at'),
    signalId: strOrNull(row, 'signal_id'),
    riskDecision,
    brokerRequest: jsonColumn<Record<string, unknown> | null>(row, 'broker_request_json', null),
    brokerStatus: numOrNull(row, 'broker_status'),
    brokerResponse: jsonColumn<Record<string, unknown> | null>(row, 'broker_response_json', null),
    brokerOrderId: strOrNull(row, 'broker_order_id'),
  };
}

/** Batched hydration of the embedded risk decisions. */
function hydrateOrders(rows: readonly SqlRow[]): Order[] {
  if (rows.length === 0) return [];
  const ids = rows
    .map((row) => strOrNull(row, 'risk_decision_id'))
    .filter((id): id is string => id !== null);
  const decisions = new Map<string, RiskDecision>();
  if (ids.length > 0) {
    for (const row of stmt(
      `SELECT * FROM risk_decisions WHERE id IN (${placeholders(ids.length)})`,
    ).all(...ids)) {
      decisions.set(str(row, 'id'), riskDecisionFromRow(row).decision);
    }
  }
  return rows.map((row) => {
    const id = strOrNull(row, 'risk_decision_id');
    const decision = id === null ? undefined : decisions.get(id);
    return orderFromRow(row, decision ?? NEUTRAL_RISK_DECISION);
  });
}

export function getOrder(id: string): Order | null {
  const row = stmt('SELECT * FROM orders WHERE id = ?').get(id);
  if (row === undefined) return null;
  return hydrateOrders([row])[0] ?? null;
}

export interface OrderQuery {
  userId?: string;
  symbol?: string;
  status?: OrderStatus;
  account?: 'paper' | 'live';
  since?: number;
  limit?: number;
}

export function listOrders(query: OrderQuery = {}): Order[] {
  const clauses = ['created_at >= ?'];
  const params: SqlValue[] = [query.since ?? 0];
  for (const [column, value] of [
    ['user_id', query.userId],
    ['symbol', query.symbol],
    ['status', query.status],
    ['account', query.account],
  ] as const) {
    if (value !== undefined) {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }
  params.push(query.limit ?? 200);
  const rows = stmt(
    `SELECT * FROM orders WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
  ).all(...params);
  return hydrateOrders(rows);
}

const OPEN_STATUSES: readonly OrderStatus[] = ['pending_risk', 'submitted', 'partially_filled'];

export function listOpenOrders(userId?: string): Order[] {
  const marks = placeholders(OPEN_STATUSES.length);
  const params: SqlValue[] = [...OPEN_STATUSES];
  let where = `status IN (${marks})`;
  if (userId !== undefined) {
    where += ' AND user_id = ?';
    params.push(userId);
  }
  const rows = stmt(`SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC`).all(...params);
  return hydrateOrders(rows);
}

/**
 * Notional this user has already had accepted during the session containing
 * `since`, in USD.
 *
 * Feeds Control 1's aggregate daily ceiling, which was published at $500,000 and
 * enforced at nothing: no `DailyNotionalPort` was wired, so `usedToday`
 * defaulted to 0 on every request and the check compared one order against the
 * ceiling instead of the day's running total. Eight sequential $93,500 orders
 * routed to $748,000 in a single session, each one recording
 * `{"passed":true,"observed":93500}` in the ledger.
 *
 * A rejected order never reached a venue, so it does not consume the allowance;
 * everything else does, including one the broker refused, because the platform's
 * ceiling is on what it *transmits*.
 */
export function acceptedNotionalUsdSince(userId: string, since: number): number {
  const row = stmt(
    `SELECT COALESCE(SUM(notional_cents), 0) AS cents
       FROM orders
      WHERE user_id = ? AND created_at >= ? AND status <> 'rejected_risk'`,
  ).get(userId, since);
  return row === undefined ? 0 : num(row, 'cents') / 100;
}

/** True when this idempotency key has already been accepted for this user. */
export function idempotencyKeySeen(key: string, since = 0): boolean {
  const row = stmt('SELECT 1 AS hit FROM idempotency_keys WHERE key = ? AND accepted_at >= ?').get(
    key,
    since,
  );
  return row !== undefined;
}

/** Remembers an accepted key. Idempotent: a replay records nothing new. */
export function recordIdempotencyKey(
  key: string,
  userId: string,
  acceptedAt: number,
  orderId: string | null = null,
): void {
  stmt(
    `INSERT INTO idempotency_keys (key, user_id, accepted_at, order_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO NOTHING`,
  ).run(key, userId, acceptedAt, orderId);
}

export function insertOrderTelemetry(telemetry: OrderTelemetry): void {
  stmt(
    `INSERT INTO order_telemetry
       (order_id, client_click, server_received, risk_completed, broker_dispatched,
        broker_acknowledged, spiffe_id, ip_address, user_agent, click_json, raw_payload,
        broker_status, broker_body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (order_id) DO UPDATE SET
       broker_acknowledged = excluded.broker_acknowledged,
       broker_status = excluded.broker_status,
       broker_body = excluded.broker_body`,
  ).run(
    telemetry.orderId,
    telemetry.timestamps.clientClick,
    telemetry.timestamps.serverReceived,
    telemetry.timestamps.riskCompleted,
    telemetry.timestamps.brokerDispatched,
    telemetry.timestamps.brokerAcknowledged,
    telemetry.spiffeId,
    telemetry.ipAddress,
    telemetry.userAgent,
    jsonText(telemetry.click),
    telemetry.rawPayload,
    telemetry.brokerStatus,
    telemetry.brokerBody,
  );
}

function telemetryFromRow(row: SqlRow): OrderTelemetry {
  return {
    orderId: str(row, 'order_id'),
    timestamps: {
      clientClick: num(row, 'client_click'),
      serverReceived: num(row, 'server_received'),
      riskCompleted: num(row, 'risk_completed'),
      brokerDispatched: num(row, 'broker_dispatched'),
      brokerAcknowledged: numOrNull(row, 'broker_acknowledged'),
    },
    spiffeId: str(row, 'spiffe_id'),
    ipAddress: str(row, 'ip_address'),
    userAgent: str(row, 'user_agent'),
    click: jsonColumn(row, 'click_json', {
      clickX: 0,
      clickY: 0,
      viewportWidth: 0,
      viewportHeight: 0,
      clickedAt: num(row, 'client_click'),
      trusted: false,
      targetId: '',
    }),
    rawPayload: str(row, 'raw_payload'),
    brokerStatus: numOrNull(row, 'broker_status'),
    brokerBody: strOrNull(row, 'broker_body'),
  };
}

export function getOrderTelemetry(orderId: string): OrderTelemetry | null {
  const row = stmt('SELECT * FROM order_telemetry WHERE order_id = ?').get(orderId);
  return row === undefined ? null : telemetryFromRow(row);
}

export function listRecentTelemetry(limit = 50): OrderTelemetry[] {
  return stmt('SELECT * FROM order_telemetry ORDER BY client_click DESC LIMIT ?')
    .all(limit)
    .map(telemetryFromRow);
}

export interface IntentTokenRecord {
  token: string;
  userId: string;
  symbol: string;
  sessionToken: string | null;
  mintedAt: number;
  expiresAt: number;
  consumedAt: number | null;
  orderId: string | null;
  correlationId: string | null;
}

export interface MintIntentTokenInput {
  token: string;
  userId: string;
  symbol: string;
  mintedAt: number;
  expiresAt: number;
  sessionToken?: string | null;
  click?: unknown;
  correlationId?: string | null;
}

export function mintIntentToken(input: MintIntentTokenInput): IntentTokenRecord {
  stmt(
    `INSERT INTO intent_tokens
       (token, user_id, symbol, session_token, minted_at, expires_at, consumed_at, order_id,
        click_json, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    input.token,
    input.userId,
    input.symbol,
    input.sessionToken == null ? null : sessionDigest(input.sessionToken),
    input.mintedAt,
    input.expiresAt,
    jsonText(input.click ?? null),
    input.correlationId ?? null,
  );
  return {
    token: input.token,
    userId: input.userId,
    symbol: input.symbol,
    sessionToken: input.sessionToken ?? null,
    mintedAt: input.mintedAt,
    expiresAt: input.expiresAt,
    consumedAt: null,
    orderId: null,
    correlationId: input.correlationId ?? null,
  };
}

function intentFromRow(row: SqlRow): IntentTokenRecord {
  return {
    token: str(row, 'token'),
    userId: str(row, 'user_id'),
    symbol: str(row, 'symbol'),
    sessionToken: strOrNull(row, 'session_token'),
    mintedAt: num(row, 'minted_at'),
    expiresAt: num(row, 'expires_at'),
    consumedAt: numOrNull(row, 'consumed_at'),
    orderId: strOrNull(row, 'order_id'),
    correlationId: strOrNull(row, 'correlation_id'),
  };
}

export function findIntentToken(token: string): IntentTokenRecord | null {
  const row = stmt('SELECT * FROM intent_tokens WHERE token = ?').get(token);
  return row === undefined ? null : intentFromRow(row);
}

export type IntentTokenRejection =
  | 'unknown_token'
  | 'already_consumed'
  | 'expired'
  | 'wrong_user'
  | 'wrong_symbol';

export interface IntentTokenConsumption {
  ok: boolean;
  reason: IntentTokenRejection | null;
  record: IntentTokenRecord | null;
}

/**
 * Burns a token for exactly one security, exactly once.
 *
 * The single-use guarantee is the UPDATE's own WHERE clause — `consumed_at IS
 * NULL` combined with the primary key means two concurrent submissions of the
 * same click can never both report success, whatever the request interleaving.
 * A follow-up read only classifies the failure for the audit record.
 */
export function consumeIntentToken(
  token: string,
  expect: { userId: string; symbol: string; now?: number; orderId?: string | null },
): IntentTokenConsumption {
  const now = expect.now ?? Date.now();
  const applied = changes(
    stmt(
      `UPDATE intent_tokens SET consumed_at = ?, order_id = ?
         WHERE token = ? AND consumed_at IS NULL AND expires_at >= ?
           AND user_id = ? AND symbol = ?`,
    ).run(now, expect.orderId ?? null, token, now, expect.userId, expect.symbol),
  );
  const record = findIntentToken(token);
  if (applied === 1) return { ok: true, reason: null, record };
  if (record === null) return { ok: false, reason: 'unknown_token', record: null };
  if (record.consumedAt !== null) return { ok: false, reason: 'already_consumed', record };
  if (record.userId !== expect.userId) return { ok: false, reason: 'wrong_user', record };
  if (record.symbol !== expect.symbol) return { ok: false, reason: 'wrong_symbol', record };
  return { ok: false, reason: 'expired', record };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Positions and accounts
// ─────────────────────────────────────────────────────────────────────────────

export function upsertPosition(userId: string, position: Position, at = Date.now()): void {
  stmt(
    `INSERT INTO positions
       (user_id, account, symbol, quantity, average_entry, market_price, market_value_cents,
        unrealised_pnl_cents, unrealised_pnl_percent, realised_pnl_cents, opened_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, account, symbol) DO UPDATE SET
       quantity = excluded.quantity, average_entry = excluded.average_entry,
       market_price = excluded.market_price, market_value_cents = excluded.market_value_cents,
       unrealised_pnl_cents = excluded.unrealised_pnl_cents,
       unrealised_pnl_percent = excluded.unrealised_pnl_percent,
       realised_pnl_cents = excluded.realised_pnl_cents, updated_at = excluded.updated_at`,
  ).run(
    userId,
    position.account,
    position.symbol,
    Math.round(position.quantity),
    position.averageEntry,
    position.marketPrice,
    toCents(position.marketValue),
    toCents(position.unrealisedPnl),
    position.unrealisedPnlPercent,
    toCents(position.realisedPnl),
    position.openedAt,
    at,
  );
}

function positionFromRow(row: SqlRow): Position {
  return {
    symbol: str(row, 'symbol'),
    quantity: num(row, 'quantity'),
    averageEntry: num(row, 'average_entry'),
    marketPrice: num(row, 'market_price'),
    marketValue: fromCents(num(row, 'market_value_cents')),
    unrealisedPnl: fromCents(num(row, 'unrealised_pnl_cents')),
    unrealisedPnlPercent: num(row, 'unrealised_pnl_percent'),
    realisedPnl: fromCents(num(row, 'realised_pnl_cents')),
    openedAt: num(row, 'opened_at'),
    account: enumOr(row, 'account', ACCOUNT_KINDS, 'paper'),
  };
}

function listPositions(userId: string, account: 'paper' | 'live'): Position[] {
  return stmt(
    'SELECT * FROM positions WHERE user_id = ? AND account = ? ORDER BY symbol ASC',
  )
    .all(userId, account)
    .map(positionFromRow);
}

/** Positions are persisted alongside, so `getAccount` can rebuild the snapshot. */
export function upsertAccount(userId: string, snapshot: AccountSnapshot): void {
  tx(() => {
    stmt(
      `INSERT INTO accounts
         (user_id, account, cash_cents, equity_cents, buying_power_cents, gross_exposure_cents,
          net_exposure_cents, maintenance_margin_cents, day_pnl_cents, total_pnl_cents, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, account) DO UPDATE SET
         cash_cents = excluded.cash_cents, equity_cents = excluded.equity_cents,
         buying_power_cents = excluded.buying_power_cents,
         gross_exposure_cents = excluded.gross_exposure_cents,
         net_exposure_cents = excluded.net_exposure_cents,
         maintenance_margin_cents = excluded.maintenance_margin_cents,
         day_pnl_cents = excluded.day_pnl_cents, total_pnl_cents = excluded.total_pnl_cents,
         updated_at = excluded.updated_at`,
    ).run(
      userId,
      snapshot.account,
      toCents(snapshot.cash),
      toCents(snapshot.equity),
      toCents(snapshot.buyingPower),
      toCents(snapshot.grossExposure),
      toCents(snapshot.netExposure),
      toCents(snapshot.maintenanceMargin),
      toCents(snapshot.dayPnl),
      toCents(snapshot.totalPnl),
      snapshot.updatedAt,
    );
    for (const position of snapshot.positions) {
      upsertPosition(userId, position, snapshot.updatedAt);
    }
  });
}

export function getAccount(userId: string, account: 'paper' | 'live'): AccountSnapshot | null {
  const row = stmt('SELECT * FROM accounts WHERE user_id = ? AND account = ?').get(userId, account);
  if (row === undefined) return null;
  return {
    account,
    cash: fromCents(num(row, 'cash_cents')),
    equity: fromCents(num(row, 'equity_cents')),
    buyingPower: fromCents(num(row, 'buying_power_cents')),
    grossExposure: fromCents(num(row, 'gross_exposure_cents')),
    netExposure: fromCents(num(row, 'net_exposure_cents')),
    maintenanceMargin: fromCents(num(row, 'maintenance_margin_cents')),
    dayPnl: fromCents(num(row, 'day_pnl_cents')),
    totalPnl: fromCents(num(row, 'total_pnl_cents')),
    positions: listPositions(userId, account),
    updatedAt: num(row, 'updated_at'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Watchlists
// ─────────────────────────────────────────────────────────────────────────────

export interface WatchlistRecord {
  id: string;
  userId: string;
  name: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WatchlistItemRecord {
  watchlistId: string;
  symbol: string;
  ordinal: number;
  addedAt: number;
  note: string | null;
}

function watchlistFromRow(row: SqlRow): WatchlistRecord {
  return {
    id: str(row, 'id'),
    userId: str(row, 'user_id'),
    name: str(row, 'name'),
    isDefault: bool(row, 'is_default'),
    createdAt: num(row, 'created_at'),
    updatedAt: num(row, 'updated_at'),
  };
}

export function createWatchlist(input: {
  id?: string;
  userId: string;
  name: string;
  isDefault?: boolean;
  createdAt?: number;
}): WatchlistRecord {
  const now = input.createdAt ?? Date.now();
  const record: WatchlistRecord = {
    id: input.id ?? randomUUID(),
    userId: input.userId,
    name: input.name,
    isDefault: input.isDefault ?? false,
    createdAt: now,
    updatedAt: now,
  };
  stmt(
    `INSERT INTO watchlists (id, user_id, name, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, name) DO UPDATE SET
       is_default = excluded.is_default, updated_at = excluded.updated_at`,
  ).run(record.id, record.userId, record.name, flag(record.isDefault), now, now);
  const stored = getWatchlistByName(record.userId, record.name);
  return stored ?? record;
}

export function listWatchlists(userId: string): WatchlistRecord[] {
  return stmt('SELECT * FROM watchlists WHERE user_id = ? ORDER BY is_default DESC, name ASC')
    .all(userId)
    .map(watchlistFromRow);
}

export function getWatchlist(id: string): WatchlistRecord | null {
  const row = stmt('SELECT * FROM watchlists WHERE id = ?').get(id);
  return row === undefined ? null : watchlistFromRow(row);
}

export function getWatchlistByName(userId: string, name: string): WatchlistRecord | null {
  const row = stmt('SELECT * FROM watchlists WHERE user_id = ? AND name = ?').get(userId, name);
  return row === undefined ? null : watchlistFromRow(row);
}

export function renameWatchlist(id: string, name: string): void {
  stmt('UPDATE watchlists SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
}

export function deleteWatchlist(id: string): void {
  // ON DELETE CASCADE removes the items; the explicit delete keeps the intent
  // legible if foreign keys are ever disabled for a bulk import.
  tx(() => {
    stmt('DELETE FROM watchlist_items WHERE watchlist_id = ?').run(id);
    stmt('DELETE FROM watchlists WHERE id = ?').run(id);
  });
}

export function addWatchlistItem(input: {
  watchlistId: string;
  symbol: string;
  ordinal?: number;
  addedAt?: number;
  note?: string | null;
}): void {
  const now = input.addedAt ?? Date.now();
  tx(() => {
    stmt(
      `INSERT INTO watchlist_items (watchlist_id, symbol, ordinal, added_at, note)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (watchlist_id, symbol) DO UPDATE SET
         ordinal = excluded.ordinal, note = excluded.note`,
    ).run(input.watchlistId, input.symbol, input.ordinal ?? 0, now, input.note ?? null);
    stmt('UPDATE watchlists SET updated_at = ? WHERE id = ?').run(now, input.watchlistId);
  });
}

export function removeWatchlistItem(watchlistId: string, symbol: string): void {
  tx(() => {
    stmt('DELETE FROM watchlist_items WHERE watchlist_id = ? AND symbol = ?').run(
      watchlistId,
      symbol,
    );
    stmt('UPDATE watchlists SET updated_at = ? WHERE id = ?').run(Date.now(), watchlistId);
  });
}

export function listWatchlistItems(watchlistId: string): WatchlistItemRecord[] {
  return stmt(
    'SELECT * FROM watchlist_items WHERE watchlist_id = ? ORDER BY ordinal ASC, symbol ASC',
  )
    .all(watchlistId)
    .map((row) => ({
      watchlistId: str(row, 'watchlist_id'),
      symbol: str(row, 'symbol'),
      ordinal: num(row, 'ordinal'),
      addedAt: num(row, 'added_at'),
      note: strOrNull(row, 'note'),
    }));
}

export function setWatchlistItems(watchlistId: string, symbols: readonly string[]): void {
  const now = Date.now();
  tx(() => {
    stmt('DELETE FROM watchlist_items WHERE watchlist_id = ?').run(watchlistId);
    const statement = stmt(
      `INSERT INTO watchlist_items (watchlist_id, symbol, ordinal, added_at, note)
       VALUES (?, ?, ?, ?, NULL)`,
    );
    symbols.forEach((symbol, ordinal) => statement.run(watchlistId, symbol, ordinal, now));
    stmt('UPDATE watchlists SET updated_at = ? WHERE id = ?').run(now, watchlistId);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  RAG corpus
// ─────────────────────────────────────────────────────────────────────────────

export interface RagDocumentRecord {
  id: string;
  title: string;
  sourceType: RagSourceType;
  symbol: string | null;
  section: string;
  authority: number;
  publishedAt: number;
  url: string | null;
  body: string;
  checksum: string;
  ingestedAt: number;
}

export interface RagChunkRecord {
  id: string;
  documentId: string;
  ordinal: number;
  section: string;
  text: string;
  tokenCount: number;
  embedding: number[] | null;
}

/** Float32 little-endian, so an embedding costs 4 bytes per dimension. */
function encodeEmbedding(values: readonly number[]): Uint8Array {
  const floats = new Float32Array(values.length);
  floats.set(values);
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

function decodeEmbedding(bytes: Uint8Array): number[] {
  const aligned = new Uint8Array(bytes.byteLength);
  aligned.set(bytes);
  return Array.from(new Float32Array(aligned.buffer));
}

export function upsertRagDocument(document: RagDocumentRecord): void {
  stmt(
    `INSERT INTO rag_documents
       (id, title, source_type, symbol, section, authority, published_at, url, body,
        checksum, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       title = excluded.title, source_type = excluded.source_type, symbol = excluded.symbol,
       section = excluded.section, authority = excluded.authority,
       published_at = excluded.published_at, url = excluded.url, body = excluded.body,
       checksum = excluded.checksum, ingested_at = excluded.ingested_at`,
  ).run(
    document.id,
    document.title,
    document.sourceType,
    document.symbol,
    document.section,
    document.authority,
    document.publishedAt,
    document.url,
    document.body,
    document.checksum,
    document.ingestedAt,
  );
}

function ragDocumentFromRow(row: SqlRow): RagDocumentRecord {
  return {
    id: str(row, 'id'),
    title: str(row, 'title'),
    sourceType: enumOr(row, 'source_type', RAG_SOURCE_TYPES, 'news'),
    symbol: strOrNull(row, 'symbol'),
    section: str(row, 'section'),
    authority: num(row, 'authority', 0.5),
    publishedAt: num(row, 'published_at'),
    url: strOrNull(row, 'url'),
    body: str(row, 'body'),
    checksum: str(row, 'checksum'),
    ingestedAt: num(row, 'ingested_at'),
  };
}

export function insertRagChunks(chunks: readonly RagChunkRecord[]): number {
  return tx(() => {
    const statement = stmt(
      `INSERT INTO rag_chunks
         (id, document_id, ordinal, section, text, token_count, embedding, embedding_dim)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         section = excluded.section, text = excluded.text,
         token_count = excluded.token_count, embedding = excluded.embedding,
         embedding_dim = excluded.embedding_dim`,
    );
    for (const chunk of chunks) {
      statement.run(
        chunk.id,
        chunk.documentId,
        chunk.ordinal,
        chunk.section,
        chunk.text,
        chunk.tokenCount,
        chunk.embedding === null ? null : encodeEmbedding(chunk.embedding),
        chunk.embedding === null ? null : chunk.embedding.length,
      );
    }
    return chunks.length;
  });
}

function ragChunkFromRow(row: SqlRow): RagChunkRecord {
  const bytes = bytesOrNull(row, 'embedding');
  return {
    id: str(row, 'id'),
    documentId: str(row, 'document_id'),
    ordinal: num(row, 'ordinal'),
    section: str(row, 'section'),
    text: str(row, 'text'),
    tokenCount: num(row, 'token_count'),
    embedding: bytes === null ? null : decodeEmbedding(bytes),
  };
}

export interface RagDocumentQuery {
  symbol?: string;
  sourceType?: RagSourceType;
  since?: number;
  limit?: number;
}

export function listRagDocuments(query: RagDocumentQuery = {}): RagDocumentRecord[] {
  const clauses = ['published_at >= ?'];
  const params: SqlValue[] = [query.since ?? 0];
  if (query.symbol !== undefined) {
    clauses.push('symbol = ?');
    params.push(query.symbol);
  }
  if (query.sourceType !== undefined) {
    clauses.push('source_type = ?');
    params.push(query.sourceType);
  }
  params.push(query.limit ?? 200);
  return stmt(
    `SELECT * FROM rag_documents WHERE ${clauses.join(' AND ')}
       ORDER BY published_at DESC LIMIT ?`,
  )
    .all(...params)
    .map(ragDocumentFromRow);
}

export function listAllRagChunks(limit = 5000): RagChunkRecord[] {
  return stmt('SELECT * FROM rag_chunks ORDER BY document_id, ordinal ASC LIMIT ?')
    .all(limit)
    .map(ragChunkFromRow);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Kill switch, audit trail, throttles
// ─────────────────────────────────────────────────────────────────────────────

const DISENGAGED: KillSwitchState = {
  engaged: false,
  engagedAt: null,
  engagedBy: null,
  reason: null,
  cancelledOrders: 0,
};

export interface KillSwitchEvent extends KillSwitchState {
  id: string;
  recordedAt: number;
}

/** Appends an engagement or release event; current state is the newest row. */
export function recordKillSwitch(
  state: KillSwitchState,
  options: { id?: string; recordedAt?: number } = {},
): KillSwitchEvent {
  const event: KillSwitchEvent = {
    ...state,
    id: options.id ?? randomUUID(),
    recordedAt: options.recordedAt ?? Date.now(),
  };
  stmt(
    `INSERT INTO kill_switch
       (id, engaged, engaged_at, engaged_by, reason, cancelled_orders, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    flag(event.engaged),
    event.engagedAt,
    event.engagedBy,
    event.reason,
    Math.round(event.cancelledOrders),
    event.recordedAt,
  );
  return event;
}

function killSwitchFromRow(row: SqlRow): KillSwitchEvent {
  return {
    id: str(row, 'id'),
    engaged: bool(row, 'engaged'),
    engagedAt: numOrNull(row, 'engaged_at'),
    engagedBy: strOrNull(row, 'engaged_by'),
    reason: strOrNull(row, 'reason'),
    cancelledOrders: num(row, 'cancelled_orders'),
    recordedAt: num(row, 'recorded_at'),
  };
}

/** Defaults to disengaged so an empty ledger never blocks the platform. */
export function killSwitchState(): KillSwitchState {
  const row = stmt('SELECT * FROM kill_switch ORDER BY recorded_at DESC, id DESC LIMIT 1').get();
  if (row === undefined) return { ...DISENGAGED };
  const event = killSwitchFromRow(row);
  return {
    engaged: event.engaged,
    engagedAt: event.engagedAt,
    engagedBy: event.engagedBy,
    reason: event.reason,
    cancelledOrders: event.cancelledOrders,
  };
}

export function killSwitchHistory(limit = 50): KillSwitchEvent[] {
  return stmt('SELECT * FROM kill_switch ORDER BY recorded_at DESC LIMIT ?')
    .all(limit)
    .map(killSwitchFromRow);
}

/**
 * One row per user interaction, carrying the six mandatory audit fields. The
 * shape mirrors digest-compliance §"Required audit log field count" exactly, and
 * error presentations ("'Broker API Error' displayed at 10:01:45.203") are
 * recorded here as ordinary events — the mandate treats the presentation itself
 * as auditable.
 */
export interface AuditEventRecord {
  id: string;
  occurredAt: number;
  eventType: string;
  userId: string | null;
  sessionToken: string | null;
  ipAddress: string;
  userAgent: string;
  clickX: number | null;
  clickY: number | null;
  resource: string | null;
  orderId: string | null;
  rawPayload: string | null;
  brokerStatus: number | null;
  brokerBody: string | null;
  spiffeId: string;
  correlationId: string | null;
}

export type AuditEventInput = Omit<
  AuditEventRecord,
  'id' | 'occurredAt' | 'ipAddress' | 'userAgent' | 'spiffeId'
> &
  Partial<Pick<AuditEventRecord, 'id' | 'occurredAt' | 'ipAddress' | 'userAgent' | 'spiffeId'>>;

export function insertAuditEvent(input: AuditEventInput): AuditEventRecord {
  const record: AuditEventRecord = {
    ...input,
    id: input.id ?? randomUUID(),
    occurredAt: input.occurredAt ?? Date.now(),
    ipAddress: input.ipAddress ?? '',
    userAgent: input.userAgent ?? '',
    spiffeId: input.spiffeId ?? 'spiffe://aurelius/unattributed',
  };
  stmt(
    `INSERT INTO audit_events
       (id, occurred_at, event_type, user_id, session_token, ip_address, user_agent,
        click_x, click_y, resource, order_id, raw_payload, broker_status, broker_body,
        spiffe_id, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.occurredAt,
    record.eventType,
    record.userId,
    record.sessionToken === null ? null : sessionDigest(record.sessionToken),
    record.ipAddress,
    record.userAgent,
    record.clickX,
    record.clickY,
    record.resource,
    record.orderId,
    record.rawPayload,
    record.brokerStatus,
    record.brokerBody,
    record.spiffeId,
    record.correlationId,
  );
  return record;
}

function auditFromRow(row: SqlRow): AuditEventRecord {
  return {
    id: str(row, 'id'),
    occurredAt: num(row, 'occurred_at'),
    eventType: str(row, 'event_type'),
    userId: strOrNull(row, 'user_id'),
    sessionToken: strOrNull(row, 'session_token'),
    ipAddress: str(row, 'ip_address'),
    userAgent: str(row, 'user_agent'),
    clickX: numOrNull(row, 'click_x'),
    clickY: numOrNull(row, 'click_y'),
    resource: strOrNull(row, 'resource'),
    orderId: strOrNull(row, 'order_id'),
    rawPayload: strOrNull(row, 'raw_payload'),
    brokerStatus: numOrNull(row, 'broker_status'),
    brokerBody: strOrNull(row, 'broker_body'),
    spiffeId: str(row, 'spiffe_id'),
    correlationId: strOrNull(row, 'correlation_id'),
  };
}

export interface AuditEventQuery {
  userId?: string;
  eventType?: string;
  orderId?: string;
  correlationId?: string;
  since?: number;
  until?: number;
  limit?: number;
}

export function listAuditEvents(query: AuditEventQuery = {}): AuditEventRecord[] {
  const clauses = ['occurred_at >= ?', 'occurred_at <= ?'];
  const params: SqlValue[] = [query.since ?? 0, query.until ?? Number.MAX_SAFE_INTEGER];
  for (const [column, value] of [
    ['user_id', query.userId],
    ['event_type', query.eventType],
    ['order_id', query.orderId],
    ['correlation_id', query.correlationId],
  ] as const) {
    if (value !== undefined) {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }
  params.push(query.limit ?? 200);
  return stmt(
    `SELECT * FROM audit_events WHERE ${clauses.join(' AND ')}
       ORDER BY occurred_at DESC LIMIT ?`,
  )
    .all(...params)
    .map(auditFromRow);
}

export function countAuditEvents(): number {
  const row = stmt('SELECT COUNT(*) AS n FROM audit_events').get();
  return row === undefined ? 0 : num(row, 'n');
}

export interface RateLimitVerdict {
  allowed: boolean;
  hits: number;
  limit: number;
  remaining: number;
  windowStart: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  limit: number;
  now?: number;
}

/**
 * Fixed-window counter behind the 15c3-5 CONTROL 5 throttle (5 order messages
 * per second per user). The increment and the read happen in one transaction so
 * two simultaneous submissions cannot both see the pre-increment count.
 */
export function hitRateLimit(bucketKey: string, options: RateLimitOptions): RateLimitVerdict {
  const now = options.now ?? Date.now();
  const windowStart = Math.floor(now / options.windowMs) * options.windowMs;
  return tx(() => {
    stmt(
      `INSERT INTO rate_limits (bucket_key, window_start, hits, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT (bucket_key, window_start) DO UPDATE SET
         hits = rate_limits.hits + 1, updated_at = excluded.updated_at`,
    ).run(bucketKey, windowStart, now);
    const row = stmt(
      'SELECT hits FROM rate_limits WHERE bucket_key = ? AND window_start = ?',
    ).get(bucketKey, windowStart);
    const hits = row === undefined ? 1 : num(row, 'hits', 1);
    return {
      allowed: hits <= options.limit,
      hits,
      limit: options.limit,
      remaining: Math.max(0, options.limit - hits),
      windowStart,
      resetAt: windowStart + options.windowMs,
    };
  });
}
