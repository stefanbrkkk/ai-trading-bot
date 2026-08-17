/**
 * SABR stochastic-volatility model and the 25-delta risk reversal.
 *
 * MASTER §2.2 / Phase 1 §3: "Extrapolate implied volatility using the SABR
 * Model. Extract the 25-Delta Risk Reversal to quantify institutional tail-risk
 * pricing." The dynamics are
 *
 *     dF_t = α_t · F_t^β  dW¹_t
 *     dα_t = ν · α_t      dW²_t
 *     ⟨dW¹, dW²⟩ = ρ dt
 *
 * with α = instantaneous vol level, β = forward-price elasticity (CEV
 * exponent), ν = vol-of-vol, ρ = spot/vol correlation.
 *
 * Implied vol comes from Hagan et al. (2002) "Managing Smile Risk", eq. (2.17a):
 *
 *   σ_B(K,F) = A · (z / x(z)) · [1 + B·T]
 *
 *   A   = α / { (FK)^((1−β)/2) · [1 + ((1−β)²/24)·ln²(F/K) + ((1−β)⁴/1920)·ln⁴(F/K)] }
 *   z   = (ν/α) · (FK)^((1−β)/2) · ln(F/K)
 *   x(z)= ln[ (√(1 − 2ρz + z²) + z − ρ) / (1 − ρ) ]
 *   B   = ((1−β)²/24)·α²/(FK)^(1−β) + (1/4)·(ρβνα)/(FK)^((1−β)/2) + ((2−3ρ²)/24)·ν²
 *
 * ATM (K→F) collapses to
 *   σ_ATM = α/F^(1−β) · [1 + ( ((1−β)²/24)·α²/F^(2−2β) + (1/4)·ρβνα/F^(1−β)
 *                            + ((2−3ρ²)/24)·ν² ) · T ]
 */

import { strikeForDelta } from './blackscholes';
import { EPS, clamp } from './stats';

export interface SabrParams {
  /** α — instantaneous volatility level (> 0). */
  alpha: number;
  /** β — CEV elasticity ∈ [0, 1]. Equity index convention: 0.5. */
  beta: number;
  /** ρ — forward/vol correlation ∈ (−1, 1). Equities are negative (skew). */
  rho: number;
  /** ν — volatility of volatility (> 0). */
  nu: number;
}

export const DEFAULT_BETA = 0.5;

/** Hagan lognormal implied volatility σ_B(K, F, T). */
export function sabrImpliedVol(
  forward: number,
  strike: number,
  tau: number,
  p: SabrParams,
): number {
  const F = Math.max(forward, EPS);
  const K = Math.max(strike, EPS);
  const T = Math.max(tau, EPS);
  const { alpha, beta, rho, nu } = p;
  const oneMinusBeta = 1 - beta;
  const logFK = Math.log(F / K);
  const fkPow = Math.pow(F * K, oneMinusBeta / 2);

  const denomSeries =
    1 +
    ((oneMinusBeta * oneMinusBeta) / 24) * logFK * logFK +
    (Math.pow(oneMinusBeta, 4) / 1920) * Math.pow(logFK, 4);

  const B =
    ((oneMinusBeta * oneMinusBeta) / 24) * ((alpha * alpha) / Math.pow(F * K, oneMinusBeta)) +
    0.25 * ((rho * beta * nu * alpha) / fkPow) +
    ((2 - 3 * rho * rho) / 24) * nu * nu;

  // ATM limit: z/x(z) → 1 as ln(F/K) → 0. Use the series limit to avoid 0/0.
  if (Math.abs(logFK) < 1e-9) {
    return (alpha / Math.pow(F, oneMinusBeta)) * (1 + B * T);
  }

  const z = (nu / alpha) * fkPow * logFK;
  const rhoClamped = clamp(rho, -0.999999, 0.999999);
  const xz = Math.log((Math.sqrt(1 - 2 * rhoClamped * z + z * z) + z - rhoClamped) / (1 - rhoClamped));
  const zOverX = Math.abs(xz) < 1e-12 ? 1 : z / xz;

  const A = alpha / (fkPow * denomSeries);
  return Math.max(A * zOverX * (1 + B * T), 1e-6);
}

/** σ_ATM under SABR. */
export function sabrAtmVol(forward: number, tau: number, p: SabrParams): number {
  return sabrImpliedVol(forward, forward, tau, p);
}

export interface SmileQuote {
  strike: number;
  /** Market implied volatility at this strike. */
  vol: number;
  /** Optional weight (defaults to 1); vega-weighting is the usual choice. */
  weight?: number;
}

