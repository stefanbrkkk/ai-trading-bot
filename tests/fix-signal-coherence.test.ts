/**
 * Signal coherence: the platform saying one thing about one number.
 *
 * Every case here is a contradiction that shipped — two surfaces of the product
 * publishing different values for the same quantity, or one sentence arguing
 * against itself. They are grouped by the claim each one restores:
 *
 *   1. the store answers with the numbers the live engine computes;
 *   2. a published direction agrees with the probability published beside it;
 *   3. a signal with no direction publishes no trade plan;
 *   4. a driver sentence's frame agrees with the words it is built from;
 *   5. the conviction score is described as what it is;
 *   6. the publication is stamped with the instant it was evaluated at;
 *   7. the sequence barrier's counter means what its comment says;
 *   8. no comment writes the feature-vector width out as a literal.
 *
 * The suite runs against a scratch data directory so nothing here writes to
 * `.data/`. `models/` and `artefacts/` are symlinked in from the real one where
 * they exist, so the sweep-level assertions run on the seeded ensemble locally
 * and skip on a clone that has not been seeded — the database is created fresh
 * inside the scratch directory either way, which is what the persistence cases
 * need.
 */

import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRATCH_DATA = mkdtempSync(join(tmpdir(), 'aurelius-coherence-'));
for (const dir of ['models', 'artefacts']) {
  const source = join(resolve('.data'), dir);
  if (existsSync(source)) symlinkSync(source, join(SCRATCH_DATA, dir), 'dir');
}
// Must be set before anything resolves the data directory, hence the dynamic
// imports below — the db client and the model store both read it at first use.
process.env.AURELIUS_DATA_DIR = SCRATCH_DATA;

const { closeDb, getDb } = await import('@/lib/db/client');
const { persistUniverseSnapshot } = await import('@/lib/engine/persist');
const { publishedLevels, fuseConviction, resolveDirection, signalId } = await import(
  '@/lib/engine/pipeline'
);
const {
  attributionContestsState,
  composeGenericNarrative,
  translateExplanation,
} = await import('@/lib/engine/narrative');
const { HierarchicalStateClock, macroRegimeDistribution } = await import('@/lib/engine/router');
const { AGENT_DISCRIMINATION_FLOOR, MODEL_LIMITATIONS } = await import('@/lib/engine/model');
const { FEATURE_DEFINITIONS, MODEL_FEATURE_COUNT, MODEL_FEATURE_KEYS, resolveState } = await import(
  '@/lib/engine/features'
);
const { tryLoadModelBundle } = await import('@/lib/engine/store');
const { getPublication, getUniverseSnapshot } = await import('@/lib/engine/service');

import type { FeatureValue, Signal, SignalDirection } from '@/lib/domain/types';
import type { RouterAction } from '@/lib/engine/router';
import type { UniverseSnapshot } from '@/lib/engine/service';
import type { ShapExplanation } from '@/lib/quant/shap';

afterAll(() => {
  closeDb();
  rmSync(SCRATCH_DATA, { recursive: true, force: true });
});

/** The sweep-level cases need a trained ensemble; the rest do not. */
const seeded = tryLoadModelBundle() !== null;
const withEngine = seeded ? it : it.skip;

