/**
 * Empirical Cumulative Distribution Function normalisation.
 *
 * Phase 2 §2: "Traditional Gaussian normalization fails on alt-data; therefore,
 * we utilize the Empirical Cumulative Distribution Function. The ECDF
 * transforms raw values into a uniform distribution strictly on the interval
 * [0,1], completely neutralizing scale differences while preserving the exact
 * rank-relationships of extreme events."
 *
 *     F_n(x) = (1/n) · Σ_i 1{ X_i ≤ x }
 *
 * The plotting-position form (r − a)/(n + 1 − 2a) with a = 0 is used for the
 * transform so the image is the open interval (0, 1). That matters because the
 * copula layer applies Φ⁻¹ / t⁻¹ to these values, and exactly 0 or 1 would map
 * to ±∞.
 */

import { EPS, clamp, normInv } from './stats';

export interface EcdfModel {
  /** Ascending sorted sample used as the empirical support. */
  support: number[];
  /** Sample size. */
  n: number;
  min: number;
  max: number;
}

export function fitEcdf(samples: readonly number[]): EcdfModel {
  const support = samples.filter(Number.isFinite).slice().sort((a, b) => a - b);
  return {
    support,
    n: support.length,
    min: support.length ? (support[0] as number) : 0,
    max: support.length ? (support[support.length - 1] as number) : 0,
  };
}

/** Count of support values ≤ x, by binary search (upper bound). */
function countLessOrEqual(support: readonly number[], x: number): number {
  let lo = 0;
  let hi = support.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((support[mid] as number) <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Raw ECDF F_n(x) ∈ [0, 1]. */
export function ecdf(model: EcdfModel, x: number): number {
  if (model.n === 0) return 0.5;
  return countLessOrEqual(model.support, x) / model.n;
}

/**
 * ECDF transform mapped to the open interval (0, 1) via the plotting position
 * r/(n+1). This is the canonical "pseudo-observation" used for copula fitting.
 */
export function ecdfTransform(model: EcdfModel, x: number): number {
  if (model.n === 0) return 0.5;
  const r = countLessOrEqual(model.support, x);
  return clamp(r / (model.n + 1), 1 / (model.n + 1), model.n / (model.n + 1));
}

/** Empirical quantile — the ECDF's inverse, by linear interpolation. */
export function ecdfInverse(model: EcdfModel, p: number): number {
  if (model.n === 0) return 0;
  const pos = clamp(p, 0, 1) * (model.n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const w = pos - lo;
  return (model.support[lo] as number) * (1 - w) + (model.support[hi] as number) * w;
}

/**
 * Pseudo-observations for a whole sample: rank_i / (n + 1).
 * Ties receive the average rank, matching R's `pobs`.
 */
export function pseudoObservations(samples: readonly number[]): number[] {
  const n = samples.length;
  if (n === 0) return [];
  const idx = samples.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && (idx[j + 1] as { v: number }).v === (idx[i] as { v: number }).v) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[(idx[k] as { i: number }).i] = avg;
    i = j + 1;
  }
  return ranks.map((r) => r / (n + 1));
}

/**
 * Gaussian-rank ("van der Waerden") score: Φ⁻¹(ECDF(x)).
 * Gives a standard-normal-shaped feature that still preserves the empirical
 * ordering, which is what the tree ensemble and the neural agents ingest.
 */
export function gaussianRankTransform(model: EcdfModel, x: number): number {
  return normInv(ecdfTransform(model, x));
}

/**
 * Streaming ECDF over a bounded ring buffer. Alt-data arrives continuously and
 * we need an online uniform transform without holding the entire history.
 */
export class StreamingEcdf {
  private readonly buffer: number[] = [];
  private sorted: number[] = [];
  private dirty = false;

  constructor(private readonly capacity: number = 4096) {}

  push(x: number): void {
    if (!Number.isFinite(x)) return;
    this.buffer.push(x);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    this.dirty = true;
  }

  get size(): number {
    return this.buffer.length;
  }

  private ensureSorted(): void {
    if (!this.dirty) return;
    this.sorted = this.buffer.slice().sort((a, b) => a - b);
    this.dirty = false;
  }

  /** ECDF transform of x against the current window, on (0, 1). */
  transform(x: number): number {
    this.ensureSorted();
    const n = this.sorted.length;
    if (n === 0) return 0.5;
    return clamp(countLessOrEqual(this.sorted, x) / (n + 1), 1 / (n + 1), n / (n + 1));
  }

  quantile(p: number): number {
    this.ensureSorted();
    return ecdfInverse({ support: this.sorted, n: this.sorted.length, min: 0, max: 0 }, p);
  }

  snapshot(): EcdfModel {
    this.ensureSorted();
    return {
      support: this.sorted.slice(),
      n: this.sorted.length,
      min: this.sorted[0] ?? 0,
      max: this.sorted[this.sorted.length - 1] ?? 0,
    };
  }
}

/**
 * Winsorised robust z-score, used where a bounded-but-signed feature reads
 * better than a uniform one (e.g. the SHAP force-plot axis).
 */
export function robustScale(x: number, median: number, madScale: number, cap = 4): number {
  if (madScale < EPS) return 0;
  return clamp((x - median) / madScale, -cap, cap);
}
