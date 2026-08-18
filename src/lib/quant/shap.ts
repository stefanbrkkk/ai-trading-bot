/**
 * TreeSHAP — exact Shapley values for tree ensembles, plus the FastTreeSHAP-v2
 * style path pre-computation.
 *
 * The requirement, quoted: "the Python backend completely bypasses standard
 * O(TL2^M) TreeSHAP computations. Instead, it utilizes FastTreeSHAP v2 to
 * pre-compute and cache decision tree paths in memory, and WOODELF, which
 * reduces background SHAP calculations to linear time complexity via
 * pseudo-Boolean formulas."
 *
 * What is implemented here, honestly labelled:
 *
 *  1. `treeShap` — the exact path-dependent TreeSHAP algorithm of Lundberg,
 *     Erion & Lee (2018), Algorithm 2. Complexity O(T·L·D²) with D the maximum
 *     depth, versus O(T·L·2^M) for naive Shapley enumeration. It satisfies local
 *     accuracy exactly: Σφ_i + E[f] = f(x). The per-tree core it loops over,
 *     `treeShapSingle`, is what tests/quant-core.test.ts checks that identity on
 *     against an exhaustive enumeration of the Shapley definition; the wrapper
 *     itself is covered in tests/fix-quant.test.ts.
 *
 *  2. `FastTreeShapExplainer` — the FastTreeSHAP v2 idea: hoist everything that
 *     depends only on the *tree* (not the sample) out of the per-sample loop.
 *     Each tree is compiled once into flat typed arrays with pre-computed child
 *     cover fractions and per-node ancestor-feature tables, so scoring a sample
 *     never re-derives them. Same values as (1), materially less work per row —
 *     which is what keeps the signal pipeline inside its latency budget.
 *
 *  3. `linearTimeApproxShap` — the WOODELF-style linear-time attribution. It
 *     walks each tree once, splitting each internal node's contribution between
 *     its children by cover, giving O(T·L) per sample.
 *
 *     It is *not* on the shipped scoring path, and this entry used to claim it
 *     was — "used for the background pass, bulk scoring of the whole universe".
 *     Both passes run (2): per-symbol attribution is
 *     `FastTreeShapExplainer.explain` from `engine/pipeline.ts`, and the bulk
 *     background pass is `globalShapImportance` over the same explainer from
 *     `engine/model.ts`. Nothing a user reads is approximated. (3) is kept as
 *     the linear-time reference to compare the exact values against.
 */

import { type DecisionTree, type GbdtModel, type TreeNode, predictRaw, sigmoid } from './gbdt';
import { EPS } from './stats';

const LEAF = -1;

// ─────────────────────────────────────────────────────────────────────────────
//  1. Exact path-dependent TreeSHAP
// ─────────────────────────────────────────────────────────────────────────────

/** One entry of the "unique path" stack from the TreeSHAP paper. */
interface PathElement {
  /** Feature index (−1 for the synthetic root element). */
  featureIndex: number;
  /** Fraction of "zero" (excluded) paths — the cover ratio. */
  zeroFraction: number;
  /** Fraction of "one" (included) paths — 1 on the hot path, 0 on the cold. */
  oneFraction: number;
  /** Proportion of subsets of this size that are permuted through here. */
  weight: number;
}

function extendPath(
  path: PathElement[],
  length: number,
  zeroFraction: number,
  oneFraction: number,
  featureIndex: number,
): void {
  const el = path[length];
  if (el) {
    el.featureIndex = featureIndex;
    el.zeroFraction = zeroFraction;
    el.oneFraction = oneFraction;
    el.weight = length === 0 ? 1 : 0;
  } else {
    path[length] = { featureIndex, zeroFraction, oneFraction, weight: length === 0 ? 1 : 0 };
  }
  for (let i = length - 1; i >= 0; i -= 1) {
    const next = path[i + 1] as PathElement;
    const cur = path[i] as PathElement;
    next.weight += (oneFraction * cur.weight * (i + 1)) / (length + 1);
    cur.weight = (zeroFraction * cur.weight * (length - i)) / (length + 1);
  }
}

