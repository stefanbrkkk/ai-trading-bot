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
 *
 * The *say so* is what this file got wrong. `truncated` used to mean only "the cap
 * in this function cut the result", tested as `rows.length > maxRows`, and it could
 * never be true: the compiler bakes its own LIMIT into every list statement — 25 by
 * default, 200 at the ceiling — so SQLite stopped the scan long before the 500-row
 * cap had anything left to cut. The screener therefore labelled every capped result
 * "Complete result" while dropping matches. Asked "Which optionable large cap names
 * have a 25 delta risk reversal below -2?" it returned 25 rows and called them
 * complete; asked the identical predicate as "how many", the same compiler answered
 * 50. A screening surface that drops a name and asserts it dropped nothing is worse
 * than one that shows fewer rows.
 *
 * So truncation is measured against whichever bound actually stopped the scan, the
 * statement's own LIMIT included, and it is *established* rather than inferred. A
 * result that comes back at exactly the statement's limit is the one count that
 * reads both ways — 25 rows under `LIMIT 25` describes a universe of 25 matches and
 * a universe of 500 identically — so in that single case the statement is re-run
 * bounded one row higher and the flag is set only if that row exists. Everywhere
 * else no probe runs at all.
 */

import { getDb, type SqlRow, type SqlValue } from '@/lib/db';

/** Rows returned to a client, whatever the statement's own LIMIT says. */
export const MAX_ROWS = 500;

export interface ExecutionResult {
  columns: string[];
  rows: (string | number | null)[][];
  rowCount: number;
  /**
   * True when at least one matching row was dropped — by the statement's own
   * LIMIT or by the cap here. Never a guess: see the probe below.
   */
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

/** A statement's own row bound, and the same statement asking for one row more. */
interface StatementLimit {
  rows: number;
  probe: string;
}

/**
 * Reads the LIMIT the statement carries in its own text.
 *
 * SQLite accepts three spellings and the probe has to rewrite the right integer of
 * the two: `LIMIT n`, `LIMIT n OFFSET m`, and the MySQL-compatible `LIMIT m, n` in
 * which the *first* number is the offset. Getting that backwards would rewrite an
 * offset and compare row counts against a bound that was never applied, so each
 * form is matched explicitly rather than by a single loose pattern.
 *
 * Anything else — a bound parameter, an expression, a LIMIT nested inside a
 * subquery — yields null and leaves truncation to the row cap, which is then the
 * only bound this function can measure. That fallback cannot fire in this build:
 * the compiler interpolates a literal (`LIMIT ${limit}`) as the last line of the
 * statement, and the model path executes its candidate with no parameters at all,
 * so a `LIMIT ?` would fail at `prepare` long before it reached here. It is written
 * down rather than asserted because a parser that silently guessed at an unreadable
 * bound would be the same class of mistake this file exists to correct.
 */
function statementLimit(sql: string): StatementLimit | null {
  const body = sql.replace(/\s*;\s*$/, '').trimEnd();

  const commaForm = /\blimit\s+(\d+)\s*,\s*(\d+)$/i.exec(body);
  if (commaForm !== null) {
    const rows = Number(commaForm[2]);
    if (!Number.isSafeInteger(rows) || rows <= 0) return null;
    return { rows, probe: `${body.slice(0, commaForm.index)}LIMIT ${commaForm[1]}, ${rows + 1}` };
  }

  const offsetForm = /\blimit\s+(\d+)\s+offset\s+(\d+)$/i.exec(body);
  if (offsetForm !== null) {
    const rows = Number(offsetForm[1]);
    if (!Number.isSafeInteger(rows) || rows <= 0) return null;
    return { rows, probe: `${body.slice(0, offsetForm.index)}LIMIT ${rows + 1} OFFSET ${offsetForm[2]}` };
  }

  const plainForm = /\blimit\s+(\d+)$/i.exec(body);
  if (plainForm !== null) {
    const rows = Number(plainForm[1]);
    if (!Number.isSafeInteger(rows) || rows <= 0) return null;
    return { rows, probe: `${body.slice(0, plainForm.index)}LIMIT ${rows + 1}` };
  }

  return null;
}

/**
 * Whether the statement's own LIMIT stopped it short of a match.
 *
 * Runs only when the result came back at exactly that limit — the ambiguous count —
 * and costs one extra row of work, because the probe is the same statement bounded
 * one row higher rather than an unbounded rescan. The statement the caller shows the
 * user is executed verbatim and is still the statement that produced the rows: the
 * page's "the exact SQL that ran" heading stays literally true.
 *
 * A probe that throws fails closed and reports truncation. The alternative is to
 * publish "Complete result" over a result whose completeness was never established,
 * and on a screening surface that is the more expensive of the two errors — an
 * over-cautious footnote sends a reader back to the query, a wrong one sends them
 * away satisfied.
 */
function droppedByOwnLimit(sql: string, returned: number, params: readonly SqlValue[]): boolean {
  const own = statementLimit(sql);
  if (own === null || returned < own.rows) return false;
  try {
    return getDb().prepare(own.probe).all(...params).length > own.rows;
  } catch (error) {
    console.error('[investgpt] truncation probe failed', error);
    return true;
  }
}

export function executeQuery(sql: string, options: ExecuteOptions = {}): ExecutionResult {
  const startedAt = Date.now();
  const maxRows = Math.min(options.maxRows ?? MAX_ROWS, MAX_ROWS);
  const params = (options.params ?? []).map((value) => value as SqlValue);

  try {
    const db = getDb();
    const statement = db.prepare(sql);

    // Column names are read from the prepared statement rather than from the first
    // row, so a query matching zero rows still reports what it would have
    // returned. A screener that answers "no matches" is far more useful with its
    // headers intact than as an empty object.
    const columns = statement.columns();

    const raw: SqlRow[] = statement.all(...params);

    // Two different bounds can stop a scan and the reader has to hear about either
    // one. The cap here is observed directly — more rows came back than it allows.
    // The statement's own LIMIT leaves no such trace, so it is probed for, and only
    // in the one case where the row count cannot be read either way.
    const cappedHere = raw.length > maxRows;
    const kept = cappedHere ? raw.slice(0, maxRows) : raw;
    const truncated = cappedHere || droppedByOwnLimit(sql, raw.length, params);

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
    /*
     * A driver error here is a genuine bug (the validator passed a statement
     * SQLite rejected) or an un-migrated database. Both are reported to the
     * caller rather than thrown, so the route can answer with the SQL and a
     * reason instead of a 500 that hides which query failed.
     *
     * The driver's own message is logged, not returned. This endpoint answers
     * anonymous callers, and SQLite's errors name tables, columns and file paths
     * — which is a free schema map for anyone probing the validator.
     */
    console.error('[investgpt] query execution failed', error);
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      error: 'The query was rejected by the store. The statement is shown above; the reason is in the server log.',
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
          'The feature store holds no rows yet, so a query would return nothing. Seed the deployment to populate the snapshot.',
        symbols: 0,
      };
    }
    return { ready: true, reason: null, symbols };
  } catch (error) {
    // Same reasoning as above: the operator gets the driver's message, the
    // anonymous caller gets the action they can take about it.
    console.error('[investgpt] store probe failed', error);
    return {
      ready: false,
      reason: 'The store is not queryable. Run `npm run seed` to create and populate it.',
      symbols: 0,
    };
  }
}
