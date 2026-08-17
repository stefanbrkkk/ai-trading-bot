/**
 * K-Means with WCSS elbow selection — the SHAP background summariser.
 *
 * XAI research §Background Summarisation: "assemble the historical feature
 * matrix… run K-Means over a sweep of k; compute
 * WCSS(k) = Σ_j Σ_{x∈C_j} ‖x − μ_j‖²; render an elbow plot; select k at the
 * elbow; emit 50–100 centroid rows as the SHAP background dataset."
 *
 * The point is that the SHAP expected value must be taken over a background
 * distribution that still represents the market's regimes — compressing
 * millions of ticks to 50–100 centroids preserves the variance structure while
 * making the attribution baseline cheap and stable.
 */

import { EPS } from './stats';

export interface KMeansResult {
  /** k centroids, each a d-vector. */
  centroids: number[][];
  /** Cluster index per input row. */
  assignments: number[];
  /** Membership counts per cluster — the background sample weights. */
  counts: number[];
  /** Normalised membership weights summing to 1. */
  weights: number[];
  /** Within-cluster sum of squares at convergence. */
  wcss: number;
  iterations: number;
  k: number;
  converged: boolean;
}

/** Squared Euclidean distance. */
function sqDist(a: readonly number[], b: readonly number[]): number {
  let acc = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = (a[i] as number) - (b[i] as number);
    acc += d * d;
  }
  return acc;
}

/**
 * k-means++ seeding: the first centroid is uniform, each subsequent one is drawn
 * with probability proportional to D(x)² from the nearest chosen centroid. This
 * is what makes a single run reliable enough that we do not need restarts.
 */
function kmeansPlusPlusInit(
  data: readonly (readonly number[])[],
  k: number,
  random: () => number,
): number[][] {
  const n = data.length;
  const centroids: number[][] = [];
  centroids.push((data[Math.floor(random() * n) % n] as number[]).slice());

  const closest = new Float64Array(n).fill(Infinity);
  for (let c = 1; c < k; c += 1) {
    let total = 0;
    const latest = centroids[c - 1] as number[];
    for (let i = 0; i < n; i += 1) {
      const d = sqDist(data[i] as number[], latest);
      if (d < (closest[i] as number)) closest[i] = d;
      total += closest[i] as number;
    }
    if (total < EPS) {
      centroids.push((data[Math.floor(random() * n) % n] as number[]).slice());
      continue;
    }
    let target = random() * total;
    let chosen = n - 1;
    for (let i = 0; i < n; i += 1) {
      target -= closest[i] as number;
      if (target <= 0) {
        chosen = i;
        break;
      }
    }
    centroids.push((data[chosen] as number[]).slice());
  }
  return centroids;
}

export function kMeans(
  data: readonly (readonly number[])[],
  k: number,
  options: { maxIterations?: number; tolerance?: number; random?: () => number } = {},
): KMeansResult {
  const n = data.length;
  const kk = Math.max(1, Math.min(k, n));
  const maxIterations = options.maxIterations ?? 60;
  const tolerance = options.tolerance ?? 1e-8;
  const random = options.random ?? (() => 0.5);

  if (n === 0) {
    return { centroids: [], assignments: [], counts: [], weights: [], wcss: 0, iterations: 0, k: 0, converged: true };
  }
  const d = (data[0] as number[]).length;

  let centroids = kmeansPlusPlusInit(data, kk, random);
  const assignments = new Array<number>(n).fill(0);
  let previousWcss = Infinity;
  let iterations = 0;
  let converged = false;

  for (; iterations < maxIterations; iterations += 1) {
    // Assign.
    let wcss = 0;
    for (let i = 0; i < n; i += 1) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c += 1) {
        const dist = sqDist(data[i] as number[], centroids[c] as number[]);
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      assignments[i] = best;
      wcss += bestDist;
    }

    // Update.
    const sums: number[][] = Array.from({ length: centroids.length }, () => new Array<number>(d).fill(0));
    const counts = new Array<number>(centroids.length).fill(0);
    for (let i = 0; i < n; i += 1) {
      const c = assignments[i] as number;
      counts[c] = (counts[c] as number) + 1;
      const row = data[i] as number[];
      const acc = sums[c] as number[];
      for (let j = 0; j < d; j += 1) acc[j] = (acc[j] as number) + (row[j] as number);
    }
    const next: number[][] = centroids.map((old, c) => {
      const count = counts[c] as number;
      if (count === 0) return old.slice(); // keep an empty cluster where it is
      return (sums[c] as number[]).map((v) => v / count);
    });
    centroids = next;

    if (Math.abs(previousWcss - wcss) <= tolerance * Math.max(1, Math.abs(previousWcss))) {
      previousWcss = wcss;
      converged = true;
      iterations += 1;
      break;
    }
    previousWcss = wcss;
  }

  const counts = new Array<number>(centroids.length).fill(0);
  let wcss = 0;
  for (let i = 0; i < n; i += 1) {
    let best = 0;
    let bestDist = Infinity;
    for (let c = 0; c < centroids.length; c += 1) {
      const dist = sqDist(data[i] as number[], centroids[c] as number[]);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    assignments[i] = best;
    counts[best] = (counts[best] as number) + 1;
    wcss += bestDist;
  }

  return {
    centroids,
    assignments,
    counts,
    weights: counts.map((c) => c / n),
    wcss,
    iterations,
    k: centroids.length,
    converged,
  };
}

