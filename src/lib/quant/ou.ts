/**
 * Continuous-time mean reversion — the Ornstein–Uhlenbeck SDE.
 *
 * MASTER_AURELIUS_SPECIFICATION §2.2 and Phase 1 §2 mandate abandoning
 * discrete-time linear regression and static EMA pullbacks in favour of the OU
 * process, calibrated by Maximum Likelihood Estimation on incoming ticks:
 *
 *     dX_t = θ (μ − X_t) dt + σ dW_t
 *
 *   X_t = spread / price deviation at time t
 *   θ   = rate of mean reversion (velocity of return to the mean), θ > 0
 *   μ   = long-run equilibrium mean
 *   σ   = instantaneous volatility of the process
 *   dW  = increment of a standard Wiener process
 *
 * The exact transition density over a step Δt is Gaussian:
 *
 *     X_{t+Δt} | X_t  ~  N( μ + (X_t − μ)·e^{−θΔt},  σ²(1 − e^{−2θΔt}) / (2θ) )
 *
 * so the OU process is exactly an AR(1) in discrete time with
 * b = e^{−θΔt} and a = μ(1 − b). That equivalence gives closed-form MLEs.
 */

import { EPS, clamp, mean as avg, normCdf } from './stats';

export interface OuParameters {
  /** Mean-reversion rate θ (per unit of time, in the Δt units supplied). */
  theta: number;
  /** Long-run equilibrium level μ. */
  mu: number;
  /** Instantaneous volatility σ. */
  sigma: number;
  /** Sampling interval used for calibration. */
  dt: number;
}

export interface OuFit extends OuParameters {
  /** ln(2)/θ — periods until half of a shock has decayed. */
  halfLife: number;
  /** Stationary standard deviation σ_eq = σ / √(2θ). */
  equilibriumSigma: number;
  /** Log-likelihood at the optimum (higher is better). */
  logLikelihood: number;
  /** AR(1) persistence b = e^{−θΔt} ∈ (0,1); ≥1 means no reversion detected. */
  persistence: number;
  /** Fraction of variance explained by the AR(1) representation. */
  rSquared: number;
  /** Observations used. */
  n: number;
  /** False when the series shows no statistically usable mean reversion. */
  meanReverting: boolean;
}

const MIN_OBS = 8;

/**
 * Closed-form Maximum Likelihood Estimation of (θ, μ, σ) for a uniformly
 * sampled OU path. Derivation: maximise the joint Gaussian transition density
 * of the AR(1) representation; the score equations solve analytically.
 *
 *   Sx = Σ x_{i−1},  Sy = Σ x_i,  Sxx = Σ x²_{i−1},  Sxy = Σ x_{i−1}x_i,  Syy = Σ x²_i
 *
 *   μ̂ = (Sy·Sxx − Sx·Sxy) / ( n(Sxx − Sxy) − (Sx² − Sx·Sy) )
 *   θ̂ = −(1/Δt)·ln[ (Sxy − μ̂Sx − μ̂Sy + nμ̂²) / (Sxx − 2μ̂Sx + nμ̂²) ]
 *   σ̂² = σ̂²_h · 2θ̂ / (1 − e^{−2θ̂Δt}),  where
 *   σ̂²_h = (1/n)·Σ ( x_i − x_{i−1}·e^{−θ̂Δt} − μ̂(1 − e^{−θ̂Δt}) )²
 */
export function fitOu(series: readonly number[], dt = 1): OuFit {
  const n = series.length - 1;
  if (n < MIN_OBS) {
    const mu = avg(series);
    return degenerateFit(mu, dt, Math.max(0, series.length - 1));
  }

  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  // Σy² is deliberately not accumulated. The closed-form θ and μ do not use it,
  // and the total sum of squares below could be had from it as `syy − sy²/n` —
  // but on log-price levels (magnitude ~5, so Σy² ≈ 25n) that difference is a
  // subtraction of two nearly-equal large numbers, and the cancellation costs
  // more precision than the saved pass is worth. R² is computed two-pass instead.
  for (let i = 1; i <= n; i += 1) {
    const xPrev = series[i - 1] as number;
    const xCur = series[i] as number;
    sx += xPrev;
    sy += xCur;
    sxx += xPrev * xPrev;
    sxy += xPrev * xCur;
  }

  const muDenom = n * (sxx - sxy) - (sx * sx - sx * sy);
  const grandMean = (sx + sy) / (2 * n);
  const mu = Math.abs(muDenom) < EPS ? grandMean : (sy * sxx - sx * sxy) / muDenom;

  const num = sxy - mu * sx - mu * sy + n * mu * mu;
  const den = sxx - 2 * mu * sx + n * mu * mu;
  const ratio = Math.abs(den) < EPS ? 1 : num / den;

  // ratio ≡ e^{−θΔt}. Outside (0,1) the series is not mean-reverting on this
  // sample; clamp into a usable band and flag it.
  const reverting = ratio > 1e-6 && ratio < 1 - 1e-6;
  const b = clamp(ratio, 1e-6, 1 - 1e-9);
  const theta = -Math.log(b) / dt;

  let sse = 0;
  for (let i = 1; i <= n; i += 1) {
    const pred = mu + ((series[i - 1] as number) - mu) * b;
    const err = (series[i] as number) - pred;
    sse += err * err;
  }
  const sigmaH2 = sse / n;
  const denom = 1 - b * b;
  const sigma2 = denom < EPS ? sigmaH2 / dt : (sigmaH2 * 2 * theta) / denom;
  const sigma = Math.sqrt(Math.max(sigma2, 0));

  // Gaussian log-likelihood of the exact transition density.
  const condVar = Math.max(sigmaH2, EPS);
  const logLikelihood = -0.5 * n * (Math.log(2 * Math.PI * condVar) + 1);

  const meanY = sy / n;
  let tss = 0;
  for (let i = 1; i <= n; i += 1) tss += ((series[i] as number) - meanY) ** 2;
  const rSquared = tss < EPS ? 0 : clamp(1 - sse / tss, 0, 1);

  return {
    theta,
    mu,
    sigma,
    dt,
    halfLife: theta > EPS ? Math.LN2 / theta : Infinity,
    equilibriumSigma: theta > EPS ? sigma / Math.sqrt(2 * theta) : Math.sqrt(Math.max(sigmaH2, 0)),
    logLikelihood,
    persistence: b,
    rSquared,
    n,
    meanReverting: reverting && theta > EPS,
  };
}

