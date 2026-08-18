/**
 * The C-vine behind the portfolio's joint-downside panel.
 *
 * Two properties are load-bearing and neither is obvious from reading the code.
 *
 * The first is that hoisting the marginal quantiles out of the optimiser did not
 * change any fit. `selectPairCopula` used to map u and v through `normInv` or
 * `studentTInv` inside the likelihood, on every one of the optimiser's ~70
 * iterations, for each of seven candidate ν — and `studentTInv` is a 200-step
 * bisection over the incomplete beta. Fitting one pair at 504 observations took
 * 3.5 s, which made a four-holding vine 22 s and an eight-holding one 99 s on a
 * route the portfolio page polls every minute. The quantiles do not depend on
 * the parameter being optimised, so they are now computed once. That is a pure
 * speedup only if the likelihood it evaluates is arithmetically the same one.
 *
 * The second is that `maxTrees: 1` is sound for what the panel publishes. Tail
 * dependence is a property of a pair, and `vineTailSummary` reads only tree-1
 * edges, so the conditional trees above it cost d(d−1)/2 pair estimations and
 * change nothing that reaches the page.
 */

import { describe, expect, it } from 'vitest';
import {
  copulaDensity,
  fitCVine,
  selectPairCopula,
  tailDependence,
  vineTailSummary,
} from '@/lib/quant/copula';
import { pseudoObservations } from '@/lib/quant/ecdf';
import { createRng } from '@/lib/quant/rng';

/** Correlated columns with a controllable amount of shared factor. */
function columns(count: number, n: number, shared: number, seed: string): number[][] {
  const rng = createRng(seed);
  const out: number[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < n; i += 1) {
    const factor = rng.next() - 0.5;
    for (let c = 0; c < count; c += 1) {
      (out[c] as number[]).push(shared * factor + (1 - shared) * (rng.next() - 0.5));
    }
  }
  return out;
}

/** The likelihood written the original way, through the public density. */
function densityLoglik(
  fit: { family: string; theta: number; nu?: number },
  u: readonly number[],
  v: readonly number[],
): number {
  let acc = 0;
  for (let i = 0; i < u.length; i += 1) {
    acc += Math.log(Math.max(copulaDensity(fit as never, u[i] as number, v[i] as number), 1e-300));
  }
  return acc;
}

describe('selectPairCopula', () => {
  it('reports the likelihood copulaDensity would give for the same fit', () => {
    for (let trial = 0; trial < 8; trial += 1) {
      const [x, y] = columns(2, 300, 0.1 + trial * 0.11, `equiv-${trial}`);
      const u = pseudoObservations(x as number[]);
      const v = pseudoObservations(y as number[]);
      const fit = selectPairCopula(u, v);
      const recomputed = densityLoglik(fit, u, v);
      const relative =
        Math.abs(recomputed - fit.logLikelihood) / Math.max(1, Math.abs(fit.logLikelihood));
      expect(relative, `${fit.family} theta=${fit.theta} nu=${fit.nu}`).toBeLessThan(1e-9);
    }
  });

  it('calls independence when there is nothing to model', () => {
    const [x, y] = columns(2, 300, 0, 'independent');
    const fit = selectPairCopula(pseudoObservations(x as number[]), pseudoObservations(y as number[]));
    expect(['independence', 'gaussian', 'frank']).toContain(fit.family);
    expect(Math.abs(fit.tau)).toBeLessThan(0.15);
  });

  it('finds more tail dependence in a more dependent pair', () => {
    const weak = columns(2, 400, 0.2, 'weak');
    const strong = columns(2, 400, 0.85, 'strong');
    const a = selectPairCopula(pseudoObservations(weak[0] as number[]), pseudoObservations(weak[1] as number[]));
    const b = selectPairCopula(pseudoObservations(strong[0] as number[]), pseudoObservations(strong[1] as number[]));
    expect(Math.abs(b.tau)).toBeGreaterThan(Math.abs(a.tau));
  });
});

describe('tailDependence', () => {
  it('is exactly zero for the families that have no tail dependence', () => {
    for (const family of ['gaussian', 'frank', 'independence'] as const) {
      expect(tailDependence({ family, theta: 0.8 })).toEqual({ lower: 0, upper: 0 });
    }
  });

  it('is in [0, 1] and lower-only for Clayton, upper-only for Gumbel', () => {
    const clayton = tailDependence({ family: 'clayton', theta: 2 });
    expect(clayton.lower).toBeGreaterThan(0);
    expect(clayton.lower).toBeLessThanOrEqual(1);
    expect(clayton.upper).toBe(0);

    const gumbel = tailDependence({ family: 'gumbel', theta: 2 });
    expect(gumbel.upper).toBeGreaterThan(0);
    expect(gumbel.upper).toBeLessThanOrEqual(1);
    expect(gumbel.lower).toBe(0);
  });

  it('rises with the correlation of a Student-t pair', () => {
    const low = tailDependence({ family: 'student', theta: 0.2, nu: 5 }).lower;
    const high = tailDependence({ family: 'student', theta: 0.8, nu: 5 }).lower;
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(1);
  });
});

describe('fitCVine', () => {
  it('gives the same tree-1 edges and tail summary whether or not the higher trees are fitted', () => {
    const cols = columns(6, 252, 0.55, 'trees');
    const full = fitCVine(cols, { labels: ['a', 'b', 'c', 'd', 'e', 'f'] });
    const firstOnly = fitCVine(cols, { labels: ['a', 'b', 'c', 'd', 'e', 'f'], maxTrees: 1 });

    expect(firstOnly.order).toEqual(full.order);

    const tree1 = (m: typeof full) => m.edges.filter((e) => e.tree === 1);
    expect(tree1(firstOnly)).toEqual(tree1(full));
    // And nothing above tree 1 was fitted.
    expect(firstOnly.edges.every((e) => e.tree === 1)).toBe(true);
    expect(firstOnly.edges).toHaveLength(cols.length - 1);

    // The published statistic is identical, which is the point of the option.
    expect(vineTailSummary(firstOnly)).toEqual(vineTailSummary(full));
  });

  it('reports a tail summary inside [0, 1] at every book size', () => {
    for (const d of [2, 4, 8]) {
      const model = fitCVine(columns(d, 252, 0.5, `size-${d}`), { maxTrees: 1 });
      const summary = vineTailSummary(model);
      expect(summary.lower, `d=${d}`).toBeGreaterThanOrEqual(0);
      expect(summary.lower, `d=${d}`).toBeLessThanOrEqual(1);
      expect(summary.upper, `d=${d}`).toBeGreaterThanOrEqual(0);
      expect(summary.upper, `d=${d}`).toBeLessThanOrEqual(1);
    }
  });

  it('degenerates safely below two columns', () => {
    expect(fitCVine([], {}).edges).toHaveLength(0);
    expect(fitCVine([[1, 2, 3]], {}).edges).toHaveLength(0);
    expect(vineTailSummary(fitCVine([], {}))).toEqual({ lower: 0, upper: 0 });
  });

  it('fits a twelve-column book fast enough for a request to wait on it', () => {
    const started = Date.now();
    fitCVine(columns(12, 252, 0.5, 'perf'), { maxTrees: 1 });
    const elapsed = Date.now() - started;
    // Measured at ~730 ms; the ceiling catches an order-of-magnitude regression
    // such as reintroducing the per-iteration quantile inversions.
    expect(elapsed, `${elapsed}ms`).toBeLessThan(8000);
  });
});
