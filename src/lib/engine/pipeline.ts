/**
 * The signal pipeline.
 *
 * Stages, in the order the engine blueprint specifies, each instrumented against
 * the sub-150ms tick-to-trade budget from Phase 3:
 *
 *   1. ingest        — bars, book, option chain and alt-data for the instant
 *   2. features      — the 80-feature vector (compute.ts)
 *   3. regime        — Hurst / ADF / ADX classification
 *   4. agents        — the 60m TFT, 15m BiLSTM and 5m LSTM, published through the
 *                      Hierarchical State Clock's sequence barrier
 *   5. route         — the MADRL conflict-resolution matrix
 *   6. tree model    — GBDT probability
 *   7. attribution   — exact FastTreeSHAP v2 values, verified for local accuracy
 *   8. translate     — the deterministic Human-Translation Engine
 *   9. strategies    — the named scans, regime-weighted
 *  10. fuse          — the conviction score
 *
 * The stage order matters: the agents publish *before* the router reads, and the
 * router's abort/skip verdicts are respected by the fusion step rather than
 * being advisory.
 */

import { type ComputedFeatures, computeFeatures } from './compute';
import { MODEL_FEATURE_KEYS } from './features';
import { classifyRegime, regimeMultiplier } from './regime';
import {
  HierarchicalStateClock,
  type RouterDecision,
  macroRegimeDistribution,
  routeSignals,
} from './router';
import {
  type TranslatedDriver,
  INSUFFICIENT_DATA_THESIS,
  composeCounterThesis,
  composeThesis,
  isInsufficientEvidence,
  translateExplanation,
} from './narrative';
import { AGENT_FEATURE_KEYS, type ModelBundle } from './model';
import {
  type StrategyContext,
  type StrategyEvaluation,
  aggregateStrategyConviction,
  evaluateStrategies,
  resolveStrategyConflicts,
} from './strategies';
import { localAccuracyError } from '@/lib/quant/shap';
import { rogersSatchellVolatility, closes, last, resample } from '@/lib/quant/indicators';
import { clamp } from '@/lib/quant/stats';
import type {
  AgentInference,
  AltDataEvent,
  Bar,
  LatencyBreakdown,
  OptionChainSlice,
  OrderBookSnapshot,
  Signal,
  SignalDirection,
  SignalDriver,
  SymbolMeta,
} from '@/lib/domain/types';

/** Phase 3 mandates a sub-150ms tick-to-trade budget. */
export const LATENCY_BUDGET_MS = 150;

export interface PipelineInput {
  symbol: string;
  meta: SymbolMeta;
  dailyBars: Bar[];
  intradayBars: Bar[];
  benchmarkBars: Bar[];
  benchmarkIntradayBars: Bar[];
  sectorCloses: number[];
  books: OrderBookSnapshot[];
  chains: OptionChainSlice[];
  altEvents: AltDataEvent[];
  /** Rolling 25Δ risk-reversal history for the skew oscillator. */
  riskReversalHistory: number[];
  now: number;
  /** Signal horizon in trading days. */
  horizonDays?: number;
  /** Previous session's per-strategy profit factors, for conflict tie-breaks. */
  profitFactors?: Record<string, number>;
}

export interface PipelineResult {
  signal: Signal;
  features: ComputedFeatures;
  router: RouterDecision;
  strategies: StrategyEvaluation[];
  drivers: TranslatedDriver[];
  clock: ReturnType<HierarchicalStateClock['snapshot']>;
}

class LatencyTracker {
  private readonly stages: { stage: string; ms: number }[] = [];
  private cursor = performance.now();

  mark(stage: string): void {
    const now = performance.now();
    this.stages.push({ stage, ms: Math.round((now - this.cursor) * 1000) / 1000 });
    this.cursor = now;
  }

  breakdown(): LatencyBreakdown {
    const totalMs = Math.round(this.stages.reduce((a, s) => a + s.ms, 0) * 1000) / 1000;
    return {
      stages: this.stages.slice(),
      totalMs,
      budgetMs: LATENCY_BUDGET_MS,
      withinBudget: totalMs <= LATENCY_BUDGET_MS,
    };
  }
}

/** Extracts the agent input sequence from a trailing window of daily bars. */
export function buildAgentSequence(
  history: readonly ComputedFeatures[],
  sequenceLength: number,
): number[][] {
  const window = history.slice(-sequenceLength);
  const rows: number[][] = window.map((f) => AGENT_FEATURE_KEYS.map((k) => sanitise(f.raw[k] ?? 0)));
  // Left-pad with the earliest row so a short history still produces a
  // fixed-length sequence rather than throwing.
  while (rows.length < sequenceLength && rows.length > 0) rows.unshift((rows[0] as number[]).slice());
  while (rows.length < sequenceLength) rows.unshift(new Array<number>(AGENT_FEATURE_KEYS.length).fill(0));
  return rows;
}

