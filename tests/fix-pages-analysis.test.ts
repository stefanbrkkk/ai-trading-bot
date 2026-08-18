/**
 * The seven analysis surfaces: /compliance, /control, /backtest, /research,
 * /admin, /screener and /terminal.
 *
 * Every case here shipped, and they divide into the two kinds this suite's
 * siblings already distinguish.
 *
 * The first kind has an arithmetic outcome and is checked against the thing the
 * page has to agree with rather than against its own output. The acceptance
 * ledger's cells are checked by reading a record the real repository wrote, so a
 * rename in the store fails here rather than blanking a column in the browser.
 * The back-test tail is checked by counting how many of the plotted observations
 * fall inside the region the chart's own caption calls "the 5% of observations
 * beyond VaR95" — the defect was that the annotation was computed from the daily
 * equity curve and drawn over a histogram of trade returns, so 68% of the bars
 * sat inside a region captioned 5%.
 *
 * The second kind is a claim, and a claim is checked by reading it. /control told
 * every reader that "a decision is recorded every time you run a pre-flight
 * check", above a history that a pre-flight has never written a row to. There is
 * no expression to fix in that; the sentence is the defect, and the assertion is
 * on the sentence — this codebase treats its prose as part of the product, and a
 * page describing behaviour the platform does not have has no other detector.
 *
 * The layout cases are the same kind. The environment is `node`, so nothing here
 * renders React or measures a box; what is asserted is that the construct which
 * produced the measured defect is gone and the one that replaced it is present,
 * with the measurement that motivated it recorded in the test's own prose.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { mean, quantile } from '@/lib/quant/stats';

// In memory, before anything resolves the data directory: nothing in this file
// may touch `.data/`.
process.env.AURELIUS_DATA_DIR = ':memory:';
const { closeDb } = await import('@/lib/db/client');
const { listTosAcceptances, recordTosAcceptance, upsertUser } = await import('@/lib/db');

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

const COMPLIANCE = read('src/app/compliance/page.tsx');
const CONTROL = read('src/app/control/page.tsx');
const BACKTEST = read('src/app/backtest/page.tsx');
const RESEARCH = read('src/app/research/page.tsx');
const ADMIN = read('src/app/admin/page.tsx');
const SCREENER = read('src/app/screener/page.tsx');
const TERMINAL = read('src/app/terminal/page.tsx');
const PREFLIGHT_ROUTE = read('src/app/api/orders/preflight/route.ts');
const SUBMIT_ROUTE = read('src/app/api/orders/submit/route.ts');

/**
 * Lifts a top-level function out of a page and makes it callable.
 *
 * Copying the body into the test would check the copy. These functions are
 * small, pure and free of JSX, so the only thing between the source and
 * `new Function` is the type annotations, removed by an exact substitution that
 * has to match — extraction fails loudly rather than silently exercising a shape
 * that has moved on.
 */
