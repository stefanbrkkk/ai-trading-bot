/**
 * Descriptive statistics and distribution primitives.
 *
 * Pure, allocation-light and dependency-free so the same code runs in a Node
 * route handler, in a Vitest process and (where needed) in the browser.
 */

export const EPS = 1e-12;

export function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function sum(xs: readonly number[]): number {
  // Neumaier compensated summation — keeps long P&L series exact enough that
  // equity curves reconcile to the cent.
  let s = 0;
  let c = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i] as number;
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? s - t + x : x - t + s;
    s = t;
  }
  return s + c;
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : sum(xs) / xs.length;
}

/** Sample variance (Bessel-corrected, ddof = 1) via Welford. */
export function variance(xs: readonly number[], ddof = 1): number {
  const n = xs.length;
  if (n <= ddof) return 0;
  let m = 0;
  let m2 = 0;
  for (let i = 0; i < n; i += 1) {
    const x = xs[i] as number;
    const delta = x - m;
    m += delta / (i + 1);
    m2 += delta * (x - m);
  }
  return m2 / (n - ddof);
}

export function stdev(xs: readonly number[], ddof = 1): number {
  return Math.sqrt(Math.max(0, variance(xs, ddof)));
}

export function covariance(xs: readonly number[], ys: readonly number[], ddof = 1): number {
  const n = Math.min(xs.length, ys.length);
  if (n <= ddof) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let acc = 0;
  for (let i = 0; i < n; i += 1) acc += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
  return acc / (n - ddof);
}

export function correlation(xs: readonly number[], ys: readonly number[]): number {
  const sx = stdev(xs);
  const sy = stdev(ys);
  if (sx < EPS || sy < EPS) return 0;
  return clamp(covariance(xs, ys) / (sx * sy), -1, 1);
}

/** Spearman rank correlation — robust to the fat tails typical of alt-data. */
export function spearman(xs: readonly number[], ys: readonly number[]): number {
  return correlation(rank(xs), rank(ys));
}

/** Average ranks (1-based), ties share the mean rank. */
export function rank(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(xs.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && (idx[j + 1] as { v: number }).v === (idx[i] as { v: number }).v) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[(idx[k] as { i: number }).i] = avg;
    i = j + 1;
  }
  return out;
}

export function skewness(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs);
  const s = stdev(xs, 1);
  if (s < EPS) return 0;
  let acc = 0;
  for (const x of xs) acc += ((x - m) / s) ** 3;
  return (n / ((n - 1) * (n - 2))) * acc;
}

export function kurtosis(xs: readonly number[]): number {
  /*
   * Excess kurtosis, unbiased (Fisher).
   *
   * The bias correction on the last line takes `g2 = m4/m2² − 3`, and that is a
   * ratio of *population* moments: `m2` is the mean squared deviation, ddof 0.
   * Standardising by the sample standard deviation instead multiplied the whole
   * thing by ((n−1)/n)², biasing the answer low by roughly 2% at n = 100 and 19%
   * at n = 10 — `kurtosis([1..10])` returned −1.7965 where pandas and scipy both
   * give −1.2000.
   */
  const n = xs.length;
  if (n < 4) return 0;
  const m = mean(xs);
  const s = stdev(xs, 0);
  if (s < EPS) return 0;
  let acc = 0;
  for (const x of xs) acc += ((x - m) / s) ** 4;
  const g2 = acc / n - 3;
  return ((n - 1) * ((n + 1) * g2 + 6)) / ((n - 2) * (n - 3));
}

/** Linear-interpolated quantile (type 7, the NumPy/R default). */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = xs.slice().sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const w = pos - lo;
  return (sorted[lo] as number) * (1 - w) + (sorted[hi] as number) * w;
}

export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5);
}

/** Median absolute deviation, scaled to be a consistent σ estimator. */
export function mad(xs: readonly number[], scale = 1.4826): number {
  if (xs.length === 0) return 0;
  const med = median(xs);
  return scale * median(xs.map((x) => Math.abs(x - med)));
}

export function zscore(x: number, mu: number, sigma: number): number {
  return sigma < EPS ? 0 : (x - mu) / sigma;
}

// ── Normal distribution ─────────────────────────────────────────────────────

