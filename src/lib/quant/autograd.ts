/**
 * Minimal reverse-mode automatic differentiation over dense 2-D tensors.
 *
 * The three temporal agents mandated by Phase 1 §1 (a 60m Temporal Fusion
 * Transformer, a 15m BiLSTM and a 5m LSTM) have to be genuinely trained, not
 * stubbed. Rather than depend on a native ML runtime — which would make the app
 * unbuildable in a plain Node environment — this module provides matrix-level
 * autodiff: every op is a Float64Array kernel with a hand-written adjoint, and
 * the tape records closures.
 *
 * Matrix-level (not scalar-level) granularity is what makes this fast enough:
 * one `matmul` node covers r·c·k multiply-adds inside a tight loop instead of
 * building a graph node per scalar.
 */

export type Shape = [number, number];

let tapeEnabled = true;
let tape: (() => void)[] = [];

/** Runs `fn` without recording gradients (inference path). */
export function noGrad<T>(fn: () => T): T {
  const previous = tapeEnabled;
  tapeEnabled = false;
  try {
    return fn();
  } finally {
    tapeEnabled = previous;
  }
}

export class Tensor {
  readonly data: Float64Array;
  readonly rows: number;
  readonly cols: number;
  grad: Float64Array | null;
  readonly requiresGrad: boolean;

  constructor(rows: number, cols: number, data?: Float64Array | readonly number[], requiresGrad = false) {
    this.rows = rows;
    this.cols = cols;
    this.data = data instanceof Float64Array ? data : Float64Array.from(data ?? new Array(rows * cols).fill(0));
    if (this.data.length !== rows * cols) {
      throw new Error(`Tensor: data length ${this.data.length} != ${rows}×${cols}`);
    }
    this.requiresGrad = requiresGrad;
    this.grad = requiresGrad ? new Float64Array(rows * cols) : null;
  }

  get size(): number {
    return this.rows * this.cols;
  }

  get shape(): Shape {
    return [this.rows, this.cols];
  }

  at(r: number, c: number): number {
    return this.data[r * this.cols + c] as number;
  }

  set(r: number, c: number, v: number): void {
    this.data[r * this.cols + c] = v;
  }

  ensureGrad(): Float64Array {
    if (!this.grad) this.grad = new Float64Array(this.size);
    return this.grad;
  }

  zeroGrad(): void {
    if (this.grad) this.grad.fill(0);
  }

  clone(): Tensor {
    return new Tensor(this.rows, this.cols, this.data.slice(), this.requiresGrad);
  }

  toArray(): number[] {
    return Array.from(this.data);
  }

  /** Row `r` as a plain array. */
  row(r: number): number[] {
    return Array.from(this.data.subarray(r * this.cols, (r + 1) * this.cols));
  }
}

export function tensor(rows: number, cols: number, values?: readonly number[]): Tensor {
  return new Tensor(rows, cols, values);
}

export function parameter(rows: number, cols: number, values?: readonly number[]): Tensor {
  return new Tensor(rows, cols, values, true);
}

export function fromRows(rows: readonly (readonly number[])[]): Tensor {
  const r = rows.length;
  const c = r === 0 ? 0 : (rows[0] as number[]).length;
  const data = new Float64Array(r * c);
  for (let i = 0; i < r; i += 1) {
    const src = rows[i] as number[];
    for (let j = 0; j < c; j += 1) data[i * c + j] = src[j] as number;
  }
  return new Tensor(r, c, data);
}

/** Glorot/Xavier uniform initialisation. */
export function glorot(rows: number, cols: number, rand: () => number): Tensor {
  const limit = Math.sqrt(6 / (rows + cols));
  const data = new Float64Array(rows * cols);
  for (let i = 0; i < data.length; i += 1) data[i] = (rand() * 2 - 1) * limit;
  return new Tensor(rows, cols, data, true);
}

export function zerosParam(rows: number, cols: number): Tensor {
  return new Tensor(rows, cols, new Float64Array(rows * cols), true);
}

function record(fn: () => void): void {
  if (tapeEnabled) tape.push(fn);
}

