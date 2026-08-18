/**
 * The model bundle: the gradient-boosted conviction model, its FastTreeSHAP
 * explainer, the K-Means SHAP background, and the three temporal agents.
 *
 * Training happens once (the seed script) and the weights are serialised to
 * plain JSON so a request only ever does forward passes. Nothing here reads the
 * network or requires an API key: the ensemble is trained on the deterministic
 * market simulator, so the platform ships with a genuinely fitted model rather
 * than random weights.
 */

import { z } from 'zod';
import {
  type GbdtModel,
  featureImportance,
  predictProbability,
  trainGbdt,
} from '@/lib/quant/gbdt';
import { FastTreeShapExplainer, ensembleBaseValue, globalShapImportance } from '@/lib/quant/shap';
import { buildShapBackground } from '@/lib/quant/kmeans';
import {
  BiLstmAgent,
  LstmAgent,
  type SequenceSample,
  type SerialisedWeights,
  TftAgent,
  loadParams,
  serialiseParams,
} from '@/lib/quant/nn';
import { createRng } from '@/lib/quant/rng';
import { MODEL_FEATURE_COUNT, MODEL_FEATURE_KEYS } from './features';

export const MODEL_VERSION = 'aurelius-ensemble-1.0.0';

/** Sequence length each temporal agent consumes. */
export const AGENT_SEQUENCE_LENGTH = 24;
/** Hidden width per agent. Small enough to train in-process, large enough to fit. */
export const AGENT_HIDDEN = { lstm: 16, bilstm: 16, tft: 12 } as const;
/**
 * The agents consume a compact projection of the full feature vector rather than
 * all 80 features: an 80-wide input at 24 timesteps would dominate training time
 * without adding signal, since the tree ensemble already covers the wide
 * cross-section. These are the sequence-relevant features.
 */
export const AGENT_FEATURE_KEYS: string[] = [
  'roc_10',
  'rsi_14',
  'macd_hist',
  'atr_pct_14',
  'bb_percent_b',
  'ou_zscore',
  'kalman_innovation_z',
  'mlofi_intent',
  'rel_volume_20',
  'rel_strength_20d',
  'vol_ratio_5_20',
  'close_location',
];

export const AGENT_INPUT_SIZE = AGENT_FEATURE_KEYS.length;

// ─────────────────────────────────────────────────────────────────────────────
//  Serialisation
// ─────────────────────────────────────────────────────────────────────────────

const treeNodeSchema = z.object({
  feature: z.number(),
  threshold: z.number(),
  left: z.number(),
  right: z.number(),
  value: z.number(),
  cover: z.number(),
  count: z.number(),
});

const gbdtSchema = z.object({
  trees: z.array(z.object({ nodes: z.array(treeNodeSchema), maxDepth: z.number() })),
  baseScore: z.number(),
  learningRate: z.number(),
  objective: z.union([z.literal('logistic'), z.literal('squared')]),
  featureNames: z.array(z.string()),
  featureGain: z.array(z.number()),
  featureSplits: z.array(z.number()),
  history: z.array(z.object({ round: z.number(), trainLoss: z.number(), validLoss: z.number().optional() })),
});

const weightsSchema = z.object({
  values: z.array(z.array(z.number())),
  shapes: z.array(z.tuple([z.number(), z.number()])),
});

/**
 * One equal-width bin of the reliability curve. Kept structurally identical to
 * the chart's `CalibrationBin` so the model card hands the panel its props
 * rather than a shape the page has to translate on the way through.
 */
const reliabilityBinSchema = z.object({
  bin: z.number(),
  meanPredicted: z.number(),
  observedFrequency: z.number(),
  count: z.number(),
});

