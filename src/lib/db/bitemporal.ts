/**
 * The append-only bitemporal ledger API.
 *
 * digest-compliance §MUST IMPLEMENT: "Create the append-only bitemporal ledger:
 * table entity_facet_snapshots holding complete baseline state … and table
 * entity_facet_deltas holding append-only JSON Patch operations with a
 * snapshot_id foreign key and a precise timestamp; revoke UPDATE and DELETE on
 * both", plus "Implement temporal reconstruction queries able to rebuild exact
 * UI and backend state at any given microsecond around an incident by replaying
 * deltas onto the nearest prior snapshot."
 *
 * Two independent time axes are stored on every row and both are honoured on
 * read:
 *
 *   • `validFrom`  — when the fact became true in the world;
 *   • `recordedAt` — when the platform learned it.
 *
 * `reconstruct({ asOf, recordedAsOf })` therefore answers the question an
 * arbitration panel actually asks: *what did the system believe, at the moment
 * it acted, about the state of the world?* A ledger with only one axis cannot
 * distinguish a genuine state change from a late-arriving correction, and a
 * plaintiff would be free to characterise the difference however they liked.
 *
 * RFC 6902 patches are computed and applied in this module rather than by a
 * dependency: the build contract forbids adding one, and the operation set the
 * mandate needs (add / remove / replace) is small enough to implement exactly.
 */

import { randomUUID } from 'node:crypto';

import { getDb } from '@/lib/db/client';
import type { SqlDriver, SqlRow } from '@/lib/db/driver';
import { num, parseJson, str, strOrNull } from '@/lib/db/row';
import { APPEND_ONLY_TRIGGERS, APPEND_ONLY_TRIGGER_NAMES, EVIDENCE_TRIGGER_NAMES } from '@/lib/db/schema';

// ─────────────────────────────────────────────────────────────────────────────
//  JSON value model and RFC 6902 patches
// ─────────────────────────────────────────────────────────────────────────────

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type JsonPatchOperation = 'add' | 'remove' | 'replace';

export interface JsonPatchOp {
  op: JsonPatchOperation;
  /** RFC 6901 JSON Pointer. `''` addresses the whole document. */
  path: string;
  /** Absent for `remove`. */
  value?: JsonValue;
}

/** Raised when the ledger or a patch is internally inconsistent. */
export class BitemporalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BitemporalError';
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** RFC 6901 §3: `~` becomes `~0` and `/` becomes `~1`, in that order. */
function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new BitemporalError(`invalid JSON Pointer "${pointer}": must be empty or start with "/"`);
  }
  return pointer.slice(1).split('/').map(unescapeToken);
}

function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]),
    );
  }
  return false;
}

function deepClone(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isJsonObject(value)) {
    const copy: JsonObject = {};
    for (const key of Object.keys(value)) copy[key] = deepClone(value[key]);
    return copy;
  }
  return value;
}

/**
 * The minimal add/remove/replace patch turning `before` into `after`.
 *
 * Objects are diffed key by key so a delta records only the field that actually
 * changed — the mandate's "Write a delta row for every user parameter change …
 * recording only the exact change". Arrays are diffed positionally over the
 * common prefix; trailing removals are emitted highest-index-first so each op
 * stays valid against the document produced by the previous one.
 */
export function diffToJsonPatch(before: JsonValue, after: JsonValue): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  collectDiff(before, after, '', ops);
  return ops;
}

function collectDiff(before: JsonValue, after: JsonValue, path: string, ops: JsonPatchOp[]): void {
  if (deepEqual(before, after)) return;

  if (isJsonObject(before) && isJsonObject(after)) {
    for (const key of Object.keys(before)) {
      if (!Object.prototype.hasOwnProperty.call(after, key)) {
        ops.push({ op: 'remove', path: `${path}/${escapeToken(key)}` });
      }
    }
    for (const key of Object.keys(after)) {
      const child = `${path}/${escapeToken(key)}`;
      if (!Object.prototype.hasOwnProperty.call(before, key)) {
        ops.push({ op: 'add', path: child, value: deepClone(after[key]) });
      } else {
        collectDiff(before[key], after[key], child, ops);
      }
    }
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const shared = Math.min(before.length, after.length);
    for (let index = 0; index < shared; index += 1) {
      collectDiff(before[index], after[index], `${path}/${index}`, ops);
    }
    // Descending so earlier removals never shift the index of a later one.
    for (let index = before.length - 1; index >= after.length; index -= 1) {
      ops.push({ op: 'remove', path: `${path}/${index}` });
    }
    for (let index = before.length; index < after.length; index += 1) {
      ops.push({ op: 'add', path: `${path}/-`, value: deepClone(after[index]) });
    }
    return;
  }

  // Type change, primitive change, or the whole document: one replace. RFC 6902
  // §4.3 permits an empty path, which addresses the root.
  ops.push({ op: 'replace', path, value: deepClone(after) });
}