let sweep: UniverseSnapshot | null = null;
async function universe(): Promise<UniverseSnapshot> {
  sweep ??= await getUniverseSnapshot();
  return sweep;
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. The store answers with the numbers the live engine computes
// ─────────────────────────────────────────────────────────────────────────────

function featureValue(key: string, value: number): FeatureValue {
  const definition = FEATURE_DEFINITIONS.find((d) => d.key === key);
  if (!definition) throw new Error(`no such feature: ${key}`);
  return {
    key,
    label: definition.label,
    group: definition.group,
    value,
    normalised: 0.5,
    unit: definition.unit,
    state: resolveState(definition, value).state,
  };
}

function stubSignal(symbol: string, at: number, over: Partial<Signal> = {}): Signal {
  return {
    id: signalId(symbol, at),
    symbol,
    generatedAt: at,
    direction: 'long',
    conviction: 11.1,
    probability: 0.61,
    horizonDays: 5,
    expectedReturn: 0.01,
    expectedReturnLow: 0,
    expectedReturnHigh: 0.02,
    referencePrice: 100,
    levels: { entryZoneLow: 99, entryZoneHigh: 101, invalidation: 96, target1: 105, target2: 110 },
    strategy: null,
    strategiesFired: [],
    regime: 'low_volatility_drift',
    drivers: [],
    agents: [],
    features: [featureValue('rsi_14', 55)],
    thesis: 'Stub.',
    counterThesis: 'Stub.',
    latency: { stages: [], totalMs: 1, budgetMs: 150, withinBudget: true },
    attributionResidual: 0,
    modelVersion: 'test-1.0.0',
    ...over,
  };
}

function snapshotOf(signals: Signal[], computedAt: number): UniverseSnapshot {
  return {
    rows: [],
    signals,
    features: [],
    computedAt,
    provider: 'simulator',
    modelVersion: 'test-1.0.0',
  };
}

function storedSignal(symbol: string): { direction: string; conviction: number } {
  const row = getDb()
    .prepare('SELECT direction, conviction FROM v_signal_latest WHERE symbol = ?')
    .get(symbol);
  if (row === undefined) throw new Error(`no stored signal for ${symbol}`);
  return { direction: String(row['direction']), conviction: Number(row['conviction']) };
}

describe('the persisted snapshot is the one the engine just computed', () => {
  /*
   * `persistUniverseSnapshot` used to skip the whole write whenever the store
   * already held a vintage at or after the evaluation instant. That instant is
   * the last completed session close, so it stops moving for a whole trading
   * day, while the sweep behind it also depends on the model and on the code —
   * and the equality branch of `stored >= asOf` made the first write of a day
   * permanent. On the shipped store that left 59 of 67 convictions, 16 of 67
   * directions and all 67 prices disagreeing between InvestGPT, which compiles
   * against this table, and the screener beside it.
   */
  const AS_OF = Date.UTC(2026, 7, 17, 20, 0, 0);

  it('rewrites a vintage at the same instant when the sweep behind it has changed', async () => {
    const first = await persistUniverseSnapshot(snapshotOf([stubSignal('AAPL', AS_OF)], AS_OF));
    expect(first.written).toBe(true);
    expect(storedSignal('AAPL')).toEqual({ direction: 'long', conviction: 11.1 });

    const second = await persistUniverseSnapshot(
      snapshotOf([stubSignal('AAPL', AS_OF, { direction: 'short', conviction: 44.4 })], AS_OF),
    );
    expect(second.written, 'the equal-instant write is not skipped').toBe(true);
    expect(storedSignal('AAPL')).toEqual({ direction: 'short', conviction: 44.4 });
  });

  it('keeps an earlier vintage beside the new one', async () => {
    const earlier = Date.UTC(2026, 7, 14, 20, 0, 0);
    await persistUniverseSnapshot(snapshotOf([stubSignal('MSFT', earlier)], earlier));
    await persistUniverseSnapshot(
      snapshotOf([stubSignal('MSFT', AS_OF, { conviction: 22.2 })], AS_OF),
    );
    const vintages = getDb()
      .prepare('SELECT DISTINCT as_of FROM feature_values WHERE symbol = ? ORDER BY as_of')
      .all('MSFT')
      .map((row) => Number(row['as_of']));
    expect(vintages, '"what did you believe on the 14th" stays answerable').toEqual([
      earlier,
      AS_OF,
    ]);
  });

  it('reports nothing written only when there was nothing to write', async () => {
    const empty = await persistUniverseSnapshot(snapshotOf([], AS_OF));
    expect(empty).toEqual({ written: false, asOf: AS_OF, signals: 0, quotes: 0 });
  });

  withEngine('publishes every swept signal into the relation InvestGPT queries', async () => {
    const snapshot = await universe();
    await persistUniverseSnapshot(snapshot);
    const rows = getDb()
      .prepare('SELECT symbol, direction, conviction, price FROM v_equity_snapshot')
      .all();
    const stored = new Map(rows.map((row) => [String(row['symbol']), row]));
    for (const signal of snapshot.signals) {
      const row = stored.get(signal.symbol);
      expect(row, `${signal.symbol} is missing from v_equity_snapshot`).toBeDefined();
      expect(String(row?.['direction']), signal.symbol).toBe(signal.direction);
      expect(Number(row?.['conviction']), signal.symbol).toBeCloseTo(signal.conviction, 10);
      expect(Number(row?.['price']), signal.symbol).toBeCloseTo(signal.referencePrice, 10);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. A published direction agrees with the probability published beside it
// ─────────────────────────────────────────────────────────────────────────────

describe('the tree model vetoes a router verdict it disagrees with', () => {
  /*
   * The router used to be unconditionally authoritative on direction, so four
   * rows published a side against their own probability: LULU short at 42.4%,
   * GS short at 43.5%, MA short at 43.8%, SPG long at 43.1%. `Signal.probability`
   * is the probability the *published position* beats the benchmark, so each of
   * those advertised a trade the platform's own number said would not work.
   */
  const grid = [0, 0.2, 0.43, 0.4999, 0.5, 0.5001, 0.56, 0.8, 1];

  it('never lets a directional verdict publish against the model', () => {
    for (const probability of grid) {
      expect(resolveDirection({ action: 'EXECUTE_LONG' }, probability)).toBe(
        probability >= 0.5 ? 'long' : 'flat',
      );
      expect(resolveDirection({ action: 'EXECUTE_SHORT' }, probability)).toBe(
        probability <= 0.5 ? 'short' : 'flat',
      );
    }
  });

  it('leaves the non-directional verdicts and the noise floor alone', () => {
    const flatActions: RouterAction[] = ['ABORT_TOXIC_FLOW', 'SKIP', 'NEUTRAL'];
    for (const action of flatActions) {
      for (const probability of grid) {
        expect(resolveDirection({ action }, probability)).toBe('flat');
      }
    }
    expect(resolveDirection({ action: 'HOLD' }, 0.56)).toBe('long');
    expect(resolveDirection({ action: 'HOLD' }, 0.55)).toBe('flat');
    expect(resolveDirection({ action: 'HOLD' }, 0.44)).toBe('short');
    expect(resolveDirection({ action: 'HOLD' }, 0.45)).toBe('flat');
  });

  withEngine('publishes no directional signal below a coin flip', async () => {
    const snapshot = await universe();
    const offending = snapshot.signals
      .filter((s) => s.direction !== 'flat' && s.probability < 0.5)
      .map((s) => `${s.symbol} ${s.direction} ${s.probability.toFixed(4)}`);
    expect(offending).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. A signal with no direction publishes no trade plan
// ─────────────────────────────────────────────────────────────────────────────

describe('a flat signal publishes no trade plan', () => {
  /*
   * `defaultLevels` derived its sign as `direction === 'short' ? -1 : 1`, which
   * reads 'flat' as long, and the call site had no flat branch. Every flat name
   * therefore published a complete bullish plan: BAC at a reference 31.41 with
   * invalidation 30.28, T1 33.11 (+5.4%) and T2 34.43 (+9.6%), under a FLAT badge
   * and an expected return of +0.00%.
   */
  const PRICE = 31.41;
  const ATR = 0.72;
  const STRATEGY = { entryZoneLow: 1, entryZoneHigh: 2, invalidation: 3, target1: 4, target2: 5 };

  it('collapses the directional levels onto the reference price', () => {
    const levels = publishedLevels('flat', PRICE, ATR, null);
    expect(levels.invalidation).toBe(PRICE);
    expect(levels.target1).toBe(PRICE);
    expect(levels.target2).toBe(PRICE);
    expect(levels.entryZoneLow).toBeLessThan(PRICE);
    expect(levels.entryZoneHigh).toBeGreaterThan(PRICE);
  });

  it('does not adopt a strategy plan for a direction it did not publish', () => {
    expect(publishedLevels('flat', PRICE, ATR, STRATEGY)).toEqual(
      publishedLevels('flat', PRICE, ATR, null),
    );
    expect(publishedLevels('long', PRICE, ATR, STRATEGY)).toEqual(STRATEGY);
  });

  it('still shapes a directional plan around its own side', () => {
    const long = publishedLevels('long', PRICE, ATR, null);
    expect(long.invalidation).toBeLessThan(PRICE);
    expect(long.target1).toBeGreaterThan(PRICE);
    const short = publishedLevels('short', PRICE, ATR, null);
    expect(short.invalidation).toBeGreaterThan(PRICE);
    expect(short.target1).toBeLessThan(PRICE);
  });

  withEngine('publishes no directional plan on any flat name in the universe', async () => {
    const snapshot = await universe();
    const flat = snapshot.signals.filter((s) => s.direction === 'flat');
    expect(flat.length, 'the sweep has flat names to check').toBeGreaterThan(0);
    for (const s of flat) {
      expect(s.levels.invalidation, s.symbol).toBe(s.referencePrice);
      expect(s.levels.target1, s.symbol).toBe(s.referencePrice);
      expect(s.levels.target2, s.symbol).toBe(s.referencePrice);
      expect(s.expectedReturn, s.symbol).toBe(0);
    }
  });

  withEngine('never prints directional driver prose under a flat headline', async () => {
    /*
     * The Insufficient Data Protocol used to be applied after the drivers were
     * translated, so a signal it flattened kept its directional sentences: T
     * published FLAT above "3% of this bullish conviction is driven by a primary
     * downtrend". The gate now runs before the translation that reads the
     * direction.
     */
    const snapshot = await universe();
    for (const s of snapshot.signals.filter((x) => x.direction === 'flat')) {
      for (const driver of s.drivers) {
        // A predicate may describe a bearish *state* ("a mildly bearish
        // moving-average stack"); what a flat signal must never do is frame one
        // as driving a conviction it says it does not hold.
        expect(driver.narrative, `${s.symbol}/${driver.featureKey}`).not.toMatch(
          /(bullish|bearish) conviction|headwind/,
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. A driver sentence's frame agrees with the words it is built from
// ─────────────────────────────────────────────────────────────────────────────

const CONTESTED = 'against the way that state normally leans';

describe('a driver sentence never argues against itself', () => {
  /*
   * The frame ("driven by" / "headwind") came from the SHAP sign; the predicate
   * and implication came from the registry's state band. Where the two pointed
   * opposite ways the sentence contradicted itself in place — BA published "3% of
   * this bullish conviction is driven by a primary downtrend (EMA 50/200 spread at
   * −31.05%), a regime in which long setups have materially lower base rates", and
   * MSFT's short credited net institutional *accumulation* with driving a bearish
   * conviction. Measured over one sweep: 107 of 374 polarised driver sentences on
   * 49 of the 54 directional names.
   */
  it('marks every contested pairing, and only those', () => {
    let contestedSeen = 0;
    let agreeingSeen = 0;
    for (const definition of FEATURE_DEFINITIONS) {
      for (const state of definition.states) {
        for (const supports of [true, false] as const) {
          for (const direction of ['long', 'short', 'flat'] as const) {
            const sentence = composeGenericNarrative(definition, state, 1.25, 12, supports, direction);
            const pushesUp = direction === 'short' ? !supports : supports;
            const contested = attributionContestsState(state, pushesUp);
            expect(sentence.includes(CONTESTED), `${definition.key}/${state.state}: ${sentence}`).toBe(
              contested,
            );
            if (contested) contestedSeen += 1;
            else agreeingSeen += 1;
          }
        }
      }
    }
    // Both branches are actually exercised by the registry as it stands.
    expect(contestedSeen).toBeGreaterThan(0);
    expect(agreeingSeen).toBeGreaterThan(0);
  });

  it('reproduces the two sentences the defect was found on', () => {
    const trend = FEATURE_DEFINITIONS.find((d) => d.key === 'ema_50_200_spread');
    expect(trend).toBeDefined();
    const bearBand = trend?.states.find((s) => s.polarity === 'bearish');
    expect(bearBand).toBeDefined();
    if (!trend || !bearBand) return;

    // BA: a bearish trend state credited with driving a bullish conviction.
    const asSupport = composeGenericNarrative(trend, bearBand, -31.05, 3, true, 'long');
    expect(asSupport).toContain('bullish conviction is driven by');
    expect(asSupport).toContain(CONTESTED);

    // MSFT: the same state framed as a headwind on a short it argues for.
    const asHeadwind = composeGenericNarrative(trend, bearBand, -16.42, 3, false, 'short');
    expect(asHeadwind).toContain('headwind');
    expect(asHeadwind).toContain(CONTESTED);

    // And the uncontested pairing keeps the plain shape.
    const agreeing = composeGenericNarrative(trend, bearBand, -16.42, 3, true, 'short');
    expect(agreeing).toContain('bearish conviction is driven by');
    expect(agreeing).not.toContain(CONTESTED);
  });

  it('never hydrates a verbatim matrix row for a contested state', () => {
    /*
     * A matrix row is one fixed string with nowhere to put the qualifying clause,
     * so it would assert the stance flatly. No row is contested today; this is
     * what keeps a hand-edited addition from re-opening the defect.
     */
    const keys = FEATURE_DEFINITIONS.slice(0, 6).map((d) => d.key);
    for (const direction of ['long', 'short'] as const) {
      for (const sign of [1, -1]) {
        const values = keys.map((_, i) => sign * (1 - i * 0.1));
        const explanation: ShapExplanation = {
          values,
          baseValue: 0,
          rawPrediction: values.reduce((a, b) => a + b, 0),
          probability: 0.57,
          featureNames: keys,
          featureValues: FEATURE_DEFINITIONS.slice(0, 6).map((d) => d.states[0]?.max ?? 1),
        };
        for (const driver of translateExplanation(explanation, { signalDirection: direction })) {
          if (!driver.fromMatrix) continue;
          expect(attributionContestsState(resolveStateOf(driver.featureKey, driver.value), driver.shap >= 0)).toBe(
            false,
          );
          expect(driver.narrative).not.toContain(CONTESTED);
        }
      }
    }
  });

  withEngine('marks a contested counter-thesis the same way the driver table does', async () => {
    /*
     * The counter-thesis carries the named driver's implication, so it inherits
     * the same contest: MSFT called a primary downtrend its strongest *opposing*
     * driver and then gave "a regime in which long setups have materially lower
     * base rates" as the reason — an argument for the short it opposes. Nineteen
     * of the forty-six directional counter-theses on one sweep.
     */
    const snapshot = await universe();
    let directional = 0;
    for (const s of snapshot.signals) {
      if (s.direction === 'flat') continue;
      directional += 1;
      const named = s.drivers.filter((d) => (s.direction === 'long' ? d.shap < 0 : d.shap > 0))[0];
      if (!named) continue;
      const contested = attributionContestsState(
        resolveStateOf(named.featureKey, named.value),
        named.shap >= 0,
      );
      expect(s.counterThesis.includes(CONTESTED), `${s.symbol} counter-thesis`).toBe(contested);
    }
    expect(directional).toBeGreaterThan(0);
  });

  withEngine('marks every contested driver on every published signal', async () => {
    const snapshot = await universe();
    let checked = 0;
    for (const s of snapshot.signals) {
      for (const driver of s.drivers) {
        const state = resolveStateOf(driver.featureKey, driver.value);
        const contested = attributionContestsState(state, driver.shap >= 0);
        expect(driver.narrative.includes(CONTESTED), `${s.symbol}/${driver.featureKey}`).toBe(
          contested,
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

function resolveStateOf(featureKey: string, value: number): ReturnType<typeof resolveState> {
  const definition = FEATURE_DEFINITIONS.find((d) => d.key === featureKey);
  if (!definition) throw new Error(`no such feature: ${featureKey}`);
  return resolveState(definition, value);
}

// ─────────────────────────────────────────────────────────────────────────────
//  5. The conviction score is described as what it is
// ─────────────────────────────────────────────────────────────────────────────

describe('the model card describes the conviction score correctly', () => {
  const inputs = (over: Partial<Parameters<typeof fuseConviction>[0]>) => ({
    directionalProbability: 0.5,
    aggregateDirection: 0,
    strategyConviction: 0,
    regimeConfidence: 0.5,
    direction: 'long' as SignalDirection,
    routerAction: 'EXECUTE_LONG' as RouterAction,
    ...over,
  });

  it('is not the probability, and demonstrably so', () => {
    // A near-certain probability with nothing corroborating it scores below a
    // coin flip that everything else agrees with.
    const certain = fuseConviction(inputs({ directionalProbability: 0.99, aggregateDirection: 0.1 }));
    const coinFlip = fuseConviction(
      inputs({ aggregateDirection: 1, strategyConviction: 1, regimeConfidence: 1 }),
    );
    expect(certain).toBeCloseTo(36.3, 6);
    expect(coinFlip).toBeCloseTo(60, 6);
    expect(coinFlip).toBeGreaterThan(certain);
    // And it is zero wherever the router declines a side, whatever the model says.
    expect(fuseConviction(inputs({ directionalProbability: 0.9, direction: 'flat' }))).toBe(0);
    expect(fuseConviction(inputs({ directionalProbability: 0.9, routerAction: 'SKIP' }))).toBe(0);
  });

  it('says so on the card', () => {
    const conviction = MODEL_LIMITATIONS.find((l) => l.includes('conviction score'));
    expect(conviction, 'the card still speaks about the conviction score').toBeDefined();
    expect(conviction).toContain('not a probability');
    expect(conviction).not.toMatch(/conviction score is the modelled probability/);
    // The rendered numbering on /transparency is positional.
    expect(MODEL_LIMITATIONS).toHaveLength(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  6. The publication is stamped with the instant it was evaluated at
// ─────────────────────────────────────────────────────────────────────────────

describe('the publication and the signals in it share one instant', () => {
  /*
   * `publishedAt` was `sessionOpen(now)` — 09:30 ET — while every signal in the
   * list carried the session close. The terminal header announced a publication
   * six and a half hours before its own contents were generated.
   */
  withEngine('stamps the publication at the instant the sweep was evaluated at', async () => {
    const snapshot = await universe();
    const publication = await getPublication();
    expect(publication.publishedAt).toBe(snapshot.computedAt);
    for (const item of publication.items) {
      const signal = snapshot.signals.find((s) => s.symbol === item.symbol);
      expect(signal, item.symbol).toBeDefined();
      expect(signal?.generatedAt, item.symbol).toBe(publication.publishedAt);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  7. The sequence barrier's counter means what its comment says
// ─────────────────────────────────────────────────────────────────────────────

describe('the hierarchical state clock', () => {
  const macro = (p: number) => macroRegimeDistribution(p, 0.5, 0.5);

  it('cannot violate its barrier on the first tick, which is the only tick a request takes', () => {
    const clock = new HierarchicalStateClock();
    const sequence = clock.tick();
    expect(sequence).toBe(0);
    // No 60m/15m publish at all, and it still succeeds: `readMacroForTick`
    // returns early for a required sequence of −1.
    expect(() => clock.publish5m(sequence)).not.toThrow();
    expect(clock.barrierViolations).toBe(0);
  });

  it('enforces the barrier from the second tick onwards', () => {
    const clock = new HierarchicalStateClock();
    clock.tick();
    clock.publish5m(0);
    const second = clock.tick();
    expect(second).toBe(1);
    expect(() => clock.publish5m(second)).toThrow(/sequence barrier not satisfied for tick 1/);
    expect(clock.barrierViolations).toBe(1);

    clock.publish60m(macro(0.6), second - 1);
    clock.publish15m(macro(0.6), second - 1);
    expect(() => clock.publish5m(second)).not.toThrow();
    expect(clock.barrierViolations, 'a satisfied barrier records nothing').toBe(1);
    expect(clock.snapshot().violations).toBe(1);
  });

  withEngine('gives a collapsed agent no weight in the router', async () => {
    const bundle = tryLoadModelBundle();
    expect(bundle).not.toBeNull();
    const discrimination = bundle?.training.discrimination;
    expect(discrimination).toBeDefined();
    if (!discrimination) return;
    // The seeded 60m TFT is below the floor; the comments in pipeline.ts and
    // model.ts describe that state rather than asserting a fixed figure.
    const collapsed = Object.values(discrimination).filter((d) => d < AGENT_DISCRIMINATION_FLOOR);
    expect(collapsed.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  8. No comment writes the feature-vector width out as a literal
// ─────────────────────────────────────────────────────────────────────────────

describe('the feature-vector width lives in one place', () => {
  it('agrees with itself across the registry', () => {
    expect(MODEL_FEATURE_KEYS).toHaveLength(MODEL_FEATURE_COUNT);
    expect(FEATURE_DEFINITIONS.filter((d) => d.inModel)).toHaveLength(MODEL_FEATURE_COUNT);
  });

  it('is not written out as a literal anywhere in the engine', async () => {
    /*
     * Four comments in these files said the model consumes 80 features against a
     * registry of 89 — and one of them contradicted its own header eighty-eight
     * lines further down. Substituting the right number would only have reset the
     * clock on the same defect, so the prose names `MODEL_FEATURE_COUNT` instead
     * and this test keeps a literal from creeping back.
     */
    const files = ['pipeline.ts', 'model.ts', 'narrative.ts', 'service.ts', 'router.ts', 'persist.ts'];
    for (const file of files) {
      const source = await readFile(join('src', 'lib', 'engine', file), 'utf8');
      const literals = source.match(/\b\d+[\s-](?:feature|wide)\b|\ball \d+ features\b/gi) ?? [];
      expect(literals, `${file} writes the vector width out`).toEqual([]);
    }
  });
});