function needsGrad(...ts: Tensor[]): boolean {
  return tapeEnabled && ts.some((t) => t.requiresGrad || t.grad !== null);
}

function makeOut(rows: number, cols: number, data: Float64Array, inputs: Tensor[]): Tensor {
  const out = new Tensor(rows, cols, data, false);
  if (needsGrad(...inputs)) out.grad = new Float64Array(rows * cols);
  return out;
}

// ── Core ops ────────────────────────────────────────────────────────────────

/** C = A · B */
export function matmul(a: Tensor, b: Tensor): Tensor {
  if (a.cols !== b.rows) throw new Error(`matmul: ${a.rows}×${a.cols} · ${b.rows}×${b.cols}`);
  const m = a.rows;
  const k = a.cols;
  const n = b.cols;
  const data = new Float64Array(m * n);
  for (let i = 0; i < m; i += 1) {
    const aOff = i * k;
    const cOff = i * n;
    for (let p = 0; p < k; p += 1) {
      const av = a.data[aOff + p] as number;
      if (av === 0) continue;
      const bOff = p * n;
      for (let j = 0; j < n; j += 1) data[cOff + j] = (data[cOff + j] as number) + av * (b.data[bOff + j] as number);
    }
  }
  const out = makeOut(m, n, data, [a, b]);
  if (out.grad) {
    record(() => {
      const g = out.grad as Float64Array;
      if (a.requiresGrad || a.grad) {
        const ga = a.ensureGrad();
        for (let i = 0; i < m; i += 1) {
          for (let p = 0; p < k; p += 1) {
            let acc = 0;
            const bOff = p * n;
            const gOff = i * n;
            for (let j = 0; j < n; j += 1) acc += (g[gOff + j] as number) * (b.data[bOff + j] as number);
            ga[i * k + p] = (ga[i * k + p] as number) + acc;
          }
        }
      }
      if (b.requiresGrad || b.grad) {
        const gb = b.ensureGrad();
        for (let p = 0; p < k; p += 1) {
          for (let j = 0; j < n; j += 1) {
            let acc = 0;
            for (let i = 0; i < m; i += 1) acc += (a.data[i * k + p] as number) * (g[i * n + j] as number);
            gb[p * n + j] = (gb[p * n + j] as number) + acc;
          }
        }
      }
    });
  }
  return out;
}

/** Element-wise add; `b` may be a 1×cols row vector broadcast over rows. */
export function add(a: Tensor, b: Tensor): Tensor {
  const broadcast = b.rows === 1 && a.rows !== 1;
  if (!broadcast && (a.rows !== b.rows || a.cols !== b.cols)) {
    throw new Error(`add: ${a.rows}×${a.cols} + ${b.rows}×${b.cols}`);
  }
  if (a.cols !== b.cols) throw new Error(`add: column mismatch ${a.cols} vs ${b.cols}`);
  const data = new Float64Array(a.size);
  for (let i = 0; i < a.rows; i += 1) {
    for (let j = 0; j < a.cols; j += 1) {
      data[i * a.cols + j] =
        (a.data[i * a.cols + j] as number) + (b.data[(broadcast ? 0 : i) * a.cols + j] as number);
    }
  }
  const out = makeOut(a.rows, a.cols, data, [a, b]);
  if (out.grad) {
    record(() => {
      const g = out.grad as Float64Array;
      if (a.requiresGrad || a.grad) {
        const ga = a.ensureGrad();
        for (let i = 0; i < g.length; i += 1) ga[i] = (ga[i] as number) + (g[i] as number);
      }
      if (b.requiresGrad || b.grad) {
        const gb = b.ensureGrad();
        for (let i = 0; i < a.rows; i += 1) {
          for (let j = 0; j < a.cols; j += 1) {
            const idx = (broadcast ? 0 : i) * a.cols + j;
            gb[idx] = (gb[idx] as number) + (g[i * a.cols + j] as number);
          }
        }
      }
    });
  }
  return out;
}

