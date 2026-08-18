/**
 * The complete DDL, as an ordered list of idempotent statements.
 *
 * Conventions that hold across every table, so nothing has to be remembered
 * per-column:
 *
 *   • timestamps are epoch **milliseconds** in INTEGER columns — the audit
 *     mandate (digest-compliance §"Timestamp precision requirement") requires
 *     millisecond precision for every routing event and consent record;
 *   • ledger **money is cents** in INTEGER columns (`*_cents`), so no float
 *     rounding can ever enter a payment, cash or P&L figure;
 *   • *quoted prices* (bar OHLC, bid/ask, limit prices, strikes) stay REAL.
 *     They are market observations feeding the deterministic feature pipeline,
 *     not ledger amounts; rounding them to cents would silently change model
 *     inputs and break the reproducibility guarantee in the build contract;
 *   • booleans are 0/1 INTEGER with a CHECK constraint — SQLite has no boolean;
 *   • structured payloads are JSON in TEXT columns, mirroring the JSONB columns
 *     the compliance mandate specifies for the Postgres deployment.
 *
 * Statement order matters: a table must exist before anything references it.
 */

import type { SqlDriver } from '@/lib/db/driver';
import { FEATURE_DEFINITIONS } from '@/lib/engine/features';

/**
 * Bumped whenever the statement list below changes shape. 3 adds the
 * append-only triggers on `audit_events`, `tos_acceptances`, `risk_decisions`,
 * `orders` and `order_telemetry`.
 */
export const SCHEMA_VERSION = 3;

/** Default SPIFFE identity for rows written outside an authenticated agent. */
const UNATTRIBUTED_SPIFFE = 'spiffe://aurelius/unattributed';

// ─────────────────────────────────────────────────────────────────────────────
//  1. The bitemporal ledger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * digest-compliance §"Bitemporal ledger table count" = 2 primary interconnected
 * structures: a baseline-state snapshot table and an append-only JSON Patch
 * delta table keyed to it. Two time axes are stored per row: `valid_from` is
 * when the fact became true in the world, `recorded_at` is when the platform
 * learned it. Only both together allow the mandated reconstruction of "the
 * exact UI and backend state at any given microsecond around an incident" as it
 * was *believed at the time*, which is what an arbitration defence needs.
 */
