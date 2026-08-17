/**
 * The single database connection.
 *
 * Zero required configuration (build contract §3): with an empty `.env` this
 * opens an embedded SQLite file under `.data/` and migrates it in place, so the
 * platform boots with no external service. `DATABASE_URL` is the switch that a
 * future Neon/Postgres driver registers against — see `driver.ts` for why the
 * seam exists.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type {
  DbMode,
  DriverFactory,
  SqlDriver,
  SqlRow,
  SqlStatement,
  SqlValue,
} from '@/lib/db/driver';
import { dropAllObjects, migrate } from '@/lib/db/schema';

export const DB_FILENAME = 'aurelius.db';
const DEFAULT_DATA_DIR = '.data';
/** Escape hatch used by unit tests: `AURELIUS_DATA_DIR=:memory:`. */
const IN_MEMORY = ':memory:';
/**
 * SQLite serialises writers. WAL plus a five-second busy timeout is what keeps
 * a burst of concurrent audit writes (every click is an audit row) from ever
 * surfacing SQLITE_BUSY to a request handler.
 */
const BUSY_TIMEOUT_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
//  ExperimentalWarning suppression
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `node:sqlite` is still flagged experimental, and Node prints that warning to
 * stderr the first time the builtin is linked. The E2E suite asserts a clean
 * console, so the warning is filtered out here — once per process, and only
 * this one warning, so a genuine deprecation or unhandled-rejection warning
 * still reaches the operator.
 *
 * Two hooks are needed. `process.emitWarning` covers anything emitted from now
 * on. But an ESM graph links builtins *before* it evaluates module bodies, so
 * the SQLite warning has usually already been emitted by the time this file
 * runs; emission only queues the warning, and the actual write to stderr
 * happens on the next tick through the `warning` listener. Wrapping the
 * existing listeners therefore catches the one that is already in flight while
 * preserving Node's own formatting for every other warning.
 */
const WARNING_FILTER_INSTALLED = '__aureliusSqliteWarningFilterInstalled';

function isSqliteExperimentalWarning(name: string, message: string): boolean {
  return name === 'ExperimentalWarning' && message.includes('SQLite');
}

function warningTypeOf(warning: string | Error, rest: readonly unknown[]): string {
  const first = rest[0];
  if (typeof first === 'string') return first;
  if (first !== null && typeof first === 'object' && 'type' in first) {
    const type = (first as { type?: unknown }).type;
    if (typeof type === 'string') return type;
  }
  return typeof warning === 'string' ? '' : warning.name;
}

function installWarningFilter(): void {
  const registry = globalThis as unknown as Record<string, unknown>;
  if (registry[WARNING_FILTER_INSTALLED] === true) return;
  registry[WARNING_FILTER_INSTALLED] = true;

  type WarningListener = (warning: Error) => void;
  const inherited = process.listeners('warning') as unknown as WarningListener[];
  process.removeAllListeners('warning');
  process.on('warning', (warning: Error) => {
    if (isSqliteExperimentalWarning(warning.name, warning.message)) return;
    for (const listener of inherited) listener.call(process, warning);
  });

  type EmitWarning = typeof process.emitWarning;
  const original = process.emitWarning;
  const patched = (warning: string | Error, ...rest: unknown[]): void => {
    const message = typeof warning === 'string' ? warning : warning.message;
    if (isSqliteExperimentalWarning(warningTypeOf(warning, rest), message)) return;
    const forward = original as unknown as (this: NodeJS.Process, ...args: unknown[]) => void;
    forward.call(process, warning, ...rest);
  };
  process.emitWarning = patched as unknown as EmitWarning;
}

installWarningFilter();

/**
 * `node:sqlite` is imported for its types only and fetched at first use.
 *
 * An ESM graph links builtin modules during instantiation — before any module body
 * evaluates — so a static `import … from 'node:sqlite'` emits the experimental
 * warning while the filter above is still unreachable, no matter where the import
 * sits. Deferring the load to the first `getDb()` call puts it strictly after
 * `installWarningFilter()` on every runtime, ESM and CommonJS alike, which is what
 * keeps the console clean for the E2E assertion. See `loadSqlite` for how the load
 * is performed and why.
 */
