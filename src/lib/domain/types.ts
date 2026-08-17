/**
 * Shared domain types.
 *
 * These cross every layer — market data, engine, persistence, API and UI — so
 * they live in one place with no imports beyond the quant primitives.
 */

import type { Bar } from '@/lib/quant/indicators';
import type { OrderBookSnapshot } from '@/lib/quant/orderflow';
import type { AltDataStream } from '@/lib/quant/decay';

export type { Bar, OrderBookSnapshot, AltDataStream };

export type Timeframe = '5m' | '15m' | '60m' | '1d';

export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  '5m': 5,
  '15m': 15,
  '60m': 60,
  '1d': 390,
};

export type Sector =
  | 'Technology'
  | 'Health Care'
  | 'Financials'
  | 'Consumer Discretionary'
  | 'Consumer Staples'
  | 'Industrials'
  | 'Energy'
  | 'Materials'
  | 'Utilities'
  | 'Real Estate'
  | 'Communication Services';

export interface SymbolMeta {
  symbol: string;
  name: string;
  sector: Sector;
  industry: string;
  /** Market capitalisation in USD. */
  marketCap: number;
  /** 30-day average daily volume in shares — the risk engine's ADV input. */
  adv30: number;
  /** Shares outstanding. */
  sharesOutstanding: number;
  /** Exchange listing. */
  exchange: 'NASDAQ' | 'NYSE' | 'ARCA';
  /** True when the symbol is the benchmark used for relative strength. */
  isBenchmark: boolean;
  /** Beta to the benchmark, as published metadata (not the rolling estimate). */
  referenceBeta: number;
  /** Annual dividend yield as a decimal. */
  dividendYield: number;
  /** Whether options are listed — gates the SABR feature block. */
  optionable: boolean;
}

export interface Quote {
  symbol: string;
  timestamp: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  last: number;
  lastSize: number;
  /** Cumulative session volume. */
  volume: number;
  /** Previous session close, for change calculations. */
  previousClose: number;
}

export interface OptionQuote {
  symbol: string;
  strike: number;
  /** Expiry in epoch ms. */
  expiry: number;
  type: 'call' | 'put';
  bid: number;
  ask: number;
  mid: number;
  impliedVolatility: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  openInterest: number;
  volume: number;
}

export interface OptionChainSlice {
  symbol: string;
  /** Days to expiry. */
  dte: number;
  expiry: number;
  /** Forward price used for the SABR fit. */
  forward: number;
  quotes: OptionQuote[];
}

