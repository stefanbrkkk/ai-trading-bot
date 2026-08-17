/**
 * Ornstein–Uhlenbeck estimation, tested against ground truth.
 *
 * The test that matters is **parameter recovery**: simulate a path from known
 * (θ, μ, σ) and check the MLE gets them back. That is a far stronger statement
 * than asserting the fit returns plausible-looking numbers, because a closed-form
 * MLE with a sign error or a mis-derived denominator still returns plausible
 * numbers — it just returns the wrong ones, consistently, and nothing downstream
 * would notice.
 *
 * The identities (half-life, expectation, variance, reversion probability) are
 * checked against their analytic definitions rather than against recorded output,
 * so a refactor that changes a formula fails here instead of silently shifting
 * every published half-life.
 */

import { describe, expect, it } from 'vitest';
import {
  fitOu,
  ouBands,
  ouExpectation,
  ouReversionProbability,
  ouTimeToReversion,
  ouVariance,
  ouZScore,
  rollingOuFit,
  simulateOu,
} from '@/lib/quant/ou';
import { createRng } from '@/lib/quant/rng';
import { mean, stdev } from '@/lib/quant/stats';

/** A seeded standard-normal sampler, which is what `simulateOu` consumes. */
function gauss(seed: number): () => number {
  const rng = createRng(seed);
  return () => rng.normal();
}

describe('OU parameter recovery', () => {
  it('recovers theta, mu and sigma from a simulated path', () => {
    const truth = { theta: 0.08, mu: Math.log(150), sigma: 0.02, dt: 1 };
    // 20k steps: the MLE is consistent, so the tolerance below is a statement
    // about the estimator's variance at this sample size, not about correctness.
    const path = simulateOu(truth, truth.mu, 20_000, gauss(4242));
    const fit = fitOu(path, truth.dt);

    expect(fit.theta).toBeCloseTo(truth.theta, 2);
    expect(fit.mu).toBeCloseTo(truth.mu, 2);
    expect(fit.sigma).toBeCloseTo(truth.sigma, 3);
    expect(fit.meanReverting).toBe(true);
  });

  it('gives a random walk a half-life far outside any tradable horizon', () => {
    const rng = createRng(7);
    const walk: number[] = [0];
    for (let i = 1; i < 4000; i += 1) walk.push((walk[i - 1] as number) + rng.normal() * 0.01);

    const fit = fitOu(walk);

    /**
     * The assertion is on the half-life, not on `meanReverting`, and the
     * distinction is worth recording because the obvious test is the wrong one.
     *
     * A random walk has θ = 0, so `e^{−θΔt}` is exactly 1 — but the AR(1)
     * coefficient estimator is biased downward in finite samples (Kendall's bias,
     * roughly −(1+3b)/n), so at n = 4000 the fitted ratio lands near 0.999 and
     * `meanReverting` reports true. That flag is a *numerical validity guard* —
     * "is the estimate inside the range where θ and the half-life are
     * computable" — and 0.999 legitimately is.
     *
     * The economically meaningful filter is elsewhere and is the one that
     * protects the user: `strategies.ts` gates on the half-life falling inside a
     * tradable band, and a ~700-day half-life fails it by two orders of
     * magnitude. Testing the boolean would assert the wrong contract and would
     * fail whenever the sample size changed.
     */
    expect(fit.theta).toBeLessThan(0.01);
    expect(fit.halfLife).toBeGreaterThan(60);

    /**
     * R² is *high* here, and that is the point.
     *
     * The AR(1) is fitted in levels, so regressing a random walk on its own lag
     * explains almost all of the variance — the classic spurious-regression
     * result. This fit reports R² ≈ 0.997 for a series with no mean reversion
     * whatsoever.
     *
     * The assertion is inverted deliberately, to pin the fact down: a high R² on
     * an OU fit is *not* evidence that the reversion is real, and any surface
     * that presented it as a goodness-of-signal measure would be actively
     * misleading. The half-life above is the quantity that carries the
     * information.
     */
    expect(fit.rSquared).toBeGreaterThan(0.9);
  });

  it('is exact on a deterministic AR(1) with no noise', () => {
    // x_{t+1} = mu + (x_t - mu) * b, so theta = -ln(b)/dt exactly.
    const mu = 2;
    const b = 0.9;
    const series = [3];
    for (let i = 1; i < 200; i += 1) series.push(mu + ((series[i - 1] as number) - mu) * b);

    const fit = fitOu(series, 1);
    expect(fit.mu).toBeCloseTo(mu, 6);
    expect(fit.theta).toBeCloseTo(-Math.log(b), 6);
    expect(fit.rSquared).toBeCloseTo(1, 6);
  });
});