type SqliteModule = { DatabaseSync: new (path: string, options?: SqliteOpenOptions) => DatabaseSync };

interface SqliteOpenOptions {
  enableForeignKeyConstraints?: boolean;
  timeout?: number;
}

let sqliteModule: SqliteModule | null = null;

/**
 * Loads `node:sqlite` lazily, without involving the bundler.
 *
 * Three approaches were tried, and the reasoning matters because each failure is
 * instructive:
 *
 *   • A **static import** is the obvious choice and the wrong one. `node:sqlite`
 *     landed in Node 22.5, so on an older runtime a static import fails at *module
 *     evaluation* — taking down the whole application at boot, including every page
 *     that never touches the database, with an error naming a module the operator
 *     did not know they depended on.
 *
 *   • **`createRequire`** defers correctly but webpack cannot statically evaluate
 *     the call and emits "module.createRequire failed parsing argument" on every
 *     build. Passing a string literal instead of a computed path does not help —
 *     webpack's handler wants `import.meta.url` specifically. A permanent harmless
 *     warning is the worst kind, because it teaches readers to skim the build log.
 *
 *   • **`process.getBuiltinModule`** (Node 22.3+) exists for precisely this: fetch
 *     a builtin synchronously, no module system involved, nothing for a bundler to
 *     resolve or rewrite. Every runtime that has `node:sqlite` has it, so the
 *     version floor is unchanged.
 *
 * The result is lazy, silent at build time, and fails at the point of use with a
 * message about persistence rather than at boot with one about a module specifier.
 */
