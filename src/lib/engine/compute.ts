/**
 * Feature computation — market data in, the ordered feature vector out.
 *
 * This is the single place where raw bars, books, option chains and alt-data
 * events become numbers the model can consume. Everything downstream (the GBDT,
 * the three temporal agents, SHAP, the narrative engine, the screener, InvestGPT)
 * reads from the output of this module, so there is exactly one definition of
 * every feature's value.
 *
 * Strict no-look-ahead rule: a feature computed for bar index `i` may only read
 * bars `≤ i`. The backtester relies on this.
 */

import {
  MODEL_FEATURE_KEYS,
  type FeatureDefinition,
  featureDefinition,
  formatFeatureValue,
  resolveState,
} from './features';
import {
  type Bar,
  adx,
  aroon,
  atrPercent,
  bollinger,
  cci,
  chaikinMoneyFlow,
  closeLocation,
  closes,
  consecutiveCloses,
  distanceFromHigh,
  distanceFromLow,
  ema,
  gapPercent,
  garmanKlassVolatility,
  keltner,
  last,
  macd,
  mfi,
  obv,
  realisedVolatility,
  relativeVolume,
  roc,
  rollingBeta,
  rsi,
  squeezePercentile,
  stochastic,
  supertrend,
  trendSlope,
  volumes,
  vwap,
  williamsR,
} from '@/lib/quant/indicators';
import { fitOu, ouBands, ouReversionProbability, ouZScore } from '@/lib/quant/ou';
import { kalmanInnovationBands } from '@/lib/quant/kalman';
import {
  type OrderBookSnapshot,
  computeMlofiSignal,
  depthImbalance,
  microPrice,
  microstructureMetrics,
  midPrice,
  queueImbalance,
  spreadBps,
  vpin,
} from '@/lib/quant/orderflow';
import { type SabrParams, calibrateSabr, riskReversal25, sabrAtmVol } from '@/lib/quant/sabr';
import {
  type AggregatedStream,
  type DecayableEvent,
  aggregateStream,
  compositeAltScore,
} from '@/lib/quant/decay';
import { EPS, clamp, mean, ols, quantile, stdev } from '@/lib/quant/stats';
import { adfStatistic, hurstExponent, logReturns } from '@/lib/quant/stats';
import { isoDate, minutesSinceOpen, toNewYork } from '@/lib/market/calendar';
import type { AltDataEvent, FeatureValue, OptionChainSlice, SymbolMeta } from '@/lib/domain/types';

export interface ComputeInput {
  symbol: string;
  meta: SymbolMeta;
  /** Daily bars, ascending. The last bar is "now". */
  dailyBars: Bar[];
  /** Intraday bars for the current session, ascending (may be empty). */
  intradayBars: Bar[];
  /** Benchmark daily bars, aligned to `dailyBars` by index. */
  benchmarkBars: Bar[];
  /** Equal-weighted sector peer close series, aligned by index. */
  sectorCloses: number[];
  /** Order book snapshots, oldest → newest. */
  books: OrderBookSnapshot[];
  /** Option chain slices by DTE (7 / 30 / 60 / 90). */
  chains: OptionChainSlice[];
  /** Alt-data events with timestamps ≤ `now`. */
  altEvents: AltDataEvent[];
  /** Evaluation instant. */
  now: number;
  /** Signal horizon in trading days, used by the OU reversion probability. */
  horizonDays: number;
}

export interface ComputedFeatures {
  symbol: string;
  now: number;
  /** Raw values by feature key. */
  raw: Record<string, number>;
  /** Ordered model input vector, aligned to MODEL_FEATURE_KEYS. */
  vector: number[];
  /** Presentation-ready values, in registry order. */
  values: FeatureValue[];
  /** Intermediate artefacts the UI and the narrative engine reuse. */
  artefacts: FeatureArtefacts;
}

export interface FeatureArtefacts {
  price: number;
  previousClose: number;
  changePercent: number;
  atr: number;
  ou: ReturnType<typeof fitOu>;
  ouBand: { upper: number; lower: number; mid: number };
  kalman: ReturnType<typeof kalmanInnovationBands>[number] | null;
  kalmanSeries: ReturnType<typeof kalmanInnovationBands>;
  mlofi: ReturnType<typeof computeMlofiSignal>;
  micro: ReturnType<typeof microstructureMetrics>;
  sabr: (SabrParams & { rmse: number; converged: boolean }) | null;
  skew: ReturnType<typeof riskReversal25> | null;
  /** Per-stream decayed alt-data aggregates. */
  altStreams: AggregatedStream[];
  altComposite: ReturnType<typeof compositeAltScore>;
  vwapValue: number;
  bollingerUpper: number;
  bollingerLower: number;
  ema20: number;
  ema50: number;
  ema200: number;
  volumeAverage: number;
}

