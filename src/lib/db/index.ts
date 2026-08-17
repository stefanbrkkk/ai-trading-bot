/**
 * Persistence layer barrel.
 *
 * Import from `@/lib/db` rather than reaching into a file — the split between
 * client / schema / bitemporal / repositories is an internal one, and the
 * driver seam means a subsystem should never care which store is underneath.
 */

export type {
  DbMode,
  DriverFactory,
  SqlDriver,
  SqlRow,
  SqlRunResult,
  SqlStatement,
  SqlValue,
} from '@/lib/db/driver';

export {
  DB_FILENAME,
  closeDb,
  configuredDbMode,
  dataDir,
  databaseFile,
  dbMode,
  getDb,
  registerDriverFactory,
  resetDb,
} from '@/lib/db/client';

export type { MigrationReport } from '@/lib/db/schema';
export {
  APPEND_ONLY_TABLES,
  APPEND_ONLY_TRIGGERS,
  APPEND_ONLY_TRIGGER_NAMES,
  EQUITY_SNAPSHOT_COLUMNS,
  EQUITY_SNAPSHOT_DIMENSIONS,
  READ_ALLOWLIST,
  SCHEMA_STATEMENTS,
  SCHEMA_VERSION,
  TABLE_NAMES,
  VIEW_NAMES,
  dropAllObjects,
  migrate,
  monthBucket,
} from '@/lib/db/schema';

export type {
  AppendOnlyProof,
  DeltaInput,
  DeltaRecord,
  FacetKey,
  HistoryEntry,
  HistoryQuery,
  JsonObject,
  JsonPatchOp,
  JsonPatchOperation,
  JsonPrimitive,
  JsonValue,
  Reconstruction,
  ReconstructQuery,
  SnapshotInput,
  SnapshotRecord,
} from '@/lib/db/bitemporal';
export {
  BitemporalError,
  appendDelta,
  applyJsonPatch,
  assertAppendOnly,
  diffToJsonPatch,
  history,
  ledgerCounts,
  reconstruct,
  writeSnapshot,
} from '@/lib/db/bitemporal';

export {
  flag,
  fromCents,
  jsonText,
  jsonTextOrNull,
  parseJson,
  toCents,
} from '@/lib/db/row';

export * from '@/lib/db/repositories';