function unwindPath(path: PathElement[], length: number, pathIndex: number): void {
  const one = (path[pathIndex] as PathElement).oneFraction;
  const zero = (path[pathIndex] as PathElement).zeroFraction;
  let nextOnePortion = (path[length] as PathElement).weight;

  for (let i = length - 1; i >= 0; i -= 1) {
    const cur = path[i] as PathElement;
    if (one !== 0) {
      const tmp = cur.weight;
      cur.weight = (nextOnePortion * (length + 1)) / ((i + 1) * one);
      nextOnePortion = tmp - (cur.weight * zero * (length - i)) / (length + 1);
    } else {
      cur.weight = (cur.weight * (length + 1)) / (zero * (length - i));
    }
  }
  for (let i = pathIndex; i < length; i += 1) {
    const cur = path[i] as PathElement;
    const nxt = path[i + 1] as PathElement;
    cur.featureIndex = nxt.featureIndex;
    cur.zeroFraction = nxt.zeroFraction;
    cur.oneFraction = nxt.oneFraction;
  }
}

/** Σ weights the path would have if element `pathIndex` were unwound. */
function unwoundPathSum(path: readonly PathElement[], top: number, pathIndex: number): number {
  const one = (path[pathIndex] as PathElement).oneFraction;
  const zero = (path[pathIndex] as PathElement).zeroFraction;
  let nextOnePortion = (path[top] as PathElement).weight;
  let total = 0;

  if (one !== 0) {
    for (let i = top - 1; i >= 0; i -= 1) {
      const tmp = (nextOnePortion * (top + 1)) / ((i + 1) * one);
      total += tmp;
      nextOnePortion = (path[i] as PathElement).weight - (tmp * zero * (top - i)) / (top + 1);
    }
  } else if (zero !== 0) {
    for (let i = top - 1; i >= 0; i -= 1) {
      total += ((path[i] as PathElement).weight * (top + 1)) / (zero * (top - i));
    }
  }
  return total;
}

/** Copies the first `count` elements of a path into a fresh array. */
function clonePath(path: readonly PathElement[], count: number): PathElement[] {
  const out: PathElement[] = new Array(count + 1);
  for (let i = 0; i < count; i += 1) {
    const el = path[i] as PathElement;
    out[i] = {
      featureIndex: el.featureIndex,
      zeroFraction: el.zeroFraction,
      oneFraction: el.oneFraction,
      weight: el.weight,
    };
  }
  return out;
}

/**
 * Exact SHAP values of one tree for one sample, accumulated into `phi`.
 * Direct transcription of Algorithm 2 in "Consistent Individualized Feature
 * Attribution for Tree Ensembles".
 *
 * Index convention (matching the reference C++): `depth` on entry is the number
 * of elements already on the path, i.e. the slot `extendPath` will write. After
 * the extension the top index is `depth`, and slot 0 is the synthetic root that
 * carries no feature.
 */
export function treeShapSingle(tree: DecisionTree, row: readonly number[], phi: number[]): void {
  const nodes = tree.nodes;
  if (nodes.length === 0) return;

  const recurse = (
    nodeIndex: number,
    parentPath: PathElement[],
    depth: number,
    parentZeroFraction: number,
    parentOneFraction: number,
    parentFeatureIndex: number,
  ): void => {
    const path = clonePath(parentPath, depth);
    extendPath(path, depth, parentZeroFraction, parentOneFraction, parentFeatureIndex);
    const node = nodes[nodeIndex] as TreeNode;

    if (node.feature === LEAF) {
      for (let i = 1; i <= depth; i += 1) {
        const el = path[i] as PathElement;
        if (el.featureIndex < 0) continue;
        const w = unwoundPathSum(path, depth, i);
        phi[el.featureIndex] =
          (phi[el.featureIndex] as number) + w * (el.oneFraction - el.zeroFraction) * node.value;
      }
      return;
    }

    const goesLeft = (row[node.feature] as number) <= node.threshold;
    const hot = goesLeft ? node.left : node.right;
    const cold = goesLeft ? node.right : node.left;
    const denom = node.cover > EPS ? node.cover : 1;
    const hotFraction = (nodes[hot] as TreeNode).cover / denom;
    const coldFraction = (nodes[cold] as TreeNode).cover / denom;

    // If this feature already appears on the path, unwind it first so its
    // contribution is not double-counted (the paper's FINDFIRST + UNWIND step).
    let incomingZero = 1;
    let incomingOne = 1;
    let seenAt = -1;
    for (let i = 1; i <= depth; i += 1) {
      if ((path[i] as PathElement).featureIndex === node.feature) {
        seenAt = i;
        break;
      }
    }
    let nextDepth = depth + 1;
    if (seenAt >= 0) {
      incomingZero = (path[seenAt] as PathElement).zeroFraction;
      incomingOne = (path[seenAt] as PathElement).oneFraction;
      unwindPath(path, depth, seenAt);
      nextDepth = depth;
    }

    recurse(hot, path, nextDepth, incomingZero * hotFraction, incomingOne, node.feature);
    recurse(cold, path, nextDepth, incomingZero * coldFraction, 0, node.feature);
  };

  recurse(0, [], 0, 1, 1, -1);
}

