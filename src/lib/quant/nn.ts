/**
 * Neural layers for the multi-timeframe ensemble.
 *
 * Phase 1 §1 mandates three concurrent architectures, each bound to one
 * temporal resolution:
 *
 *   • 60m — Temporal Fusion Transformer: variable-selection networks, gated
 *     residual networks, an LSTM encoder and interpretable multi-head attention,
 *     trained on the quantile (pinball) loss so it emits calibrated intervals
 *     and exposes attention weights and variable-selection weights as
 *     first-class explanations.
 *   • 15m — bidirectional LSTM: processes the sequence forward and backward and
 *     concatenates both final states, resolving contextual dependencies a
 *     unidirectional model cannot see.
 *   • 5m  — LSTM: the tactical layer.
 *
 * All three are built from `autograd`, so they train with real backpropagation
 * and their weights serialise to plain JSON.
 */

import {
  Adam,
  type Tensor,
  add,
  backward,
  bceWithLogits,
  concat,
  elu,
  glorot,
  layerNorm,
  matmul,
  mul,
  noGrad,
  parameter,
  quantileLoss,
  resetTape,
  rowSlice,
  scale,
  sigmoid,
  sub,
  sliceCols,
  softmax,
  softplus,
  stackRows,
  tanh,
  tensor,
  transpose,
  zerosParam,
} from './autograd';

// ─────────────────────────────────────────────────────────────────────────────
//  Building blocks
// ─────────────────────────────────────────────────────────────────────────────

export interface Dense {
  W: Tensor;
  b: Tensor;
}

export function dense(inDim: number, outDim: number, rand: () => number): Dense {
  return { W: glorot(inDim, outDim, rand), b: zerosParam(1, outDim) };
}

export function applyDense(layer: Dense, x: Tensor): Tensor {
  return add(matmul(x, layer.W), layer.b);
}

export function denseParams(layer: Dense): Tensor[] {
  return [layer.W, layer.b];
}

/**
 * Gated Linear Unit: GLU(x) = σ(Wx + b) ⊙ (Vx + c).
 * The TFT's gating primitive — lets the network suppress a whole pathway.
 */
export interface Glu {
  gate: Dense;
  value: Dense;
}

export function glu(inDim: number, outDim: number, rand: () => number): Glu {
  return { gate: dense(inDim, outDim, rand), value: dense(inDim, outDim, rand) };
}

export function applyGlu(layer: Glu, x: Tensor): Tensor {
  return mul(sigmoid(applyDense(layer.gate, x)), applyDense(layer.value, x));
}

export function gluParams(layer: Glu): Tensor[] {
  return [...denseParams(layer.gate), ...denseParams(layer.value)];
}

/**
 * Gated Residual Network (Lim et al. 2021, eq. 3–5):
 *
 *   η₂ = ELU(W₂·a + b₂)
 *   η₁ = W₁·η₂ + b₁
 *   GRN(a) = LayerNorm( skip(a) + GLU(η₁) )
 *
 * `skip` is identity when the dimensions match, otherwise a learned projection.
 */
export interface Grn {
  hidden: Dense;
  output: Dense;
  gate: Glu;
  norm: { gain: Tensor; bias: Tensor };
  projection: Dense | null;
}

export function grn(inDim: number, hiddenDim: number, outDim: number, rand: () => number): Grn {
  const gain = parameter(1, outDim);
  gain.data.fill(1);
  return {
    hidden: dense(inDim, hiddenDim, rand),
    output: dense(hiddenDim, outDim, rand),
    gate: glu(outDim, outDim, rand),
    norm: { gain, bias: zerosParam(1, outDim) },
    projection: inDim === outDim ? null : dense(inDim, outDim, rand),
  };
}

export function applyGrn(layer: Grn, x: Tensor): Tensor {
  const eta2 = elu(applyDense(layer.hidden, x));
  const eta1 = applyDense(layer.output, eta2);
  const gated = applyGlu(layer.gate, eta1);
  const skip = layer.projection ? applyDense(layer.projection, x) : x;
  return layerNorm(add(skip, gated), layer.norm.gain, layer.norm.bias);
}

