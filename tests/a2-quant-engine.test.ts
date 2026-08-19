/**
 * Quantitative-engine figures that described something other than what happened.
 *
 * Three of these are published numbers or published sentences whose meaning did
 * not survive contact with the values they were computed from; the last two are
 * source comments that a change elsewhere in the repo falsified.
 *
 *   1. Walk-forward efficiency is `outOfSampleSharpe / inSampleSharpe`, and the
 *      whole column is read as "below 1.0 means the in-sample result did not
 *      survive". A negative in-sample Sharpe inverts that reading, and on a
 *      portfolio whose headline Sharpe is negative — which is the one this
 *      platform ships — a losing training window is the normal case. Folds with
 *      nothing to survive now publish no ratio at all, and the scorecard averages
 *      only the ones that have one.
 *   2. The Kalman strategy's rationale quoted the standardised innovation, which
 *      is measured against the filter's *a priori* forecast, as the distance from
 *      the *a posteriori* level printed in the same sentence. The two are never
 *      that far apart: `price − level = (1 − K₀)·ỹ`, so the sentence overstated
 *      the dislocation on every bar it could ever be emitted on.
 *   3. The agent training loops tracked a best validation epoch, stopped on
 *      patience and returned the last epoch's weights, so the "Valid loss" the
 *      model card publishes described a fit that had been trained past.
 *   4. `gbdt.ts` described the importance buffers and the ensemble in the present
 *      tense — "112 × 89 on the shipped model", "the shipped 92-tree ensemble" —
 *      after a retrain had replaced that bundle.
 *   5. `orderflow.ts`'s `vpin` docstring restated `compute.ts`'s bucket depth as
 *      three times mean bar volume; `compute.ts` moved to six and left the
 *      restatement, and its worked example, false by a factor of two.
 *
 * Everything here is synthetic and in-process: no data directory, no market
 * provider, no trained ensemble. The two comment cases follow the approach
 * `tests/a2-engine-comments.test.ts` established — assert that the prose states
 * no figure a retrain or a constant change can falsify, rather than substituting
 * today's value and resetting the clock on the same defect.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKTEST_CONFIG,
  combineScorecard,
  hasDefinedEfficiency,
  computeMetrics,
  walkForwardFolds,
} from '@/lib/engine/backtest';
import { STRATEGY_PARAMS, strategyById, type StrategyContext } from '@/lib/engine/strategies';
import { computeFeatures, type ComputeInput } from '@/lib/engine/compute';
import { kalmanInnovationBands } from '@/lib/quant/kalman';
import { BiLstmAgent, type SequenceSample } from '@/lib/quant/nn';
import { createRng } from '@/lib/quant/rng';
import type { Bar } from '@/lib/quant/indicators';
import type {
  BacktestConfig,
  BacktestResult,
  EquityPoint,
  SymbolMeta,
  WalkForwardFold,
} from '@/lib/domain/types';

const REPO_ROOT = resolve(__dirname, '..');
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2024, 0, 2, 14, 30);

const source = (...parts: string[]): string => readFileSync(join(REPO_ROOT, ...parts), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
//  1. Walk-forward efficiency
// ─────────────────────────────────────────────────────────────────────────────

function config(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    ...DEFAULT_BACKTEST_CONFIG,
    symbols: ['TEST'],
    startTime: T0,
    endTime: T0 + 400 * DAY,
    ...overrides,
  };
}

/** An equity curve that realises `returns` exactly, one point per return plus the base. */
function curveFrom(returns: readonly number[]): EquityPoint[] {
  let equity = 100_000;
  const out: EquityPoint[] = [{ time: T0, equity, drawdown: 0, benchmark: equity, exposure: 0 }];
  returns.forEach((r, i) => {
    equity *= 1 + r;
    out.push({ time: T0 + (i + 1) * DAY, equity, drawdown: 0, benchmark: 100_000, exposure: 0 });
  });
  return out;
}

/** `count` returns alternating between two values — a controlled mean and a non-zero spread. */
function alternating(count: number, a: number, b: number): number[] {
  return Array.from({ length: count }, (_, i) => (i % 2 === 0 ? a : b));
}

