/**
 * The quant core, tested against closed forms and brute force.
 *
 * The organising principle: wherever a property can be checked against something
 * *independent* of the implementation, it is. TreeSHAP is checked against an
 * exhaustive enumeration of the Shapley definition; Black-Scholes against put-call
 * parity and against a finite-difference of its own price function; PCA against
 * hand-constructed eigenvectors; SABR against the ATM limit of its own formula.
 *
 * Asserting against recorded output would pass just as reliably and would prove
 * nothing — a wrong implementation happily reproduces its own wrong numbers.
 */

import { describe, expect, it } from 'vitest';
import { blackScholes, bsPrice, impliedVolatility, strikeForDelta } from '@/lib/quant/blackscholes';
import { fitPca, componentsForVariance, pcaFirstScore, pcaInverse, pcaTransform } from '@/lib/quant/pca';
import { ecdf, ecdfInverse, fitEcdf, pseudoObservations } from '@/lib/quant/ecdf';
import { calibrateSabr, riskReversal25, sabrAtmVol, sabrImpliedVol } from '@/lib/quant/sabr';
import { correlation, mean, quantile, skewness, stdev, variance } from '@/lib/quant/stats';
import { matMul, matVec, solve, transpose } from '@/lib/quant/linalg';
import { atr, bollinger, ema, rsi, sma, vwap } from '@/lib/quant/indicators';
import { createRng, hashSeed } from '@/lib/quant/rng';
import { ensembleBaseValue, treeShapSingle } from '@/lib/quant/shap';
import type { DecisionTree, GbdtModel } from '@/lib/quant/gbdt';

// ─────────────────────────────────────────────────────────────────────────────
//  TreeSHAP against the Shapley definition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates a tree with a *subset* of features known.
 *
 * Unknown features take both branches, weighted by the training cover, which is
 * exactly the conditional expectation path-dependent TreeSHAP computes. This is
 * the reference implementation the fast algorithm has to agree with.
 */
function expectedValueGivenSubset(tree: DecisionTree, row: readonly number[], known: ReadonlySet<number>): number {
  const walk = (nodeIndex: number, weight: number): number => {
    const node = tree.nodes[nodeIndex];
    if (node === undefined) return 0;
    if (node.feature === -1) return weight * node.value;

    const left = node.left;
    const right = node.right;
    if (left === undefined || right === undefined || left < 0 || right < 0) return weight * node.value;

    if (known.has(node.feature)) {
      const goLeft = (row[node.feature] as number) <= node.threshold;
      return walk(goLeft ? left : right, weight);
    }

    const leftNode = tree.nodes[left];
    const rightNode = tree.nodes[right];
    const total = (leftNode?.cover ?? 0) + (rightNode?.cover ?? 0);
    if (total <= 0) return weight * node.value;
    return (
      walk(left, (weight * (leftNode?.cover ?? 0)) / total) +
      walk(right, (weight * (rightNode?.cover ?? 0)) / total)
    );
  };
  return walk(0, 1);
}

/** Exact Shapley values by enumerating every ordering, via the subset formula. */
function bruteForceShapley(tree: DecisionTree, row: readonly number[], featureCount: number): number[] {
  const phi = new Array<number>(featureCount).fill(0);
  const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));
  const total = featureCount;

  for (let i = 0; i < featureCount; i += 1) {
    const others = Array.from({ length: featureCount }, (_, k) => k).filter((k) => k !== i);
    // Every subset S of N \ {i}: weight |S|!(n-|S|-1)!/n!
    for (let mask = 0; mask < 1 << others.length; mask += 1) {
      const subset = new Set<number>();
      for (let b = 0; b < others.length; b += 1) {
        if (mask & (1 << b)) subset.add(others[b] as number);
      }
      const withI = new Set(subset);
      withI.add(i);
      const marginal = expectedValueGivenSubset(tree, row, withI) - expectedValueGivenSubset(tree, row, subset);
      const weight = (factorial(subset.size) * factorial(total - subset.size - 1)) / factorial(total);
      phi[i] = (phi[i] as number) + weight * marginal;
    }
  }
  return phi;
}