export interface AltDataEvent {
  id: string;
  symbol: string;
  stream: AltDataStream;
  timestamp: number;
  /** Signed score in [−1, 1]. */
  value: number;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** Human-readable headline for the alt-data panel. */
  headline: string;
  /** Source identifier (e.g. "SEC EDGAR Form 4"). */
  source: string;
  /** Optional structured payload (Form 4 fields, 13F position deltas, …). */
  payload?: Record<string, string | number | boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Signals
// ─────────────────────────────────────────────────────────────────────────────

export type SignalDirection = 'long' | 'short' | 'flat';

export interface FeatureValue {
  key: string;
  label: string;
  group: FeatureGroup;
  /** Raw value in the feature's native unit. */
  value: number;
  /** ECDF-normalised value on (0, 1) against the cross-sectional distribution. */
  normalised: number;
  unit: FeatureUnit;
  /** Discretised state label, e.g. STATE_OVERSOLD. */
  state: string;
}

export type FeatureGroup =
  | 'momentum'
  | 'trend'
  | 'volatility'
  | 'microstructure'
  | 'meanreversion'
  | 'skew'
  | 'altdata'
  | 'relative'
  | 'volume'
  | 'regime';

export type FeatureUnit =
  | 'ratio'
  | 'percent'
  | 'bps'
  | 'zscore'
  | 'probability'
  | 'index_0_100'
  | 'bars'
  | 'currency'
  | 'shares'
  | 'volpoints'
  | 'signed_unit'
  | 'count';

export interface SignalDriver {
  featureKey: string;
  label: string;
  group: FeatureGroup;
  value: number;
  /** Exact SHAP value in log-odds. */
  shap: number;
  /** |φ| / Σ|φ| */
  share: number;
  direction: 'positive' | 'negative';
  /** Discretised state used to select the narrative template. */
  state: string;
  /** Plain-English sentence produced by the deterministic mapping matrix. */
  narrative: string;
}

export interface AgentInference {
  name: string;
  architecture: 'tft' | 'bilstm' | 'lstm';
  timeframeMinutes: number;
  probability: number;
  expectedReturn: number;
  lower: number | null;
  upper: number | null;
  /** Sequence attention weights, oldest → newest (TFT only). */
  attention: number[] | null;
  /** Variable-selection weights aligned to `featureKeys` (TFT only). */
  variableWeights: number[] | null;
  /** Sequence used, for the timeline chart. */
  sequenceLength: number;
  /** Timestamp of the state-clock epoch this inference belongs to. */
  epoch: number;
  /** Ring-buffer sequence this inference was published at. */
  publishedSequence: number;
}

export interface Signal {
  id: string;
  symbol: string;
  /** Epoch ms of the state-clock tick that produced the signal. */
  generatedAt: number;
  direction: SignalDirection;
  /** 0–100. The gold dial. */
  conviction: number;
  /** Calibrated probability the position beats the benchmark over the horizon. */
  probability: number;
  /** Horizon in trading days. */
  horizonDays: number;
  /** Expected move over the horizon, as a decimal return. */
  expectedReturn: number;
  /** Predictive interval from the TFT quantile head. */
  expectedReturnLow: number;
  expectedReturnHigh: number;
  /** Reference price at signal time. */
  referencePrice: number;
  /** Suggested (never auto-applied) technical levels. */
  levels: {
    entryZoneLow: number;
    entryZoneHigh: number;
    invalidation: number;
    target1: number;
    target2: number;
  };
  /** Named strategy that fired, if any. */
  strategy: string | null;
  /** Every strategy that fired on this bar. */
  strategiesFired: string[];
  regime: RegimeLabel;
  drivers: SignalDriver[];
  agents: AgentInference[];
  /** Full feature snapshot, for the drill-down table. */
  features: FeatureValue[];
  /** Executive summary sentence assembled from the top drivers. */
  thesis: string;
  /** Risk sentence naming the strongest opposing driver. */
  counterThesis: string;
  /** Latency budget accounting for this signal. */
  latency: LatencyBreakdown;
  /** SHAP local-accuracy residual — 0 means the attribution reconciles exactly. */
  attributionResidual: number;
  /** Model version that produced this signal. */
  modelVersion: string;
}

export interface LatencyBreakdown {
  /** Milliseconds per pipeline stage. */
  stages: { stage: string; ms: number }[];
  totalMs: number;
  /** Budget from Phase 3: sub-150ms tick-to-trade. */
  budgetMs: number;
  withinBudget: boolean;
}

export type RegimeLabel =
  | 'trending_bull'
  | 'trending_bear'
  | 'mean_reverting'
  | 'high_volatility'
  | 'low_volatility_drift'
  | 'illiquid';

export interface RegimeState {
  label: RegimeLabel;
  /** Confidence in [0, 1]. */
  confidence: number;
  hurst: number;
  adf: number;
  realisedVol: number;
  volPercentile: number;
  trendStrength: number;
  liquidityScore: number;
  description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Orders, positions, risk
// ─────────────────────────────────────────────────────────────────────────────

export type OrderSide = 'buy' | 'sell';
/** No default is ever applied — Phase 5 §1 requires explicit selection. */
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit';
export type TimeInForce = 'day' | 'gtc' | 'ioc' | 'fok';
export type OrderStatus =
  | 'pending_risk'
  | 'rejected_risk'
  | 'submitted'
  | 'partially_filled'
  | 'filled'
  | 'canceled'
  | 'broker_error';

export interface OrderIntent {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  /** Null until the user types one — never pre-filled. */
  quantity: number | null;
  notional: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  timeInForce: TimeInForce;
  /** Paper or live routing. */
  account: 'paper' | 'live';
  /** Signal the user was looking at, for the audit trail. Not an instruction. */
  signalId: string | null;
}

export interface ClickProvenance {
  /** Physical mouse coordinates of the Execute click (Phase 5 §3). */
  clickX: number;
  clickY: number;
  /** Viewport at click time, so coordinates are interpretable later. */
  viewportWidth: number;
  viewportHeight: number;
  /** Client-side epoch ms of the click. */
  clickedAt: number;
  /** True when the event carried `isTrusted` — i.e. a real user gesture. */
  trusted: boolean;
  /** Element the user actually pressed. */
  targetId: string;
}

export type RiskRejectionCode =
  | 'FAT_FINGER_NOTIONAL'
  | 'LIQUIDITY_ADV_LIMIT'
  | 'PRICE_TOLERANCE_NBBO'
  | 'INSUFFICIENT_FUNDS'
  | 'KILL_SWITCH_ENGAGED'
  | 'MARKET_CLOSED'
  | 'INVALID_QUANTITY'
  | 'MISSING_ORDER_TYPE'
  | 'MISSING_LIMIT_PRICE'
  | 'MISSING_STOP_PRICE'
  | 'SYMBOL_NOT_TRADABLE'
  | 'SUBSCRIPTION_REQUIRED'
  | 'UNTRUSTED_CLICK'
  /*
   * Split out of `UNTRUSTED_CLICK`. A token that does not match the order, and a
   * token that has already been spent, are different events with different
   * remedies — re-submit with the parameters you authorised, versus click Execute
   * again — and a single code left the UI unable to say which had happened.
   */
  | 'INTENT_TOKEN_MISMATCH'
  | 'INTENT_TOKEN_SPENT'
  | 'MAX_OPEN_ORDERS'
  | 'DUPLICATE_ORDER';

export interface RiskCheckResult {
  code: RiskRejectionCode | null;
  passed: boolean;
  /** Human-readable, shown verbatim in the UI. */
  message: string;
  /** Which check produced this result. */
  check: string;
  /** Observed value and the limit it was compared against. */
  observed: number | null;
  limit: number | null;
}

export interface RiskDecision {
  approved: boolean;
  checks: RiskCheckResult[];
  /** First failing check, if any. */
  rejection: RiskCheckResult | null;
  evaluatedAt: number;
  /** SPIFFE-format identity of the service that ran the checks. */
  spiffeId: string;
  elapsedMs: number;
}

export interface Order {
  id: string;
  userId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limitPrice: number | null;
  stopPrice: number | null;
  timeInForce: TimeInForce;
  account: 'paper' | 'live';
  status: OrderStatus;
  filledQuantity: number;
  averageFillPrice: number | null;
  createdAt: number;
  updatedAt: number;
  signalId: string | null;
  riskDecision: RiskDecision;
  /** Raw JSON dispatched to the broker (Phase 5 §3.6). */
  brokerRequest: Record<string, unknown> | null;
  /** Broker's HTTP status and body. */
  brokerStatus: number | null;
  brokerResponse: Record<string, unknown> | null;
  brokerOrderId: string | null;
}

export interface OrderTelemetry {
  orderId: string;
  /** Millisecond-precision timestamp array: click → API → broker ACK. */
  timestamps: {
    clientClick: number;
    serverReceived: number;
    riskCompleted: number;
    brokerDispatched: number;
    brokerAcknowledged: number | null;
  };
  spiffeId: string;
  ipAddress: string;
  userAgent: string;
  click: ClickProvenance;
  rawPayload: string;
  brokerStatus: number | null;
  brokerBody: string | null;
}

export interface Position {
  symbol: string;
  quantity: number;
  averageEntry: number;
  marketPrice: number;
  marketValue: number;
  unrealisedPnl: number;
  unrealisedPnlPercent: number;
  realisedPnl: number;
  openedAt: number;
  account: 'paper' | 'live';
}

export interface AccountSnapshot {
  account: 'paper' | 'live';
  cash: number;
  equity: number;
  buyingPower: number;
  /** Sum of |marketValue| across positions. */
  grossExposure: number;
  netExposure: number;
  maintenanceMargin: number;
  dayPnl: number;
  totalPnl: number;
  positions: Position[];
  updatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Users, subscription, compliance
// ─────────────────────────────────────────────────────────────────────────────

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'none';
export type UserRole = 'trader' | 'admin';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt: number;
  subscription: {
    status: SubscriptionStatus;
    /** Epoch ms the 14-day paper sandbox trial ends. */
    trialEndsAt: number | null;
    currentPeriodEnd: number | null;
    priceUsdPerMonth: number;
    provider: 'stripe' | 'simulated' | null;
    externalId: string | null;
  };
  /** Live routing is gated behind an active subscription. */
  liveTradingUnlocked: boolean;
  tosAcceptedAt: number | null;
  tosVersion: string | null;
}

export interface TosAcceptance {
  userId: string;
  version: string;
  acceptedAt: number;
  ipAddress: string;
  userAgent: string;
  /** Proof the user scrolled to the absolute bottom before the box unlocked. */
  scrolledToBottom: boolean;
  scrollDurationMs: number;
  /** Coordinates of the checkbox click. */
  click: ClickProvenance;
}

export interface KillSwitchState {
  engaged: boolean;
  engagedAt: number | null;
  engagedBy: string | null;
  reason: string | null;
  /** Orders cancelled by the last engagement. */
  cancelledOrders: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Backtesting
// ─────────────────────────────────────────────────────────────────────────────

export interface BacktestTrade {
  symbol: string;
  strategy: string;
  direction: 'long' | 'short';
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  quantity: number;
  grossPnl: number;
  commission: number;
  slippage: number;
  netPnl: number;
  returnPercent: number;
  barsHeld: number;
  exitReason: 'target' | 'stop' | 'time' | 'signal' | 'end_of_data';
  convictionAtEntry: number;
  maxFavourableExcursion: number;
  maxAdverseExcursion: number;
}

export interface BacktestMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Σ wins / |Σ losses|. */
  profitFactor: number;
  expectancy: number;
  averageWin: number;
  averageLoss: number;
  /** Largest win / largest loss. */
  payoffRatio: number;
  totalReturn: number;
  cagr: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  maxDrawdown: number;
  maxDrawdownDurationDays: number;
  volatility: number;
  downsideDeviation: number;
  /** 95% historical VaR of daily returns. */
  var95: number;
  /** 95% conditional VaR (expected shortfall). */
  cvar95: number;
  ulcerIndex: number;
  kellyFraction: number;
  averageBarsHeld: number;
  exposure: number;
  bestTrade: number;
  worstTrade: number;
  longestWinStreak: number;
  longestLossStreak: number;
  /** Deflated Sharpe correction for the number of strategies tried. */
  deflatedSharpe: number;
  /** Probabilistic Sharpe ratio against a zero benchmark. */
  probabilisticSharpe: number;
  turnover: number;
  /** Benchmark comparison. */
  benchmarkReturn: number;
  alpha: number;
  beta: number;
  informationRatio: number;
  trackingError: number;
}

export interface EquityPoint {
  time: number;
  equity: number;
  drawdown: number;
  benchmark: number;
  exposure: number;
}

export interface BacktestResult {
  id: string;
  createdAt: number;
  config: BacktestConfig;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  /** Per-strategy attribution. */
  byStrategy: { strategy: string; trades: number; netPnl: number; winRate: number; sharpe: number }[];
  /** Monthly return grid for the heatmap. */
  monthlyReturns: { year: number; month: number; ret: number }[];
  /** Walk-forward fold summaries. */
  folds: WalkForwardFold[];
  warnings: string[];
}

export interface BacktestConfig {
  symbols: string[];
  strategies: string[];
  startTime: number;
  endTime: number;
  timeframe: Timeframe;
  initialCapital: number;
  /** Fixed fractional risk per trade as a decimal of equity. */
  riskPerTrade: number;
  maxConcurrentPositions: number;
  commissionPerShare: number;
  slippageBps: number;
  /** Minimum conviction required to take a signal. */
  minConviction: number;
  /** Walk-forward: in-sample and out-of-sample lengths, in bars. */
  walkForward: { enabled: boolean; trainBars: number; testBars: number };
  benchmarkSymbol: string;
}

export interface WalkForwardFold {
  index: number;
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  inSampleSharpe: number;
  outOfSampleSharpe: number;
  outOfSampleReturn: number;
  trades: number;
  /** OOS Sharpe / IS Sharpe — the degradation ratio. */
  efficiency: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  InvestGPT / RAG
// ─────────────────────────────────────────────────────────────────────────────

export interface FeatureCatalogEntry {
  key: string;
  label: string;
  group: FeatureGroup;
  unit: FeatureUnit;
  description: string;
  /** Plain-text formula, shown in the schema explorer. */
  formula: string;
  /** SQL expression against v_equity_snapshot. */
  sqlColumn: string;
  /** Synonyms the retriever matches on. */
  aliases: string[];
  /** True for the ~70 features the model actually consumes. */
  inModel: boolean;
}

export interface SchemaPruningReport {
  /** Total catalog size before pruning. */
  totalColumns: number;
  /** Columns kept after CSR-RAG pruning. */
  keptColumns: number;
  prunedPercent: number;
  /** Which tables survived. */
  tables: string[];
  /** Matched catalog entries with their retrieval scores. */
  matches: { key: string; score: number; reason: string }[];
  elapsedMs: number;
}

export interface SqlValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface InvestGptResult {
  question: string;
  sql: string;
  /** How the SQL was produced. */
  source: 'deterministic_compiler' | 'llm';
  llmProvider: string | null;
  pruning: SchemaPruningReport;
  validation: { valid: boolean; issues: SqlValidationIssue[]; ast: string | null };
  columns: string[];
  rows: (string | number | null)[][];
  rowCount: number;
  elapsedMs: number;
  /** Plain-English restatement of what the query does. */
  explanation: string;
  /** Non-fatal notes (e.g. "interpreted 'mid-cap' as $2B–$10B"). */
  notes: string[];
}

export interface RagCitation {
  documentId: string;
  documentTitle: string;
  sourceType: RagSourceType;
  section: string;
  /** Authority weight applied during re-ranking. */
  authority: number;
  /** Final fused score. */
  score: number;
  snippet: string;
  publishedAt: number;
}

export type RagSourceType =
  | 'sec_10k'
  | 'sec_10q'
  | 'sec_8k'
  | 'sec_13f'
  | 'sec_form4'
  | 'earnings_transcript'
  | 'analyst_note'
  | 'news'
  | 'social_x'
  | 'reddit'
  /*
   * The platform's own published statement of scope. Filed as `sec_8k` before,
   * which made /research label it "SEC Form 8-K" and cite it, at 0.9 authority, as
   * a regulatory filing — a synthetic corpus asserting that a real regulator had
   * published the platform's own compliance position. It is a first-party
   * statement and now says so.
   */
  | 'platform_statement';

export interface RagAnswer {
  question: string;
  answer: string;
  citations: RagCitation[];
  /** FinGround claim-level verification. */
  claims: GroundedClaim[];
  source: 'deterministic_synthesis' | 'llm';
  llmProvider: string | null;
  elapsedMs: number;
  /** Fraction of claims that verified against a source. */
  groundingScore: number;
}

export type ClaimCategory =
  | 'numerical'
  | 'temporal'
  | 'entity_attribute'
  | 'comparative'
  | 'regulatory'
  | 'computational';

export interface GroundedClaim {
  text: string;
  category: ClaimCategory;
  verified: boolean;
  /** Citation index supporting the claim, or null when unverified. */
  citationIndex: number | null;
  evidence: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Screener
// ─────────────────────────────────────────────────────────────────────────────

export interface ScreenerRow {
  symbol: string;
  name: string;
  sector: Sector;
  price: number;
  changePercent: number;
  conviction: number;
  probability: number;
  direction: SignalDirection;
  regime: RegimeLabel;
  relativeVolume: number;
  atrPercent: number;
  rsi14: number;
  ouZScore: number;
  mlofiIntent: number;
  riskReversal25: number;
  altComposite: number;
  marketCap: number;
  adv30: number;
  topDriver: string;
  signalId: string | null;
}

export interface ScreenerFilter {
  sectors?: Sector[];
  minConviction?: number;
  maxConviction?: number;
  direction?: SignalDirection;
  minPrice?: number;
  maxPrice?: number;
  minMarketCap?: number;
  maxMarketCap?: number;
  minRelativeVolume?: number;
  maxRsi?: number;
  minRsi?: number;
  regimes?: RegimeLabel[];
  search?: string;
  sortBy?: keyof ScreenerRow;
  sortDirection?: 'asc' | 'desc';
  limit?: number;
}
