/**
 * The persistence driver seam.
 *
 * The compliance mandate (digest-compliance §"Database technology mandate")
 * names PostgreSQL/JSONB for the append-only bitemporal ledger, and the
 * InvestGPT mandate (digest-investgpt) assumes Neon serverless Postgres. The
 * build contract, however, requires the whole platform to run end to end with
 * a completely empty `.env`, no network and no extra dependencies.
 *
 * Both are satisfied by never letting a repository touch a concrete database:
 * every query in this layer goes through the narrow synchronous interface
 * below. It is implemented today by Node 22's embedded `node:sqlite`, and a
 * Neon/Postgres implementation can be registered later (see
 * `registerDriverFactory` in `client.ts`) without editing a single call site.
 */

/** Which physical store is backing the ledger. */
export type DbMode = 'embedded' | 'postgres';

/**
 * The exact value domain `node:sqlite` accepts and returns. Booleans are
 * deliberately absent: SQLite has no boolean type, so this layer stores 0/1
 * integers and converts at the repository boundary.
 */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** A returned row. `node:sqlite` hands back null-prototype plain objects. */
export type SqlRow = Record<string, SqlValue>;

export interface SqlRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

/**
 * A prepared statement. Parameters are positional `?` placeholders — named
 * `$name` binding is intentionally not part of the seam because the two
 * dialects spell named parameters differently.
 */
export interface SqlStatement {
  run(...params: SqlValue[]): SqlRunResult;
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
  /**
   * Result-set column names, in order, without executing the statement.
   * InvestGPT reports the columns of a generated SELECT even when it matches
   * zero rows, which `all()` alone cannot tell it.
   */
  columns(): string[];
}

export interface SqlDriver {
  readonly mode: DbMode;
  /** File path in embedded mode, connection URL otherwise. Diagnostics only. */
  readonly location: string;
  /** DDL and other result-less statements. */
  exec(sql: string): void;
  /** Prepared statements are cached per driver instance, keyed by SQL text. */
  prepare(sql: string): SqlStatement;
  /**
   * Runs `body` atomically. Nested calls use savepoints, so a repository
   * helper that opens a transaction stays composable inside a larger one —
   * which the multi-table writes (a signal plus its drivers and agents) need.
   */
  transaction<T>(body: () => T): T;
  close(): void;
}

export type DriverFactory = () => SqlDriver;
