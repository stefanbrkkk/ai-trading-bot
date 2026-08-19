/**
 * InvestGPT truncation and claim classification: three places a surface asserted
 * something the module beside it contradicted.
 *
 * All three were the same shape — a label that had drifted away from the thing it
 * labels — and each is pinned here against the behaviour rather than against the
 * wording, because the wording is the part that was wrong.
 *
 *   1. `executeQuery` reported `truncated` by comparing the returned row count with
 *      its own 500-row cap. The compiler bakes a `LIMIT 25` into every list
 *      statement, so SQLite stopped the scan first and the flag could never be true.
 *      The screener therefore printed "Complete result" over results that had
 *      dropped matches: "Which optionable large cap names have a 25 delta risk
 *      reversal below -2?" returned 25 rows and called them complete while the
 *      identical predicate asked as a count answered 50.
 *   2. The structured-reading chips on `/investgpt` printed an ORDER BY and a LIMIT
 *      for every result, including the COUNT statements that carry neither — under
 *      a panel headed "The exact SQL that ran".
 *   3. `REGULATORY_TERMS` held the bare adjective 'discretionary', and
 *      `classifyClaim` tests that list as a substring before anything else. The GICS
 *      sector name "Consumer Discretionary" therefore routed every risk-factor
 *      sentence naming that sector to the platform-status verifier, which grades
 *      against a document those sentences cannot appear in — so a sentence copied
 *      character for character out of a 10-K was published "unsupported" next to the
 *      citation it was copied from.
 *
 * The truncation cases run against an in-memory store rather than the seeded one, so
 * the boundary that matters — a result sitting *exactly* on its own LIMIT, which is
 * complete, versus one row past it, which is not — can be constructed rather than
 * hoped for. That boundary is the whole point: a `rows.length >= limit` test would
 * pass every other case here and still label a complete result truncated.
 */

process.env.AURELIUS_DATA_DIR = ':memory:';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { classifyClaim, groundAnswer, type Evidence } from '@/lib/rag/ground';
import { compileQuestion } from '@/lib/investgpt/compile';

const { closeDb, getDb } = await import('@/lib/db/client');
const { executeQuery, MAX_ROWS } = await import('@/lib/investgpt/execute');

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. Truncation is measured, not assumed
// ─────────────────────────────────────────────────────────────────────────────

/** Thirty rows, `n` from 1 to 30, so every limit below is a known distance from the end. */
const ROWS = 30;

beforeAll(() => {
  const db = getDb();
  db.prepare('CREATE TABLE IF NOT EXISTS probe_rows (n INTEGER PRIMARY KEY, label TEXT NOT NULL)').run();
  for (let n = 1; n <= ROWS; n += 1) {
    db.prepare('INSERT OR REPLACE INTO probe_rows (n, label) VALUES (?, ?)').run(n, `row-${n}`);
  }
});

afterAll(() => {
  closeDb();
});