/** Standard normal pdf. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal cdf via Abramowitz & Stegun 7.1.26 on erf.
 * |ε| < 1.5e-7 — ample for risk-reversal and probability displays.
 */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Inverse standard normal cdf — Acklam's rational approximation refined by one
 * Halley step, giving ~1e-15 relative accuracy across (0, 1).
 */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      ((((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q + (c[3] as number)) * q + (c[4] as number)) * q + (c[5] as number)) /
      ((((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) * q + 1));
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0] as number) * r + (a[1] as number)) * r + (a[2] as number)) * r + (a[3] as number)) * r + (a[4] as number)) * r + (a[5] as number)) * q /
      ((((((b[0] as number) * r + (b[1] as number)) * r + (b[2] as number)) * r + (b[3] as number)) * r + (b[4] as number)) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -((((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q + (c[3] as number)) * q + (c[4] as number)) * q + (c[5] as number)) /
      ((((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) * q + 1));
  }
  /*
   * No refinement step.
   *
   * There used to be a Halley iteration here, "against the high-accuracy cdf".
   * `normCdf` is Abramowitz & Stegun 7.1.26, whose documented error bound is
   * |ε| < 1.5e-7 — this file says so where the function is defined — so the step
   * was correcting an accurate value against an inaccurate one and injecting
   * ε·√(2π)·e^{x²/2} in the process. Measured against a series/continued-fraction
   * reference it cost four to five orders of magnitude:
   *
   *     p        with Halley   Acklam alone
   *     0.75     2.1e-07       2.7e-11
   *     0.975    1.2e-06       3.5e-10
   *     0.999    2.0e-05       1.5e-09
   *     0.0001   7.4e-05       3.3e-09
   *
   * Acklam's rational approximation is accurate to ~1.15e-9 relative across the
   * whole domain on its own, which is what the callers here need: the Gaussian
   * rank transform, the copula h-functions, and the bivariate normal CDF.
   */
  return x;
}

/** Student-t cdf via the regularised incomplete beta function. */
export function studentTCdf(t: number, nu: number): number {
  const x = nu / (nu + t * t);
  const ib = 0.5 * incompleteBeta(nu / 2, 0.5, x);
  return t > 0 ? 1 - ib : ib;
}

/** ln Γ(z) — Lanczos g=7, n=9. */
export function lnGamma(z: number): number {
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  const zz = z - 1;
  let x = g[0] as number;
  for (let i = 1; i < 9; i += 1) x += (g[i] as number) / (zz + i);
  const t = zz + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularised incomplete beta I_x(a,b) via Lentz continued fraction. */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  if (x < (a + 1) / (a + b + 2)) return Math.exp(lbeta) * betacf(a, b, x) / a;
  return 1 - (Math.exp(lbeta) * betacf(b, a, 1 - x)) / b;
}

function betacf(a: number, b: number, x: number): number {
  const tiny = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-16) break;
  }
  return h;
}

// ── Rolling / windowed helpers ──────────────────────────────────────────────

export function rollingMean(xs: readonly number[], window: number): number[] {
  const out = new Array<number>(xs.length).fill(NaN);
  if (window <= 0) return out;
  let acc = 0;
  for (let i = 0; i < xs.length; i += 1) {
    acc += xs[i] as number;
    if (i >= window) acc -= xs[i - window] as number;
    if (i >= window - 1) out[i] = acc / window;
  }
  return out;
}

export function rollingStdev(xs: readonly number[], window: number): number[] {
  const out = new Array<number>(xs.length).fill(NaN);
  if (window <= 1) return out;
  for (let i = window - 1; i < xs.length; i += 1) out[i] = stdev(xs.slice(i - window + 1, i + 1));
  return out;
}

export function diff(xs: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < xs.length; i += 1) out.push((xs[i] as number) - (xs[i - 1] as number));
  return out;
}

export function logReturns(prices: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i += 1) {
    const prev = prices[i - 1] as number;
    const cur = prices[i] as number;
    out.push(prev > 0 && cur > 0 ? Math.log(cur / prev) : 0);
  }
  return out;
}

export function pctReturns(prices: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i += 1) {
    const prev = prices[i - 1] as number;
    out.push(prev === 0 ? 0 : ((prices[i] as number) - prev) / prev);
  }
  return out;
}

