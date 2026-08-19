/**
 * Gradient-boosted decision trees — the conviction model whose attributions the
 * XAI layer explains.
 *
 * Second-order (Newton) boosting in the XGBoost formulation: for a split of a
 * node with gradient sum G and hessian sum H,
 *
 *   gain = ½ · [ G_L²/(H_L+λ) + G_R²/(H_R+λ) − G²/(H+λ) ] − γ
 *   leaf = −G / (H + λ) · η
 *
 * with logistic loss for the binary "beats the benchmark over the horizon"
 * target: p = σ(F), g = p − y, h = p(1 − p).
 *
 * Splitting is histogram-based (fixed bin count per feature) so training a
 * few hundred trees over a few thousand rows completes inside a request.
 */

import { EPS, clamp } from './stats';

export interface TreeNode {
  /** −1 for a leaf. */
  feature: number;
  /** Split threshold; samples with value ≤ threshold go left. */
  threshold: number;
  left: number;
  right: number;
  /** Leaf output (raw score contribution). */
  value: number;
  /** Sum of hessians reaching this node — the TreeSHAP "cover". */
  cover: number;
  /** Number of training samples reaching this node. */
  count: number;
}

export interface DecisionTree {
  nodes: TreeNode[];
  maxDepth: number;
}

export interface GbdtModel {
  trees: DecisionTree[];
  /** Raw base score F₀ (log-odds for the logistic objective). */
  baseScore: number;
  learningRate: number;
  objective: 'logistic' | 'squared';
  featureNames: string[];
  /**
   * Total gain accumulated per feature — global importance. Counts only splits
   * in `trees`, so it still describes the model after early stopping truncates
   * the ensemble.
   */
  featureGain: number[];
  /** Split count per feature, over the same surviving trees as `featureGain`. */
  featureSplits: number[];
  /**
   * Training diagnostics per boosting round, one entry per surviving tree.
   * `history.length === trees.length` always holds, so the last entry is the
   * loss of the model that is actually returned rather than of the best round
   * plus the patience window that followed it.
   */
  history: { round: number; trainLoss: number; validLoss?: number }[];
}

export interface GbdtOptions {
  rounds?: number;
  learningRate?: number;
  maxDepth?: number;
  minChildWeight?: number;
  minSamplesLeaf?: number;
  /** L2 leaf regularisation λ. */
  lambda?: number;
  /** Minimum-gain-to-split γ. */
  gamma?: number;
  /** Histogram bins per feature. */
  bins?: number;
  /** Fraction of features considered per split. */
  colsampleByTree?: number;
  /** Fraction of rows sampled per tree. */
  subsample?: number;
  objective?: 'logistic' | 'squared';
  featureNames?: string[];
  /** Stop when validation loss has not improved for this many rounds. */
  earlyStoppingRounds?: number;
  /** Deterministic RNG draw in [0,1) for subsampling. */
  random?: () => number;
}

const LEAF = -1;

export function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

export function logit(p: number): number {
  const q = clamp(p, 1e-9, 1 - 1e-9);
  return Math.log(q / (1 - q));
}

interface Histogram {
  /** `edges[f]` are the ascending bin upper-bounds for feature f. */
  edges: number[][];
  /** `binned[i][f]` is the bin index of sample i on feature f. */
  binned: Uint8Array[];
}

/** Quantile bin edges so each bin holds a comparable number of samples. */
function buildHistogram(x: readonly number[][], bins: number): Histogram {
  const n = x.length;
  const d = n === 0 ? 0 : (x[0] as number[]).length;
  const edges: number[][] = [];
  for (let f = 0; f < d; f += 1) {
    const column = new Array<number>(n);
    for (let i = 0; i < n; i += 1) column[i] = (x[i] as number[])[f] as number;
    column.sort((a, b) => a - b);
    const uniq: number[] = [];
    for (let b = 1; b < bins; b += 1) {
      const q = column[Math.min(n - 1, Math.floor((b * n) / bins))] as number;
      if (uniq.length === 0 || q > (uniq[uniq.length - 1] as number) + EPS) uniq.push(q);
    }
    edges.push(uniq);
  }
  const binned: Uint8Array[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const row = new Uint8Array(d);
    for (let f = 0; f < d; f += 1) {
      const e = edges[f] as number[];
      const v = (x[i] as number[])[f] as number;
      let lo = 0;
      let hi = e.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (v <= (e[mid] as number)) hi = mid;
        else lo = mid + 1;
      }
      row[f] = lo;
    }
    binned[i] = row;
  }
  return { edges, binned };
}

interface TrainCtx {
  hist: Histogram;
  grad: Float64Array;
  hess: Float64Array;
  opts: Required<Omit<GbdtOptions, 'featureNames' | 'random' | 'earlyStoppingRounds'>>;
  featureGain: number[];
  featureSplits: number[];
  random: () => number;
  dims: number;
}