export interface ElbowPoint {
  k: number;
  wcss: number;
  /** Perpendicular distance from the (k_min, wcss_min)–(k_max, wcss_max) chord. */
  distance: number;
}

export interface ElbowSelection {
  curve: ElbowPoint[];
  /** k at the elbow, by maximum perpendicular distance from the chord. */
  kSelected: number;
  result: KMeansResult;
}

/**
 * Sweeps k over `range` and picks the elbow by the "kneedle" criterion — the
 * point with the greatest perpendicular distance from the straight line joining
 * the first and last points of the WCSS curve. Deterministic, and it never
 * needs a human to look at a plot.
 */
export function selectKByElbow(
  data: readonly (readonly number[])[],
  range: [number, number],
  options: { step?: number; random?: () => number; maxIterations?: number } = {},
): ElbowSelection {
  const step = options.step ?? Math.max(1, Math.round((range[1] - range[0]) / 10));
  const candidates: number[] = [];
  for (let k = range[0]; k <= range[1]; k += step) candidates.push(k);
  if (candidates[candidates.length - 1] !== range[1]) candidates.push(range[1]);

  const runs = candidates.map((k) => ({ k, run: kMeans(data, k, options) }));
  const curve: ElbowPoint[] = runs.map((r) => ({ k: r.k, wcss: r.run.wcss, distance: 0 }));

  if (curve.length < 3) {
    const chosen = runs[runs.length - 1] as { k: number; run: KMeansResult };
    return { curve, kSelected: chosen.k, result: chosen.run };
  }

  const first = curve[0] as ElbowPoint;
  const lastPoint = curve[curve.length - 1] as ElbowPoint;
  const dx = lastPoint.k - first.k;
  const dy = lastPoint.wcss - first.wcss;
  const chordLength = Math.sqrt(dx * dx + dy * dy);

  let bestIndex = 0;
  let bestDistance = -1;
  for (let i = 0; i < curve.length; i += 1) {
    const p = curve[i] as ElbowPoint;
    const distance =
      chordLength < EPS
        ? 0
        : Math.abs(dy * (p.k - first.k) - dx * (p.wcss - first.wcss)) / chordLength;
    p.distance = distance;
    if (distance > bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  const chosen = runs[bestIndex] as { k: number; run: KMeansResult };
  return { curve, kSelected: chosen.k, result: chosen.run };
}

/**
 * Builds the SHAP background dataset: sweep k over [kMin, kMax] (defaults 50–100
 * per the research mandate), take the elbow, and return the centroids with
 * their membership weights.
 */
export function buildShapBackground(
  featureMatrix: readonly (readonly number[])[],
  options: { kMin?: number; kMax?: number; random?: () => number } = {},
): { background: number[][]; weights: number[]; kSelected: number; curve: ElbowPoint[] } {
  const kMin = options.kMin ?? 50;
  const kMax = options.kMax ?? 100;
  if (featureMatrix.length <= kMin) {
    return {
      background: featureMatrix.map((r) => r.slice()),
      weights: featureMatrix.map(() => 1 / Math.max(1, featureMatrix.length)),
      kSelected: featureMatrix.length,
      curve: [],
    };
  }
  const selection = selectKByElbow(featureMatrix, [kMin, Math.min(kMax, featureMatrix.length - 1)], {
    step: Math.max(1, Math.round((kMax - kMin) / 6)),
    random: options.random,
    maxIterations: 40,
  });
  return {
    background: selection.result.centroids,
    weights: selection.result.weights,
    kSelected: selection.kSelected,
    curve: selection.curve,
  };
}
