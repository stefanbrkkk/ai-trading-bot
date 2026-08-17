/**
 * Dense linear algebra for the quant core.
 *
 * Matrices are row-major `number[][]`. Sizes here are small (Kalman state ≤ 4,
 * MLOFI covariance ≤ 10×10, GBDT feature blocks ≤ 64) so the readable O(n³)
 * implementations are the right trade-off: no typed-array plumbing, no
 * dependencies, and every routine is exercised by unit tests with analytic
 * expectations.
 */

import { EPS } from './stats';

export type Matrix = number[][];
export type Vector = number[];

export function zeros(rows: number, cols: number): Matrix {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
}

export function identity(n: number, scale = 1): Matrix {
  const m = zeros(n, n);
  for (let i = 0; i < n; i += 1) (m[i] as Vector)[i] = scale;
  return m;
}

export function diag(values: readonly number[]): Matrix {
  const m = zeros(values.length, values.length);
  for (let i = 0; i < values.length; i += 1) (m[i] as Vector)[i] = values[i] as number;
  return m;
}

export function cloneMatrix(a: Matrix): Matrix {
  return a.map((row) => row.slice());
}

export function shape(a: Matrix): [number, number] {
  return [a.length, a.length === 0 ? 0 : (a[0] as Vector).length];
}

export function transpose(a: Matrix): Matrix {
  const [r, c] = shape(a);
  const out = zeros(c, r);
  for (let i = 0; i < r; i += 1) for (let j = 0; j < c; j += 1) (out[j] as Vector)[i] = (a[i] as Vector)[j] as number;
  return out;
}

export function matMul(a: Matrix, b: Matrix): Matrix {
  const [ar, ac] = shape(a);
  const [br, bc] = shape(b);
  if (ac !== br) throw new Error(`matMul: dimension mismatch ${ar}x${ac} · ${br}x${bc}`);
  const out = zeros(ar, bc);
  for (let i = 0; i < ar; i += 1) {
    const ai = a[i] as Vector;
    const oi = out[i] as Vector;
    for (let k = 0; k < ac; k += 1) {
      const aik = ai[k] as number;
      if (aik === 0) continue;
      const bk = b[k] as Vector;
      for (let j = 0; j < bc; j += 1) oi[j] = (oi[j] as number) + aik * (bk[j] as number);
    }
  }
  return out;
}

export function matVec(a: Matrix, v: Vector): Vector {
  const [r, c] = shape(a);
  if (c !== v.length) throw new Error(`matVec: dimension mismatch ${r}x${c} · ${v.length}`);
  const out = new Array<number>(r).fill(0);
  for (let i = 0; i < r; i += 1) {
    const row = a[i] as Vector;
    let acc = 0;
    for (let j = 0; j < c; j += 1) acc += (row[j] as number) * (v[j] as number);
    out[i] = acc;
  }
  return out;
}

export function matAdd(a: Matrix, b: Matrix): Matrix {
  return a.map((row, i) => row.map((x, j) => x + ((b[i] as Vector)[j] as number)));
}

export function matSub(a: Matrix, b: Matrix): Matrix {
  return a.map((row, i) => row.map((x, j) => x - ((b[i] as Vector)[j] as number)));
}

export function matScale(a: Matrix, s: number): Matrix {
  return a.map((row) => row.map((x) => x * s));
}

export function vecAdd(a: Vector, b: Vector): Vector {
  return a.map((x, i) => x + (b[i] as number));
}

export function vecSub(a: Vector, b: Vector): Vector {
  return a.map((x, i) => x - (b[i] as number));
}

export function vecScale(a: Vector, s: number): Vector {
  return a.map((x) => x * s);
}

export function dot(a: Vector, b: Vector): number {
  let acc = 0;
  for (let i = 0; i < a.length; i += 1) acc += (a[i] as number) * (b[i] as number);
  return acc;
}

export function norm(a: Vector): number {
  return Math.sqrt(dot(a, a));
}

/** Outer product a·bᵀ. */
export function outer(a: Vector, b: Vector): Matrix {
  return a.map((x) => b.map((y) => x * y));
}

/**
 * Gauss–Jordan inverse with partial pivoting.
 * Throws on a singular matrix — callers that expect near-singular input should
 * use `pseudoInverse` or add Tikhonov ridge first.
 */