/** Ordinary least squares on y = α + βx, plus R². */
export function ols(x: readonly number[], y: readonly number[]): { alpha: number; beta: number; r2: number } {
  const n = Math.min(x.length, y.length);
  if (n < 2) return { alpha: 0, beta: 0, r2: 0 };
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (x[i] as number) - mx;
    const dy = (y[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const beta = sxx < EPS ? 0 : sxy / sxx;
  return { alpha: my - beta * mx, beta, r2: sxx < EPS || syy < EPS ? 0 : (sxy * sxy) / (sxx * syy) };
}

/**
 * Augmented Dickey–Fuller τ statistic, lag 1, **with a constant** — the τ_μ
 * specification:
 *
 *     Δy_t = α + γ·y_{t−1} + δ·Δy_{t−1} + ε,   τ = γ̂ / SE(γ̂)
 *
 * The constant is load-bearing, and the version without it was a silent
 * no-power test. This regression is run on the log-price spread against the
 * benchmark (engine/compute.ts), which is a *level* with a large non-zero mean —
 * across the universe the median window has |mean| 1.073 against a standard
 * deviation of 0.108, so it sits ten of its own sigmas from zero. Forcing the
 * fit through the origin
 * leaves γ̂ ≈ 0 as the only way to reconcile a series that sits away from zero,
 * so the estimator ends up reading the level rather than the reversion. Measured
 * on simulated OU paths (θ = 0.05, stationary σ = 0.08, n = 120): with the
 * constant the mean τ is ≈ −2.16 and rejection at the 5% value ≈ 14%, and both
 * are invariant to μ; without it the mean τ collapses from −1.82 at μ = 0 to
 * −0.16 at μ = −0.78 and rejection to 0%. On live data the published τ had a
 * median of −0.57 and a maximum of +4.48 — a *positive* Dickey–Fuller statistic
 * is a fitted explosive root, which is what reading the level instead of the
 * reversion produces. Recomputed with the constant, the same 63 spreads have a
 * median of −1.46.
 *
 * Including the constant is also what makes the shipped critical value the right
 * one. The null distribution here is τ_μ, whose 5% point is −2.89 at n = 120
 * (measured: −2.85 over 5000 driftless random walks, empirical size at −2.86 of
 * 4.9%) — that is the −2.86 in engine/regime.ts. The no-constant regression has
 * the plain τ null with a 5% point near −1.97, so comparing it to −2.86 was a
 * 0.4% test wearing a 5% label.
 *
 * Solved by the Frisch–Waugh–Lovell equivalence: centring Δy_t, y_{t−1} and
 * Δy_{t−1} and running the same two-regressor normal equations on the centred
 * data reproduces (γ̂, δ̂) and the residuals of the three-regressor fit exactly,
 * so the constant costs one extra pass and one degree of freedom rather than a
 * 3×3 solve.
 */
export function adfStatistic(series: readonly number[]): number {
  const n = series.length;
  if (n < 20) return 0;
  const dy: number[] = [];
  const yLag: number[] = [];
  const dyLag: number[] = [];
  for (let i = 2; i < n; i += 1) {
    dy.push((series[i] as number) - (series[i - 1] as number));
    yLag.push(series[i - 1] as number);
    dyLag.push((series[i - 1] as number) - (series[i - 2] as number));
  }
  const n2 = dy.length;
  const mDy = mean(dy);
  const mYLag = mean(yLag);
  const mDyLag = mean(dyLag);
  let s11 = 0;
  let s12 = 0;
  let s22 = 0;
  let s1y = 0;
  let s2y = 0;
  for (let i = 0; i < n2; i += 1) {
    const a = (yLag[i] as number) - mYLag;
    const b = (dyLag[i] as number) - mDyLag;
    const y = (dy[i] as number) - mDy;
    s11 += a * a;
    s12 += a * b;
    s22 += b * b;
    s1y += a * y;
    s2y += b * y;
  }
  const det = s11 * s22 - s12 * s12;
  if (Math.abs(det) < EPS) return 0;
  const gamma = (s1y * s22 - s2y * s12) / det;
  const delta = (s2y * s11 - s1y * s12) / det;
  // Recovered from the centred solution rather than estimated separately.
  const alpha = mDy - gamma * mYLag - delta * mDyLag;
  let rss = 0;
  for (let i = 0; i < n2; i += 1) {
    const e =
      (dy[i] as number) - alpha - gamma * (yLag[i] as number) - delta * (dyLag[i] as number);
    rss += e * e;
  }
  // Three parameters are estimated now (α, γ, δ), so the residual degrees of
  // freedom are n2 − 3.
  const sigma2 = rss / Math.max(1, n2 - 3);
  const varGamma = (sigma2 * s22) / det;
  return varGamma <= 0 ? 0 : gamma / Math.sqrt(varGamma);
}

/**
 * Anis–Lloyd expected value of R/S for a segment of `m` independent draws:
 *
 *     E[R/S]_m = ((m − 0.5)/m) · Γ((m−1)/2) / (√π·Γ(m/2)) · Σ_{i=1}^{m−1} √((m−i)/i)
 *
 * This is the null against which the observed R/S has to be read. The raw R/S
 * slope is *not* an estimate of H at the sample sizes used here — it converges
 * to 0.5 from above at a rate of roughly 1/√m, which is why the uncorrected
 * estimator reads ≈ 0.62 on pure noise at m ≤ 50.
 *
 * The Γ ratio is evaluated in log space so it stays finite at any segment
 * length; it tends to (m·π/2)^(−1/2), which is the large-m form Peters
 * substitutes above m = 340 to avoid the overflow that `lnGamma` already avoids.
 */
function expectedRescaledRange(m: number): number {
  let acc = 0;
  for (let i = 1; i < m; i += 1) acc += Math.sqrt((m - i) / i);
  const front = Math.exp(lnGamma((m - 1) / 2) - lnGamma(m / 2)) / Math.sqrt(Math.PI);
  return ((m - 0.5) / m) * front * acc;
}

/**
 * Hurst exponent by rescaled-range analysis, Anis–Lloyd corrected; 0.5 = random
 * walk, above = persistent, below = anti-persistent.
 *
 * The correction is the difference between an estimator and a coin flip. R/S on
 * short segments is biased upward under the null, so regressing log(R/S) on
 * log(m) directly — which this used to do — returns H ≈ 0.62 on iid Gaussian
 * noise at n = 100, with 90% of draws above 0.5. That bias was not academic:
 * `engine/regime.ts` maps H onto `persistence = clamp((H − 0.5)/0.15, −1, 1)`,
 * so a 0.62 baseline is a standing vote for "trending" cast before any data is
 * read. The 134 published `hurst_100` values had a mean of 0.625 against the
 * pure-noise baseline of 0.622 — indistinguishable, which is to say the feature
 * carried no information at all — 93% of them sat above 0.5, mean `persistence`
 * was +0.69, and 37% were pinned at the +1 rail. Combined with the ADF above
 * that made `mean_reverting` unreachable: it never once appeared across the 134
 * stored signals, and `regimeMultiplier` scores reversion strategies at 1.3 in
 * that regime against 0.55–0.6 in the trending ones.
 *
 * So the regressand is log(R/S_m) − log(E[R/S]_m) and the slope is H − 0.5.
 * Measured on iid Gaussians at n = 100: mean H = 0.494 over 3000 draws (three
 * seeds, all within 0.007 of 0.5), against 0.62 before. Discrimination is
 * unaffected — AR(1) at φ = −0.7/0/+0.7 reads 0.29/0.49/0.72.
 *
 * One subtlety worth recording, because it looks like an inconsistency: the
 * segment deviation below is the Bessel-corrected one while Anis–Lloyd derive
 * E[R/S] against the population deviation. Those differ by √(m/(m−1)) per
 * segment, a factor that shrinks with m and therefore tilts the slope. It tilts
 * it *toward* the truth here — it offsets the residual finite-m error in the
 * Anis–Lloyd expectation itself. Pairing E[R/S] with the population deviation
 * instead was measured and reads 0.463 on the same noise; the Bessel-corrected
 * pairing reads 0.494. The pairing is chosen by that measurement, not by
 * derivation, and `tests/fix-quant.test.ts` pins the result.
 */
export function hurstExponent(series: readonly number[]): number {
  const n = series.length;
  if (n < 32) return 0.5;
  const sizes: number[] = [];
  for (let s = 8; s <= Math.floor(n / 2); s = Math.floor(s * 1.6)) sizes.push(s);
  if (sizes.length < 2) return 0.5;
  const logN: number[] = [];
  const logRS: number[] = [];
  for (const size of sizes) {
    const chunks = Math.floor(n / size);
    let acc = 0;
    let used = 0;
    for (let c = 0; c < chunks; c += 1) {
      const seg = series.slice(c * size, (c + 1) * size);
      const m = mean(seg);
      let cum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const v of seg) {
        cum += v - m;
        if (cum < min) min = cum;
        if (cum > max) max = cum;
      }
      const s = stdev(seg);
      if (s > EPS) {
        acc += (max - min) / s;
        used += 1;
      }
    }
    if (used > 0) {
      logN.push(Math.log(size));
      logRS.push(Math.log(acc / used) - Math.log(expectedRescaledRange(size)));
    }
  }
  if (logN.length < 2) return 0.5;
  // The regressand is the *excess* over the null, so the slope estimates H − 0.5.
  return clamp(0.5 + ols(logN, logRS).beta, 0, 1);
}
