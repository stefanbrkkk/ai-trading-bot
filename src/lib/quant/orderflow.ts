/**
 * Multi-Level Order Flow Imbalance (MLOFI) and PCA-filtered execution intent.
 *
 * The requirement, quoted: "While retail traders look at Level 1 Bid/Ask
 * sizes, Aurelius constructs a Multi-Level Order Flow Imbalance vector across M
 * depth levels of the limit order book… filter the MLOFI matrix using PCA…
 * isolating the first principal component distils millions of limit order
 * updates into a single orthogonal signal representing the true, non-noise
 * directional intent of market makers."
 *
 * Per-level order-flow increment (Cont–Kukanov–Stoikov 2014, extended to depth
 * m by Xu–Gould–Hawkes 2018). Between consecutive book snapshots n−1 → n, for
 * level m:
 *
 *   bid contribution:
 *     P^{b,m}_n >  P^{b,m}_{n−1}  →  + q^{b,m}_n              (bid improved)
 *     P^{b,m}_n =  P^{b,m}_{n−1}  →  + (q^{b,m}_n − q^{b,m}_{n−1})
 *     P^{b,m}_n <  P^{b,m}_{n−1}  →  − q^{b,m}_{n−1}          (bid pulled)
 *
 *   ask contribution (sign-flipped: a lower ask is aggressive selling pressure):
 *     P^{a,m}_n <  P^{a,m}_{n−1}  →  + q^{a,m}_n
 *     P^{a,m}_n =  P^{a,m}_{n−1}  →  + (q^{a,m}_n − q^{a,m}_{n−1})
 *     P^{a,m}_n >  P^{a,m}_{n−1}  →  − q^{a,m}_{n−1}
 *
 *   e^m_n = bidContribution − askContribution
 *   OFI^m_k = Σ_{n ∈ bucket k} e^m_n
 *   MLOFI_k = [OFI^1_k, …, OFI^M_k]
 */

import { type PcaModel, fitPca } from './pca';
import { EPS, clamp, mean, stdev, sum } from './stats';

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  /** Epoch milliseconds. */
  timestamp: number;
  /** Descending by price: bids[0] is the best bid. */
  bids: BookLevel[];
  /** Ascending by price: asks[0] is the best ask. */
  asks: BookLevel[];
}

/** Depth levels M used across the platform — the specified "M limit order book levels". */
export const MLOFI_LEVELS = 10;

export function bestBid(book: OrderBookSnapshot): BookLevel | undefined {
  return book.bids[0];
}

export function bestAsk(book: OrderBookSnapshot): BookLevel | undefined {
  return book.asks[0];
}

export function midPrice(book: OrderBookSnapshot): number {
  const b = bestBid(book);
  const a = bestAsk(book);
  if (!b || !a) return b?.price ?? a?.price ?? 0;
  return (b.price + a.price) / 2;
}

/** Size-weighted mid — the "micro price", a better short-horizon fair value. */
export function microPrice(book: OrderBookSnapshot): number {
  const b = bestBid(book);
  const a = bestAsk(book);
  if (!b || !a) return midPrice(book);
  const total = b.size + a.size;
  if (total < EPS) return (b.price + a.price) / 2;
  return (b.price * a.size + a.price * b.size) / total;
}

export function spread(book: OrderBookSnapshot): number {
  const b = bestBid(book);
  const a = bestAsk(book);
  return b && a ? a.price - b.price : 0;
}

export function spreadBps(book: OrderBookSnapshot): number {
  const mid = midPrice(book);
  return mid < EPS ? 0 : (spread(book) / mid) * 10_000;
}

/** Level-1 queue imbalance (q_b − q_a)/(q_b + q_a) ∈ [−1, 1]. */
export function queueImbalance(book: OrderBookSnapshot): number {
  const b = bestBid(book)?.size ?? 0;
  const a = bestAsk(book)?.size ?? 0;
  const t = a + b;
  return t < EPS ? 0 : (b - a) / t;
}

/** Depth-weighted imbalance over the first `levels` levels. */
export function depthImbalance(book: OrderBookSnapshot, levels = MLOFI_LEVELS): number {
  let bidVol = 0;
  let askVol = 0;
  for (let i = 0; i < levels; i += 1) {
    bidVol += book.bids[i]?.size ?? 0;
    askVol += book.asks[i]?.size ?? 0;
  }
  const t = bidVol + askVol;
  return t < EPS ? 0 : (bidVol - askVol) / t;
}