export const modelBundleSchema = z.object({
  version: z.string(),
  createdAt: z.number(),
  seed: z.number(),
  featureKeys: z.array(z.string()),
  agentFeatureKeys: z.array(z.string()),
  sequenceLength: z.number(),
  gbdt: gbdtSchema,
  background: z.object({ rows: z.array(z.array(z.number())), weights: z.array(z.number()), kSelected: z.number() }),
  agents: z.object({ lstm: weightsSchema, bilstm: weightsSchema, tft: weightsSchema }),
  /**
   * Per-agent logit offsets fitted after training. Defaulted so a bundle written
   * before calibration existed still loads, uncalibrated, rather than failing.
   */
  calibration: z.object({ lstm: z.number(), bilstm: z.number(), tft: z.number() }).default({ lstm: 0, bilstm: 0, tft: 0 }),
  training: z.object({
    samples: z.number(),
    validationSamples: z.number(),
    positiveRate: z.number(),
    gbdtTrainLoss: z.number(),
    gbdtValidLoss: z.number().nullable(),
    accuracy: z.number(),
    validationAccuracy: z.number(),
    auc: z.number(),
    brier: z.number(),
    lstmValidLoss: z.number().nullable(),
    bilstmValidLoss: z.number().nullable(),
    tftValidLoss: z.number().nullable(),
    discrimination: z
      .object({ lstm: z.number(), bilstm: z.number(), tft: z.number() })
      .default({ lstm: 0, bilstm: 0, tft: 0 }),
    /*
     * The reliability curve over the held-out split, and the count-weighted
     * error across its bins.
     *
     * Defaulted for the same reason as `discrimination` above: a bundle
     * serialised before the calibration panel existed carries neither field, and
     * it has to keep loading. An existing `.data/models/ensemble.json` therefore
     * parses to an empty curve, which the panel renders as its own empty state
     * until the model is next trained — rather than failing validation and
     * taking the whole deployment down to a setup screen over a chart.
     *
     * `ece` defaults to null and not to 0 because 0 is the score of a perfectly
     * calibrated model: an unmeasured bundle must not be able to claim it.
     */
    reliability: z.array(reliabilityBinSchema).default([]),
    ece: z.number().nullable().default(null),
    elapsedMs: z.number(),
  }),
});

export type SerialisedModelBundle = z.infer<typeof modelBundleSchema>;

/** One equal-width probability bin of the reliability curve. */
export interface ReliabilityBin {
  /** Index into the equal-width partition of [0, 1]. */
  bin: number;
  /** Mean predicted probability of the observations that fell in the bin. */
  meanPredicted: number;
  /** Fraction of those observations whose label was positive. */
  observedFrequency: number;
  count: number;
}

export interface TrainingMetrics {
  samples: number;
  validationSamples: number;
  positiveRate: number;
  gbdtTrainLoss: number;
  gbdtValidLoss: number | null;
  accuracy: number;
  validationAccuracy: number;
  auc: number;
  brier: number;
  lstmValidLoss: number | null;
  bilstmValidLoss: number | null;
  tftValidLoss: number | null;
  /** Std-dev of each agent's predicted probability over the validation split. */
  discrimination: { lstm: number; bilstm: number; tft: number };
  /** Reliability bins over the validation split. Empty bins are not reported. */
  reliability: ReliabilityBin[];
  /** Expected calibration error over those bins; null when it was not measured. */
  ece: number | null;
  elapsedMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Bundle
// ─────────────────────────────────────────────────────────────────────────────

export class ModelBundle {
  readonly version: string;
  readonly createdAt: number;
  readonly seed: number;
  readonly gbdt: GbdtModel;
  readonly explainer: FastTreeShapExplainer;
  readonly background: { rows: number[][]; weights: number[]; kSelected: number };
  readonly lstm: LstmAgent;
  readonly bilstm: BiLstmAgent;
  readonly tft: TftAgent;
  readonly training: TrainingMetrics;
  readonly featureKeys: string[];
  readonly agentFeatureKeys: string[];
  readonly sequenceLength: number;

  constructor(params: {
    version: string;
    createdAt: number;
    seed: number;
    gbdt: GbdtModel;
    background: { rows: number[][]; weights: number[]; kSelected: number };
    lstm: LstmAgent;
    bilstm: BiLstmAgent;
    tft: TftAgent;
    training: TrainingMetrics;
    featureKeys: string[];
    agentFeatureKeys: string[];
    sequenceLength: number;
  }) {
    this.version = params.version;
    this.createdAt = params.createdAt;
    this.seed = params.seed;
    this.gbdt = params.gbdt;
    this.explainer = new FastTreeShapExplainer(params.gbdt);
    this.background = params.background;
    this.lstm = params.lstm;
    this.bilstm = params.bilstm;
    this.tft = params.tft;
    this.training = params.training;
    this.featureKeys = params.featureKeys;
    this.agentFeatureKeys = params.agentFeatureKeys;
    this.sequenceLength = params.sequenceLength;
  }