export function inverse(a: Matrix): Matrix {
  const n = a.length;
  const m = cloneMatrix(a);
  const inv = identity(n);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    let best = Math.abs((m[col] as Vector)[col] as number);
    for (let r = col + 1; r < n; r += 1) {
      const v = Math.abs((m[r] as Vector)[col] as number);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-14) throw new Error(`inverse: singular matrix at column ${col}`);
    if (pivot !== col) {
      const t1 = m[col] as Vector;
      m[col] = m[pivot] as Vector;
      m[pivot] = t1;
      const t2 = inv[col] as Vector;
      inv[col] = inv[pivot] as Vector;
      inv[pivot] = t2;
    }
    const pv = (m[col] as Vector)[col] as number;
    for (let j = 0; j < n; j += 1) {
      (m[col] as Vector)[j] = ((m[col] as Vector)[j] as number) / pv;
      (inv[col] as Vector)[j] = ((inv[col] as Vector)[j] as number) / pv;
    }
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = (m[r] as Vector)[col] as number;
      if (f === 0) continue;
      for (let j = 0; j < n; j += 1) {
        (m[r] as Vector)[j] = ((m[r] as Vector)[j] as number) - f * ((m[col] as Vector)[j] as number);
        (inv[r] as Vector)[j] = ((inv[r] as Vector)[j] as number) - f * ((inv[col] as Vector)[j] as number);
      }
    }
  }
  return inv;
}

/** Inverse with Tikhonov regularisation — safe for rank-deficient covariance. */
export function ridgeInverse(a: Matrix, lambda = 1e-8): Matrix {
  return inverse(matAdd(a, identity(a.length, lambda)));
}

/** Cholesky factor L with A = L·Lᵀ; jitters the diagonal until PD. */
export function cholesky(a: Matrix, maxJitter = 8): Matrix {
  const n = a.length;
  let jitter = 0;
  for (let attempt = 0; attempt <= maxJitter; attempt += 1) {
    const l = zeros(n, n);
    let ok = true;
    for (let i = 0; i < n && ok; i += 1) {
      for (let j = 0; j <= i; j += 1) {
        let acc = ((a[i] as Vector)[j] as number) + (i === j ? jitter : 0);
        for (let k = 0; k < j; k += 1) acc -= ((l[i] as Vector)[k] as number) * ((l[j] as Vector)[k] as number);
        if (i === j) {
          if (acc <= 1e-15) {
            ok = false;
            break;
          }
          (l[i] as Vector)[j] = Math.sqrt(acc);
        } else {
          (l[i] as Vector)[j] = acc / ((l[j] as Vector)[j] as number);
        }
      }
    }
    if (ok) return l;
    jitter = jitter === 0 ? 1e-10 : jitter * 100;
  }
  throw new Error('cholesky: matrix is not positive definite');
}

export function trace(a: Matrix): number {
  let acc = 0;
  for (let i = 0; i < a.length; i += 1) acc += (a[i] as Vector)[i] as number;
  return acc;
}

/** Sample covariance matrix of column-observations (rows = samples). */
export function covarianceMatrix(samples: readonly Vector[], ddof = 1): Matrix {
  const n = samples.length;
  if (n === 0) return [];
  const d = (samples[0] as Vector).length;
  const means = new Array<number>(d).fill(0);
  for (const s of samples) for (let j = 0; j < d; j += 1) means[j] = (means[j] as number) + ((s[j] as number) / n);
  const cov = zeros(d, d);
  const denom = Math.max(1, n - ddof);
  for (const s of samples) {
    for (let i = 0; i < d; i += 1) {
      const di = (s[i] as number) - (means[i] as number);
      for (let j = i; j < d; j += 1) {
        const dj = (s[j] as number) - (means[j] as number);
        (cov[i] as Vector)[j] = ((cov[i] as Vector)[j] as number) + (di * dj) / denom;
      }
    }
  }
  for (let i = 0; i < d; i += 1) for (let j = 0; j < i; j += 1) (cov[i] as Vector)[j] = (cov[j] as Vector)[i] as number;
  return cov;
}

export interface Eigen {
  values: number[];
  /** `vectors[k]` is the unit eigenvector for `values[k]`, descending by |λ|. */
  vectors: Vector[];
}