/**
 * Applies a patch, returning a new document. Throws rather than skipping a bad
 * op: a delta that cannot be replayed means the evidentiary chain is broken, and
 * silently returning an approximate state would be worse than failing loudly.
 */
export function applyJsonPatch(state: JsonValue, patch: readonly JsonPatchOp[]): JsonValue {
  let document = deepClone(state);
  for (const op of patch) {
    document = applyOne(document, op);
  }
  return document;
}

function applyOne(document: JsonValue, op: JsonPatchOp): JsonValue {
  const tokens = parsePointer(op.path);

  if (tokens.length === 0) {
    if (op.op === 'remove') {
      throw new BitemporalError('cannot remove the root of a document');
    }
    if (op.value === undefined) {
      throw new BitemporalError(`"${op.op}" at the document root requires a value`);
    }
    return deepClone(op.value);
  }

  const parentTokens = tokens.slice(0, -1);
  const leaf = tokens[tokens.length - 1];
  const parent = resolve(document, parentTokens, op.path);

  if (Array.isArray(parent)) {
    applyToArray(parent, leaf, op);
    return document;
  }
  if (isJsonObject(parent)) {
    applyToObject(parent, leaf, op);
    return document;
  }
  throw new BitemporalError(`JSON Pointer "${op.path}" does not address a container`);
}

function resolve(document: JsonValue, tokens: readonly string[], pointer: string): JsonValue {
  let cursor = document;
  for (const token of tokens) {
    if (Array.isArray(cursor)) {
      const index = arrayIndex(token, cursor.length, pointer, false);
      cursor = cursor[index];
    } else if (isJsonObject(cursor)) {
      if (!Object.prototype.hasOwnProperty.call(cursor, token)) {
        throw new BitemporalError(`JSON Pointer "${pointer}" refers to a missing member "${token}"`);
      }
      cursor = cursor[token];
    } else {
      throw new BitemporalError(`JSON Pointer "${pointer}" traverses a non-container value`);
    }
  }
  return cursor;
}

function arrayIndex(token: string, length: number, pointer: string, allowAppend: boolean): number {
  if (token === '-') {
    if (!allowAppend) {
      throw new BitemporalError(`JSON Pointer "${pointer}" uses "-" outside an array append`);
    }
    return length;
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(token)) {
    throw new BitemporalError(`JSON Pointer "${pointer}" has a non-numeric array index "${token}"`);
  }
  const index = Number(token);
  const limit = allowAppend ? length : length - 1;
  if (index > limit) {
    throw new BitemporalError(`JSON Pointer "${pointer}" index ${index} is out of range`);
  }
  return index;
}

function applyToArray(parent: JsonValue[], token: string, op: JsonPatchOp): void {
  if (op.op === 'remove') {
    const index = arrayIndex(token, parent.length, op.path, false);
    parent.splice(index, 1);
    return;
  }
  if (op.value === undefined) {
    throw new BitemporalError(`"${op.op}" at "${op.path}" requires a value`);
  }
  const index = arrayIndex(token, parent.length, op.path, op.op === 'add');
  if (op.op === 'add') parent.splice(index, 0, deepClone(op.value));
  else parent[index] = deepClone(op.value);
}

