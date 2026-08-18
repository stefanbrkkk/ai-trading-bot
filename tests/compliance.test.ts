/**
 * The compliance surface: disclosure integrity and the narrative engine's guards.
 *
 * These tests treat the *copy* as a contract. Several strings on this platform have
 * to appear verbatim — a rejection message, a disclosure block, an acceptance
 * label — because their wording is the compliance artefact, not a presentation
 * detail. A test that only checked "some message is shown" would let a helpful
 * rewrite quietly void the thing the message exists to establish.
 *
 * The strongest tests in the file are the two exhaustive ones: every narrative
 * template the engine can emit — the per-driver sentences, and the executive thesis
 * and counter-thesis composed from them — is run through the platform's own
 * prohibited-phrase checker. That closes the loop between "we forbid advisory
 * language" and "our own output does not contain it", which is otherwise an
 * assertion nobody verifies. The thesis pair sat outside that loop for a while:
 * the tests below composed both and then asserted only on wording and direction,
 * so the two sentences at the top of every attribution panel were the one narrative
 * surface no compliance assertion ran over.
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
  composeCounterThesis,
  composeGenericNarrative,
  composePublicationNotice,
  composeThesis,
  findProhibitedCopy,
  hydrateTemplate,
  translateExplanation,
} from '@/lib/engine/narrative';
import { FEATURE_DEFINITIONS } from '@/lib/engine/features';
import type { FeatureState } from '@/lib/engine/features';
import type { ShapExplanation } from '@/lib/quant/shap';

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
        for (const supports of [true, false] as const) {
          for (const signal of ['long', 'short'] as const) {
            const sentence = composeGenericNarrative(definition, band, 1.25, 12, supports, signal);
            const first = sentence.charAt(0);
            expect(/[A-Z0-9]/.test(first), `${definition.key}/${band.state}/${supports}: ${sentence}`).toBe(true);
            expect(sentence.endsWith('.'), sentence).toBe(true);
            expect(findProhibitedCopy(sentence), sentence).toHaveLength(0);
          }
        }
      }
    }
  });
});

/**
 * The narrative's direction convention, which used to have two of them.
 *
 * `composeThesis` and `composeCounterThesis` read a driver as supporting when
 * its SHAP value agrees with the *published direction*; the per-driver sentence
 * read it as supporting whenever the SHAP value was positive. Those coincide for
 * a long signal and invert for a short, so every short published a counter-thesis
 * that named a driver as its strongest opponent and then, in the next sentence,
 * credited that same driver with driving the thesis.
 */