  /** E[f(x)] over the training distribution, in log-odds. */
  get expectedValue(): number {
    return ensembleBaseValue(this.gbdt);
  }

  probability(vector: readonly number[]): number {
    return predictProbability(this.gbdt, vector);
  }

  /** Model card payload for the transparency page. */
  card(): ModelCard {
    return {
      version: this.version,
      createdAt: this.createdAt,
      seed: this.seed,
      objective: 'Probability the symbol outperforms the benchmark over the signal horizon.',
      trees: this.explainer.treeCount,
      leaves: this.explainer.leafCount,
      maxDepth: this.explainer.maxDepth,
      featureCount: this.featureKeys.length,
      expectedValue: this.expectedValue,
      backgroundRows: this.background.rows.length,
      backgroundK: this.background.kSelected,
      shapEngine: 'FastTreeSHAP v2 (path pre-compilation), exact path-dependent TreeSHAP values',
      agents: [this.tft.spec, this.bilstm.spec, this.lstm.spec],
      training: this.training,
      topFeatures: featureImportance(this.gbdt).slice(0, 15),
      globalShap: globalShapImportance(this.explainer, this.background.rows.slice(0, 40)).slice(0, 15),
      limitations: MODEL_LIMITATIONS,
    };
  }

  serialise(): SerialisedModelBundle {
    return {
      version: this.version,
      createdAt: this.createdAt,
      seed: this.seed,
      featureKeys: this.featureKeys,
      agentFeatureKeys: this.agentFeatureKeys,
      sequenceLength: this.sequenceLength,
      gbdt: this.gbdt as unknown as SerialisedModelBundle['gbdt'],
      background: this.background,
      agents: {
        lstm: serialiseParams(this.lstm.params()),
        bilstm: serialiseParams(this.bilstm.params()),
        tft: serialiseParams(this.tft.params()),
      },
      calibration: {
        lstm: this.lstm.calibrationOffset,
        bilstm: this.bilstm.calibrationOffset,
        tft: this.tft.calibrationOffset,
      },
      training: this.training,
    };
  }

