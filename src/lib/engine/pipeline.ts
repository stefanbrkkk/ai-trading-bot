/**
 * The signal pipeline.
 *
 * Stages, in the order the engine blueprint specifies, each instrumented against
 * the sub-150ms tick-to-trade budget from Phase 3:
 *
 *   1. ingest        — bars, book, option chain and alt-data for the instant
 *   2. features      — the full registry feature vector (compute.ts)
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
 *
 * Stage 2 used to write the vector's width out as a literal, and the field
 * comment ninety lines below wrote a different one for the same vector, so the
 * file disagreed with itself and both numbers disagreed with the registry.
 * Neither sentence names a width any more: `MODEL_FEATURE_COUNT` is exported
 * from the registry, and prose cannot be kept in agreement with a number it
 * repeats.
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
import { type ShapExplanation, localAccuracyError, rankContributions } from '@/lib/quant/shap';
import { rogersSatchellVolatility, closes, last, resample } from '@/lib/quant/indicators';
import { clamp } from '@/lib/quant/stats';
import { AGENT_DISCRIMINATION_FLOOR } from './model';
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

/**
 * How many drivers the narrative publishes, and how small a share still earns a
 * sentence.
 *
 * Named once because `rankContributions` is applied twice against it — once to
 * size the evidence for the Insufficient Data Protocol, once to translate the
 * drivers the page shows — and two copies of the pair would let the gate count a
 * different list than the one it gates.
 */