/** Element-wise multiply (same shape, or `b` broadcast as a row vector). */
export function mul(a: Tensor, b: Tensor): Tensor {
  const broadcast = b.rows === 1 && a.rows !== 1;
  if (a.cols !== b.cols) throw new Error(`mul: column mismatch ${a.cols} vs ${b.cols}`);
  const data = new Float64Array(a.size);
  for (let i = 0; i < a.rows; i += 1) {
    for (let j = 0; j < a.cols; j += 1) {
      data[i * a.cols + j] =
        (a.data[i * a.cols + j] as number) * (b.data[(broadcast ? 0 : i) * a.cols + j] as number);
    }
  }
  const out = makeOut(a.rows, a.cols, data, [a, b]);
  if (out.grad) {
    record(() => {
      const g = out.grad as Float64Array;
      if (a.requiresGrad || a.grad) {
        const ga = a.ensureGrad();
        for (let i = 0; i < a.rows; i += 1) {
          for (let j = 0; j < a.cols; j += 1) {
            const ai = i * a.cols + j;
            ga[ai] = (ga[ai] as number) + (g[ai] as number) * (b.data[(broadcast ? 0 : i) * a.cols + j] as number);
          }
        }
      }
      if (b.requiresGrad || b.grad) {
        const gb = b.ensureGrad();
        for (let i = 0; i < a.rows; i += 1) {
          for (let j = 0; j < a.cols; j += 1) {
            const ai = i * a.cols + j;
            const bi = (broadcast ? 0 : i) * a.cols + j;
            gb[bi] = (gb[bi] as number) + (g[ai] as number) * (a.data[ai] as number);
          }
        }
      }
    });
  }
  return out;
}

export function scale(a: Tensor, s: number): Tensor {
  const data = new Float64Array(a.size);
  for (let i = 0; i < a.size; i += 1) data[i] = (a.data[i] as number) * s;
  const out = makeOut(a.rows, a.cols, data, [a]);
  if (out.grad) {
    record(() => {
      const g = out.grad as Float64Array;
      const ga = a.ensureGrad();
      for (let i = 0; i < g.length; i += 1) ga[i] = (ga[i] as number) + (g[i] as number) * s;
    });
  }
  return out;
}

export function sub(a: Tensor, b: Tensor): Tensor {
  return add(a, scale(b, -1));
}

function elementwise(a: Tensor, f: (x: number) => number, df: (x: number, y: number) => number): Tensor {
  const data = new Float64Array(a.size);
  for (let i = 0; i < a.size; i += 1) data[i] = f(a.data[i] as number);
  const out = makeOut(a.rows, a.cols, data, [a]);
  if (out.grad) {
    record(() => {
      const g = out.grad as Float64Array;
      const ga = a.ensureGrad();
      for (let i = 0; i < g.length; i += 1) {
        ga[i] = (ga[i] as number) + (g[i] as number) * df(a.data[i] as number, data[i] as number);
      }
    });
  }
  return out;
}

const sigmoidScalar = (x: number): number => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));

export function sigmoid(a: Tensor): Tensor {
  return elementwise(a, sigmoidScalar, (_x, y) => y * (1 - y));
}

export function tanh(a: Tensor): Tensor {
  return elementwise(a, Math.tanh, (_x, y) => 1 - y * y);
}

export function relu(a: Tensor): Tensor {
  return elementwise(a, (x) => (x > 0 ? x : 0), (x) => (x > 0 ? 1 : 0));
}

/** Softplus, log(1 + eˣ), computed stably. Guarantees a positive output. */
export function softplus(a: Tensor): Tensor {
  return elementwise(
    a,
    (x) => (x > 20 ? x : x < -20 ? Math.exp(x) : Math.log1p(Math.exp(x))),
    (x) => sigmoidScalar(x),
  );
}

/** ELU — used in the TFT's gated residual networks. */
export function elu(a: Tensor, alpha = 1): Tensor {
  return elementwise(
    a,
    (x) => (x > 0 ? x : alpha * (Math.exp(x) - 1)),
    (x, y) => (x > 0 ? 1 : y + alpha),
  );
}