  static deserialise(raw: unknown): ModelBundle {
    const parsed = modelBundleSchema.parse(raw);
    const rand = createRng(parsed.seed).next;
    const lstm = new LstmAgent(AGENT_INPUT_SIZE, AGENT_HIDDEN.lstm, parsed.sequenceLength, rand);
    const bilstm = new BiLstmAgent(AGENT_INPUT_SIZE, AGENT_HIDDEN.bilstm, parsed.sequenceLength, rand);
    const tft = new TftAgent(AGENT_INPUT_SIZE, AGENT_HIDDEN.tft, parsed.sequenceLength, rand, { heads: 3 });

    const loaded =
      loadParams(lstm.params(), parsed.agents.lstm as SerialisedWeights) &&
      loadParams(bilstm.params(), parsed.agents.bilstm as SerialisedWeights) &&
      loadParams(tft.params(), parsed.agents.tft as SerialisedWeights);
    if (!loaded) {
      throw new Error('ModelBundle.deserialise: agent weight shapes do not match the current architecture');
    }

    // The offsets are inference-time state, not parameters, so they ride
    // alongside the weights rather than inside them.
    lstm.calibrationOffset = parsed.calibration.lstm;
    bilstm.calibrationOffset = parsed.calibration.bilstm;
    tft.calibrationOffset = parsed.calibration.tft;

    return new ModelBundle({
      version: parsed.version,
      createdAt: parsed.createdAt,
      seed: parsed.seed,
      gbdt: parsed.gbdt as unknown as GbdtModel,
      background: parsed.background,
      lstm,
      bilstm,
      tft,
      training: parsed.training,
      featureKeys: parsed.featureKeys,
      agentFeatureKeys: parsed.agentFeatureKeys,
      sequenceLength: parsed.sequenceLength,
    });
  }
}

export interface ModelCard {
  version: string;
  createdAt: number;
  seed: number;
  objective: string;
  trees: number;
  leaves: number;
  maxDepth: number;
  featureCount: number;
  expectedValue: number;
  backgroundRows: number;
  backgroundK: number;
  shapEngine: string;
  agents: { name: string; architecture: string; timeframeMinutes: number; hiddenSize: number; sequenceLength: number; inputSize: number }[];
  training: TrainingMetrics;
  topFeatures: { feature: string; gain: number; splits: number; share: number }[];
  globalShap: { feature: string; meanAbsShap: number; share: number }[];
  limitations: string[];
}

/**
 * Stated limitations. The compliance research is explicit that marketing must
 * accurately reflect actual capability — SEC "AI-washing" enforcement — so the
 * model card names what this model cannot do.
 */
export const MODEL_LIMITATIONS: string[] = [
  'The ensemble is fitted on the deterministic market simulator bundled with this platform, not on licensed historical market data. Its measured accuracy describes the simulator, not live markets.',
  'The conviction score is the modelled probability of outperforming the benchmark over the stated horizon. It is not a price target, not a guarantee, and not a recommendation.',
  'SHAP attributions explain the model, not the market. They are exact with respect to this ensemble and carry no causal claim.',
  'The three temporal agents are trained on a bounded in-process budget so the platform installs without a GPU. Their capacity is deliberately small.',
  'Options-derived features are unavailable for symbols without a listed chain, and those feature blocks read zero rather than being imputed.',
  'Alternative-data streams in the default configuration are synthetic. Live streams require the corresponding provider keys.',
  'No model output accounts for any individual financial situation, and none is personalised in any way.',
];

// ─────────────────────────────────────────────────────────────────────────────
//  Training
// ─────────────────────────────────────────────────────────────────────────────

export interface TrainingDataset {
  /** Full feature vectors, aligned to MODEL_FEATURE_KEYS. */
  x: number[][];
  /** 1 when the symbol outperformed the benchmark over the horizon. */
  y: number[];
  /** Forward benchmark-relative return, the TFT's quantile target. */
  forwardReturn: number[];
  /** Agent sequences, aligned to AGENT_FEATURE_KEYS × sequenceLength. */
  sequences: number[][][];
  /**
   * Per-sample metadata. `labelTime` is when the sample's outcome became
   * knowable, and the trainer uses it to purge the boundary — see the embargo in
   * `trainModelBundle`.
   */
  meta: { symbol: string; time: number; labelTime: number }[];
}

export interface TrainOptions {
  seed?: number;
  /** Fraction of the dataset held back, taken from the END (no leakage). */
  validationFraction?: number;
  gbdtRounds?: number;
  agentEpochs?: number;
  tftEpochs?: number;
  onProgress?: (stage: string, detail: string) => void;
}

export function trainModelBundle(dataset: TrainingDataset, options: TrainOptions = {}): ModelBundle {
  const started = Date.now();
  const seed = options.seed ?? 20240117;
  const rng = createRng(`train:${seed}`);
  const rand = rng.next;
  const validationFraction = options.validationFraction ?? 0.2;
  const report = options.onProgress ?? ((): void => {});

  const n = dataset.x.length;
  if (n < 50) throw new Error(`trainModelBundle: dataset too small (${n} samples)`);
  // Chronological split — a random split would leak the future into training.
  const splitIndex = Math.max(20, Math.floor(n * (1 - validationFraction)));

  /*
   * Purge the boundary.
   *
   * A chronological split makes the validation set out-of-time in its *features*.
   * It does not, on its own, make it out-of-time in its *outcomes*: a training
   * sample taken five sessions before the boundary is labelled by a close that
   * falls after it, so the model is fitted on information from inside the window
   * it is then scored on. That is López de Prado's purging problem, and it
   * inflates the out-of-sample figure — the one number on the model card that is
   * supposed to be the honest one.
   *
   * Every training sample whose label was observed at or after the first
   * validation instant is dropped. There is no embargo on the other side: the
   * validation samples are scored, never fitted, so a validation feature window
   * that overlaps training data costs nothing.
   */
  const firstValidationInstant = dataset.meta[splitIndex]?.time ?? Number.POSITIVE_INFINITY;
  const trainIndices: number[] = [];
  for (let i = 0; i < splitIndex; i += 1) {
    const labelTime = dataset.meta[i]?.labelTime;
    if (labelTime !== undefined && labelTime >= firstValidationInstant) continue;
    trainIndices.push(i);
  }
  const purged = splitIndex - trainIndices.length;

  const trainX = trainIndices.map((i) => dataset.x[i] as number[]);
  const trainY = trainIndices.map((i) => dataset.y[i] as number);
  const validX = dataset.x.slice(splitIndex);
  const validY = dataset.y.slice(splitIndex);

  report(
    'gbdt',
    `training on ${trainX.length} samples, validating on ${validX.length}` +
      (purged > 0 ? ` (${purged} purged at the boundary)` : ''),
  );
  const gbdt = trainGbdt(
    trainX,
    trainY,
    {
      rounds: options.gbdtRounds ?? 160,
      // Deliberately shallow and heavily regularised. With ~1.6k samples over 89
      // features an unconstrained ensemble memorises the training set (98% train
      // accuracy against 57% out of sample was the measured result at depth 5).
      // Depth 3 with a large L2 term and aggressive column subsampling trades
      // in-sample fit for out-of-sample AUC, which is the only number that means
      // anything here.
      learningRate: 0.04,
      maxDepth: 3,
      minChildWeight: 6,
      minSamplesLeaf: 25,
      lambda: 6,
      gamma: 0.05,
      bins: 24,
      colsampleByTree: 0.45,
      subsample: 0.7,
      objective: 'logistic',
      featureNames: MODEL_FEATURE_KEYS.slice(),
      earlyStoppingRounds: 20,
      random: rand,
    },
    { x: validX, y: validY },
  );

  const finalHistory = gbdt.history[gbdt.history.length - 1];
  report('shap-background', 'summarising the background distribution by K-Means elbow');
  const backgroundSource = trainX.length > 600 ? trainX.slice(-600) : trainX;
  const bg = buildShapBackground(backgroundSource, { kMin: 50, kMax: 100, random: rand });

  // ── Temporal agents ──────────────────────────────────────────────────────
  // Same purged index set as the tree model: an embargo applied to one component
  // and not the other three would leave the ensemble's headline figure inflated
  // by whichever component still saw across the boundary.
  const trainSamples: SequenceSample[] = trainIndices.map((i) => ({
    sequence: dataset.sequences[i] as number[][],
    target: dataset.y[i] as number,
  }));
  const validSamples: SequenceSample[] = dataset.sequences
    .slice(splitIndex)
    .map((sequence, i) => ({ sequence, target: dataset.y[splitIndex + i] as number }));
  const trainReturns = trainIndices.map((i) => dataset.forwardReturn[i] as number);

  const sequenceLength = trainSamples[0]?.sequence.length ?? AGENT_SEQUENCE_LENGTH;

  report('lstm', `5m tactical agent, ${trainSamples.length} sequences`);
  const lstm = new LstmAgent(AGENT_INPUT_SIZE, AGENT_HIDDEN.lstm, sequenceLength, rand);
  const lstmReport = lstm.train(trainSamples, { epochs: options.agentEpochs ?? 5, learningRate: 5e-3, patience: 3 }, validSamples);

  report('bilstm', `15m contextual agent, ${trainSamples.length} sequences`);
  const bilstm = new BiLstmAgent(AGENT_INPUT_SIZE, AGENT_HIDDEN.bilstm, sequenceLength, rand);
  const bilstmReport = bilstm.train(trainSamples, { epochs: options.agentEpochs ?? 5, learningRate: 5e-3, patience: 3 }, validSamples);

  report('tft', `60m macro agent with quantile head, ${trainSamples.length} sequences`);
  const tft = new TftAgent(AGENT_INPUT_SIZE, AGENT_HIDDEN.tft, sequenceLength, rand, { heads: 3 });
  const tftReport = tft.train(
    trainSamples,
    { epochs: options.tftEpochs ?? 4, learningRate: 4e-3, patience: 2 },
    validSamples,
    { returnTargets: trainReturns, quantileWeight: 0.6 },
  );

  /*
   * Calibrate each agent onto the base rate before anything reads it.
   *
   * All three came out of training with a mean predicted probability near 0.75
   * against a 49.5% base rate — validation losses worse than a coin flip — so the
   * router's aggregate was positive for every symbol and all 67 tradable names
   * published as long. The offset is one number per agent, fitted on the held-out
   * split; it moves the distribution without touching the relative ordering the
   * network learned, which is the part that carries whatever signal there is.
   */
  const calibrationRate = trainY.reduce((a, b) => a + b, 0) / Math.max(1, trainY.length);
  const validLogits = (agent: { predict(s: readonly number[][]): { logit: number } }): number[] =>
    validSamples.map((sample) => agent.predict(sample.sequence).logit);
  lstm.calibrate(validLogits(lstm), calibrationRate);
  bilstm.calibrate(validLogits(bilstm), calibrationRate);
  tft.calibrate(validLogits(tft), calibrationRate);

  // ── Diagnostics ──────────────────────────────────────────────────────────
  /*
   * How much each agent's output actually moves with its input.
   *
   * The 60m TFT was returning 0.7711 for every symbol in the universe — a spread
   * of 7.6e-4 across validation sequences, against 0.35 for the LSTM — so it was
   * contributing a constant positive bias to the router's aggregate and every one
   * of the 67 names came out long. A collapsed agent is not a neutral one: it
   * votes, with conviction, for whatever its bias happens to be.
   *
   * The spread is measured here, published on the model card, and read by the
   * router, which gives an agent that does not discriminate no weight.
   */
  const discrimination = {
    lstm: probabilitySpread(lstm, validSamples),
    bilstm: probabilitySpread(bilstm, validSamples),
    tft: probabilitySpread(tft, validSamples),
  };

  const trainProbs = trainX.map((row) => predictProbability(gbdt, row));
  const validProbs = validX.map((row) => predictProbability(gbdt, row));
  const accuracy = classificationAccuracy(trainProbs, trainY);
  const validationAccuracy = validX.length > 0 ? classificationAccuracy(validProbs, validY) : accuracy;
  const auc = validX.length > 0 ? rocAuc(validProbs, validY) : rocAuc(trainProbs, trainY);
  const brier = validX.length > 0 ? brierScore(validProbs, validY) : brierScore(trainProbs, trainY);

  /*
   * Reliability of the same held-out predictions the AUC and the Brier score are
   * read from. The calibration panel is a projection of these bins; nothing
   * re-scores the model to draw it.
   *
   * Empty bins are dropped rather than published as zero. A bin nothing landed
   * in carries no observation, and reporting an observed frequency of 0 for it
   * would put a point on the axis asserting the model was wrong there.
   *
   * Unlike the AUC and the Brier score there is no fall back to the training
   * split when nothing is held out: the panel states the curve is out-of-sample,
   * so a curve that is not out-of-sample must not exist.
   */
  const reliability = validX.length > 0 ? reliabilityCurve(validProbs, validY).filter((b) => b.count > 0) : [];
  const ece = validX.length > 0 ? expectedCalibrationError(validProbs, validY) : null;

  const training: TrainingMetrics = {
    samples: trainX.length,
    validationSamples: validX.length,
    positiveRate: trainY.reduce((a, b) => a + b, 0) / Math.max(1, trainY.length),
    gbdtTrainLoss: finalHistory?.trainLoss ?? 0,
    gbdtValidLoss: finalHistory?.validLoss ?? null,
    accuracy,
    validationAccuracy,
    auc,
    brier,
    lstmValidLoss: lstmReport.bestValidLoss,
    bilstmValidLoss: bilstmReport.bestValidLoss,
    tftValidLoss: tftReport.bestValidLoss,
    discrimination,
    reliability,
    ece,
    elapsedMs: Date.now() - started,
  };

  return new ModelBundle({
    version: MODEL_VERSION,
    createdAt: started,
    seed,
    gbdt,
    background: { rows: bg.background, weights: bg.weights, kSelected: bg.kSelected },
    lstm,
    bilstm,
    tft,
    training,
    featureKeys: MODEL_FEATURE_KEYS.slice(),
    agentFeatureKeys: AGENT_FEATURE_KEYS.slice(),
    sequenceLength,
  });
}

export function classificationAccuracy(probabilities: readonly number[], labels: readonly number[]): number {
  if (probabilities.length === 0) return 0;
  let correct = 0;
  for (let i = 0; i < probabilities.length; i += 1) {
    const predicted = (probabilities[i] as number) >= 0.5 ? 1 : 0;
    if (predicted === (labels[i] as number)) correct += 1;
  }
  return correct / probabilities.length;
}

/** ROC AUC by the Mann–Whitney U statistic (rank-based, ties averaged). */
export function rocAuc(scores: readonly number[], labels: readonly number[]): number {
  const pairs = scores.map((s, i) => ({ s, y: labels[i] as number })).sort((a, b) => a.s - b.s);
  const n = pairs.length;
  let positives = 0;
  for (const p of pairs) positives += p.y;
  const negatives = n - positives;
  if (positives === 0 || negatives === 0) return 0.5;

  // Average ranks over ties.
  const ranks = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && (pairs[j + 1] as { s: number }).s === (pairs[i] as { s: number }).s) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[k] = avg;
    i = j + 1;
  }
  let rankSumPositive = 0;
  for (let k = 0; k < n; k += 1) if ((pairs[k] as { y: number }).y === 1) rankSumPositive += ranks[k] as number;
  return (rankSumPositive - (positives * (positives + 1)) / 2) / (positives * negatives);
}