/**
 * One fold, with the training window and the test window specified separately.
 *
 * The curve is exactly `trainBars + testBars` points long, so the loop that
 * steps by `testBars` produces a single fold and the fold's two windows are the
 * two return blocks passed in.
 */
function singleFold(trainReturns: readonly number[], testReturns: readonly number[]): WalkForwardFold {
  const trainBars = trainReturns.length + 1;
  const testBars = testReturns.length;
  const folds = walkForwardFolds(
    curveFrom([...trainReturns, ...testReturns]),
    [],
    config({ walkForward: { enabled: true, trainBars, testBars } }),
  );
  expect(folds).toHaveLength(1);
  return folds[0] as WalkForwardFold;
}

function resultWith(folds: WalkForwardFold[]): BacktestResult {
  const cfg = config();
  return {
    id: 'bt_test',
    createdAt: T0,
    config: cfg,
    metrics: computeMetrics([], [], cfg, { exposure: 0, turnover: 0, strategiesTried: 1 }),
    trades: [],
    equityCurve: [],
    byStrategy: [],
    monthlyReturns: [],
    folds,
    warnings: [],
  };
}

describe('walk-forward efficiency', () => {
  it('publishes no ratio for a training window that lost money', () => {
    /*
     * The case the shipped fixture was full of: in-sample negative, out-of-sample
     * strictly worse. Dividing one negative by the other gave a ratio above 1.0,
     * which every surface around it reads as "the in-sample result survived", and
     * /backtest rendered sage.
     */
    const fold = singleFold(alternating(23, -0.01, -0.005), alternating(8, -0.02, -0.015));

    expect(fold.inSampleSharpe).toBeLessThan(0);
    expect(fold.outOfSampleSharpe).toBeLessThan(fold.inSampleSharpe);
    expect(Number.isFinite(fold.efficiency)).toBe(false);
    // The ratio the old code published, for the record: strictly above 1.0.
    expect(fold.outOfSampleSharpe / fold.inSampleSharpe).toBeGreaterThan(1);
  });

  it('publishes no ratio for the fold whose out-of-sample result improved most, either', () => {
    // Negative in sample, strongly positive out of sample — the old ratio came
    // out negative and rendered burgundy, ranking the best fold in the run last.
    const fold = singleFold(alternating(23, -0.01, -0.005), alternating(8, 0.02, 0.015));

    expect(fold.inSampleSharpe).toBeLessThan(0);
    expect(fold.outOfSampleSharpe).toBeGreaterThan(0);
    expect(Number.isFinite(fold.efficiency)).toBe(false);
    expect(fold.outOfSampleSharpe / fold.inSampleSharpe).toBeLessThan(0);
  });

  it('publishes no ratio for a flat training window', () => {
    // `sharpeOfCurve` returns exactly 0 for a curve that never moves. The old
    // near-zero guard published 0.0 for it, which reads as total degradation of
    // an edge that was never measured in the first place.
    const fold = singleFold(new Array<number>(23).fill(0), alternating(8, -0.02, -0.015));

    expect(fold.inSampleSharpe).toBe(0);
    expect(Number.isFinite(fold.efficiency)).toBe(false);
  });

  it('still divides where the training window had an edge to lose', () => {
    const fold = singleFold(alternating(23, 0.01, 0.005), alternating(8, -0.02, -0.015));

    expect(fold.inSampleSharpe).toBeGreaterThan(0);
    expect(fold.efficiency).toBeCloseTo(fold.outOfSampleSharpe / fold.inSampleSharpe, 12);
    // The direction the column claims to carry: worse out of sample reads below 1.
    expect(fold.efficiency).toBeLessThan(1);
  });

  it('gives a defined efficiency the sign of its own out-of-sample Sharpe', () => {
    // With a positive denominator the ratio can no longer disagree with the two
    // raw Sharpe columns printed next to it, which is the whole failure the
    // signed division produced.
    const improved = singleFold(alternating(23, 0.01, 0.005), alternating(8, 0.03, 0.02));
    const degraded = singleFold(alternating(23, 0.01, 0.005), alternating(8, -0.02, -0.015));

    expect(improved.efficiency).toBeGreaterThan(1);
    expect(degraded.efficiency).toBeLessThan(0);
    expect(Math.sign(improved.efficiency)).toBe(Math.sign(improved.outOfSampleSharpe));
    expect(Math.sign(degraded.efficiency)).toBe(Math.sign(degraded.outOfSampleSharpe));
  });
});

