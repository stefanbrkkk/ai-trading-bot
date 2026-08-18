/**
 * Regressions for the quant core.
 *
 * Each block here pins a defect that shipped, and every one of them was a number
 * a user read rather than an internal slip: an ADF test with no power that made
 * one regime label unreachable, a Hurst estimator that read 0.62 on pure noise,
 * an OU fit publishing equilibria the series had never visited, and a model card
 * describing the ensemble early stopping threw away.
 *
 * The assertions are against the properties the estimators claim — the size of a
 * test under its own null, invariance to a shift that the statistic must not
 * see, the convex hull of the data, the tree count of the served model — rather
 * than against recorded output, which would pass just as reliably on the broken
 * versions that produced it.
 */

import { describe, expect, it } from 'vitest';
import { adfStatistic, diff, hurstExponent, mean, stdev } from '@/lib/quant/stats';
import { fitOu, ouBands, ouZScore } from '@/lib/quant/ou';
import { predictProbability, trainGbdt } from '@/lib/quant/gbdt';
import { localAccuracyError, treeShap } from '@/lib/quant/shap';
import { classifyRegime } from '@/lib/engine/regime';
import { createRng } from '@/lib/quant/rng';

/** A seeded standard-normal stream, so every figure below is reproducible. */
function gauss(seed: string): () => number {
  const rng = createRng(seed);
  return () => rng.normal();
}

/** Driftless random walk — the ADF null and the OU "no reversion" case. */
function randomWalk(n: number, step: number, next: () => number): number[] {
  const out: number[] = [];
  let x = 0;
  for (let i = 0; i < n; i += 1) {
    x += step * next();
    out.push(x);
  }
  return out;
}

/**
 * A discretely sampled OU path with a chosen stationary spread, so the level and
 * the dispersion can be varied independently. That separation is the whole point
 * of the ADF block: the statistic must respond to the second and ignore the
 * first.
 */