export function brierScore(probabilities: readonly number[], labels: readonly number[]): number {
  if (probabilities.length === 0) return 0;
  let acc = 0;
  for (let i = 0; i < probabilities.length; i += 1) acc += ((probabilities[i] as number) - (labels[i] as number)) ** 2;
  return acc / probabilities.length;
}

/**
 * Reliability curve for the calibration panel: observed frequency versus mean
 * predicted probability, in equal-width bins.
 */
export function reliabilityCurve(
  probabilities: readonly number[],
  labels: readonly number[],
  bins = 10,
): ReliabilityBin[] {
  const buckets = Array.from({ length: bins }, () => ({ sumP: 0, sumY: 0, count: 0 }));
  for (let i = 0; i < probabilities.length; i += 1) {
    const p = probabilities[i] as number;
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
    const b = buckets[idx] as { sumP: number; sumY: number; count: number };
    b.sumP += p;
    b.sumY += labels[i] as number;
    b.count += 1;
  }
  return buckets.map((b, i) => ({
    bin: i,
    meanPredicted: b.count === 0 ? (i + 0.5) / bins : b.sumP / b.count,
    observedFrequency: b.count === 0 ? 0 : b.sumY / b.count,
    count: b.count,
  }));
}

/**
 * Standard deviation of an agent's predicted probability across a sample set.
 *
 * The measure of whether an agent is reading its input at all. A model that has
 * collapsed to its bias scores ~0 here however good its loss looks, because a
 * constant prediction on a balanced set is a perfectly ordinary loss.
 */