const LEDGER_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS entity_facet_snapshots (
    id             TEXT    PRIMARY KEY,
    entity_kind    TEXT    NOT NULL,
    entity_id      TEXT    NOT NULL,
    facet          TEXT    NOT NULL,
    state_json     TEXT    NOT NULL,
    valid_from     INTEGER NOT NULL,
    recorded_at    INTEGER NOT NULL,
    spiffe_id      TEXT    NOT NULL DEFAULT '${UNATTRIBUTED_SPIFFE}',
    correlation_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_efs_entity
     ON entity_facet_snapshots (entity_kind, entity_id, facet, valid_from DESC, recorded_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_efs_recorded ON entity_facet_snapshots (recorded_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_efs_correlation ON entity_facet_snapshots (correlation_id)`,

  `CREATE TABLE IF NOT EXISTS entity_facet_deltas (
    id             TEXT    PRIMARY KEY,
    snapshot_id    TEXT    NOT NULL REFERENCES entity_facet_snapshots (id),
    entity_kind    TEXT    NOT NULL,
    entity_id      TEXT    NOT NULL,
    facet          TEXT    NOT NULL,
    patch_json     TEXT    NOT NULL,
    valid_from     INTEGER NOT NULL,
    recorded_at    INTEGER NOT NULL,
    actor          TEXT    NOT NULL,
    spiffe_id      TEXT    NOT NULL DEFAULT '${UNATTRIBUTED_SPIFFE}',
    correlation_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_efd_entity
     ON entity_facet_deltas (entity_kind, entity_id, facet, valid_from, recorded_at)`,
  `CREATE INDEX IF NOT EXISTS idx_efd_snapshot ON entity_facet_deltas (snapshot_id, valid_from)`,
  `CREATE INDEX IF NOT EXISTS idx_efd_recorded ON entity_facet_deltas (recorded_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_efd_correlation ON entity_facet_deltas (correlation_id)`,
];

/**
 * digest-compliance §"AUDIT IMMUTABILITY": basic tables that permit UPDATE and
 * DELETE are "entirely insufficient for regulatory compliance — a plaintiff's
 * attorney will successfully argue such logs could have been easily altered".
 * The Postgres deployment revokes UPDATE/DELETE at the role level; SQLite has no
 * grants, so the equivalent enforcement is a pair of BEFORE triggers per table
 * that RAISE(ABORT). These are part of the schema, not a convention: a fresh
 * ledger is immutable from its first byte, and `assertAppendOnly()` proves it by
 * actually attempting both operations.
 *
 * This pair covers the two bitemporal facet tables only. The evidence tables the
 * disclosures make the same promise about — audit, consent, risk and order rows —
 * are guarded by `EVIDENCE_TRIGGERS` below, which has to be a separate list
 * because those tables are created further down the DDL.
 */
export const APPEND_ONLY_TRIGGERS: readonly string[] = [
  `CREATE TRIGGER IF NOT EXISTS trg_efs_no_update
     BEFORE UPDATE ON entity_facet_snapshots
   BEGIN
     SELECT RAISE(ABORT, 'entity_facet_snapshots is append-only: UPDATE is forbidden');
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_efs_no_delete
     BEFORE DELETE ON entity_facet_snapshots
   BEGIN
     SELECT RAISE(ABORT, 'entity_facet_snapshots is append-only: DELETE is forbidden');
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_efd_no_update
     BEFORE UPDATE ON entity_facet_deltas
   BEGIN
     SELECT RAISE(ABORT, 'entity_facet_deltas is append-only: UPDATE is forbidden');
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_efd_no_delete
     BEFORE DELETE ON entity_facet_deltas
   BEGIN
     SELECT RAISE(ABORT, 'entity_facet_deltas is append-only: DELETE is forbidden');
   END`,
];

export const APPEND_ONLY_TRIGGER_NAMES: readonly string[] = [
  'trg_efs_no_update',
  'trg_efs_no_delete',
  'trg_efd_no_update',
  'trg_efd_no_delete',
];

export const APPEND_ONLY_TABLES: readonly string[] = [
  'entity_facet_snapshots',
  'entity_facet_deltas',
];

/**
 * The same enforcement for the evidence tables outside the bitemporal ledger.
 *
 * The two facet tables above were the only rows anything actually protected, and
 * they are not the rows an opposing attorney asks about. `audit_events` holds the
 * six mandatory fields for every routed order, `order_telemetry` the
 * click→API→broker timeline, `tos_acceptances` the non-repudiation record of
 * consent, `risk_decisions` the proof that an order passed the engine — and the
 * terms of service and the privacy policy both tell the user, verbatim, that
 * order and audit records "cannot be modified or deleted, including on request,
 * because their evidentiary value depends on immutability".
 *
 * That was a convention, not a control. Against the shipped store a plain
 * `UPDATE audit_events SET ip_address = …` succeeded, as did `DELETE FROM
 * audit_events`, `UPDATE orders SET notional_cents = 1` and `DELETE FROM
 * tos_acceptances` — which is precisely the "could have been easily altered"
 * argument the mandate quoted above says the enforcement exists to defeat. None
 * of those rows are mirrored into the ledger either: only `broker/state.ts`
 * writes facet snapshots, so nothing else was standing behind the promise.
 *
 * Two of the five are frozen by column rather than outright, because they carry
 * live execution state as well as evidence:
 *
 *   • `orders` legitimately advances through its lifecycle — `updateOrderExecution`
 *     writes `updated_at`, `status`, the fill fields and the broker's reply. So the
 *     trigger freezes the columns that describe the *instruction*: who ordered what,
 *     at what size, on whose authorisation. A fill may be recorded; the order that
 *     was placed may not be rewritten.
 *   • `order_telemetry` is inserted at dispatch and amended once when the broker
 *     acknowledges — the `ON CONFLICT (order_id) DO UPDATE` in
 *     `insertOrderTelemetry`, which touches exactly `broker_acknowledged`,
 *     `broker_status` and `broker_body`. Everything else, including the click
 *     coordinates and the raw outbound payload, is frozen.
 *
 * `intent_tokens` deliberately gets no trigger: single-use is *implemented* by
 * writing `consumed_at` after minting, and expired unconsumed tokens are purged,
 * so freezing it would break the control it looks like it should protect.
 *
 * These are a second list rather than more entries in `APPEND_ONLY_TRIGGERS`
 * because a trigger cannot be created before its table: the ledger pair is
 * spliced in directly after `LEDGER_TABLES`, while these can only run once the
 * identity, execution and governance sections have been applied. See
 * `SCHEMA_STATEMENTS`, where they are last before the views.
 */
export const EVIDENCE_TRIGGERS: readonly string[] = [
  `CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
     BEFORE UPDATE ON audit_events
   BEGIN
     SELECT RAISE(ABORT, 'audit_events is append-only: UPDATE is forbidden');
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
     BEFORE DELETE ON audit_events
   BEGIN
     SELECT RAISE(ABORT, 'audit_events is append-only: DELETE is forbidden');
   END`,

  `CREATE TRIGGER IF NOT EXISTS trg_tos_no_update
     BEFORE UPDATE ON tos_acceptances
   BEGIN
     SELECT RAISE(ABORT, 'tos_acceptances is append-only: UPDATE is forbidden');
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_tos_no_delete
     BEFORE DELETE ON tos_acceptances
   BEGIN
     SELECT RAISE(ABORT, 'tos_acceptances is append-only: DELETE is forbidden');
   END`,

  `CREATE TRIGGER IF NOT EXISTS trg_risk_no_update
     BEFORE UPDATE ON risk_decisions
   BEGIN
     SELECT RAISE(ABORT, 'risk_decisions is append-only: UPDATE is forbidden');
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_risk_no_delete
     BEFORE DELETE ON risk_decisions
   BEGIN
     SELECT RAISE(ABORT, 'risk_decisions is append-only: DELETE is forbidden');
   END`,

  // Column-scoped: the fill and broker-reply columns advance, the instruction
  // does not. `BEFORE UPDATE OF …` fires for an ordinary UPDATE and for an
  // upsert's DO UPDATE alike, so there is no route around it.
  `CREATE TRIGGER IF NOT EXISTS trg_orders_no_rewrite
     BEFORE UPDATE OF id, user_id, symbol, side, type, quantity, limit_price, stop_price,
                      time_in_force, account, notional_cents, created_at, signal_id,
                      risk_decision_id, intent_token, broker_request_json, correlation_id
     ON orders
   BEGIN
     SELECT RAISE(ABORT, 'orders: the placed instruction is immutable; only execution state may be updated');
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_orders_no_delete
     BEFORE DELETE ON orders
   BEGIN
     SELECT RAISE(ABORT, 'orders is append-only: DELETE is forbidden');
   END`,

  `CREATE TRIGGER IF NOT EXISTS trg_telemetry_no_rewrite
     BEFORE UPDATE OF order_id, client_click, server_received, risk_completed,
                      broker_dispatched, spiffe_id, ip_address, user_agent, click_json,
                      raw_payload
     ON order_telemetry
   BEGIN
     SELECT RAISE(ABORT, 'order_telemetry: forensic fields are immutable; only the broker acknowledgement may be amended');
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_telemetry_no_delete
     BEFORE DELETE ON order_telemetry
   BEGIN
     SELECT RAISE(ABORT, 'order_telemetry is append-only: DELETE is forbidden');
   END`,
];

export const EVIDENCE_TRIGGER_NAMES: readonly string[] = [
  'trg_audit_no_update',
  'trg_audit_no_delete',
  'trg_tos_no_update',
  'trg_tos_no_delete',
  'trg_risk_no_update',
  'trg_risk_no_delete',
  'trg_orders_no_rewrite',
  'trg_orders_no_delete',
  'trg_telemetry_no_rewrite',
  'trg_telemetry_no_delete',
];

/**
 * The evidence tables and, for the two that are frozen by column, the columns
 * that may still be written. An empty `mutableColumns` means the whole row is
 * frozen against both UPDATE and DELETE.
 */
export const EVIDENCE_TABLES: readonly { table: string; mutableColumns: readonly string[] }[] = [
  { table: 'audit_events', mutableColumns: [] },
  { table: 'tos_acceptances', mutableColumns: [] },
  { table: 'risk_decisions', mutableColumns: [] },
  {
    table: 'orders',
    mutableColumns: [
      'updated_at',
      'status',
      'filled_quantity',
      'average_fill_price',
      'broker_status',
      'broker_response_json',
      'broker_order_id',
    ],
  },
  {
    table: 'order_telemetry',
    mutableColumns: ['broker_acknowledged', 'broker_status', 'broker_body'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  2. Identity, consent, billing
// ─────────────────────────────────────────────────────────────────────────────

const IDENTITY_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id                    TEXT    PRIMARY KEY,
    email                 TEXT    NOT NULL UNIQUE,
    display_name          TEXT    NOT NULL,
    role                  TEXT    NOT NULL DEFAULT 'trader',
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL,
    password_hash         TEXT,
    password_salt         TEXT,
    live_trading_unlocked INTEGER NOT NULL DEFAULT 0 CHECK (live_trading_unlocked IN (0, 1)),
    tos_accepted_at       INTEGER,
    tos_version           TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_users_role ON users (role)`,

  `CREATE TABLE IF NOT EXISTS sessions (
    token        TEXT    PRIMARY KEY,
    user_id      TEXT    NOT NULL REFERENCES users (id),
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked_at   INTEGER,
    ip_address   TEXT    NOT NULL DEFAULT '',
    user_agent   TEXT    NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, expires_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at)`,

  // digest-compliance §"CONSENT CAPTURE (non-repudiation)": email, IP, device
  // footprint and a millisecond timestamp, plus proof the clickwrap gate was
  // genuinely satisfied (scrolled to the absolute bottom before the box
  // unlocked) and the physical coordinates of the checkbox click.
  `CREATE TABLE IF NOT EXISTS tos_acceptances (
    id                 TEXT    PRIMARY KEY,
    user_id            TEXT    NOT NULL REFERENCES users (id),
    version            TEXT    NOT NULL,
    accepted_at        INTEGER NOT NULL,
    ip_address         TEXT    NOT NULL DEFAULT '',
    user_agent         TEXT    NOT NULL DEFAULT '',
    device_footprint   TEXT    NOT NULL DEFAULT '',
    scrolled_to_bottom INTEGER NOT NULL DEFAULT 0 CHECK (scrolled_to_bottom IN (0, 1)),
    scroll_duration_ms INTEGER NOT NULL DEFAULT 0,
    click_json         TEXT    NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tos_user ON tos_acceptances (user_id, accepted_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tos_version ON tos_acceptances (version, accepted_at DESC)`,

  `CREATE TABLE IF NOT EXISTS subscriptions (
    id                 TEXT    PRIMARY KEY,
    user_id            TEXT    NOT NULL UNIQUE REFERENCES users (id),
    status             TEXT    NOT NULL DEFAULT 'none',
    trial_ends_at      INTEGER,
    current_period_end INTEGER,
    price_cents        INTEGER NOT NULL DEFAULT 0,
    provider           TEXT,
    external_id        TEXT,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_status
     ON subscriptions (status, current_period_end)`,

  // digest-compliance §MUST IMPLEMENT: "Maintain a queryable immutable
  // subscription payment history so the trailing-three-month liability cap can
  // be computed for any claim date." Hence paid_at is indexed per user.
  `CREATE TABLE IF NOT EXISTS payments (
    id              TEXT    PRIMARY KEY,
    user_id         TEXT    NOT NULL REFERENCES users (id),
    subscription_id TEXT    REFERENCES subscriptions (id),
    amount_cents    INTEGER NOT NULL,
    currency        TEXT    NOT NULL DEFAULT 'USD',
    status          TEXT    NOT NULL,
    provider        TEXT    NOT NULL,
    external_id     TEXT,
    paid_at         INTEGER NOT NULL,
    period_start    INTEGER,
    period_end      INTEGER,
    raw_json        TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id, paid_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_paid_at ON payments (paid_at DESC)`,
];

// ─────────────────────────────────────────────────────────────────────────────
//  3. Market data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * digest-investgpt §"Time-partition granularity" = by month or year: recent-week
 * queries must route to the smallest, most recent partition. SQLite has no
 * declarative partitioning, so every time-series table carries a `month_bucket`
 * (YYYYMM) with a leading index. The predicate a caller writes is the same one
 * Postgres partition pruning would use, so the port is mechanical.
 *
 * These ingest tables deliberately omit a foreign key to `symbols`: the same
 * mandate calls for maximum insert throughput on the partitioned time series,
 * and the tradable universe is validated once at the ingest boundary rather
 * than per row.
 */
const MARKET_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS symbols (
    symbol              TEXT    PRIMARY KEY,
    name                TEXT    NOT NULL,
    sector              TEXT    NOT NULL,
    industry            TEXT    NOT NULL,
    market_cap_cents    INTEGER NOT NULL DEFAULT 0,
    adv30               INTEGER NOT NULL DEFAULT 0,
    shares_outstanding  INTEGER NOT NULL DEFAULT 0,
    exchange            TEXT    NOT NULL DEFAULT 'NASDAQ',
    is_benchmark        INTEGER NOT NULL DEFAULT 0 CHECK (is_benchmark IN (0, 1)),
    reference_beta      REAL    NOT NULL DEFAULT 1,
    dividend_yield      REAL    NOT NULL DEFAULT 0,
    optionable          INTEGER NOT NULL DEFAULT 0 CHECK (optionable IN (0, 1)),
    updated_at          INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_sector ON symbols (sector)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_market_cap ON symbols (market_cap_cents DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_adv ON symbols (adv30 DESC)`,

  `CREATE TABLE IF NOT EXISTS bars_daily (
    symbol       TEXT    NOT NULL,
    ts           INTEGER NOT NULL,
    month_bucket INTEGER NOT NULL DEFAULT 0,
    open         REAL    NOT NULL,
    high         REAL    NOT NULL,
    low          REAL    NOT NULL,
    close        REAL    NOT NULL,
    volume       INTEGER NOT NULL DEFAULT 0,
    vwap         REAL,
    trades       INTEGER,
    PRIMARY KEY (symbol, ts)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bars_daily_ts ON bars_daily (ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_bars_daily_bucket ON bars_daily (month_bucket DESC, symbol)`,

  `CREATE TABLE IF NOT EXISTS bars_intraday (
    symbol       TEXT    NOT NULL,
    timeframe    TEXT    NOT NULL,
    ts           INTEGER NOT NULL,
    month_bucket INTEGER NOT NULL DEFAULT 0,
    open         REAL    NOT NULL,
    high         REAL    NOT NULL,
    low          REAL    NOT NULL,
    close        REAL    NOT NULL,
    volume       INTEGER NOT NULL DEFAULT 0,
    vwap         REAL,
    trades       INTEGER,
    PRIMARY KEY (symbol, timeframe, ts)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bars_intraday_tf_ts ON bars_intraday (timeframe, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_bars_intraday_bucket
     ON bars_intraday (month_bucket DESC, symbol, timeframe)`,

  `CREATE TABLE IF NOT EXISTS quotes_snapshot (
    symbol         TEXT    NOT NULL,
    ts             INTEGER NOT NULL,
    bid            REAL    NOT NULL DEFAULT 0,
    ask            REAL    NOT NULL DEFAULT 0,
    bid_size       INTEGER NOT NULL DEFAULT 0,
    ask_size       INTEGER NOT NULL DEFAULT 0,
    last           REAL    NOT NULL DEFAULT 0,
    last_size      INTEGER NOT NULL DEFAULT 0,
    volume         INTEGER NOT NULL DEFAULT 0,
    previous_close REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (symbol, ts)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_quotes_ts ON quotes_snapshot (ts DESC)`,

  `CREATE TABLE IF NOT EXISTS option_quotes (
    symbol             TEXT    NOT NULL,
    expiry             INTEGER NOT NULL,
    strike             REAL    NOT NULL,
    type               TEXT    NOT NULL CHECK (type IN ('call', 'put')),
    ts                 INTEGER NOT NULL,
    dte                INTEGER NOT NULL DEFAULT 0,
    forward            REAL    NOT NULL DEFAULT 0,
    bid                REAL    NOT NULL DEFAULT 0,
    ask                REAL    NOT NULL DEFAULT 0,
    mid                REAL    NOT NULL DEFAULT 0,
    implied_volatility REAL    NOT NULL DEFAULT 0,
    delta              REAL    NOT NULL DEFAULT 0,
    gamma              REAL    NOT NULL DEFAULT 0,
    vega               REAL    NOT NULL DEFAULT 0,
    theta              REAL    NOT NULL DEFAULT 0,
    open_interest      INTEGER NOT NULL DEFAULT 0,
    volume             INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (symbol, expiry, strike, type, ts)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_option_quotes_symbol_ts ON option_quotes (symbol, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_option_quotes_expiry ON option_quotes (symbol, expiry, ts DESC)`,

  `CREATE TABLE IF NOT EXISTS book_snapshots (
    symbol    TEXT    NOT NULL,
    ts        INTEGER NOT NULL,
    sequence  INTEGER NOT NULL DEFAULT 0,
    levels    INTEGER NOT NULL DEFAULT 0,
    bids_json TEXT    NOT NULL DEFAULT '[]',
    asks_json TEXT    NOT NULL DEFAULT '[]',
    PRIMARY KEY (symbol, ts)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_book_snapshots_ts ON book_snapshots (ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_book_snapshots_sequence ON book_snapshots (symbol, sequence DESC)`,
];

// ─────────────────────────────────────────────────────────────────────────────
//  4. Alternative data and features
// ─────────────────────────────────────────────────────────────────────────────

/**
 * digest-investgpt §Part 2: >10,000 features per equity cannot live in a wide
 * table (Postgres caps at 1,600 columns), so features are stored in the long
 * hybrid-EAV form and pivoted into `v_equity_snapshot` for querying. That keeps
 * the write path narrow and the read path wide without duplicating storage.
 */
const FEATURE_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS alt_events (
    id           TEXT    PRIMARY KEY,
    symbol       TEXT    NOT NULL,
    stream       TEXT    NOT NULL,
    ts           INTEGER NOT NULL,
    value        REAL    NOT NULL DEFAULT 0,
    confidence   REAL    NOT NULL DEFAULT 0,
    headline     TEXT    NOT NULL DEFAULT '',
    source       TEXT    NOT NULL DEFAULT '',
    payload_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_alt_events_symbol_ts ON alt_events (symbol, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_alt_events_stream_ts ON alt_events (stream, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_alt_events_ts ON alt_events (ts DESC)`,

  `CREATE TABLE IF NOT EXISTS feature_values (
    symbol      TEXT    NOT NULL,
    as_of       INTEGER NOT NULL,
    feature_key TEXT    NOT NULL,
    value       REAL    NOT NULL DEFAULT 0,
    normalised  REAL    NOT NULL DEFAULT 0.5,
    state       TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (symbol, as_of, feature_key)
  )`,
  // The cross-sectional read path (screener, ECDF normalisation) scans one
  // feature across all symbols at one instant; the pivot view scans one symbol
  // at its latest instant. Both need their own leading column.
  `CREATE INDEX IF NOT EXISTS idx_feature_values_key ON feature_values (feature_key, as_of DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_feature_values_as_of ON feature_values (as_of DESC, symbol)`,

  `CREATE TABLE IF NOT EXISTS feature_catalog (
    key           TEXT    PRIMARY KEY,
    label         TEXT    NOT NULL,
    short_label   TEXT    NOT NULL DEFAULT '',
    feature_group TEXT    NOT NULL,
    unit          TEXT    NOT NULL,
    description   TEXT    NOT NULL DEFAULT '',
    formula       TEXT    NOT NULL DEFAULT '',
    sql_column    TEXT    NOT NULL,
    aliases_json  TEXT    NOT NULL DEFAULT '[]',
    in_model      INTEGER NOT NULL DEFAULT 0 CHECK (in_model IN (0, 1)),
    -- Not named "precision": PRECISION is a type-name keyword in PostgreSQL and
    -- would need quoting after the port.
    display_precision INTEGER NOT NULL DEFAULT 2
  )`,
  `CREATE INDEX IF NOT EXISTS idx_feature_catalog_group ON feature_catalog (feature_group)`,
  `CREATE INDEX IF NOT EXISTS idx_feature_catalog_in_model ON feature_catalog (in_model)`,
];

// ─────────────────────────────────────────────────────────────────────────────
//  5. Signals and the daily publication
// ─────────────────────────────────────────────────────────────────────────────

const SIGNAL_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS signals (
    id                     TEXT    PRIMARY KEY,
    symbol                 TEXT    NOT NULL,
    generated_at           INTEGER NOT NULL,
    direction              TEXT    NOT NULL,
    conviction             REAL    NOT NULL DEFAULT 0,
    probability            REAL    NOT NULL DEFAULT 0,
    horizon_days           INTEGER NOT NULL DEFAULT 0,
    expected_return        REAL    NOT NULL DEFAULT 0,
    expected_return_low    REAL    NOT NULL DEFAULT 0,
    expected_return_high   REAL    NOT NULL DEFAULT 0,
    reference_price        REAL    NOT NULL DEFAULT 0,
    entry_zone_low         REAL    NOT NULL DEFAULT 0,
    entry_zone_high        REAL    NOT NULL DEFAULT 0,
    invalidation           REAL    NOT NULL DEFAULT 0,
    target1                REAL    NOT NULL DEFAULT 0,
    target2                REAL    NOT NULL DEFAULT 0,
    strategy               TEXT,
    strategies_fired_json  TEXT    NOT NULL DEFAULT '[]',
    regime                 TEXT    NOT NULL DEFAULT 'low_volatility_drift',
    thesis                 TEXT    NOT NULL DEFAULT '',
    counter_thesis         TEXT    NOT NULL DEFAULT '',
    latency_json           TEXT    NOT NULL DEFAULT '{}',
    latency_total_ms       REAL    NOT NULL DEFAULT 0,
    attribution_residual   REAL    NOT NULL DEFAULT 0,
    model_version          TEXT    NOT NULL DEFAULT '',
    features_json          TEXT    NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals (symbol, generated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_signals_generated ON signals (generated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_signals_conviction ON signals (conviction DESC, generated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_signals_direction ON signals (direction, generated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS signal_drivers (
    signal_id     TEXT    NOT NULL REFERENCES signals (id) ON DELETE CASCADE,
    ordinal       INTEGER NOT NULL,
    feature_key   TEXT    NOT NULL,
    label         TEXT    NOT NULL DEFAULT '',
    feature_group TEXT    NOT NULL DEFAULT '',
    value         REAL    NOT NULL DEFAULT 0,
    shap          REAL    NOT NULL DEFAULT 0,
    share         REAL    NOT NULL DEFAULT 0,
    direction     TEXT    NOT NULL DEFAULT 'positive',
    state         TEXT    NOT NULL DEFAULT '',
    narrative     TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (signal_id, ordinal)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_signal_drivers_feature ON signal_drivers (feature_key)`,

  `CREATE TABLE IF NOT EXISTS signal_agents (
    signal_id             TEXT    NOT NULL REFERENCES signals (id) ON DELETE CASCADE,
    name                  TEXT    NOT NULL,
    architecture          TEXT    NOT NULL,
    timeframe_minutes     INTEGER NOT NULL DEFAULT 0,
    probability           REAL    NOT NULL DEFAULT 0,
    expected_return       REAL    NOT NULL DEFAULT 0,
    lower                 REAL,
    upper                 REAL,
    attention_json        TEXT,
    variable_weights_json TEXT,
    sequence_length       INTEGER NOT NULL DEFAULT 0,
    epoch                 INTEGER NOT NULL DEFAULT 0,
    published_sequence    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (signal_id, name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_signal_agents_arch ON signal_agents (architecture)`,

  // Lowe v. SEC (1985) criterion 1 — IMPERSONAL. This table has no user_id
  // column and never will: the published Top-5 is one row set per session date,
  // structurally identical for every subscriber. UNIQUE (session_date, rank)
  // makes a per-user variant impossible to represent, so the impersonal
  // distribution guarantee is enforced by the schema rather than by review.
  //
  // Nothing writes it, deliberately. `engine/service.ts` sets out why the Top 5
  // is derived on every call and never cached to disk — three revisions of a
  // cache key each survived a change the key did not name, and the front page
  // contradicted the symbol page it linked to by up to twenty-five conviction
  // points. The repository functions that used to fill this table were removed
  // with that decision; the DDL is kept so a store written by an older build
  // still migrates cleanly, and because the shape is the contract any future
  // publication archive would have to honour. It is empty by design, not by
  // accident.
  `CREATE TABLE IF NOT EXISTS publications (
    id             TEXT    PRIMARY KEY,
    session_date   TEXT    NOT NULL,
    published_at   INTEGER NOT NULL,
    rank           INTEGER NOT NULL,
    symbol         TEXT    NOT NULL,
    signal_id      TEXT,
    direction      TEXT    NOT NULL DEFAULT 'flat',
    conviction     REAL    NOT NULL DEFAULT 0,
    probability    REAL    NOT NULL DEFAULT 0,
    kelly_fraction REAL    NOT NULL DEFAULT 0,
    notice         TEXT    NOT NULL DEFAULT '',
    model_version  TEXT    NOT NULL DEFAULT '',
    checksum       TEXT    NOT NULL DEFAULT '',
    UNIQUE (session_date, rank),
    UNIQUE (session_date, symbol)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_publications_date ON publications (session_date DESC, rank ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_publications_published ON publications (published_at DESC)`,
];

// ─────────────────────────────────────────────────────────────────────────────
//  6. Orders, risk, intent and accounts
// ─────────────────────────────────────────────────────────────────────────────

const EXECUTION_TABLES: readonly string[] = [
  // Written before orders because an order links to the decision that cleared
  // it: digest-compliance requires 100% of order traffic to pass the risk
  // engine, so an order row without a risk_decision_id is evidence of a bug.
  `CREATE TABLE IF NOT EXISTS risk_decisions (
    id             TEXT    PRIMARY KEY,
    order_id       TEXT,
    user_id        TEXT    NOT NULL,
    symbol         TEXT    NOT NULL,
    approved       INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0, 1)),
    checks_json    TEXT    NOT NULL DEFAULT '[]',
    rejection_code TEXT,
    rejection_json TEXT,
    evaluated_at   INTEGER NOT NULL,
    elapsed_ms     REAL    NOT NULL DEFAULT 0,
    spiffe_id      TEXT    NOT NULL DEFAULT '${UNATTRIBUTED_SPIFFE}',
    correlation_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_risk_user ON risk_decisions (user_id, evaluated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_risk_order ON risk_decisions (order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_risk_rejection ON risk_decisions (rejection_code, evaluated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS orders (
    id                   TEXT    PRIMARY KEY,
    user_id              TEXT    NOT NULL REFERENCES users (id),
    symbol               TEXT    NOT NULL,
    side                 TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
    type                 TEXT    NOT NULL,
    quantity             INTEGER NOT NULL,
    limit_price          REAL,
    stop_price           REAL,
    time_in_force        TEXT    NOT NULL DEFAULT 'day',
    account              TEXT    NOT NULL CHECK (account IN ('paper', 'live')),
    status               TEXT    NOT NULL,
    filled_quantity      INTEGER NOT NULL DEFAULT 0,
    average_fill_price   REAL,
    notional_cents       INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL,
    signal_id            TEXT,
    risk_decision_id     TEXT    REFERENCES risk_decisions (id),
    intent_token         TEXT,
    broker_request_json  TEXT,
    broker_status        INTEGER,
    broker_response_json TEXT,
    broker_order_id      TEXT,
    correlation_id       TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_symbol ON orders (symbol, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_signal ON orders (signal_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC)`,
  // The 5-orders-per-second-per-user throttle and the duplicate-order check both
  // scan one user's very recent orders.
  `CREATE INDEX IF NOT EXISTS idx_orders_user_window ON orders (user_id, symbol, created_at DESC)`,

  // digest-compliance §"Required audit log field count" = 6 mandatory fields.
  // Telemetry stores the per-order copy: the millisecond click→API→broker
  // timeline, IP + User-Agent, X/Y click coordinates, the raw outbound JSON
  // exactly as sent, and the broker's HTTP status plus body.
  `CREATE TABLE IF NOT EXISTS order_telemetry (
    order_id            TEXT    PRIMARY KEY REFERENCES orders (id),
    client_click        INTEGER NOT NULL,
    server_received     INTEGER NOT NULL,
    risk_completed      INTEGER NOT NULL,
    broker_dispatched   INTEGER NOT NULL,
    broker_acknowledged INTEGER,
    spiffe_id           TEXT    NOT NULL DEFAULT '${UNATTRIBUTED_SPIFFE}',
    ip_address          TEXT    NOT NULL DEFAULT '',
    user_agent          TEXT    NOT NULL DEFAULT '',
    click_json          TEXT    NOT NULL DEFAULT '{}',
    raw_payload         TEXT    NOT NULL DEFAULT '',
    broker_status       INTEGER,
    broker_body         TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_order_telemetry_click ON order_telemetry (client_click DESC)`,

  // digest-compliance HARD RULE: every routing call must carry "a unique,
  // time-stamped cryptographic token generated at the exact millisecond the
  // user clicks Execute", single-use and single-security. `symbol` on the token
  // is what makes it single-security; `consumed_at` is what makes it single-use.
  `CREATE TABLE IF NOT EXISTS intent_tokens (
    token          TEXT    PRIMARY KEY,
    user_id        TEXT    NOT NULL,
    symbol         TEXT    NOT NULL,
    session_token  TEXT,
    minted_at      INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    consumed_at    INTEGER,
    order_id       TEXT,
    click_json     TEXT    NOT NULL DEFAULT '{}',
    correlation_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_intent_user ON intent_tokens (user_id, minted_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_intent_expiry ON intent_tokens (expires_at)`,

  `CREATE TABLE IF NOT EXISTS positions (
    user_id                 TEXT    NOT NULL,
    account                 TEXT    NOT NULL CHECK (account IN ('paper', 'live')),
    symbol                  TEXT    NOT NULL,
    quantity                INTEGER NOT NULL DEFAULT 0,
    average_entry           REAL    NOT NULL DEFAULT 0,
    market_price            REAL    NOT NULL DEFAULT 0,
    market_value_cents      INTEGER NOT NULL DEFAULT 0,
    unrealised_pnl_cents    INTEGER NOT NULL DEFAULT 0,
    unrealised_pnl_percent  REAL    NOT NULL DEFAULT 0,
    realised_pnl_cents      INTEGER NOT NULL DEFAULT 0,
    opened_at               INTEGER NOT NULL,
    updated_at              INTEGER NOT NULL,
    PRIMARY KEY (user_id, account, symbol)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions (symbol)`,

  `CREATE TABLE IF NOT EXISTS accounts (
    user_id                  TEXT    NOT NULL,
    account                  TEXT    NOT NULL CHECK (account IN ('paper', 'live')),
    cash_cents               INTEGER NOT NULL DEFAULT 0,
    equity_cents             INTEGER NOT NULL DEFAULT 0,
    buying_power_cents       INTEGER NOT NULL DEFAULT 0,
    gross_exposure_cents     INTEGER NOT NULL DEFAULT 0,
    net_exposure_cents       INTEGER NOT NULL DEFAULT 0,
    maintenance_margin_cents INTEGER NOT NULL DEFAULT 0,
    day_pnl_cents            INTEGER NOT NULL DEFAULT 0,
    total_pnl_cents          INTEGER NOT NULL DEFAULT 0,
    updated_at               INTEGER NOT NULL,
    PRIMARY KEY (user_id, account)
  )`,
];

// ─────────────────────────────────────────────────────────────────────────────
//  7. Watchlists and backtests
// ─────────────────────────────────────────────────────────────────────────────

const WORKSPACE_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS watchlists (
    id         TEXT    PRIMARY KEY,
    user_id    TEXT    NOT NULL REFERENCES users (id),
    name       TEXT    NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists (user_id, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS watchlist_items (
    watchlist_id TEXT    NOT NULL REFERENCES watchlists (id) ON DELETE CASCADE,
    symbol       TEXT    NOT NULL,
    ordinal      INTEGER NOT NULL DEFAULT 0,
    added_at     INTEGER NOT NULL,
    note         TEXT,
    PRIMARY KEY (watchlist_id, symbol)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_watchlist_items_symbol ON watchlist_items (symbol)`,
  `CREATE INDEX IF NOT EXISTS idx_watchlist_items_order ON watchlist_items (watchlist_id, ordinal)`,

  // digest-compliance §GOVERNANCE OBLIGATION: backtesting logs and model
  // validation reports are the anti-AI-washing evidence set, so results are
  // retained in full rather than recomputed on demand.
  `CREATE TABLE IF NOT EXISTS backtests (
    id                   TEXT    PRIMARY KEY,
    user_id              TEXT,
    created_at           INTEGER NOT NULL,
    status               TEXT    NOT NULL DEFAULT 'complete',
    elapsed_ms           INTEGER NOT NULL DEFAULT 0,
    config_json          TEXT    NOT NULL DEFAULT '{}',
    metrics_json         TEXT    NOT NULL DEFAULT '{}',
    equity_curve_json    TEXT    NOT NULL DEFAULT '[]',
    by_strategy_json     TEXT    NOT NULL DEFAULT '[]',
    monthly_returns_json TEXT    NOT NULL DEFAULT '[]',
    folds_json           TEXT    NOT NULL DEFAULT '[]',
    warnings_json        TEXT    NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_backtests_user ON backtests (user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_backtests_created ON backtests (created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS backtest_trades (
    backtest_id              TEXT    NOT NULL REFERENCES backtests (id) ON DELETE CASCADE,
    ordinal                  INTEGER NOT NULL,
    symbol                   TEXT    NOT NULL,
    strategy                 TEXT    NOT NULL DEFAULT '',
    direction                TEXT    NOT NULL DEFAULT 'long',
    entry_time               INTEGER NOT NULL,
    entry_price              REAL    NOT NULL DEFAULT 0,
    exit_time                INTEGER NOT NULL,
    exit_price               REAL    NOT NULL DEFAULT 0,
    quantity                 INTEGER NOT NULL DEFAULT 0,
    gross_pnl_cents          INTEGER NOT NULL DEFAULT 0,
    commission_cents         INTEGER NOT NULL DEFAULT 0,
    slippage_cents           INTEGER NOT NULL DEFAULT 0,
    net_pnl_cents            INTEGER NOT NULL DEFAULT 0,
    return_percent           REAL    NOT NULL DEFAULT 0,
    bars_held                INTEGER NOT NULL DEFAULT 0,
    exit_reason              TEXT    NOT NULL DEFAULT 'end_of_data',
    conviction_at_entry      REAL    NOT NULL DEFAULT 0,
    max_favourable_excursion REAL    NOT NULL DEFAULT 0,
    max_adverse_excursion    REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (backtest_id, ordinal)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_backtest_trades_symbol ON backtest_trades (backtest_id, symbol)`,
  `CREATE INDEX IF NOT EXISTS idx_backtest_trades_strategy ON backtest_trades (backtest_id, strategy)`,
];

// ─────────────────────────────────────────────────────────────────────────────
//  8. RAG corpus
// ─────────────────────────────────────────────────────────────────────────────

const RAG_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS rag_documents (
    id          TEXT    PRIMARY KEY,
    title       TEXT    NOT NULL,
    source_type TEXT    NOT NULL,
    symbol      TEXT,
    section     TEXT    NOT NULL DEFAULT '',
    authority   REAL    NOT NULL DEFAULT 0.5,
    published_at INTEGER NOT NULL,
    url         TEXT,
    body        TEXT    NOT NULL DEFAULT '',
    checksum    TEXT    NOT NULL DEFAULT '',
    ingested_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rag_documents_symbol ON rag_documents (symbol, published_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_rag_documents_source
     ON rag_documents (source_type, published_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_rag_documents_authority ON rag_documents (authority DESC)`,

  // The embedding is a BLOB of little-endian float32s rather than JSON: it is
  // read on every retrieval and never inspected by a human. digest-investgpt
  // prescribes pgvector + HNSW on Postgres; the embedded deployment scans the
  // corpus in process, which is why `embedding_dim` is stored alongside.
  `CREATE TABLE IF NOT EXISTS rag_chunks (
    id            TEXT    PRIMARY KEY,
    document_id   TEXT    NOT NULL REFERENCES rag_documents (id) ON DELETE CASCADE,
    ordinal       INTEGER NOT NULL,
    section       TEXT    NOT NULL DEFAULT '',
    text          TEXT    NOT NULL DEFAULT '',
    token_count   INTEGER NOT NULL DEFAULT 0,
    embedding     BLOB,
    embedding_dim INTEGER,
    UNIQUE (document_id, ordinal)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rag_chunks_document ON rag_chunks (document_id, ordinal)`,
];

// ─────────────────────────────────────────────────────────────────────────────
//  9. Governance, audit, throttling, models
// ─────────────────────────────────────────────────────────────────────────────

const GOVERNANCE_TABLES: readonly string[] = [
  // The kill switch is stored as an append-only event log, not a mutable flag:
  // "no code deploy and no reboot" (15c3-5 CONTROL 6) means engagements happen
  // under incident conditions, exactly when the sequence of who engaged what
  // and when becomes evidence. Current state is the most recent row.
  `CREATE TABLE IF NOT EXISTS kill_switch (
    id               TEXT    PRIMARY KEY,
    engaged          INTEGER NOT NULL DEFAULT 0 CHECK (engaged IN (0, 1)),
    engaged_at       INTEGER,
    engaged_by       TEXT,
    reason           TEXT,
    cancelled_orders INTEGER NOT NULL DEFAULT 0,
    recorded_at      INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kill_switch_recorded ON kill_switch (recorded_at DESC)`,

  `CREATE TABLE IF NOT EXISTS admin_actions (
    id             TEXT    PRIMARY KEY,
    admin_user_id  TEXT    NOT NULL,
    action         TEXT    NOT NULL,
    target         TEXT,
    detail_json    TEXT,
    ip_address     TEXT    NOT NULL DEFAULT '',
    user_agent     TEXT    NOT NULL DEFAULT '',
    spiffe_id      TEXT    NOT NULL DEFAULT '${UNATTRIBUTED_SPIFFE}',
    correlation_id TEXT,
    created_at     INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_admin_actions_admin
     ON admin_actions (admin_user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_admin_actions_action ON admin_actions (action, created_at DESC)`,

  // The six mandatory fields, one row per interaction: (1) user id + session
  // token, (2) millisecond timestamp, (3) IP + User-Agent, (4) X/Y click
  // coordinates, (5) the raw outbound JSON payload, (6) broker HTTP status +
  // body. `spiffe_id` and `correlation_id` add the zero-trust hop tracing the
  // same mandate requires across microservices.
  `CREATE TABLE IF NOT EXISTS audit_events (
    id             TEXT    PRIMARY KEY,
    occurred_at    INTEGER NOT NULL,
    event_type     TEXT    NOT NULL,
    user_id        TEXT,
    session_token  TEXT,
    ip_address     TEXT    NOT NULL DEFAULT '',
    user_agent     TEXT    NOT NULL DEFAULT '',
    click_x        INTEGER,
    click_y        INTEGER,
    resource       TEXT,
    order_id       TEXT,
    raw_payload    TEXT,
    broker_status  INTEGER,
    broker_body    TEXT,
    spiffe_id      TEXT    NOT NULL DEFAULT '${UNATTRIBUTED_SPIFFE}',
    correlation_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_events (occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_events (user_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events (event_type, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_order ON audit_events (order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_events (correlation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events (session_token, occurred_at DESC)`,

  // 15c3-5 CONTROL 5: 5 order messages per second per unique user ID. Counters
  // are bucketed by window start so the check is a single primary-key lookup.
  `CREATE TABLE IF NOT EXISTS rate_limits (
    bucket_key   TEXT    NOT NULL,
    window_start INTEGER NOT NULL,
    hits         INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (bucket_key, window_start)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start)`,

  /*
   * Accepted idempotency keys, so DUPLICATE_ORDER is a control rather than a
   * label.
   *
   * The pre-flight panel prints "IDEMPOTENCY — No prior submission with this
   * key", and it printed that for a key that had already routed: no port was
   * wired, so the engine's check had nothing to consult and always passed. The
   * duplicate was caught one layer further out by the paper broker's own
   * client-order-id collision, as a 502 BROKER_ERROR — the right outcome by
   * accident, from the wrong component, with the audit ledger recording that the
   * platform's own control had found nothing.
   *
   * A separate table rather than a column on `orders`: `migrate()` replays
   * `CREATE TABLE IF NOT EXISTS`, which adds a new table to an existing database
   * and cannot add a column to one.
   */
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    key         TEXT    PRIMARY KEY,
    user_id     TEXT    NOT NULL,
    accepted_at INTEGER NOT NULL,
    order_id    TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_idempotency_user ON idempotency_keys (user_id, accepted_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_idempotency_accepted ON idempotency_keys (accepted_at DESC)`,

  `CREATE TABLE IF NOT EXISTS models (
    id                TEXT    PRIMARY KEY,
    version           TEXT    NOT NULL UNIQUE,
    kind              TEXT    NOT NULL,
    created_at        INTEGER NOT NULL,
    trained_at        INTEGER,
    seed              INTEGER NOT NULL DEFAULT 0,
    feature_keys_json TEXT    NOT NULL DEFAULT '[]',
    hyperparams_json  TEXT,
    metrics_json      TEXT,
    artifact_json     TEXT,
    base_value        REAL,
    active            INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_models_active ON models (active, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_models_kind ON models (kind, created_at DESC)`,

  // Trained agent tensors, stored as float32 BLOBs keyed by model + agent +
  // layer so the three temporal agents can be rehydrated without retraining.
  `CREATE TABLE IF NOT EXISTS nn_weights (
    id           TEXT    PRIMARY KEY,
    model_id     TEXT    NOT NULL REFERENCES models (id) ON DELETE CASCADE,
    agent_name   TEXT    NOT NULL,
    architecture TEXT    NOT NULL DEFAULT '',
    layer        TEXT    NOT NULL,
    shape_json   TEXT    NOT NULL DEFAULT '[]',
    weights      BLOB    NOT NULL,
    checksum     TEXT    NOT NULL DEFAULT '',
    seed         INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    UNIQUE (model_id, agent_name, layer)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_nn_weights_agent ON nn_weights (model_id, agent_name)`,
];

// ─────────────────────────────────────────────────────────────────────────────
//  10. Views
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Descriptive (non-feature) columns of `v_equity_snapshot`, in view order. They
 * are what the deterministic NL→SQL compiler filters and labels on; the feature
 * columns that follow are generated from the registry.
 */
export const EQUITY_SNAPSHOT_DIMENSIONS: readonly string[] = [
  'symbol',
  'name',
  'sector',
  'industry',
  'exchange',
  'market_cap',
  'adv30',
  'shares_outstanding',
  'reference_beta',
  'dividend_yield',
  'optionable',
  'is_benchmark',
  'as_of',
  'price',
  'previous_close',
  'change_percent',
  'session_volume',
  'bid',
  'ask',
  'signal_id',
  'direction',
  'conviction',
  'probability',
  'expected_return',
  'horizon_days',
  'regime',
  'model_version',
];

/** Columns of `v_signal_latest`, in view order. */
const SIGNAL_LATEST_COLUMNS: readonly string[] = [
  'id',
  'symbol',
  'generated_at',
  'direction',
  'conviction',
  'probability',
  'horizon_days',
  'expected_return',
  'expected_return_low',
  'expected_return_high',
  'reference_price',
  'entry_zone_low',
  'entry_zone_high',
  'invalidation',
  'target1',
  'target2',
  'strategy',
  'strategies_fired_json',
  'regime',
  'thesis',
  'counter_thesis',
  'latency_total_ms',
  'attribution_residual',
  'model_version',
];

/**
 * One row per symbol: the newest signal, chosen deterministically. `MAX()` alone
 * would produce duplicates if two signals shared a generated_at for a symbol,
 * so the id tiebreak is part of the selection.
 */
function signalLatestView(): string {
  const projection = SIGNAL_LATEST_COLUMNS.map((column) => `  s.${column}`).join(',\n');
  return `CREATE VIEW v_signal_latest AS
SELECT
${projection}
FROM signals s
WHERE s.id = (
  SELECT s2.id
  FROM signals s2
  WHERE s2.symbol = s.symbol
  ORDER BY s2.generated_at DESC, s2.id DESC
  LIMIT 1
)`;
}

/**
 * InvestGPT's query target (digest-investgpt §Part 1–2): the long-form
 * `feature_values` rows pivoted into one wide row per symbol at its latest
 * `as_of`, joined to the symbol dimension, the latest quote and the latest
 * signal. Every feature column is named from `FeatureDefinition.sqlColumn`, and
 * the SQL is generated from `FEATURE_DEFINITIONS` rather than hand-written, so
 * the catalog the retriever prunes over and the view it emits SQL against can
 * never drift apart.
 *
 * The pivot lives in a derived table grouped only by (symbol, as_of), and the
 * dimension columns are joined outside it. That avoids SQLite's tolerance of
 * bare columns in an aggregate query, keeping the statement valid standard SQL
 * for the Neon/Postgres port.
 */
function equitySnapshotView(): string {
  const pivot = FEATURE_DEFINITIONS.map(
    (definition) =>
      `    MAX(CASE WHEN fv.feature_key = '${definition.key}' THEN fv.value END) AS ${definition.sqlColumn}`,
  ).join(',\n');
  const projection = FEATURE_DEFINITIONS.map(
    (definition) => `  f.${definition.sqlColumn} AS ${definition.sqlColumn}`,
  ).join(',\n');

  return `CREATE VIEW v_equity_snapshot AS
SELECT
  s.symbol AS symbol,
  s.name AS name,
  s.sector AS sector,
  s.industry AS industry,
  s.exchange AS exchange,
  s.market_cap_cents / 100.0 AS market_cap,
  s.adv30 AS adv30,
  s.shares_outstanding AS shares_outstanding,
  s.reference_beta AS reference_beta,
  s.dividend_yield AS dividend_yield,
  s.optionable AS optionable,
  s.is_benchmark AS is_benchmark,
  f.as_of AS as_of,
  q.last AS price,
  q.previous_close AS previous_close,
  CASE
    WHEN q.previous_close > 0 THEN 100.0 * (q.last - q.previous_close) / q.previous_close
    ELSE NULL
  END AS change_percent,
  q.volume AS session_volume,
  q.bid AS bid,
  q.ask AS ask,
  sig.id AS signal_id,
  sig.direction AS direction,
  sig.conviction AS conviction,
  sig.probability AS probability,
  sig.expected_return AS expected_return,
  sig.horizon_days AS horizon_days,
  sig.regime AS regime,
  sig.model_version AS model_version,
${projection}
FROM symbols s
JOIN (
  SELECT
    fv.symbol AS symbol,
    fv.as_of AS as_of,
${pivot}
  FROM feature_values fv
  JOIN (
    SELECT symbol, MAX(as_of) AS as_of FROM feature_values GROUP BY symbol
  ) latest ON latest.symbol = fv.symbol AND latest.as_of = fv.as_of
  GROUP BY fv.symbol, fv.as_of
) f ON f.symbol = s.symbol
LEFT JOIN v_signal_latest sig ON sig.symbol = s.symbol
LEFT JOIN quotes_snapshot q
  ON q.symbol = s.symbol
  AND q.ts = (SELECT MAX(q2.ts) FROM quotes_snapshot q2 WHERE q2.symbol = s.symbol)`;
}

/**
 * Views are dropped and recreated on every migration rather than guarded with
 * IF NOT EXISTS: their bodies are derived from the feature registry, so adding a
 * feature must change the view, and a stale definition would silently hide the
 * new column from InvestGPT. `v_equity_snapshot` reads `v_signal_latest`, so
 * order matters in both directions.
 */
const VIEW_STATEMENTS: readonly string[] = [
  'DROP VIEW IF EXISTS v_equity_snapshot',
  'DROP VIEW IF EXISTS v_signal_latest',
  signalLatestView(),
  equitySnapshotView(),
];

// ─────────────────────────────────────────────────────────────────────────────
//  Assembly
// ─────────────────────────────────────────────────────────────────────────────

/** The full DDL, in dependency order. Every statement is idempotent. */
export const SCHEMA_STATEMENTS: readonly string[] = [
  ...LEDGER_TABLES,
  ...APPEND_ONLY_TRIGGERS,
  ...IDENTITY_TABLES,
  ...MARKET_TABLES,
  ...FEATURE_TABLES,
  ...SIGNAL_TABLES,
  ...EXECUTION_TABLES,
  ...WORKSPACE_TABLES,
  ...RAG_TABLES,
  ...GOVERNANCE_TABLES,
  // Last, because every table they guard has to exist first.
  ...EVIDENCE_TRIGGERS,
  ...VIEW_STATEMENTS,
];

/** Every table, in creation order (children after parents). */
export const TABLE_NAMES: readonly string[] = [
  'entity_facet_snapshots',
  'entity_facet_deltas',
  'users',
  'sessions',
  'tos_acceptances',
  'subscriptions',
  'payments',
  'symbols',
  'bars_daily',
  'bars_intraday',
  'quotes_snapshot',
  'option_quotes',
  'book_snapshots',
  'alt_events',
  'feature_values',
  'feature_catalog',
  'signals',
  'signal_drivers',
  'signal_agents',
  'publications',
  'risk_decisions',
  'orders',
  'order_telemetry',
  'intent_tokens',
  'positions',
  'accounts',
  'watchlists',
  'watchlist_items',
  'backtests',
  'backtest_trades',
  'rag_documents',
  'rag_chunks',
  'kill_switch',
  'admin_actions',
  'audit_events',
  'rate_limits',
  'idempotency_keys',
  'models',
  'nn_weights',
];

export const VIEW_NAMES: readonly string[] = ['v_signal_latest', 'v_equity_snapshot'];

/**
 * The relations a generated SELECT may touch.
 *
 * digest-investgpt §"Layer 3: Recursive Allowlisting and Schema Mapping"
 * requires every table reference extracted from a validated AST to be matched
 * against a hardcoded allowlist, and the RBAC section requires the two data
 * domains to be separated — `schema_market_data` (public equities) from
 * `schema_tenant_private` (user portfolios). SQLite has one namespace, so the
 * separation is expressed here: impersonal market, feature, signal and
 * publication relations only. Nothing user-scoped, nothing holding credentials
 * or ledger evidence, is reachable from a natural-language query.
 */
export const READ_ALLOWLIST: readonly string[] = [
  'symbols',
  'bars_daily',
  'bars_intraday',
  'quotes_snapshot',
  'option_quotes',
  'book_snapshots',
  'alt_events',
  'feature_values',
  'feature_catalog',
  'signals',
  'signal_drivers',
  'signal_agents',
  'publications',
  'rag_documents',
  'v_signal_latest',
  'v_equity_snapshot',
];

/** Full column list of `v_equity_snapshot`, dimensions then features. */
export const EQUITY_SNAPSHOT_COLUMNS: readonly string[] = [
  ...EQUITY_SNAPSHOT_DIMENSIONS,
  ...FEATURE_DEFINITIONS.map((definition) => definition.sqlColumn),
];

export interface MigrationReport {
  mode: SqlDriver['mode'];
  location: string;
  statements: number;
  tables: number;
  views: number;
  schemaVersion: number;
  elapsedMs: number;
}

/**
 * Applies the DDL. Safe to call repeatedly: the statements are idempotent, and
 * the whole set runs in one transaction so a partially-created schema can never
 * be observed.
 */
export function migrate(db: SqlDriver): MigrationReport {
  const started = Date.now();
  db.transaction(() => {
    for (const statement of SCHEMA_STATEMENTS) {
      db.exec(statement);
    }
  });
  if (db.mode === 'embedded') {
    // PRAGMA cannot be parameterised, and SCHEMA_VERSION is a module constant.
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  return {
    mode: db.mode,
    location: db.location,
    statements: SCHEMA_STATEMENTS.length,
    tables: TABLE_NAMES.length,
    views: VIEW_NAMES.length,
    schemaVersion: SCHEMA_VERSION,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Drops every object this schema owns, in reverse dependency order. Used by
 * `resetDb()` for drivers where deleting a file is not an option. Both trigger
 * families fire on row DELETE, not on DROP TABLE, so the ledger and evidence
 * tables come down cleanly — and only ever through this deliberate path.
 */
export function dropAllObjects(db: SqlDriver): void {
  for (const view of [...VIEW_NAMES].reverse()) {
    db.exec(`DROP VIEW IF EXISTS ${view}`);
  }
  for (const trigger of [...APPEND_ONLY_TRIGGER_NAMES, ...EVIDENCE_TRIGGER_NAMES]) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  for (const table of [...TABLE_NAMES].reverse()) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

/** YYYYMM partition bucket for the time-series tables. */
export function monthBucket(epochMs: number): number {
  const date = new Date(epochMs);
  return date.getUTCFullYear() * 100 + (date.getUTCMonth() + 1);
}