function loadSqlite(): SqliteModule {
  if (sqliteModule === null) {
    const builtin = process.getBuiltinModule('node:sqlite') as SqliteModule | undefined;
    if (builtin?.DatabaseSync === undefined) {
      throw new Error(
        `The embedded store requires Node's built-in "node:sqlite" module, which this runtime (${process.version}) does not provide. Upgrade to Node 22.5 or later, or set DATABASE_URL to use a registered external driver.`,
      );
    }
    sqliteModule = builtin;
  }
  return sqliteModule;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Location resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Absolute data directory, from `AURELIUS_DATA_DIR` (default `.data`). */
export function dataDir(): string {
  const configured = process.env.AURELIUS_DATA_DIR?.trim();
  const target = configured && configured.length > 0 ? configured : DEFAULT_DATA_DIR;
  return resolve(process.cwd(), target);
}

/** Absolute path of the ledger file, or `:memory:` when so configured. */
export function databaseFile(): string {
  if (process.env.AURELIUS_DATA_DIR?.trim() === IN_MEMORY) return IN_MEMORY;
  return join(dataDir(), DB_FILENAME);
}

/**
 * The mode the environment *asks* for. `dbMode()` reports what is actually in
 * use, which can differ when a Postgres URL is set but no Postgres driver has
 * been registered — the build contract forbids adding a `pg` dependency, so
 * that case degrades to the embedded ledger rather than failing to boot.
 */
export function configuredDbMode(): DbMode {
  const url = process.env.DATABASE_URL?.trim() ?? '';
  return /^postgres(?:ql)?:\/\//i.test(url) ? 'postgres' : 'embedded';
}

// ─────────────────────────────────────────────────────────────────────────────
//  Embedded driver
// ─────────────────────────────────────────────────────────────────────────────

class EmbeddedSqliteDriver implements SqlDriver {
  readonly mode: DbMode = 'embedded';
  readonly location: string;

  #db: DatabaseSync;
  #statements = new Map<string, SqlStatement>();
  /** Savepoint nesting depth, so `transaction()` composes. */
  #depth = 0;

  constructor(file: string) {
    this.location = file;
    if (file !== IN_MEMORY) mkdirSync(dirname(file), { recursive: true });
    const { DatabaseSync: Sqlite } = loadSqlite();
    this.#db = new Sqlite(file, {
      enableForeignKeyConstraints: true,
      timeout: BUSY_TIMEOUT_MS,
    });
    // WAL is meaningless for an in-memory database and SQLite would silently
    // keep journal_mode=memory, so it is only requested for real files.
    if (file !== IN_MEMORY) this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // NORMAL is the documented safe pairing with WAL: a crash can lose the
    // tail of the last transaction but never corrupts the ledger.
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec('PRAGMA temp_store = MEMORY');
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    const cached = this.#statements.get(sql);
    if (cached) return cached;
    const statement = this.#db.prepare(sql);
    const wrapped: SqlStatement = {
      run: (...params: SqlValue[]) => {
        const result = statement.run(...params);
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
      },
      get: (...params: SqlValue[]): SqlRow | undefined => statement.get(...params),
      all: (...params: SqlValue[]): SqlRow[] => statement.all(...params),
      columns: (): string[] => statement.columns().map((column) => column.name),
    };
    this.#statements.set(sql, wrapped);
    return wrapped;
  }

  transaction<T>(body: () => T): T {
    const nested = this.#depth > 0;
    const savepoint = `aurelius_sp_${this.#depth}`;
    this.#depth += 1;
    this.#db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    try {
      const result = body();
      this.#db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.#db.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
      if (nested) this.#db.exec(`RELEASE ${savepoint}`);
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }

  close(): void {
    this.#statements.clear();
    this.#db.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Driver registry + singleton
// ─────────────────────────────────────────────────────────────────────────────

const factories = new Map<DbMode, DriverFactory>();
let active: SqlDriver | null = null;
let warnedAboutMissingPostgres = false;

factories.set('embedded', () => new EmbeddedSqliteDriver(databaseFile()));

/**
 * The seam. Registering a `'postgres'` factory is all that is required to move
 * the identical DDL and repositories onto Neon; nothing else in the codebase
 * references a concrete database.
 */
export function registerDriverFactory(mode: DbMode, factory: DriverFactory): void {
  factories.set(mode, factory);
  if (active !== null && active.mode !== mode && configuredDbMode() === mode) {
    // A late registration must not leave half the process on the old store.
    closeDb();
  }
}

function resolveMode(): DbMode {
  const configured = configuredDbMode();
  if (configured === 'postgres' && !factories.has('postgres')) {
    if (!warnedAboutMissingPostgres) {
      warnedAboutMissingPostgres = true;
      console.warn(
        '[aurelius/db] DATABASE_URL points at Postgres but no Postgres driver is registered; ' +
          'falling back to the embedded SQLite ledger.',
      );
    }
    return 'embedded';
  }
  return configured;
}

/** The mode actually serving queries. */
export function dbMode(): DbMode {
  return active !== null ? active.mode : resolveMode();
}

/** Opens (once) and migrates the ledger, then hands back the shared driver. */
export function getDb(): SqlDriver {
  if (active !== null) return active;
  const mode = resolveMode();
  const factory = factories.get(mode) ?? factories.get('embedded');
  if (factory === undefined) {
    // Unreachable: the embedded factory is registered at module load.
    throw new Error(`[aurelius/db] no driver factory registered for mode "${mode}"`);
  }
  const driver = factory();
  active = driver;
  try {
    migrate(driver);
  } catch (error) {
    active = null;
    driver.close();
    throw error;
  }
  return driver;
}

/** Releases the connection. Idempotent; safe to call in test teardown. */
export function closeDb(): void {
  const driver = active;
  if (driver === null) return;
  active = null;
  try {
    driver.close();
  } catch (error) {
    console.warn('[aurelius/db] failed to close the ledger cleanly', error);
  }
}

/**
 * Drops every object and recreates the schema. Used by `scripts/seed.ts` and by
 * the test suites that need a known-empty ledger. For the embedded store the
 * files are removed outright, which is both faster and guaranteed to clear WAL
 * residue; any other driver is reset with DDL so the same call works there.
 */
export function resetDb(): SqlDriver {
  if (resolveMode() === 'embedded') {
    closeDb();
    const file = databaseFile();
    if (file !== IN_MEMORY) {
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${file}${suffix}`, { force: true });
      }
    }
    return getDb();
  }
  const driver = getDb();
  driver.transaction(() => {
    dropAllObjects(driver);
  });
  migrate(driver);
  return driver;
}

export type { DbMode, DriverFactory, SqlDriver, SqlRow, SqlStatement, SqlValue };