/** Row-wise softmax. */
export function softmax(a: Tensor): Tensor {
  const data = new Float64Array(a.size);
  for (let i = 0; i < a.rows; i += 1) {
    const off = i * a.cols;
    let max = -Infinity;
    for (let j = 0; j < a.cols; j += 1) max = Math.max(max, a.data[off + j] as number);
    let sum = 0;
    for (let j = 0; j < a.cols; j += 1) {
      const e = Math.exp((a.data[off + j] as number) - max);
      data[off + j] = e;
      sum += e;
    }
    const inv = sum === 0 ? 0 : 1 / sum;
    for (let j = 0; j < a.cols; j += 1) data[off + j] = (data[off + j] as number) * inv;
  }
  const out = makeOut(a.rows, a.cols, data, [a]);
  if (out.grad) {
    record(() => {
      const g = out.grad as Float64Array;
      const ga = a.ensureGrad();
      for (let i = 0; i < a.rows; i += 1) {
        const off = i * a.cols;
        let dot = 0;
        for (let j = 0; j < a.cols; j += 1) dot += (g[off + j] as number) * (data[off + j] as number);
        for (let j = 0; j < a.cols; j += 1) {
          const y = data[off + j] as number;
          ga[off + j] = (ga[off + j] as number) + y * ((g[off + j] as number) - dot);
        }
      }
    });
  }
  return out;
}

/** Layer normalisation over the feature (column) axis. */
export function layerNorm(a: Tensor, gain: Tensor, bias: Tensor, eps = 1e-5): Tensor {
  const data = new Float64Array(a.size);
  const means = new Float64Array(a.rows);
  const invStds = new Float64Array(a.rows);
  for (let i = 0; i < a.rows; i += 1) {
    const off = i * a.cols;
    let m = 0;
    for (let j = 0; j < a.cols; j += 1) m += a.data[off + j] as number;
    m /= a.cols;
    let v = 0;
    for (let j = 0; j < a.cols; j += 1) v += ((a.data[off + j] as number) - m) ** 2;
    v /= a.cols;
    const inv = 1 / Math.sqrt(v + eps);
    means[i] = m;
    invStds[i] = inv;
    for (let j = 0; j < a.cols; j += 1) {
      const norm = ((a.data[off + j] as number) - m) * inv;
      data[off + j] = norm * (gain.data[j] as number) + (bias.data[j] as number);
    }
  }
  const out = makeOut(a.rows, a.cols, data, [a, gain, bias]);
  if (out.grad) {
    record(() => {
      const g = out.grad as Float64Array;
      const ga = a.requiresGrad || a.grad ? a.ensureGrad() : null;
      const gg = gain.requiresGrad || gain.grad ? gain.ensureGrad() : null;
      const gb = bias.requiresGrad || bias.grad ? bias.ensureGrad() : null;
      const n = a.cols;
      for (let i = 0; i < a.rows; i += 1) {
        const off = i * n;
        const m = means[i] as number;
        const inv = invStds[i] as number;
        let sumDy = 0;
        let sumDyXhat = 0;
        for (let j = 0; j < n; j += 1) {
          const xhat = ((a.data[off + j] as number) - m) * inv;
          const dy = (g[off + j] as number) * (gain.data[j] as number);
          sumDy += dy;
          sumDyXhat += dy * xhat;
          if (gg) gg[j] = (gg[j] as number) + (g[off + j] as number) * xhat;
          if (gb) gb[j] = (gb[j] as number) + (g[off + j] as number);
        }
        if (ga) {
          for (let j = 0; j < n; j += 1) {
            const xhat = ((a.data[off + j] as number) - m) * inv;
            const dy = (g[off + j] as number) * (gain.data[j] as number);
            ga[off + j] = (ga[off + j] as number) + (inv / n) * (n * dy - sumDy - xhat * sumDyXhat);
          }
        }
      }
    });
  }
  return out;
}

