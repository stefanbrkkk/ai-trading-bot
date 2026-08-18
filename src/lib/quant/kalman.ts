/**
 * Kalman filter state-space estimation.
 *
 * The requirement: replace Ordinary Least Squares with a Kalman filter so the
 * estimate adapts to heteroskedasticity instead of giving equal weight across a
 * fixed lookback, and draw the execution bands from it — "Kalman Innovation
 * Bands" — because the error covariance P updates on every tick from the
 * observed residual variance, the execution bands expand and contract with the
 * live regime rather than with a historical 20-period standard deviation.
 *
 * Predict:
 *     x̂_{k|k−1} = F · x̂_{k−1|k−1}
 *     P_{k|k−1}  = F · P_{k−1|k−1} · Fᵀ + Q
 *
 * Update:
 *     ỹ_k = z_k − H · x̂_{k|k−1}                (innovation / measurement residual)
 *     S_k = H · P_{k|k−1} · Hᵀ + R             (innovation covariance)
 *     K_k = P_{k|k−1} · Hᵀ · S_k⁻¹             (Kalman gain)
 *     x̂_{k|k} = x̂_{k|k−1} + K_k · ỹ_k
 *     P_{k|k}  = (I − K_k·H) · P_{k|k−1} · (I − K_k·H)ᵀ + K_k·R·K_kᵀ   (Joseph form)
 *
 * The Joseph form is used deliberately: it keeps P symmetric positive
 * semi-definite over long tick streams where the shorter (I − KH)P update
 * accumulates asymmetry and eventually diverges.
 */

import {
  type Matrix,
  type Vector,
  identity,
  inverse,
  matAdd,
  matMul,
  matSub,
  matVec,
  transpose,
  vecAdd,
  vecSub,
  zeros,
} from './linalg';
import { EPS } from './stats';

export interface KalmanConfig {
  /** State transition F (n×n). */
  F: Matrix;
  /** Observation model H (m×n). */
  H: Matrix;
  /** Process noise covariance Q (n×n). */
  Q: Matrix;
  /** Measurement noise covariance R (m×m). */
  R: Matrix;
  /** Initial state x̂₀ (n). */
  x0: Vector;
  /** Initial covariance P₀ (n×n). */
  P0: Matrix;
  /**
   * Exponential forgetting factor for the adaptive R estimator (Sage–Husa).
   * 0 disables adaptation; 0.98 is the default used by the innovation bands.
   */
  adaptiveR?: number;
}

export interface KalmanStep {
  /** Posterior state estimate x̂_{k|k}. */
  state: Vector;
  /** Posterior covariance P_{k|k}. */
  covariance: Matrix;
  /** Innovation ỹ_k. */
  innovation: Vector;
  /** Innovation covariance S_k. */
  innovationCovariance: Matrix;
  /** Kalman gain K_k. */
  gain: Matrix;
  /** Normalised innovation ỹ / √S — the standardised surprise of this tick. */
  standardisedInnovation: number;
  /** One-step-ahead prediction H·x̂_{k|k−1}. */
  prediction: number;
  /** Gaussian log-likelihood contribution of this observation. */
  logLikelihood: number;
}

export class KalmanFilter {
  private F: Matrix;
  private H: Matrix;
  private Q: Matrix;
  private R: Matrix;
  private x: Vector;
  private P: Matrix;
  private readonly n: number;
  private readonly m: number;
  private readonly lambda: number;
  private observations = 0;
  private cumulativeLogLik = 0;

  constructor(config: KalmanConfig) {
    this.F = config.F;
    this.H = config.H;
    this.Q = config.Q;
    this.R = config.R;
    this.x = config.x0.slice();
    this.P = config.P0.map((r) => r.slice());
    this.n = config.x0.length;
    this.m = config.H.length;
    this.lambda = config.adaptiveR ?? 0;
  }

  get state(): Vector {
    return this.x.slice();
  }

  get covariance(): Matrix {
    return this.P.map((r) => r.slice());
  }

  get measurementNoise(): Matrix {
    return this.R.map((r) => r.slice());
  }

  get logLikelihood(): number {
    return this.cumulativeLogLik;
  }

  get count(): number {
    return this.observations;
  }

  /** Predicted measurement H·F·x̂ before seeing z_k. */
  predict(): Vector {
    return matVec(this.H, matVec(this.F, this.x));
  }

