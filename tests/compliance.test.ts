/**
 * The compliance surface: disclosure integrity and the narrative engine's guards.
 *
 * These tests treat the *copy* as a contract. Several strings on this platform have
 * to appear verbatim — a rejection message, a disclosure block, an acceptance
 * label — because their wording is the compliance artefact, not a presentation
 * detail. A test that only checked "some message is shown" would let a helpful
 * rewrite quietly void the thing the message exists to establish.
 *
 * The strongest test in the file is the last one: every narrative template the
 * engine can emit is run through the platform's own prohibited-phrase checker. That
 * closes the loop between "we forbid advisory language" and "our own output does
 * not contain it", which is otherwise an assertion nobody verifies.
 */

import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_LABEL,
  DISCLOSURE_BLOCKS,
  ERROR_COPY,
  LIABILITY_CAP_MONTHS,
  MANDATORY_AUDIT_FIELDS,
  PRIVACY_POLICY_SECTIONS,
  PROHIBITED_COPY_EXAMPLES,
  TOS_CLAUSES,
  disclosureBundle,
} from '@/lib/compliance/disclosures';
import {
  INSTITUTIONAL_MAPPING_MATRIX,
  INSUFFICIENT_DATA_THESIS,
  NEUTRALITY_NOTICE,
  PROHIBITED_PHRASES,
  assertCompliantCopy,
  composeGenericNarrative,
  composePublicationNotice,
  findProhibitedCopy,
  hydrateTemplate,
} from '@/lib/engine/narrative';
import { FEATURE_DEFINITIONS } from '@/lib/engine/features';

