/**
 * Regressions for the persistence layer, the UI helper modules and the two
 * routes that publish a number a page then labels.
 *
 * Every test here corresponds to something that was true of the shipped build
 * and is not meant to be true again. Where the original defect was a *claim*
 * rather than a computation — a docstring naming a consumer that does not
 * exist, a comment asserting an immutability the database did not enforce — the
 * test asserts the thing the claim describes, so the claim cannot quietly
 * decay back into fiction.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Both must be set before the store module is imported: the first keeps every
// write in memory (nothing here may touch `.data/`), the second is the subject
// of the DATABASE_URL test at the bottom.
process.env.AURELIUS_DATA_DIR = ':memory:';
process.env.DATABASE_URL = 'postgresql://user:pw@db.example.invalid:5432/aurelius';

const { closeDb, configuredDbMode, dbMode, getDb } = await import('@/lib/db/client');
const {
  APPEND_ONLY_TRIGGER_NAMES,
  APPEND_ONLY_TABLES,
  EVIDENCE_TABLES,
  EVIDENCE_TRIGGERS,
  EVIDENCE_TRIGGER_NAMES,
} = await import('@/lib/db/schema');
const { hFunction, tailDependence } = await import('@/lib/quant/copula');
const { rankContributions, shapWaterfall } = await import('@/lib/quant/shap');
const { SECTORS, UNIVERSE } = await import('@/lib/market/universe');

import type { SqlDriver } from '@/lib/db/driver';
import type { PairCopula } from '@/lib/quant/copula';
import type { ShapExplanation } from '@/lib/quant/shap';

const REPO_ROOT = resolve(__dirname, '..');

beforeAll(() => {
  // `resolveMode()` warns once about the unregistered Postgres driver. That
  // warning is the documented behaviour under test, not noise to fix.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  closeDb();
});

// ─────────────────────────────────────────────────────────────────────────────
//  The ledger is append-only — proved, not asserted
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs `attempt` and reports whether the database aborted it.
 *
 * Everything runs inside a savepoint that is always rolled back, exactly as
 * `assertAppendOnly` does: RAISE(ABORT) unwinds only the offending statement, so
 * the savepoint survives and the probe rows disappear with it.
 */