function sideIncrement(
  priceNow: number | undefined,
  sizeNow: number | undefined,
  pricePrev: number | undefined,
  sizePrev: number | undefined,
  improvedWhenGreater: boolean,
): number {
  const pN = priceNow ?? 0;
  const qN = sizeNow ?? 0;
  const pP = pricePrev ?? 0;
  const qP = sizePrev ?? 0;
  if (pN === 0 && pP === 0) return 0;
  if (pP === 0) return qN;
  if (pN === 0) return -qP;
  const improved = improvedWhenGreater ? pN > pP : pN < pP;
  const worsened = improvedWhenGreater ? pN < pP : pN > pP;
  if (improved) return qN;
  if (worsened) return -qP;
  return qN - qP;
}

/** Per-level increments e^m between two consecutive snapshots. */
export function ofiIncrement(
  prev: OrderBookSnapshot,
  next: OrderBookSnapshot,
  levels = MLOFI_LEVELS,
): number[] {
  const out = new Array<number>(levels).fill(0);
  for (let m = 0; m < levels; m += 1) {
    const bid = sideIncrement(
      next.bids[m]?.price,
      next.bids[m]?.size,
      prev.bids[m]?.price,
      prev.bids[m]?.size,
      true,
    );
    const ask = sideIncrement(
      next.asks[m]?.price,
      next.asks[m]?.size,
      prev.asks[m]?.price,
      prev.asks[m]?.size,
      false,
    );
    out[m] = bid - ask;
  }
  return out;
}

/** Cumulative MLOFI vector over a whole snapshot sequence. */
export function mlofiVector(
  snapshots: readonly OrderBookSnapshot[],
  levels = MLOFI_LEVELS,
): number[] {
  const out = new Array<number>(levels).fill(0);
  for (let i = 1; i < snapshots.length; i += 1) {
    const inc = ofiIncrement(snapshots[i - 1] as OrderBookSnapshot, snapshots[i] as OrderBookSnapshot, levels);
    for (let m = 0; m < levels; m += 1) out[m] = (out[m] as number) + (inc[m] as number);
  }
  return out;
}

/** MLOFI matrix: one bucketed row per `bucketSize` snapshot transitions. */
export function mlofiMatrix(
  snapshots: readonly OrderBookSnapshot[],
  options: { levels?: number; bucketSize?: number } = {},
): number[][] {
  const levels = options.levels ?? MLOFI_LEVELS;
  const bucketSize = Math.max(1, options.bucketSize ?? 1);
  const rows: number[][] = [];
  let acc = new Array<number>(levels).fill(0);
  let count = 0;
  for (let i = 1; i < snapshots.length; i += 1) {
    const inc = ofiIncrement(snapshots[i - 1] as OrderBookSnapshot, snapshots[i] as OrderBookSnapshot, levels);
    for (let m = 0; m < levels; m += 1) acc[m] = (acc[m] as number) + (inc[m] as number);
    count += 1;
    if (count === bucketSize) {
      rows.push(acc);
      acc = new Array<number>(levels).fill(0);
      count = 0;
    }
  }
  if (count > 0) rows.push(acc);
  return rows;
}

export interface MlofiSignal {
  /** Raw cumulative MLOFI per level. */
  levels: number[];
  /** Depth-decayed scalar Σ w_m·OFI^m with w_m = exp(−(m−1)/decay). */
  weighted: number;
  /** Score on the first principal component of the bucketed MLOFI matrix. */
  pc1Score: number;
  /** First-PC loadings across depth — shows which levels drive the signal. */
  pc1Loadings: number[];
  /** Share of MLOFI variance captured by PC1. */
  pc1ExplainedVariance: number;
  /** pc1Score standardised by the in-sample score dispersion, in σ. */
  pc1Z: number;
  /**
   * Directional intent in [−1, 1] after tanh squashing — this is what the
   * execution layer and the feature vector consume.
   */
  intent: number;
  /** Level-1 queue imbalance at the final snapshot. */
  queueImbalance: number;
  /** Depth imbalance at the final snapshot. */
  depthImbalance: number;
  /** Fitted PCA model, reusable for streaming scoring. */
  model: PcaModel | null;
}

/** Exponential depth decay: near-touch levels dominate. */
export function depthWeights(levels: number, decay = 3): number[] {
  return Array.from({ length: levels }, (_, m) => Math.exp(-m / decay));
}

/**
 * Full MLOFI → PCA pipeline. Bucketing then standardising is important: raw OFI
 * scales with the notional size at each level, and without standardisation PC1
 * would simply be "level 1", which defeats the purpose.
 */