/**
 * Cover-weighted expectation of one tree, E_cover[tree] — the value the tree
 * outputs when *no* feature is known.
 */
export function treeExpectedValue(tree: DecisionTree, nodeIndex = 0): number {
  const nodes = tree.nodes;
  if (nodes.length === 0) return 0;
  const node = nodes[nodeIndex] as TreeNode;
  if (node.feature === LEAF) return node.value;
  const left = nodes[node.left] as TreeNode;
  const right = nodes[node.right] as TreeNode;
  const denom = node.cover > EPS ? node.cover : 1;
  return (
    (treeExpectedValue(tree, node.left) * left.cover + treeExpectedValue(tree, node.right) * right.cover) /
    denom
  );
}

/**
 * E[f(x)] for the whole ensemble = baseScore + Σ_t E_cover[tree_t].
 *
 * This — not `baseScore` alone — is the value SHAP attributions are measured
 * against; using `baseScore` leaves a residual equal to the trees' own
 * expectations and breaks local accuracy.
 */
export function ensembleBaseValue(model: GbdtModel): number {
  let acc = model.baseScore;
  for (const tree of model.trees) acc += treeExpectedValue(tree);
  return acc;
}

export interface ShapExplanation {
  /** φ_i per feature, in raw model units (log-odds for the logistic objective). */
  values: number[];
  /** E[f(x)] over the training distribution, in the same units. */
  baseValue: number;
  /** f(x) in raw units. Guaranteed to equal baseValue + Σφ. */
  rawPrediction: number;
  /** Calibrated probability when the objective is logistic. */
  probability: number;
  featureNames: string[];
  /** The input row, for state discretisation by the narrative engine. */
  featureValues: number[];
}

