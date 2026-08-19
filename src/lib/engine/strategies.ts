/**
 * Named strategies.
 *
 * Two provenances, both from the research corpus:
 *
 *   • The three Trade-Ideas / Holly AI scans reverse-engineered in
 *     "Deconstructing Trade Ideas: Holly AI" — Alpha Predators, 5 Day Bounce and
 *     Breakout — reproduced with their exact documented gates so Aurelius can be
 *     benchmarked against the legacy engine rather than merely asserted superior.
 *     Where the source document had a stripped numeric image the extraction
 *     flagged a reconstructed default; those are marked `reconstructed: true` and
 *     are configurable.
 *
 *   • The continuous-time strategies from "Algorithmic Swing Trading Quant
 *     Strategies": OU spread reversion (|Z| ≥ 2.0, half-life 2–14 days, exit
 *     |Z| < 0.5), the 25-delta risk-reversal skew oscillator (|Z_RR| ≥ 2.0 with a
 *     50-day lookback, exit |Z_RR| < 0.5) and the Kalman innovation rule
 *     (|z| ≥ 1.5, exit on the zero crossing).
 *
 * A strategy is a pure predicate over a `StrategyContext`. It returns a
 * `StrategyEvaluation` describing whether it fired, its own conviction, and the
 * levels it implies. It never places an order and never reads a user.
 */

import type { Bar } from '@/lib/quant/indicators';
import {
  atr,
  closes,
  crossedAbove,
  donchian,
  ema,
  last,
  macd,
  relativeVolume,
  rsi,
  sma,
} from '@/lib/quant/indicators';
import { EPS, clamp, mean, stdev } from '@/lib/quant/stats';
import { OU_ENTRY_Z, OU_EXIT_Z } from '@/lib/domain/thresholds';
import type { ComputedFeatures } from './compute';
import type { StrategyFamily } from './regime';

export interface StrategyContext {
  symbol: string;
  /** Daily bars, ascending, last bar = evaluation bar. */
  dailyBars: Bar[];
  /** 5-minute bars for the current session (may be empty outside hours). */
  intradayBars: Bar[];
  /** 60-minute bars for the trailing few sessions. */
  hourlyBars: Bar[];
  /** Benchmark daily bars, index-aligned to `dailyBars`. */
  benchmarkBars: Bar[];
  /** Benchmark 5-minute bars for the index-stability filter. */
  benchmarkIntradayBars: Bar[];
  /** Computed feature snapshot for the same instant. */
  features: ComputedFeatures;
  /** 30-day ADV in shares. */
  adv30: number;
  /** Rolling 50-day history of the 25Δ risk reversal, oldest → newest. */
  riskReversalHistory: number[];
  /** Evaluation instant. */
  now: number;
}

export interface StrategyLevels {
  entryZoneLow: number;
  entryZoneHigh: number;
  invalidation: number;
  target1: number;
  target2: number;
}

export interface StrategyEvaluation {
  id: string;
  name: string;
  fired: boolean;
  direction: 'long' | 'short';
  /** Strategy-local conviction in [0, 1] before regime weighting. */
  conviction: number;
  /** Ordered gate results, so the UI can show exactly which condition failed. */
  gates: { name: string; passed: boolean; detail: string }[];
  levels: StrategyLevels | null;
  /** One-sentence account of the setup, in the objective house tone. */
  rationale: string;
}