export function computeMlofiSignal(
  snapshots: readonly OrderBookSnapshot[],
  options: { levels?: number; bucketSize?: number; decay?: number } = {},
): MlofiSignal {
  const levels = options.levels ?? MLOFI_LEVELS;
  const decay = options.decay ?? 3;
  const last = snapshots[snapshots.length - 1];
  const empty: MlofiSignal = {
    levels: new Array<number>(levels).fill(0),
    weighted: 0,
    pc1Score: 0,
    pc1Loadings: new Array<number>(levels).fill(0),
    pc1ExplainedVariance: 0,
    pc1Z: 0,
    intent: 0,
    queueImbalance: last ? queueImbalance(last) : 0,
    depthImbalance: last ? depthImbalance(last, levels) : 0,
    model: null,
  };
  if (snapshots.length < 3) return empty;

  const matrix = mlofiMatrix(snapshots, { levels, bucketSize: options.bucketSize ?? 1 });
  if (matrix.length < 3) return empty;

  const cumulative = new Array<number>(levels).fill(0);
  for (const row of matrix) for (let m = 0; m < levels; m += 1) cumulative[m] = (cumulative[m] as number) + (row[m] as number);

  const w = depthWeights(levels, decay);
  const weighted = sum(cumulative.map((v, m) => v * (w[m] as number)));

  const model = fitPca(matrix, { standardise: true, maxComponents: Math.min(levels, matrix.length - 1) });
  const loadings = (model.components[0] ?? new Array<number>(levels).fill(0)) as number[];

  // The PC1 *direction* comes from the (centred, standardised) covariance
  // structure, but the score must be measured against a neutral book — zero
  // imbalance — not against the window's own mean. Centring would make the net
  // projection identically zero, since Σ(s_k − s̄) = 0 by construction.
  //
  //   t_k = Σ_m w_m · OFI^m_k / σ_m        (scale-only projection)
  //   z   = Σ_k t_k / ( sd(t) · √n )       (net flow as a t-statistic)
  const projections = matrix.map((row) => {
    let acc = 0;
    for (let m = 0; m < levels; m += 1) {
      acc += (loadings[m] as number) * ((row[m] as number) / (model.scale[m] ?? 1));
    }
    return acc;
  });
  const netProjection = sum(projections);
  const projectionSigma = Math.max(stdev(projections), EPS);
  const rawZ = netProjection / (projectionSigma * Math.sqrt(matrix.length));

  // The eigenvector's sign is arbitrary, so tie the orientation to the
  // depth-weighted OFI: a positive score must always mean net buying pressure.
  const loadingSum = sum(loadings.map((l, m) => l * (w[m] as number)));
  const orientation = loadingSum < 0 ? -1 : 1;

  return {
    levels: cumulative,
    weighted,
    pc1Score: netProjection * orientation,
    pc1Loadings: loadings.map((l) => l * orientation),
    pc1ExplainedVariance: model.explainedVarianceRatio[0] ?? 0,
    pc1Z: rawZ * orientation,
    intent: clamp(Math.tanh((rawZ * orientation) / 2), -1, 1),
    queueImbalance: last ? queueImbalance(last) : 0,
    depthImbalance: last ? depthImbalance(last, levels) : 0,
    model,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Microstructure diagnostics
// ─────────────────────────────────────────────────────────────────────────────

export interface MicrostructureMetrics {
  mid: number;
  micro: number;
  spread: number;
  spreadBps: number;
  /** Roll (1984) effective spread estimator: 2·√(−cov(Δp_t, Δp_{t−1})). */
  rollSpread: number;
  /** Kyle's λ: price impact per unit of signed volume, from OLS. */
  kyleLambda: number;
  /** Amihud illiquidity: mean(|r| / dollar volume) × 1e6. */
  amihud: number;
  /** Total visible notional within the modelled depth. */
  bookNotional: number;
  /** Slope of cumulative depth vs distance from mid — resilience proxy. */
  bookResilience: number;
}

export function microstructureMetrics(
  book: OrderBookSnapshot,
  history: { price: number; signedVolume: number; dollarVolume: number }[],
): MicrostructureMetrics {
  const mid = midPrice(book);
  const prices = history.map((h) => h.price);
  const deltas: number[] = [];
  for (let i = 1; i < prices.length; i += 1) deltas.push((prices[i] as number) - (prices[i - 1] as number));

  let cov = 0;
  if (deltas.length > 2) {
    const m = mean(deltas);
    let acc = 0;
    for (let i = 1; i < deltas.length; i += 1) acc += ((deltas[i] as number) - m) * ((deltas[i - 1] as number) - m);
    cov = acc / (deltas.length - 1);
  }
  const rollSpread = cov < 0 ? 2 * Math.sqrt(-cov) : 0;

  let sxx = 0;
  let sxy = 0;
  for (let i = 1; i < history.length; i += 1) {
    const x = (history[i] as { signedVolume: number }).signedVolume;
    const y = (prices[i] as number) - (prices[i - 1] as number);
    sxx += x * x;
    sxy += x * y;
  }
  const kyleLambda = sxx < EPS ? 0 : sxy / sxx;

  let amihudAcc = 0;
  let amihudN = 0;
  for (let i = 1; i < history.length; i += 1) {
    const dv = (history[i] as { dollarVolume: number }).dollarVolume;
    const prev = prices[i - 1] as number;
    if (dv > EPS && prev > EPS) {
      amihudAcc += Math.abs(((prices[i] as number) - prev) / prev) / dv;
      amihudN += 1;
    }
  }

  let notional = 0;
  const distances: number[] = [];
  const cumDepth: number[] = [];
  let running = 0;
  for (let i = 0; i < Math.max(book.bids.length, book.asks.length); i += 1) {
    const b = book.bids[i];
    const a = book.asks[i];
    if (b) {
      notional += b.price * b.size;
      running += b.size;
    }
    if (a) {
      notional += a.price * a.size;
      running += a.size;
    }
    const d = b && a ? (a.price - b.price) / 2 : b ? mid - b.price : a ? a.price - mid : 0;
    distances.push(Math.abs(d));
    cumDepth.push(running);
  }
  let resilience = 0;
  if (distances.length > 2) {
    let sdd = 0;
    let sdq = 0;
    const md = mean(distances);
    const mq = mean(cumDepth);
    for (let i = 0; i < distances.length; i += 1) {
      const dd = (distances[i] as number) - md;
      sdd += dd * dd;
      sdq += dd * ((cumDepth[i] as number) - mq);
    }
    resilience = sdd < EPS ? 0 : sdq / sdd;
  }

  return {
    mid,
    micro: microPrice(book),
    spread: spread(book),
    spreadBps: spreadBps(book),
    rollSpread,
    kyleLambda,
    amihud: amihudN === 0 ? 0 : (amihudAcc / amihudN) * 1e6,
    bookNotional: notional,
    bookResilience: resilience,
  };
}

/**
 * Volume-synchronised probability of informed trading (VPIN), Easley–López de
 * Prado–O'Hara. Fraction of the bucket volume that is directionally imbalanced,
 * averaged over the last `windowBuckets` volume buckets.
 *
 * A trade that spans a bucket boundary is *split* across the buckets it fills,
 * which is what "volume-synchronised" means: the buckets are equal volume, not
 * equal trade count. Carrying the whole trade into one bucket and then draining
 * the counter produced a real bucket followed by empty ones —
 *
 *     vpin([{ volume: 300, signedVolume: 300 }], 100)  ->  0.333
 *
 * — where three hundred shares of perfectly one-sided flow must read 1.0, and
 * does when the same shares arrive as three hundred-lots. The error is not
 * cosmetic: `compute.ts` sizes a bucket at `VPIN_BARS_PER_BUCKET` times mean bar
 * volume, so it fires on any bar carrying a whole bucket by itself — a volume
 * spike, which is exactly the condition toxicity is being measured for — and the
 * number feeds the router's `ABORT_TOXIC_FLOW` gate.
 *
 * The depth is named rather than transcribed on purpose. This sentence read
 * "three times mean bar volume, so it fires on any bar three times the average",
 * which was true for as long as `compute.ts` multiplied by three; the commit that
 * introduced bulk-volume classification moved it to six and left the claim here
 * false by a factor of two, worked example included. The derivation of the depth
 * — the √(2/3πn) sampling floor a bucket of n equal bars carries, and why six is
 * where it balances against having enough buckets left to average — lives beside
 * the constant in `compute.ts`, which is the file anyone retuning it is editing.
 */
export function vpin(
  trades: readonly { volume: number; signedVolume: number }[],
  bucketVolume: number,
  windowBuckets = 50,
): number {
  if (bucketVolume <= 0) return 0;
  const buckets: { buy: number; sell: number }[] = [];
  let buy = 0;
  let sell = 0;
  let filled = 0;
  for (const t of trades) {
    const volume = Math.max(0, t.volume);
    if (volume <= 0) continue;
    const b = Math.max((volume + t.signedVolume) / 2, 0);
    const s = Math.max((volume - t.signedVolume) / 2, 0);
    // Normalised by the clamped mix rather than by `volume`, so a |signedVolume|
    // larger than the volume it is signing still yields shares that sum to one.
    const mix = b + s;
    if (mix <= 0) continue;
    const buyShare = b / mix;
    const sellShare = s / mix;

    let remaining = volume;
    while (remaining > 0) {
      const take = Math.min(remaining, bucketVolume - filled);
      buy += take * buyShare;
      sell += take * sellShare;
      filled += take;
      remaining -= take;
      if (filled >= bucketVolume - EPS) {
        buckets.push({ buy, sell });
        buy = 0;
        sell = 0;
        filled = 0;
      }
    }
  }
  const window = buckets.slice(-windowBuckets);
  if (window.length === 0) return 0;
  let acc = 0;
  for (const b of window) {
    const total = b.buy + b.sell;
    acc += total < EPS ? 0 : Math.abs(b.buy - b.sell) / total;
  }
  return clamp(acc / window.length, 0, 1);
}