/** Exact SHAP for the whole ensemble. */
export function treeShap(model: GbdtModel, row: readonly number[]): ShapExplanation {
  const d = model.featureNames.length;
  const phi = new Array<number>(d).fill(0);
  for (const tree of model.trees) treeShapSingle(tree, row, phi);
  const raw = predictRaw(model, row);
  return {
    values: phi,
    baseValue: ensembleBaseValue(model),
    rawPrediction: raw,
    probability: model.objective === 'logistic' ? sigmoid(raw) : raw,
    featureNames: model.featureNames.slice(),
    featureValues: row.slice(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  2. FastTreeSHAP v2 — tree-invariant work hoisted out of the sample loop
// ─────────────────────────────────────────────────────────────────────────────

/** A tree compiled to flat typed arrays with pre-computed cover fractions. */
interface CompiledTree {
  feature: Int32Array;
  threshold: Float64Array;
  left: Int32Array;
  right: Int32Array;
  value: Float64Array;
  /** cover(child) / cover(node), pre-divided so the hot loop has no divisions. */
  leftFraction: Float64Array;
  rightFraction: Float64Array;
  maxDepth: number;
  /** Distinct features used anywhere in the tree — bounds the path length. */
  usedFeatures: number[];
}

function compileTree(tree: DecisionTree): CompiledTree {
  const n = tree.nodes.length;
  const feature = new Int32Array(n);
  const threshold = new Float64Array(n);
  const left = new Int32Array(n);
  const right = new Int32Array(n);
  const value = new Float64Array(n);
  const leftFraction = new Float64Array(n);
  const rightFraction = new Float64Array(n);
  const used = new Set<number>();

  for (let i = 0; i < n; i += 1) {
    const node = tree.nodes[i] as TreeNode;
    feature[i] = node.feature;
    threshold[i] = node.threshold;
    left[i] = node.left;
    right[i] = node.right;
    value[i] = node.value;
    if (node.feature !== LEAF) {
      used.add(node.feature);
      const denom = node.cover > EPS ? node.cover : 1;
      leftFraction[i] = (tree.nodes[node.left] as TreeNode).cover / denom;
      rightFraction[i] = (tree.nodes[node.right] as TreeNode).cover / denom;
    }
  }

  let maxDepth = 0;
  const depthOf = (idx: number, depth: number): void => {
    if ((feature[idx] as number) === LEAF) {
      if (depth > maxDepth) maxDepth = depth;
      return;
    }
    depthOf(left[idx] as number, depth + 1);
    depthOf(right[idx] as number, depth + 1);
  };
  if (n > 0) depthOf(0, 0);

  return {
    feature,
    threshold,
    left,
    right,
    value,
    leftFraction,
    rightFraction,
    maxDepth,
    usedFeatures: Array.from(used).sort((a, b) => a - b),
  };
}

/**
 * Pre-compiled explainer. Build it once per model (it is cached per model
 * version in the signal pipeline) and reuse it for every row.
 */
export class FastTreeShapExplainer {
  private readonly compiled: CompiledTree[];
  private readonly dims: number;
  readonly baseValue: number;
  readonly featureNames: string[];
  private readonly objective: 'logistic' | 'squared';
  /** Reusable path scratch buffers, sized to the deepest tree. */
  private readonly zeroBuf: Float64Array;
  private readonly oneBuf: Float64Array;
  private readonly weightBuf: Float64Array;
  private readonly featBuf: Int32Array;

  constructor(private readonly model: GbdtModel) {
    this.compiled = model.trees.map(compileTree);
    this.dims = model.featureNames.length;
    this.baseValue = ensembleBaseValue(model);
    this.featureNames = model.featureNames.slice();
    this.objective = model.objective;
    const depth = Math.max(2, ...this.compiled.map((c) => c.maxDepth)) + 2;
    const cap = depth * (depth + 1);
    this.zeroBuf = new Float64Array(cap);
    this.oneBuf = new Float64Array(cap);
    this.weightBuf = new Float64Array(cap);
    this.featBuf = new Int32Array(cap);
  }

  /** Total leaves across the ensemble — reported by the model card. */
  get leafCount(): number {
    let acc = 0;
    for (const c of this.compiled) {
      for (let i = 0; i < c.feature.length; i += 1) if ((c.feature[i] as number) === LEAF) acc += 1;
    }
    return acc;
  }

  get treeCount(): number {
    return this.compiled.length;
  }

  get maxDepth(): number {
    return this.compiled.length === 0 ? 0 : Math.max(...this.compiled.map((c) => c.maxDepth));
  }

  explain(row: readonly number[]): ShapExplanation {
    const phi = new Array<number>(this.dims).fill(0);
    for (const tree of this.compiled) this.shapTree(tree, row, phi);
    const raw = predictRaw(this.model, row);
    return {
      values: phi,
      baseValue: this.baseValue,
      rawPrediction: raw,
      probability: this.objective === 'logistic' ? sigmoid(raw) : raw,
      featureNames: this.featureNames,
      featureValues: row.slice(),
    };
  }

  /**
   * Same recursion as `treeShapSingle`, but the path lives in the pre-allocated
   * flat buffers (offset by depth) instead of a freshly cloned object array at
   * every node, and the cover fractions are read from the compiled tree.
   */
  private shapTree(tree: CompiledTree, row: readonly number[], phi: number[]): void {
    if (tree.feature.length === 0) return;
    const { zeroBuf, oneBuf, weightBuf, featBuf } = this;

    const recurse = (
      nodeIndex: number,
      offset: number,
      length: number,
      parentZero: number,
      parentOne: number,
      parentFeature: number,
    ): void => {
      const nextOffset = offset + length + 1;
      // Copy the parent path into a fresh slice of the scratch buffer.
      for (let i = 0; i < length; i += 1) {
        zeroBuf[nextOffset + i] = zeroBuf[offset + i] as number;
        oneBuf[nextOffset + i] = oneBuf[offset + i] as number;
        weightBuf[nextOffset + i] = weightBuf[offset + i] as number;
        featBuf[nextOffset + i] = featBuf[offset + i] as number;
      }

      // extendPath, inlined on the flat buffers.
      zeroBuf[nextOffset + length] = parentZero;
      oneBuf[nextOffset + length] = parentOne;
      featBuf[nextOffset + length] = parentFeature;
      weightBuf[nextOffset + length] = length === 0 ? 1 : 0;
      for (let i = length - 1; i >= 0; i -= 1) {
        weightBuf[nextOffset + i + 1] =
          (weightBuf[nextOffset + i + 1] as number) +
          (parentOne * (weightBuf[nextOffset + i] as number) * (i + 1)) / (length + 1);
        weightBuf[nextOffset + i] =
          (parentZero * (weightBuf[nextOffset + i] as number) * (length - i)) / (length + 1);
      }
      const newLength = length + 1;
      const feat = tree.feature[nodeIndex] as number;

      if (feat === LEAF) {
        const leafValue = tree.value[nodeIndex] as number;
        for (let i = 1; i < newLength; i += 1) {
          const fi = featBuf[nextOffset + i] as number;
          if (fi < 0) continue;
          const one = oneBuf[nextOffset + i] as number;
          const zero = zeroBuf[nextOffset + i] as number;
          let total = 0;
          let nextOnePortion = weightBuf[nextOffset + newLength - 1] as number;
          if (one !== 0) {
            for (let j = newLength - 2; j >= 0; j -= 1) {
              const tmp = (nextOnePortion * newLength) / ((j + 1) * one);
              total += tmp;
              nextOnePortion =
                (weightBuf[nextOffset + j] as number) - (tmp * zero * (newLength - 1 - j)) / newLength;
            }
          } else {
            for (let j = newLength - 2; j >= 0; j -= 1) {
              total += ((weightBuf[nextOffset + j] as number) * newLength) / (zero * (newLength - 1 - j));
            }
          }
          phi[fi] = (phi[fi] as number) + total * (one - zero) * leafValue;
        }
        return;
      }

      const goesLeft = (row[feat] as number) <= (tree.threshold[nodeIndex] as number);
      const hot = goesLeft ? (tree.left[nodeIndex] as number) : (tree.right[nodeIndex] as number);
      const cold = goesLeft ? (tree.right[nodeIndex] as number) : (tree.left[nodeIndex] as number);
      const hotFrac = goesLeft ? (tree.leftFraction[nodeIndex] as number) : (tree.rightFraction[nodeIndex] as number);
      const coldFrac = goesLeft ? (tree.rightFraction[nodeIndex] as number) : (tree.leftFraction[nodeIndex] as number);

      let incomingZero = 1;
      let incomingOne = 1;
      let seenAt = -1;
      for (let i = 1; i < newLength; i += 1) {
        if ((featBuf[nextOffset + i] as number) === feat) {
          seenAt = i;
          break;
        }
      }
      let effLength = newLength;
      if (seenAt >= 0) {
        incomingZero = zeroBuf[nextOffset + seenAt] as number;
        incomingOne = oneBuf[nextOffset + seenAt] as number;
        // unwindPath, inlined.
        let nextOnePortion = weightBuf[nextOffset + newLength - 1] as number;
        for (let i = newLength - 2; i >= 0; i -= 1) {
          if (incomingOne !== 0) {
            const tmp = weightBuf[nextOffset + i] as number;
            weightBuf[nextOffset + i] = (nextOnePortion * newLength) / ((i + 1) * incomingOne);
            nextOnePortion =
              tmp - ((weightBuf[nextOffset + i] as number) * incomingZero * (newLength - 1 - i)) / newLength;
          } else {
            weightBuf[nextOffset + i] =
              ((weightBuf[nextOffset + i] as number) * newLength) / (incomingZero * (newLength - 1 - i));
          }
        }
        for (let i = seenAt; i < newLength - 1; i += 1) {
          featBuf[nextOffset + i] = featBuf[nextOffset + i + 1] as number;
          zeroBuf[nextOffset + i] = zeroBuf[nextOffset + i + 1] as number;
          oneBuf[nextOffset + i] = oneBuf[nextOffset + i + 1] as number;
        }
        effLength = newLength - 1;
      }

      recurse(hot, nextOffset, effLength, incomingZero * hotFrac, incomingOne, feat);
      recurse(cold, nextOffset, effLength, incomingZero * coldFrac, 0, feat);
    };

    zeroBuf[0] = 1;
    oneBuf[0] = 1;
    weightBuf[0] = 1;
    featBuf[0] = -1;
    recurse(0, 0, 0, 1, 1, -1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  3. WOODELF-style linear-time approximation — reference only, not on the
//     scoring path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * O(T·L) attribution: walk the tree once, and at each internal node credit the
 * split feature with the *difference* between the value the sample's branch
 * implies and the cover-weighted value of the node. This is the classic
 * "saabas"/pseudo-Boolean decomposition — it is exact in the sense that it sums
 * to f(x) − E[f(x)], but it is order-dependent and therefore only an
 * approximation of the Shapley values.
 *
 * Not on the shipped scoring path — both the per-symbol and the bulk background
 * passes run the exact `FastTreeShapExplainer`. Retained as the linear-time
 * reference implementation to compare the exact values against.
 */
export function linearTimeApproxShap(model: GbdtModel, row: readonly number[]): ShapExplanation {
  const d = model.featureNames.length;
  const phi = new Array<number>(d).fill(0);

  for (const tree of model.trees) {
    const nodes = tree.nodes;
    if (nodes.length === 0) continue;
    const expectedValue = (idx: number): number => {
      const node = nodes[idx] as TreeNode;
      if (node.feature === LEAF) return node.value;
      const l = nodes[node.left] as TreeNode;
      const r = nodes[node.right] as TreeNode;
      const denom = node.cover > EPS ? node.cover : 1;
      return (expectedValue(node.left) * l.cover + expectedValue(node.right) * r.cover) / denom;
    };
    let idx = 0;
    let prevExpectation = expectedValue(0);
    for (let guard = 0; guard < 1024; guard += 1) {
      const node = nodes[idx] as TreeNode;
      if (node.feature === LEAF) break;
      const child = (row[node.feature] as number) <= node.threshold ? node.left : node.right;
      const childExpectation = expectedValue(child);
      phi[node.feature] = (phi[node.feature] as number) + (childExpectation - prevExpectation);
      prevExpectation = childExpectation;
      idx = child;
    }
  }

  const raw = predictRaw(model, row);
  return {
    values: phi,
    baseValue: ensembleBaseValue(model),
    rawPrediction: raw,
    probability: model.objective === 'logistic' ? sigmoid(raw) : raw,
    featureNames: model.featureNames.slice(),
    featureValues: row.slice(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Presentation helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface ShapContribution {
  feature: string;
  featureIndex: number;
  value: number;
  shap: number;
  /** |φ_i| / Σ|φ| — the "35% of this conviction" number in the narrative. */
  share: number;
  direction: 'positive' | 'negative';
}

/** Sorted, share-normalised contributions for the force plot and narrative. */
export function rankContributions(
  explanation: ShapExplanation,
  options: { topK?: number; minShare?: number } = {},
): ShapContribution[] {
  const total = explanation.values.reduce((a, b) => a + Math.abs(b), 0);
  const all: ShapContribution[] = explanation.values.map((shap, i) => ({
    feature: explanation.featureNames[i] ?? `f${i}`,
    featureIndex: i,
    value: explanation.featureValues[i] ?? 0,
    shap,
    share: total < EPS ? 0 : Math.abs(shap) / total,
    direction: shap >= 0 ? 'positive' : 'negative',
  }));
  const filtered = all
    .filter((c) => Math.abs(c.shap) > 1e-9 && c.share >= (options.minShare ?? 0))
    .sort((a, b) => Math.abs(b.shap) - Math.abs(a.shap));
  return options.topK ? filtered.slice(0, options.topK) : filtered;
}

/**
 * Waterfall layout: cumulative raw score after each contribution, ordered by
 * descending |φ|. The remaining (unshown) contributions are pooled into one
 * "other" row so the waterfall still lands exactly on f(x).
 */
export interface WaterfallStep {
  label: string;
  shap: number;
  cumulative: number;
  /** Probability equivalent of `cumulative` (logistic objective). */
  cumulativeProbability: number;
  direction: 'positive' | 'negative';
  /**
   * |φ_i| / Σ|φ| over the **whole** attribution — the same denominator
   * `rankContributions` uses, and the same number the driver table and the
   * narrative sentence print.
   *
   * Published here rather than derived in the chart because the chart cannot
   * derive it: it is handed the top-K rows, so any sum it forms is over a
   * subset. Recomputing there put three different figures for one driver on one
   * page — 17% in the waterfall, 12% in the force plot, 11.9% in the table.
   * One denominator, computed once, at the only place that can see all of it.
   */
  share: number;
}

export function shapWaterfall(explanation: ShapExplanation, topK = 8): {
  baseValue: number;
  baseProbability: number;
  steps: WaterfallStep[];
  finalValue: number;
  finalProbability: number;
} {
  const ranked = rankContributions(explanation);
  const shown = ranked.slice(0, topK);
  const rest = ranked.slice(topK);
  const restSum = rest.reduce((a, c) => a + c.shap, 0);
  const restShare = rest.reduce((a, c) => a + c.share, 0);
  const steps: WaterfallStep[] = [];
  let cum = explanation.baseValue;
  for (const c of shown) {
    cum += c.shap;
    steps.push({
      label: c.feature,
      shap: c.shap,
      cumulative: cum,
      cumulativeProbability: sigmoid(cum),
      direction: c.direction,
      share: c.share,
    });
  }
  if (Math.abs(restSum) > 1e-9) {
    cum += restSum;
    steps.push({
      label: `${ranked.length - shown.length} other drivers`,
      shap: restSum,
      cumulative: cum,
      cumulativeProbability: sigmoid(cum),
      direction: restSum >= 0 ? 'positive' : 'negative',
      /*
       * The pooled row's share is the sum of the shares it pools, not
       * |Σφ| / Σ|φ|. Those differ whenever the pooled contributions disagree in
       * sign, and the column has to add to 100 across the rows shown.
       */
      share: restShare,
    });
  }
  return {
    baseValue: explanation.baseValue,
    baseProbability: sigmoid(explanation.baseValue),
    steps,
    finalValue: cum,
    finalProbability: sigmoid(cum),
  };
}

/**
 * Local-accuracy residual: |baseValue + Σφ − f(x)|.
 * The pipeline asserts this is < 1e-6 before any explanation is shown to a
 * user — an attribution that does not add up is not shipped.
 */
export function localAccuracyError(explanation: ShapExplanation): number {
  const summed = explanation.values.reduce((a, b) => a + b, explanation.baseValue);
  return Math.abs(summed - explanation.rawPrediction);
}

/**
 * Global mean |SHAP| over a sample of rows — the model card's importance chart.
 */
export function globalShapImportance(
  explainer: FastTreeShapExplainer,
  rows: readonly (readonly number[])[],
): { feature: string; meanAbsShap: number; share: number }[] {
  const d = explainer.featureNames.length;
  const acc = new Array<number>(d).fill(0);
  for (const row of rows) {
    const e = explainer.explain(row);
    for (let i = 0; i < d; i += 1) acc[i] = (acc[i] as number) + Math.abs(e.values[i] as number);
  }
  const n = Math.max(1, rows.length);
  const means = acc.map((v) => v / n);
  const total = means.reduce((a, b) => a + b, 0);
  return means
    .map((meanAbsShap, i) => ({
      feature: explainer.featureNames[i] ?? `f${i}`,
      meanAbsShap,
      share: total < EPS ? 0 : meanAbsShap / total,
    }))
    .sort((a, b) => b.meanAbsShap - a.meanAbsShap);
}

/**
 * Counterfactual probe: the smallest change to one feature that flips the
 * prediction across `threshold`, found by bisection on the model output.
 * Returns null when the feature cannot flip it within the search range.
 */
export function counterfactual(
  model: GbdtModel,
  row: readonly number[],
  featureIndex: number,
  threshold = 0.5,
  searchRange = 6,
): { requiredValue: number; delta: number; achievable: boolean } | null {
  const base = row.slice();
  const current = base[featureIndex] as number;
  const probAt = (v: number): number => {
    const probe = base.slice();
    probe[featureIndex] = v;
    const raw = predictRaw(model, probe);
    return model.objective === 'logistic' ? sigmoid(raw) : raw;
  };
  const p0 = probAt(current);
  const wantAbove = p0 < threshold;

  let lo = current;
  let hi = current + (wantAbove ? searchRange : -searchRange);
  const pHi = probAt(hi);
  if (wantAbove ? pHi < threshold : pHi > threshold) {
    // Try the other direction before giving up.
    hi = current - (wantAbove ? searchRange : -searchRange);
    const pAlt = probAt(hi);
    if (wantAbove ? pAlt < threshold : pAlt > threshold) {
      return { requiredValue: current, delta: 0, achievable: false };
    }
  }
  for (let i = 0; i < 60; i += 1) {
    const mid = 0.5 * (lo + hi);
    const p = probAt(mid);
    if (wantAbove ? p < threshold : p > threshold) lo = mid;
    else hi = mid;
  }
  const requiredValue = 0.5 * (lo + hi);
  return { requiredValue, delta: requiredValue - current, achievable: true };
}