/** Concatenates along the column axis. */
export function concat(parts: readonly Tensor[]): Tensor {
  if (parts.length === 0) throw new Error('concat: no parts');
  const rows = (parts[0] as Tensor).rows;
  let cols = 0;
  for (const p of parts) {
    if (p.rows !== rows) throw new Error('concat: row mismatch');
    cols += p.cols;
  }
  const data = new Float64Array(rows * cols);
  let offset = 0;
  for (const p of parts) {
    for (let i = 0; i < rows; i += 1) {
      for (let j = 0; j < p.cols; j += 1) data[i * cols + offset + j] = p.data[i * p.cols + j] as number;
    }
    offset += p.cols;
  }
  const out = makeOut(rows, cols, data, parts as Tensor[]);
  if (out.grad) {
    record(() => {
      const g = out.grad as Float64Array;
      let off = 0;
      for (const p of parts) {
        if (p.requiresGrad || p.grad) {
          const gp = p.ensureGrad();
          for (let i = 0; i < rows; i += 1) {
            for (let j = 0; j < p.cols; j += 1) {
              gp[i * p.cols + j] = (gp[i * p.cols + j] as number) + (g[i * cols + off + j] as number);
            }
          }
        }
        off += p.cols;
      }
    });
  }
  return out;
}

/** Column slice [start, start+width). */
export function sliceCols(a: Tensor, start: number, width: number): Tensor {
  const data = new Float64Array(a.rows * width);
  for (let i = 0; i < a.rows; i += 1) {
    for (let j = 0; j < width; j += 1) data[i * width + j] = a.data[i * a.cols + start + j] as number;
  }
  const out = makeOut(a.rows, width, data, [a]);
  if (out.grad) {
    record(() => {
      const g = out.grad as Float64Array;
      const ga = a.ensureGrad();
      for (let i = 0; i < a.rows; i += 1) {
        for (let j = 0; j < width; j += 1) {
          const idx = i * a.cols + start + j;
          ga[idx] = (ga[idx] as number) + (g[i * width + j] as number);
        }
      }
    });
  }
  return out;
}

/** Single row as a 1×cols tensor. */
export function rowSlice(a: Tensor, rowIndex: number): Tensor {
  const data = new Float64Array(a.cols);
  for (let j = 0; j < a.cols; j += 1) data[j] = a.data[rowIndex * a.cols + j] as number;
  const out = makeOut(1, a.cols, data, [a]);
  if (out.grad) {
    record(() => {
      const g = out.grad as Float64Array;
      const ga = a.ensureGrad();
      for (let j = 0; j < a.cols; j += 1) {
        const idx = rowIndex * a.cols + j;
        ga[idx] = (ga[idx] as number) + (g[j] as number);
      }
    });
  }
  return out;
}

/** Stacks 1×c tensors into an r×c tensor. */
export function stackRows(rows: readonly Tensor[]): Tensor {
  if (rows.length === 0) throw new Error('stackRows: no rows');
  const c = (rows[0] as Tensor).cols;
  const data = new Float64Array(rows.length * c);
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] as Tensor;
    for (let j = 0; j < c; j += 1) data[i * c + j] = r.data[j] as number;
  }
  const out = makeOut(rows.length, c, data, rows as Tensor[]);
  if (out.grad) {
    record(() => {
      const g = out.grad as Float64Array;
      for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i] as Tensor;
        if (!(r.requiresGrad || r.grad)) continue;
        const gr = r.ensureGrad();
        for (let j = 0; j < c; j += 1) gr[j] = (gr[j] as number) + (g[i * c + j] as number);
      }
    });
  }
  return out;
}

export function transpose(a: Tensor): Tensor {
  const data = new Float64Array(a.size);
  for (let i = 0; i < a.rows; i += 1) {
    for (let j = 0; j < a.cols; j += 1) data[j * a.rows + i] = a.data[i * a.cols + j] as number;
  }
  const out = makeOut(a.cols, a.rows, data, [a]);
  if (out.grad) {
    record(() => {
      const g = out.grad as Float64Array;
      const ga = a.ensureGrad();
      for (let i = 0; i < a.rows; i += 1) {
        for (let j = 0; j < a.cols; j += 1) {
          ga[i * a.cols + j] = (ga[i * a.cols + j] as number) + (g[j * a.rows + i] as number);
        }
      }
    });
  }
  return out;
}