export function probabilitySpread(
  agent: { predict(sequence: readonly number[][]): { probability: number } },
  samples: readonly SequenceSample[],
): number {
  if (samples.length < 2) return 0;
  const probabilities = samples.map((sample) => agent.predict(sample.sequence).probability);
  const mean = probabilities.reduce((a, b) => a + b, 0) / probabilities.length;
  const variance =
    probabilities.reduce((a, p) => a + (p - mean) * (p - mean), 0) / (probabilities.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

/**
 * Below this an agent is treated as carrying no directional information.
 *
 * A probability that moves by less than a percentage point across the whole
 * validation set is a constant with noise on it.
 */
export const AGENT_DISCRIMINATION_FLOOR = 0.01;

/** Expected calibration error over the reliability curve. */
export function expectedCalibrationError(
  probabilities: readonly number[],
  labels: readonly number[],
  bins = 10,
): number {
  const curve = reliabilityCurve(probabilities, labels, bins);
  const total = probabilities.length;
  if (total === 0) return 0;
  let acc = 0;
  for (const b of curve) {
    if (b.count === 0) continue;
    acc += (b.count / total) * Math.abs(b.observedFrequency - b.meanPredicted);
  }
  return acc;
}

/** Sanity check that the registry and the model agree on the vector shape. */
export function assertFeatureVectorShape(vector: readonly number[]): void {
  if (vector.length !== MODEL_FEATURE_COUNT) {
    throw new Error(
      `Feature vector length ${vector.length} does not match the registry (${MODEL_FEATURE_COUNT})`,
    );
  }
}