function blocked(attempt: () => void): string | null {
  try {
    attempt();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function seedProbeRows(db: SqlDriver): void {
  db.prepare("INSERT INTO audit_events (id, occurred_at, event_type) VALUES ('p', 1, 'probe')").run();
  db.prepare(
    "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('p', 'p@probe', 'p', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO tos_acceptances (id, user_id, version, accepted_at) VALUES ('p', 'p', 'v1', 1)",
  ).run();
  db.prepare(
    "INSERT INTO risk_decisions (id, user_id, symbol, evaluated_at) VALUES ('p', 'p', 'AAPL', 1)",
  ).run();
  db.prepare(
    `INSERT INTO orders (id, user_id, symbol, side, type, quantity, account, status, created_at, updated_at)
     VALUES ('p', 'p', 'AAPL', 'buy', 'market', 10, 'paper', 'submitted', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO order_telemetry (order_id, client_click, server_received, risk_completed, broker_dispatched)
     VALUES ('p', 1, 2, 3, 4)`,
  ).run();
  db.prepare(
    "INSERT INTO intent_tokens (token, user_id, symbol, minted_at, expires_at) VALUES ('p', 'p', 'AAPL', 1, 2)",
  ).run();
}

/** Every column of a table, from the DDL the driver actually applied. */
function columnsOf(db: SqlDriver, table: string): string[] {
  return db
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => String((row as Record<string, unknown>).name));
}

const PRIMARY_KEY: Record<string, string> = {
  audit_events: 'id',
  tos_acceptances: 'id',
  risk_decisions: 'id',
  orders: 'id',
  order_telemetry: 'order_id',
};

describe('append-only enforcement', () => {
  it('installs both trigger families and nothing else', () => {
    const db = getDb();
    const installed = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all()
      .map((row) => String((row as Record<string, unknown>).name));

    const expected = [...APPEND_ONLY_TRIGGER_NAMES, ...EVIDENCE_TRIGGER_NAMES].slice().sort();
    expect(installed).toEqual(expected);
  });

  it('keeps the trigger list and the name list in step', () => {
    // A trigger present in the DDL but absent from the name list would survive
    // `dropAllObjects`, and a name with no trigger would make any count-based
    // proof pass vacuously.
    const declared = EVIDENCE_TRIGGERS.map((sql) => {
      const match = /CREATE TRIGGER IF NOT EXISTS (\w+)/.exec(sql);
      if (match === null) throw new Error(`unparseable trigger DDL: ${sql.slice(0, 60)}`);
      return match[1] as string;
    });
    expect(declared.slice().sort()).toEqual([...EVIDENCE_TRIGGER_NAMES].slice().sort());
    expect(new Set(EVIDENCE_TRIGGER_NAMES).size).toBe(EVIDENCE_TRIGGER_NAMES.length);
  });

  it('aborts a real UPDATE and a real DELETE against every protected table', () => {
    const db = getDb();
    db.exec('SAVEPOINT fix_db_misc_probe');
    try {
      seedProbeRows(db);

      for (const { table, mutableColumns } of EVIDENCE_TABLES) {
        const key = PRIMARY_KEY[table] as string;
        const frozen = columnsOf(db, table).filter(
          (column) => column !== key && !mutableColumns.includes(column),
        );
        expect(frozen.length, `${table} has no frozen columns to probe`).toBeGreaterThan(0);

        for (const column of frozen) {
          const message = blocked(() =>
            db.prepare(`UPDATE ${table} SET ${column} = NULL WHERE ${key} = 'p'`).run(),
          );
          expect(message, `${table}.${column} accepted an UPDATE`).not.toBeNull();
        }

        const deleted = blocked(() =>
          db.prepare(`DELETE FROM ${table} WHERE ${key} = 'p'`).run(),
        );
        expect(deleted, `${table} accepted a DELETE`).not.toBeNull();
      }
    } finally {
      db.exec('ROLLBACK TO fix_db_misc_probe');
      db.exec('RELEASE fix_db_misc_probe');
    }
  });

  it('still lets an order advance through its execution lifecycle', () => {
    // The column-scoped trigger exists so that freezing the instruction does not
    // freeze the fill. `updateOrderExecution` writes exactly these columns.
    const db = getDb();
    db.exec('SAVEPOINT fix_db_misc_lifecycle');
    try {
      seedProbeRows(db);
      expect(
        blocked(() =>
          db
            .prepare(
              `UPDATE orders
                  SET updated_at = 2, status = 'filled', filled_quantity = 10,
                      average_fill_price = 1.5, broker_status = 200,
                      broker_response_json = '{}', broker_order_id = 'b1'
                WHERE id = 'p'`,
            )
            .run(),
        ),
      ).toBeNull();

      // The broker acknowledgement arrives as an upsert, and an upsert's
      // DO UPDATE fires UPDATE triggers like any other write.
      expect(
        blocked(() =>
          db
            .prepare(
              `INSERT INTO order_telemetry
                 (order_id, client_click, server_received, risk_completed, broker_dispatched, broker_acknowledged)
               VALUES ('p', 1, 2, 3, 4, 5)
               ON CONFLICT (order_id) DO UPDATE SET
                 broker_acknowledged = excluded.broker_acknowledged,
                 broker_status = excluded.broker_status,
                 broker_body = excluded.broker_body`,
            )
            .run(),
        ),
      ).toBeNull();
    } finally {
      db.exec('ROLLBACK TO fix_db_misc_lifecycle');
      db.exec('RELEASE fix_db_misc_lifecycle');
    }
  });

  it('leaves intent_tokens mutable, because single-use is implemented by mutating it', () => {
    const db = getDb();
    db.exec('SAVEPOINT fix_db_misc_tokens');
    try {
      seedProbeRows(db);
      expect(
        blocked(() =>
          db.prepare("UPDATE intent_tokens SET consumed_at = 9 WHERE token = 'p'").run(),
        ),
      ).toBeNull();
      expect(
        blocked(() => db.prepare("DELETE FROM intent_tokens WHERE token = 'p'").run()),
      ).toBeNull();
    } finally {
      db.exec('ROLLBACK TO fix_db_misc_tokens');
      db.exec('RELEASE fix_db_misc_tokens');
    }
  });

  it('protects every table the disclosures name', () => {
    const promised = [
      ...APPEND_ONLY_TABLES,
      ...EVIDENCE_TABLES.map((entry) => entry.table),
    ];
    for (const table of [
      'entity_facet_snapshots',
      'entity_facet_deltas',
      'audit_events',
      'order_telemetry',
      'orders',
      'tos_acceptances',
      'risk_decisions',
    ]) {
      expect(promised, `${table} is unprotected`).toContain(table);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  DATABASE_URL does not silently move the store
// ─────────────────────────────────────────────────────────────────────────────

describe('driver mode', () => {
  it('serves from the embedded ledger when DATABASE_URL names Postgres with no driver registered', () => {
    // Two different questions with two different answers, which is the whole
    // point of having both functions: what the environment asked for, and what
    // is actually answering queries.
    expect(configuredDbMode()).toBe('postgres');
    expect(dbMode()).toBe('embedded');
    expect(getDb().mode).toBe('embedded');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  No exported function without a caller
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.data',
  'test-results',
  'playwright-report',
  'coverage',
  'public',
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (/\.(ts|tsx|mjs|md)$/.test(entry)) out.push(full);
  }
  return out;
}

let corpus: { path: string; text: string }[] = [];

function unreferencedExports(
  relativePath: string,
  only: (name: string) => boolean = () => true,
): string[] {
  const absolute = join(REPO_ROOT, relativePath);
  const source = readFileSync(absolute, 'utf8');
  const names = [...source.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)]
    .map((match) => match[1] as string)
    .filter(only);
  if (corpus.length === 0) {
    corpus = sourceFiles(REPO_ROOT).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
  }
  const others = corpus.filter((file) => file.path !== absolute);
  return names.filter((name) => {
    const pattern = new RegExp(`\\b${name}\\b`);
    return !others.some((file) => pattern.test(file.text));
  });
}

describe('exported surface', () => {
  /*
   * 81 of 147 exported repository functions had no caller anywhere in the
   * repository — whole subsystems, including a `publishRanking` that directly
   * contradicted the documented decision never to persist the daily Top 5. The
   * count is not the point; the invariant is. An export nobody calls is a
   * standing invitation to call it.
   */
  it('leaves no repository export without a caller', () => {
    expect(unreferencedExports('src/lib/db/repositories.ts')).toEqual([]);
  });

  /*
   * The same rot in the UI helpers, with an extra twist: the docstrings named
   * the components that used them. `roundedRectPath` was documented as drawing
   * "the waterfall bars and ladder cells" while ShapWaterfall drew plain
   * `<rect rx>` and DepthLadder used its own component; `arcPath` was documented
   * as the conviction ring, which uses `circlePath`.
   */
  it('leaves no SVG or format helper without a caller', () => {
    expect(unreferencedExports('src/lib/ui/svg.ts')).toEqual([]);
    expect(unreferencedExports('src/lib/ui/format.ts')).toEqual([]);
  });

  /*
   * The terminal store exported thirteen selectors and one component subscribed
   * to two of them, which made an entirely unwired store read as a wired one.
   *
   * Scoped to the selectors on purpose. `DEFAULT_SCREENER_FILTER` and
   * `EMPTY_TICKET` are also referenced only inside the factory today, but they
   * are value contracts rather than subscriptions — a blank ticket is the
   * compliance guarantee that no field arrives pre-filled — and an unread
   * constant does not misrepresent what the tree is wired to.
   */
  it('leaves no terminal-store selector without a subscriber', () => {
    expect(
      unreferencedExports('src/store/terminalStore.ts', (name) => name.startsWith('select')),
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  The attribution header and the waterfall beside it count the same set
// ─────────────────────────────────────────────────────────────────────────────

function explanationWithZeroes(): ShapExplanation {
  // Eight non-zero drivers, four numerically-zero ones. A GBDT produces these
  // whenever a feature is never split on: φ is exactly 0, not merely small.
  const values = [0.9, -0.7, 0.5, -0.4, 0.3, -0.25, 0.2, -0.15, 0, 0, 0, 0];
  const baseValue = 0.1;
  return {
    values,
    baseValue,
    rawPrediction: values.reduce((a, b) => a + b, baseValue),
    probability: 0.5,
    featureNames: values.map((_, i) => `f${i}`),
    featureValues: values.map(() => 1),
  };
}

describe('attributed input count', () => {
  it('counts the ranked set, not the raw φ vector', () => {
    const explanation = explanationWithZeroes();
    const ranked = rankContributions(explanation);
    expect(explanation.values.length).toBe(12);
    expect(ranked.length).toBe(8);
  });

  it('reconciles with the waterfall the page draws beside it', () => {
    // The page renders `Top {contributions} of {attributedInputs}` above a
    // waterfall whose last bar reads "{n} other drivers". A reader who adds the
    // bars up is doing the arithmetic the page invites, so it has to come out:
    // named steps + remainder must equal the published total.
    const explanation = explanationWithZeroes();
    const attributedInputs = rankContributions(explanation).length;
    const waterfall = shapWaterfall(explanation, 3);

    const remainder = waterfall.steps.filter((step) => / other drivers$/.test(step.label));
    expect(remainder).toHaveLength(1);
    const pooled = Number((remainder[0] as { label: string }).label.split(' ')[0]);
    const named = waterfall.steps.length - 1;

    expect(named + pooled).toBe(attributedInputs);
    // And the raw vector length would not have reconciled — that is the defect.
    expect(named + pooled).not.toBe(explanation.values.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  λ_L is a limit, not a probability at the 5th percentile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * C(q, q) = ∫₀^q h(q | v) dv, by midpoint rule on the exact h-function.
 *
 * Deliberately not `copulaCdf`: it answers the Student-t case with the Gaussian
 * copula cdf at the same ρ (see its own comment), and every tree-1 edge the
 * joint-downside panel fits on a real book comes back Student-t.
 */
function conditionalExceedance(copula: PairCopula, q: number, steps = 20_000): number {
  const width = q / steps;
  let joint = 0;
  for (let i = 0; i < steps; i += 1) joint += hFunction(copula, q, (i + 0.5) * width);
  return (joint * width) / q;
}

describe('lower-tail dependence', () => {
  it('is materially smaller than the conditional exceedance at q = 0.05', () => {
    // A Student-t pair at ρ = 0.6, ν = 5 — the shape every edge on the sample
    // book came back as. λ_L is the limit as the threshold goes to zero; the
    // panel's label speaks about a finite 5% threshold. Publishing one under the
    // other's label understates co-movement, in the direction that flatters.
    const copula: PairCopula = { family: 'student', theta: 0.6, nu: 5 };
    const lambda = tailDependence(copula).lower;
    const exact = conditionalExceedance(copula, 0.05);

    expect(lambda).toBeGreaterThan(0);
    expect(exact).toBeGreaterThan(lambda);
    // Not a rounding difference: on the measured five-name book the two were
    // 0.212 and 0.268, and the concentration multiples 4.24× and 5.36×.
    expect(exact - lambda).toBeGreaterThan(0.02);
  });

  it('is exactly zero for the families with no tail dependence, at any threshold', () => {
    for (const family of ['gaussian', 'frank'] as const) {
      expect(tailDependence({ family, theta: 0.6 }).lower).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  The universe docstring says something true
// ─────────────────────────────────────────────────────────────────────────────

describe('universe docstring', () => {
  it('asserts counts that hold', () => {
    const tradable = UNIVERSE.filter((spec) => !spec.isBenchmark);
    expect(UNIVERSE.length).toBe(68);
    expect(tradable.length).toBe(67);
    expect(SECTORS.length).toBe(11);
    // "across all eleven GICS sectors" is true of the tradable names alone, so
    // the sentence needs no benchmark qualifier on that clause.
    expect(new Set(tradable.map((spec) => spec.sector)).size).toBe(11);
  });

  it('qualifies the benchmark once, not twice', () => {
    // The sentence read "…plus the benchmark, across all eleven GICS sectors
    // plus the benchmark", which modifies a set the benchmark cannot be added
    // to. A stray duplicate is the signature of a half-applied edit.
    const source = readFileSync(join(REPO_ROOT, 'src/lib/market/universe.ts'), 'utf8');
    const sentence = source
      .split('\n')
      .find((line) => line.includes('tradable names plus the benchmark'));
    expect(sentence).toBeDefined();
    expect((sentence as string).match(/plus the benchmark/g)).toHaveLength(1);
  });
});