export interface SabrCalibration extends SabrParams {
  /** Root-mean-square vol error in volatility points (e.g. 0.0031 = 31bp). */
  rmse: number;
  /** Iterations used by the simplex. */
  iterations: number;
  /** Number of quotes fitted. */
  quotes: number;
  /** True when RMSE ≤ 1 vol point — the smile is well described. */
  converged: boolean;
}

/**
 * Calibrates (α, ρ, ν) with β held fixed — market standard, because β and ρ are
 * jointly unidentifiable from a single smile.
 *
 * Optimiser: Nelder–Mead simplex on an unconstrained reparameterisation
 *   α = exp(u₀),  ρ = tanh(u₁),  ν = exp(u₂)
 * so the iterates can never leave the admissible region and no gradient or
 * external solver is needed.
 */
export function calibrateSabr(
  forward: number,
  tau: number,
  quotes: readonly SmileQuote[],
  options: { beta?: number; initial?: Partial<SabrParams>; maxIterations?: number } = {},
): SabrCalibration {
  const beta = options.beta ?? DEFAULT_BETA;
  const maxIter = options.maxIterations ?? 400;
  const usable = quotes.filter((q) => q.strike > 0 && Number.isFinite(q.vol) && q.vol > 0);

  if (usable.length === 0) {
    const fallback: SabrParams = { alpha: 0.2 * Math.pow(Math.max(forward, EPS), 1 - beta), beta, rho: -0.3, nu: 0.4 };
    return { ...fallback, rmse: 0, iterations: 0, quotes: 0, converged: false };
  }

  // Seed α from the quote closest to ATM: σ_ATM ≈ α / F^(1−β).
  const atmQuote = usable.reduce((best, q) =>
    Math.abs(Math.log(q.strike / forward)) < Math.abs(Math.log(best.strike / forward)) ? q : best,
  );
  const alpha0 = options.initial?.alpha ?? atmQuote.vol * Math.pow(Math.max(forward, EPS), 1 - beta);
  const rho0 = clamp(options.initial?.rho ?? -0.35, -0.95, 0.95);
  const nu0 = Math.max(options.initial?.nu ?? 0.55, 1e-3);

  const objective = (u: number[]): number => {
    const p: SabrParams = {
      alpha: Math.exp(u[0] as number),
      beta,
      rho: Math.tanh(u[1] as number),
      nu: Math.exp(u[2] as number),
    };
    if (!Number.isFinite(p.alpha) || !Number.isFinite(p.nu) || p.alpha <= 0 || p.nu <= 0) return 1e9;
    let sse = 0;
    let wsum = 0;
    for (const q of usable) {
      const model = sabrImpliedVol(forward, q.strike, tau, p);
      if (!Number.isFinite(model)) return 1e9;
      const w = q.weight ?? 1;
      sse += w * (model - q.vol) ** 2;
      wsum += w;
    }
    return wsum < EPS ? 1e9 : sse / wsum;
  };

  const x0 = [Math.log(Math.max(alpha0, 1e-6)), Math.atanh(rho0), Math.log(nu0)];
  const { x, iterations } = nelderMead(objective, x0, { maxIterations: maxIter });

  const fitted: SabrParams = {
    alpha: Math.exp(x[0] as number),
    beta,
    rho: Math.tanh(x[1] as number),
    nu: Math.exp(x[2] as number),
  };
  const rmse = Math.sqrt(objective(x));
  return { ...fitted, rmse, iterations, quotes: usable.length, converged: rmse <= 0.01 };
}

export interface SkewMetrics {
  /** σ at the 25-delta call strike. */
  vol25Call: number;
  /** σ at the 25-delta put strike. */
  vol25Put: number;
  /** σ at the money. */
  volAtm: number;
  /** The 25-delta call strike. */
  strike25Call: number;
  /** The 25-delta put strike. */
  strike25Put: number;
  /**
   * 25-delta risk reversal, RR₂₅ = σ(25Δ call) − σ(25Δ put), in vol points.
   * Negative ⇒ puts bid over calls ⇒ institutions paying for downside tail
   * protection. Positive ⇒ upside call skew (squeeze / takeover pricing).
   */
  riskReversal25: number;
  /** Butterfly, BF₂₅ = (σ_25c + σ_25p)/2 − σ_ATM — smile convexity / kurtosis. */
  butterfly25: number;
  /** RR₂₅ normalised by σ_ATM; the scale-free skew signal fed to the model. */
  normalisedSkew: number;
}

/**
 * Extracts the 25-delta risk reversal from a calibrated SABR surface. Strikes
 * are solved so that the Black–Scholes delta computed *with the SABR vol at
 * that strike* equals ±0.25 (a "smile-consistent" delta, not a flat-vol delta).
 */