/**
 * Symmetric eigendecomposition by the cyclic Jacobi rotation method.
 * Exact to machine precision for the symmetric PSD covariance matrices we feed
 * it, and needs no external LAPACK.
 */
export function symmetricEigen(input: Matrix, maxSweeps = 100): Eigen {
  const n = input.length;
  if (n === 0) return { values: [], vectors: [] };
  const a = cloneMatrix(input);
  let v = identity(n);

  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let off = 0;
    for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) off += ((a[i] as Vector)[j] as number) ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = (a[p] as Vector)[q] as number;
        if (Math.abs(apq) < 1e-18) continue;
        const app = (a[p] as Vector)[p] as number;
        const aqq = (a[q] as Vector)[q] as number;
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k += 1) {
          const akp = (a[k] as Vector)[p] as number;
          const akq = (a[k] as Vector)[q] as number;
          (a[k] as Vector)[p] = c * akp - s * akq;
          (a[k] as Vector)[q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = (a[p] as Vector)[k] as number;
          const aqk = (a[q] as Vector)[k] as number;
          (a[p] as Vector)[k] = c * apk - s * aqk;
          (a[q] as Vector)[k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = (v[k] as Vector)[p] as number;
          const vkq = (v[k] as Vector)[q] as number;
          (v[k] as Vector)[p] = c * vkp - s * vkq;
          (v[k] as Vector)[q] = s * vkp + c * vkq;
        }
      }
    }
  }

  v = transpose(v); // rows become eigenvectors
  const pairs = Array.from({ length: n }, (_, k) => ({
    value: (a[k] as Vector)[k] as number,
    vector: v[k] as Vector,
  })).sort((x, y) => Math.abs(y.value) - Math.abs(x.value));

  return {
    values: pairs.map((p) => p.value),
    vectors: pairs.map((p) => {
      const nv = norm(p.vector);
      const unit = nv < EPS ? p.vector : vecScale(p.vector, 1 / nv);
      // Sign convention: largest-|component| is positive, so PCA loadings are
      // stable across reruns (otherwise eigenvector signs flip arbitrarily).
      let maxIdx = 0;
      for (let i = 1; i < unit.length; i += 1) {
        if (Math.abs(unit[i] as number) > Math.abs(unit[maxIdx] as number)) maxIdx = i;
      }
      return (unit[maxIdx] as number) < 0 ? vecScale(unit, -1) : unit;
    }),
  };
}

/**
 * Solves A·x = b by Gaussian elimination with partial pivoting.
 * Used by the SABR calibrator's normal equations and the GBDT leaf solver.
 */
export function solve(a: Matrix, b: Vector): Vector {
  const n = a.length;
  const m = a.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs((m[r] as Vector)[col] as number) > Math.abs((m[pivot] as Vector)[col] as number)) pivot = r;
    }
    if (Math.abs((m[pivot] as Vector)[col] as number) < 1e-14) throw new Error(`solve: singular at column ${col}`);
    if (pivot !== col) {
      const t = m[col] as Vector;
      m[col] = m[pivot] as Vector;
      m[pivot] = t;
    }
    for (let r = col + 1; r < n; r += 1) {
      const f = ((m[r] as Vector)[col] as number) / ((m[col] as Vector)[col] as number);
      if (f === 0) continue;
      for (let j = col; j <= n; j += 1) {
        (m[r] as Vector)[j] = ((m[r] as Vector)[j] as number) - f * ((m[col] as Vector)[j] as number);
      }
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let acc = (m[i] as Vector)[n] as number;
    for (let j = i + 1; j < n; j += 1) acc -= ((m[i] as Vector)[j] as number) * (x[j] as number);
    x[i] = acc / ((m[i] as Vector)[i] as number);
  }
  return x;
}

/** Ridge-regularised least squares: (XᵀX + λI)⁻¹Xᵀy. */
export function ridgeRegression(x: readonly Vector[], y: readonly number[], lambda = 1e-6): Vector {
  const xt = transpose(x as Matrix);
  const xtx = matAdd(matMul(xt, x as Matrix), identity(xt.length, lambda));
  const xty = matVec(xt, y as Vector);
  return solve(xtx, xty);
}