function lift<T>(source: string, signature: string, plain: string, deps: Record<string, unknown>): T {
  const start = source.indexOf(signature);
  expect(start, `signature not found: ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}\n', start);
  expect(end, 'function end not found').toBeGreaterThan(start);
  const body = source.slice(start, end + 2).replace(signature, plain);
  expect(body.startsWith(plain), 'signature substitution failed').toBe(true);
  const name = plain.slice('function '.length, plain.indexOf('('));
  const factory = new Function(...Object.keys(deps), `${body}\nreturn ${name};`);
  return factory(...Object.values(deps)) as T;
}

/** The slice of a source between a marker and the matching column-2 `}`. */
function block(source: string, opener: string, closer: string): string {
  const start = source.indexOf(opener);
  expect(start, `opener not found: ${opener}`).toBeGreaterThan(-1);
  const end = source.indexOf(closer, start);
  expect(end, `closer not found: ${closer}`).toBeGreaterThan(start);
  return source.slice(start, end + closer.length);
}

// ─────────────────────────────────────────────────────────────────────────────
//  #28 / #35 / #44 — the acceptance ledger reads the fields the store writes
// ─────────────────────────────────────────────────────────────────────────────

/*
 * The page declared `tosVersion`, `clickX` and `clickY` at the top level of its
 * history rows. The record has never carried those names, so the VERSION cell
 * rendered empty and the CLICK cell rendered a lone comma — under a panel
 * printing the same version correctly from `acceptedVersion`, and under a
 * heading promising the reader a record of "what you agreed to and when".
 */
const USER_ID = 'user-acceptance-ledger';
const ACCEPTED_AT = 1_787_040_623_281;

upsertUser({
  email: 'ledger@aurelius.test',
  displayName: 'Ledger',
  role: 'trader',
  passwordHash: 'x',
  passwordSalt: 'y',
  liveTradingUnlocked: false,
  tosAcceptedAt: null,
  tosVersion: null,
  createdAt: ACCEPTED_AT - 1_000,
  id: USER_ID,
});

recordTosAcceptance({
  userId: USER_ID,
  version: '2026-01-15',
  acceptedAt: ACCEPTED_AT,
  ipAddress: 'unattributed',
  userAgent: 'vitest',
  scrolledToBottom: true,
  scrollDurationMs: 749,
  click: {
    clickX: 361,
    clickY: 538,
    viewportWidth: 1440,
    viewportHeight: 900,
    clickedAt: ACCEPTED_AT,
    trusted: true,
    targetId: 'accept-terms',
  },
});

const LEDGER_ROW = listTosAcceptances(USER_ID)[0];

/** Resolves a dotted path against a value, or `undefined` at the first gap. */
function at(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, value);
}

describe('the compliance acceptance ledger renders the record the store wrote', () => {
  it('writes a record with a version and nested click coordinates', () => {
    expect(LEDGER_ROW).toBeDefined();
    expect(LEDGER_ROW?.version).toBe('2026-01-15');
    expect(LEDGER_ROW?.click.clickX).toBe(361);
    expect(LEDGER_ROW?.click.clickY).toBe(538);
    // The names the page used to read. Their absence is the whole defect.
    expect(LEDGER_ROW).not.toHaveProperty('tosVersion');
    expect(LEDGER_ROW).not.toHaveProperty('clickX');
    expect(LEDGER_ROW).not.toHaveProperty('clickY');
  });

  it('reads only paths that resolve on that record', () => {
    const table = block(COMPLIANCE, '{consent.data.history.map((entry) => (', '</TableShell>');
    const paths = [...table.matchAll(/entry\.([A-Za-z][A-Za-z0-9_.]*)/g)].map((m) => m[1] as string);
    // The extraction itself has to have found the cells, or this passes vacuously.
    expect(paths).toContain('version');
    expect(paths).toContain('click.clickX');
    expect(paths).toContain('click.clickY');
    for (const path of new Set(paths)) {
      expect(at(LEDGER_ROW, path), `entry.${path} is not on the record`).toBeDefined();
    }
  });

  it('no longer names the fields that never existed', () => {
    expect(COMPLIANCE).not.toContain('entry.tosVersion');
    expect(COMPLIANCE).not.toContain('entry.clickX');
    expect(COMPLIANCE).not.toContain('entry.clickY');
  });

  it('borrows the store record type instead of restating its shape', () => {
    // A restated shape is what let three wrong field names typecheck.
    expect(COMPLIANCE).toContain('history: TosAcceptanceRecord[];');
    expect(COMPLIANCE).toContain("import type { TosAcceptanceRecord } from '@/lib/db';");
    // `import type` and nothing else: a value import puts `node:sqlite` in the
    // browser bundle.
    expect(COMPLIANCE).not.toMatch(/^import \{[^}]*\} from '@\/lib\/db';$/m);
  });

  it('prints the keyboard sentinel as a keypress rather than as a coordinate', () => {
    // `clickProvenance` records −1 for a keyboard activation because 0,0 is a
    // real point in the corner of the viewport.
    expect(COMPLIANCE).toContain("? 'keyboard'");
    expect(COMPLIANCE).toContain('entry.click.clickX < 0 || entry.click.clickY < 0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  #45 — the tail drawn on the trade histogram is the trade histogram's tail
// ─────────────────────────────────────────────────────────────────────────────

const tailRisk = lift<(returns: number[]) => { var95: number; cvar95: number } | null>(
  BACKTEST,
  'function tailRisk(returns: number[]): { var95: number; cvar95: number } | null {',
  'function tailRisk(returns) {',
  { mean, quantile },
);

/** 31 trade returns with a fat left tail — the shape a real run produces. */
const TRADE_RETURNS = [
  -0.16, -0.12, -0.09, -0.07, -0.05, -0.04, -0.03, -0.025, -0.02, -0.015, -0.012, -0.01, -0.008, -0.006, -0.004,
  -0.002, 0.001, 0.003, 0.005, 0.007, 0.009, 0.012, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.07, 0.09, 0.12,
];

/**
 * Daily equity returns over the same window: far more observations, far tighter,
 * because a day is not a trade. This is the series `metrics.var95` measures, and
 * its 5% quantile lands in the *body* of the trade distribution.
 */
const DAILY_RETURNS = Array.from({ length: 400 }, (_, i) => -0.004 + (0.008 * i) / 399);

/** The share of a series at or beyond a threshold — what the chart shades. */
function shadedShare(returns: number[], level: number): number {
  return returns.filter((r) => r <= level).length / returns.length;
}

describe('the back-test distribution annotates the series it plots', () => {
  it('shades about 5% of the plotted observations, as the caption says', () => {
    const tail = tailRisk(TRADE_RETURNS);
    expect(tail).not.toBeNull();
    const share = shadedShare(TRADE_RETURNS, (tail as { var95: number }).var95);
    // Discrete data cannot hit 5% exactly at n = 31; it must be within a
    // rounding of it, and must never be the majority of the chart.
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThanOrEqual(0.1);
  });

  it('would have shaded almost half the chart with the daily-equity tail', () => {
    // The defect, reproduced: the number that used to be passed in.
    const daily = quantile(DAILY_RETURNS, 0.05);
    expect(shadedShare(TRADE_RETURNS, daily)).toBeGreaterThan(0.4);
  });

  it('reports a conditional loss no better than the threshold it conditions on', () => {
    const tail = tailRisk(TRADE_RETURNS) as { var95: number; cvar95: number };
    expect(tail.cvar95).toBeLessThanOrEqual(tail.var95);
    // And the printed mean cannot sit below the average of the worst 5% — the
    // impossibility the mismatched pair produced (MEAN −0.52% under a CVaR95 of
    // −0.83% and a VaR95 of −0.25%).
    expect(mean(TRADE_RETURNS)).toBeGreaterThan(tail.cvar95);
  });

  it('uses the same quantile primitive the engine uses for the daily series', () => {
    const tail = tailRisk(TRADE_RETURNS) as { var95: number };
    expect(tail.var95).toBe(quantile(TRADE_RETURNS, 0.05));
    expect(BACKTEST).toContain("import { mean, quantile } from '@/lib/quant/stats';");
  });

  it('draws no threshold at all below five observations', () => {
    // A zero here would put the line at break-even and shade every losing trade.
    expect(tailRisk([-0.01, 0.02, -0.03, 0.04])).toBeNull();
    expect(BACKTEST).toContain('{...(tradeTail === null ? {} : { var95: tradeTail.var95, cvar95: tradeTail.cvar95 })}');
  });

  it('no longer passes the daily-equity quantiles to the trade histogram', () => {
    expect(BACKTEST).not.toContain('var95: m.var95');
    expect(BACKTEST).not.toContain('cvar95: m.cvar95');
    // They are still published, beside the volatility that shares their basis,
    // labelled with the series they were computed from.
    expect(BACKTEST).toContain('label="VaR95 (daily equity)"');
    expect(BACKTEST).toContain('label="CVaR95 (daily equity)"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  #84 — /control does not promise a row a pre-flight never writes
// ─────────────────────────────────────────────────────────────────────────────

describe('the control centre describes what the risk decision history contains', () => {
  it('is backed by a pre-flight route that writes nothing', () => {
    expect(PREFLIGHT_ROUTE).toContain('commit: false');
    expect(PREFLIGHT_ROUTE).not.toContain('insertRiskDecision');
    // No write of any kind: the preview is a preview.
    expect(PREFLIGHT_ROUTE).not.toMatch(/\binsert[A-Z]\w*\(/);
  });

  it('is backed by a submit route that does write one', () => {
    // Which is what makes "every order you submit" the true claim.
    expect(SUBMIT_ROUTE).toContain('insertRiskDecision(');
  });

  it('never tells the reader a pre-flight check is recorded', () => {
    expect(CONTROL).not.toContain('run a pre-flight check or route an order');
    expect(CONTROL).not.toContain('every risk check run against your orders');
    for (const claim of ['A decision is recorded every time you submit an order', 'reserves nothing and writes nothing']) {
      expect(CONTROL).toContain(claim);
    }
  });

  it('never mentions pre-flight without saying what it does not do', () => {
    // Prose and docstring alike: the word may not appear on this page in a
    // sentence that leaves the reader expecting a row.
    const sentences = CONTROL.split(/(?<=[.;])\s+/).filter((s) => /pre-flight/i.test(s));
    expect(sentences.length).toBeGreaterThan(0);
    for (const sentence of sentences) {
      expect(sentence, `unqualified pre-flight claim: ${sentence}`).toMatch(/\bnot\b|\bnothing\b|preview/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  #27 — a provider reason stays beside its label
// ─────────────────────────────────────────────────────────────────────────────

describe('the provider status list lays a sentence out as a column, not as a wrap', () => {
  it('renders the reasons through a two-column grid', () => {
    expect(CONTROL).toContain('grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] items-baseline gap-x-4 py-2');
    for (const label of ['Market data', 'Inference', 'Engine', 'Model', 'Degraded feeds']) {
      expect(CONTROL).toContain(`<ReasonRow label="${label}"`);
    }
  });

  it('keeps the shared row primitive for the scalar list it was built for', () => {
    // The rejection counters are counts, which is exactly what `DataRow` is for.
    expect(CONTROL).toContain('value={integer(entry.count)}');
    expect(CONTROL).toContain('<DataRow');
  });

  it('still emits a term and a definition for a screen reader', () => {
    const row = block(CONTROL, 'function ReasonRow(', '\n}\n');
    expect(row).toContain('<dt');
    expect(row).toContain('<dd');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  #86 — a pasted URL wraps instead of widening the document
// ─────────────────────────────────────────────────────────────────────────────

describe('the research answer heading wraps the question a user typed', () => {
  it('carries a wrapping rule on the only heading a user writes', () => {
    expect(RESEARCH).toContain('<PanelHeader className="break-words" eyebrow="Answer" title={answer.question} />');
  });

  it('accepts a token long enough to need it', () => {
    // 600 characters with no space in them is reachable from the field, and one
    // 95-character URL was enough: 693px of document against a 390px viewport.
    expect(RESEARCH).toContain('maxLength={600}');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  #105 — the admin refusal says what it is refusing
// ─────────────────────────────────────────────────────────────────────────────

describe('the unauthorised admin state earns the region it occupies', () => {
  const branch = block(ADMIN, '  if (!isAdmin) {', '\n  }\n');

  it('still refuses, and still says the refusal is enforced server-side', () => {
    expect(branch).toContain('Not authorised');
    expect(branch).toContain('enforced server-side');
  });

  it('names the three controls the console holds', () => {
    for (const control of ['Kill switch', 'Forensic telemetry', 'Entitlements']) {
      expect(branch).toContain(control);
    }
  });

  it('says how the administrator role is granted', () => {
    // Both paths, and only those two exist: the configured address at signup,
    // and a grant from an existing administrator.
    expect(branch).toContain('AURELIUS_ADMIN_EMAIL');
    expect(branch).toContain('existing administrator grants the role');
  });

  it('reads no privileged payload to do it', () => {
    // The branch returns before any admin query is consumed; it must stay that
    // way, or the refusal would depend on data the caller may not read.
    expect(branch).not.toContain('telemetry.data');
    expect(branch).not.toContain('kill.data');
    expect(branch).not.toContain('entitlements.data');
  });

  it('leaves the authorised render path alone', () => {
    expect(ADMIN).toContain('<PageShell wide>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  #8 — the screener's driver column has a width
// ─────────────────────────────────────────────────────────────────────────────

describe('the screener leading-driver column is width-capped', () => {
  it('gives the cell a block box and an explicit width', () => {
    // `truncate` alone does nothing inside an auto-layout `<td>`: without a
    // definite width the column collapsed to 89px and every one of 67 rows
    // wrapped to three or four lines.
    expect(SCREENER).toContain('className="block w-44 truncate text-2xs text-parchment-faint" title={row.topDriver}');
  });

  it('recovers the full label rather than losing it', () => {
    const cell = block(SCREENER, 'block w-44 truncate', '</Td>');
    expect(cell).toContain('title={row.topDriver}');
  });

  it('leaves the unconstrained span behind', () => {
    expect(SCREENER).not.toContain('<span className="text-2xs text-parchment-faint">{row.topDriver}</span>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  #69 — the publication card's rows share a baseline on a phone
// ─────────────────────────────────────────────────────────────────────────────

describe('the terminal card gives its metric list the full card width on a phone', () => {
  it('stacks the dial above the rows below sm and restores the row above it', () => {
    expect(TERMINAL).toContain('flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-5');
    expect(TERMINAL).toContain('<dl className="w-full min-w-0 flex-1 space-y-1.5">');
  });

  it('no longer packs a 132px dial and a four-row list into 375px of card', () => {
    expect(TERMINAL).not.toContain('<div className="mb-4 mt-4 flex items-center gap-5">');
    // The dial's size is the constraint that made the list 141px wide; if it
    // changes, the stacking breakpoint is worth re-measuring.
    expect(TERMINAL).toContain('size={132}');
  });
});

closeDb();