  step(z: Vector | number): KalmanStep {
    const zv = typeof z === 'number' ? [z] : z;

    // ── Predict ──
    const xPred = matVec(this.F, this.x);
    const Ppred = matAdd(matMul(matMul(this.F, this.P), transpose(this.F)), this.Q);

    // ── Update ──
    const Ht = transpose(this.H);
    const innovation = vecSub(zv, matVec(this.H, xPred));
    const S = matAdd(matMul(matMul(this.H, Ppred), Ht), this.R);
    const Sinv = safeInverse(S);
    const K = matMul(matMul(Ppred, Ht), Sinv);

    const xPost = vecAdd(xPred, matVec(K, innovation));
    const IKH = matSub(identity(this.n), matMul(K, this.H));
    const Ppost = matAdd(
      matMul(matMul(IKH, Ppred), transpose(IKH)),
      matMul(matMul(K, this.R), transpose(K)),
    );

    this.x = xPost;
    this.P = symmetrise(Ppost);
    this.observations += 1;

    // Sage–Husa adaptive measurement noise: R ← λR + (1−λ)(ỹỹᵀ − H·P⁻·Hᵀ).
    // This is what makes the innovation bands respond to a volatility shock on
    // the very tick it happens rather than after the window rolls off.
    if (this.lambda > 0 && this.lambda < 1) {
      const yyT = outerProduct(innovation, innovation);
      const hph = matMul(matMul(this.H, Ppred), Ht);
      const candidate = matSub(yyT, hph);
      const next = zeros(this.m, this.m);
      for (let i = 0; i < this.m; i += 1) {
        for (let j = 0; j < this.m; j += 1) {
          const v =
            this.lambda * ((this.R[i] as Vector)[j] as number) +
            (1 - this.lambda) * ((candidate[i] as Vector)[j] as number);
          (next[i] as Vector)[j] = i === j ? Math.max(v, 1e-10) : v;
        }
      }
      this.R = symmetrise(next);
    }

    const s00 = Math.max((S[0] as Vector)[0] as number, EPS);
    const y0 = innovation[0] as number;
    const logLik = -0.5 * (Math.log(2 * Math.PI * s00) + (y0 * y0) / s00);
    this.cumulativeLogLik += logLik;

    return {
      state: xPost.slice(),
      covariance: this.P.map((r) => r.slice()),
      innovation,
      innovationCovariance: S,
      gain: K,
      standardisedInnovation: y0 / Math.sqrt(s00),
      prediction: (matVec(this.H, xPred)[0] as number) ?? 0,
      logLikelihood: logLik,
    };
  }
}

function symmetrise(a: Matrix): Matrix {
  const n = a.length;
  const out = zeros(n, n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      (out[i] as Vector)[j] = 0.5 * (((a[i] as Vector)[j] as number) + ((a[j] as Vector)[i] as number));
    }
  }
  return out;
}

function outerProduct(a: Vector, b: Vector): Matrix {
  return a.map((x) => b.map((y) => x * y));
}