describe('OU analytic identities', () => {
  const fit = fitOu(simulateOu({ theta: 0.1, mu: 5, sigma: 0.05, dt: 1 }, 5, 8000, gauss(11)));

  it('half-life satisfies ln(2)/theta', () => {
    expect(fit.halfLife).toBeCloseTo(Math.LN2 / fit.theta, 8);
  });

  it('expectation decays exponentially toward mu', () => {
    const x0 = fit.mu + 1;
    // E[x_tau | x_0] = mu + (x_0 - mu) e^{-theta tau}
    for (const tau of [0, 1, 5, 20]) {
      const expected = fit.mu + (x0 - fit.mu) * Math.exp(-fit.theta * tau);
      expect(ouExpectation(fit, x0, tau)).toBeCloseTo(expected, 10);
    }
  });

  it('expectation at one half-life is exactly halfway to mu', () => {
    const x0 = fit.mu + 4;
    expect(ouExpectation(fit, x0, fit.halfLife)).toBeCloseTo(fit.mu + 2, 8);
  });

  it('variance rises monotonically to the stationary value', () => {
    const stationary = fit.sigma ** 2 / (2 * fit.theta);
    let previous = -1;
    for (const tau of [0.5, 1, 5, 20, 100, 1000]) {
      const v = ouVariance(fit, tau);
      expect(v).toBeGreaterThan(previous);
      previous = v;
      expect(v).toBeLessThanOrEqual(stationary * (1 + 1e-9));
    }
    expect(ouVariance(fit, 1e6)).toBeCloseTo(stationary, 8);
  });

  it('z-score is zero at equilibrium and signed away from it', () => {
    expect(ouZScore(fit, fit.mu)).toBeCloseTo(0, 10);
    expect(ouZScore(fit, fit.mu + fit.equilibriumSigma)).toBeCloseTo(1, 6);
    expect(ouZScore(fit, fit.mu - 2 * fit.equilibriumSigma)).toBeCloseTo(-2, 6);
  });

  it('time to revert a given fraction inverts the expectation', () => {
    const tau = ouTimeToReversion(fit, 0.5);
    expect(tau).toBeCloseTo(fit.halfLife, 8);
    // Reverting 90% of the way takes ln(10)/theta.
    expect(ouTimeToReversion(fit, 0.9)).toBeCloseTo(Math.log(10) / fit.theta, 8);
  });

  it('reversion probability is 0.5 at equilibrium and rises with displacement', () => {
    expect(ouReversionProbability(fit, fit.mu, 5)).toBeCloseTo(0.5, 6);
    const near = ouReversionProbability(fit, fit.mu + fit.equilibriumSigma, 5);
    const far = ouReversionProbability(fit, fit.mu + 3 * fit.equilibriumSigma, 5);
    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThanOrEqual(1);
  });

  it('bands are symmetric around mu at k equilibrium sigmas', () => {
    const bands = ouBands(fit, 2);
    expect(bands.mid).toBeCloseTo(fit.mu, 10);
    expect(bands.upper - bands.mid).toBeCloseTo(bands.mid - bands.lower, 10);
    expect(bands.upper - bands.mid).toBeCloseTo(2 * fit.equilibriumSigma, 8);
  });
});

describe('OU simulation', () => {
  it('produces a stationary distribution matching the analytic moments', () => {
    const p = { theta: 0.2, mu: 1.5, sigma: 0.1, dt: 1 };
    // Burn in past the transient so the sample is drawn from the stationary law.
    const path = simulateOu(p, p.mu, 60_000, gauss(99)).slice(5000);

    expect(mean(path)).toBeCloseTo(p.mu, 2);
    const stationarySigma = p.sigma / Math.sqrt(2 * p.theta);
    expect(stdev(path)).toBeCloseTo(stationarySigma, 2);
  });

  it('is deterministic in its seed', () => {
    const p = { theta: 0.1, mu: 0, sigma: 0.05, dt: 1 };
    const a = simulateOu(p, 0, 500, gauss(5));
    const b = simulateOu(p, 0, 500, gauss(5));
    expect(a).toEqual(b);
  });
});

describe('rolling OU fit', () => {
  it('returns null before the window fills and a fit afterwards', () => {
    const path = simulateOu({ theta: 0.1, mu: 0, sigma: 0.05, dt: 1 }, 0, 400, gauss(3));
    const window = 120;
    const fits = rollingOuFit(path, window);

    expect(fits).toHaveLength(path.length);
    // A window that has not filled cannot be fitted, and returning a fit from
    // partial data would silently publish an estimate from too few observations.
    expect(fits.slice(0, window - 1).every((f) => f === null)).toBe(true);
    expect(fits[fits.length - 1]).not.toBeNull();
  });
});

describe('OU degenerate inputs', () => {
  it('does not throw or emit NaN on constant or trivial series', () => {
    for (const series of [[], [1], [1, 1], new Array(50).fill(7) as number[]]) {
      const fit = fitOu(series);
      expect(Number.isFinite(fit.theta)).toBe(true);
      expect(Number.isFinite(fit.mu)).toBe(true);
      expect(Number.isFinite(fit.sigma)).toBe(true);
      expect(Number.isNaN(fit.rSquared)).toBe(false);
    }
  });
});