function buildTree(ctx: TrainCtx, indices: number[]): DecisionTree {
  const nodes: TreeNode[] = [];
  const { opts, dims } = ctx;

  const featureMask: boolean[] = new Array(dims).fill(true);
  if (opts.colsampleByTree < 1) {
    for (let f = 0; f < dims; f += 1) featureMask[f] = ctx.random() < opts.colsampleByTree;
    if (!featureMask.some(Boolean)) featureMask[Math.floor(ctx.random() * dims) % dims] = true;
  }

  const build = (rows: number[], depth: number): number => {
    let G = 0;
    let H = 0;
    for (const i of rows) {
      G += ctx.grad[i] as number;
      H += ctx.hess[i] as number;
    }
    const nodeIndex = nodes.length;
    nodes.push({
      feature: LEAF,
      threshold: 0,
      left: LEAF,
      right: LEAF,
      value: (-G / (H + opts.lambda)) * opts.learningRate,
      cover: H,
      count: rows.length,
    });

    if (depth >= opts.maxDepth || rows.length < 2 * opts.minSamplesLeaf || H < 2 * opts.minChildWeight) {
      return nodeIndex;
    }

    const parentScore = (G * G) / (H + opts.lambda);
    let bestGain = 0;
    let bestFeature = LEAF;
    let bestBin = -1;

    for (let f = 0; f < dims; f += 1) {
      if (!featureMask[f]) continue;
      const edges = ctx.hist.edges[f] as number[];
      const nBins = edges.length + 1;
      if (nBins < 2) continue;
      const gSum = new Float64Array(nBins);
      const hSum = new Float64Array(nBins);
      const cSum = new Int32Array(nBins);
      for (const i of rows) {
        const b = (ctx.hist.binned[i] as Uint8Array)[f] as number;
        gSum[b] = (gSum[b] as number) + (ctx.grad[i] as number);
        hSum[b] = (hSum[b] as number) + (ctx.hess[i] as number);
        cSum[b] = (cSum[b] as number) + 1;
      }
      let gLeft = 0;
      let hLeft = 0;
      let cLeft = 0;
      for (let b = 0; b < nBins - 1; b += 1) {
        gLeft += gSum[b] as number;
        hLeft += hSum[b] as number;
        cLeft += cSum[b] as number;
        const cRight = rows.length - cLeft;
        if (cLeft < opts.minSamplesLeaf || cRight < opts.minSamplesLeaf) continue;
        const hRight = H - hLeft;
        if (hLeft < opts.minChildWeight || hRight < opts.minChildWeight) continue;
        const gRight = G - gLeft;
        const gain =
          0.5 *
            ((gLeft * gLeft) / (hLeft + opts.lambda) +
              (gRight * gRight) / (hRight + opts.lambda) -
              parentScore) -
          opts.gamma;
        if (gain > bestGain) {
          bestGain = gain;
          bestFeature = f;
          bestBin = b;
        }
      }
    }

    if (bestFeature === LEAF || bestBin < 0) return nodeIndex;

    const threshold = (ctx.hist.edges[bestFeature] as number[])[bestBin] as number;
    const leftRows: number[] = [];
    const rightRows: number[] = [];
    for (const i of rows) {
      if (((ctx.hist.binned[i] as Uint8Array)[bestFeature] as number) <= bestBin) leftRows.push(i);
      else rightRows.push(i);
    }
    if (leftRows.length === 0 || rightRows.length === 0) return nodeIndex;

    ctx.featureGain[bestFeature] = (ctx.featureGain[bestFeature] as number) + bestGain;
    ctx.featureSplits[bestFeature] = (ctx.featureSplits[bestFeature] as number) + 1;

    const node = nodes[nodeIndex] as TreeNode;
    node.feature = bestFeature;
    node.threshold = threshold;
    node.left = build(leftRows, depth + 1);
    node.right = build(rightRows, depth + 1);
    return nodeIndex;
  };

  build(indices, 0);
  return { nodes, maxDepth: opts.maxDepth };
}

