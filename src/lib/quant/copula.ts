/**
 * Pair-copula constructions and the Canonical Vine (C-vine).
 *
 * Phase 2 §2: "To model the cross-sectional correlation and asymmetric tail
 * dependencies between disparate streams (e.g. market downturns), we apply
 * Canonical Vine (C-vine) copulas, which decompose the multi-dimensional joint
 * probability density into a hierarchical tree structure."
 *
 * The C-vine density factorisation for d variables is
 *
 *   c(u₁,…,u_d) = Π_{j=1}^{d−1} Π_{i=1}^{d−j}
 *                    c_{j, j+i | 1,…,j−1}( F(u_j | ·), F(u_{j+i} | ·) )
 *
 * Conditional distributions are propagated by the h-function
 *
 *   h(u | v; θ) = ∂C(u, v; θ) / ∂v
 *
 * Asymmetry is where the alpha is: a Gaussian pair copula has zero tail
 * dependence in both tails, Clayton concentrates it in the lower tail (joint
 * crashes) and Gumbel in the upper tail (joint melt-ups). Family selection is
 * therefore per-edge and by AIC.
 */

import { pseudoObservations } from './ecdf';
import { EPS, clamp, normCdf, normInv, studentTCdf, sum } from './stats';

export type CopulaFamily = 'independence' | 'gaussian' | 'student' | 'clayton' | 'gumbel' | 'frank';

export interface PairCopula {
  family: CopulaFamily;
  /** Primary dependence parameter: ρ for elliptical, θ for Archimedean. */
  theta: number;
  /** Degrees of freedom for the Student-t family. */
  nu?: number;
}

export interface TailDependence {
  lower: number;
  upper: number;
}

const CLAMP = (u: number): number => clamp(u, 1e-10, 1 - 1e-10);

// ── Student-t quantile (bisection on the cdf — robust, ~40 iterations) ───────