export function grnParams(layer: Grn): Tensor[] {
  return [
    ...denseParams(layer.hidden),
    ...denseParams(layer.output),
    ...gluParams(layer.gate),
    layer.norm.gain,
    layer.norm.bias,
    ...(layer.projection ? denseParams(layer.projection) : []),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
//  LSTM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LSTM cell with the four gates packed into one weight matrix so each timestep
 * is a single matmul:
 *
 *   [i, f, g, o] = x·Wx + h·Wh + b
 *   i = σ(i)   f = σ(f)   g = tanh(g)   o = σ(o)
 *   c' = f ⊙ c + i ⊙ g
 *   h' = o ⊙ tanh(c')
 *
 * The forget-gate bias is initialised to +1 (Jozefowicz et al.) so gradients
 * survive the long 60m sequences.
 */
export interface LstmCell {
  Wx: Tensor;
  Wh: Tensor;
  b: Tensor;
  hiddenSize: number;
  inputSize: number;
}

export function lstmCell(inputSize: number, hiddenSize: number, rand: () => number): LstmCell {
  const b = zerosParam(1, 4 * hiddenSize);
  for (let j = hiddenSize; j < 2 * hiddenSize; j += 1) b.data[j] = 1;
  return {
    Wx: glorot(inputSize, 4 * hiddenSize, rand),
    Wh: glorot(hiddenSize, 4 * hiddenSize, rand),
    b,
    hiddenSize,
    inputSize,
  };
}

export function lstmCellParams(cell: LstmCell): Tensor[] {
  return [cell.Wx, cell.Wh, cell.b];
}

export interface LstmState {
  h: Tensor;
  c: Tensor;
}

export function lstmStep(cell: LstmCell, x: Tensor, state: LstmState): LstmState {
  const H = cell.hiddenSize;
  const z = add(add(matmul(x, cell.Wx), matmul(state.h, cell.Wh)), cell.b);
  const i = sigmoid(sliceCols(z, 0, H));
  const f = sigmoid(sliceCols(z, H, H));
  const g = tanh(sliceCols(z, 2 * H, H));
  const o = sigmoid(sliceCols(z, 3 * H, H));
  const c = add(mul(f, state.c), mul(i, g));
  return { h: mul(o, tanh(c)), c };
}

export function initialLstmState(batch: number, hiddenSize: number): LstmState {
  return { h: tensor(batch, hiddenSize), c: tensor(batch, hiddenSize) };
}

/** Runs an LSTM over a sequence of `steps` 1×inputSize rows. */
export function lstmSequence(
  cell: LstmCell,
  sequence: readonly Tensor[],
): { outputs: Tensor[]; final: LstmState } {
  let state = initialLstmState(1, cell.hiddenSize);
  const outputs: Tensor[] = [];
  for (const x of sequence) {
    state = lstmStep(cell, x, state);
    outputs.push(state.h);
  }
  return { outputs, final: state };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Interpretable multi-head attention (TFT)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lim et al.'s interpretable multi-head attention: every head shares one value
 * projection, so head-averaged attention weights are directly interpretable as
 * "how much did the model look at timestep t".
 */
export interface InterpretableAttention {
  q: Dense[];
  k: Dense[];
  v: Dense;
  out: Dense;
  heads: number;
  dK: number;
}

export function interpretableAttention(
  dModel: number,
  heads: number,
  rand: () => number,
): InterpretableAttention {
  const dK = Math.max(1, Math.floor(dModel / heads));
  return {
    q: Array.from({ length: heads }, () => dense(dModel, dK, rand)),
    k: Array.from({ length: heads }, () => dense(dModel, dK, rand)),
    v: dense(dModel, dModel, rand),
    out: dense(dModel, dModel, rand),
    heads,
    dK,
  };
}

export function attentionParams(layer: InterpretableAttention): Tensor[] {
  return [
    ...layer.q.flatMap(denseParams),
    ...layer.k.flatMap(denseParams),
    ...denseParams(layer.v),
    ...denseParams(layer.out),
  ];
}

export interface AttentionResult {
  output: Tensor;
  /** Head-averaged attention weights, queries × keys. */
  weights: Tensor;
}

export function applyAttention(
  layer: InterpretableAttention,
  query: Tensor,
  keyValue: Tensor,
): AttentionResult {
  const V = applyDense(layer.v, keyValue);
  const scaleFactor = 1 / Math.sqrt(layer.dK);
  let acc: Tensor | null = null;
  let weightAcc: Tensor | null = null;
  for (let h = 0; h < layer.heads; h += 1) {
    const Q = applyDense(layer.q[h] as Dense, query);
    const K = applyDense(layer.k[h] as Dense, keyValue);
    const scores = scale(matmul(Q, transpose(K)), scaleFactor);
    const w = softmax(scores);
    const headOut = matmul(w, V);
    acc = acc === null ? headOut : add(acc, headOut);
    weightAcc = weightAcc === null ? w : add(weightAcc, w);
  }
  const averaged = scale(acc as Tensor, 1 / layer.heads);
  return {
    output: applyDense(layer.out, averaged),
    weights: scale(weightAcc as Tensor, 1 / layer.heads),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Variable Selection Network (TFT)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-timestep, instance-wise feature weighting. A softmax over a GRN of the
 * flattened inputs produces one weight per input variable; each variable is
 * separately transformed by its own GRN and the results are weighted-summed.
 * The softmax weights are exactly the "which inputs mattered" explanation.
 */
export interface VariableSelection {
  weightGrn: Grn;
  variableGrns: Grn[];
  inputDim: number;
  hiddenDim: number;
}

export function variableSelection(
  inputDim: number,
  hiddenDim: number,
  rand: () => number,
): VariableSelection {
  return {
    weightGrn: grn(inputDim, hiddenDim, inputDim, rand),
    variableGrns: Array.from({ length: inputDim }, () => grn(1, hiddenDim, hiddenDim, rand)),
    inputDim,
    hiddenDim,
  };
}

export function variableSelectionParams(layer: VariableSelection): Tensor[] {
  return [...grnParams(layer.weightGrn), ...layer.variableGrns.flatMap(grnParams)];
}

export interface VariableSelectionResult {
  output: Tensor;
  /** 1×inputDim softmax weights. */
  weights: Tensor;
}

export function applyVariableSelection(
  layer: VariableSelection,
  x: Tensor,
): VariableSelectionResult {
  const weights = softmax(applyGrn(layer.weightGrn, x));
  let acc: Tensor | null = null;
  for (let i = 0; i < layer.inputDim; i += 1) {
    const xi = sliceCols(x, i, 1);
    const transformed = applyGrn(layer.variableGrns[i] as Grn, xi);
    const wi = sliceCols(weights, i, 1);
    // Broadcast the scalar weight across the hidden dimension.
    const broadcastCols: Tensor[] = new Array(layer.hiddenDim).fill(wi);
    const weighted = mul(transformed, concat(broadcastCols));
    acc = acc === null ? weighted : add(acc, weighted);
  }
  return { output: acc as Tensor, weights };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Serialisation
// ─────────────────────────────────────────────────────────────────────────────

export interface SerialisedWeights {
  /** Flat parameter values in the exact order `params()` returns them. */
  values: number[][];
  shapes: [number, number][];
}

export function serialiseParams(params: readonly Tensor[]): SerialisedWeights {
  return {
    values: params.map((p) => Array.from(p.data)),
    shapes: params.map((p) => p.shape),
  };
}

export function loadParams(params: readonly Tensor[], weights: SerialisedWeights): boolean {
  if (weights.values.length !== params.length) return false;
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i] as Tensor;
    const v = weights.values[i] as number[];
    const shape = weights.shapes[i] as [number, number];
    if (shape[0] !== p.rows || shape[1] !== p.cols || v.length !== p.size) return false;
  }
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i] as Tensor;
    const v = weights.values[i] as number[];
    for (let j = 0; j < p.size; j += 1) p.data[j] = v[j] as number;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Models
// ─────────────────────────────────────────────────────────────────────────────

export interface TrainingConfig {
  epochs?: number;
  batchSize?: number;
  learningRate?: number;
  weightDecay?: number;
  /** Reports progress each epoch. */
  onEpoch?: (epoch: number, trainLoss: number, validLoss: number | null) => void;
  /** Stop when validation loss has not improved for this many epochs. */
  patience?: number;
}

export interface TrainingReport {
  epochs: number;
  finalTrainLoss: number;
  finalValidLoss: number | null;
  bestValidLoss: number | null;
  history: { epoch: number; trainLoss: number; validLoss: number | null }[];
}

/** A sequence sample: `steps` timesteps × `features` inputs, one scalar target. */
export interface SequenceSample {
  sequence: number[][];
  target: number;
}

export const TFT_QUANTILES = [0.1, 0.5, 0.9] as const;

/** Shared shape metadata every temporal agent reports. */
export interface AgentSpec {
  name: string;
  timeframeMinutes: number;
  sequenceLength: number;
  inputSize: number;
  hiddenSize: number;
  architecture: 'tft' | 'bilstm' | 'lstm';
}

export interface AgentOutput {
  /** Directional probability in (0, 1). */
  probability: number;
  /** Raw logit. */
  logit: number;
  /** Expected forward return (median quantile for the TFT). */
  expectedReturn: number;
  /** Lower / upper predictive bounds, when the model produces them. */
  lower: number | null;
  upper: number | null;
  /** Attention over the input sequence (TFT), newest last. */
  attention: number[] | null;
  /** Per-feature variable-selection weights (TFT). */
  variableWeights: number[] | null;
  /** Final hidden state — published to the state vector. */
  hidden: number[];
}

// ── 5m LSTM agent ───────────────────────────────────────────────────────────

export class LstmAgent {
  readonly spec: AgentSpec;
  private readonly cell: LstmCell;
  private readonly head: Dense;

  constructor(
    inputSize: number,
    hiddenSize: number,
    sequenceLength: number,
    rand: () => number,
    options: { name?: string; timeframeMinutes?: number } = {},
  ) {
    this.cell = lstmCell(inputSize, hiddenSize, rand);
    this.head = dense(hiddenSize, 1, rand);
    this.spec = {
      name: options.name ?? '5m Tactical LSTM',
      timeframeMinutes: options.timeframeMinutes ?? 5,
      sequenceLength,
      inputSize,
      hiddenSize,
      architecture: 'lstm',
    };
  }

  params(): Tensor[] {
    return [...lstmCellParams(this.cell), ...denseParams(this.head)];
  }

  /** Forward pass returning the logit tensor (kept on the tape for training). */
  forwardLogit(sequence: readonly number[][]): { logit: Tensor; hidden: Tensor } {
    const steps = sequence.map((row) => tensor(1, this.spec.inputSize, row));
    const { final } = lstmSequence(this.cell, steps);
    return { logit: applyDense(this.head, final.h), hidden: final.h };
  }

  predict(sequence: readonly number[][]): AgentOutput {
    return noGrad(() => {
      const { logit, hidden } = this.forwardLogit(sequence);
      const z = logit.data[0] as number;
      const p = 1 / (1 + Math.exp(-z));
      return {
        probability: p,
        logit: z,
        expectedReturn: Math.tanh(z) * 0.01,
        lower: null,
        upper: null,
        attention: null,
        variableWeights: null,
        hidden: hidden.toArray(),
      };
    });
  }

  train(samples: readonly SequenceSample[], config: TrainingConfig = {}, validation?: readonly SequenceSample[]): TrainingReport {
    return trainBinary(this.params(), (s) => this.forwardLogit(s).logit, samples, config, validation);
  }
}

// ── 15m BiLSTM agent ────────────────────────────────────────────────────────

export class BiLstmAgent {
  readonly spec: AgentSpec;
  private readonly forwardCell: LstmCell;
  private readonly backwardCell: LstmCell;
  private readonly head: Dense;

  constructor(
    inputSize: number,
    hiddenSize: number,
    sequenceLength: number,
    rand: () => number,
    options: { name?: string; timeframeMinutes?: number } = {},
  ) {
    this.forwardCell = lstmCell(inputSize, hiddenSize, rand);
    this.backwardCell = lstmCell(inputSize, hiddenSize, rand);
    this.head = dense(2 * hiddenSize, 1, rand);
    this.spec = {
      name: options.name ?? '15m Contextual BiLSTM',
      timeframeMinutes: options.timeframeMinutes ?? 15,
      sequenceLength,
      inputSize,
      hiddenSize,
      architecture: 'bilstm',
    };
  }

  params(): Tensor[] {
    return [
      ...lstmCellParams(this.forwardCell),
      ...lstmCellParams(this.backwardCell),
      ...denseParams(this.head),
    ];
  }

  forwardLogit(sequence: readonly number[][]): { logit: Tensor; hidden: Tensor } {
    const steps = sequence.map((row) => tensor(1, this.spec.inputSize, row));
    const fwd = lstmSequence(this.forwardCell, steps);
    const bwd = lstmSequence(this.backwardCell, steps.slice().reverse());
    const combined = concat([fwd.final.h, bwd.final.h]);
    return { logit: applyDense(this.head, combined), hidden: combined };
  }

  predict(sequence: readonly number[][]): AgentOutput {
    return noGrad(() => {
      const { logit, hidden } = this.forwardLogit(sequence);
      const z = logit.data[0] as number;
      return {
        probability: 1 / (1 + Math.exp(-z)),
        logit: z,
        expectedReturn: Math.tanh(z) * 0.015,
        lower: null,
        upper: null,
        attention: null,
        variableWeights: null,
        hidden: hidden.toArray(),
      };
    });
  }

  train(samples: readonly SequenceSample[], config: TrainingConfig = {}, validation?: readonly SequenceSample[]): TrainingReport {
    return trainBinary(this.params(), (s) => this.forwardLogit(s).logit, samples, config, validation);
  }
}

// ── 60m Temporal Fusion Transformer agent ───────────────────────────────────

export class TftAgent {
  readonly spec: AgentSpec;
  private readonly vsn: VariableSelection;
  private readonly encoder: LstmCell;
  private readonly gateAfterLstm: Glu;
  private readonly normAfterLstm: { gain: Tensor; bias: Tensor };
  private readonly staticEnrichment: Grn;
  private readonly attention: InterpretableAttention;
  private readonly gateAfterAttention: Glu;
  private readonly normAfterAttention: { gain: Tensor; bias: Tensor };
  private readonly positionwise: Grn;
  private readonly quantileHead: Dense;
  private readonly classifierHead: Dense;

  constructor(
    inputSize: number,
    hiddenSize: number,
    sequenceLength: number,
    rand: () => number,
    options: { heads?: number; name?: string; timeframeMinutes?: number } = {},
  ) {
    const heads = options.heads ?? 4;
    const gain1 = parameter(1, hiddenSize);
    gain1.data.fill(1);
    const gain2 = parameter(1, hiddenSize);
    gain2.data.fill(1);

    this.vsn = variableSelection(inputSize, hiddenSize, rand);
    this.encoder = lstmCell(hiddenSize, hiddenSize, rand);
    this.gateAfterLstm = glu(hiddenSize, hiddenSize, rand);
    this.normAfterLstm = { gain: gain1, bias: zerosParam(1, hiddenSize) };
    this.staticEnrichment = grn(hiddenSize, hiddenSize, hiddenSize, rand);
    this.attention = interpretableAttention(hiddenSize, heads, rand);
    this.gateAfterAttention = glu(hiddenSize, hiddenSize, rand);
    this.normAfterAttention = { gain: gain2, bias: zerosParam(1, hiddenSize) };
    this.positionwise = grn(hiddenSize, hiddenSize, hiddenSize, rand);
    this.quantileHead = dense(hiddenSize, TFT_QUANTILES.length, rand);
    this.classifierHead = dense(hiddenSize, 1, rand);

    this.spec = {
      name: options.name ?? '60m Macro Temporal Fusion Transformer',
      timeframeMinutes: options.timeframeMinutes ?? 60,
      sequenceLength,
      inputSize,
      hiddenSize,
      architecture: 'tft',
    };
  }

  params(): Tensor[] {
    return [
      ...variableSelectionParams(this.vsn),
      ...lstmCellParams(this.encoder),
      ...gluParams(this.gateAfterLstm),
      this.normAfterLstm.gain,
      this.normAfterLstm.bias,
      ...grnParams(this.staticEnrichment),
      ...attentionParams(this.attention),
      ...gluParams(this.gateAfterAttention),
      this.normAfterAttention.gain,
      this.normAfterAttention.bias,
      ...grnParams(this.positionwise),
      ...denseParams(this.quantileHead),
      ...denseParams(this.classifierHead),
    ];
  }

  /**
   * Full TFT forward pass. Returns the quantile head, the classifier logit, the
   * head-averaged attention over the sequence and the mean variable-selection
   * weights — the last two are the model's built-in interpretability outputs.
   */
  forward(sequence: readonly number[][]): {
    quantiles: Tensor;
    logit: Tensor;
    attention: Tensor;
    variableWeights: Tensor;
    hidden: Tensor;
  } {
    // 1. Variable selection per timestep.
    const selected: Tensor[] = [];
    const weightRows: Tensor[] = [];
    for (const row of sequence) {
      const x = tensor(1, this.spec.inputSize, row);
      const vs = applyVariableSelection(this.vsn, x);
      selected.push(vs.output);
      weightRows.push(vs.weights);
    }

    // 2. LSTM encoder over the selected representations, with a gated skip.
    const encoded = lstmSequence(this.encoder, selected);
    const gatedSteps = encoded.outputs.map((h, i) =>
      layerNorm(
        add(selected[i] as Tensor, applyGlu(this.gateAfterLstm, h)),
        this.normAfterLstm.gain,
        this.normAfterLstm.bias,
      ),
    );
    const sequenceTensor = stackRows(gatedSteps);

    // 3. Static enrichment, then interpretable self-attention over the sequence.
    const enriched = applyGrn(this.staticEnrichment, sequenceTensor);
    const attn = applyAttention(this.attention, enriched, enriched);
    const attended = layerNorm(
      add(enriched, applyGlu(this.gateAfterAttention, attn.output)),
      this.normAfterAttention.gain,
      this.normAfterAttention.bias,
    );

    // 4. Position-wise feed-forward, then read out the final timestep.
    const processed = applyGrn(this.positionwise, attended);
    const lastIndex = sequence.length - 1;
    const finalStep = rowSlice(processed, lastIndex);

    // Mean variable-selection weights across the window.
    let weightSum: Tensor = weightRows[0] as Tensor;
    for (let i = 1; i < weightRows.length; i += 1) weightSum = add(weightSum, weightRows[i] as Tensor);
    const variableWeights = scale(weightSum, 1 / weightRows.length);

    // 5. Monotonic quantile construction. The head emits (median, δ_low, δ_high)
    //    and the quantiles are built as m − softplus(δ_low) ≤ m ≤ m + softplus(δ_high),
    //    so a predictive interval can never come out inverted regardless of how
    //    little the model has trained.
    const rawQuantiles = applyDense(this.quantileHead, finalStep);
    const median = sliceCols(rawQuantiles, 1, 1);
    const quantiles = concat([
      sub(median, softplus(sliceCols(rawQuantiles, 0, 1))),
      median,
      add(median, softplus(sliceCols(rawQuantiles, 2, 1))),
    ]);

    return {
      quantiles,
      logit: applyDense(this.classifierHead, finalStep),
      attention: rowSlice(attn.weights, lastIndex),
      variableWeights,
      hidden: finalStep,
    };
  }

  predict(sequence: readonly number[][]): AgentOutput {
    return noGrad(() => {
      const out = this.forward(sequence);
      const z = out.logit.data[0] as number;
      const q = out.quantiles.toArray();
      return {
        probability: 1 / (1 + Math.exp(-z)),
        logit: z,
        expectedReturn: q[1] ?? 0,
        lower: q[0] ?? null,
        upper: q[2] ?? null,
        attention: out.attention.toArray(),
        variableWeights: out.variableWeights.toArray(),
        hidden: out.hidden.toArray(),
      };
    });
  }

  /**
   * Joint objective: pinball loss on the forward-return quantiles plus BCE on
   * the directional head. The quantile term is what gives the 60m agent
   * calibrated uncertainty; the BCE term keeps the direction sharp.
   */
  train(
    samples: readonly SequenceSample[],
    config: TrainingConfig = {},
    validation?: readonly SequenceSample[],
    options: { returnTargets?: readonly number[]; quantileWeight?: number } = {},
  ): TrainingReport {
    const epochs = config.epochs ?? 12;
    const lr = config.learningRate ?? 3e-3;
    const patience = config.patience ?? 0;
    const qWeight = options.quantileWeight ?? 1;
    const params = this.params();
    const optimiser = new Adam(params, { learningRate: lr, weightDecay: config.weightDecay ?? 1e-5 });
    const history: { epoch: number; trainLoss: number; validLoss: number | null }[] = [];
    let bestValid: number | null = null;
    let bestEpoch = 0;
    let lastTrain = 0;
    let lastValid: number | null = null;

    const returnTargets = options.returnTargets;

    for (let epoch = 0; epoch < epochs; epoch += 1) {
      let acc = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const sample = samples[i] as SequenceSample;
        resetTape();
        optimiser.zeroGrad();
        const out = this.forward(sample.sequence);
        const cls = bceWithLogits(out.logit, tensor(1, 1, [sample.target]));
        const rTarget = returnTargets ? (returnTargets[i] as number) : sample.target * 2 - 1;
        const qLoss = quantileLoss(out.quantiles, tensor(1, 1, [rTarget]), TFT_QUANTILES as unknown as number[]);
        const loss = add(cls, scale(qLoss, qWeight));
        backward(loss);
        optimiser.step();
        acc += loss.data[0] as number;
      }
      lastTrain = samples.length === 0 ? 0 : acc / samples.length;

      lastValid = null;
      if (validation && validation.length > 0) {
        lastValid = noGrad(() => {
          let vAcc = 0;
          for (const s of validation) {
            const out = this.forward(s.sequence);
            const z = out.logit.data[0] as number;
            const p = Math.min(Math.max(1 / (1 + Math.exp(-z)), 1e-9), 1 - 1e-9);
            vAcc += -(s.target * Math.log(p) + (1 - s.target) * Math.log(1 - p));
          }
          return vAcc / validation.length;
        });
        if (bestValid === null || lastValid < bestValid - 1e-6) {
          bestValid = lastValid;
          bestEpoch = epoch;
        }
      }

      history.push({ epoch, trainLoss: lastTrain, validLoss: lastValid });
      config.onEpoch?.(epoch, lastTrain, lastValid);
      if (patience > 0 && lastValid !== null && epoch - bestEpoch >= patience) break;
    }

    return {
      epochs: history.length,
      finalTrainLoss: lastTrain,
      finalValidLoss: lastValid,
      bestValidLoss: bestValid,
      history,
    };
  }
}

// ── Shared binary training loop ─────────────────────────────────────────────

function trainBinary(
  params: Tensor[],
  forward: (sequence: readonly number[][]) => Tensor,
  samples: readonly SequenceSample[],
  config: TrainingConfig,
  validation?: readonly SequenceSample[],
): TrainingReport {
  const epochs = config.epochs ?? 12;
  const lr = config.learningRate ?? 4e-3;
  const patience = config.patience ?? 0;
  const optimiser = new Adam(params, { learningRate: lr, weightDecay: config.weightDecay ?? 1e-5 });
  const history: { epoch: number; trainLoss: number; validLoss: number | null }[] = [];
  let bestValid: number | null = null;
  let bestEpoch = 0;
  let lastTrain = 0;
  let lastValid: number | null = null;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let acc = 0;
    for (const sample of samples) {
      resetTape();
      optimiser.zeroGrad();
      const logit = forward(sample.sequence);
      const loss = bceWithLogits(logit, tensor(1, 1, [sample.target]));
      backward(loss);
      optimiser.step();
      acc += loss.data[0] as number;
    }
    lastTrain = samples.length === 0 ? 0 : acc / samples.length;

    lastValid = null;
    if (validation && validation.length > 0) {
      lastValid = noGrad(() => {
        let vAcc = 0;
        for (const s of validation) {
          const z = forward(s.sequence).data[0] as number;
          const p = Math.min(Math.max(1 / (1 + Math.exp(-z)), 1e-9), 1 - 1e-9);
          vAcc += -(s.target * Math.log(p) + (1 - s.target) * Math.log(1 - p));
        }
        return vAcc / validation.length;
      });
      if (bestValid === null || lastValid < bestValid - 1e-6) {
        bestValid = lastValid;
        bestEpoch = epoch;
      }
    }

    history.push({ epoch, trainLoss: lastTrain, validLoss: lastValid });
    config.onEpoch?.(epoch, lastTrain, lastValid);
    if (patience > 0 && lastValid !== null && epoch - bestEpoch >= patience) break;
  }

  return { epochs: history.length, finalTrainLoss: lastTrain, finalValidLoss: lastValid, bestValidLoss: bestValid, history };
}
