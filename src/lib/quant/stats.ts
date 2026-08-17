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
  // Excess kurtosis, unbiased (Fisher).
  const n = xs.length;
  if (n < 4) return 0;
  const m = mean(xs);
  const s = stdev(xs, 1);
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
  // One Halley refinement against the high-accuracy cdf.
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
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

/** Augmented Dickey–Fuller τ statistic (no drift, lag 1) for stationarity. */
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
  // Two-regressor OLS: Δy_t = γ·y_{t-1} + δ·Δy_{t-1} + ε
  const n2 = dy.length;
  let s11 = 0;
  let s12 = 0;
  let s22 = 0;
  let s1y = 0;
  let s2y = 0;
  for (let i = 0; i < n2; i += 1) {
    const a = yLag[i] as number;
    const b = dyLag[i] as number;
    const y = dy[i] as number;
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
  let rss = 0;
  for (let i = 0; i < n2; i += 1) {
    const e = (dy[i] as number) - gamma * (yLag[i] as number) - delta * (dyLag[i] as number);
    rss += e * e;
  }
  const sigma2 = rss / Math.max(1, n2 - 2);
  const varGamma = (sigma2 * s22) / det;
  return varGamma <= 0 ? 0 : gamma / Math.sqrt(varGamma);
}

/** Hurst exponent by rescaled-range analysis; 0.5 = random walk. */
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
      logRS.push(Math.log(acc / used));
    }
  }
  if (logN.length < 2) return 0.5;
  return clamp(ols(logN, logRS).beta, 0, 1);
}