function ouPath(n: number, theta: number, level: number, stationarySd: number, next: () => number): number[] {
  const b = Math.exp(-theta);
  const shock = stationarySd * Math.sqrt(1 - b * b);
  const out: number[] = [];
  let x = level;
  for (let i = 0; i < n; i += 1) {
    x = level + (x - level) * b + shock * next();
    out.push(x);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADF — the τ_μ specification
// ─────────────────────────────────────────────────────────────────────────────

describe('adfStatistic', () => {
  it('has the size it is compared at: ~5% rejection at −2.86 under the unit-root null', () => {
    /*
     * The threshold in engine/regime.ts is −2.86, the τ_μ 5% point. Without the
     * constant in the regression the null is the plain τ distribution, whose 5%
     * point is near −1.97, and the shipped test rejected 0.4% of the time — a
     * 5%-labelled test operating at 0.4%, which is why no name in the universe
     * ever cleared it.
     *
     * 1200 driftless random walks at the engine's own window length. The
     * tolerance is wide enough for Monte-Carlo noise at this sample size (the
     * standard error of the rate is ~0.6pp) and far too narrow for the
     * no-constant regression to sneak through.
     */
    const next = gauss('adf-null');
    const trials = 1200;
    let rejected = 0;
    for (let t = 0; t < trials; t += 1) {
      if (adfStatistic(randomWalk(120, 1, next)) < -2.86) rejected += 1;
    }
    expect(rejected / trials).toBeGreaterThan(0.025);
    expect(rejected / trials).toBeLessThan(0.085);
  });

  it('is invariant to the level of the series', () => {
    /*
     * The engine feeds this a log-price spread against the benchmark, which is a
     * level with a median |mean| of about 1.07 log-units. A stationarity test
     * that moves when the whole series is shifted is measuring the level, not
     * the reversion — and the no-constant version moved from −3.3 to +0.3 on
     * this exact path for no reason other than where it sat.
     */
    const next = gauss('adf-shift');
    const centred = ouPath(120, 0.15, 0, 0.06, next);
    const raw = adfStatistic(centred);
    for (const shift of [-1.4, 0.994, 3.632]) {
      expect(adfStatistic(centred.map((v) => v + shift))).toBeCloseTo(raw, 6);
    }
  });

  it('has the same power against reversion wherever the series sits', () => {
    /*
     * Invariance is necessary but not sufficient — a statistic that is always
     * zero is invariant too. This is the power side: OU paths with a 4.6-bar
     * half-life, rejected roughly two times in three at every level tested.
     * The no-constant version rejected 5% at level 0 and 0% at any other level,
     * so both the rate and its flatness across levels are the assertion.
     */
    const next = gauss('adf-power');
    const power = (level: number): number => {
      let rejected = 0;
      for (let t = 0; t < 200; t += 1) {
        if (adfStatistic(ouPath(120, 0.15, level, 0.06, next)) < -2.86) rejected += 1;
      }
      return rejected / 200;
    };
    const atZero = power(0);
    expect(atZero).toBeGreaterThan(0.5);
    for (const level of [-1.4, 0.994, 3.632]) {
      expect(power(level)).toBeGreaterThan(0.5);
      expect(Math.abs(power(level) - atZero)).toBeLessThan(0.15);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Hurst — Anis–Lloyd corrected R/S
// ─────────────────────────────────────────────────────────────────────────────

describe('hurstExponent', () => {
  it('reads 0.5 on iid noise at the window length the engine uses', () => {
    /*
     * The acceptance criterion for the correction. Uncorrected R/S at n = 100
     * returns a mean H of 0.62 with 90% of draws above 0.5, which
     * engine/regime.ts converts into a standing +0.65 vote for "trending" before
     * any data is read. The live distribution of the published `hurst_100` was
     * indistinguishable from this baseline, which is another way of saying it
     * carried no information.
     */
    const next = gauss('hurst-iid');
    const draws: number[] = [];
    for (let t = 0; t < 500; t += 1) {
      draws.push(hurstExponent(Array.from({ length: 100 }, next)));
    }
    expect(mean(draws)).toBeGreaterThan(0.48);
    expect(mean(draws)).toBeLessThan(0.52);
    // Symmetry about 0.5 matters as much as the mean: the old estimator put 90%
    // of its mass on one side while still being nominally "near" 0.5.
    const above = draws.filter((h) => h > 0.5).length / draws.length;
    expect(above).toBeGreaterThan(0.35);
    expect(above).toBeLessThan(0.65);
  });

  it('still separates persistent from anti-persistent series', () => {
    // Removing the bias must not cost the discrimination the estimator is for.
    const next = gauss('hurst-ar1');
    const ar1 = (phi: number): number[] => {
      const out: number[] = [];
      let x = 0;
      for (let i = 0; i < 100; i += 1) {
        x = phi * x + next();
        out.push(x);
      }
      return out;
    };
    const persistent = mean(Array.from({ length: 120 }, () => hurstExponent(ar1(0.7))));
    const antiPersistent = mean(Array.from({ length: 120 }, () => hurstExponent(ar1(-0.7))));
    expect(persistent).toBeGreaterThan(0.6);
    expect(antiPersistent).toBeLessThan(0.4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  The two together: `mean_reverting` has to be a reachable regime
// ─────────────────────────────────────────────────────────────────────────────

describe('regime reachability', () => {
  it('classifies a genuinely mean-reverting spread at a non-zero level as mean_reverting', () => {
    /*
     * The product-level consequence of the two fixes above, and the reason both
     * were blockers. Across all 134 stored signals the `mean_reverting` count
     * was zero: the ADF could not fire on a spread with a level, and the Hurst
     * bias pinned `persistence` at +1 often enough to cancel the ADF where it
     * did. `regimeMultiplier` gives reversion strategies 1.3 in that regime and
     * 0.55–0.6 in the trending ones, so the label was not cosmetic.
     *
     * This fixture is an OU spread with a 4.6-bar half-life sitting at −1.4 log
     * units — unambiguously reverting, unambiguously away from zero. Before the
     * fix it produced adf = +0.311 and hurst = 0.473, landing in the classifier's
     * "neither hypothesis clears its threshold" branch at 0.35 confidence. The
     * confidence assertion is what distinguishes the real classification from
     * that fallback.
     */
    const next = gauss('regime-probe');
    const spread = ouPath(240, 0.15, -1.4, 0.06, next);
    const state = classifyRegime({
      hurst: hurstExponent(diff(spread).slice(-100)),
      adf: adfStatistic(spread.slice(-120)),
      adx: 14,
      diSpread: 0,
      realisedVol: 0.2,
      volPercentile: 0.5,
      liquidityScore: 0.8,
      primaryTrend: 0,
    });
    expect(state.label).toBe('mean_reverting');
    expect(state.confidence).toBeGreaterThan(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  OU — μ̂ has to be somewhere the series could plausibly have come from
// ─────────────────────────────────────────────────────────────────────────────

describe('fitOu equilibrium guard', () => {
  it('never places μ̂ far outside the range the series visited', () => {
    /*
     * μ̂'s closed form is a ratio whose denominator vanishes as θ → 0, and the
     * original |denominator| < 1e-12 guard only caught the exact singularity.
     * On near-unit-root spreads — 14 of the 63 names in the shipped universe —
     * μ̂ landed outside the data entirely: ABBV fitted +0.596 on a series that
     * never left [−1.35, −0.75], and published z = −42.4 as "the highest-
     * conviction reversion state the OU model produces".
     *
     * The bound is the observed range widened by half a span on each side, which
     * is the guard's own contract; see the comment in ou.ts for why the margin
     * is there rather than a bare [min, max].
     */
    const next = gauss('ou-walks');
    for (let t = 0; t < 200; t += 1) {
      const walk = randomWalk(180, 0.01, next);
      const lo = Math.min(...walk);
      const hi = Math.max(...walk);
      const margin = 0.5 * (hi - lo);
      const fit = fitOu(walk, 1);
      expect(fit.mu).toBeGreaterThanOrEqual(lo - margin);
      expect(fit.mu).toBeLessThanOrEqual(hi + margin);
    }
  });

  it('keeps the published z-score and the equilibrium band attached to the data', () => {
    /*
     * The two user-facing consequences of the above. |z| reached 40.1 over this
     * same simulation before the guard, against a stationary Gaussian law that
     * allows 2.5 with probability 1.24%, and `ouBands` returned intervals that
     * did not intersect the series anywhere — ABBV's [0.0825, 1.1095] against
     * data in [−1.35, −0.75], a miss of 1.4 times the span of the data.
     *
     * The band tolerance is a quarter of a span rather than zero because a tight
     * σ_eq combined with a μ̂ legitimately just outside the hull can still leave
     * a hairline gap. Measured over 5000 walks that happens to 0.02% of fits and
     * the worst gap is 0.037 spans, so a quarter-span bound is loose by an order
     * of magnitude here and rejects the shipped case by a factor of five.
     */
    const next = gauss('ou-bands');
    let worstZ = 0;
    for (let t = 0; t < 200; t += 1) {
      const walk = randomWalk(180, 0.01, next);
      const lo = Math.min(...walk);
      const hi = Math.max(...walk);
      const tolerance = 0.25 * (hi - lo);
      const fit = fitOu(walk, 1);
      worstZ = Math.max(worstZ, Math.abs(ouZScore(fit, walk[walk.length - 1] as number)));
      const band = ouBands(fit, 2);
      expect(band.lower).toBeLessThanOrEqual(hi + tolerance);
      expect(band.upper).toBeGreaterThanOrEqual(lo - tolerance);
    }
    expect(worstZ).toBeLessThan(5);
  });

  it('leaves a well-identified fit exactly as the closed form gives it', () => {
    /*
     * The guard must be inert wherever the MLE is identified, otherwise it trades
     * one bias for another. A path simulated from known parameters straddles its
     * own μ, so the range test cannot bind, and the estimate has to be the
     * unmodified closed form.
     */
    const next = gauss('ou-identified');
    const path = ouPath(2000, 0.08, Math.log(150), 0.05, next);
    const fit = fitOu(path, 1);
    expect(fit.mu).toBeCloseTo(Math.log(150), 2);
    expect(fit.mu).toBeGreaterThan(Math.min(...path));
    expect(fit.mu).toBeLessThan(Math.max(...path));
    expect(fit.meanReverting).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GBDT — every diagnostic must describe the ensemble that survived
// ─────────────────────────────────────────────────────────────────────────────

/** Separable-with-noise binary data; feature 0 carries most of the signal. */
function classificationSet(seed: string, rows: number, dims: number): { x: number[][]; y: number[] } {
  const next = gauss(seed);
  const x: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < rows; i += 1) {
    const row = Array.from({ length: dims }, next);
    x.push(row);
    const score = 0.9 * (row[0] as number) + 0.5 * (row[1] as number) - 0.4 * (row[2] as number) + 0.8 * next();
    y.push(score > 0 ? 1 : 0);
  }
  return { x, y };
}

describe('trainGbdt early stopping', () => {
  const train = classificationSet('gbdt-train', 400, 6);
  const valid = classificationSet('gbdt-valid', 200, 6);
  const base = {
    rounds: 80,
    learningRate: 0.15,
    maxDepth: 3,
    minSamplesLeaf: 5,
    bins: 16,
    subsample: 1,
    colsampleByTree: 1,
  };
  const model = trainGbdt(
    train.x,
    train.y,
    { ...base, earlyStoppingRounds: 5, random: createRng('gbdt').next },
    { x: valid.x, y: valid.y },
  );

  it('actually stops early, or the rest of this block proves nothing', () => {
    expect(model.trees.length).toBeGreaterThan(1);
    expect(model.trees.length).toBeLessThan(base.rounds);
  });

  it('reports one history entry per surviving tree', () => {
    /*
     * `engine/model.ts` reads the last history entry for the model card's
     * training and validation loss. With the history left at full length that
     * was the loss of the discarded tail: the shipped card claimed a training
     * loss of 0.5751 (round 111) where the served 92-tree model's was 0.5910 —
     * 2.7% understated, in the flattering direction.
     */
    expect(model.history).toHaveLength(model.trees.length);
    expect(model.history[model.history.length - 1]?.round).toBe(model.trees.length - 1);
  });

  it('publishes the training loss of the ensemble it returns', () => {
    // Recomputed from the returned trees, independently of anything the trainer
    // recorded during the run.
    let acc = 0;
    for (let i = 0; i < train.x.length; i += 1) {
      const p = Math.min(Math.max(predictProbability(model, train.x[i] as number[]), 1e-12), 1 - 1e-12);
      const t = train.y[i] as number;
      acc += -(t * Math.log(p) + (1 - t) * Math.log(1 - p));
    }
    expect(model.history[model.history.length - 1]?.trainLoss).toBeCloseTo(acc / train.x.length, 12);
  });

  it('counts splits only in the trees the model contains', () => {
    /*
     * The shipped 92-tree ensemble recorded 734 splits against 605 real internal
     * nodes — 17.6% of the model card's feature-importance chart belonged to
     * trees that were thrown away. `sector_rel_strength` was credited with 46
     * splits and has 40.
     */
    let internalNodes = 0;
    for (const tree of model.trees) {
      for (const node of tree.nodes) if (node.feature !== -1) internalNodes += 1;
    }
    expect(model.featureSplits.reduce((a, b) => a + b, 0)).toBe(internalNodes);
    // A feature that never split cannot carry gain.
    model.featureSplits.forEach((splits, i) => {
      if (splits === 0) expect(model.featureGain[i]).toBe(0);
    });
  });

  it('matches a run that was told to stop at the same round', () => {
    /*
     * The strongest statement of the contract: truncating after the fact has to
     * be indistinguishable from never having built the extra trees. Same data,
     * same seed, `rounds` set to what early stopping kept — every diagnostic has
     * to agree, not just the tree list.
     */
    const equivalent = trainGbdt(
      train.x,
      train.y,
      { ...base, rounds: model.trees.length, earlyStoppingRounds: 0, random: createRng('gbdt').next },
      { x: valid.x, y: valid.y },
    );
    expect(equivalent.trees).toHaveLength(model.trees.length);
    expect(equivalent.featureSplits).toEqual(model.featureSplits);
    expect(equivalent.featureGain).toEqual(model.featureGain);
    expect(equivalent.history).toEqual(model.history);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  TreeSHAP — the exported entry point, not only the per-tree core
// ─────────────────────────────────────────────────────────────────────────────

describe('treeShap', () => {
  it('satisfies local accuracy on a trained ensemble', () => {
    /*
     * shap.ts claims of `treeShap` that "it satisfies local accuracy exactly:
     * Σφ_i + E[f] = f(x)". tests/quant-core.test.ts checks that identity on
     * `treeShapSingle`, the per-tree core the wrapper loops over, against an
     * exhaustive enumeration of the Shapley definition — but never on the
     * exported wrapper itself, so the docstring was making a claim no test
     * covered. This closes that gap; the maths is covered by the enumeration
     * next door.
     */
    const train = classificationSet('shap-train', 300, 5);
    const model = trainGbdt(train.x, train.y, {
      rounds: 12,
      learningRate: 0.2,
      maxDepth: 3,
      minSamplesLeaf: 5,
      bins: 16,
      subsample: 1,
      colsampleByTree: 1,
      random: createRng('shap').next,
    });
    for (const row of train.x.slice(0, 10)) {
      const explanation = treeShap(model, row);
      expect(localAccuracyError(explanation)).toBeLessThan(1e-9);
      expect(explanation.featureValues).toEqual(row);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Sanity on the helpers this file leans on
// ─────────────────────────────────────────────────────────────────────────────

describe('fixture generators', () => {
  it('produce the dispersion they claim, so the assertions above mean what they say', () => {
    const next = gauss('fixture');
    const path = ouPath(20_000, 0.15, -1.4, 0.06, next);
    expect(mean(path)).toBeCloseTo(-1.4, 2);
    expect(stdev(path)).toBeCloseTo(0.06, 2);
  });
});