const SOCIAL_STREAMS = ['social_reddit', 'social_x', 'stocktwits'] as const;
const STRUCTURAL_STREAMS = ['job_postings', 'web_traffic', 'supply_chain', 'patent_filings', 'glassdoor_sentiment'] as const;

/** Blends several streams by their evidence weights. */
function blendStreams(streams: AggregatedStream[], keys: readonly string[]): number {
  const selected = streams.filter((s) => keys.includes(s.stream));
  const totalEvidence = selected.reduce((a, s) => a + s.evidence, 0);
  if (totalEvidence < EPS) return 0;
  return clamp(selected.reduce((a, s) => a + (s.evidence / totalEvidence) * s.score, 0), -1, 1);
}

function streamScore(streams: AggregatedStream[], key: string): number {
  return streams.find((s) => s.stream === key)?.score ?? 0;
}

export function computeFeatures(input: ComputeInput): ComputedFeatures {
  const { dailyBars, benchmarkBars, intradayBars, books, chains, altEvents, now, meta } = input;
  if (dailyBars.length < 30) {
    throw new Error(`computeFeatures(${input.symbol}): need at least 30 daily bars, got ${dailyBars.length}`);
  }

  const closeSeries = closes(dailyBars);
  const price = last(closeSeries);
  const previousClose = closeSeries.length > 1 ? (closeSeries[closeSeries.length - 2] as number) : price;

  // ── Momentum & trend ─────────────────────────────────────────────────────
  const rsi14 = rsi(closeSeries, 14);
  const rsi2 = rsi(closeSeries, 2);
  const stoch = stochastic(dailyBars, 14, 3, 3);
  const wr = williamsR(dailyBars, 14);
  const roc10 = roc(closeSeries, 10);
  const roc20 = roc(closeSeries, 20);
  const mfi14 = mfi(dailyBars, 14);
  const cci20 = cci(dailyBars, 20);
  const macdResult = macd(closeSeries, 12, 26, 9);
  const consec = consecutiveCloses(dailyBars);
  const closeLoc = closeLocation(dailyBars);

  const ema20 = ema(closeSeries, 20);
  const ema50 = ema(closeSeries, 50);
  const ema200 = ema(closeSeries, Math.min(200, Math.max(50, Math.floor(closeSeries.length * 0.7))));
  const slope20 = trendSlope(closeSeries, 20);
  const adxResult = adx(dailyBars, 14);
  const aroonResult = aroon(dailyBars, 25);
  const st = supertrend(dailyBars, 10, 3);
  const fromHigh20 = distanceFromHigh(dailyBars, 20);
  const fromHigh252 = distanceFromHigh(dailyBars, Math.min(252, dailyBars.length));
  const fromLow20 = distanceFromLow(dailyBars, 20);

  // ── Volatility ───────────────────────────────────────────────────────────
  const atrPct = atrPercent(dailyBars, 14);
  const rv20 = realisedVolatility(closeSeries, 20);
  const gk20 = garmanKlassVolatility(dailyBars, 20);
  const bb = bollinger(closeSeries, 20, 2);
  const squeeze = squeezePercentile(bb.width, 120);
  const kelt = keltner(dailyBars, 20, 2, 10);
  const rets = logReturns(closeSeries);
  const vol5 = stdev(rets.slice(-5));
  const vol20 = stdev(rets.slice(-20));
  const gaps = gapPercent(dailyBars);

  // ── OU / Kalman ──────────────────────────────────────────────────────────
  // The OU process is calibrated on the log-price residual against the
  // benchmark, which is the spread Phase 1 §2 describes — not raw price, which
  // has a unit root and would produce a meaningless θ.
  const alignedBenchmark = benchmarkBars.slice(-closeSeries.length);
  const benchmarkCloses = closes(alignedBenchmark);
  const spread: number[] = [];
  for (let i = 0; i < closeSeries.length; i += 1) {
    const b = benchmarkCloses[i];
    spread.push(
      b && b > 0 && (closeSeries[i] as number) > 0
        ? Math.log(closeSeries[i] as number) - Math.log(b)
        : 0,
    );
  }
  const ouWindow = spread.slice(-Math.min(180, spread.length));
  const ou = fitOu(ouWindow, 1);
  const ouSpreadNow = ouWindow[ouWindow.length - 1] as number;
  const ouZ = ouZScore(ou, ouSpreadNow);
  const ouBand = ouBands(ou, 2);
  const revProb = ouReversionProbability(ou, ouSpreadNow, Math.max(1, input.horizonDays));

  const kalmanSeries = kalmanInnovationBands(closeSeries.slice(-Math.min(250, closeSeries.length)), {
    k: 2,
    processNoise: 1e-4,
    measurementNoise: 1e-2,
    adaptiveR: 0.98,
  });
  const kalman = kalmanSeries[kalmanSeries.length - 1] ?? null;
  const kalmanBandPos = kalman && kalman.width > EPS ? clamp((price - kalman.lower) / (2 * kalman.width), -0.5, 1.5) : 0.5;

  // ── VWAP ─────────────────────────────────────────────────────────────────
  const sessionBars = intradayBars.length > 0 ? intradayBars : dailyBars.slice(-1);
  const vwapSeries = vwap(sessionBars, (b) => isoDate(b.time));
  const vwapValue = last(vwapSeries, price);

  // ── Microstructure ───────────────────────────────────────────────────────
  const mlofi = computeMlofiSignal(books, { levels: 10, bucketSize: 1, decay: 3 });
  const lastBook = books[books.length - 1];
  const tradeHistory = sessionBars.slice(-60).map((b, i, arr) => {
    const prev = i > 0 ? (arr[i - 1] as Bar).close : b.open;
    const direction = b.close >= prev ? 1 : -1;
    return { price: b.close, signedVolume: direction * b.volume, dollarVolume: b.close * b.volume };
  });
  const micro = lastBook
    ? microstructureMetrics(lastBook, tradeHistory)
    : {
        mid: price,
        micro: price,
        spread: 0,
        spreadBps: 0,
        rollSpread: 0,
        kyleLambda: 0,
        amihud: 0,
        bookNotional: 0,
        bookResilience: 0,
      };
  const vpinValue = vpin(
    tradeHistory.map((t) => ({ volume: Math.abs(t.signedVolume), signedVolume: t.signedVolume })),
    Math.max(1, mean(tradeHistory.map((t) => Math.abs(t.signedVolume))) * 3),
    20,
  );
  const microDivergenceBps = lastBook && midPrice(lastBook) > EPS
    ? ((microPrice(lastBook) - midPrice(lastBook)) / midPrice(lastBook)) * 10_000
    : 0;

  // ── Options / SABR ───────────────────────────────────────────────────────
  let sabr: (SabrParams & { rmse: number; converged: boolean }) | null = null;
  let skew: ReturnType<typeof riskReversal25> | null = null;
  let atmIv = 0;
  let termSlope = 0;
  let pcOi = 1;
  let pcVolume = 1;

  const chain30 = chains.find((c) => c.dte === 30) ?? chains[0];
  if (chain30 && chain30.quotes.length >= 6) {
    const calls = chain30.quotes.filter((q) => q.type === 'call' && q.impliedVolatility > 0);
    const fit = calibrateSabr(
      chain30.forward,
      Math.max(chain30.dte, 1) / 365,
      calls.map((q) => ({ strike: q.strike, vol: q.impliedVolatility, weight: Math.max(q.vega, 1e-4) })),
      { beta: 0.5 },
    );
    sabr = { alpha: fit.alpha, beta: fit.beta, rho: fit.rho, nu: fit.nu, rmse: fit.rmse, converged: fit.converged };
    skew = riskReversal25(price, Math.max(chain30.dte, 1) / 365, fit, { rate: 0.042, dividend: meta.dividendYield });
    atmIv = skew.volAtm;

    const front = chains.find((c) => c.dte === 7);
    const back = chains.find((c) => c.dte === 90);
    if (front && back) {
      const frontFit = calibrateSabr(
        front.forward,
        7 / 365,
        front.quotes.filter((q) => q.type === 'call').map((q) => ({ strike: q.strike, vol: q.impliedVolatility, weight: Math.max(q.vega, 1e-4) })),
        { beta: 0.5 },
      );
      const backFit = calibrateSabr(
        back.forward,
        90 / 365,
        back.quotes.filter((q) => q.type === 'call').map((q) => ({ strike: q.strike, vol: q.impliedVolatility, weight: Math.max(q.vega, 1e-4) })),
        { beta: 0.5 },
      );
      termSlope = (sabrAtmVol(back.forward, 90 / 365, backFit) - sabrAtmVol(front.forward, 7 / 365, frontFit)) * 100;
    }

    let putOi = 0;
    let callOi = 0;
    let putVol = 0;
    let callVol = 0;
    for (const c of chains) {
      for (const q of c.quotes) {
        if (q.type === 'put') {
          putOi += q.openInterest;
          putVol += q.volume;
        } else {
          callOi += q.openInterest;
          callVol += q.volume;
        }
      }
    }
    pcOi = callOi > 0 ? putOi / callOi : 1;
    pcVolume = callVol > 0 ? putVol / callVol : 1;
  }

  // ── Alt-data ─────────────────────────────────────────────────────────────
  const decayable: DecayableEvent[] = altEvents.map((e) => ({
    stream: e.stream,
    timestamp: e.timestamp,
    value: e.value,
    confidence: e.confidence,
  }));
  const presentStreams = Array.from(new Set(decayable.map((e) => e.stream)));
  const altStreams = presentStreams.map((s) => aggregateStream(s, decayable, now));
  const altComposite = compositeAltScore(altStreams);

  // ── Relative / cross-sectional ───────────────────────────────────────────
  const relStrength20 =
    (last(roc20) || 0) - (benchmarkCloses.length > 20 ? (last(roc(benchmarkCloses, 20)) || 0) : 0);
  const betaResult = rollingBeta(closeSeries, benchmarkCloses, 60);
  const sectorRoc = input.sectorCloses.length > 20 ? last(roc(input.sectorCloses, 20)) || 0 : 0;
  const sectorRelStrength = (last(roc20) || 0) - sectorRoc;

  // ── Volume ───────────────────────────────────────────────────────────────
  const rvol = relativeVolume(dailyBars, 20);
  const obvSeries = obv(dailyBars);
  const obvWindow = obvSeries.slice(-20);
  const obvSlope =
    obvWindow.length >= 5
      ? ols(
          obvWindow.map((_, i) => i),
          obvWindow,
        ).beta / Math.max(1, mean(obvWindow.map(Math.abs)))
      : 0;
  const cmf = chaikinMoneyFlow(dailyBars, 20);
  const volSeries = volumes(dailyBars);
  const advRatio = meta.adv30 > 0 ? last(volSeries) / meta.adv30 : 1;
  const dollarVolumes = dailyBars.slice(-60).map((b) => b.close * b.volume);
  const dvMean = mean(dollarVolumes);
  const dvSd = Math.max(stdev(dollarVolumes), EPS);
  const dollarVolumeZ = (price * last(volSeries) - dvMean) / dvSd;

  // ── Regime ───────────────────────────────────────────────────────────────
  const hurst = hurstExponent(rets.slice(-Math.min(100, rets.length)));
  const adfStat = adfStatistic(spread.slice(-Math.min(120, spread.length)));
  const rvHistory = realisedVolatility(closeSeries, 20).filter(Number.isFinite).slice(-252);
  const currentRv = last(rv20);
  const volPercentile =
    rvHistory.length > 20 ? rvHistory.filter((v) => v <= currentRv).length / rvHistory.length : 0.5;
  const adxNow = last(adxResult.adx);
  const regimeTrendScore = Math.tanh(2 * (hurst - 0.5) + adxNow / 60 + Math.max(0, adfStat + 2) / 3);
  const liquidityScore = computeLiquidityScore(micro.spreadBps, micro.amihud, meta.adv30, mlofi.pc1ExplainedVariance);

  const nyParts = toNewYork(now);
  const weekday = nyParts.weekday === 0 ? 7 : nyParts.weekday;

  // ── Assemble ─────────────────────────────────────────────────────────────
  const raw: Record<string, number> = {
    rsi_14: last(rsi14, 50),
    rsi_2: last(rsi2, 50),
    stoch_k_14: last(stoch.k, 50),
    williams_r_14: last(wr, -50),
    roc_10: last(roc10),
    roc_20: last(roc20),
    mfi_14: last(mfi14, 50),
    cci_20: last(cci20),
    macd_hist: price > EPS ? last(macdResult.histogram) / price : 0,
    macd_signal_gap: price > EPS ? (last(macdResult.macd) - last(macdResult.signal)) / price : 0,
    consecutive_closes: last(consec),
    close_location: last(closeLoc, 0.5),

    ema_20_50_spread: price > EPS ? ((last(ema20) - last(ema50)) / price) * 100 : 0,
    ema_50_200_spread: price > EPS ? ((last(ema50) - last(ema200)) / price) * 100 : 0,
    price_vs_ema20: last(ema20) > EPS ? ((price - last(ema20)) / last(ema20)) * 100 : 0,
    trend_slope_20: last(slope20),
    adx_14: adxNow,
    di_spread: last(adxResult.plusDi) - last(adxResult.minusDi),
    aroon_osc: last(aroonResult.oscillator),
    supertrend_dir: last(st.direction, 1),
    dist_from_20d_high: last(fromHigh20),
    dist_from_252d_high: last(fromHigh252),
    dist_from_20d_low: last(fromLow20),

    atr_pct_14: last(atrPct) * 100,
    realised_vol_20: currentRv * 100,
    gk_vol_20: last(gk20) * 100,
    bb_width_20: last(bb.width),
    bb_percent_b: last(bb.percentB, 0.5),
    squeeze_pct: last(squeeze, 0.5),
    keltner_percent_b: last(kelt.percentB, 0.5),
    vol_ratio_5_20: vol20 > EPS ? vol5 / vol20 : 1,
    gap_pct: last(gaps),

    ou_zscore: ouZ,
    ou_half_life: Number.isFinite(ou.halfLife) ? Math.min(ou.halfLife, 999) : 999,
    ou_theta: ou.theta,
    ou_reversion_prob: revProb,
    kalman_innovation_z: kalman?.z ?? 0,
    kalman_band_pos: kalmanBandPos,
    kalman_slope_bps: kalman && kalman.level > EPS ? (kalman.slope / kalman.level) * 10_000 : 0,
    kalman_forecast_sigma_bps: kalman && kalman.level > EPS ? (kalman.forecastSigma / kalman.level) * 10_000 : 0,
    vwap_deviation_bps: vwapValue > EPS ? ((price - vwapValue) / vwapValue) * 10_000 : 0,

    mlofi_intent: mlofi.intent,
    mlofi_pc1_z: mlofi.pc1Z,
    mlofi_pc1_variance: mlofi.pc1ExplainedVariance,
    queue_imbalance: lastBook ? queueImbalance(lastBook) : 0,
    depth_imbalance: lastBook ? depthImbalance(lastBook, 10) : 0,
    spread_bps: lastBook ? spreadBps(lastBook) : 0,
    roll_spread_bps: price > EPS ? (micro.rollSpread / price) * 10_000 : 0,
    kyle_lambda: Math.abs(micro.kyleLambda),
    amihud_illiq: micro.amihud,
    vpin: vpinValue,
    micro_mid_divergence_bps: microDivergenceBps,
    book_resilience: Math.abs(micro.bookResilience),

    iv_atm_30d: atmIv * 100,
    rr25_30d: (skew?.riskReversal25 ?? 0) * 100,
    bf25_30d: (skew?.butterfly25 ?? 0) * 100,
    sabr_rho: sabr?.rho ?? 0,
    sabr_nu: sabr?.nu ?? 0,
    iv_rv_spread: (atmIv - currentRv) * 100,
    vol_term_slope: termSlope,
    put_call_oi_ratio: pcOi,
    put_call_volume_ratio: pcVolume,

    alt_composite: altComposite.score,
    insider_form4_score: streamScore(altStreams, 'insider_form4'),
    inst_13f_score: streamScore(altStreams, 'institutional_13f'),
    social_sentiment: blendStreams(altStreams, SOCIAL_STREAMS),
    news_sentiment: streamScore(altStreams, 'news_headline'),
    options_flow_score: streamScore(altStreams, 'options_flow'),
    analyst_revision_score: streamScore(altStreams, 'analyst_revision'),
    short_interest_score: streamScore(altStreams, 'short_interest'),
    structural_alt_score: blendStreams(altStreams, STRUCTURAL_STREAMS),
    alt_evidence: altComposite.evidence,

    rel_strength_20d: relStrength20,
    beta_60: last(betaResult.beta, meta.referenceBeta),
    idio_alpha_60: last(betaResult.alpha) * 10_000,
    corr_bench_60: last(betaResult.correlation, 0.5),
    sector_rel_strength: sectorRelStrength,

    rel_volume_20: last(rvol, 1),
    obv_slope_20: obvSlope,
    cmf_20: last(cmf),
    adv_ratio: advRatio,
    dollar_volume_z: dollarVolumeZ,

    hurst_100: hurst,
    adf_stat_120: adfStat,
    vol_percentile_252: volPercentile,
    regime_trend_score: regimeTrendScore,
    liquidity_score: liquidityScore,
    minutes_since_open: minutesSinceOpen(now),
    day_of_week: weekday,
  };

  // Sanitise: a NaN anywhere would silently poison the tree ensemble.
  for (const key of Object.keys(raw)) {
    const v = raw[key] as number;
    if (!Number.isFinite(v)) raw[key] = 0;
  }

  const vector = MODEL_FEATURE_KEYS.map((k) => raw[k] ?? 0);
  const values: FeatureValue[] = MODEL_FEATURE_KEYS.map((key) => {
    const def = featureDefinition(key) as FeatureDefinition;
    const value = raw[key] ?? 0;
    return {
      key,
      label: def.label,
      group: def.group,
      value,
      normalised: 0.5, // filled by the cross-sectional pass
      unit: def.unit,
      state: resolveState(def, value).state,
    };
  });

  return {
    symbol: input.symbol,
    now,
    raw,
    vector,
    values,
    artefacts: {
      price,
      previousClose,
      changePercent: previousClose > EPS ? ((price - previousClose) / previousClose) * 100 : 0,
      atr: (last(atrPct) || 0) * price,
      ou,
      ouBand,
      kalman,
      kalmanSeries,
      mlofi,
      micro,
      sabr,
      skew,
      altStreams,
      altComposite,
      vwapValue,
      bollingerUpper: last(bb.upper, price),
      bollingerLower: last(bb.lower, price),
      ema20: last(ema20, price),
      ema50: last(ema50, price),
      ema200: last(ema200, price),
      volumeAverage: mean(volSeries.slice(-20)),
    },
  };
}