function sanitise(x: number): number {
  if (!Number.isFinite(x)) return 0;
  // The agents see standardised-ish inputs; clip the fat tails so a single
  // outlier cannot saturate every gate in the LSTM.
  return clamp(x, -50, 50);
}

/**
 * Directional prediction ŷ ∈ [−1, 1] from an agent probability. The router needs
 * a signed direction, the agents emit a probability, and 2p − 1 is the canonical
 * bridge.
 */
function toDirection(probability: number): number {
  return clamp(2 * probability - 1, -1, 1);
}

/**
 * Conviction c ∈ [0, 1] from an agent probability: how far it is from a coin
 * flip. The blueprint describes this as deriving from softmax entropy; for a
 * binary head, 2|p − ½| is exactly that measure rescaled.
 */
function toConviction(probability: number): number {
  return clamp(Math.abs(probability - 0.5) * 2, 0, 1);
}

export function runPipeline(
  input: PipelineInput,
  model: ModelBundle,
  featureHistory: readonly ComputedFeatures[],
): PipelineResult {
  const latency = new LatencyTracker();
  const horizonDays = input.horizonDays ?? 5;

  // ── 1. Ingest (already supplied; measure the marshalling cost) ────────────
  const hourlyBars = resample(input.intradayBars, 60);
  latency.mark('ingest');

  // ── 2. Features ──────────────────────────────────────────────────────────
  const features = computeFeatures({
    symbol: input.symbol,
    meta: input.meta,
    dailyBars: input.dailyBars,
    intradayBars: input.intradayBars,
    benchmarkBars: input.benchmarkBars,
    sectorCloses: input.sectorCloses,
    books: input.books,
    chains: input.chains,
    altEvents: input.altEvents,
    now: input.now,
    horizonDays,
  });
  latency.mark('features');

  // ── 3. Regime ────────────────────────────────────────────────────────────
  const regime = classifyRegime({
    hurst: features.raw.hurst_100 ?? 0.5,
    adf: features.raw.adf_stat_120 ?? 0,
    adx: features.raw.adx_14 ?? 0,
    diSpread: features.raw.di_spread ?? 0,
    realisedVol: (features.raw.realised_vol_20 ?? 0) / 100,
    volPercentile: features.raw.vol_percentile_252 ?? 0.5,
    liquidityScore: features.raw.liquidity_score ?? 0.5,
    primaryTrend: features.raw.ema_50_200_spread ?? 0,
  });
  latency.mark('regime');

  // ── 4. Agents, published under the sequence barrier ──────────────────────
  const clock = new HierarchicalStateClock();
  const sequence = clock.tick();
  const history = [...featureHistory, features];
  const sequenceInput = buildAgentSequence(history, model.sequenceLength);

  const tftOut = model.tft.predict(sequenceInput);
  const bilstmOut = model.bilstm.predict(sequenceInput);

  // Rogers–Satchell is the macro-volatility term the router consumes. Computed
  // on the 60m bars where available, otherwise daily.
  const rsSource = hourlyBars.length >= 24 ? hourlyBars : input.dailyBars;
  const rsVol = last(rogersSatchellVolatility(rsSource, Math.min(20, Math.max(5, rsSource.length - 1))), 0);
  const vpinToxicity = clamp(features.raw.vpin ?? 0, 0, 1);

  const macro60 = macroRegimeDistribution(
    tftOut.probability,
    regime.trendStrength,
    features.raw.vol_percentile_252 ?? 0.5,
  );
  const macro15 = macroRegimeDistribution(
    bilstmOut.probability,
    regime.trendStrength,
    features.raw.vol_percentile_252 ?? 0.5,
  );
  // The 60m and 15m agents commit their macro state for the *previous* sequence,
  // which is what the barrier requires the 5m agent to have read.
  clock.publish60m(macro60, sequence - 1);
  clock.publish15m(macro15, sequence - 1);

  const lstmOut = model.lstm.predict(sequenceInput);
  clock.publish5m(sequence);
  const inhibition = clock.inhibitionFlags();
  latency.mark('agents');

  // ── 5. Route ─────────────────────────────────────────────────────────────
  const router = routeSignals({
    agent5m: { direction: toDirection(lstmOut.probability), conviction: toConviction(lstmOut.probability) },
    agent15m: { direction: toDirection(bilstmOut.probability), conviction: toConviction(bilstmOut.probability) },
    agent60m: { direction: toDirection(tftOut.probability), conviction: toConviction(tftOut.probability) },
    vpinToxicity,
    rsVolatility: rsVol,
    inhibitLong: inhibition.inhibitLong,
    inhibitShort: inhibition.inhibitShort,
  });
  latency.mark('route');

  // ── 6. Tree model ────────────────────────────────────────────────────────
  const probability = model.probability(features.vector);
  latency.mark('tree');

  // ── 7. Attribution ───────────────────────────────────────────────────────
  const explanation = model.explainer.explain(features.vector);
  const attributionResidual = localAccuracyError(explanation);
  latency.mark('attribution');

  // ── 8/9. Direction, strategies, translation ──────────────────────────────
  const direction = resolveDirection(router, probability);

  const strategyContext: StrategyContext = {
    symbol: input.symbol,
    dailyBars: input.dailyBars,
    intradayBars: input.intradayBars,
    hourlyBars,
    benchmarkBars: input.benchmarkBars,
    benchmarkIntradayBars: input.benchmarkIntradayBars,
    features,
    adv30: input.meta.adv30,
    riskReversalHistory: input.riskReversalHistory,
    now: input.now,
  };
  const strategies = evaluateStrategies(strategyContext);
  const conflict = resolveStrategyConflicts(strategies, input.profitFactors ?? {});
  const strategyConviction = aggregateStrategyConviction(strategies, (family) =>
    regimeMultiplier(regime.label, family),
  );
  latency.mark('strategies');

  const drivers = translateExplanation(explanation, {
    signalDirection: direction,
    topK: 12,
    minShare: 0.002,
  });
  latency.mark('translate');

  // ── 10. Fuse ─────────────────────────────────────────────────────────────
  const directionalProbability = direction === 'short' ? 1 - probability : probability;
  const stratScore = direction === 'short' ? strategyConviction.short : strategyConviction.long;
  const conviction = fuseConviction({
    directionalProbability,
    aggregateDirection: Math.abs(router.aggregateDirection),
    strategyConviction: stratScore,
    regimeConfidence: regime.confidence,
    direction,
    routerAction: router.action,
  });

  const price = features.artefacts.price;
  const evidence = features.raw.alt_evidence ?? 0;
  const insufficient = isInsufficientEvidence(evidence, drivers.length);

  const levels = conflict.winner?.levels ?? defaultLevels(price, features.artefacts.atr, direction);
  const expectedReturn = deriveExpectedReturn(tftOut.expectedReturn, price, levels, direction);

  const thesis = insufficient
    ? INSUFFICIENT_DATA_THESIS
    : composeThesis(input.symbol, drivers, direction, conviction);
  const counterThesis = insufficient
    ? 'Evidence is insufficient to identify a material opposing driver.'
    : composeCounterThesis(drivers, direction);

  const agents: AgentInference[] = [
    toAgentInference(model.tft.spec, tftOut, sequence),
    toAgentInference(model.bilstm.spec, bilstmOut, sequence),
    toAgentInference(model.lstm.spec, lstmOut, sequence),
  ];

  const signalDrivers: SignalDriver[] = drivers.map((d) => ({
    featureKey: d.featureKey,
    label: d.label,
    group: d.group,
    value: d.value,
    shap: d.shap,
    share: d.share,
    direction: d.direction,
    state: d.state,
    narrative: d.narrative,
  }));

  const signal: Signal = {
    id: signalId(input.symbol, input.now),
    symbol: input.symbol,
    generatedAt: input.now,
    direction: insufficient ? 'flat' : direction,
    conviction: insufficient ? 0 : conviction,
    probability: insufficient ? 0.5 : directionalProbability,
    horizonDays,
    expectedReturn: insufficient ? 0 : expectedReturn.mid,
    expectedReturnLow: insufficient ? 0 : expectedReturn.low,
    expectedReturnHigh: insufficient ? 0 : expectedReturn.high,
    referencePrice: price,
    levels,
    strategy: conflict.winner?.id ?? null,
    strategiesFired: strategies.filter((s) => s.fired).map((s) => s.id),
    regime: regime.label,
    drivers: signalDrivers,
    agents,
    features: features.values,
    thesis,
    counterThesis,
    latency: latency.breakdown(),
    attributionResidual,
    modelVersion: model.version,
  };

  return { signal, features, router, strategies, drivers, clock: clock.snapshot() };
}