/** Mean over every element, producing a 1×1 tensor. */
export function meanAll(a: Tensor): Tensor {
  let acc = 0;
  for (let i = 0; i < a.size; i += 1) acc += a.data[i] as number;
  const out = makeOut(1, 1, Float64Array.of(acc / a.size), [a]);
  if (out.grad) {
    record(() => {
      const g = (out.grad as Float64Array)[0] as number;
      const ga = a.ensureGrad();
      const s = g / a.size;
      for (let i = 0; i < a.size; i += 1) ga[i] = (ga[i] as number) + s;
    });
  }
  return out;
}

// ── Losses ──────────────────────────────────────────────────────────────────

/** Mean squared error between predictions and targets. */
export function mseLoss(pred: Tensor, target: Tensor): Tensor {
  const d = sub(pred, target);
  return meanAll(mul(d, d));
}

/**
 * Binary cross-entropy on *logits* (numerically stable):
 *   L = mean( max(z,0) − z·y + log(1 + e^{−|z|}) )
 */
export function bceWithLogits(logits: Tensor, target: Tensor): Tensor {
  let acc = 0;
  for (let i = 0; i < logits.size; i += 1) {
    const z = logits.data[i] as number;
    const y = target.data[i] as number;
    acc += Math.max(z, 0) - z * y + Math.log1p(Math.exp(-Math.abs(z)));
  }
  const out = makeOut(1, 1, Float64Array.of(acc / logits.size), [logits]);
  if (out.grad) {
    record(() => {
      const g = (out.grad as Float64Array)[0] as number;
      const gl = logits.ensureGrad();
      const inv = g / logits.size;
      for (let i = 0; i < logits.size; i += 1) {
        const p = sigmoidScalar(logits.data[i] as number);
        gl[i] = (gl[i] as number) + inv * (p - (target.data[i] as number));
      }
    });
  }
  return out;
}

/** Huber (smooth L1) loss — robust to the fat-tailed return targets. */
export function huberLoss(pred: Tensor, target: Tensor, delta = 1): Tensor {
  let acc = 0;
  for (let i = 0; i < pred.size; i += 1) {
    const e = (pred.data[i] as number) - (target.data[i] as number);
    acc += Math.abs(e) <= delta ? 0.5 * e * e : delta * (Math.abs(e) - 0.5 * delta);
  }
  const out = makeOut(1, 1, Float64Array.of(acc / pred.size), [pred]);
  if (out.grad) {
    record(() => {
      const g = (out.grad as Float64Array)[0] as number;
      const gp = pred.ensureGrad();
      const inv = g / pred.size;
      for (let i = 0; i < pred.size; i += 1) {
        const e = (pred.data[i] as number) - (target.data[i] as number);
        gp[i] = (gp[i] as number) + inv * (Math.abs(e) <= delta ? e : delta * Math.sign(e));
      }
    });
  }
  return out;
}

/**
 * Quantile (pinball) loss — the TFT's native objective, giving calibrated
 * prediction intervals instead of a point estimate.
 *   L_q(y, ŷ) = max( q(y − ŷ), (q − 1)(y − ŷ) )
 */
export function quantileLoss(pred: Tensor, target: Tensor, quantiles: readonly number[]): Tensor {
  if (pred.cols !== quantiles.length) throw new Error('quantileLoss: column/quantile mismatch');
  let acc = 0;
  for (let i = 0; i < pred.rows; i += 1) {
    const y = target.data[i * target.cols] as number;
    for (let j = 0; j < pred.cols; j += 1) {
      const q = quantiles[j] as number;
      const e = y - (pred.data[i * pred.cols + j] as number);
      acc += Math.max(q * e, (q - 1) * e);
    }
  }
  const out = makeOut(1, 1, Float64Array.of(acc / (pred.rows * pred.cols)), [pred]);
  if (out.grad) {
    record(() => {
      const g = (out.grad as Float64Array)[0] as number;
      const gp = pred.ensureGrad();
      const inv = g / (pred.rows * pred.cols);
      for (let i = 0; i < pred.rows; i += 1) {
        const y = target.data[i * target.cols] as number;
        for (let j = 0; j < pred.cols; j += 1) {
          const q = quantiles[j] as number;
          const e = y - (pred.data[i * pred.cols + j] as number);
          // ∂L/∂ŷ = −q when e > 0, (1 − q) when e ≤ 0
          gp[i * pred.cols + j] = (gp[i * pred.cols + j] as number) + inv * (e > 0 ? -q : 1 - q);
        }
      }
    });
  }
  return out;
}

