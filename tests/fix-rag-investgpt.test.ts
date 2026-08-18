/**
 * Regressions for the research pipeline and the InvestGPT compiler.
 *
 * Every block below pins a defect where the platform told a user something
 * confidently and wrongly, and where every surface on the page agreed with the
 * wrong version — which is the failure mode this codebase is built to make
 * impossible, and therefore the only one worth writing tests against.
 *
 *   • A grounding tile reporting "100.0% — 5 of 5 claims verified" over an answer
 *     of six sentences, because the sixth was never graded.
 *   • A six-citation, fully-grounded answer about semiconductor revenue in reply
 *     to a question about a 2021 Federal Reserve meeting.
 *   • `optionable = 1` emitted for "which names are not optionable?", with the
 *     SQL, the plan, the readback and the rows all agreeing.
 *   • A quoted source span beginning two characters into a word.
 *
 * The assertions are on the property that was violated — the claim list covers
 * the answer, lexical evidence is necessary, a negated question compiles to the
 * complement — rather than on recorded output, which the broken versions would
 * have satisfied just as well.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { splitSentences, tokenise } from '@/lib/ai/deterministic';
import { answerableFromEvidence, ask, chunksFromMemory, groundAnswer, type Evidence } from '@/lib/rag';
import { hasRelevantEvidence, retrieve } from '@/lib/rag/retrieve';
import { compileQuestion } from '@/lib/investgpt/compile';
import { validateSql } from '@/lib/investgpt/validate';
import { CATALOG, TABLES } from '@/lib/investgpt/catalog';

const NOW = Date.UTC(2026, 7, 14, 20, 0, 0);
const CHUNKS = chunksFromMemory(NOW);

// ─────────────────────────────────────────────────────────────────────────────
//  Claim grading covers the answer
// ─────────────────────────────────────────────────────────────────────────────

const GROSS_MARGIN_EVIDENCE: Evidence[] = [
  {
    citationIndex: 0,
    text: 'Gross margin was 51.6% for the quarter. Management reiterated full-year guidance with a revision of -2.5% at the midpoint.',
    sourceType: 'earnings_transcript',
    documentId: 'ACME-transcript-2026-Q3',
  },
  {
    citationIndex: 1,
    text: 'Cash and equivalents plus short-term investments totalled $16.13 billion at fiscal year end.',
    sourceType: 'sec_10k',
    documentId: 'ACME-10k-2026',
  },
];

describe('claim grading covers every sentence the reader is shown', () => {
  /**
   * The gate used to be `tokenise(sentence).length < 4`, which sounds like it
   * excludes connectives and in fact excluded assertions: `tokenise` drops stop
   * words, so all three of these are three content terms.
   */
  it('does not skip the shortest, most quotable assertions', () => {
    for (const sentence of ['Gross margin was 51.6%.', 'Cutting my NVDA position.', 'We face intense competition.']) {
      expect(tokenise(sentence).length, sentence).toBeLessThan(4);
      expect(tokenise(sentence).length, sentence).toBeGreaterThan(0);
    }
  });

  it('grades the sentence that answers the question rather than dropping it', () => {
    const answer =
      'Gross margin was 51.6%. [1] Management reiterated full-year guidance with a revision of -2.5% at the midpoint. [1] Cash and equivalents plus short-term investments totalled $16.13 billion at fiscal year end. [2]';
    const { claims, groundingScore } = groundAnswer(answer, GROSS_MARGIN_EVIDENCE);

    const graded = claims.find((claim) => claim.text.startsWith('Gross margin was'));
    expect(graded).toBeDefined();
    expect(graded?.category).toBe('numerical');
    expect(graded?.verified).toBe(true);
    expect(graded?.citationIndex).toBe(0);
    expect(groundingScore).toBe(1);
  });

  it('reports a denominator that equals the number of sentences on screen', () => {
    const answer =
      'Gross margin was 51.6%. [1] Management reiterated full-year guidance with a revision of -2.5% at the midpoint. [1] Cash and equivalents plus short-term investments totalled $16.13 billion at fiscal year end. [2]';
    const { claims } = groundAnswer(answer, GROSS_MARGIN_EVIDENCE);
    // This is the number the research page renders as "N of M claims verified".
    expect(claims.length).toBe(splitSentences(answer).length);
    expect(claims.length).toBe(3);
  });

  it('still skips fragments with nothing to grade', () => {
    // A bare marker left behind by sentence splitting, and a sentence that is
    // entirely stop words, are not claims and must not enter the denominator.
    const { claims } = groundAnswer('[1] It was.', GROSS_MARGIN_EVIDENCE);
    expect(claims).toHaveLength(0);
  });

  it('keeps the claim list aligned with the answer on the real corpus', async () => {
    for (const question of [
      'What did management say about gross margin guidance?',
      'What was NVDA revenue last quarter?',
      'What are the main risk factors disclosed?',
    ]) {
      const result = await ask(question, { now: NOW });
      expect(result.citations.length, question).toBeGreaterThan(0);
      expect(result.claims.length, question).toBe(splitSentences(result.answer).length);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Retrieval scope: lexical evidence is necessary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Off-topic questions long enough to accumulate dense similarity.
 *
 * The four short questions in `tests/rag.test.ts` all fall below the dense floor
 * as well as the lexical one, so they never exercised the OR arm. These do: each
 * scores below 5.0 on BM25 and at or above 0.42 on the dense channel, and each
 * came back as a six-citation, 100%-grounded answer before the gate demanded
 * lexical evidence.
 */
const LONG_FORM_OUT_OF_SCOPE = [
  'What did the Federal Reserve decide at its March 2021 meeting?',
  'What was the closing price of Bitcoin on 3 March 1997 and who won the 1962 Kentucky Derby?',
  'What is the weather today in Lisbon and should I take an umbrella?',
  'Who won the world cup in 1998 and what was the score?',
];

const IN_SCOPE = [
  'What did Apple report for revenue last quarter?',
  'What are the risks disclosed for NVDA?',
  'Can this platform place trades on my behalf or give me advice?',
  'What is insider activity at TSLA?',
  'What did management say about gross margin guidance?',
  'What is the current volatility regime across the index?',
  'Has any insider bought shares recently?',
  'What are the main risk factors disclosed?',
];

describe('retrieval scope demands lexical evidence', () => {
  it('refuses long-form off-topic questions that clear the dense floor', () => {
    for (const question of LONG_FORM_OUT_OF_SCOPE) {
      const { trace } = retrieve(CHUNKS, question, {});
      expect(answerableFromEvidence(trace), question).toBe(false);
    }
  });

  it('exercises the arm that was broken, not just the one that already worked', () => {
    // At least one of these must be a question the old predicate accepted;
    // otherwise this block would pass against the defect it exists to pin.
    const acceptedByTheOldRule = LONG_FORM_OUT_OF_SCOPE.filter(
      (question) => hasRelevantEvidence(retrieve(CHUNKS, question, {}).trace),
    );
    expect(acceptedByTheOldRule.length).toBeGreaterThan(0);
  });

  it('keeps answering everything the corpus genuinely covers', () => {
    for (const question of IN_SCOPE) {
      const { trace } = retrieve(CHUNKS, question, {});
      expect(answerableFromEvidence(trace), question).toBe(true);
    }
  });

  it('cannot be satisfied by the dense channel alone', () => {
    /**
     * The dense populations overlap completely on this corpus, so no threshold
     * separates them and the channel cannot be a sufficient condition for
     * anything. This asserts the overlap directly: if it ever disappears, the
     * reasoning in `answerableFromEvidence` needs revisiting rather than the
     * gate silently becoming stricter than it needs to be.
     */
    const offTopic = LONG_FORM_OUT_OF_SCOPE.map((q) => retrieve(CHUNKS, q, {}).trace.bestDense);
    const onTopic = IN_SCOPE.map((q) => retrieve(CHUNKS, q, {}).trace.bestDense);
    expect(Math.max(...offTopic)).toBeGreaterThan(Math.min(...onTopic));
  });

  it('answers an unanswerable question with a refusal, not with unrelated prose', async () => {
    const result = await ask('What did the Federal Reserve decide at its March 2021 meeting?', { now: NOW });
    expect(result.citations).toHaveLength(0);
    expect(result.claims).toHaveLength(0);
    expect(result.answer).toContain('No passage in the corpus addresses this question');
    // The refusal says which floor was missed, so it reads as a scope decision.
    expect(result.notes.join(' ')).toContain('relevance floor');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  The compiler does not invert a negated question
// ─────────────────────────────────────────────────────────────────────────────

describe('negation compiles to the complement', () => {
  it('does not screen for the set the question excluded', () => {
    const optionable = compileQuestion('Which names are not optionable?');
    expect(optionable.sql).toContain('optionable = 0');
    expect(optionable.sql).not.toContain('optionable = 1');
    expect(optionable.plan.filters.some((f) => f.column === 'optionable' && f.value === 'false')).toBe(true);

    const sector = compileQuestion('Which stocks are not in the Technology sector?');
    expect(sector.sql).toContain('sector NOT IN');
    expect(sector.plan.filters.some((f) => f.column === 'sector' && f.operator === 'NOT IN')).toBe(true);

    const direction = compileQuestion('stocks that are not bullish');
    expect(direction.plan.filters.some((f) => f.column === 'direction' && f.operator === '!=')).toBe(true);
    expect(direction.sql).not.toMatch(/AND direction = \?/);
  });

  it('reads the negators the numeric comparator table already recognised', () => {
    // 'excluding' is a != comparator for numbers; it must not select a sector.
    const excluding = compileQuestion('Show me names excluding the Technology sector');
    expect(excluding.sql).toContain('sector NOT IN');

    // 'not greater than' was inverted because only 'not above' was tabulated.
    const notGreater = compileQuestion('conviction not greater than 60');
    expect(notGreater.plan.filters.some((f) => f.column === 'conviction' && f.operator === '<=')).toBe(true);
    // The two phrasings the table already handled must not double-negate.
    const notBelow = compileQuestion('conviction not below 60');
    expect(notBelow.plan.filters.some((f) => f.column === 'conviction' && f.operator === '>=')).toBe(true);
  });

  it('negates the state band and the cap bucket too', () => {
    const band = compileQuestion('names that are not oversold');
    expect(band.plan.filters.some((f) => f.column === 'rsi_14' && f.operator === 'outside band')).toBe(true);
    expect(band.sql).toContain('NOT (rsi_14 >=');

    const bucket = compileQuestion('names that are not large cap');
    expect(bucket.plan.filters.some((f) => f.column === 'market_cap' && f.operator === 'outside band')).toBe(true);
    expect(bucket.sql).toContain('NOT (market_cap >=');
  });

  it('partitions tickers named on both sides of a negation', () => {
    const compiled = compileQuestion('AAPL and MSFT but not NVDA');
    expect(compiled.sql).toContain('symbol IN (?, ?)');
    expect(compiled.sql).toContain('symbol NOT IN (?)');
    expect(compiled.params).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });

  it('binds the negation to the word it governs, not to the nearest phrase', () => {
    /**
     * A proximity window would read this as a negated *sector*. The sector is
     * asserted, the RSI band is the thing being excluded, and reading it the
     * other way would swap one silent misreading for another.
     */
    const compiled = compileQuestion('names that are not oversold in the technology sector');
    expect(compiled.plan.filters.some((f) => f.column === 'sector' && f.operator === 'IN')).toBe(true);
    expect(compiled.plan.filters.some((f) => f.column === 'rsi_14' && f.operator === 'outside band')).toBe(true);
  });

  it('leaves an unnegated question exactly as it was', () => {
    for (const [question, fragment] of [
      ['Which optionable large cap names have a 25 delta risk reversal below -2?', 'optionable = 1'],
      ['Which stocks are in the Technology sector?', 'sector IN (?)'],
      ['bullish healthcare stocks', 'direction = ?'],
      ['Stocks in a mean reverting regime where the OU z-score is below -2', 'regime = ?'],
      ['Show me the most oversold technology stocks with conviction above 55', 'rsi_14 >= ?'],
    ] as const) {
      expect(compileQuestion(question).sql, question).toContain(fragment);
    }
  });

  it('says in notes what it inverted, so the reading is checkable', () => {
    const notes = compileQuestion('Which names are not optionable?').notes.join(' ');
    expect(notes).toContain('not optionable');
  });

  it('still emits SQL its own validator accepts', () => {
    for (const question of [
      'Which names are not optionable?',
      'Which stocks are not in the Technology sector?',
      'stocks that are not bullish',
      'Which names are not in a mean reverting regime?',
      'names that are not oversold',
      'names that are not large cap',
      'conviction not greater than 60',
      'AAPL and MSFT but not NVDA',
      'Show me names excluding the Technology sector',
    ]) {
      const compiled = compileQuestion(question);
      const result = validateSql(compiled.sql);
      expect(result.valid, `${question} → ${compiled.sql}\n${JSON.stringify(result.issues)}`).toBe(true);
    }
  });

  it('does not drop a nullable column’s unknown rows from a negated filter', () => {
    // `direction != 'long'` is false, not true, for a symbol with no signal, so
    // "bullish" and "not bullish" would not partition the universe.
    const compiled = compileQuestion('stocks that are not bullish');
    expect(compiled.sql).toContain('direction IS NULL OR');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  The quoted source span is a phrase
// ─────────────────────────────────────────────────────────────────────────────

describe('the structured reading quotes the claim, not the regex match', () => {
  it('starts a numeric filter’s source span on a word boundary', () => {
    const compiled = compileQuestion('Which optionable large cap names have a 25 delta risk reversal below -2?');
    const filter = compiled.plan.filters.find((candidate) => candidate.column === 'rr25_30d');
    expect(filter).toBeDefined();
    expect(filter?.source).toBe('25 delta risk reversal below -2');
  });

  it('quotes a span that occurs verbatim in the question, for every filter', () => {
    for (const question of [
      'Which optionable large cap names have a 25 delta risk reversal below -2?',
      'Show me the most oversold technology stocks with conviction above 55',
      'Bearish energy names with market cap over 50',
      'Names where RSI (14) is under 30 sorted by ATR percent ascending',
    ]) {
      const compiled = compileQuestion(question);
      for (const filter of compiled.plan.filters) {
        // Label sources ("sector reference") are deliberate; a quoted span must
        // be text the user actually typed.
        if (!question.toLowerCase().includes(filter.source.toLowerCase())) continue;
        const at = question.toLowerCase().indexOf(filter.source.toLowerCase());
        const before = question[at - 1] ?? ' ';
        expect(/[\s(]/.test(before), `${question} → "${filter.source}"`).toBe(true);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  The pruner's docstring describes the catalog it has
// ─────────────────────────────────────────────────────────────────────────────

describe('the pruner documents the real catalog', () => {
  it('states the surface count and relation count the code derives', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/lib/investgpt/prune.ts', import.meta.url)), 'utf8');
    const header = source.slice(0, source.indexOf('*/'));
    expect(header).toContain(String(CATALOG.length));
    expect(header).toContain('four relations');
    expect(TABLES.length).toBe(4);
    // The figure the docstring quotes is the one the report publishes.
    expect(CATALOG.length).toBe(829);
  });
});