/**
 * Composite executability score in [0, 1] from four components, each mapped
 * through a monotone squash so the score is comparable across price levels.
 */
function computeLiquidityScore(
  spreadBpsValue: number,
  amihud: number,
  adv: number,
  pc1Variance: number,
): number {
  const spreadScore = 1 / (1 + spreadBpsValue / 8);
  const amihudScore = 1 / (1 + amihud / 0.2);
  const advScore = clamp(Math.log10(Math.max(adv, 1)) / 8, 0, 1);
  const bookScore = clamp(pc1Variance, 0, 1);
  return clamp(0.32 * spreadScore + 0.28 * amihudScore + 0.28 * advScore + 0.12 * bookScore, 0, 1);
}

/**
 * Cross-sectional ECDF pass. Features are only comparable across names after
 * being ranked within the universe, which is what Phase 2 §2 mandates for
 * alt-data and what the screener's percentile columns display.
 */
export function applyCrossSectionalNormalisation(computed: ComputedFeatures[]): void {
  if (computed.length === 0) return;
  for (const key of MODEL_FEATURE_KEYS) {
    const column = computed.map((c) => c.raw[key] ?? 0).sort((a, b) => a - b);
    const n = column.length;
    for (const c of computed) {
      const v = c.raw[key] ?? 0;
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((column[mid] as number) <= v) lo = mid + 1;
        else hi = mid;
      }
      const target = c.values.find((f) => f.key === key);
      if (target) target.normalised = clamp(lo / (n + 1), 1 / (n + 1), n / (n + 1));
    }
  }
}

/** Presentation helper: raw value formatted in its native unit. */
export function formatRaw(key: string, value: number): string {
  const def = featureDefinition(key);
  return def ? formatFeatureValue(def, value) : value.toFixed(3);
}

/**
 * Percentile of `value` within `population` — used for the screener's
 * distribution bars and for the model card's calibration report.
 */
export function percentileOf(value: number, population: readonly number[]): number {
  if (population.length === 0) return 0.5;
  const q = quantile(population, 0.5);
  void q;
  let below = 0;
  for (const v of population) if (v <= value) below += 1;
  return below / population.length;
}