export function trainGbdt(
  x: readonly number[][],
  y: readonly number[],
  options: GbdtOptions = {},
  validation?: { x: readonly number[][]; y: readonly number[] },
): GbdtModel {
  const n = x.length;
  const dims = n === 0 ? 0 : (x[0] as number[]).length;
  const objective = options.objective ?? 'logistic';
  const opts = {
    rounds: options.rounds ?? 120,
    learningRate: options.learningRate ?? 0.06,
    maxDepth: options.maxDepth ?? 5,
    minChildWeight: options.minChildWeight ?? 1,
    minSamplesLeaf: options.minSamplesLeaf ?? 12,
    lambda: options.lambda ?? 1,
    gamma: options.gamma ?? 0,
    bins: options.bins ?? 32,
    colsampleByTree: options.colsampleByTree ?? 0.8,
    subsample: options.subsample ?? 0.85,
    objective,
  };
  const random = options.random ?? (() => 0.5);
  const featureNames = options.featureNames ?? Array.from({ length: dims }, (_, i) => `f${i}`);

  if (n === 0 || dims === 0) {
    return {
      trees: [],
      baseScore: 0,
      learningRate: opts.learningRate,
      objective,
      featureNames,
      featureGain: new Array(dims).fill(0),
      featureSplits: new Array(dims).fill(0),
      history: [],
    };
  }

  const positiveRate = clamp(y.reduce((a, b) => a + b, 0) / n, 1e-6, 1 - 1e-6);
  const baseScore = objective === 'logistic' ? logit(positiveRate) : y.reduce((a, b) => a + b, 0) / n;

  const hist = buildHistogram(x, opts.bins);
  const raw = new Float64Array(n).fill(baseScore);
  const grad = new Float64Array(n);
  const hess = new Float64Array(n);

  const ctx: TrainCtx = {
    hist,
    grad,
    hess,
    opts,
    featureGain: new Array(dims).fill(0),
    featureSplits: new Array(dims).fill(0),
    random,
    dims,
  };

  const trees: DecisionTree[] = [];
  const history: { round: number; trainLoss: number; validLoss?: number }[] = [];
  /*
   * Running totals of `ctx.featureGain` / `ctx.featureSplits` snapshotted after
   * each tree, so importance can be rewound to whichever tree early stopping
   * keeps.
   *
   * `ctx` accumulates across the whole run and `buildTree` discards its per-node
   * gain, so without these the counters describe every tree that was ever built,
   * including the ones truncated away below. That is not a rounding difference:
   * the 92-tree ensemble that exposed this published 734 splits against 605 real
   * internal nodes — 17.6% of the feature importance on the model card belonged
   * to trees the model did not contain, and `sector_rel_strength` was credited
   * with 46 splits where it had 40.
   *
   * The snapshots are cumulative rather than per-tree so that the value wanted
   * at the end is a single index rather than a sum: entry i is the total through
   * tree i. Two arrays of `dims` numbers for every round the loop runs — the
   * kept ones and the patience window that follows them — which is nothing next
   * to the trees themselves.
   *
   * Those figures are in the past tense on purpose. They describe the bundle
   * that exposed the defect, not the one on disk now: `.data/` is git-ignored and
   * the ensemble is re-fitted per deployment, so any transcription of its size is
   * stale the moment someone runs `npm run seed`. This block spent a while
   * asserting "112 × 89 on the shipped model" and "the shipped 92-tree ensemble"
   * in the present tense, of a bundle a retrain had already replaced with a
   * smaller one; substituting the new dimensions would only have reset the clock
   * on the same defect. `engine/model.ts` declines to write out the
   * agent-discrimination measurements for the same reason.
   */
  const gainThroughTree: number[][] = [];
  const splitsThroughTree: number[][] = [];
  let bestValid = Infinity;
  let bestRound = 0;
  const patience = options.earlyStoppingRounds ?? 0;

  for (let round = 0; round < opts.rounds; round += 1) {
    for (let i = 0; i < n; i += 1) {
      if (objective === 'logistic') {
        const p = sigmoid(raw[i] as number);
        grad[i] = p - (y[i] as number);
        hess[i] = Math.max(p * (1 - p), 1e-6);
      } else {
        grad[i] = (raw[i] as number) - (y[i] as number);
        hess[i] = 1;
      }
    }

    let rows: number[];
    if (opts.subsample < 1) {
      rows = [];
      for (let i = 0; i < n; i += 1) if (random() < opts.subsample) rows.push(i);
      if (rows.length < opts.minSamplesLeaf * 2) rows = Array.from({ length: n }, (_, i) => i);
    } else {
      rows = Array.from({ length: n }, (_, i) => i);
    }

    const tree = buildTree(ctx, rows);
    trees.push(tree);
    gainThroughTree.push(ctx.featureGain.slice());
    splitsThroughTree.push(ctx.featureSplits.slice());
    for (let i = 0; i < n; i += 1) raw[i] = (raw[i] as number) + predictTree(tree, x[i] as number[]);

    const trainLoss = computeLoss(raw, y, objective);
    let validLoss: number | undefined;
    if (validation && validation.x.length > 0) {
      // A throwaway wrapper so `predictRaw` can score the validation split
      // against the trees built so far. It never escapes this scope, so the
      // importance counters on it are the raw running totals rather than the
      // per-surviving-tree figures the returned model carries; `predictRaw`
      // reads neither.
      const partial: GbdtModel = {
        trees,
        baseScore,
        learningRate: opts.learningRate,
        objective,
        featureNames,
        featureGain: ctx.featureGain,
        featureSplits: ctx.featureSplits,
        history: [],
      };
      const vRaw = validation.x.map((row) => predictRaw(partial, row));
      validLoss = computeLoss(Float64Array.from(vRaw), validation.y, objective);
      if (validLoss < bestValid - 1e-6) {
        bestValid = validLoss;
        bestRound = round;
      }
    }
    history.push(validLoss === undefined ? { round, trainLoss } : { round, trainLoss, validLoss });

    if (patience > 0 && validLoss !== undefined && round - bestRound >= patience) {
      trees.length = bestRound + 1;
      break;
    }
  }

  /*
   * Every diagnostic returned has to describe the ensemble that survived early
   * stopping, not the one that was built.
   *
   * `trees` was already truncated; `history` and the importance counters were
   * not, and both are published. `engine/model.ts` reads the *last* history
   * entry for the model card's training and validation loss, so it was reporting
   * the losses of the discarded tail: on the 92-tree bundle that exposed this,
   * the card claimed a training loss of 0.5751 (round 111) where the served
   * model's was 0.5910 — 2.7% understated, in the flattering direction — and a
   * validation loss of 0.6736 where the served model's was 0.6728, marginally
   * better than advertised. Neither number described the model behind the
   * ranking, which is the whole claim the transparency page makes.
   *
   * Truncating here rather than at the read site keeps the invariant local:
   * anything a caller derives from a returned `GbdtModel` is about `trees`.
   */
  history.length = trees.length;
  const survivingGain = gainThroughTree[trees.length - 1];
  const survivingSplits = splitsThroughTree[trees.length - 1];

  return {
    trees,
    baseScore,
    learningRate: opts.learningRate,
    objective,
    featureNames,
    featureGain: survivingGain ?? new Array<number>(dims).fill(0),
    featureSplits: survivingSplits ?? new Array<number>(dims).fill(0),
    history,
  };
}