describe('executeQuery reports truncation against the bound that actually stopped the scan', () => {
  it('flags a statement whose own LIMIT dropped a match', () => {
    // The shape of every default screener query: LIMIT 25 over a wider match set.
    const result = executeQuery('SELECT n, label FROM probe_rows ORDER BY n LIMIT 25');
    expect(result.error).toBeNull();
    expect(result.rowCount).toBe(25);
    expect(result.truncated).toBe(true);
  });

  it('does not flag a result that sits exactly on its own LIMIT with nothing behind it', () => {
    // 25 matches under LIMIT 25. This is the case a `rows.length >= limit` guess
    // gets wrong, and it is why the flag is established by a probe: the count alone
    // cannot tell a complete result from a truncated one.
    const result = executeQuery('SELECT n, label FROM probe_rows WHERE n <= 25 ORDER BY n LIMIT 25');
    expect(result.rowCount).toBe(25);
    expect(result.truncated).toBe(false);
  });

  it('does not flag a result that came back short of its own LIMIT', () => {
    const result = executeQuery('SELECT n, label FROM probe_rows WHERE n <= 10 ORDER BY n LIMIT 25');
    expect(result.rowCount).toBe(10);
    expect(result.truncated).toBe(false);
  });

  it('carries the caller-supplied parameters into the probe', () => {
    // If the probe ran without them it would throw, and the fail-closed branch would
    // report truncation — so the `false` here is what proves the binding, not the
    // `true`. Both are asserted because only the pair distinguishes the two paths.
    const dropped = executeQuery('SELECT n FROM probe_rows WHERE n > ? ORDER BY n LIMIT 25', { params: [0] });
    expect(dropped.rowCount).toBe(25);
    expect(dropped.truncated).toBe(true);

    const complete = executeQuery('SELECT n FROM probe_rows WHERE n > ? ORDER BY n LIMIT 25', { params: [5] });
    expect(complete.rowCount).toBe(25);
    expect(complete.truncated).toBe(false);
  });

  it('reads the row bound out of LIMIT … OFFSET … rather than the offset', () => {
    // Rows 21-25 of 30: five more follow.
    const dropped = executeQuery('SELECT n FROM probe_rows ORDER BY n LIMIT 5 OFFSET 20');
    expect(dropped.rows.map((row) => row[0])).toEqual([21, 22, 23, 24, 25]);
    expect(dropped.truncated).toBe(true);

    // Rows 26-30 of 30: the window ends where the table does.
    const complete = executeQuery('SELECT n FROM probe_rows ORDER BY n LIMIT 5 OFFSET 25');
    expect(complete.rows.map((row) => row[0])).toEqual([26, 27, 28, 29, 30]);
    expect(complete.truncated).toBe(false);
  });

  it('reads the row bound out of the comma form, where the first number is the offset', () => {
    const dropped = executeQuery('SELECT n FROM probe_rows ORDER BY n LIMIT 20, 5');
    expect(dropped.rows.map((row) => row[0])).toEqual([21, 22, 23, 24, 25]);
    expect(dropped.truncated).toBe(true);

    const complete = executeQuery('SELECT n FROM probe_rows ORDER BY n LIMIT 25, 5');
    expect(complete.rowCount).toBe(5);
    expect(complete.truncated).toBe(false);
  });

  it('leaves an aggregate with no LIMIT alone', () => {
    // A COUNT returns one row and carries no bound. Nothing was dropped, and the
    // probe must not run — the count itself is the complete answer.
    const result = executeQuery('SELECT COUNT(*) AS matches FROM probe_rows');
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]?.[0]).toBe(ROWS);
    expect(result.truncated).toBe(false);
  });

  it('still reports the executor row cap, which is a different bound', () => {
    const capped = executeQuery('SELECT n FROM probe_rows ORDER BY n', { maxRows: 10 });
    expect(capped.rowCount).toBe(10);
    expect(capped.truncated).toBe(true);

    const uncapped = executeQuery('SELECT n FROM probe_rows ORDER BY n');
    expect(uncapped.rowCount).toBe(ROWS);
    expect(uncapped.truncated).toBe(false);
    // The cap is far above any limit the compiler can emit (MAX_LIMIT is 200),
    // which is precisely why it could never be the bound that fired.
    expect(MAX_ROWS).toBeGreaterThan(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. The structured reading describes the statement it sits under
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The page's guard, restated.
 *
 * `/investgpt` is a client component and this suite runs in vitest's `node`
 * environment with no DOM, so the predicate is duplicated here and applied to real
 * compiler output. The source assertion below is what stops the two drifting apart:
 * it fails if the chips are ever rendered unguarded again.
 */
const ORDERS_ROWS = /\border\s+by\b/i;
const LIMITS_ROWS = /\blimit\b/i;

describe('the InvestGPT structured reading only names clauses the statement carries', () => {
  it('a count question compiles to a statement with neither clause, while its plan keeps both', () => {
    const compiled = compileQuestion('How many mid cap healthcare stocks are bullish?');
    expect(compiled.plan.intent).toBe('count');

    // The plan is the compiler's reading of the *question*; it populates an ordering
    // and a limit whether or not the emitted statement uses them. That is the trap
    // the page fell into.
    expect(compiled.plan.orderBy).not.toBeNull();
    expect(compiled.plan.limit).toBeGreaterThan(0);

    expect(ORDERS_ROWS.test(compiled.sql)).toBe(false);
    expect(LIMITS_ROWS.test(compiled.sql)).toBe(false);
  });

  it('a list question compiles to a statement carrying both, so both chips still render', () => {
    const compiled = compileQuestion('bearish names with market cap over 50');
    expect(compiled.plan.intent).toBe('list');
    expect(ORDERS_ROWS.test(compiled.sql)).toBe(true);
    expect(LIMITS_ROWS.test(compiled.sql)).toBe(true);
  });

  it('the page gates the chips on the statement rather than rendering them unconditionally', () => {
    const page = source('src/app/investgpt/page.tsx');
    expect(page).toContain("const statementOrdersRows = result !== null && /\\border\\s+by\\b/i.test(result.sql);");
    expect(page).toContain("const statementLimitsRows = result !== null && /\\blimit\\b/i.test(result.sql);");
    expect(page).toContain('{statementOrdersRows || statementLimitsRows ? (');
    // The ROWS tile no longer names the executor's cap as the cause, because the
    // statement's own LIMIT is the bound that fires in practice.
    expect(page).not.toContain('Truncated by the row cap');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. "Consumer Discretionary" is a sector, not an advisory claim
// ─────────────────────────────────────────────────────────────────────────────

/** The opening sentence of every 10-K risk section in the corpus, sector substituted. */
function riskSentence(sector: string): string {
  return `Our results are subject to fluctuations in demand within the ${sector} sector, and a downturn would reduce revenue and compress margin.`;
}

function filing(text: string, documentId: string): Evidence {
  return { citationIndex: 0, text, sourceType: 'filing', documentId };
}

/** The body of `platform-regulatory-status`, the only document a regulatory claim grounds against. */
const PLATFORM_STATUS = [
  'This platform operates as a publisher of impersonal, non-individualised market analysis and does not provide investment advice.',
  'Analysis is generated and published on a uniform schedule to all subscribers and is not tailored to any recipient, their holdings, their objectives or their circumstances.',
  'No output constitutes a recommendation to buy or sell any security. Position sizing, order parameters and the decision to transact rest entirely with the user.',
  'The platform does not exercise discretion over any account and cannot originate an order: every order is transmitted only in response to a physical user action.',
].join(' ');

describe('claim classification keys on advisory scope, not on a shared word stem', () => {
  it('classifies a sector risk factor as an entity attribute whichever sector it names', () => {
    for (const sector of ['consumer discretionary', 'communication services', 'technology', 'health care']) {
      expect(classifyClaim(riskSentence(sector))).toBe('entity_attribute');
    }
  });

  it('grounds a Consumer Discretionary sentence against the filing it was copied from', () => {
    const sentence = riskSentence('consumer discretionary');
    const result = groundAnswer(sentence, [filing(sentence, 'AMZN-10k-2025-risk')]);

    const claim = result.claims[0];
    expect(claim?.category).toBe('entity_attribute');
    expect(claim?.verified).toBe(true);
    expect(claim?.citationIndex).toBe(0);
    expect(result.groundingScore).toBe(1);
  });

  it('grades two sentences differing only in the sector noun identically', () => {
    // This is the contradiction the research page displayed: character-identical
    // templates, one verified at 100% and one unsupported at 66.7%, with the
    // supporting passage visible in the citation panel of both.
    const discretionary = groundAnswer(riskSentence('consumer discretionary'), [
      filing(riskSentence('consumer discretionary'), 'AMZN-10k-2025-risk'),
    ]);
    const communications = groundAnswer(riskSentence('communication services'), [
      filing(riskSentence('communication services'), 'GOOGL-10k-2025-risk'),
    ]);

    expect(discretionary.claims[0]?.category).toBe(communications.claims[0]?.category);
    expect(discretionary.groundingScore).toBe(communications.groundingScore);
  });

  it('leaves a buyback disclosure to the filing that made it', () => {
    // The other sentence the bare adjective swept up: a company saying its own
    // repurchases are at its discretion is not a claim about this service.
    const sentence = 'Repurchases are discretionary and may be suspended at any time.';
    expect(classifyClaim(sentence)).not.toBe('regulatory');
    expect(groundAnswer(sentence, [filing(sentence, 'AMZN-10k-2025-buyback')]).groundingScore).toBe(1);
  });

  it('still routes a real advisory-scope claim to the platform-status verifier', () => {
    const advisory = [
      'The platform does not exercise discretion over any account and cannot originate an order.',
      'We never accept discretionary authority over a client account.',
      'The service does not manage a discretionary account for any subscriber.',
      'Analysis is not tailored to any recipient.',
      'No output constitutes a recommendation to buy or sell any security.',
    ];
    for (const sentence of advisory) expect(classifyClaim(sentence)).toBe('regulatory');
  });

  it('still refuses to ground an advisory claim against a company filing', () => {
    const sentence = 'The platform does not exercise discretion over any account and cannot originate an order.';

    const authoritative = groundAnswer(sentence, [
      { citationIndex: 0, text: PLATFORM_STATUS, sourceType: 'platform_statement', documentId: 'platform-regulatory-status' },
    ]);
    expect(authoritative.claims[0]?.verified).toBe(true);

    // The same words in a 10-K are not evidence about this service, and the
    // narrowed term list must not have loosened that.
    const impostor = groundAnswer(sentence, [filing(PLATFORM_STATUS, 'AMZN-10k-2025-risk')]);
    expect(impostor.claims[0]?.category).toBe('regulatory');
    expect(impostor.claims[0]?.verified).toBe(false);
  });

  it('keeps the qualifying noun on every discretion term', () => {
    // The defect was a bare adjective. Nothing on the list may match "Consumer
    // Discretionary" on its own again, and the platform's own status document —
    // which says "discretion over", never "discretionary" — proves the adjective
    // was grounding nothing anyway.
    const ground = source('src/lib/rag/ground.ts');
    const terms = /const REGULATORY_TERMS = \[([\s\S]*?)\];/.exec(ground)?.[1] ?? '';
    expect(terms).not.toBe('');
    for (const term of terms.matchAll(/'([^']+)'/g)) {
      expect(riskSentence('consumer discretionary')).not.toContain(term[1]);
    }
    expect(PLATFORM_STATUS.toLowerCase()).not.toContain('discretionary');
  });
});