function toAgentInference(
  spec: { name: string; architecture: 'tft' | 'bilstm' | 'lstm'; timeframeMinutes: number; sequenceLength: number },
  out: { probability: number; expectedReturn: number; lower: number | null; upper: number | null; attention: number[] | null; variableWeights: number[] | null },
  sequence: number,
): AgentInference {
  return {
    name: spec.name,
    architecture: spec.architecture,
    timeframeMinutes: spec.timeframeMinutes,
    probability: out.probability,
    expectedReturn: out.expectedReturn,
    lower: out.lower,
    upper: out.upper,
    attention: out.attention,
    variableWeights: out.variableWeights,
    sequenceLength: spec.sequenceLength,
    epoch: sequence,
    publishedSequence: sequence,
  };
}

/**
 * The router's verdict is authoritative on direction when it emitted one; the
 * tree model only decides when the router held, aborted or skipped.
 */
function resolveDirection(router: RouterDecision, probability: number): SignalDirection {
  if (router.action === 'EXECUTE_LONG') return 'long';
  if (router.action === 'EXECUTE_SHORT') return 'short';
  if (router.action === 'ABORT_TOXIC_FLOW' || router.action === 'SKIP' || router.action === 'NEUTRAL') return 'flat';
  // HOLD: the agents are inside the noise floor, so defer to the tree model, but
  // only when it is meaningfully off a coin flip.
  if (probability >= 0.56) return 'long';
  if (probability <= 0.44) return 'short';
  return 'flat';
}