describe('the Combine scorecard note', () => {
  const measurable = singleFold(alternating(23, 0.01, 0.005), alternating(8, -0.02, -0.015));
  const undefinedFold = singleFold(alternating(23, -0.01, -0.005), alternating(8, -0.02, -0.015));

  it('averages only the folds that have an efficiency', () => {
    const scorecard = combineScorecard(resultWith([measurable, undefinedFold, undefinedFold]));

    expect(scorecard.meanEfficiency).toBeCloseTo(measurable.efficiency, 12);
    expect(Number.isFinite(scorecard.meanEfficiency)).toBe(true);
    expect(scorecard.note).toContain('1 of 3 folds');
  });

  it('says so plainly when no fold had a positive in-sample Sharpe', () => {
    const scorecard = combineScorecard(resultWith([undefinedFold, undefinedFold]));

    expect(scorecard.meanEfficiency).toBe(0);
    expect(scorecard.note).toMatch(/None of the 2 walk-forward folds/);
    expect(scorecard.note).not.toMatch(/Mean out-of-sample Sharpe efficiency is/);
  });

  it('treats a fixture round-tripped through JSON the same way', () => {
    /*
     * `NaN` does not survive `JSON.stringify` — it becomes `null` — and
     * /api/backtest/run serves the seeded fixture straight off disk, so the
     * scorecard is recomputed from exactly that. `Number.isFinite` rejects both
     * forms; a bare `isNaN`-style guard would not.
     */
    const revived = JSON.parse(JSON.stringify(resultWith([measurable, undefinedFold]))) as BacktestResult;

    expect(revived.folds[1]?.efficiency).toBeNull();
    expect(combineScorecard(revived).meanEfficiency).toBeCloseTo(measurable.efficiency, 12);
    expect(combineScorecard(revived).note).toContain('1 of 2 folds');
  });

  it('rejects a stale fold that still carries the signed ratio', () => {
    /*
     * `.data/` is git-ignored and re-seeded per deployment rather than migrated,
     * so until a deployment re-seeds, /api/backtest/run serves a fixture whose
     * folds were written by the previous build — with the inverted ratio present
     * as an ordinary finite number. The scorecard is recomputed from that
     * fixture on every request, so it rejects the fold on the in-sample Sharpe
     * rather than only on the shape of the value.
     */
    const stale: WalkForwardFold = { ...undefinedFold, efficiency: 1.5404 };

    expect(hasDefinedEfficiency(stale)).toBe(false);
    expect(hasDefinedEfficiency(measurable)).toBe(true);
    expect(combineScorecard(resultWith([measurable, stale])).meanEfficiency).toBeCloseTo(
      measurable.efficiency,
      12,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. The Kalman innovation rationale
// ─────────────────────────────────────────────────────────────────────────────

const META: SymbolMeta = {
  symbol: 'TEST',
  name: 'Test Instrument',
  sector: 'Technology',
  industry: 'Software',
  marketCap: 1e11,
  adv30: 5e6,
  sharesOutstanding: 1e9,
  exchange: 'NASDAQ',
  isBenchmark: false,
  referenceBeta: 1,
  dividendYield: 0,
  optionable: false,
};

function barsFrom(closes: readonly number[]): Bar[] {
  return closes.map((close, i) => {
    const open = i > 0 ? (closes[i - 1] as number) : close;
    return {
      time: T0 + i * DAY,
      open,
      high: Math.max(close, open) * 1.001,
      low: Math.min(close, open) * 0.999,
      close,
      volume: 1_000_000,
    };
  });
}

/**
 * A quiet random walk with one large closing print, which is what puts a big
 * standardised innovation on the last bar: the adaptive R has settled on the
 * quiet stretch, so `√S` for the final step is small relative to the surprise.
 * The 5% jump clears the |z| ≥ 1.5 entry gate while the forecast σ stays inside
 * the strategy's 250bp confidence ceiling.
 */
function dislocatedSeries(): number[] {
  const rng = createRng('kalman-fixture:e');
  const closes: number[] = [];
  let logPrice = Math.log(100);
  for (let i = 0; i < 220; i += 1) {
    logPrice += rng.normal() * 0.015;
    closes.push(Math.exp(logPrice));
  }
  closes[closes.length - 1] = (closes[closes.length - 2] as number) * 1.05;
  return closes;
}

function kalmanContext(closes: readonly number[]): StrategyContext {
  const dailyBars = barsFrom(closes);
  const benchmarkBars = barsFrom(closes.map(() => 100));
  const input: ComputeInput = {
    symbol: 'TEST',
    meta: META,
    dailyBars,
    intradayBars: [],
    benchmarkBars,
    sectorCloses: closes.map(() => 100),
    books: [],
    chains: [],
    altEvents: [],
    now: T0 + closes.length * DAY,
    horizonDays: 5,
  };
  return {
    symbol: 'TEST',
    dailyBars,
    intradayBars: [],
    hourlyBars: [],
    benchmarkBars,
    benchmarkIntradayBars: [],
    features: computeFeatures(input),
    adv30: META.adv30,
    riskReversalHistory: [],
    now: input.now,
  };
}

describe('the Kalman innovation rationale', () => {
  const ctx = kalmanContext(dislocatedSeries());
  const kalman = ctx.features.artefacts.kalman;
  const price = ctx.features.artefacts.price;
  const evaluation = strategyById('kalman_innovation')?.evaluate(ctx);

  it('fires on the fixture, so the sentence under test is the one that ships', () => {
    expect(kalman).not.toBeNull();
    expect(Math.abs(kalman?.z ?? 0)).toBeGreaterThanOrEqual(STRATEGY_PARAMS.kalmanEntryZ);
    expect(evaluation?.fired).toBe(true);
    expect(evaluation?.rationale).toBeTruthy();
  });

  it('quotes a σ distance that the two prices in the same sentence actually have', () => {
    const rationale = evaluation?.rationale ?? '';
    const quoted = /print of \$([\d.]+) missed the filter's one-step-ahead forecast of \$([\d.]+) by ([\d.]+)σ/.exec(
      rationale,
    );
    expect(quoted).not.toBeNull();

    const printed = Number(quoted?.[1]);
    const forecast = Number(quoted?.[2]);
    const sigmas = Number(quoted?.[3]);
    const forecastSigma = kalman?.forecastSigma ?? 0;
    const z = kalman?.z ?? 0;

    // The two quantities the sentence is built from, exactly.
    expect(printed).toBeCloseTo(Number(price.toFixed(2)), 12);
    expect(forecast).toBeCloseTo(Number((price - z * forecastSigma).toFixed(2)), 12);
    expect(sigmas).toBeCloseTo(Number(Math.abs(z).toFixed(2)), 12);

    /*
     * And the claim as a reader can check it, from the three figures on the page
     * and nothing else. The tolerance is the rounding the sentence itself does:
     * a cent on each price, and a hundredth on the σ multiple.
     */
    const asPrinted = Math.abs(printed - forecast) / forecastSigma;
    expect(Math.abs(asPrinted - sigmas)).toBeLessThan(0.01 / forecastSigma + 0.005);
  });

  it('does not claim that distance from the filtered level it prints beside it', () => {
    /*
     * The regression. `level` is the posterior state, which has already absorbed
     * this print, so the print is (1 − K₀)·|z| away from it and never |z|. On this
     * fixture the old sentence claimed roughly five times the true distance.
     */
    const rationale = evaluation?.rationale ?? '';
    const level = kalman?.level ?? 0;
    const forecastSigma = kalman?.forecastSigma ?? 0;
    const trueDistanceFromLevel = Math.abs(price - level) / forecastSigma;

    expect(rationale).not.toMatch(/sits [\d.]+σ from the filtered fair value/);
    expect(trueDistanceFromLevel).toBeLessThan(Math.abs(kalman?.z ?? 0) / 2);
    // The level the sentence does name is the one the first target sits on.
    expect(rationale).toContain(`fair value to $${level.toFixed(2)}`);
    expect(evaluation?.levels?.target1).toBeCloseTo(level, 12);
  });

  it('is an identity, not a fixture accident: the posterior level is always nearer', () => {
    /*
     * With H = [1, 0], `level = x̂⁻₀ + K₀·ỹ` and `ỹ = price − x̂⁻₀`, so
     * `|price − level| = (1 − K₀)·|ỹ|` with K₀ ∈ (0, 1). The a priori distance
     * `|z|` is therefore an upper bound on the distance from the level, on every
     * bar of every series — which is why the old sentence could only ever
     * overstate.
     */
    const closes = dislocatedSeries();
    const series = kalmanInnovationBands(closes, {
      k: 2,
      processNoise: 1e-4,
      measurementNoise: 1e-2,
      adaptiveR: 0.98,
    });

    expect(series).toHaveLength(closes.length);
    series.forEach((point, i) => {
      const distance = Math.abs((closes[i] as number) - point.level) / point.forecastSigma;
      expect(distance).toBeLessThanOrEqual(Math.abs(point.z) + 1e-9);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. Early stopping returns the epoch it stopped for
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Samples whose training targets are learnable and whose validation targets are
 * not: the label is a deterministic function of the sequence on the training
 * split and an independent coin on the validation split. A network with enough
 * capacity therefore improves on training every epoch while validation loss turns
 * upwards early, which is the shape that makes early stopping fire.
 */
function overfittableSplit(): { train: SequenceSample[]; valid: SequenceSample[] } {
  const rng = createRng('nn-early-stop');
  const sample = (labelled: boolean): SequenceSample => {
    const sequence = Array.from({ length: 4 }, () => Array.from({ length: 3 }, () => rng.normal()));
    const total = sequence.reduce((acc, row) => acc + row.reduce((a, b) => a + b, 0), 0);
    return { sequence, target: labelled ? (total > 0 ? 1 : 0) : rng.next() < 0.5 ? 1 : 0 };
  };
  return {
    train: Array.from({ length: 48 }, () => sample(true)),
    valid: Array.from({ length: 24 }, () => sample(false)),
  };
}

/** Validation BCE of an agent exactly as it predicts, clamped the way the trainer clamps. */
function validationLoss(agent: BiLstmAgent, samples: readonly SequenceSample[]): number {
  let acc = 0;
  for (const s of samples) {
    const p = Math.min(Math.max(agent.predict(s.sequence).probability, 1e-9), 1 - 1e-9);
    acc += -(s.target * Math.log(p) + (1 - s.target) * Math.log(1 - p));
  }
  return acc / samples.length;
}

describe('agent early stopping', () => {
  const { train, valid } = overfittableSplit();
  const agent = new BiLstmAgent(3, 6, 4, createRng('nn-early-stop:init').next);
  const report = agent.train(train, { epochs: 8, learningRate: 0.2, patience: 2 }, valid);

  it('produces the divergence the case is about', () => {
    // The best epoch is not the last one, so "best" and "final" are genuinely
    // different objects here rather than the same weights under two names.
    expect(report.bestValidLoss).not.toBeNull();
    expect(report.finalValidLoss).not.toBeNull();
    expect(report.bestValidLoss as number).toBeLessThan(report.finalValidLoss as number);
  });

  it('returns the weights the reported best validation loss describes', () => {
    /*
     * The regression: `engine/model.ts` publishes `bestValidLoss` as the model
     * card's agent "Valid loss", and the loops used to return the last epoch's
     * weights, so the card described a fit that had been trained past and thrown
     * away. Scored here against the returned object rather than against anything
     * the trainer recorded.
     */
    expect(validationLoss(agent, valid)).toBeCloseTo(report.bestValidLoss as number, 10);
  });

  it('leaves the report honest about which epoch it ran to', () => {
    // `finalValidLoss` and `history` still describe the run; only the parameters
    // are rewound. The last history entry is the epoch the loop actually stopped
    // on, which is what makes the two numbers comparable in the first place.
    expect(report.history).toHaveLength(report.epochs);
    expect(report.history[report.epochs - 1]?.validLoss).toBeCloseTo(report.finalValidLoss as number, 12);
    expect(report.epochs).toBeLessThan(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  4 and 5. Comments a change elsewhere falsified
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The prose of the `/* … *\/` block whose text contains `anchor`, with the
 * leading asterisks stripped and whitespace collapsed so a claim can be matched
 * across the line wrapping it happens to have.
 */
function commentBlock(text: string, anchor: string): string {
  const block = text
    .split('/*')
    .slice(1)
    .map((chunk) => chunk.split('*/')[0] ?? '')
    .find((chunk) => chunk.includes(anchor));
  expect(block, `no comment block containing ${JSON.stringify(anchor)}`).toBeTruthy();
  return (block as string).replace(/^\s*\*/gm, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The same prose with quoted spans blanked out.
 *
 * These comments name the defect they repaired by quoting the sentence that
 * carried it, so the false claim legitimately appears inside double quotes.
 * Only an occurrence outside them is the comment asserting it.
 */
function unquoted(text: string): string {
  return text.replace(/"[^"]*"/g, '""');
}

describe("gbdt.ts's account of the importance buffers", () => {
  const gbdt = source('src', 'lib', 'quant', 'gbdt.ts');

  it('states no present-tense figure about the bundle on disk', () => {
    /*
     * It said "112 × 89 on the shipped model" and "the shipped 92-tree ensemble".
     * `.data/` is git-ignored and the ensemble is re-fitted per deployment, so
     * both went stale at the retrain that shrank it, and substituting the new
     * dimensions would only reset the clock on the same defect. The buffer height
     * is derivable from the loop either way.
     */
    const block = unquoted(commentBlock(gbdt, 'Running totals of'));

    expect(block).not.toMatch(/on the shipped model/);
    expect(block).not.toMatch(/the shipped \d+-tree/);
    expect(block).not.toMatch(/\d+\s*×\s*\d+/);
  });

  it('keeps the figures that motivated the fix, in the past tense', () => {
    // The narrative is the valuable part and is not stale: it describes a bundle
    // that existed, not the one on disk.
    const block = commentBlock(gbdt, 'Running totals of');

    expect(block).toContain('734 splits against 605 real internal');
    expect(block).toMatch(/that exposed this/);
  });

  it('does not claim the superseded losses are the served ones', () => {
    // "the served 92-tree model's is 0.5910" — present tense about a model that
    // had already been replaced by one whose losses are different.
    const block = commentBlock(gbdt, 'Every diagnostic returned');

    expect(block).not.toMatch(/model's is 0\./);
    expect(block).toMatch(/model's was 0\.5910/);
    expect(block).toMatch(/model's was 0\.6728/);
  });
});

describe("orderflow.ts's account of the VPIN bucket depth", () => {
  const orderflow = source('src', 'lib', 'quant', 'orderflow.ts');
  const compute = source('src', 'lib', 'engine', 'compute.ts');

  it('names the constant instead of restating a depth that can go stale', () => {
    const doc = commentBlock(orderflow, 'Volume-synchronised probability of informed trading');

    expect(doc).toContain('VPIN_BARS_PER_BUCKET');
    expect(unquoted(doc)).not.toMatch(/sizes a bucket at three times mean bar volume/);
    expect(unquoted(doc)).not.toMatch(/fires on any bar three times the average/);
    // The old sentence survives only as the quotation that names the defect.
    expect(doc).toMatch(/read "three times mean bar volume/);
  });

  it('is the constant compute.ts actually passes to vpin', () => {
    // The claim the docstring now makes, checked against the call site: the
    // bucket is `VPIN_BARS_PER_BUCKET` × mean bar volume, whatever that is set to.
    expect(compute).toMatch(/const VPIN_BARS_PER_BUCKET = \d+;/);
    expect(compute).toMatch(/mean\(tapeWindow\.map\(\(b\) => b\.volume\)\) \* VPIN_BARS_PER_BUCKET/);
  });
});