function degenerateFit(mu: number, dt: number, n: number): OuFit {
  return {
    theta: 0,
    mu,
    sigma: 0,
    dt,
    halfLife: Infinity,
    equilibriumSigma: 0,
    logLikelihood: 0,
    persistence: 1,
    rSquared: 0,
    n,
    meanReverting: false,
  };
}

/** Conditional expectation E[X_{t+τ} | X_t] = μ + (X_t − μ)·e^{−θτ}. */
export function ouExpectation(fit: OuParameters, x: number, tau: number): number {
  return fit.mu + (x - fit.mu) * Math.exp(-fit.theta * tau);
}

/** Conditional variance Var[X_{t+τ} | X_t] = σ²(1 − e^{−2θτ}) / (2θ). */
export function ouVariance(fit: OuParameters, tau: number): number {
  if (fit.theta <= EPS) return fit.sigma * fit.sigma * tau;
  return (fit.sigma * fit.sigma * (1 - Math.exp(-2 * fit.theta * tau))) / (2 * fit.theta);
}

/** Standardised deviation from equilibrium, in stationary sigmas. */
export function ouZScore(fit: OuFit, x: number): number {
  const s = fit.equilibriumSigma;
  return s < EPS ? 0 : (x - fit.mu) / s;
}

/**
 * Periods for the conditional expectation to close `fraction` of the current
 * gap to μ:  τ = −ln(1 − fraction) / θ.
 */
export function ouTimeToReversion(fit: OuFit, fraction = 0.5): number {
  if (fit.theta <= EPS) return Infinity;
  const f = clamp(fraction, EPS, 1 - EPS);
  return -Math.log(1 - f) / fit.theta;
}

/**
 * Probability that the process is closer to μ after τ than it is now — the
 * "mean reversion conviction" the signal engine consumes.
 *
 * P(|X_{t+τ} − μ| < |X_t − μ|) under the exact Gaussian transition density.
 */
export function ouReversionProbability(fit: OuFit, x: number, tau: number): number {
  const gap = x - fit.mu;
  if (Math.abs(gap) < EPS) return 0.5;
  const m = ouExpectation(fit, x, tau) - fit.mu;
  const sd = Math.sqrt(Math.max(ouVariance(fit, tau), EPS));
  const a = Math.abs(gap);
  // P(−a < Y < a) where Y ~ N(m, sd²)
  return clamp(normCdf((a - m) / sd) - normCdf((-a - m) / sd), 0, 1);
}

/**
 * OU "innovation" entry bands: μ ± k·σ_eq. Unlike Bollinger bands these widen
 * with measured σ and tighten with measured θ, so they follow the regime rather
 * than a fixed 20-period standard deviation (Phase 1 §4).
 */
export function ouBands(fit: OuFit, k = 2): { upper: number; lower: number; mid: number } {
  const w = k * fit.equilibriumSigma;
  return { upper: fit.mu + w, lower: fit.mu - w, mid: fit.mu };
}

/**
 * Exact-transition simulation of an OU path. Used by the market simulator and
 * by the Monte-Carlo leg of the backtester.
 */
export function simulateOu(
  fit: OuParameters,
  x0: number,
  steps: number,
  gauss: () => number,
): number[] {
  const b = Math.exp(-fit.theta * fit.dt);
  const shockSd =
    fit.theta <= EPS
      ? fit.sigma * Math.sqrt(fit.dt)
      : fit.sigma * Math.sqrt((1 - b * b) / (2 * fit.theta));
  const out = new Array<number>(steps);
  let x = x0;
  for (let i = 0; i < steps; i += 1) {
    x = fit.mu + (x - fit.mu) * b + shockSd * gauss();
    out[i] = x;
  }
  return out;
}

/**
 * Rolling OU calibration: refits on a sliding window so θ, μ and σ track the
 * regime instead of being fixed by an overnight batch job (Phase 1 §4.3 — the
 * explicit answer to Holly AI's nightly "Quantitative Combine").
 */
export function rollingOuFit(series: readonly number[], window: number, dt = 1): (OuFit | null)[] {
  const out: (OuFit | null)[] = new Array(series.length).fill(null);
  for (let i = window; i < series.length; i += 1) {
    out[i] = fitOu(series.slice(i - window, i + 1), dt);
  }
  return out;
}