describe('disclosure bundle', () => {
  it('publishes every required block with substantive body text', () => {
    expect(DISCLOSURE_BLOCKS.length).toBeGreaterThanOrEqual(4);
    for (const block of DISCLOSURE_BLOCKS) {
      expect(block.id, block.id).toMatch(/^[a-z_]+$/);
      expect(block.title.length, block.id).toBeGreaterThan(5);
      // A one-line placeholder would satisfy a naive length check; 80 characters is
      // the floor for a disclosure that actually discloses something.
      expect(block.body.length, block.id).toBeGreaterThan(80);
    }
  });

  it('includes the four named disclosures', () => {
    const ids = DISCLOSURE_BLOCKS.map((b) => b.id);
    expect(ids).toContain('publisher_status');
    expect(ids).toContain('ai_error');
    expect(ids).toContain('total_loss');
    expect(ids).toContain('neutral_tool');
  });

  it('states the publisher position and disclaims fiduciary duty', () => {
    const publisher = DISCLOSURE_BLOCKS.find((b) => b.id === 'publisher_status');
    expect(publisher).toBeDefined();
    const body = (publisher?.body ?? '').toLowerCase();
    // These are the load-bearing terms of the Lowe v. SEC position.
    expect(body).toMatch(/publisher|impersonal/);
    expect(body).toMatch(/not.*(adviser|advisor|fiduciary)/);
  });

  it('discloses the possibility of total loss', () => {
    const loss = DISCLOSURE_BLOCKS.find((b) => b.id === 'total_loss');
    // Title and body together, because the block says "catastrophic loss", "can go
    // to zero" and "100% of the financial risk" rather than the literal phrase.
    // What matters is that the possibility is stated, not which words state it.
    const text = `${loss?.title ?? ''} ${loss?.body ?? ''}`.toLowerCase();
    expect(text).toMatch(/total loss|catastrophic|go to zero|100% of the financial risk/);
  });

  it('publishes versioned terms, privacy and risk disclosures', () => {
    const bundle = disclosureBundle();
    for (const version of [bundle.tosVersion, bundle.privacyVersion, bundle.riskDisclosuresVersion]) {
      // A date-shaped version is what makes "which document did you accept"
      // answerable from an acceptance record.
      expect(version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(bundle.blocks).toEqual(DISCLOSURE_BLOCKS);
    expect(bundle.liabilityCapMonths).toBe(LIABILITY_CAP_MONTHS);
  });

  it('publishes terms clauses covering the structural limits', () => {
    const ids = TOS_CLAUSES.map((c) => c.id);
    expect(ids).toContain('not_an_adviser');
    expect(ids).toContain('no_discretion');
    expect(ids).toContain('no_position_sizing');
    expect(ids).toContain('liability_cap');
    for (const clause of TOS_CLAUSES) {
      expect(clause.body.length, clause.id).toBeGreaterThan(60);
    }
  });

  it('caps liability at a bounded number of months', () => {
    expect(LIABILITY_CAP_MONTHS).toBeGreaterThan(0);
    expect(LIABILITY_CAP_MONTHS).toBeLessThanOrEqual(24);
  });

  it('has an acceptance label that names what is being accepted', () => {
    expect(ACCEPTANCE_LABEL.length).toBeGreaterThan(40);
    const lower = ACCEPTANCE_LABEL.toLowerCase();
    expect(lower).toMatch(/risk|loss/);
    expect(lower).toMatch(/terms|agree/);
  });

  it('lists the six mandatory audit fields with a stated purpose', () => {
    expect(MANDATORY_AUDIT_FIELDS.length).toBeGreaterThanOrEqual(6);
    const joined = MANDATORY_AUDIT_FIELDS.map((f) => f.field.toLowerCase()).join(' | ');
    // Click coordinates are the field that distinguishes a human gesture from
    // automation, and are the one most easily omitted.
    expect(joined).toMatch(/click/);
    expect(joined).toMatch(/timestamp/);
    expect(joined).toMatch(/ip address/);
    for (const field of MANDATORY_AUDIT_FIELDS) {
      expect(field.purpose.length, field.field).toBeGreaterThan(20);
    }
  });

  it('states in the privacy policy what is NOT collected', () => {
    const titles = PRIVACY_POLICY_SECTIONS.map((s) => s.title.toLowerCase());
    // The negative statement is the one that matters here: holdings are not
    // ingested for analysis, and saying so is what makes the claim checkable.
    expect(titles.some((t) => t.includes('not'))).toBe(true);
  });

  it('publishes the mandated error copy verbatim', () => {
    // These strings are quoted in the mandate; a friendlier rewrite would void it.
    expect(ERROR_COPY.insufficientFunds).toBe('Insufficient Funds / Margin Limit Exceeded');
    expect(ERROR_COPY.brokerError).toBe('Broker API Error');
  });
});

describe('prohibited copy', () => {
  it('publishes each forbidden phrase with a reason', () => {
    expect(PROHIBITED_COPY_EXAMPLES.length).toBeGreaterThanOrEqual(4);
    for (const entry of PROHIBITED_COPY_EXAMPLES) {
      expect(entry.phrase.length, entry.phrase).toBeGreaterThan(5);
      expect(entry.reason.length, entry.phrase).toBeGreaterThan(15);
    }
  });

  it('names the Weiss Research control', () => {
    // Automating the published picks is the exact conduct that drew enforcement.
    const joined = PROHIBITED_COPY_EXAMPLES.map((e) => `${e.phrase} ${e.reason}`).join(' ');
    expect(joined).toMatch(/Weiss/i);
  });

  it('detects a recommendation', () => {
    const findings = findProhibitedCopy('We recommend you buy AAPL at the open.');
    expect(findings.length).toBeGreaterThan(0);
  });

  it('detects individualised advice', () => {
    expect(findProhibitedCopy('This is perfectly suited for your portfolio.').length).toBeGreaterThan(0);
  });

  it('detects an automation offer', () => {
    expect(findProhibitedCopy('Automatically trade the daily Top 5 picks.').length).toBeGreaterThan(0);
  });

  it('passes compliant descriptive copy', () => {
    const clean =
      'RSI (14) at 27.4 places the security in its published oversold band, which historically precedes a reversion over a five-day horizon.';
    expect(findProhibitedCopy(clean)).toHaveLength(0);
    expect(() => assertCompliantCopy(clean, 'test')).not.toThrow();
  });

  it('throws on non-compliant copy, naming the context', () => {
    expect(() => assertCompliantCopy('We recommend you buy X', 'unit-test-context')).toThrow(/unit-test-context/);
  });

  it('keeps a non-empty deny-list', () => {
    expect(PROHIBITED_PHRASES.length).toBeGreaterThan(3);
  });
});

describe('narrative engine', () => {
  it('hydrates a template without leaving a placeholder behind', () => {
    for (const entry of Object.values(INSTITUTIONAL_MAPPING_MATRIX)) {
      const hydrated = hydrateTemplate(entry.template, 42, 27.4);
      // An unreplaced {pct} or {val} reaching a user is a visible defect and a sign
      // the matrix and the hydrator have diverged.
      expect(hydrated, entry.template).not.toMatch(/\{[a-z]+\}/);
      // The percentage is rendered as a whole number — a share of attribution is
      // not meaningful to a decimal place — so a whole input is used here.
      expect(hydrated).toContain('42');
      // Not every template quotes the feature's value: the alt-data template states
      // a share of conviction and nothing else, so {val} is genuinely absent.
      if (entry.template.includes('{val}')) expect(hydrated).toContain('27.4');
    }
  });

  it('emits no prohibited language from any template in the matrix', () => {
    /**
     * The closing of the loop: every sentence the deterministic engine can produce
     * is checked against the platform's own deny-list, across a range of
     * percentages and values. Without this, "we forbid advisory language" and "our
     * output contains none" are two unconnected claims.
     */
    for (const [key, entry] of Object.entries(INSTITUTIONAL_MAPPING_MATRIX)) {
      for (const [pct, val] of [
        [5, 0],
        [42.5, 27.4],
        [99.9, -3.2],
      ] as const) {
        const hydrated = hydrateTemplate(entry.template, pct, val);
        expect(findProhibitedCopy(hydrated), `${key}: ${hydrated}`).toHaveLength(0);
      }
    }
  });

  it('publishes a neutrality notice that disclaims recommendation', () => {
    expect(NEUTRALITY_NOTICE.length).toBeGreaterThan(80);
    const lower = NEUTRALITY_NOTICE.toLowerCase();
    expect(lower).toMatch(/not.*(advice|recommendation)/);
    expect(findProhibitedCopy(NEUTRALITY_NOTICE)).toHaveLength(0);
  });

  it('frames the publication notice impersonally and names the symbols', () => {
    const notice = composePublicationNotice(['AAPL', 'MSFT', 'NVDA']);
    expect(notice).toContain('AAPL');
    expect(notice).toContain('NVDA');
    expect(findProhibitedCopy(notice)).toHaveLength(0);
  });

  it('has an insufficient-evidence thesis that asserts nothing', () => {
    expect(INSUFFICIENT_DATA_THESIS.length).toBeGreaterThan(40);
    expect(findProhibitedCopy(INSUFFICIENT_DATA_THESIS)).toHaveLength(0);
  });
});

describe('feature registry integrity', () => {
  it('gives every feature a unique key and SQL column', () => {
    const keys = new Set<string>();
    const columns = new Set<string>();
    for (const definition of FEATURE_DEFINITIONS) {
      expect(keys.has(definition.key), definition.key).toBe(false);
      expect(columns.has(definition.sqlColumn), definition.sqlColumn).toBe(false);
      keys.add(definition.key);
      columns.add(definition.sqlColumn);
    }
    expect(keys.size).toBeGreaterThan(70);
  });

  it('gives every feature a formula and a description', () => {
    for (const definition of FEATURE_DEFINITIONS) {
      // The model card renders the formula verbatim, so an empty one is a hole in
      // the transparency claim rather than a cosmetic gap.
      expect(definition.formula.length, definition.key).toBeGreaterThan(3);
      expect(definition.description.length, definition.key).toBeGreaterThan(20);
      expect(definition.label.length, definition.key).toBeGreaterThan(1);
      expect(definition.shortLabel.length, definition.key).toBeLessThanOrEqual(18);
    }
  });

  it('gives every feature contiguous, ordered state bands covering the real line', () => {
    for (const definition of FEATURE_DEFINITIONS) {
      const states = definition.states;
      expect(states.length, definition.key).toBeGreaterThan(0);
      // The first band must open at −∞ and the last must close at +∞, or some value
      // falls through and the discretisation has no answer for it.
      expect(states[0]?.min, definition.key).toBe(-Infinity);
      expect(states[states.length - 1]?.max, definition.key).toBe(Infinity);

      for (let i = 0; i < states.length; i += 1) {
        const band = states[i];
        if (band === undefined) continue;
        expect(band.min, `${definition.key}/${band.state}`).toBeLessThan(band.max);
        if (i > 0) {
          // Contiguous: each band starts exactly where the previous ended, so there
          // is no gap and no overlap.
          expect(band.min, `${definition.key}/${band.state}`).toBe(states[i - 1]?.max);
        }
        // Digits are legitimate in a state name (STATE_NEAR_52W_HIGH).
        expect(band.state, definition.key).toMatch(/^STATE_[A-Z0-9_]+$/);
        expect(band.predicate.length, band.state).toBeGreaterThan(5);
      }
    }
  });

  it('assigns every state a polarity from the published set', () => {
    for (const definition of FEATURE_DEFINITIONS) {
      for (const band of definition.states) {
        expect(['bullish', 'bearish', 'neutral'], `${definition.key}/${band.state}`).toContain(band.polarity);
      }
    }
  });

  it('emits no prohibited language in any state implication', () => {
    for (const definition of FEATURE_DEFINITIONS) {
      for (const band of definition.states) {
        expect(findProhibitedCopy(band.implication), `${definition.key}/${band.state}`).toHaveLength(0);
        expect(findProhibitedCopy(band.predicate), `${definition.key}/${band.state}`).toHaveLength(0);
      }
    }
  });

  it('emits no prohibited language in any feature description', () => {
    for (const definition of FEATURE_DEFINITIONS) {
      expect(findProhibitedCopy(definition.description), definition.key).toHaveLength(0);
    }
  });

  it('writes every generic sentence as a sentence', () => {
    /**
     * Both composed shapes, over every state of every feature, in both signal
     * directions.
     *
     * The opposing shape used to capitalise `^an? ` — which handles "a dislocation
     * above fair value" and nothing else, so the 130-odd predicates that open with
     * an adjective produced "bearish retail chatter (Social sentiment at -1.000)
     * acts as a 3% headwind…" in the attribution table, lowercase, beside eleven
     * correctly capitalised sentences.
     */
    for (const definition of FEATURE_DEFINITIONS) {
      for (const band of definition.states) {
        for (const direction of ['positive', 'negative'] as const) {
          for (const signal of ['long', 'short'] as const) {
            const sentence = composeGenericNarrative(definition, band, 1.25, 12, direction, signal);
            const first = sentence.charAt(0);
            expect(/[A-Z0-9]/.test(first), `${definition.key}/${band.state}/${direction}: ${sentence}`).toBe(true);
            expect(sentence.endsWith('.'), sentence).toBe(true);
            expect(findProhibitedCopy(sentence), sentence).toHaveLength(0);
          }
        }
      }
    }
  });
});