export function riskReversal25(
  spot: number,
  tau: number,
  p: SabrParams,
  options: { rate?: number; dividend?: number } = {},
): SkewMetrics {
  const rate = options.rate ?? 0;
  const dividend = options.dividend ?? 0;
  const forward = spot * Math.exp((rate - dividend) * tau);
  const volAt = (k: number): number => sabrImpliedVol(forward, k, tau, p);

  const strike25Call = strikeForDelta(0.25, { spot, tau, type: 'call', rate, dividend, volAt });
  const strike25Put = strikeForDelta(-0.25, { spot, tau, type: 'put', rate, dividend, volAt });

  const vol25Call = volAt(strike25Call);
  const vol25Put = volAt(strike25Put);
  const volAtm = volAt(forward);
  const rr = vol25Call - vol25Put;

  return {
    vol25Call,
    vol25Put,
    volAtm,
    strike25Call,
    strike25Put,
    riskReversal25: rr,
    butterfly25: (vol25Call + vol25Put) / 2 - volAtm,
    normalisedSkew: volAtm < EPS ? 0 : rr / volAtm,
  };
}

/** Dense vol curve for the surface chart, in log-moneyness space. */
export function sabrSmileCurve(
  forward: number,
  tau: number,
  p: SabrParams,
  options: { points?: number; logMoneynessRange?: number } = {},
): { strike: number; logMoneyness: number; vol: number }[] {
  const points = options.points ?? 41;
  const range = options.logMoneynessRange ?? 0.45;
  const out: { strike: number; logMoneyness: number; vol: number }[] = [];
  for (let i = 0; i < points; i += 1) {
    const lm = -range + (2 * range * i) / (points - 1);
    const strike = forward * Math.exp(lm);
    out.push({ strike, logMoneyness: lm, vol: sabrImpliedVol(forward, strike, tau, p) });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Nelder–Mead simplex
// ─────────────────────────────────────────────────────────────────────────────

export interface NelderMeadResult {
  x: number[];
  fx: number;
  iterations: number;
}

/**
 * Derivative-free simplex minimiser (Nelder & Mead 1965) with the standard
 * reflection / expansion / contraction / shrink coefficients. Also used by the
 * copula fitter and the GBDT hyper-parameter search.
 */
export function nelderMead(
  f: (x: number[]) => number,
  x0: readonly number[],
  options: { maxIterations?: number; tolerance?: number; step?: number } = {},
): NelderMeadResult {
  const maxIterations = options.maxIterations ?? 500;
  const tol = options.tolerance ?? 1e-10;
  const step = options.step ?? 0.35;
  const n = x0.length;

  const simplex: { x: number[]; fx: number }[] = [{ x: x0.slice(), fx: f(x0 as number[]) }];
  for (let i = 0; i < n; i += 1) {
    const p = x0.slice();
    p[i] = (p[i] as number) + (Math.abs(p[i] as number) > EPS ? step * (p[i] as number) : step);
    simplex.push({ x: p, fx: f(p) });
  }

  const alpha = 1;
  const gamma = 2;
  const rho = 0.5;
  const sigma = 0.5;
  let iterations = 0;

  for (; iterations < maxIterations; iterations += 1) {
    simplex.sort((a, b) => a.fx - b.fx);
    const best = simplex[0] as { x: number[]; fx: number };
    const worst = simplex[n] as { x: number[]; fx: number };
    const secondWorst = simplex[n - 1] as { x: number[]; fx: number };

    if (Math.abs(worst.fx - best.fx) < tol * (Math.abs(best.fx) + tol)) break;

    const centroid = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        centroid[j] = (centroid[j] as number) + ((simplex[i] as { x: number[] }).x[j] as number) / n;
      }
    }

    const reflect = centroid.map((c, j) => c + alpha * (c - (worst.x[j] as number)));
    const fr = f(reflect);

    if (fr < secondWorst.fx && fr >= best.fx) {
      simplex[n] = { x: reflect, fx: fr };
      continue;
    }
    if (fr < best.fx) {
      const expand = centroid.map((c, j) => c + gamma * ((reflect[j] as number) - c));
      const fe = f(expand);
      simplex[n] = fe < fr ? { x: expand, fx: fe } : { x: reflect, fx: fr };
      continue;
    }
    const contract = centroid.map((c, j) => c + rho * ((worst.x[j] as number) - c));
    const fc = f(contract);
    if (fc < worst.fx) {
      simplex[n] = { x: contract, fx: fc };
      continue;
    }
    for (let i = 1; i <= n; i += 1) {
      const shrunk = (simplex[i] as { x: number[] }).x.map(
        (v, j) => (best.x[j] as number) + sigma * (v - (best.x[j] as number)),
      );
      simplex[i] = { x: shrunk, fx: f(shrunk) };
    }
  }

  simplex.sort((a, b) => a.fx - b.fx);
  const best = simplex[0] as { x: number[]; fx: number };
  return { x: best.x, fx: best.fx, iterations };
}