const DRIVER_SELECTION = { topK: 12, minShare: 0.002 } as const;

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
  /**
   * The exact TreeSHAP decomposition — one value per registry feature — with the
   * ensemble's own `baseValue` and `rawPrediction`.
   *
   * Published because the API was rebuilding a waterfall from the twelve
   * *translated* drivers with `baseValue: 0`, which is a different object: it
   * starts at a 50% base the page labels "E[f(x)] over the K-Means background",
   * it ends at the sum of twelve values rather than at f(x), and the gap between
   * that end point and the published probability measured up to 4.4 points —
   * under a footer certifying the attribution exact to 3.3e-16.
   */
  explanation: ShapExplanation;
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
  /*
   * A fresh clock per run, which makes the barrier structural on this path
   * rather than live.
   *
   * `runPipeline` is request-scoped, so every production call ticks a clock that
   * has never ticked before and publishes the 5m agent at sequence 0 — and
   * `readMacroForTick` returns early when the required sequence is −1, without
   * consulting either upstream sequence. The ordering contract is therefore
   * expressed and type-checked here, and enforced from tick 1 onwards, but this
   * path never reaches tick 1: `clock.barrierViolations` is pinned at 0 by
   * construction, not by the agents behaving. Making it live means holding one
   * clock per symbol across requests, alongside `symbolCache` in service.ts.
   */
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
  /*
   * An agent that does not discriminate carries no conviction into the router.
   *
   * `discrimination` is the standard deviation of each agent's probability across
   * the validation split, measured at training time. On the bundled seed the 60m
   * TFT scores below `AGENT_DISCRIMINATION_FLOOR` while the 5m LSTM and the 15m
   * BiLSTM clear it several times over: it returns essentially the same
   * probability for whatever it is shown, so its vote is one fixed offset applied
   * to all 67 names rather than a reading of any of them. An earlier fit made
   * that plain by landing its constant well above a coin flip, where the same
   * fixed vote carried the whole universe long at once.
   *
   * Zeroing its conviction is not a correction of its opinion; it is a refusal to
   * treat a constant as an opinion. The router's own guard handles the case where
   * every agent collapses, and the floor — not any particular measurement — is
   * the contract.
   *
   * No figure is quoted. This read "scores 1.4e-3 against 0.17 for the 5m LSTM"
   * and closed by asserting that described the seeded model, and a retrain
   * falsified both halves without touching the line: `.data/` is git-ignored, so
   * the seed is re-fitted per deployment and nothing carries a transcription of
   * it forward. Same lesson as the feature width in this file's header, on a
   * number that moves per install rather than per registry edit. /api/model-card
   * and /transparency publish what the seed on this deployment measured.
   */
  const discrimination = model.training.discrimination;
  const agentWeight = (spread: number): number => (spread >= AGENT_DISCRIMINATION_FLOOR ? 1 : 0);
  const router = routeSignals({
    agent5m: {
      direction: toDirection(lstmOut.probability),
      conviction: toConviction(lstmOut.probability) * agentWeight(discrimination.lstm),
    },
    agent15m: {
      direction: toDirection(bilstmOut.probability),
      conviction: toConviction(bilstmOut.probability) * agentWeight(discrimination.bilstm),
    },
    agent60m: {
      direction: toDirection(tftOut.probability),
      conviction: toConviction(tftOut.probability) * agentWeight(discrimination.tft),
    },
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
  const price = features.artefacts.price;

  /*
   * The published direction is settled before anything reads it.
   *
   * The Insufficient Data Protocol used to be evaluated *after* the driver
   * sentences and the levels had been built from `direction`, and only the
   * `Signal` literal at the bottom applied it. A signal the gate flattened
   * therefore published FLAT above a full set of directional driver prose —
   * "3% of this bullish conviction is driven by a primary downtrend" under a
   * headline saying the model holds no directional conviction, which is the
   * exact contradiction the flat branch of `composeGenericNarrative` exists to
   * prevent, and a long-shaped trade plan besides.
   *
   * `rankContributions` decides how many drivers there are and does not consult
   * the direction, so the count the gate needs is available before the
   * translation that consumes the direction. Everything downstream reads
   * `publishedDirection`; `direction` is not used again.
   */
  const evidence = features.raw.alt_evidence ?? 0;
  const insufficient = isInsufficientEvidence(
    evidence,
    rankContributions(explanation, DRIVER_SELECTION).length,
  );
  const publishedDirection: SignalDirection = insufficient ? 'flat' : direction;

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
    signalDirection: publishedDirection,
    ...DRIVER_SELECTION,
  });
  latency.mark('translate');

  // ── 10. Fuse ─────────────────────────────────────────────────────────────
  const directionalProbability = publishedDirection === 'short' ? 1 - probability : probability;
  const stratScore =
    publishedDirection === 'short' ? strategyConviction.short : strategyConviction.long;
  const conviction = fuseConviction({
    directionalProbability,
    aggregateDirection: Math.abs(router.aggregateDirection),
    strategyConviction: stratScore,
    regimeConfidence: regime.confidence,
    direction: publishedDirection,
    routerAction: router.action,
  });

  /*
   * A strategy supplies this signal's levels only if it agrees with the direction
   * the signal actually published.
   *
   * `resolveDirection` answers to the router and the tree model; the strategies
   * are a separate line of evidence and are free to disagree, and a strategy that
   * fired can win the conflict resolution while pointing the other way. Its
   * levels were being adopted anyway, so a quarter of the directional universe
   * published a trade plan for the opposite side of itself: MRK short with the
   * invalidation *below* the price and the target above it, PLTR short with an
   * expected return of +14.8%. Measured across the universe, 7 of 27 directional
   * names. `deriveExpectedReturn` blends the target into the published figure —
   * its own comment says "a signal whose expected return contradicts its own
   * target would be incoherent" — so one wrong input poisoned both numbers.
   *
   * When the winner disagrees, the signal names no strategy and falls back to
   * ATR-derived levels, which are always built from the published direction.
   * That the strategy fired at all is still published in `strategiesFired`, with
   * its own direction, so the disagreement is visible rather than resolved
   * silently. A flat signal never adopts a strategy's levels either: no strategy
   * fires flat, so the comparison below cannot match one.
   */
  const alignedStrategy =
    conflict.winner !== null && conflict.winner.direction === publishedDirection
      ? conflict.winner
      : null;
  const levels = publishedLevels(
    publishedDirection,
    price,
    features.artefacts.atr,
    alignedStrategy?.levels ?? null,
  );
  const expectedReturn = deriveExpectedReturn(tftOut.expectedReturn, price, levels, publishedDirection);

  const thesis = insufficient
    ? INSUFFICIENT_DATA_THESIS
    : composeThesis(input.symbol, drivers, publishedDirection, conviction);
  const counterThesis = insufficient
    ? 'Evidence is insufficient to identify a material opposing driver.'
    : composeCounterThesis(drivers, publishedDirection);

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
    direction: publishedDirection,
    conviction: insufficient ? 0 : conviction,
    probability: insufficient ? 0.5 : directionalProbability,
    horizonDays,
    expectedReturn: insufficient ? 0 : expectedReturn.mid,
    expectedReturnLow: insufficient ? 0 : expectedReturn.low,
    expectedReturnHigh: insufficient ? 0 : expectedReturn.high,
    referencePrice: price,
    levels,
    strategy: alignedStrategy?.id ?? null,
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

  return { signal, features, router, strategies, drivers, explanation, clock: clock.snapshot() };
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
 * The router picks the side; the tree model holds a veto over it.
 *
 * The router resolves three agents on three timeframes and can emit EXECUTE_LONG
 * or EXECUTE_SHORT while the GBDT — the only component fitted directly on the
 * "beats the benchmark" label — reads the other way. Taking its verdict
 * unconditionally published four directional rows whose own probability was
 * below a coin flip: LULU short at 42.4%, GS short at 43.5%, MA short at 43.8%,
 * SPG long at 43.1%. `Signal.probability` is the probability the *published
 * position* beats the benchmark — stage 10 stores `1 − p` on a short — so each
 * of those rows advertised a trade the platform's own number said would not
 * work, beside a conviction score computed from that same number.
 *
 * A disagreement between two lines of evidence is not settled by ranking them.
 * It publishes flat, which is what the noise-floor path below already does when
 * the evidence is thin, and the router panel and `strategiesFired` still show
 * what each side said. `probability === 0.5` is not a disagreement, so it is not
 * vetoed.
 *
 * Takes only the action it reads, so the veto can be exercised directly rather
 * than through a whole `RouterDecision`.
 */