/** A small hand-built tree, so the brute force stays tractable. */
function fixtureTree(): DecisionTree {
  return {
    nodes: [
      { feature: 0, threshold: 0.5, left: 1, right: 4, value: 0, cover: 100, count: 100 },
      { feature: 1, threshold: 0.5, left: 2, right: 3, value: 0, cover: 60, count: 60 },
      { feature: -1, threshold: 0, left: -1, right: -1, value: -1.5, cover: 25, count: 25 },
      { feature: -1, threshold: 0, left: -1, right: -1, value: 0.4, cover: 35, count: 35 },
      { feature: 2, threshold: 0.5, left: 5, right: 6, value: 0, cover: 40, count: 40 },
      { feature: -1, threshold: 0, left: -1, right: -1, value: 0.9, cover: 18, count: 18 },
      { feature: -1, threshold: 0, left: -1, right: -1, value: 2.2, cover: 22, count: 22 },
    ],
    maxDepth: 3,
  };
}

describe('exact TreeSHAP', () => {
  it('matches an exhaustive Shapley enumeration on every input corner', () => {
    const tree = fixtureTree();
    const featureCount = 3;

    // All eight corners of the 3-dimensional split space, so every leaf is the
    // decision path at least once.
    for (let corner = 0; corner < 8; corner += 1) {
      const row = [corner & 1 ? 0.8 : 0.2, corner & 2 ? 0.8 : 0.2, corner & 4 ? 0.8 : 0.2];
      const fast = new Array<number>(featureCount).fill(0);
      treeShapSingle(tree, row, fast);
      const slow = bruteForceShapley(tree, row, featureCount);

      for (let i = 0; i < featureCount; i += 1) {
        expect(fast[i]).toBeCloseTo(slow[i] as number, 12);
      }
    }
  });

  it('satisfies local accuracy: the contributions sum to f(x) − E[f(x)]', () => {
    const tree = fixtureTree();
    // A minimal but complete GbdtModel: `ensembleBaseValue` reads baseScore and
    // walks the trees, and the remaining fields are part of the published contract.
    const model: GbdtModel = {
      trees: [tree],
      baseScore: 0,
      learningRate: 1,
      objective: 'logistic',
      featureNames: ['f0', 'f1', 'f2'],
      featureGain: [0, 0, 0],
      featureSplits: [0, 0, 0],
      history: [],
    };
    const base = ensembleBaseValue(model);

    for (const row of [
      [0.2, 0.2, 0.2],
      [0.8, 0.2, 0.8],
      [0.2, 0.8, 0.2],
      [0.8, 0.8, 0.8],
    ]) {
      const phi = new Array<number>(3).fill(0);
      treeShapSingle(tree, row, phi);
      const prediction = expectedValueGivenSubset(tree, row, new Set([0, 1, 2]));
      const summed = phi.reduce((a, b) => a + b, 0);
      // This identity is the whole reason exact TreeSHAP is used rather than a
      // sampled approximation, and it is what the UI's residual displays.
      expect(summed).toBeCloseTo(prediction - base, 12);
    }
  });

  it('gives an unused feature exactly zero attribution', () => {
    // Feature 2 is never split on in this tree.
    const tree: DecisionTree = {
      nodes: [
        { feature: 0, threshold: 0.5, left: 1, right: 2, value: 0, cover: 50, count: 50 },
        { feature: -1, threshold: 0, left: -1, right: -1, value: -1, cover: 20, count: 20 },
        { feature: -1, threshold: 0, left: -1, right: -1, value: 1, cover: 30, count: 30 },
      ],
      maxDepth: 1,
    };
    const phi = new Array<number>(3).fill(0);
    treeShapSingle(tree, [0.9, 0.4, 0.7], phi);
    expect(phi[1]).toBeCloseTo(0, 14);
    expect(phi[2]).toBeCloseTo(0, 14);
    expect(Math.abs(phi[0] as number)).toBeGreaterThan(0.1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Black-Scholes
// ─────────────────────────────────────────────────────────────────────────────

describe('Black-Scholes', () => {
  const base = { spot: 100, strike: 100, tau: 0.5, vol: 0.25, rate: 0.03, dividend: 0.01 };

  it('satisfies put-call parity', () => {
    // C − P = S e^{−qτ} − K e^{−rτ}
    for (const strike of [80, 95, 100, 110, 130]) {
      const call = bsPrice({ ...base, strike, type: 'call' as const });
      const put = bsPrice({ ...base, strike, type: 'put' as const });
      const parity =
        base.spot * Math.exp(-base.dividend * base.tau) - strike * Math.exp(-base.rate * base.tau);
      expect(call - put).toBeCloseTo(parity, 8);
    }
  });

  it('delta matches a central finite difference of the price', () => {
    const h = 1e-4;
    for (const type of ['call', 'put'] as const) {
      const greeks = blackScholes({ ...base, type });
      const up = bsPrice({ ...base, type, spot: base.spot + h });
      const down = bsPrice({ ...base, type, spot: base.spot - h });
      /**
       * Three decimal places, not six, and the reason is the normal CDF rather
       * than the formula.
       *
       * `normalCdf` is Abramowitz & Stegun 7.1.26, documented to |ε| < 1.5e-7.
       * At a spot of 100 that is a price error around 1.5e-5, and dividing by
       * 2h = 2e-4 amplifies it into the difference quotient — a smaller h makes
       * it worse, not better. The residual is a property of the CDF
       * approximation, which is deliberate and ample for the probability and
       * risk-reversal displays it feeds.
       *
       * A tolerance of 1e-3 still catches every error that matters: a sign slip
       * or a wrong d₁ moves delta by O(0.1), five hundred times this bound.
       */
      expect(greeks.delta).toBeCloseTo((up - down) / (2 * h), 3);
    }
  });

  it('gamma matches a second finite difference and is call/put identical', () => {
    const h = 1e-2;
    const call = blackScholes({ ...base, type: 'call' as const });
    const put = blackScholes({ ...base, type: 'put' as const });
    // Gamma does not depend on the option's parity.
    expect(call.gamma).toBeCloseTo(put.gamma, 10);

    const second =
      (bsPrice({ ...base, type: 'call' as const, spot: base.spot + h }) -
        2 * bsPrice({ ...base, type: 'call' as const }) +
        bsPrice({ ...base, type: 'call' as const, spot: base.spot - h })) /
      (h * h);
    expect(call.gamma).toBeCloseTo(second, 4);
  });

  it('vega matches a finite difference in volatility and is non-negative', () => {
    const h = 1e-5;
    const greeks = blackScholes({ ...base, type: 'call' as const });
    const up = bsPrice({ ...base, type: 'call' as const, vol: base.vol + h });
    const down = bsPrice({ ...base, type: 'call' as const, vol: base.vol - h });
    // Raw ∂V/∂σ, i.e. per *unit* of volatility, not per vol point. The
    // per-point convention (divide by 100) is a presentation choice and is
    // applied by the formatter, not by the model.
    expect(greeks.vega).toBeCloseTo((up - down) / (2 * h), 4);
    expect(greeks.vega).toBeGreaterThan(0);
  });

  it('recovers the input volatility through implied-vol inversion', () => {
    for (const vol of [0.1, 0.2, 0.35, 0.8]) {
      for (const strike of [85, 100, 120]) {
        const price = bsPrice({ ...base, strike, vol, type: 'call' as const });
        const recovered = impliedVolatility(price, { ...base, strike, type: 'call' as const });
        expect(recovered).toBeCloseTo(vol, 5);
      }
    }
  });

  it('strikeForDelta inverts the delta function', () => {
    // The solver takes a vol *function* of strike, so it works against a smile;
    // a flat function reduces it to the Black-Scholes inverse.
    const volAt = (): number => base.vol;
    for (const target of [0.25, 0.5, 0.75]) {
      const strike = strikeForDelta(target, {
        spot: base.spot,
        tau: base.tau,
        type: 'call',
        rate: base.rate,
        dividend: base.dividend,
        volAt,
      });
      const achieved = blackScholes({ ...base, strike, type: 'call' as const }).delta;
      expect(achieved).toBeCloseTo(target, 4);
    }
  });

  it('prices a zero-volatility option at its discounted intrinsic value', () => {
    const forward = base.spot * Math.exp((base.rate - base.dividend) * base.tau);
    const intrinsic = Math.max(0, forward - 90) * Math.exp(-base.rate * base.tau);
    expect(bsPrice({ ...base, strike: 90, vol: 0, type: 'call' as const })).toBeCloseTo(intrinsic, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  SABR
// ─────────────────────────────────────────────────────────────────────────────

describe('SABR', () => {
  const params = { alpha: 0.3, beta: 0.5, rho: -0.3, nu: 0.4 };

  it('agrees with the ATM closed form at the money', () => {
    const forward = 100;
    const tau = 0.5;
    // Hagan's ATM expansion is a distinct code path from the general formula, so
    // their agreement at K = F is a real cross-check rather than a tautology.
    expect(sabrImpliedVol(forward, forward, tau, params)).toBeCloseTo(
      sabrAtmVol(forward, tau, params),
      9,
    );
  });

  it('produces a smile: implied vol rises away from the money', () => {
    const forward = 100;
    const tau = 0.5;
    const atm = sabrImpliedVol(forward, forward, tau, params);
    expect(sabrImpliedVol(forward, 80, tau, params)).toBeGreaterThan(atm);
    expect(sabrImpliedVol(forward, 125, tau, params)).toBeGreaterThan(atm);
  });

  it('signs the skew with rho', () => {
    const forward = 100;
    const tau = 0.5;
    const downside = 85;
    const upside = 118;
    // Negative correlation lifts the downside wing relative to the upside.
    const negative = { ...params, rho: -0.6 };
    const positive = { ...params, rho: 0.6 };
    const negSkew =
      sabrImpliedVol(forward, downside, tau, negative) - sabrImpliedVol(forward, upside, tau, negative);
    const posSkew =
      sabrImpliedVol(forward, downside, tau, positive) - sabrImpliedVol(forward, upside, tau, positive);
    expect(negSkew).toBeGreaterThan(posSkew);
  });

  it('recovers its own parameters through calibration', () => {
    const forward = 100;
    const tau = 0.5;
    const strikes = [80, 88, 94, 100, 106, 114, 124];
    const quotes = strikes.map((strike) => ({
      strike,
      vol: sabrImpliedVol(forward, strike, tau, params),
    }));

    const fit = calibrateSabr(forward, tau, quotes, { beta: params.beta });

    // The fitted surface must reproduce the quotes it was fitted to; the
    // parameters themselves are only weakly identified from seven points, so the
    // assertion is on the surface rather than on alpha/rho/nu individually.
    for (const quote of quotes) {
      expect(sabrImpliedVol(forward, quote.strike, tau, fit)).toBeCloseTo(quote.vol, 3);
    }
    expect(fit.rmse).toBeLessThan(1e-3);
  });

  it('signs the 25-delta risk reversal with the skew', () => {
    const forward = 100;
    const tau = 0.25;
    const negative = riskReversal25(forward, tau, { ...params, rho: -0.7 });
    const positive = riskReversal25(forward, tau, { ...params, rho: 0.7 });
    // Puts richer than calls is the negative convention.
    expect(negative.riskReversal25).toBeLessThan(0);
    expect(positive.riskReversal25).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PCA
// ─────────────────────────────────────────────────────────────────────────────

describe('PCA', () => {
  it('recovers a known dominant axis', () => {
    // Points along the (1, 1)/√2 direction with a little orthogonal noise.
    const rng = createRng(21);
    const samples = Array.from({ length: 600 }, () => {
      const t = rng.normal() * 3;
      const n = rng.normal() * 0.05;
      return [t + n, t - n];
    });

    const model = fitPca(samples);
    const first = model.components[0] as number[];
    // Sign is arbitrary in an eigendecomposition, so the axis is compared up to it.
    const aligned = Math.abs((first[0] as number) * Math.SQRT1_2 + (first[1] as number) * Math.SQRT1_2);
    expect(aligned).toBeCloseTo(1, 3);
    expect(model.explainedVarianceRatio[0] as number).toBeGreaterThan(0.99);
  });

  it('round-trips a sample through transform and inverse', () => {
    const rng = createRng(5);
    const samples = Array.from({ length: 200 }, () => [rng.normal(), rng.normal(), rng.normal()]);
    const model = fitPca(samples);

    const x = samples[10] as number[];
    // Keeping every component makes the projection lossless up to float error.
    const back = pcaInverse(model, pcaTransform(model, x));
    for (let i = 0; i < x.length; i += 1) expect(back[i]).toBeCloseTo(x[i] as number, 8);
  });

  it('orders components by descending explained variance', () => {
    const rng = createRng(9);
    const samples = Array.from({ length: 300 }, () => [rng.normal() * 5, rng.normal() * 2, rng.normal() * 0.4]);
    const model = fitPca(samples);
    const ratios = model.explainedVarianceRatio;
    for (let i = 1; i < ratios.length; i += 1) {
      expect(ratios[i - 1] as number).toBeGreaterThanOrEqual(ratios[i] as number);
    }
    expect(componentsForVariance(model, 0.9)).toBeLessThanOrEqual(ratios.length);
    expect(pcaFirstScore(model, samples[0] as number[])).toBeTypeOf('number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ECDF
// ─────────────────────────────────────────────────────────────────────────────

describe('ECDF', () => {
  it('maps the sample onto approximately uniform ranks', () => {
    const samples = Array.from({ length: 1000 }, (_, i) => i * 0.37);
    const model = fitEcdf(samples);

    expect(ecdf(model, samples[0] as number)).toBeGreaterThan(0);
    expect(ecdf(model, samples[999] as number)).toBeLessThanOrEqual(1);
    // The median of the sample must sit at the middle of the distribution.
    expect(ecdf(model, samples[499] as number)).toBeCloseTo(0.5, 2);
  });

  it('is monotone non-decreasing', () => {
    const rng = createRng(31);
    const samples = Array.from({ length: 400 }, () => rng.normal());
    const model = fitEcdf(samples);
    let previous = -1;
    for (const x of [-4, -2, -1, -0.5, 0, 0.5, 1, 2, 4]) {
      const p = ecdf(model, x);
      expect(p).toBeGreaterThanOrEqual(previous);
      previous = p;
    }
  });

  it('inverts back into the sample support', () => {
    const samples = Array.from({ length: 500 }, (_, i) => i);
    const model = fitEcdf(samples);
    for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const x = ecdfInverse(model, p);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(499);
      // Round-tripping should land within one sample spacing.
      expect(Math.abs(ecdf(model, x) - p)).toBeLessThan(0.01);
    }
  });

  it('produces pseudo-observations strictly inside (0, 1)', () => {
    // A copula fit needs the open interval; a 0 or 1 makes the inverse normal
    // infinite and poisons every downstream correlation.
    const u = pseudoObservations([3, 1, 4, 1, 5, 9, 2, 6]);
    for (const value of u) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Statistics and linear algebra
// ─────────────────────────────────────────────────────────────────────────────

describe('statistics', () => {
  it('computes mean, variance and stdev against hand values', () => {
    const xs = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(mean(xs)).toBeCloseTo(5, 12);
    // Population variance is 4; the default ddof = 1 gives 32/7.
    expect(variance(xs, 0)).toBeCloseTo(4, 12);
    expect(variance(xs, 1)).toBeCloseTo(32 / 7, 12);
    expect(stdev(xs, 0)).toBeCloseTo(2, 12);
  });

  it('gives correlation of exactly ±1 for a linear relation', () => {
    const xs = [1, 2, 3, 4, 5];
    expect(correlation(xs, xs.map((x) => 3 * x + 7))).toBeCloseTo(1, 12);
    expect(correlation(xs, xs.map((x) => -2 * x + 1))).toBeCloseTo(-1, 12);
  });

  it('reports zero skewness for a symmetric sample', () => {
    expect(skewness([-2, -1, 0, 1, 2])).toBeCloseTo(0, 12);
    expect(skewness([0, 0, 0, 1, 10])).toBeGreaterThan(0);
  });

  it('interpolates quantiles', () => {
    const xs = [1, 2, 3, 4];
    expect(quantile(xs, 0)).toBeCloseTo(1, 12);
    expect(quantile(xs, 1)).toBeCloseTo(4, 12);
    expect(quantile(xs, 0.5)).toBeCloseTo(2.5, 12);
  });
});

describe('linear algebra', () => {
  it('solves a linear system exactly', () => {
    const a = [
      [2, 1, -1],
      [-3, -1, 2],
      [-2, 1, 2],
    ];
    const b = [8, -11, -3];
    const x = solve(a, b);
    // Known solution (2, 3, -1).
    expect(x[0]).toBeCloseTo(2, 10);
    expect(x[1]).toBeCloseTo(3, 10);
    expect(x[2]).toBeCloseTo(-1, 10);
  });

  it('multiplies matrices and vectors consistently', () => {
    const a = [
      [1, 2],
      [3, 4],
    ];
    const b = [
      [5, 6],
      [7, 8],
    ];
    expect(matMul(a, b)).toEqual([
      [19, 22],
      [43, 50],
    ]);
    expect(matVec(a, [1, 1])).toEqual([3, 7]);
    expect(transpose(a)).toEqual([
      [1, 3],
      [2, 4],
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Indicators
// ─────────────────────────────────────────────────────────────────────────────

describe('indicators', () => {
  it('computes an SMA against hand arithmetic', () => {
    const out = sma([1, 2, 3, 4, 5, 6], 3);
    expect(out).toHaveLength(6);
    // The first two are undefined-by-window; the platform emits NaN there.
    expect(out[2]).toBeCloseTo(2, 12);
    expect(out[5]).toBeCloseTo(5, 12);
  });

  it('seeds an EMA on the first SMA and then applies the smoothing factor', () => {
    const values = [1, 2, 3, 4, 5];
    const out = ema(values, 3);
    const k = 2 / (3 + 1);
    // Seed = mean(1,2,3) = 2 at index 2, then recursive.
    expect(out[2]).toBeCloseTo(2, 12);
    expect(out[3]).toBeCloseTo(2 + k * (4 - 2), 12);
    expect(out[4]).toBeCloseTo(out[3] as number + k * (5 - (out[3] as number)), 12);
  });

  it('gives RSI of 100 for a monotone rise and 0 for a monotone fall', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const down = Array.from({ length: 40 }, (_, i) => 100 - i);
    expect(rsi(up, 14).at(-1) as number).toBeCloseTo(100, 6);
    expect(rsi(down, 14).at(-1) as number).toBeCloseTo(0, 6);
  });

  it('gives RSI of 50 for a flat series, not 100', () => {
    const flat = new Array(40).fill(50) as number[];
    const value = rsi(flat, 14).at(-1) as number;
    /**
     * A flat series has zero gains *and* zero losses, so RS is 0/0. The textbook
     * `avgLoss === 0 ? 100` branch fires first and returns 100, which this
     * platform discretises into STATE_DEEPLY_OVERBOUGHT — publishing a confident
     * bearish thesis about a price that has not moved. Reachable on a halted or
     * untraded name, so 50 is asserted explicitly.
     */
    expect(value).toBeCloseTo(50, 6);
  });

  it('brackets price inside its Bollinger band and centres the middle on the SMA', () => {
    const rng = createRng(77);
    const closes = Array.from({ length: 60 }, () => 100 + rng.normal() * 2);
    const band = bollinger(closes, 20, 2);
    const middle = sma(closes, 20);

    const i = closes.length - 1;
    expect(band.middle[i]).toBeCloseTo(middle[i] as number, 10);
    expect(band.upper[i] as number).toBeGreaterThan(band.middle[i] as number);
    expect(band.lower[i] as number).toBeLessThan(band.middle[i] as number);
    // The band is symmetric by construction.
    expect((band.upper[i] as number) - (band.middle[i] as number)).toBeCloseTo(
      (band.middle[i] as number) - (band.lower[i] as number),
      10,
    );
  });

  it('computes ATR as a positive smoothed true range', () => {
    const bars = Array.from({ length: 40 }, (_, i) => ({
      time: i,
      open: 100,
      high: 102 + (i % 3),
      low: 98 - (i % 2),
      close: 100 + (i % 5) * 0.2,
      volume: 1000,
    }));
    const out = atr(bars, 14);
    const last = out.at(-1) as number;
    expect(last).toBeGreaterThan(0);
    expect(Number.isFinite(last)).toBe(true);
  });

  it('computes VWAP as the volume-weighted typical price', () => {
    const bars = [
      { time: 1, open: 10, high: 12, low: 8, close: 10, volume: 100 },
      { time: 2, open: 10, high: 22, low: 18, close: 20, volume: 300 },
    ];
    // Typical prices are 10 and 20; weighted mean is (10*100 + 20*300)/400 = 17.5.
    expect(vwap(bars).at(-1) as number).toBeCloseTo(17.5, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  RNG
// ─────────────────────────────────────────────────────────────────────────────

describe('seeded RNG', () => {
  it('is reproducible from the same seed and differs across seeds', () => {
    const a = Array.from({ length: 50 }, () => createRng(1234).next());
    const b = Array.from({ length: 50 }, () => createRng(1234).next());
    expect(a).toEqual(b);

    const one = createRng(1);
    const two = createRng(2);
    const sequenceOne = Array.from({ length: 20 }, () => one.next());
    const sequenceTwo = Array.from({ length: 20 }, () => two.next());
    expect(sequenceOne).not.toEqual(sequenceTwo);
  });

  it('produces uniforms in [0, 1) with the right mean and spread', () => {
    const rng = createRng('aurelius');
    const xs = Array.from({ length: 100_000 }, () => rng.next());
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(mean(xs)).toBeCloseTo(0.5, 2);
    // Uniform variance is 1/12, so sd ≈ 0.2887.
    expect(stdev(xs)).toBeCloseTo(Math.sqrt(1 / 12), 2);
  });

  it('produces standard normals with unit variance', () => {
    const rng = createRng(31_337);
    const xs = Array.from({ length: 100_000 }, () => rng.normal());
    expect(mean(xs)).toBeCloseTo(0, 1);
    expect(stdev(xs)).toBeCloseTo(1, 1);
    // A normal sample is symmetric, so skewness must vanish.
    expect(Math.abs(skewness(xs))).toBeLessThan(0.05);
  });

  it('hashes strings and numbers to stable seeds', () => {
    expect(hashSeed('AAPL')).toBe(hashSeed('AAPL'));
    expect(hashSeed('AAPL')).not.toBe(hashSeed('MSFT'));
    expect(hashSeed(42)).toBe(hashSeed(42));
  });
});
