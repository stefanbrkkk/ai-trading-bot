/**
 * Principal Component Analysis via the symmetric eigendecomposition of the
 * sample covariance (or correlation) matrix.
 *
 * MASTER §2.2: "Filter noise using Principal Component Analysis, extracting the
 * first principal component eigenvector to dictate microsecond execution."
 * Deep limit-order-book data is highly collinear; the first PC distils millions
 * of level updates into one orthogonal directional-intent signal.
 */

import { type Matrix, type Vector, covarianceMatrix, dot, symmetricEigen } from './linalg';
import { EPS, mean, stdev } from './stats';

export interface PcaModel {
  /** Column means used for centring. */
  center: Vector;
  /** Column scales used (all 1 when `standardise` is false). */
  scale: Vector;
  /** Eigenvalues λ_k, descending. */
  eigenvalues: number[];
  /** `components[k]` is the k-th unit eigenvector (loadings). */
  components: Vector[];
  /** λ_k / Σλ. */
  explainedVarianceRatio: number[];
  /** Cumulative explained variance. */
  cumulativeVarianceRatio: number[];
  /** Number of observations the model was fitted on. */
  n: number;
}

export interface PcaOptions {
  /** Divide each column by its standard deviation before decomposing. */
  standardise?: boolean;
  /** Keep at most this many components. */
  maxComponents?: number;
}

export function fitPca(samples: readonly Vector[], options: PcaOptions = {}): PcaModel {
  const n = samples.length;
  if (n === 0) {
    return {
      center: [],
      scale: [],
      eigenvalues: [],
      components: [],
      explainedVarianceRatio: [],
      cumulativeVarianceRatio: [],
      n: 0,
    };
  }
  const d = (samples[0] as Vector).length;
  const columns: number[][] = Array.from({ length: d }, (_, j) => samples.map((s) => s[j] as number));
  const center = columns.map((c) => mean(c));
  const scale = options.standardise ? columns.map((c) => Math.max(stdev(c), EPS)) : new Array<number>(d).fill(1);

  const normalised: Vector[] = samples.map((s) =>
    s.map((v, j) => (v - (center[j] as number)) / (scale[j] as number)),
  );

  const cov: Matrix = covarianceMatrix(normalised, 1);
  const eig = symmetricEigen(cov);

  const keep = Math.min(options.maxComponents ?? d, eig.values.length);
  const eigenvalues = eig.values.slice(0, keep).map((v) => Math.max(v, 0));
  const components = eig.vectors.slice(0, keep);
  const total = eig.values.reduce((a, b) => a + Math.max(b, 0), 0);
  const ratios = eigenvalues.map((v) => (total < EPS ? 0 : v / total));
  const cumulative: number[] = [];
  let acc = 0;
  for (const r of ratios) {
    acc += r;
    cumulative.push(acc);
  }

  return {
    center,
    scale,
    eigenvalues,
    components,
    explainedVarianceRatio: ratios,
    cumulativeVarianceRatio: cumulative,
    n,
  };
}

/** Projects one observation onto the retained components (the PC scores). */
export function pcaTransform(model: PcaModel, x: Vector): number[] {
  const z = x.map((v, j) => (v - (model.center[j] ?? 0)) / (model.scale[j] ?? 1));
  return model.components.map((c) => dot(c, z));
}

/** Score on the first principal component only — the hot path for MLOFI. */
export function pcaFirstScore(model: PcaModel, x: Vector): number {
  const pc1 = model.components[0];
  if (!pc1) return 0;
  const z = x.map((v, j) => (v - (model.center[j] ?? 0)) / (model.scale[j] ?? 1));
  return dot(pc1, z);
}

/** Reconstructs an observation from its scores (for residual/noise analysis). */
export function pcaInverse(model: PcaModel, scores: readonly number[]): Vector {
  const d = model.center.length;
  const out = new Array<number>(d).fill(0);
  for (let k = 0; k < model.components.length && k < scores.length; k += 1) {
    const c = model.components[k] as Vector;
    const s = scores[k] as number;
    for (let j = 0; j < d; j += 1) out[j] = (out[j] as number) + s * (c[j] as number);
  }
  return out.map((v, j) => v * (model.scale[j] ?? 1) + (model.center[j] ?? 0));
}

/**
 * Smallest k with cumulative explained variance ≥ `threshold`.
 * Used to report how much of the order book is genuinely one-dimensional.
 */
export function componentsForVariance(model: PcaModel, threshold = 0.9): number {
  for (let i = 0; i < model.cumulativeVarianceRatio.length; i += 1) {
    if ((model.cumulativeVarianceRatio[i] as number) >= threshold) return i + 1;
  }
  return model.components.length;
}