export function resolveDirection(
  router: Pick<RouterDecision, 'action'>,
  probability: number,
): SignalDirection {
  if (router.action === 'EXECUTE_LONG') return probability >= 0.5 ? 'long' : 'flat';
  if (router.action === 'EXECUTE_SHORT') return probability <= 0.5 ? 'short' : 'flat';
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

/**
 * ATR-derived levels for a signal that has a side.
 *
 * `direction` is deliberately narrowed to the two directional values. It used to
 * accept the full `SignalDirection` and derive its sign as
 * `direction === 'short' ? -1 : 1`, which reads 'flat' as long — see
 * `flatLevels` for what that published. Narrowing the parameter is what makes
 * that call unrepresentable rather than merely absent.
 */
function defaultLevels(
  price: number,
  atrValue: number,
  direction: 'long' | 'short',
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
 * The level set a signal publishes: the aligned strategy's when it has one, the
 * ATR-derived default when it does not, and `flatLevels` when it took no side.
 *
 * One function so that "flat" is decided in exactly one place. This was a `??`
 * chain at the call site with no flat branch at all, which is how a signal with
 * no direction came to publish a directional plan.
 */
export function publishedLevels(
  direction: SignalDirection,
  price: number,
  atrValue: number,
  strategyLevels: Signal['levels'] | null,
): Signal['levels'] {
  if (direction === 'flat') return flatLevels(price, atrValue);
  return strategyLevels ?? defaultLevels(price, atrValue, direction);
}

/**
 * Levels for a signal that has no side.
 *
 * An invalidation and a target are directional statements, and `defaultLevels`
 * took any non-short direction as long — so every flat name published a complete
 * bullish trade plan under a FLAT badge and an expected return of +0.00%. BAC,
 * at a reference price of 31.41: invalidation 30.28, target 1 33.11 (+5.4%),
 * target 2 34.43 (+9.6%), drawn on the price chart as four annotations and
 * listed in the "Published levels" panel directly beneath a thesis reading "the
 * model holds no directional conviction on BAC". Thirteen of the sixty-seven
 * names on the measured sweep were flat, and all thirteen were long-shaped.
 *
 * A flat signal publishes the one band it actually has — the entry zone, which
 * is symmetric about the reference price and asserts no side — and collapses the
 * three directional levels onto the reference price itself. That is the only
 * finite value which claims no move in either direction, and it keeps
 * `deriveExpectedReturn`'s target leg at the +0.00% the signal publishes beside
 * it, so the two numbers still derive from each other.
 *
 * Collapsing rather than omitting is a storage constraint, not a preference. The
 * display layer is already built for absence: `price()` renders '—' for a
 * non-finite value and `PriceChart` skips any level failing `Number.isFinite`.
 * But `signals.invalidation`, `.target1` and `.target2` are `REAL NOT NULL`,
 * SQLite has no NaN, and binding one aborts the insert — which would take down
 * the universe write in `persist.ts` and the seed with it. Publishing "no level"
 * rather than "a level equal to the price" needs those three columns made
 * nullable, `Signal['levels']` widened to `number | null`, and the levels panel
 * on the symbol page hidden when the direction is flat.
 */
function flatLevels(price: number, atrValue: number): Signal['levels'] {
  const a = Math.max(atrValue, price * 0.005);
  return {
    entryZoneLow: price - 0.25 * a,
    entryZoneHigh: price + 0.25 * a,
    invalidation: price,
    target1: price,
    target2: price,
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
  /*
   * The agent's median only counts when it points the same way the signal does.
   *
   * It is a forward price forecast, not a view on this signal, so it is free to
   * disagree — and blended in unconditionally it can carry the published figure
   * across zero, which is how a short came to advertise a positive expected
   * return. The target is always built from `direction`, so falling back to it
   * alone keeps the number and the badge above it saying the same thing. The
   * disagreement is not hidden: the agent's own probability and interval are
   * published per agent on the attribution page.
   */
  const agrees = direction === 'short' ? modelReturn < 0 : modelReturn > 0;
  const mid = agrees ? 0.5 * modelReturn + 0.5 * targetReturn : targetReturn;
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