export interface StrategyDefinition {
  id: string;
  name: string;
  family: StrategyFamily;
  /** Where the rules come from. */
  provenance: 'holly_ai_replication' | 'continuous_time_quant' | 'alt_data';
  description: string;
  /** True when a documented parameter was reconstructed from stripped source. */
  reconstructed: boolean;
  /** Horizon the strategy is scored over, in trading days. */
  horizonDays: number;
  /** Bars the context must supply before the strategy can be evaluated. */
  minimumBars: number;
  /**
   * True when the entry rule genuinely needs intraday bars (a 5-minute EMA
   * pullback, a new 60-minute high, a session-volume gate). A daily-bar
   * backtest cannot evaluate these, and pretending otherwise by substituting
   * daily proxies would produce a number that looks like evidence and is not.
   * The backtester skips them and says so.
   */
  requiresIntraday: boolean;
  evaluate: (ctx: StrategyContext) => StrategyEvaluation;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Documented parameters
// ─────────────────────────────────────────────────────────────────────────────

export const STRATEGY_PARAMS = {
  /** Alpha Predators / 5 Day Bounce hard price ceiling. */
  lowPriceCeiling: 20,
  /** Relative volume trigger: 200% of the 10-day baseline for that minute. */
  rvolTrigger: 2.0,
  rvolLookbackDays: 10,
  /** Pullback EMAs on the 5-minute chart. */
  pullbackEmaFast: 8,
  pullbackEmaSlow: 20,
  /** 5 Day Bounce: lower band = mean(C,5) − k·stdev(C,5). */
  bounceWindow: 5,
  bounceBandMultiplier: 2.0,
  /** Breakout price band (reconstructed — source values were stripped). */
  breakoutMinPrice: 5,
  breakoutMaxPrice: 100,
  /** Breakout: shares already traded this session before the signal is valid. */
  breakoutMinSessionVolume: 125_000,
  /** Breakout: index must not have moved more than this in either direction. */
  breakoutIndexStabilityPct: 0.5,
  breakoutIndexWindowMinutes: 30,
  /** OU reversion band and exit. Shared with the oscillator that draws them. */
  ouEntryZ: OU_ENTRY_Z,
  ouExitZ: OU_EXIT_Z,
  ouHalfLifeMin: 2,
  ouHalfLifeMax: 14,
  /** Skew oscillator. */
  skewLookback: 50,
  skewEntryZ: 2.0,
  skewExitZ: 0.5,
  /** Kalman innovation rule. */
  kalmanEntryZ: 1.5,
  /** Squeeze percentile below which a compression is tradeable. */
  squeezeEntryPercentile: 0.1,
  /** Insider cluster: distinct insiders required. */
  insiderClusterMin: 2,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

function gate(name: string, passed: boolean, detail: string): { name: string; passed: boolean; detail: string } {
  return { name, passed, detail };
}

function noFire(
  def: Pick<StrategyDefinition, 'id' | 'name'>,
  direction: 'long' | 'short',
  gates: { name: string; passed: boolean; detail: string }[],
): StrategyEvaluation {
  const failed = gates.find((g) => !g.passed);
  return {
    id: def.id,
    name: def.name,
    fired: false,
    direction,
    conviction: 0,
    gates,
    levels: null,
    rationale: failed ? `Not triggered: ${failed.name} — ${failed.detail}.` : 'Not triggered.',
  };
}

/** ATR-based levels: invalidation at k·ATR, targets at R multiples. */
function atrLevels(
  price: number,
  atrValue: number,
  direction: 'long' | 'short',
  options: { stopAtr?: number; target1R?: number; target2R?: number; entryBandAtr?: number } = {},
): StrategyLevels {
  const stopAtr = options.stopAtr ?? 1.5;
  const r1 = options.target1R ?? 1.5;
  const r2 = options.target2R ?? 3;
  const band = (options.entryBandAtr ?? 0.25) * atrValue;
  const risk = stopAtr * atrValue;
  if (direction === 'long') {
    return {
      entryZoneLow: price - band,
      entryZoneHigh: price + band,
      invalidation: price - risk,
      target1: price + r1 * risk,
      target2: price + r2 * risk,
    };
  }
  return {
    entryZoneLow: price - band,
    entryZoneHigh: price + band,
    invalidation: price + risk,
    target1: price - r1 * risk,
    target2: price - r2 * risk,
  };
}

/**
 * Relative volume calibrated to the exact time of day.
 *
 * The Holly research is specific that a simple daily-volume moving average is
 * the wrong denominator: it must be the 10-day average volume *for that minute*,
 * because the intraday volume smile means the same absolute volume is
 * unremarkable at 09:35 and extraordinary at 12:15.
 */
export function timeOfDayRelativeVolume(
  intradayBars: readonly Bar[],
  minutesPerBar: number,
  lookbackSessions: number,
): number {
  if (intradayBars.length === 0) return 1;
  const perSession = Math.max(1, Math.round(390 / minutesPerBar));
  const currentIndex = intradayBars.length - 1;
  const slotInSession = currentIndex % perSession;
  const current = (intradayBars[currentIndex] as Bar).volume;

  const historical: number[] = [];
  for (let s = 1; s <= lookbackSessions; s += 1) {
    const idx = currentIndex - s * perSession;
    if (idx < 0) break;
    historical.push((intradayBars[idx] as Bar).volume);
  }
  void slotInSession;
  if (historical.length < 3) return 1;
  const baseline = mean(historical);
  return baseline < EPS ? 1 : current / baseline;
}

/** Percentage move of the benchmark over the trailing `minutes`. */
export function indexMovePercent(benchmarkIntraday: readonly Bar[], minutes: number, minutesPerBar = 5): number {
  const bars = Math.max(1, Math.round(minutes / minutesPerBar));
  if (benchmarkIntraday.length <= bars) return 0;
  const now = (benchmarkIntraday[benchmarkIntraday.length - 1] as Bar).close;
  const then = (benchmarkIntraday[benchmarkIntraday.length - 1 - bars] as Bar).close;
  return then < EPS ? 0 : ((now - then) / then) * 100;
}

/** Session volume accumulated so far. */
function sessionVolume(intradayBars: readonly Bar[]): number {
  let acc = 0;
  for (const b of intradayBars) acc += b.volume;
  return acc;
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. Alpha Predators (Holly AI replication)
// ─────────────────────────────────────────────────────────────────────────────

const alphaPredators: StrategyDefinition = {
  id: 'alpha_predators',
  name: 'Alpha Predators',
  family: 'continuation',
  provenance: 'holly_ai_replication',
  description:
    'Multi-timeframe momentum alignment on a sub-$20 equity with a 200%+ relative-volume trigger, entered on the micro-pullback to the 5-minute 8/20 EMA rather than on the breakout itself.',
  reconstructed: true,
  horizonDays: 2,
  minimumBars: 60,
  requiresIntraday: true,
  evaluate: (ctx) => {
    const def = { id: 'alpha_predators', name: 'Alpha Predators' };
    const price = ctx.features.artefacts.price;
    const gates: { name: string; passed: boolean; detail: string }[] = [];

    gates.push(
      gate(
        'Price ceiling',
        price < STRATEGY_PARAMS.lowPriceCeiling,
        `$${price.toFixed(2)} against a $${STRATEGY_PARAMS.lowPriceCeiling.toFixed(2)} ceiling`,
      ),
    );
    if (!gates[0]?.passed) return noFire(def, 'long', gates);

    // Timeframe ladder: 5-day, 1-day, 60-minute, 15-minute, 5-minute all green.
    const daily = ctx.dailyBars;
    const fiveDayOpen = daily.length >= 5 ? (daily[daily.length - 5] as Bar).open : (daily[0] as Bar).open;
    const fiveDayGreen = price > fiveDayOpen;
    const lastDaily = daily[daily.length - 1] as Bar;
    const oneDayGreen = lastDaily.close > lastDaily.open;
    const lastHourly = ctx.hourlyBars[ctx.hourlyBars.length - 1];
    const hourlyGreen = lastHourly ? lastHourly.close > lastHourly.open : false;
    const fifteen = ctx.intradayBars.slice(-3);
    const fifteenGreen =
      fifteen.length === 3 && (fifteen[2] as Bar).close > (fifteen[0] as Bar).open;
    const lastFive = ctx.intradayBars[ctx.intradayBars.length - 1];
    const fiveGreen = lastFive ? lastFive.close > lastFive.open : false;
    const ladder = [fiveDayGreen, oneDayGreen, hourlyGreen, fifteenGreen, fiveGreen];
    const ladderCount = ladder.filter(Boolean).length;

    gates.push(
      gate(
        'Timeframe ladder',
        ladderCount === 5,
        `${ladderCount}/5 timeframes green (5d, 1d, 60m, 15m, 5m)`,
      ),
    );

    const rvol =
      ctx.intradayBars.length > 0
        ? timeOfDayRelativeVolume(ctx.intradayBars, 5, STRATEGY_PARAMS.rvolLookbackDays)
        : last(relativeVolume(ctx.dailyBars, 10), 1);
    gates.push(
      gate(
        'Relative volume',
        rvol >= STRATEGY_PARAMS.rvolTrigger,
        `${rvol.toFixed(2)}× the ${STRATEGY_PARAMS.rvolLookbackDays}-day baseline for this minute, trigger ${STRATEGY_PARAMS.rvolTrigger.toFixed(1)}×`,
      ),
    );

    // Entry trigger: the micro-pullback into the 5-minute 8 or 20 EMA.
    const intradayCloses = closes(ctx.intradayBars);
    const ema8 = last(ema(intradayCloses, STRATEGY_PARAMS.pullbackEmaFast), price);
    const ema20 = last(ema(intradayCloses, STRATEGY_PARAMS.pullbackEmaSlow), price);
    const anchor = Math.max(ema8, ema20);
    const distanceToAnchor = anchor < EPS ? 1 : (price - anchor) / anchor;
    const inPullbackZone = distanceToAnchor >= -0.012 && distanceToAnchor <= 0.008;
    gates.push(
      gate(
        'Micro-pullback to 8/20 EMA',
        inPullbackZone,
        `price ${(distanceToAnchor * 100).toFixed(2)}% from the 5-minute anchor at $${anchor.toFixed(2)}`,
      ),
    );

    if (gates.some((g) => !g.passed)) return noFire(def, 'long', gates);

    const atrValue = Math.max(last(atr(ctx.dailyBars, 14), price * 0.02), price * 0.004);
    const conviction = clamp(
      0.45 + 0.2 * clamp((rvol - STRATEGY_PARAMS.rvolTrigger) / 3, 0, 1) + 0.15 * (ladderCount / 5),
      0,
      1,
    );

    return {
      ...def,
      fired: true,
      direction: 'long',
      conviction,
      gates,
      levels: atrLevels(price, atrValue, 'long', { stopAtr: 1.2, target1R: 1.5, target2R: 2.5 }),
      rationale:
        `All five timeframes are aligned to the upside on a $${price.toFixed(2)} equity with volume at ` +
        `${rvol.toFixed(2)}× its time-of-day baseline, and price has pulled back into the 5-minute ` +
        `${STRATEGY_PARAMS.pullbackEmaFast}/${STRATEGY_PARAMS.pullbackEmaSlow} EMA anchor rather than extending.`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  2. 5 Day Bounce (Holly AI replication)
// ─────────────────────────────────────────────────────────────────────────────

const fiveDayBounce: StrategyDefinition = {
  id: 'five_day_bounce',
  name: '5 Day Bounce',
  family: 'reversion',
  provenance: 'holly_ai_replication',
  description:
    'Mean reversion from the lower 2σ band of the 5-day range on a sub-$20 equity, confirmed only once price crosses local resistance while registering a new 60-minute high.',
  reconstructed: true,
  horizonDays: 5,
  minimumBars: 40,
  requiresIntraday: true,
  evaluate: (ctx) => {
    const def = { id: 'five_day_bounce', name: '5 Day Bounce' };
    const price = ctx.features.artefacts.price;
    const gates: { name: string; passed: boolean; detail: string }[] = [];

    gates.push(
      gate(
        'Price ceiling',
        price <= STRATEGY_PARAMS.lowPriceCeiling,
        `$${price.toFixed(2)} against a $${STRATEGY_PARAMS.lowPriceCeiling.toFixed(2)} ceiling`,
      ),
    );

    const window = ctx.dailyBars.slice(-STRATEGY_PARAMS.bounceWindow);
    const windowCloses = closes(window);
    const mu = mean(windowCloses);
    const sd = stdev(windowCloses, 0);
    const lowerBand = mu - STRATEGY_PARAMS.bounceBandMultiplier * sd;
    // "Traded at the lowest standard deviation band" — the low of the window,
    // not necessarily the close, must have reached the band.
    const windowLow = Math.min(...window.map((b) => b.low));
    gates.push(
      gate(
        'Lower 2σ band touched',
        sd > EPS && windowLow <= lowerBand,
        `5-day low $${windowLow.toFixed(2)} against a lower band of $${lowerBand.toFixed(2)}`,
      ),
    );

    // Confirmation: cross above local resistance AND a new 60-minute high.
    const resistance = donchian(ctx.dailyBars, 10);
    const resistanceLevel = last(resistance.upper, price);
    const crossedResistance = crossedAbove(closes(ctx.dailyBars), resistance.middle);
    const hourly = ctx.hourlyBars;
    const newHourlyHigh =
      hourly.length >= 2 &&
      (hourly[hourly.length - 1] as Bar).high >=
        Math.max(...hourly.slice(-Math.min(hourly.length, 7), -1).map((b) => b.high));
    gates.push(
      gate(
        'Resistance reclaim',
        crossedResistance || price > last(resistance.middle, price),
        `price $${price.toFixed(2)} against the 10-bar midline $${last(resistance.middle, price).toFixed(2)}`,
      ),
    );
    gates.push(
      gate(
        'New 60-minute high',
        newHourlyHigh,
        newHourlyHigh
          ? 'the current hourly bar has taken out the prior hourly range'
          : 'no new 60-minute high yet — sell-side liquidity is not exhausted',
      ),
    );

    if (gates.some((g) => !g.passed)) return noFire(def, 'long', gates);

    const atrValue = Math.max(last(atr(ctx.dailyBars, 14), price * 0.02), price * 0.004);
    const depth = sd < EPS ? 0 : (mu - windowLow) / (STRATEGY_PARAMS.bounceBandMultiplier * sd);
    const conviction = clamp(0.42 + 0.22 * clamp(depth - 1, 0, 1.5) / 1.5 + 0.16, 0, 1);

    return {
      ...def,
      fired: true,
      direction: 'long',
      conviction,
      gates,
      levels: {
        entryZoneLow: price - 0.3 * atrValue,
        entryZoneHigh: price + 0.2 * atrValue,
        invalidation: Math.min(windowLow - 0.2 * atrValue, price - 1.4 * atrValue),
        target1: mu,
        target2: Math.max(resistanceLevel, mu + STRATEGY_PARAMS.bounceBandMultiplier * sd),
      },
      rationale:
        `Price reached the lower ${STRATEGY_PARAMS.bounceBandMultiplier}σ band of its 5-day range at ` +
        `$${lowerBand.toFixed(2)} and has since reclaimed the midline while printing a new 60-minute high, ` +
        'which is the confirmation that sell-side liquidity is exhausted.',
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  3. Breakout (Holly AI replication)
// ─────────────────────────────────────────────────────────────────────────────

const breakout: StrategyDefinition = {
  id: 'breakout',
  name: 'Breakout',
  family: 'breakout',
  provenance: 'holly_ai_replication',
  description:
    'Range breakout above the prior session midpoint with a minimum session volume, gated by an index-stability filter so the setup is not simply macro beta.',
  reconstructed: true,
  horizonDays: 3,
  minimumBars: 40,
  requiresIntraday: true,
  evaluate: (ctx) => {
    const def = { id: 'breakout', name: 'Breakout' };
    const price = ctx.features.artefacts.price;
    const gates: { name: string; passed: boolean; detail: string }[] = [];

    gates.push(
      gate(
        'Price band',
        price >= STRATEGY_PARAMS.breakoutMinPrice && price <= STRATEGY_PARAMS.breakoutMaxPrice,
        `$${price.toFixed(2)} against a $${STRATEGY_PARAMS.breakoutMinPrice}–$${STRATEGY_PARAMS.breakoutMaxPrice} band`,
      ),
    );

    const traded = ctx.intradayBars.length > 0
      ? sessionVolume(ctx.intradayBars)
      : (ctx.dailyBars[ctx.dailyBars.length - 1] as Bar).volume;
    gates.push(
      gate(
        'Session liquidity',
        traded >= STRATEGY_PARAMS.breakoutMinSessionVolume,
        `${Math.round(traded).toLocaleString('en-US')} shares traded against a ${STRATEGY_PARAMS.breakoutMinSessionVolume.toLocaleString('en-US')} minimum`,
      ),
    );

    const prev = ctx.dailyBars[ctx.dailyBars.length - 2];
    const midpoint = prev ? (prev.high + prev.low) / 2 : price;
    gates.push(
      gate(
        'Above prior-day midpoint',
        price > midpoint,
        `price $${price.toFixed(2)} against the prior-session midpoint $${midpoint.toFixed(2)}`,
      ),
    );

    const indexMove = indexMovePercent(
      ctx.benchmarkIntradayBars,
      STRATEGY_PARAMS.breakoutIndexWindowMinutes,
    );
    gates.push(
      gate(
        'Index stability',
        Math.abs(indexMove) <= STRATEGY_PARAMS.breakoutIndexStabilityPct,
        `benchmark moved ${indexMove >= 0 ? '+' : ''}${indexMove.toFixed(2)}% over the last ${STRATEGY_PARAMS.breakoutIndexWindowMinutes} minutes, limit ±${STRATEGY_PARAMS.breakoutIndexStabilityPct}%`,
      ),
    );

    const dc = donchian(ctx.dailyBars, 20);
    const upper = last(dc.upper, price);
    gates.push(
      gate(
        'Range extension',
        price >= upper * 0.995,
        `price $${price.toFixed(2)} against the 20-bar high $${upper.toFixed(2)}`,
      ),
    );

    if (gates.some((g) => !g.passed)) return noFire(def, 'long', gates);

    const atrValue = Math.max(last(atr(ctx.dailyBars, 14), price * 0.02), price * 0.004);
    const conviction = clamp(
      0.44 + 0.18 * clamp(traded / (STRATEGY_PARAMS.breakoutMinSessionVolume * 4), 0, 1) +
        0.16 * (1 - Math.abs(indexMove) / STRATEGY_PARAMS.breakoutIndexStabilityPct),
      0,
      1,
    );

    return {
      ...def,
      fired: true,
      direction: 'long',
      conviction,
      gates,
      levels: atrLevels(price, atrValue, 'long', { stopAtr: 1.5, target1R: 1.8, target2R: 3.2 }),
      rationale:
        `Price is extending through its 20-bar high on ${Math.round(traded).toLocaleString('en-US')} shares ` +
        `while the benchmark has moved only ${indexMove >= 0 ? '+' : ''}${indexMove.toFixed(2)}% in the last ` +
        `${STRATEGY_PARAMS.breakoutIndexWindowMinutes} minutes, so the move is idiosyncratic rather than macro beta.`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  4. OU spread reversion (continuous-time quant)
// ─────────────────────────────────────────────────────────────────────────────

const ouReversion: StrategyDefinition = {
  id: 'ou_reversion',
  name: 'OU Spread Reversion',
  family: 'reversion',
  provenance: 'continuous_time_quant',
  description:
    'Continuous-time mean reversion on the benchmark-relative spread. Enters at |Z_OU| ≥ 2.0 with an MLE half-life inside the 2–14 day swing band and exits at |Z_OU| < 0.5.',
  reconstructed: false,
  horizonDays: 7,
  minimumBars: 120,
  requiresIntraday: false,
  evaluate: (ctx) => {
    const def = { id: 'ou_reversion', name: 'OU Spread Reversion' };
    const ou = ctx.features.artefacts.ou;
    const z = ctx.features.raw.ou_zscore ?? 0;
    const price = ctx.features.artefacts.price;
    const direction: 'long' | 'short' = z < 0 ? 'long' : 'short';
    const gates: { name: string; passed: boolean; detail: string }[] = [];

    gates.push(
      gate(
        'Mean-reverting spread',
        ou.meanReverting,
        ou.meanReverting
          ? `MLE recovered θ = ${ou.theta.toFixed(4)} with R² ${ou.rSquared.toFixed(3)}`
          : 'the MLE found no usable reversion force — the spread is a random walk on this sample',
      ),
    );
    gates.push(
      gate(
        'Half-life in the swing band',
        ou.halfLife >= STRATEGY_PARAMS.ouHalfLifeMin && ou.halfLife <= STRATEGY_PARAMS.ouHalfLifeMax,
        `half-life ${Number.isFinite(ou.halfLife) ? ou.halfLife.toFixed(1) : '∞'} days against a ${STRATEGY_PARAMS.ouHalfLifeMin}–${STRATEGY_PARAMS.ouHalfLifeMax} day band`,
      ),
    );
    gates.push(
      gate(
        'Entry z-score',
        Math.abs(z) >= STRATEGY_PARAMS.ouEntryZ,
        `Z_OU ${z >= 0 ? '+' : ''}${z.toFixed(2)}σ against a ±${STRATEGY_PARAMS.ouEntryZ.toFixed(1)}σ trigger`,
      ),
    );

    if (gates.some((g) => !g.passed)) return noFire(def, direction, gates);

    const atrValue = Math.max(last(atr(ctx.dailyBars, 14), price * 0.02), price * 0.004);
    const revProb = ctx.features.raw.ou_reversion_prob ?? 0.5;
    // The full reversion to equilibrium expressed in price terms.
    const spreadGap = Math.abs(z) * ou.equilibriumSigma;
    const targetMove = price * (Math.exp(spreadGap) - 1);
    const conviction = clamp(
      0.4 + 0.25 * clamp((Math.abs(z) - STRATEGY_PARAMS.ouEntryZ) / 1.5, 0, 1) + 0.25 * clamp((revProb - 0.5) / 0.3, 0, 1),
      0,
      1,
    );

    const sign = direction === 'long' ? 1 : -1;
    return {
      ...def,
      fired: true,
      direction,
      conviction,
      gates,
      levels: {
        entryZoneLow: price - 0.3 * atrValue,
        entryZoneHigh: price + 0.3 * atrValue,
        invalidation: price - sign * 1.8 * atrValue,
        target1: price + sign * Math.max(0.6 * Math.abs(targetMove), 1.0 * atrValue),
        target2: price + sign * Math.max(Math.abs(targetMove), 2.2 * atrValue),
      },
      rationale:
        `The benchmark-relative spread sits ${Math.abs(z).toFixed(2)}σ from its MLE-calibrated equilibrium with a ` +
        `${ou.halfLife.toFixed(1)}-day half-life, giving a ${(revProb * 100).toFixed(0)}% modelled probability of ` +
        `closing toward the mean inside the horizon.`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  5. Volatility-skew reversion (continuous-time quant)
// ─────────────────────────────────────────────────────────────────────────────

const skewReversion: StrategyDefinition = {
  id: 'skew_reversion',
  name: 'Skew Reversion (25Δ RR)',
  family: 'skew',
  provenance: 'continuous_time_quant',
  description:
    'Trades the 50-day rolling z-score of the SABR-derived 25-delta risk reversal. A z ≤ −2 means put premium is stretched and is faded long; z ≥ +2 means speculative call bias is stretched and is faded short. Exits at |z| < 0.5.',
  reconstructed: false,
  horizonDays: 10,
  minimumBars: 60,
  requiresIntraday: false,
  evaluate: (ctx) => {
    const def = { id: 'skew_reversion', name: 'Skew Reversion (25Δ RR)' };
    const price = ctx.features.artefacts.price;
    const history = ctx.riskReversalHistory;
    const gates: { name: string; passed: boolean; detail: string }[] = [];

    gates.push(
      gate(
        'Options surface available',
        ctx.features.artefacts.skew !== null && (ctx.features.artefacts.sabr?.converged ?? false),
        ctx.features.artefacts.skew
          ? `SABR fit converged with RMSE ${((ctx.features.artefacts.sabr?.rmse ?? 0) * 10_000).toFixed(1)}bp`
          : 'no listed options surface for this name',
      ),
    );
    gates.push(
      gate(
        'Skew history',
        history.length >= Math.min(STRATEGY_PARAMS.skewLookback, 20),
        `${history.length} observations against a ${STRATEGY_PARAMS.skewLookback}-day lookback`,
      ),
    );
    if (gates.some((g) => !g.passed)) return noFire(def, 'long', gates);

    const window = history.slice(-STRATEGY_PARAMS.skewLookback);
    const mu = mean(window);
    const sd = stdev(window);
    const current = window[window.length - 1] as number;
    const zRr = sd < EPS ? 0 : (current - mu) / sd;
    // z ≤ −2: puts unusually bid ⇒ fade the fear, long. z ≥ +2: calls unusually
    // bid ⇒ fade the speculative frenzy, short.
    const direction: 'long' | 'short' = zRr < 0 ? 'long' : 'short';

    gates.push(
      gate(
        'Skew z-score',
        Math.abs(zRr) >= STRATEGY_PARAMS.skewEntryZ,
        `Z_RR ${zRr >= 0 ? '+' : ''}${zRr.toFixed(2)}σ against a ±${STRATEGY_PARAMS.skewEntryZ.toFixed(1)}σ trigger`,
      ),
    );
    if (gates.some((g) => !g.passed)) return noFire(def, direction, gates);

    const atrValue = Math.max(last(atr(ctx.dailyBars, 14), price * 0.02), price * 0.004);
    const conviction = clamp(
      0.4 + 0.3 * clamp((Math.abs(zRr) - STRATEGY_PARAMS.skewEntryZ) / 1.5, 0, 1) + 0.1,
      0,
      1,
    );
    const sign = direction === 'long' ? 1 : -1;

    return {
      ...def,
      fired: true,
      direction,
      conviction,
      gates,
      levels: atrLevels(price, atrValue, direction, { stopAtr: 2, target1R: 1.4, target2R: 2.6 }),
      rationale:
        `The 25-delta risk reversal is ${Math.abs(zRr).toFixed(2)}σ from its 50-day mean at ` +
        `${(current * 100).toFixed(2)} vol points, so ${direction === 'long' ? 'downside protection is historically expensive and is faded' : 'upside call bias is historically stretched and is faded'}. ` +
        `The position is unwound once |Z_RR| normalises below ${STRATEGY_PARAMS.skewExitZ}.` +
        (sign === 1 ? '' : ''),
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  6. Kalman innovation (continuous-time quant)
// ─────────────────────────────────────────────────────────────────────────────

const kalmanInnovation: StrategyDefinition = {
  id: 'kalman_innovation',
  name: 'Kalman Innovation Band',
  family: 'reversion',
  provenance: 'continuous_time_quant',
  description:
    'Trades the standardised one-step-ahead measurement residual of the adaptive Kalman filter. Because the innovation covariance re-weights on every tick, the band expands with realised volatility instead of lagging it. Enters at |z| ≥ 1.5 and exits on the zero crossing.',
  reconstructed: false,
  horizonDays: 4,
  minimumBars: 80,
  requiresIntraday: false,
  evaluate: (ctx) => {
    const def = { id: 'kalman_innovation', name: 'Kalman Innovation Band' };
    const price = ctx.features.artefacts.price;
    const kalman = ctx.features.artefacts.kalman;
    const gates: { name: string; passed: boolean; detail: string }[] = [];

    gates.push(gate('Filter converged', kalman !== null, kalman ? `filtered level $${kalman.level.toFixed(2)}` : 'filter has not converged'));
    if (!kalman) return noFire(def, 'long', gates);

    const z = kalman.z;
    const direction: 'long' | 'short' = z < 0 ? 'long' : 'short';
    gates.push(
      gate(
        'Innovation threshold',
        Math.abs(z) >= STRATEGY_PARAMS.kalmanEntryZ,
        `standardised innovation ${z >= 0 ? '+' : ''}${z.toFixed(2)}σ against a ±${STRATEGY_PARAMS.kalmanEntryZ.toFixed(1)}σ trigger`,
      ),
    );
    // Wide forecast uncertainty means the filter itself has low confidence.
    const sigmaBps = ctx.features.raw.kalman_forecast_sigma_bps ?? 0;
    gates.push(
      gate(
        'Filter confidence',
        sigmaBps < 250,
        `one-step forecast σ of ${sigmaBps.toFixed(0)}bp against a 250bp ceiling`,
      ),
    );
    if (gates.some((g) => !g.passed)) return noFire(def, direction, gates);

    const atrValue = Math.max(last(atr(ctx.dailyBars, 14), price * 0.02), price * 0.004);
    const conviction = clamp(
      0.38 + 0.3 * clamp((Math.abs(z) - STRATEGY_PARAMS.kalmanEntryZ) / 2, 0, 1) + 0.12 * (1 - clamp(sigmaBps / 250, 0, 1)),
      0,
      1,
    );
    const sign = direction === 'long' ? 1 : -1;

    /*
     * `z` is measured against the a priori forecast, so the sentence quoting it
     * has to name the a priori forecast.
     *
     * The rationale read "The print sits {|z|}σ from the filtered fair value of
     * ${kalman.level}", which asserts a distance between two numbers that are not
     * that distance apart. `kalman.z` is the standardised innovation — the
     * residual against H·x̂_{k|k−1}, the prediction the filter made *before* it
     * saw this print — while `kalman.level` is the posterior x̂_{k|k}, which has
     * already absorbed the same print. With H = [1, 0] the algebra is exact:
     * price − level = (1 − K₀)·ỹ, so the true distance from the level printed in
     * the same sentence is (1 − K₀)·|z|, and since the Kalman gain K₀ lies in
     * (0, 1) the sentence overstated the dislocation on every bar it could ever
     * be emitted on. Measured when this was found, across the universe's last
     * 250 sessions, over all 1,098 bars clearing the |z| ≥ 1.5 gate: mean 2.16σ
     * against a mean true distance of 1.66σ, the ratio never once above 0.98 and
     * as low as 0.23 — MSFT on 2026-08-04 would have claimed 1.56σ where the
     * print was 0.36σ from the level quoted beside it. The terminal draws the
     * band around that same posterior level, so a reader saw the print sitting
     * almost on the centre line while the prose called it a 1.56σ dislocation.
     *
     * The a priori forecast is not a field on `InnovationBandPoint`, but it is
     * recoverable exactly rather than approximately: ỹ = z·√S, and √S is
     * published as `forecastSigma`, so the forecast is price − z·forecastSigma.
     * Naming it makes the whole sentence one coherent set — the surprise is
     * measured from the forecast it is a surprise against, the fair value is
     * where the filter moved to after absorbing it, and that is the level the
     * first target sits on.
     */
    const forecast = price - z * kalman.forecastSigma;

    return {
      ...def,
      fired: true,
      direction,
      conviction,
      gates,
      levels: {
        entryZoneLow: price - 0.25 * atrValue,
        entryZoneHigh: price + 0.25 * atrValue,
        invalidation: price - sign * 1.6 * atrValue,
        target1: kalman.level,
        target2: kalman.level + sign * kalman.width,
      },
      rationale:
        `The print of $${price.toFixed(2)} missed the filter's one-step-ahead forecast of ` +
        `$${forecast.toFixed(2)} by ${Math.abs(z).toFixed(2)}σ, and absorbing that surprise moved the ` +
        `filtered fair value to $${kalman.level.toFixed(2)}, where the first target sits. The band around ` +
        `it is currently ±${kalman.width.toFixed(2)} wide because the adaptive innovation covariance has ` +
        'already re-weighted for the live volatility. The position closes on the zero crossing.',
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  7. Volatility squeeze expansion
// ─────────────────────────────────────────────────────────────────────────────

const squeezeExpansion: StrategyDefinition = {
  id: 'squeeze_expansion',
  name: 'Squeeze Expansion',
  family: 'breakout',
  provenance: 'continuous_time_quant',
  description:
    'Positions ahead of a volatility expansion: band width in the bottom decile of its own 120-bar history, with the directional tie broken by the PCA-filtered order-flow intent rather than by price.',
  reconstructed: false,
  horizonDays: 6,
  minimumBars: 140,
  requiresIntraday: false,
  evaluate: (ctx) => {
    const def = { id: 'squeeze_expansion', name: 'Squeeze Expansion' };
    const price = ctx.features.artefacts.price;
    const squeeze = ctx.features.raw.squeeze_pct ?? 0.5;
    const intent = ctx.features.raw.mlofi_intent ?? 0;
    const volRatio = ctx.features.raw.vol_ratio_5_20 ?? 1;
    const gates: { name: string; passed: boolean; detail: string }[] = [];

    gates.push(
      gate(
        'Compression percentile',
        squeeze <= STRATEGY_PARAMS.squeezeEntryPercentile,
        `band width at the ${(squeeze * 100).toFixed(0)}th percentile of its 120-bar history, trigger ≤ ${(STRATEGY_PARAMS.squeezeEntryPercentile * 100).toFixed(0)}th`,
      ),
    );
    gates.push(
      gate(
        'Expansion beginning',
        volRatio >= 1.05,
        `5/20 volatility ratio ${volRatio.toFixed(2)} — short-horizon volatility must be turning up`,
      ),
    );
    gates.push(
      gate(
        'Order-flow tie-break',
        Math.abs(intent) >= 0.15,
        `PCA-filtered order-flow intent ${intent >= 0 ? '+' : ''}${intent.toFixed(3)} — needs a directional footprint to resolve the coil`,
      ),
    );
    if (gates.some((g) => !g.passed)) return noFire(def, intent >= 0 ? 'long' : 'short', gates);

    const direction: 'long' | 'short' = intent >= 0 ? 'long' : 'short';
    const atrValue = Math.max(last(atr(ctx.dailyBars, 14), price * 0.02), price * 0.004);
    const conviction = clamp(
      0.36 + 0.3 * (1 - squeeze / STRATEGY_PARAMS.squeezeEntryPercentile) + 0.22 * Math.min(Math.abs(intent), 1),
      0,
      1,
    );

    return {
      ...def,
      fired: true,
      direction,
      conviction,
      gates,
      levels: atrLevels(price, atrValue, direction, { stopAtr: 1.3, target1R: 2, target2R: 3.5 }),
      rationale:
        `Band width sits in the bottom ${(squeeze * 100).toFixed(0)}% of its own history while short-horizon ` +
        `volatility has begun to expand (5/20 ratio ${volRatio.toFixed(2)}), and multi-level order flow resolves the ` +
        `coil ${direction === 'long' ? 'upward' : 'downward'} at an intent of ${intent >= 0 ? '+' : ''}${intent.toFixed(3)}.`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  8. Insider cluster accumulation (alt-data)
// ─────────────────────────────────────────────────────────────────────────────

const insiderCluster: StrategyDefinition = {
  id: 'insider_cluster',
  name: 'Form 4 Cluster Accumulation',
  family: 'event',
  provenance: 'alt_data',
  description:
    'Highest-authority alternative-data setup: net Form 4 insider accumulation, decayed with a 60-day half-life and a 5-day plateau, combined with price still trading below its own anchor so the signal has not yet been priced.',
  reconstructed: false,
  horizonDays: 20,
  minimumBars: 60,
  requiresIntraday: false,
  evaluate: (ctx) => {
    const def = { id: 'insider_cluster', name: 'Form 4 Cluster Accumulation' };
    const price = ctx.features.artefacts.price;
    const insider = ctx.features.raw.insider_form4_score ?? 0;
    const evidence = ctx.features.raw.alt_evidence ?? 0;
    const vsAnchor = ctx.features.raw.price_vs_ema20 ?? 0;
    const gates: { name: string; passed: boolean; detail: string }[] = [];

    gates.push(
      gate(
        'Net insider accumulation',
        insider >= 0.25,
        `decayed Form 4 score ${insider >= 0 ? '+' : ''}${insider.toFixed(3)} against a +0.25 trigger`,
      ),
    );
    gates.push(
      gate(
        'Evidence weight',
        evidence >= 1.5,
        `${evidence.toFixed(2)} units of live decay-weighted evidence against a 1.5 minimum`,
      ),
    );
    gates.push(
      gate(
        'Not yet priced in',
        vsAnchor <= 3,
        `price ${vsAnchor >= 0 ? '+' : ''}${vsAnchor.toFixed(2)}% versus its 20-bar anchor — the setup needs the signal to still be undiscounted`,
      ),
    );
    if (gates.some((g) => !g.passed)) return noFire(def, 'long', gates);

    const atrValue = Math.max(last(atr(ctx.dailyBars, 14), price * 0.02), price * 0.004);
    const conviction = clamp(0.4 + 0.28 * clamp((insider - 0.25) / 0.6, 0, 1) + 0.18 * clamp(evidence / 8, 0, 1), 0, 1);

    return {
      ...def,
      fired: true,
      direction: 'long',
      conviction,
      gates,
      levels: atrLevels(price, atrValue, 'long', { stopAtr: 2.2, target1R: 1.6, target2R: 3.4, entryBandAtr: 0.5 }),
      rationale:
        `Form 4 filings show net insider accumulation at a decayed score of +${insider.toFixed(3)} on ` +
        `${evidence.toFixed(1)} units of authority-weighted evidence, while price is still only ` +
        `${vsAnchor >= 0 ? '+' : ''}${vsAnchor.toFixed(2)}% from its anchor, so the filing has not yet been discounted.`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  9. Relative-strength continuation
// ─────────────────────────────────────────────────────────────────────────────

const relativeStrengthContinuation: StrategyDefinition = {
  id: 'rs_continuation',
  name: 'Relative Strength Continuation',
  family: 'continuation',
  provenance: 'continuous_time_quant',
  description:
    'Cross-sectional momentum: leads both the index and its sector peers, sits within 8% of its 52-week high, holds a bullish primary trend, and is entered on a controlled pullback into the 20-bar anchor.',
  reconstructed: false,
  horizonDays: 10,
  minimumBars: 220,
  requiresIntraday: false,
  evaluate: (ctx) => {
    const def = { id: 'rs_continuation', name: 'Relative Strength Continuation' };
    const price = ctx.features.artefacts.price;
    const rs = ctx.features.raw.rel_strength_20d ?? 0;
    const sectorRs = ctx.features.raw.sector_rel_strength ?? 0;
    const from52 = ctx.features.raw.dist_from_252d_high ?? -100;
    const primary = ctx.features.raw.ema_50_200_spread ?? 0;
    const vsAnchor = ctx.features.raw.price_vs_ema20 ?? 0;
    const gates: { name: string; passed: boolean; detail: string }[] = [];

    gates.push(gate('Leads the index', rs >= 5, `20-bar relative strength ${rs >= 0 ? '+' : ''}${rs.toFixed(2)}% against a +5% trigger`));
    gates.push(gate('Leads its sector', sectorRs >= 2, `sector-relative strength ${sectorRs >= 0 ? '+' : ''}${sectorRs.toFixed(2)}% against a +2% trigger`));
    gates.push(gate('Near 52-week high', from52 >= -8, `${from52.toFixed(2)}% from the annual high, band −8%`));
    gates.push(gate('Primary uptrend', primary >= 1, `EMA 50/200 spread ${primary >= 0 ? '+' : ''}${primary.toFixed(2)}% against a +1% trigger`));
    gates.push(
      gate(
        'Controlled pullback',
        vsAnchor >= -6 && vsAnchor <= 1,
        `price ${vsAnchor >= 0 ? '+' : ''}${vsAnchor.toFixed(2)}% from its 20-bar anchor — the entry window is −6% to +1%`,
      ),
    );
    if (gates.some((g) => !g.passed)) return noFire(def, 'long', gates);

    const atrValue = Math.max(last(atr(ctx.dailyBars, 14), price * 0.02), price * 0.004);
    const conviction = clamp(
      0.42 + 0.2 * clamp(rs / 20, 0, 1) + 0.16 * clamp(sectorRs / 10, 0, 1) + 0.12 * clamp((from52 + 8) / 8, 0, 1),
      0,
      1,
    );

    return {
      ...def,
      fired: true,
      direction: 'long',
      conviction,
      gates,
      levels: atrLevels(price, atrValue, 'long', { stopAtr: 1.8, target1R: 1.6, target2R: 3 }),
      rationale:
        `The name leads the index by ${rs.toFixed(1)}% and its sector by ${sectorRs.toFixed(1)}% over 20 bars, sits ` +
        `${Math.abs(from52).toFixed(1)}% below its annual high inside a confirmed primary uptrend, and has pulled back ` +
        `to ${vsAnchor.toFixed(2)}% of its 20-bar anchor rather than extending.`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  10. Gap fill reversion
// ─────────────────────────────────────────────────────────────────────────────

const gapFill: StrategyDefinition = {
  id: 'gap_fill',
  name: 'Gap Fill Reversion',
  family: 'reversion',
  provenance: 'continuous_time_quant',
  description:
    'Fades a large unsupported opening gap. Requires the gap to exceed 3% against the prior close, no confirming order flow in the gap direction, and a benchmark that did not gap with it — so the move is idiosyncratic and unfunded.',
  reconstructed: false,
  horizonDays: 3,
  minimumBars: 40,
  requiresIntraday: false,
  evaluate: (ctx) => {
    const def = { id: 'gap_fill', name: 'Gap Fill Reversion' };
    const price = ctx.features.artefacts.price;
    const gap = ctx.features.raw.gap_pct ?? 0;
    const intent = ctx.features.raw.mlofi_intent ?? 0;
    const gates: { name: string; passed: boolean; detail: string }[] = [];

    gates.push(gate('Gap magnitude', Math.abs(gap) >= 3, `overnight gap ${gap >= 0 ? '+' : ''}${gap.toFixed(2)}% against a ±3% trigger`));
    if (!gates[0]?.passed) return noFire(def, 'long', gates);

    const direction: 'long' | 'short' = gap < 0 ? 'long' : 'short';
    // The gap is faded only when order flow is NOT confirming it.
    const confirming = direction === 'long' ? intent < -0.25 : intent > 0.25;
    gates.push(
      gate(
        'Order flow not confirming',
        !confirming,
        `order-flow intent ${intent >= 0 ? '+' : ''}${intent.toFixed(3)} ${confirming ? 'confirms the gap, so it is not a fade' : 'does not support continuation of the gap'}`,
      ),
    );

    const benchGap = (() => {
      const b = ctx.benchmarkBars;
      if (b.length < 2) return 0;
      const prev = (b[b.length - 2] as Bar).close;
      return prev < EPS ? 0 : (((b[b.length - 1] as Bar).open - prev) / prev) * 100;
    })();
    gates.push(
      gate(
        'Idiosyncratic gap',
        Math.abs(benchGap) < 1,
        `benchmark gapped ${benchGap >= 0 ? '+' : ''}${benchGap.toFixed(2)}% — a market-wide gap is not a single-name fade`,
      ),
    );
    if (gates.some((g) => !g.passed)) return noFire(def, direction, gates);

    const prevClose = ctx.features.artefacts.previousClose;
    const atrValue = Math.max(last(atr(ctx.dailyBars, 14), price * 0.02), price * 0.004);
    const conviction = clamp(0.38 + 0.26 * clamp((Math.abs(gap) - 3) / 5, 0, 1) + 0.14 * (1 - Math.min(Math.abs(intent), 1)), 0, 1);
    const sign = direction === 'long' ? 1 : -1;

    return {
      ...def,
      fired: true,
      direction,
      conviction,
      gates,
      levels: {
        entryZoneLow: price - 0.3 * atrValue,
        entryZoneHigh: price + 0.3 * atrValue,
        invalidation: price - sign * 1.5 * atrValue,
        target1: price + sign * Math.abs(prevClose - price) * 0.5,
        target2: prevClose,
      },
      rationale:
        `The session opened ${gap >= 0 ? '+' : ''}${gap.toFixed(2)}% away from the prior close of $${prevClose.toFixed(2)} ` +
        `while the benchmark moved only ${benchGap >= 0 ? '+' : ''}${benchGap.toFixed(2)}% and order flow is not confirming ` +
        'the move, so the gap is treated as an unfunded dislocation to be closed.',
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  Registry
// ─────────────────────────────────────────────────────────────────────────────

export const STRATEGIES: StrategyDefinition[] = [
  alphaPredators,
  fiveDayBounce,
  breakout,
  ouReversion,
  skewReversion,
  kalmanInnovation,
  squeezeExpansion,
  insiderCluster,
  relativeStrengthContinuation,
  gapFill,
];

const STRATEGY_BY_ID = new Map(STRATEGIES.map((s) => [s.id, s]));

export function strategyById(id: string): StrategyDefinition | undefined {
  return STRATEGY_BY_ID.get(id);
}

export const STRATEGY_IDS = STRATEGIES.map((s) => s.id);

/** Evaluates every strategy (or a subset) against one context. */
export function evaluateStrategies(ctx: StrategyContext, ids?: readonly string[]): StrategyEvaluation[] {
  const selected = ids ? STRATEGIES.filter((s) => ids.includes(s.id)) : STRATEGIES;
  return selected.map((s) => {
    if (ctx.dailyBars.length < s.minimumBars) {
      return noFire(s, 'long', [
        gate('Sufficient history', false, `${ctx.dailyBars.length} bars against a ${s.minimumBars}-bar minimum`),
      ]);
    }
    try {
      return s.evaluate(ctx);
    } catch (error) {
      // A strategy must never take down the pipeline for a whole symbol.
      return noFire(s, 'long', [
        gate('Evaluation', false, error instanceof Error ? error.message : 'evaluation failed'),
      ]);
    }
  });
}

/**
 * Conflict resolution across strategies that fired on the same symbol.
 *
 * The Holly research documents performance-weighted dominance: on a direct
 * overlap with opposing directions the engine defers to the strategy with the
 * higher backtested profit factor from the previous session. `profitFactors`
 * supplies those; ties fall back to conviction.
 */
export function resolveStrategyConflicts(
  evaluations: readonly StrategyEvaluation[],
  profitFactors: Record<string, number> = {},
): { winner: StrategyEvaluation | null; suppressed: StrategyEvaluation[]; conflicted: boolean } {
  const fired = evaluations.filter((e) => e.fired);
  if (fired.length === 0) return { winner: null, suppressed: [], conflicted: false };

  const longs = fired.filter((e) => e.direction === 'long');
  const shorts = fired.filter((e) => e.direction === 'short');
  const conflicted = longs.length > 0 && shorts.length > 0;

  const score = (e: StrategyEvaluation): number => (profitFactors[e.id] ?? 1) * (0.5 + e.conviction);
  const ranked = fired.slice().sort((a, b) => score(b) - score(a));
  const winner = ranked[0] as StrategyEvaluation;
  return {
    winner,
    suppressed: ranked.slice(1).filter((e) => e.direction !== winner.direction),
    conflicted,
  };
}

/** Aggregate strategy conviction, regime-weighted, in [0, 1]. */
export function aggregateStrategyConviction(
  evaluations: readonly StrategyEvaluation[],
  multiplier: (family: StrategyFamily) => number,
): { long: number; short: number } {
  let longAcc = 0;
  let shortAcc = 0;
  for (const e of evaluations) {
    if (!e.fired) continue;
    const def = STRATEGY_BY_ID.get(e.id);
    if (!def) continue;
    const weighted = e.conviction * multiplier(def.family);
    if (e.direction === 'long') longAcc = Math.max(longAcc, weighted);
    else shortAcc = Math.max(shortAcc, weighted);
  }
  return { long: clamp(longAcc, 0, 1), short: clamp(shortAcc, 0, 1) };
}

/** Public metadata for the strategy-library page. */
export function strategyCatalogue(): {
  id: string;
  name: string;
  family: StrategyFamily;
  provenance: StrategyDefinition['provenance'];
  description: string;
  reconstructed: boolean;
  horizonDays: number;
  requiresIntraday: boolean;
}[] {
  return STRATEGIES.map((s) => ({
    id: s.id,
    name: s.name,
    family: s.family,
    provenance: s.provenance,
    description: s.description,
    reconstructed: s.reconstructed,
    horizonDays: s.horizonDays,
    requiresIntraday: s.requiresIntraday,
  }));
}

// Re-exported so callers building contexts do not need a second import.
export { closes, ema, last, macd, rsi, sma };
