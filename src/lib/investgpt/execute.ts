/**
 * Query execution.
 *
 * The last stage, and the narrowest. It receives SQL that has already passed the
 * validator and does three things the validator cannot: bounds the result set,
 * bounds the work, and converts driver rows into the flat column/row shape the API
 * returns.
 *
 * A row cap is enforced even when the statement carries its own LIMIT, because the
 * two protect against different things. The statement's LIMIT is what the user
 * asked for; the cap is what the process can afford to serialise into a JSON
 * response. A generated query with no LIMIT against a wide view is not a security
 * problem — the validator has already established it can only read impersonal
 * market data — but it is a memory problem, and the honest handling is to truncate
 * and *say so* rather than to stream 60,000 rows into a browser tab.
 */

import { getDb, type SqlRow, type SqlValue } from '@/lib/db';

/** Rows returned to a client, whatever the statement's own LIMIT says. */
export const MAX_ROWS = 500;

export interface ExecutionResult {
  columns: string[];
  rows: (string | number | null)[][];
  rowCount: number;
  /** True when the cap truncated the result. */
  truncated: boolean;
  elapsedMs: number;
  error: string | null;
}

/**
 * Flattens a driver value for JSON.
 *
 * `bigint` is the case that matters: `node:sqlite` returns one for an INTEGER
 * column wide enough to need it, and `JSON.stringify` throws on bigint rather than
 * degrading — so an un-narrowed row is a 500 that only appears once a market cap
 * crosses 2^53. Values beyond safe-integer range become strings rather than lossy
 * doubles, because silently rounding an identifier is worse than rendering it as
 * text.
 */
function flatten(value: SqlValue): string | number | null {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (typeof value === 'string') return value;
  // Uint8Array — a BLOB. No queryable relation stores one, so this is defensive.
  return `<${value.byteLength} bytes>`;
}

export interface ExecuteOptions {
  params?: readonly (string | number)[];
  maxRows?: number;
}

export function executeQuery(sql: string, options: ExecuteOptions = {}): ExecutionResult {
  const startedAt = Date.now();
  const maxRows = Math.min(options.maxRows ?? MAX_ROWS, MAX_ROWS);

  try {
    const db = getDb();
    const statement = db.prepare(sql);

    // Column names are read from the prepared statement rather than from the first
    // row, so a query matching zero rows still reports what it would have
    // returned. A screener that answers "no matches" is far more useful with its
    // headers intact than as an empty object.
    const columns = statement.columns();

    const raw: SqlRow[] = statement.all(...(options.params ?? []).map((value) => value as SqlValue));
    const truncated = raw.length > maxRows;
    const kept = truncated ? raw.slice(0, maxRows) : raw;

    const rows = kept.map((row) => columns.map((column) => flatten(row[column] ?? null)));

    return {
      columns,
      rows,
      rowCount: kept.length,
      truncated,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      error: null,
    };
  } catch (error) {
    // A driver error here is a genuine bug (the validator passed a statement
    // SQLite rejected) or an un-migrated database. Both are reported to the caller
    // rather than thrown, so the route can answer with the SQL and the reason
    // instead of a 500 that hides which query failed.
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Whether the store is queryable.
 *
 * Checked before execution so a fresh clone with no database yields "the store has
 * not been seeded" rather than a driver stack trace. The probe reads the snapshot
 * view's row count, which fails both when the schema is absent and when it exists
 * but holds nothing — the two states that make an InvestGPT answer impossible.
 */
export function storeReady(): { ready: boolean; reason: string | null; symbols: number } {
  try {
    const row = getDb().prepare('SELECT COUNT(*) AS n FROM v_equity_snapshot').get();
    const value = row?.n;
    const symbols = typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : 0;
    if (symbols === 0) {
      return {
        ready: false,
        reason:
          'The feature store holds no rows yet, so a query would return nothing. Run `npm run seed` to populate the snapshot.',
        symbols: 0,
      };
    }
    return { ready: true, reason: null, symbols };
  } catch (error) {
    return {
      ready: false,
      reason: `The store is not queryable: ${error instanceof Error ? error.message : String(error)}. Run \`npm run seed\` to create and populate it.`,
      symbols: 0,
    };
  }
}