export interface ConvictionInputs {
  /** GBDT probability in the signal's own direction. */
  directionalProbability: number;
  /** |S_agg| from the router. */
  aggregateDirection: number;
  /** Regime-weighted strategy conviction in the signal's direction. */
  strategyConviction: number;
  /** Regime classifier confidence. */
  regimeConfidence: number;
  direction: SignalDirection;
  routerAction: RouterDecision['action'];
}

/**
 * Conviction score, 0–100.
 *
 * Three independent evidence sources are blended, then discounted by how
 * confident the regime classifier is. The weights favour the tree ensemble
 * because it is the only component fitted directly on the "beats the benchmark"
 * label; the agents and the named strategies corroborate it.
 *
 *   raw   = 0.40·directional edge + 0.35·|S_agg| + 0.25·strategy conviction
 *   score = 100 · raw · (0.70 + 0.30·regimeConfidence)
 */
export function fuseConviction(inputs: ConvictionInputs): number {
  if (inputs.direction === 'flat') return 0;
  if (inputs.routerAction === 'ABORT_TOXIC_FLOW' || inputs.routerAction === 'SKIP') return 0;

  const edge = clamp(2 * inputs.directionalProbability - 1, 0, 1);
  const raw =
    0.4 * edge + 0.35 * clamp(inputs.aggregateDirection, 0, 1) + 0.25 * clamp(inputs.strategyConviction, 0, 1);
  const regimeAdjustment = 0.7 + 0.3 * clamp(inputs.regimeConfidence, 0, 1);
  return Math.round(clamp(raw * regimeAdjustment, 0, 1) * 1000) / 10;
}

function defaultLevels(
  price: number,
  atrValue: number,
  direction: SignalDirection,
): Signal['levels'] {
  const a = Math.max(atrValue, price * 0.005);
  const sign = direction === 'short' ? -1 : 1;
  return {
    entryZoneLow: price - 0.25 * a,
    entryZoneHigh: price + 0.25 * a,
    invalidation: price - sign * 1.5 * a,
    target1: price + sign * 2.25 * a,
    target2: price + sign * 4 * a,
  };
}

/**
 * Expected return over the horizon.
 *
 * The TFT's quantile head is trained on the forward benchmark-relative return,
 * so it supplies the interval directly. Its median is blended with the
 * strategy's own target so the published number is consistent with the levels
 * shown next to it — a signal whose expected return contradicts its own target
 * would be incoherent.
 */
function deriveExpectedReturn(
  tftMedian: number,
  price: number,
  levels: Signal['levels'],
  direction: SignalDirection,
): { low: number; mid: number; high: number } {
  if (direction === 'flat' || price <= 0) return { low: 0, mid: 0, high: 0 };
  const targetReturn = (levels.target1 - price) / price;
  const stopReturn = (levels.invalidation - price) / price;
  const modelReturn = clamp(tftMedian, -0.25, 0.25);
  const mid = 0.5 * modelReturn + 0.5 * targetReturn;
  const spread = Math.max(Math.abs(targetReturn - stopReturn) / 2, Math.abs(modelReturn) * 0.5, 0.002);
  return {
    low: Math.round((mid - spread) * 1e6) / 1e6,
    mid: Math.round(mid * 1e6) / 1e6,
    high: Math.round((mid + spread) * 1e6) / 1e6,
  };
}

/**
 * Deterministic signal id — same symbol and instant always yields the same id,
 * so the bitemporal ledger never duplicates a publication.
 */
export function signalId(symbol: string, at: number): string {
  return `sig_${symbol.replace(/[^A-Z0-9]/gi, '').toLowerCase()}_${at.toString(36)}`;
}

/** Convenience for callers that only need the vector, e.g. the dataset builder. */
export function featureVectorOf(features: ComputedFeatures): number[] {
  return MODEL_FEATURE_KEYS.map((k) => sanitise(features.raw[k] ?? 0));
}

/** Convenience re-export so the dataset builder does not import indicators twice. */
export { closes };