function safeInverse(a: Matrix): Matrix {
  try {
    return inverse(a);
  } catch {
    return inverse(matAdd(a, identity(a.length, 1e-9)));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Kalman Innovation Bands (Phase 1 §4.1)
// ─────────────────────────────────────────────────────────────────────────────

export interface InnovationBandPoint {
  /** Filtered fair value (local level). */
  level: number;
  /** Filtered local slope, per bar. */
  slope: number;
  /** level ± k·√S — the dynamic execution channel. */
  upper: number;
  lower: number;
  /** Channel half-width. */
  width: number;
  /** Standardised innovation: how surprising this print was, in σ. */
  z: number;
  /** √S — the live one-step-ahead forecast standard deviation. */
  forecastSigma: number;
  /** Trace of P: total state uncertainty, used for confidence gating. */
  uncertainty: number;
}

/**
 * Local-level + local-trend (integrated random walk) model:
 *
 *     x = [level, slope]ᵀ
 *     F = [[1, 1], [0, 1]]
 *     H = [[1, 0]]
 *
 * Q is scaled by `processNoise` (how fast fair value is allowed to move) and R
 * by `measurementNoise` (assumed microstructure noise: bid–ask bounce, phantom
 * liquidity). Both are then adapted online.
 */
export function kalmanInnovationBands(
  prices: readonly number[],
  options: {
    k?: number;
    processNoise?: number;
    measurementNoise?: number;
    adaptiveR?: number;
  } = {},
): InnovationBandPoint[] {
  const k = options.k ?? 2;
  const q = options.processNoise ?? 1e-4;
  const r0 = options.measurementNoise ?? 1e-2;
  if (prices.length === 0) return [];

  const first = prices[0] as number;
  const scale = Math.max(Math.abs(first), 1);

  const filter = new KalmanFilter({
    F: [
      [1, 1],
      [0, 1],
    ],
    H: [[1, 0]],
    // Trend noise is deliberately an order of magnitude below level noise so the
    // slope estimate stays smooth while the level tracks ticks.
    Q: [
      [q * scale * scale, 0],
      [0, q * scale * scale * 0.01],
    ],
    R: [[r0 * scale * scale]],
    x0: [first, 0],
    P0: [
      [scale * scale * 1e-2, 0],
      [0, scale * scale * 1e-4],
    ],
    adaptiveR: options.adaptiveR ?? 0.98,
  });

  const out: InnovationBandPoint[] = [];
  for (const price of prices) {
    const step = filter.step(price);
    const level = step.state[0] as number;
    const slope = step.state[1] as number;
    const s = Math.sqrt(Math.max((step.innovationCovariance[0] as Vector)[0] as number, EPS));
    const width = k * s;
    out.push({
      level,
      slope,
      upper: level + width,
      lower: level - width,
      width,
      z: step.standardisedInnovation,
      forecastSigma: s,
      uncertainty: (step.covariance[0] as Vector)[0] as number,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Dynamic hedge ratio (pairs / statistical arbitrage)
// ─────────────────────────────────────────────────────────────────────────────

export interface DynamicHedgePoint {
  alpha: number;
  beta: number;
  spread: number;
  spreadSigma: number;
  z: number;
}

/**
 * Time-varying regression y_t = α_t + β_t·x_t + ε with a random-walk state — the
 * state-space replacement for a rolling OLS hedge ratio.
 *
 * Published as part of the `kalman` module's declared API surface
 * (docs/BUILD_CONTRACT.md §kalman), with no caller inside the platform. Said
 * plainly because the docstring used to claim the opposite: the shipped OU
 * calibrator does *not* consume this. `engine/compute.ts` builds its spread as a
 * fixed unit-β log difference, log(close) − log(benchmarkClose), fits it with
 * `fitOu` and publishes that as `ou_zscore`. Nothing on that path reaches this
 * function, so a β estimated here has never moved a number a user sees.
 */
export function dynamicHedgeRatio(
  y: readonly number[],
  x: readonly number[],
  options: { processNoise?: number; measurementNoise?: number } = {},
): DynamicHedgePoint[] {
  const n = Math.min(y.length, x.length);
  if (n === 0) return [];
  const delta = options.processNoise ?? 1e-5;
  const r = options.measurementNoise ?? 1e-3;

  const filter = new KalmanFilter({
    F: identity(2),
    H: [[1, x[0] as number]],
    Q: [
      [delta, 0],
      [0, delta],
    ],
    R: [[r]],
    x0: [y[0] as number, 0],
    P0: identity(2, 1),
    adaptiveR: 0.99,
  });

  const out: DynamicHedgePoint[] = [];
  for (let i = 0; i < n; i += 1) {
    // H is time-varying (it carries the regressor), so it is rebuilt each step.
    (filter as unknown as { H: Matrix }).H = [[1, x[i] as number]];
    const step = filter.step(y[i] as number);
    const alpha = step.state[0] as number;
    const beta = step.state[1] as number;
    /*
     * The spread is the *a priori* residual, and it has to be.
     *
     * This was `y − α_post − β_post·x`, computed from a state that had already
     * absorbed `y[i]`, while `spreadSigma` is √S — the standard deviation of the
     * a priori innovation. Dividing one by the other pairs two different
     * quantities, and the mismatch grows with the filter's gain: at
     * `processNoise = 1e-2` the posterior residual collapses to zero by
     * construction, so the reported z collapses toward zero exactly on the
     * largest dislocations — "at fair value" for the widest gap in the series.
     * The `ou_zscore` the reversion strategy trades does not come from here (see
     * the function docstring), so this was a defect in a published-but-uncalled
     * export rather than one that reached a user.
     *
     * `step.innovation` is the residual `S` is the variance of. It was already
     * being computed and thrown away.
     */
    const spread = (step.innovation as Vector)[0] as number;
    const sigma = Math.sqrt(Math.max((step.innovationCovariance[0] as Vector)[0] as number, EPS));
    out.push({ alpha, beta, spread, spreadSigma: sigma, z: sigma < EPS ? 0 : spread / sigma });
  }
  return out;
}