function applyToObject(parent: JsonObject, token: string, op: JsonPatchOp): void {
  if (op.op === 'remove') {
    if (!Object.prototype.hasOwnProperty.call(parent, token)) {
      throw new BitemporalError(`cannot remove missing member at "${op.path}"`);
    }
    delete parent[token];
    return;
  }
  if (op.value === undefined) {
    throw new BitemporalError(`"${op.op}" at "${op.path}" requires a value`);
  }
  if (op.op === 'replace' && !Object.prototype.hasOwnProperty.call(parent, token)) {
    throw new BitemporalError(`cannot replace missing member at "${op.path}"`);
  }
  parent[token] = deepClone(op.value);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Ledger records
// ─────────────────────────────────────────────────────────────────────────────

/** Identifies one versioned facet of one entity, e.g. the limit price of order X. */
export interface FacetKey {
  entityKind: string;
  entityId: string;
  facet: string;
}

export interface SnapshotInput extends FacetKey {
  state: JsonValue;
  /** Defaults to `recordedAt`. */
  validFrom?: number;
  /** Defaults to `Date.now()`. */
  recordedAt?: number;
  /** Zero-trust attribution: which service wrote this. */
  spiffeId?: string;
  /** Spans every microservice hop of one interaction. */
  correlationId?: string;
  /** Supply for deterministic tests; otherwise a UUID is minted. */
  id?: string;
}

export interface SnapshotRecord extends FacetKey {
  id: string;
  state: JsonValue;
  validFrom: number;
  recordedAt: number;
  spiffeId: string;
  correlationId: string | null;
}

export interface DeltaInput extends FacetKey {
  /**
   * State before the change. Omit to diff against the ledger's current
   * reconstruction, which is what a request handler normally wants.
   */
  before?: JsonValue;
  after: JsonValue;
  /** Who caused the change — a user id, or a service name for system changes. */
  actor: string;
  validFrom?: number;
  recordedAt?: number;
  spiffeId?: string;
  correlationId?: string;
  id?: string;
}

export interface DeltaRecord extends FacetKey {
  id: string;
  snapshotId: string;
  patch: JsonPatchOp[];
  validFrom: number;
  recordedAt: number;
  actor: string;
  spiffeId: string;
  correlationId: string | null;
}

export interface ReconstructQuery extends FacetKey {
  /** Valid-time instant to rebuild. Defaults to now. */
  asOf?: number;
  /**
   * Transaction-time cutoff: ignore anything the platform learned after this
   * instant. Defaults to now, i.e. "using everything we know today".
   */
  recordedAsOf?: number;
}

export interface Reconstruction {
  /** `null` when the facet has no snapshot at or before `asOf`. */
  state: JsonValue | null;
  snapshotId: string | null;
  deltasApplied: number;
  /** Valid-from of the baseline the deltas were replayed onto. */
  snapshotValidFrom: number | null;
  /** Recorded-at of the newest row that contributed. */
  lastRecordedAt: number | null;
  asOf: number;
  recordedAsOf: number;
}

export interface HistoryQuery extends FacetKey {
  /** Inclusive valid-time lower bound. */
  from?: number;
  /** Inclusive valid-time upper bound. */
  to?: number;
  limit?: number;
}

export interface HistoryEntry {
  kind: 'snapshot' | 'delta';
  id: string;
  /** The baseline a delta hangs off; the row's own id for a snapshot. */
  snapshotId: string;
  validFrom: number;
  recordedAt: number;
  actor: string | null;
  spiffeId: string;
  correlationId: string | null;
  /** Populated for snapshots. */
  state: JsonValue | null;
  /** Populated for deltas. */
  patch: JsonPatchOp[] | null;
}

const DEFAULT_SPIFFE = 'spiffe://aurelius/unattributed';

const INSERT_SNAPSHOT = `INSERT INTO entity_facet_snapshots
  (id, entity_kind, entity_id, facet, state_json, valid_from, recorded_at, spiffe_id, correlation_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_DELTA = `INSERT INTO entity_facet_deltas
  (id, snapshot_id, entity_kind, entity_id, facet, patch_json, valid_from, recorded_at,
   actor, spiffe_id, correlation_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Nearest prior snapshot on both axes. Ordered so the tiebreak is total: two
 * rows can share a millisecond, and reconstruction must be reproducible.
 */
const SELECT_BASELINE = `SELECT * FROM entity_facet_snapshots
  WHERE entity_kind = ? AND entity_id = ? AND facet = ?
    AND valid_from <= ? AND recorded_at <= ?
  ORDER BY valid_from DESC, recorded_at DESC, id DESC
  LIMIT 1`;

/**
 * Deltas are selected by baseline lineage, not by a time window between two
 * snapshots. Every delta stores the `snapshot_id` that was the nearest prior
 * baseline when it was written, so "replay the deltas onto the nearest prior
 * snapshot" is a literal `snapshot_id = ?` — which also removes the boundary
 * ambiguity of a delta sharing a millisecond with its own baseline.
 */
const SELECT_DELTAS = `SELECT * FROM entity_facet_deltas
  WHERE snapshot_id = ? AND valid_from <= ? AND recorded_at <= ?
  ORDER BY valid_from ASC, recorded_at ASC, id ASC`;

function snapshotFromRow(row: SqlRow): SnapshotRecord {
  return {
    id: str(row, 'id'),
    entityKind: str(row, 'entity_kind'),
    entityId: str(row, 'entity_id'),
    facet: str(row, 'facet'),
    state: parseJson<JsonValue>(row['state_json'], null),
    validFrom: num(row, 'valid_from'),
    recordedAt: num(row, 'recorded_at'),
    spiffeId: str(row, 'spiffe_id', DEFAULT_SPIFFE),
    correlationId: strOrNull(row, 'correlation_id'),
  };
}

function deltaFromRow(row: SqlRow): DeltaRecord {
  return {
    id: str(row, 'id'),
    snapshotId: str(row, 'snapshot_id'),
    entityKind: str(row, 'entity_kind'),
    entityId: str(row, 'entity_id'),
    facet: str(row, 'facet'),
    patch: parseJson<JsonPatchOp[]>(row['patch_json'], []),
    validFrom: num(row, 'valid_from'),
    recordedAt: num(row, 'recorded_at'),
    actor: str(row, 'actor'),
    spiffeId: str(row, 'spiffe_id', DEFAULT_SPIFFE),
    correlationId: strOrNull(row, 'correlation_id'),
  };
}

/** Writes a new baseline. Never overwrites: snapshots accumulate by design. */
export function writeSnapshot(input: SnapshotInput, db: SqlDriver = getDb()): SnapshotRecord {
  const recordedAt = input.recordedAt ?? Date.now();
  const record: SnapshotRecord = {
    id: input.id ?? randomUUID(),
    entityKind: input.entityKind,
    entityId: input.entityId,
    facet: input.facet,
    state: input.state,
    validFrom: input.validFrom ?? recordedAt,
    recordedAt,
    spiffeId: input.spiffeId ?? DEFAULT_SPIFFE,
    correlationId: input.correlationId ?? null,
  };
  db.prepare(INSERT_SNAPSHOT).run(
    record.id,
    record.entityKind,
    record.entityId,
    record.facet,
    JSON.stringify(record.state),
    record.validFrom,
    record.recordedAt,
    record.spiffeId,
    record.correlationId,
  );
  return record;
}

/**
 * Records a state change as an RFC 6902 patch against the nearest prior
 * snapshot.
 *
 * A no-op patch is still written. Under the mandate the delta table is the
 * record of *interactions*, not just of value changes: knowing that a user
 * re-submitted an identical limit price at 10:01:45.203 is itself evidence, and
 * dropping the row would leave an unexplained gap next to the audit event.
 */
export function appendDelta(input: DeltaInput, db: SqlDriver = getDb()): DeltaRecord {
  const recordedAt = input.recordedAt ?? Date.now();
  const validFrom = input.validFrom ?? recordedAt;
  const key: FacetKey = {
    entityKind: input.entityKind,
    entityId: input.entityId,
    facet: input.facet,
  };

  return db.transaction(() => {
    const baseline = db
      .prepare(SELECT_BASELINE)
      .get(key.entityKind, key.entityId, key.facet, validFrom, recordedAt);

    let snapshotId: string;
    let before: JsonValue;

    if (baseline === undefined) {
      // The foreign key requires a baseline, and forensically a delta with no
      // origin state is unreplayable. Seed one from the caller's `before`.
      const seeded = writeSnapshot(
        {
          ...key,
          state: input.before ?? {},
          validFrom,
          recordedAt,
          spiffeId: input.spiffeId,
          correlationId: input.correlationId,
        },
        db,
      );
      snapshotId = seeded.id;
      before = seeded.state;
    } else {
      const record = snapshotFromRow(baseline);
      snapshotId = record.id;
      // Diffing against the live reconstruction (not the raw baseline) is what
      // keeps each delta minimal once several have accumulated.
      before =
        input.before !== undefined
          ? input.before
          : reconstruct({ ...key, asOf: validFrom, recordedAsOf: recordedAt }, db).state;
    }

    const patch = diffToJsonPatch(before, input.after);
    const record: DeltaRecord = {
      id: input.id ?? randomUUID(),
      snapshotId,
      ...key,
      patch,
      validFrom,
      recordedAt,
      actor: input.actor,
      spiffeId: input.spiffeId ?? DEFAULT_SPIFFE,
      correlationId: input.correlationId ?? null,
    };
    db.prepare(INSERT_DELTA).run(
      record.id,
      record.snapshotId,
      record.entityKind,
      record.entityId,
      record.facet,
      JSON.stringify(record.patch),
      record.validFrom,
      record.recordedAt,
      record.actor,
      record.spiffeId,
      record.correlationId,
    );
    return record;
  });
}

/**
 * Rebuilds the state of one facet at one instant by replaying every delta whose
 * valid-time falls after the baseline and at or before `asOf`, restricted to
 * rows recorded by `recordedAsOf`.
 */
export function reconstruct(query: ReconstructQuery, db: SqlDriver = getDb()): Reconstruction {
  const now = Date.now();
  const asOf = query.asOf ?? now;
  const recordedAsOf = query.recordedAsOf ?? now;
  const empty: Reconstruction = {
    state: null,
    snapshotId: null,
    deltasApplied: 0,
    snapshotValidFrom: null,
    lastRecordedAt: null,
    asOf,
    recordedAsOf,
  };

  const baselineRow = db
    .prepare(SELECT_BASELINE)
    .get(query.entityKind, query.entityId, query.facet, asOf, recordedAsOf);
  if (baselineRow === undefined) return empty;

  const baseline = snapshotFromRow(baselineRow);
  const deltaRows = db.prepare(SELECT_DELTAS).all(baseline.id, asOf, recordedAsOf);

  let state = baseline.state;
  let lastRecordedAt = baseline.recordedAt;
  let applied = 0;
  for (const row of deltaRows) {
    const delta = deltaFromRow(row);
    try {
      state = applyJsonPatch(state, delta.patch);
    } catch (cause) {
      throw new BitemporalError(
        `delta ${delta.id} cannot be replayed onto snapshot ${baseline.id}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    lastRecordedAt = Math.max(lastRecordedAt, delta.recordedAt);
    applied += 1;
  }

  return {
    state,
    snapshotId: baseline.id,
    deltasApplied: applied,
    snapshotValidFrom: baseline.validFrom,
    lastRecordedAt,
    asOf,
    recordedAsOf,
  };
}

/**
 * The full audit timeline for one facet — snapshots and deltas interleaved in
 * valid-time order. This is what the compliance console renders when an
 * incident is reconstructed by hand.
 */
export function history(query: HistoryQuery, db: SqlDriver = getDb()): HistoryEntry[] {
  const from = query.from ?? 0;
  const to = query.to ?? Number.MAX_SAFE_INTEGER;

  const snapshots = db
    .prepare(
      `SELECT * FROM entity_facet_snapshots
        WHERE entity_kind = ? AND entity_id = ? AND facet = ?
          AND valid_from >= ? AND valid_from <= ?`,
    )
    .all(query.entityKind, query.entityId, query.facet, from, to)
    .map((row): HistoryEntry => {
      const record = snapshotFromRow(row);
      return {
        kind: 'snapshot',
        id: record.id,
        snapshotId: record.id,
        validFrom: record.validFrom,
        recordedAt: record.recordedAt,
        actor: null,
        spiffeId: record.spiffeId,
        correlationId: record.correlationId,
        state: record.state,
        patch: null,
      };
    });

  const deltas = db
    .prepare(
      `SELECT * FROM entity_facet_deltas
        WHERE entity_kind = ? AND entity_id = ? AND facet = ?
          AND valid_from >= ? AND valid_from <= ?`,
    )
    .all(query.entityKind, query.entityId, query.facet, from, to)
    .map((row): HistoryEntry => {
      const record = deltaFromRow(row);
      return {
        kind: 'delta',
        id: record.id,
        snapshotId: record.snapshotId,
        validFrom: record.validFrom,
        recordedAt: record.recordedAt,
        actor: record.actor,
        spiffeId: record.spiffeId,
        correlationId: record.correlationId,
        state: null,
        patch: record.patch,
      };
    });

  const merged = [...snapshots, ...deltas].sort((a, b) => {
    if (a.validFrom !== b.validFrom) return a.validFrom - b.validFrom;
    if (a.recordedAt !== b.recordedAt) return a.recordedAt - b.recordedAt;
    // A snapshot at the same instant is the baseline the delta hangs off.
    if (a.kind !== b.kind) return a.kind === 'snapshot' ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return query.limit !== undefined && query.limit >= 0 ? merged.slice(0, query.limit) : merged;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Immutability enforcement
// ─────────────────────────────────────────────────────────────────────────────

export interface AppendOnlyProof {
  /** Trigger names found installed on the two ledger tables. */
  triggers: string[];
  /** True when a real UPDATE against a real row was aborted by the engine. */
  updateBlocked: boolean;
  /** True when a real DELETE against a real row was aborted by the engine. */
  deleteBlocked: boolean;
  /**
   * Per evidence table, whether the freeze holds — and how that was established.
   * `fired` means a real UPDATE against a real row was aborted by the engine;
   * `declared` means the table was empty, so there was nothing to fire against
   * and the trigger's own text was read back and checked instead. Reported
   * rather than summarised, so the compliance console can name the table that is
   * unprotected instead of only that something is.
   */
  evidence: { table: string; updateBlocked: boolean; evidence: 'fired' | 'declared' }[];
  enforced: boolean;
}

const PROBE_ID = '__aurelius_append_only_probe__';

/** Every trigger the ledger must carry: the bitemporal pair and the evidence tables. */
const EXPECTED_TRIGGERS: readonly string[] = [...APPEND_ONLY_TRIGGER_NAMES, ...EVIDENCE_TRIGGER_NAMES];

/**
 * One UPDATE per evidence table, against a column that must never move.
 *
 * Each runs inside its own savepoint and is rolled back whether it aborts or
 * not, so the probe never leaves a mark on a populated ledger.
 *
 * A row-level `BEFORE UPDATE` trigger fires once per matched row, so on an empty
 * table the statement succeeds having changed nothing and proves nothing. That
 * is not a failure and must not be reported as one: a fresh deployment has an
 * empty audit ledger by definition. Where there is no row to fire against, the
 * trigger's own text is read back out of `sqlite_master` instead and checked to
 * be a `RAISE(ABORT)` on that table — weaker evidence, honestly labelled, and it
 * strengthens by itself the moment the table has its first row.
 */
const EVIDENCE_PROBES: readonly { table: string; update: string }[] = [
  { table: 'audit_events', update: "UPDATE audit_events SET raw_payload = '__probe__'" },
  { table: 'tos_acceptances', update: "UPDATE tos_acceptances SET version = '__probe__'" },
  { table: 'risk_decisions', update: 'UPDATE risk_decisions SET approved = 1 - approved' },
  { table: 'orders', update: 'UPDATE orders SET quantity = quantity + 1' },
  { table: 'order_telemetry', update: "UPDATE order_telemetry SET click_json = '__probe__'" },
];

/**
 * Proves — rather than documents — that the ledger cannot be rewritten.
 *
 * digest-compliance §AUDIT IMMUTABILITY: "a plaintiff's attorney will
 * successfully argue such logs could have been easily altered, deleted, or
 * manipulated post-incident". A comment saying "we never UPDATE this table" is
 * exactly the convention that argument defeats, so this function installs the
 * BEFORE UPDATE / BEFORE DELETE triggers (idempotently — they are also part of
 * the migration) and then attempts a genuine UPDATE and a genuine DELETE against
 * a probe row inside a savepoint that is always rolled back. If either
 * statement succeeds, immutability is not enforced and the function throws.
 *
 * Called at startup and asserted by the test suite, this converts the mandate
 * from a policy into a checked property of the running database.
 */
export function assertAppendOnly(db: SqlDriver = getDb()): AppendOnlyProof {
  for (const statement of APPEND_ONLY_TRIGGERS) {
    db.exec(statement);
  }

  /*
   * The placeholder list is generated, not written out.
   *
   * It used to be a literal `IN (?, ?, ?, ?)` matching the four names of the
   * day, so adding a fifth trigger threw `column index out of range` at
   * startup — a guard that breaks when the thing it guards grows is a guard
   * nobody can extend. `EXPECTED_TRIGGERS` is the two families together: the
   * bitemporal snapshot/delta pair and the evidence tables (audit_events,
   * tos_acceptances, risk_decisions, orders, order_telemetry), so this proves
   * the whole ledger rather than a corner of it.
   */
  const installed = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name IN (${EXPECTED_TRIGGERS.map(() => '?').join(', ')})
        ORDER BY name`,
    )
    .all(...EXPECTED_TRIGGERS)
    .map((row) => str(row, 'name'));

  let updateBlocked = false;
  let deleteBlocked = false;

  db.exec('SAVEPOINT aurelius_append_only_probe');
  try {
    db.prepare(INSERT_SNAPSHOT).run(
      PROBE_ID,
      '__probe__',
      PROBE_ID,
      'immutability',
      '{}',
      0,
      0,
      DEFAULT_SPIFFE,
      null,
    );
    try {
      db.prepare('UPDATE entity_facet_snapshots SET facet = ? WHERE id = ?').run(
        'tampered',
        PROBE_ID,
      );
    } catch {
      updateBlocked = true;
    }
    try {
      db.prepare('DELETE FROM entity_facet_snapshots WHERE id = ?').run(PROBE_ID);
    } catch {
      deleteBlocked = true;
    }
  } finally {
    // RAISE(ABORT) unwinds only the offending statement, so the savepoint is
    // still live and the probe row disappears with it.
    db.exec('ROLLBACK TO aurelius_append_only_probe');
    db.exec('RELEASE aurelius_append_only_probe');
  }

  /*
   * The evidence tables are proved the same way, not assumed from the trigger
   * count. A trigger that exists but whose body was rewritten to a no-op would
   * still be listed above; only an aborted statement is evidence. Each frozen
   * table is probed on a column that must never move — the audit ledger's
   * payload, an acceptance's version, a risk decision's verdict, an order's
   * quantity, a telemetry row's control result.
   */
  const evidenceBlocked = EVIDENCE_PROBES.map((probe) => {
    const populated = db.prepare(`SELECT COUNT(*) AS n FROM ${probe.table}`).get();
    const rows = populated === undefined ? 0 : num(populated, 'n');

    if (rows === 0) {
      const declared = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`)
        .all(probe.table)
        .map((row) => str(row, 'sql'));
      const guards =
        declared.some((sql) => /BEFORE\s+UPDATE/i.test(sql) && /RAISE\s*\(\s*ABORT/i.test(sql)) &&
        declared.some((sql) => /BEFORE\s+DELETE/i.test(sql) && /RAISE\s*\(\s*ABORT/i.test(sql));
      return { table: probe.table, updateBlocked: guards, evidence: 'declared' as const };
    }

    let blocked = false;
    db.exec('SAVEPOINT aurelius_evidence_probe');
    try {
      db.prepare(probe.update).run();
    } catch {
      blocked = true;
    } finally {
      db.exec('ROLLBACK TO aurelius_evidence_probe');
      db.exec('RELEASE aurelius_evidence_probe');
    }
    return { table: probe.table, updateBlocked: blocked, evidence: 'fired' as const };
  });

  const proof: AppendOnlyProof = {
    triggers: installed,
    updateBlocked,
    deleteBlocked,
    evidence: evidenceBlocked,
    enforced:
      updateBlocked &&
      deleteBlocked &&
      installed.length === EXPECTED_TRIGGERS.length &&
      evidenceBlocked.every((e) => e.updateBlocked),
  };

  if (!proof.enforced) {
    const unprotected = evidenceBlocked.filter((e) => !e.updateBlocked).map((e) => e.table);
    throw new BitemporalError(
      'append-only enforcement is not active on the bitemporal ledger ' +
        `(triggers=${proof.triggers.length}/${EXPECTED_TRIGGERS.length}, ` +
        `updateBlocked=${proof.updateBlocked}, deleteBlocked=${proof.deleteBlocked}` +
        (unprotected.length === 0 ? '' : `, unprotected=${unprotected.join(',')}`) +
        ')',
    );
  }
  return proof;
}

/** Row counts for the compliance console's ledger-integrity panel. */
export function ledgerCounts(db: SqlDriver = getDb()): { snapshots: number; deltas: number } {
  const snapshots = db.prepare('SELECT COUNT(*) AS n FROM entity_facet_snapshots').get();
  const deltas = db.prepare('SELECT COUNT(*) AS n FROM entity_facet_deltas').get();
  return {
    snapshots: snapshots === undefined ? 0 : num(snapshots, 'n'),
    deltas: deltas === undefined ? 0 : num(deltas, 'n'),
  };
}
