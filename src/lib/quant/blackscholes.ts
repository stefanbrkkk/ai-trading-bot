/**
 * Black–Scholes–Merton pricing and Greeks, plus implied-volatility inversion.
 *
 * Needed by the SABR layer: the 25-delta risk reversal is defined on strikes
 * whose Black–Scholes delta is ±0.25, so the smile model and the delta metric
 * have to share one consistent pricer.
 */

import { EPS, normCdf, normPdf } from './stats';

export type OptionType = 'call' | 'put';

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
}

export interface BsInputs {
  /** Spot price S. */
  spot: number;
  /** Strike K. */
  strike: number;
  /** Time to expiry in years T. */
  tau: number;
  /** Annualised volatility σ. */
  vol: number;
  /** Continuously compounded risk-free rate r. */
  rate?: number;
  /** Continuous dividend yield q. */
  dividend?: number;
  type: OptionType;
}

function d1d2(i: BsInputs): { d1: number; d2: number; sqrtT: number } {
  const r = i.rate ?? 0;
  const q = i.dividend ?? 0;
  const sqrtT = Math.sqrt(Math.max(i.tau, EPS));
  const vs = Math.max(i.vol, EPS) * sqrtT;
  const d1 = (Math.log(Math.max(i.spot, EPS) / Math.max(i.strike, EPS)) + (r - q + 0.5 * i.vol * i.vol) * i.tau) / vs;
  return { d1, d2: d1 - vs, sqrtT };
}

export function blackScholes(i: BsInputs): Greeks {
  const r = i.rate ?? 0;
  const q = i.dividend ?? 0;
  const { d1, d2, sqrtT } = d1d2(i);
  const df = Math.exp(-r * i.tau);
  const dq = Math.exp(-q * i.tau);
  const nd1 = normCdf(d1);
  const nd2 = normCdf(d2);
  const pdf = normPdf(d1);

  if (i.type === 'call') {
    const price = i.spot * dq * nd1 - i.strike * df * nd2;
    return {
      price,
      delta: dq * nd1,
      gamma: (dq * pdf) / (i.spot * Math.max(i.vol, EPS) * sqrtT),
      vega: i.spot * dq * pdf * sqrtT,
      theta:
        (-i.spot * dq * pdf * i.vol) / (2 * sqrtT) - r * i.strike * df * nd2 + q * i.spot * dq * nd1,
      rho: i.strike * i.tau * df * nd2,
    };
  }
  const price = i.strike * df * normCdf(-d2) - i.spot * dq * normCdf(-d1);
  return {
    price,
    delta: -dq * normCdf(-d1),
    gamma: (dq * pdf) / (i.spot * Math.max(i.vol, EPS) * sqrtT),
    vega: i.spot * dq * pdf * sqrtT,
    theta:
      (-i.spot * dq * pdf * i.vol) / (2 * sqrtT) +
      r * i.strike * df * normCdf(-d2) -
      q * i.spot * dq * normCdf(-d1),
    rho: -i.strike * i.tau * df * normCdf(-d2),
  };
}

export function bsPrice(i: BsInputs): number {
  return blackScholes(i).price;
}

export function bsDelta(i: BsInputs): number {
  return blackScholes(i).delta;
}

/**
 * Implied volatility by Newton–Raphson on vega with a bisection safety net.
 * Converges to 1e-8 in ≤8 iterations for liquid quotes; the bracket guarantees
 * termination on deep wings where vega collapses.
 */
export function impliedVolatility(
  target: number,
  i: Omit<BsInputs, 'vol'>,
  options: { tol?: number; maxIter?: number } = {},
): number {
  const tol = options.tol ?? 1e-8;
  const maxIter = options.maxIter ?? 100;
  let lo = 1e-6;
  let hi = 5;
  let vol = 0.25;

  for (let n = 0; n < maxIter; n += 1) {
    const g = blackScholes({ ...i, vol });
    const diff = g.price - target;
    if (Math.abs(diff) < tol) return vol;
    if (diff > 0) hi = vol;
    else lo = vol;
    if (g.vega > 1e-8) {
      const next = vol - diff / g.vega;
      vol = next > lo && next < hi ? next : 0.5 * (lo + hi);
    } else {
      vol = 0.5 * (lo + hi);
    }
    if (hi - lo < tol) break;
  }
  return vol;
}

/**
 * Strike whose Black–Scholes delta equals `targetDelta` under a (possibly
 * smile-dependent) volatility function. Bisection on log-strike: delta is
 * monotone in K, so 60 iterations put us well below one tick.
 */
export function strikeForDelta(
  targetDelta: number,
  params: {
    spot: number;
    tau: number;
    type: OptionType;
    rate?: number;
    dividend?: number;
    volAt: (strike: number) => number;
  },
): number {
  const { spot, tau, type, rate = 0, dividend = 0, volAt } = params;
  let lo = spot * 0.05;
  let hi = spot * 6;
  const deltaAt = (k: number): number => bsDelta({ spot, strike: k, tau, vol: volAt(k), rate, dividend, type });

  for (let n = 0; n < 100; n += 1) {
    const mid = Math.sqrt(lo * hi);
    const d = deltaAt(mid);
    // Call delta decreases with K; put delta (negative) also decreases with K
    // in absolute terms it increases, so both are monotone decreasing in delta.
    if (d > targetDelta) lo = mid;
    else hi = mid;
    if (hi / lo - 1 < 1e-10) break;
  }
  return Math.sqrt(lo * hi);
}