export function studentTInv(p: number, nu: number): number {
  const target = clamp(p, 1e-12, 1 - 1e-12);
  let lo = -1e4;
  let hi = 1e4;
  for (let i = 0; i < 200; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (studentTCdf(mid, nu) < target) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return 0.5 * (lo + hi);
}

// ── Copula cdf / density / h-function ───────────────────────────────────────

/** Bivariate copula cdf C(u, v). */
export function copulaCdf(c: PairCopula, u: number, v: number): number {
  const uu = CLAMP(u);
  const vv = CLAMP(v);
  switch (c.family) {
    case 'independence':
      return uu * vv;
    case 'gaussian':
      return bivariateNormalCdf(normInv(uu), normInv(vv), clamp(c.theta, -0.9999, 0.9999));
    case 'student': {
      // Approximated by the Gaussian copula cdf at the same ρ; only the density
      // and h-function (which are exact below) enter estimation and sampling.
      return bivariateNormalCdf(normInv(uu), normInv(vv), clamp(c.theta, -0.9999, 0.9999));
    }
    case 'clayton': {
      const t = Math.max(c.theta, 1e-8);
      return Math.pow(Math.max(Math.pow(uu, -t) + Math.pow(vv, -t) - 1, EPS), -1 / t);
    }
    case 'gumbel': {
      const t = Math.max(c.theta, 1);
      const a = Math.pow(-Math.log(uu), t);
      const b = Math.pow(-Math.log(vv), t);
      return Math.exp(-Math.pow(a + b, 1 / t));
    }
    case 'frank': {
      const t = c.theta;
      if (Math.abs(t) < 1e-8) return uu * vv;
      return (
        (-1 / t) *
        Math.log(1 + ((Math.exp(-t * uu) - 1) * (Math.exp(-t * vv) - 1)) / (Math.exp(-t) - 1))
      );
    }
    default:
      return uu * vv;
  }
}

/** Copula density c(u, v) = ∂²C/∂u∂v. */
export function copulaDensity(c: PairCopula, u: number, v: number): number {
  const uu = CLAMP(u);
  const vv = CLAMP(v);
  switch (c.family) {
    case 'independence':
      return 1;
    case 'gaussian': {
      const r = clamp(c.theta, -0.9999, 0.9999);
      const x = normInv(uu);
      const y = normInv(vv);
      const oneMinusR2 = 1 - r * r;
      return (
        (1 / Math.sqrt(oneMinusR2)) *
        Math.exp(-(r * r * (x * x + y * y) - 2 * r * x * y) / (2 * oneMinusR2))
      );
    }
    case 'student': {
      const r = clamp(c.theta, -0.9999, 0.9999);
      const nu = Math.max(c.nu ?? 4, 2.01);
      const x = studentTInv(uu, nu);
      const y = studentTInv(vv, nu);
      const oneMinusR2 = 1 - r * r;
      const q = (x * x - 2 * r * x * y + y * y) / oneMinusR2;
      const lnNum =
        lnGammaFn((nu + 2) / 2) +
        lnGammaFn(nu / 2) -
        2 * lnGammaFn((nu + 1) / 2) -
        0.5 * Math.log(oneMinusR2) -
        ((nu + 2) / 2) * Math.log(1 + q / nu);
      const lnDen =
        -((nu + 1) / 2) * Math.log(1 + (x * x) / nu) - ((nu + 1) / 2) * Math.log(1 + (y * y) / nu);
      return Math.exp(lnNum - lnDen);
    }
    case 'clayton': {
      const t = Math.max(c.theta, 1e-8);
      const s = Math.pow(uu, -t) + Math.pow(vv, -t) - 1;
      if (s <= 0) return EPS;
      return (1 + t) * Math.pow(uu * vv, -t - 1) * Math.pow(s, -1 / t - 2);
    }
    case 'gumbel': {
      const t = Math.max(c.theta, 1);
      const lu = -Math.log(uu);
      const lv = -Math.log(vv);
      const a = Math.pow(lu, t) + Math.pow(lv, t);
      const a1t = Math.pow(a, 1 / t);
      return (
        (Math.exp(-a1t) * Math.pow(lu * lv, t - 1) * (a1t + t - 1) * Math.pow(a, 1 / t - 2)) /
        (uu * vv)
      );
    }
    case 'frank': {
      const t = c.theta;
      if (Math.abs(t) < 1e-8) return 1;
      const e = Math.exp(-t);
      const eu = Math.exp(-t * uu);
      const ev = Math.exp(-t * vv);
      const denom = (e - 1 + (eu - 1) * (ev - 1)) ** 2;
      return denom < EPS ? EPS : (t * (1 - e) * eu * ev) / denom;
    }
    default:
      return 1;
  }
}

function lnGammaFn(z: number): number {
  // Re-exported locally to avoid a circular import with stats' lnGamma usage.
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGammaFn(1 - z);
  const zz = z - 1;
  let x = g[0] as number;
  for (let i = 1; i < 9; i += 1) x += (g[i] as number) / (zz + i);
  const t = zz + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * h-function h(u | v) = ∂C(u,v)/∂v — the conditional cdf of U given V = v.
 * This is the recursion kernel of every vine algorithm.
 */
export function hFunction(c: PairCopula, u: number, v: number): number {
  const uu = CLAMP(u);
  const vv = CLAMP(v);
  switch (c.family) {
    case 'independence':
      return uu;
    case 'gaussian': {
      const r = clamp(c.theta, -0.9999, 0.9999);
      return CLAMP(normCdf((normInv(uu) - r * normInv(vv)) / Math.sqrt(1 - r * r)));
    }
    case 'student': {
      const r = clamp(c.theta, -0.9999, 0.9999);
      const nu = Math.max(c.nu ?? 4, 2.01);
      const x = studentTInv(uu, nu);
      const y = studentTInv(vv, nu);
      const denom = Math.sqrt(((nu + y * y) * (1 - r * r)) / (nu + 1));
      return CLAMP(studentTCdf((x - r * y) / denom, nu + 1));
    }
    case 'clayton': {
      const t = Math.max(c.theta, 1e-8);
      const s = Math.pow(uu, -t) + Math.pow(vv, -t) - 1;
      if (s <= 0) return CLAMP(uu);
      return CLAMP(Math.pow(vv, -t - 1) * Math.pow(s, -1 / t - 1));
    }
    case 'gumbel': {
      const t = Math.max(c.theta, 1);
      const lu = -Math.log(uu);
      const lv = -Math.log(vv);
      const a = Math.pow(lu, t) + Math.pow(lv, t);
      const cdf = Math.exp(-Math.pow(a, 1 / t));
      return CLAMP((cdf * Math.pow(a, 1 / t - 1) * Math.pow(lv, t - 1)) / vv);
    }
    case 'frank': {
      const t = c.theta;
      if (Math.abs(t) < 1e-8) return CLAMP(uu);
      const eu = Math.exp(-t * uu);
      const ev = Math.exp(-t * vv);
      const e = Math.exp(-t);
      const denom = e - 1 + (eu - 1) * (ev - 1);
      return Math.abs(denom) < EPS ? CLAMP(uu) : CLAMP((ev * (eu - 1)) / denom);
    }
    default:
      return CLAMP(uu);
  }
}

/** Inverse h-function: solves h(u | v) = p for u. Needed for vine sampling. */
export function hInverse(c: PairCopula, p: number, v: number): number {
  const target = CLAMP(p);
  if (c.family === 'independence') return target;
  if (c.family === 'gaussian') {
    const r = clamp(c.theta, -0.9999, 0.9999);
    return CLAMP(normCdf(normInv(target) * Math.sqrt(1 - r * r) + r * normInv(v)));
  }
  if (c.family === 'student') {
    const r = clamp(c.theta, -0.9999, 0.9999);
    const nu = Math.max(c.nu ?? 4, 2.01);
    const y = studentTInv(CLAMP(v), nu);
    const denom = Math.sqrt(((nu + y * y) * (1 - r * r)) / (nu + 1));
    return CLAMP(studentTCdf(studentTInv(target, nu + 1) * denom + r * y, nu));
  }
  // Archimedean families: bisect, h is monotone increasing in u.
  let lo = 1e-10;
  let hi = 1 - 1e-10;
  for (let i = 0; i < 80; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (hFunction(c, mid, v) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Analytic tail-dependence coefficients λ_L, λ_U per family. */
export function tailDependence(c: PairCopula): TailDependence {
  switch (c.family) {
    case 'gaussian':
    case 'independence':
    case 'frank':
      return { lower: 0, upper: 0 };
    case 'student': {
      const r = clamp(c.theta, -0.9999, 0.9999);
      const nu = Math.max(c.nu ?? 4, 2.01);
      const arg = -Math.sqrt(((nu + 1) * (1 - r)) / (1 + r));
      const lambda = clamp(2 * studentTCdf(arg, nu + 1), 0, 1);
      return { lower: lambda, upper: lambda };
    }
    case 'clayton':
      return { lower: Math.pow(2, -1 / Math.max(c.theta, 1e-8)), upper: 0 };
    case 'gumbel':
      return { lower: 0, upper: 2 - Math.pow(2, 1 / Math.max(c.theta, 1)) };
    default:
      return { lower: 0, upper: 0 };
  }
}

// ── Kendall's tau and parameter inversion ───────────────────────────────────

/** Kendall's τ_b (ties handled). O(n²) — n here is a few hundred at most. */
export function kendallTau(x: readonly number[], y: readonly number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  let concordant = 0;
  let discordant = 0;
  let tiesX = 0;
  let tiesY = 0;
  for (let i = 0; i < n - 1; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const dx = (x[i] as number) - (x[j] as number);
      const dy = (y[i] as number) - (y[j] as number);
      const p = dx * dy;
      if (p > 0) concordant += 1;
      else if (p < 0) discordant += 1;
      else if (dx === 0 && dy === 0) {
        tiesX += 1;
        tiesY += 1;
      } else if (dx === 0) tiesX += 1;
      else tiesY += 1;
    }
  }
  const d1 = concordant + discordant + tiesX;
  const d2 = concordant + discordant + tiesY;
  const den = Math.sqrt(d1 * d2);
  return den < EPS ? 0 : clamp((concordant - discordant) / den, -1, 1);
}

/** Family parameter from τ by the standard inversion relations. */
export function thetaFromTau(family: CopulaFamily, tau: number): number {
  const t = clamp(tau, -0.98, 0.98);
  switch (family) {
    case 'gaussian':
    case 'student':
      return Math.sin((Math.PI / 2) * t); // ρ = sin(πτ/2)
    case 'clayton':
      return t <= 0 ? 1e-6 : (2 * t) / (1 - t); // θ = 2τ/(1−τ)
    case 'gumbel':
      return t <= 0 ? 1 : 1 / (1 - t); // θ = 1/(1−τ)
    case 'frank':
      return frankThetaFromTau(t);
    default:
      return 0;
  }
}

/** Frank has no closed form; τ(θ) is monotone so bisect it. */
function frankThetaFromTau(tau: number): number {
  if (Math.abs(tau) < 1e-6) return 1e-6;
  const debye1 = (theta: number): number => {
    // D₁(θ) = (1/θ)∫₀^θ t/(eᵗ−1) dt, by 64-point midpoint rule.
    const steps = 64;
    let acc = 0;
    for (let i = 0; i < steps; i += 1) {
      const t = (theta * (i + 0.5)) / steps;
      acc += Math.abs(t) < 1e-12 ? 1 : t / (Math.exp(t) - 1);
    }
    return acc / steps;
  };
  const tauOf = (theta: number): number => 1 - (4 / theta) * (1 - debye1(theta));
  let lo = tau > 0 ? 1e-6 : -60;
  let hi = tau > 0 ? 60 : -1e-6;
  for (let i = 0; i < 100; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (tauOf(mid) < tau) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// ── Pair-copula selection ───────────────────────────────────────────────────

export interface PairFit extends PairCopula {
  logLikelihood: number;
  aic: number;
  tau: number;
  tailDependence: TailDependence;
}

const DEFAULT_FAMILIES: CopulaFamily[] = ['gaussian', 'student', 'clayton', 'gumbel', 'frank'];

/**
 * Fits each candidate family (τ-inversion start, then a 1-D golden-section
 * refinement of the log-likelihood) and returns the best by AIC.
 */
export function selectPairCopula(
  u: readonly number[],
  v: readonly number[],
  families: readonly CopulaFamily[] = DEFAULT_FAMILIES,
): PairFit {
  const n = Math.min(u.length, v.length);
  const tau = kendallTau(u, v);

  if (n < 10 || Math.abs(tau) < 0.02) {
    return {
      family: 'independence',
      theta: 0,
      logLikelihood: 0,
      aic: 0,
      tau,
      tailDependence: { lower: 0, upper: 0 },
    };
  }

  const loglik = (c: PairCopula): number => {
    let acc = 0;
    for (let i = 0; i < n; i += 1) {
      const d = copulaDensity(c, u[i] as number, v[i] as number);
      acc += Math.log(Math.max(d, 1e-300));
    }
    return Number.isFinite(acc) ? acc : -1e12;
  };

  let best: PairFit | null = null;
  for (const family of families) {
    // Rotated Archimedeans are not needed: negative dependence is covered by
    // Gaussian/Student/Frank, and forcing Clayton/Gumbel onto negative τ only
    // produces degenerate fits.
    if ((family === 'clayton' || family === 'gumbel') && tau <= 0) continue;

    const theta0 = thetaFromTau(family, tau);
    const nuGrid = family === 'student' ? [3, 4, 6, 8, 12, 20, 40] : [undefined];

    for (const nu of nuGrid) {
      const bounds = parameterBounds(family);
      const objective = (t: number): number => -loglik({ family, theta: t, nu });
      const theta = goldenSection(objective, bounds[0], bounds[1], theta0);
      const candidate: PairCopula = { family, theta, nu };
      const ll = loglik(candidate);
      const k = family === 'student' ? 2 : 1;
      const aic = -2 * ll + 2 * k;
      if (!best || aic < best.aic) {
        best = { ...candidate, logLikelihood: ll, aic, tau, tailDependence: tailDependence(candidate) };
      }
    }
  }

  return (
    best ?? {
      family: 'independence',
      theta: 0,
      logLikelihood: 0,
      aic: 0,
      tau,
      tailDependence: { lower: 0, upper: 0 },
    }
  );
}

function parameterBounds(family: CopulaFamily): [number, number] {
  switch (family) {
    case 'gaussian':
    case 'student':
      return [-0.995, 0.995];
    case 'clayton':
      return [1e-4, 28];
    case 'gumbel':
      return [1.0001, 20];
    case 'frank':
      return [-45, 45];
    default:
      return [0, 0];
  }
}

/** Golden-section minimiser on [lo, hi], warm-started near `seed`. */
function goldenSection(f: (x: number) => number, lo: number, hi: number, seed: number): number {
  const invPhi = (Math.sqrt(5) - 1) / 2;
  // Narrow the bracket around the τ-inversion seed to keep the search stable.
  const span = (hi - lo) * 0.5;
  let a = Math.max(lo, seed - span);
  let b = Math.min(hi, seed + span);
  if (b - a < 1e-9) return clamp(seed, lo, hi);
  let c = b - invPhi * (b - a);
  let d = a + invPhi * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < 80 && b - a > 1e-8; i += 1) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - invPhi * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + invPhi * (b - a);
      fd = f(d);
    }
  }
  return clamp(0.5 * (a + b), lo, hi);
}

// ── C-vine ──────────────────────────────────────────────────────────────────

export interface CVineEdge {
  tree: number;
  /** Conditioned variable indices (into the original column order). */
  a: number;
  b: number;
  /** Conditioning set for this edge. */
  conditioning: number[];
  copula: PairFit;
}

export interface CVineModel {
  /** Dimension d. */
  d: number;
  /** Root ordering: order[0] is the tree-1 root. */
  order: number[];
  /** All d(d−1)/2 edges, tree-major. */
  edges: CVineEdge[];
  /** Total log-likelihood. */
  logLikelihood: number;
  /** AIC across all edges. */
  aic: number;
  /** Column labels for reporting. */
  labels: string[];
  /** Sample size. */
  n: number;
}

/**
 * Fits a C-vine by sequential estimation (Aas et al. 2009, Algorithm 3):
 *   tree 1 pairs the root with every other variable;
 *   the h-function then produces the conditional pseudo-observations that
 *   tree 2 consumes, and so on.
 *
 * Root ordering greedily selects the variable with the largest Σ|τ| to the
 * remaining set, which is the standard C-vine heuristic and puts the most
 * connected stream (usually the market factor) at the top of the hierarchy.
 */
export function fitCVine(
  columns: readonly (readonly number[])[],
  options: { labels?: string[]; families?: CopulaFamily[]; alreadyUniform?: boolean } = {},
): CVineModel {
  const d = columns.length;
  const labels = options.labels ?? columns.map((_, i) => `x${i}`);
  if (d < 2) {
    return { d, order: d === 1 ? [0] : [], edges: [], logLikelihood: 0, aic: 0, labels, n: 0 };
  }

  const n = Math.min(...columns.map((c) => c.length));
  const uniform: number[][] = columns.map((c) =>
    options.alreadyUniform ? c.slice(0, n).map(CLAMP) : pseudoObservations(c.slice(0, n)),
  );

  // Greedy root ordering by total absolute Kendall's tau.
  const remaining = Array.from({ length: d }, (_, i) => i);
  const order: number[] = [];
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < remaining.length; i += 1) {
      const vi = remaining[i] as number;
      let score = 0;
      for (const vj of remaining) {
        if (vj === vi) continue;
        score += Math.abs(kendallTau(uniform[vi] as number[], uniform[vj] as number[]));
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    order.push(remaining[bestIdx] as number);
    remaining.splice(bestIdx, 1);
  }

  const edges: CVineEdge[] = [];
  let logLikelihood = 0;
  let aic = 0;

  // `current[k]` holds the pseudo-observations for order[k] conditioned on the
  // roots processed so far.
  let current: number[][] = order.map((idx) => (uniform[idx] as number[]).slice());
  const conditioning: number[] = [];

  for (let tree = 1; tree < d; tree += 1) {
    const rootSeries = current[0] as number[];
    const rootVar = order[tree - 1] as number;
    const next: number[][] = [];
    for (let k = 1; k < current.length; k += 1) {
      const other = current[k] as number[];
      const otherVar = order[tree - 1 + k] as number;
      const fit = selectPairCopula(other, rootSeries, options.families);
      edges.push({
        tree,
        a: otherVar,
        b: rootVar,
        conditioning: conditioning.slice(),
        copula: fit,
      });
      logLikelihood += fit.logLikelihood;
      aic += fit.aic;
      next.push(other.map((uu, i) => hFunction(fit, uu, rootSeries[i] as number)));
    }
    conditioning.push(rootVar);
    current = next;
    if (current.length === 0) break;
  }

  return { d, order, edges, logLikelihood, aic, labels, n };
}

/** Joint log-density of one uniform observation under the fitted vine. */
export function cVineLogDensity(model: CVineModel, u: readonly number[]): number {
  const order = model.order;
  let current = order.map((idx) => CLAMP(u[idx] as number));
  let acc = 0;
  let edgeIdx = 0;
  for (let tree = 1; tree < model.d; tree += 1) {
    const root = current[0] as number;
    const next: number[] = [];
    for (let k = 1; k < current.length; k += 1) {
      const edge = model.edges[edgeIdx] as CVineEdge | undefined;
      if (!edge) break;
      edgeIdx += 1;
      const other = current[k] as number;
      acc += Math.log(Math.max(copulaDensity(edge.copula, other, root), 1e-300));
      next.push(hFunction(edge.copula, other, root));
    }
    current = next;
    if (current.length === 0) break;
  }
  return acc;
}

/**
 * Simulates from the fitted C-vine (Aas et al. Algorithm 4, C-vine form).
 * Used to Monte-Carlo the joint tail of the alt-data streams.
 */
export function sampleCVine(model: CVineModel, uniforms: readonly number[]): number[] {
  const d = model.d;
  const w = uniforms.slice(0, d).map(CLAMP);
  const x = new Array<number>(d).fill(0);
  // v[i][j] holds intermediate conditional values.
  const v: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));

  x[0] = w[0] as number;
  (v[0] as number[])[0] = x[0] as number;

  const edgeAt = (tree: number, position: number): CVineEdge | undefined =>
    model.edges.find((e) => e.tree === tree && e.a === (model.order[tree - 1 + position] as number));

  for (let i = 1; i < d; i += 1) {
    let value = w[i] as number;
    for (let k = i - 1; k >= 0; k -= 1) {
      const edge = edgeAt(k + 1, i - k);
      if (!edge) continue;
      value = hInverse(edge.copula, value, (v[k] as number[])[k] as number);
    }
    x[i] = value;
    (v[i] as number[])[i] = value;
    for (let j = 0; j < i; j += 1) {
      const edge = edgeAt(j + 1, i - j);
      if (!edge) continue;
      (v[i] as number[])[j] = hFunction(edge.copula, (v[i] as number[])[i] as number, (v[j] as number[])[j] as number);
      (v[i] as number[])[i] = (v[i] as number[])[j] as number;
    }
  }

  // Map back from vine order to original column order.
  const out = new Array<number>(d).fill(0.5);
  for (let k = 0; k < d; k += 1) out[model.order[k] as number] = x[k] as number;
  return out;
}

/**
 * Systemic joint-downside probability: P(all streams below their q-quantile),
 * estimated from the fitted vine copula cdf via Monte-Carlo on the vine sampler.
 * This is the "market downturn" co-movement number the risk panel reports.
 */
export function jointTailProbability(
  model: CVineModel,
  q: number,
  draws: number,
  nextUniform: () => number,
): number {
  if (model.d === 0 || draws <= 0) return 0;
  let hits = 0;
  for (let s = 0; s < draws; s += 1) {
    const u = sampleCVine(model, Array.from({ length: model.d }, nextUniform));
    if (u.every((v) => v <= q)) hits += 1;
  }
  return hits / draws;
}

/** Average pairwise tail dependence across tree-1 edges — a systemic-risk gauge. */
export function vineTailSummary(model: CVineModel): TailDependence {
  const tree1 = model.edges.filter((e) => e.tree === 1);
  if (tree1.length === 0) return { lower: 0, upper: 0 };
  return {
    lower: sum(tree1.map((e) => e.copula.tailDependence.lower)) / tree1.length,
    upper: sum(tree1.map((e) => e.copula.tailDependence.upper)) / tree1.length,
  };
}

// ── Bivariate normal cdf (Drezner–Wesolowsky) ───────────────────────────────

/** Φ₂(x, y; ρ) with |ε| < 1e-14; 20-point Gauss–Legendre on the ρ integral. */
export function bivariateNormalCdf(x: number, y: number, rho: number): number {
  const r = clamp(rho, -0.999999, 0.999999);
  if (Math.abs(r) < 1e-12) return normCdf(x) * normCdf(y);
  const w = [
    0.017614007139152, 0.040601429800387, 0.062672048334109, 0.083276741576705, 0.10193011981724,
    0.118194531961518, 0.131688638449177, 0.142096109318382, 0.149172986472604, 0.152753387130726,
  ];
  const t = [
    0.993128599185095, 0.963971927277914, 0.912234428251326, 0.839116971822219, 0.746331906460151,
    0.636053680726515, 0.510867001950827, 0.37370608871542, 0.227785851141645, 0.076526521133497,
  ];
  let acc = 0;
  for (let i = 0; i < 10; i += 1) {
    for (const s of [-1, 1]) {
      const rr = (r * (1 + s * (t[i] as number))) / 2;
      const den = Math.sqrt(1 - rr * rr);
      acc += (w[i] as number) * Math.exp(-(x * x - 2 * rr * x * y + y * y) / (2 * den * den)) / den;
    }
  }
  return clamp(normCdf(x) * normCdf(y) + (r / (4 * Math.PI)) * acc, 0, 1);
}