function computeLoss(raw: Float64Array, y: readonly number[], objective: 'logistic' | 'squared'): number {
  let acc = 0;
  for (let i = 0; i < y.length; i += 1) {
    const r = raw[i] as number;
    const t = y[i] as number;
    if (objective === 'logistic') {
      const p = clamp(sigmoid(r), 1e-12, 1 - 1e-12);
      acc += -(t * Math.log(p) + (1 - t) * Math.log(1 - p));
    } else {
      acc += (r - t) ** 2;
    }
  }
  return acc / Math.max(1, y.length);
}

export function predictTree(tree: DecisionTree, row: readonly number[]): number {
  let idx = 0;
  for (let guard = 0; guard < 1024; guard += 1) {
    const node = tree.nodes[idx] as TreeNode;
    if (node.feature === LEAF) return node.value;
    idx = (row[node.feature] as number) <= node.threshold ? node.left : node.right;
  }
  return 0;
}

/** Raw (log-odds for logistic) model output. */
export function predictRaw(model: GbdtModel, row: readonly number[]): number {
  let acc = model.baseScore;
  for (const tree of model.trees) acc += predictTree(tree, row);
  return acc;
}

/** Calibrated probability (logistic) or the raw value (squared objective). */
export function predictProbability(model: GbdtModel, row: readonly number[]): number {
  const raw = predictRaw(model, row);
  return model.objective === 'logistic' ? sigmoid(raw) : raw;
}

export function predictBatch(model: GbdtModel, rows: readonly (readonly number[])[]): number[] {
  return rows.map((r) => predictProbability(model, r));
}

/** Normalised total-gain importance, descending. */
export function featureImportance(model: GbdtModel): { feature: string; gain: number; splits: number; share: number }[] {
  const total = model.featureGain.reduce((a, b) => a + b, 0);
  return model.featureGain
    .map((gain, i) => ({
      feature: model.featureNames[i] ?? `f${i}`,
      gain,
      splits: model.featureSplits[i] ?? 0,
      share: total < EPS ? 0 : gain / total,
    }))
    .sort((a, b) => b.gain - a.gain);
}

/** Leaf depth of the path a row takes — used by the fast-path precompute. */
export function pathDepth(tree: DecisionTree, row: readonly number[]): number {
  let idx = 0;
  let depth = 0;
  for (let guard = 0; guard < 1024; guard += 1) {
    const node = tree.nodes[idx] as TreeNode;
    if (node.feature === LEAF) return depth;
    idx = (row[node.feature] as number) <= node.threshold ? node.left : node.right;
    depth += 1;
  }
  return depth;
}