describe('narrative direction is signal-relative', () => {
  /*
   * Real registry keys, taken from the registry, so the translator resolves a
   * definition and produces a composed sentence rather than the unmapped
   * fallback. Two positive and two negative SHAP values, so both signal
   * directions have something supporting and something opposing.
   */
  const featureNames = FEATURE_DEFINITIONS.slice(0, 4).map((d) => d.key);
  const values = [0.9, -0.7, 0.3, -0.2];
  const explanation: ShapExplanation = {
    values,
    baseValue: 0,
    rawPrediction: values.reduce((a, b) => a + b, 0),
    probability: 0.57,
    featureNames,
    featureValues: FEATURE_DEFINITIONS.slice(0, 4).map((d) => d.states[0]?.max ?? 1),
  };

  for (const signalDirection of ['long', 'short'] as const) {
    it(`agrees with itself on a ${signalDirection} signal`, () => {
      const drivers = translateExplanation(explanation, { signalDirection });
      const thesis = composeThesis('TEST', drivers, signalDirection, 62);
      const counter = composeCounterThesis(drivers, signalDirection);

      const supporting = drivers.filter((d) => d.supports);
      const opposing = drivers.filter((d) => !d.supports);
      expect(supporting.length, 'some driver supports').toBeGreaterThan(0);
      expect(opposing.length, 'some driver opposes').toBeGreaterThan(0);

      // `supports` must match the convention the thesis composer uses.
      for (const d of drivers) {
        expect(d.supports, `${d.featureKey} shap=${d.shap}`).toBe(
          signalDirection === 'long' ? d.shap >= 0 : d.shap < 0,
        );
      }

      // The driver the counter-thesis names must not also be credited with
      // driving the conviction. That contradiction is the defect under test.
      const named = opposing[0];
      expect(named, 'counter-thesis has a subject').toBeDefined();
      expect(counter).toContain('opposing');
      expect(named?.narrative).toContain('headwind');
      expect(named?.narrative).not.toContain('conviction is driven by');

      // And the driver the thesis leads with must read as supporting.
      const lead = supporting[0];
      expect(lead?.narrative).toContain('conviction is driven by');
      expect(lead?.narrative).not.toContain('headwind');
      expect(thesis).toContain('led by');
    });
  }

  it('claims no stance at all on a flat signal', () => {
    /*
     * A flat signal publishes "the model holds no directional conviction".
     * The per-driver sentences used to sit underneath that saying "46% of this
     * bullish conviction is driven by …", because 'flat' was collapsed to 'long'
     * before the stance word was chosen. About a third of the universe publishes
     * flat on a given day.
     */
    const flat = translateExplanation(explanation, { signalDirection: 'flat' });
    expect(flat.length).toBeGreaterThan(0);
    for (const d of flat) {
      expect(d.narrative, d.featureKey).not.toContain('bullish');
      expect(d.narrative, d.featureKey).not.toContain('bearish');
      expect(d.narrative, d.featureKey).not.toContain('conviction');
      expect(d.narrative, d.featureKey).not.toContain('headwind');
      expect(d.narrative, d.featureKey).toContain('total attribution');
      // And it still says which way the driver pushed the model.
      expect(/pushes (the model's probability up|it down)/.test(d.narrative), d.narrative).toBe(true);
    }
    // A verbatim matrix row asserts a stance, so none may be used on a flat signal.
    expect(flat.every((d) => !d.fromMatrix)).toBe(true);
  });

  it('uses the stance word that matches the published direction', () => {
    const short = translateExplanation(explanation, { signalDirection: 'short' });
    const supporting = short.find((d) => d.supports);
    expect(supporting?.narrative).toContain('bearish conviction');
    const long = translateExplanation(explanation, { signalDirection: 'long' });
    expect(long.find((d) => d.supports)?.narrative).toContain('bullish conviction');
  });

  /**
   * The two composed sentences, over every state band of every feature.
   *
   * `composeThesis` and `composeCounterThesis` are live emitters — `pipeline.ts`
   * calls both for every attribution panel — and their sentences are assembled
   * from a template of their own, not from the per-driver narrative the test above
   * checks. Neither calls `assertCompliantCopy`, so nothing at runtime reads them
   * either. Their literal copy ("led by …, reinforced by …", "The strongest
   * opposing driver is …, subtracting …% of total attribution") was clean when
   * this was written; the point is that it stays clean when someone edits it.
   *
   * Every shape the pair can emit is exercised here: both composers over each band
   * of each feature in all three published directions, the two-supporting-driver
   * form that adds the "reinforced by" clause, and the three degenerate branches —
   * a flat signal, an empty driver list, and a driver list with nothing opposing.
   * `composeThesis`'s "no single dominant driver" line is the one literal not
   * covered, because it is unreachable: the empty-list guard above it returns
   * first, so `drivers[0]` is always defined by the time that branch is tested.
   */
  it('emits no prohibited language in any thesis or counter-thesis', () => {
    /** A value that lands inside the band, so `resolveState` returns this one. */
    const inBand = (band: FeatureState): number => {
      if (!Number.isFinite(band.min) && !Number.isFinite(band.max)) return 0;
      if (!Number.isFinite(band.min)) return band.max - 1;
      if (!Number.isFinite(band.max)) return band.min + 1;
      return (band.min + band.max) / 2;
    };

    const compose = (
      names: readonly string[],
      vals: readonly number[],
      shap: readonly number[],
      direction: 'long' | 'short' | 'flat',
    ): { thesis: string; counter: string } => {
      const drivers = translateExplanation(
        {
          values: [...shap],
          baseValue: 0,
          rawPrediction: shap.reduce((a, b) => a + b, 0),
          probability: 0.55,
          featureNames: [...names],
          featureValues: [...vals],
        },
        { signalDirection: direction },
      );
      return {
        thesis: composeThesis('TEST', drivers, direction, 62),
        counter: composeCounterThesis(drivers, direction),
      };
    };

    for (const definition of FEATURE_DEFINITIONS) {
      // A second driver carrying the opposite SHAP sign, so both a supporting and
      // an opposing driver exist whichever direction is published: the feature
      // under test leads the thesis on one direction and the counter-thesis on
      // the other, and both templates see every one of its bands.
      const foil = FEATURE_DEFINITIONS.find((d) => d.key !== definition.key);
      expect(foil, 'the registry holds more than one feature').toBeDefined();
      if (foil === undefined) continue;
      const foilBand = foil.states[0];
      if (foilBand === undefined) continue;

      for (const band of definition.states) {
        const names = [definition.key, foil.key];
        const vals = [inBand(band), inBand(foilBand)];
        for (const direction of ['long', 'short', 'flat'] as const) {
          const { thesis, counter } = compose(names, vals, [0.9, -0.7], direction);
          expect(findProhibitedCopy(thesis), thesis).toHaveLength(0);
          expect(findProhibitedCopy(counter), counter).toHaveLength(0);
        }
      }
    }

    const first = FEATURE_DEFINITIONS[0];
    const second = FEATURE_DEFINITIONS[1];
    expect(first, 'registry is populated').toBeDefined();
    expect(second, 'registry holds a second feature').toBeDefined();
    if (first === undefined || second === undefined) return;
    const pair = [first.key, second.key];
    const pairValues = [inBand(first.states[0] as FeatureState), inBand(second.states[0] as FeatureState)];

    // Two drivers on the same side: the thesis takes its "reinforced by" form and
    // the counter-thesis takes the branch where nothing opposes at all.
    const both = compose(pair, pairValues, [0.9, 0.5], 'long');
    expect(both.thesis).toContain('reinforced by');
    expect(both.counter).toContain('No material driver currently opposes');
    expect(findProhibitedCopy(both.thesis), both.thesis).toHaveLength(0);
    expect(findProhibitedCopy(both.counter), both.counter).toHaveLength(0);

    // A flat signal claims no stance in either sentence.
    const flat = compose(pair, pairValues, [0.9, -0.7], 'flat');
    expect(flat.thesis).toContain('no directional conviction');
    expect(flat.counter).toContain('No opposing driver is material');
    expect(findProhibitedCopy(flat.thesis), flat.thesis).toHaveLength(0);
    expect(findProhibitedCopy(flat.counter), flat.counter).toHaveLength(0);

    // And the empty-driver branches, which a symbol with no attributions reaches.
    for (const direction of ['long', 'short', 'flat'] as const) {
      const thesis = composeThesis('TEST', [], direction, 0);
      const counter = composeCounterThesis([], direction);
      expect(thesis).toContain('no directional conviction');
      expect(findProhibitedCopy(thesis), thesis).toHaveLength(0);
      expect(findProhibitedCopy(counter), counter).toHaveLength(0);
    }
  });
});