// ── Tape control ────────────────────────────────────────────────────────────

export function resetTape(): void {
  tape = [];
}

/** Seeds the loss gradient with 1 and replays the tape in reverse. */
export function backward(loss: Tensor): void {
  const g = loss.ensureGrad();
  g.fill(0);
  g[0] = 1;
  for (let i = tape.length - 1; i >= 0; i -= 1) (tape[i] as () => void)();
  tape = [];
}

// ── Optimiser ───────────────────────────────────────────────────────────────

export interface AdamOptions {
  learningRate?: number;
  beta1?: number;
  beta2?: number;
  eps?: number;
  weightDecay?: number;
  /** Global gradient-norm clip; 0 disables. */
  clipNorm?: number;
}

/** Adam with decoupled weight decay (AdamW) and global gradient clipping. */
export class Adam {
  private readonly m: Float64Array[];
  private readonly v: Float64Array[];
  private t = 0;
  private readonly lr: number;
  private readonly beta1: number;
  private readonly beta2: number;
  private readonly eps: number;
  private readonly weightDecay: number;
  private readonly clipNorm: number;

  constructor(private readonly params: Tensor[], options: AdamOptions = {}) {
    this.lr = options.learningRate ?? 3e-3;
    this.beta1 = options.beta1 ?? 0.9;
    this.beta2 = options.beta2 ?? 0.999;
    this.eps = options.eps ?? 1e-8;
    this.weightDecay = options.weightDecay ?? 0;
    this.clipNorm = options.clipNorm ?? 1;
    this.m = params.map((p) => new Float64Array(p.size));
    this.v = params.map((p) => new Float64Array(p.size));
  }

  zeroGrad(): void {
    for (const p of this.params) p.zeroGrad();
  }

  step(): void {
    this.t += 1;
    if (this.clipNorm > 0) {
      let sq = 0;
      for (const p of this.params) {
        const g = p.grad;
        if (!g) continue;
        for (let i = 0; i < g.length; i += 1) sq += (g[i] as number) ** 2;
      }
      const norm = Math.sqrt(sq);
      if (norm > this.clipNorm) {
        const s = this.clipNorm / (norm + 1e-12);
        for (const p of this.params) {
          const g = p.grad;
          if (!g) continue;
          for (let i = 0; i < g.length; i += 1) g[i] = (g[i] as number) * s;
        }
      }
    }
    const b1t = 1 - Math.pow(this.beta1, this.t);
    const b2t = 1 - Math.pow(this.beta2, this.t);
    for (let k = 0; k < this.params.length; k += 1) {
      const p = this.params[k] as Tensor;
      const g = p.grad;
      if (!g) continue;
      const m = this.m[k] as Float64Array;
      const v = this.v[k] as Float64Array;
      for (let i = 0; i < p.size; i += 1) {
        const grad = g[i] as number;
        m[i] = this.beta1 * (m[i] as number) + (1 - this.beta1) * grad;
        v[i] = this.beta2 * (v[i] as number) + (1 - this.beta2) * grad * grad;
        const mHat = (m[i] as number) / b1t;
        const vHat = (v[i] as number) / b2t;
        let w = p.data[i] as number;
        if (this.weightDecay > 0) w -= this.lr * this.weightDecay * w;
        p.data[i] = w - (this.lr * mHat) / (Math.sqrt(vHat) + this.eps);
      }
    }
  }
}
