/**
 * Regime classification.
 *
 * Phase 1 §4 turns on this distinction: continuation setups earn their edge in
 * trending regimes and bleed in mean-reverting ones, and vice versa. Static
 * indicator thresholds cannot tell the difference, so the classifier fuses three
 * orthogonal statistical tests — persistence (Hurst), stationarity (ADF) and
 * directional strength (ADX) — with a volatility and liquidity overlay.
 */

import type { RegimeLabel, RegimeState } from '@/lib/domain/types';
import { clamp } from '@/lib/quant/stats';

export interface RegimeInput {
  /** Rescaled-range Hurst exponent of returns; 0.5 = random walk. */
  hurst: number;
  /** ADF τ statistic of the benchmark-relative spread; more negative = stationary. */
  adf: number;
  /** Wilder ADX. */
  adx: number;
  /** +DI − −DI, for the sign of the trend. */
  diSpread: number;
  /** Annualised realised volatility as a decimal (0.24 = 24%). */
  realisedVol: number;
  /** Where that volatility sits in its own 252-bar history, [0, 1]. */
  volPercentile: number;
  /** Composite executability score, [0, 1]. */
  liquidityScore: number;
  /** EMA 50/200 spread in percent, for the primary trend direction. */
  primaryTrend: number;
}

/** ADF 5% critical value for the no-drift specification. */
export const ADF_CRITICAL_5PCT = -2.86;
/** ADX level above which a trend is considered confirmed. */
export const ADX_TREND_THRESHOLD = 25;
/** Volatility percentile above which the stress overlay takes over. */
export const STRESS_VOL_PERCENTILE = 0.85;
/** Liquidity score below which the name is classified illiquid regardless. */
export const ILLIQUID_THRESHOLD = 0.3;

export const REGIME_LABELS: Record<RegimeLabel, { label: string; description: string; favours: string }> = {
  trending_bull: {
    label: 'Trending — bull',
    description: 'Persistent series with confirmed directional strength to the upside.',
    favours: 'Continuation and pullback entries; reversion entries historically bleed here.',
  },
  trending_bear: {
    label: 'Trending — bear',
    description: 'Persistent series with confirmed directional strength to the downside.',
    favours: 'Short continuation; long reversion attempts have their lowest base rates here.',
  },
  mean_reverting: {
    label: 'Mean reverting',
    description: 'Anti-persistent, statistically stationary series with no directional trend.',
    favours: 'Ornstein–Uhlenbeck reversion entries at the band extremes.',
  },
  high_volatility: {
    label: 'High volatility',
    description: 'Volatility in the top decile of its own annual range; correlations converging.',
    favours: 'Reduced exposure. Both trend and reversion edges degrade as noise dominates.',
  },
  low_volatility_drift: {
    label: 'Low-volatility drift',
    description: 'Compressed volatility with weak but positive drift; a coiled state.',
    favours: 'Squeeze and expansion setups positioned ahead of the volatility break.',
  },
  illiquid: {
    label: 'Illiquid',
    description: 'Spread, depth and turnover too poor for the modelled edge to survive costs.',
    favours: 'Nothing. Transaction costs consume the expected value.',
  },
};

/**
 * Classifies the regime and returns a confidence derived from how far the
 * evidence sits from each decision boundary — a signal generated in a
 * low-confidence regime is discounted downstream rather than trusted blindly.
 */
export function classifyRegime(input: RegimeInput): RegimeState {
  const {
    hurst,
    adf,
    adx,
    diSpread,
    realisedVol,
    volPercentile,
    liquidityScore,
    primaryTrend,
  } = input;

  // Continuous evidence in [0, 1] for each hypothesis.
  const persistence = clamp((hurst - 0.5) / 0.15, -1, 1); // +1 trending, −1 anti-persistent
  const stationarity = clamp((ADF_CRITICAL_5PCT - adf) / 1.5, -1, 1); // +1 stationary
  const strength = clamp((adx - ADX_TREND_THRESHOLD) / 15, -1, 1); // +1 strong trend
  const trendScore = 0.4 * persistence + 0.6 * strength;
  const reversionScore = 0.45 * -persistence + 0.55 * stationarity;

  let label: RegimeLabel;
  let confidence: number;

  if (liquidityScore < ILLIQUID_THRESHOLD) {
    label = 'illiquid';
    confidence = clamp((ILLIQUID_THRESHOLD - liquidityScore) / ILLIQUID_THRESHOLD, 0.35, 0.98);
  } else if (volPercentile >= STRESS_VOL_PERCENTILE) {
    // Stress overrides the trend/reversion question: at this volatility neither
    // edge survives, which is itself the actionable conclusion.
    label = 'high_volatility';
    confidence = clamp((volPercentile - STRESS_VOL_PERCENTILE) / (1 - STRESS_VOL_PERCENTILE), 0.4, 0.98);
  } else if (trendScore > 0.2 && trendScore >= reversionScore) {
    const up = diSpread > 0 || (Math.abs(diSpread) < 2 && primaryTrend > 0);
    label = up ? 'trending_bull' : 'trending_bear';
    confidence = clamp(0.5 + trendScore / 2, 0.4, 0.97);
  } else if (reversionScore > 0.2) {
    label = 'mean_reverting';
    confidence = clamp(0.5 + reversionScore / 2, 0.4, 0.97);
  } else if (volPercentile < 0.3) {
    label = 'low_volatility_drift';
    confidence = clamp(0.5 + (0.3 - volPercentile), 0.4, 0.9);
  } else {
    // Neither hypothesis clears its threshold. Report the closer one at low
    // confidence rather than fabricating certainty.
    label = trendScore >= reversionScore ? (diSpread > 0 ? 'trending_bull' : 'trending_bear') : 'mean_reverting';
    confidence = 0.35;
  }

  return {
    label,
    confidence,
    hurst,
    adf,
    realisedVol,
    volPercentile,
    trendStrength: clamp((adx - 10) / 40, 0, 1),
    liquidityScore,
    description: REGIME_LABELS[label].description,
  };
}

/**
 * Regime-conditional multiplier applied to a strategy's conviction.
 *
 * This is the mechanism Phase 1 §4.3 argues for: rather than optimising
 * parameters overnight and hoping the regime holds, the engine keeps the
 * parameters fixed and re-weights each strategy family by the *live* regime.
 */
export function regimeMultiplier(label: RegimeLabel, family: StrategyFamily): number {
  const table: Record<RegimeLabel, Record<StrategyFamily, number>> = {
    trending_bull: { continuation: 1.25, reversion: 0.6, breakout: 1.15, skew: 0.95, event: 1.0 },
    trending_bear: { continuation: 1.1, reversion: 0.55, breakout: 0.85, skew: 1.05, event: 0.95 },
    mean_reverting: { continuation: 0.6, reversion: 1.3, breakout: 0.7, skew: 1.1, event: 1.0 },
    high_volatility: { continuation: 0.55, reversion: 0.7, breakout: 0.6, skew: 1.15, event: 0.8 },
    low_volatility_drift: { continuation: 1.05, reversion: 0.9, breakout: 1.3, skew: 0.9, event: 1.0 },
    illiquid: { continuation: 0.3, reversion: 0.3, breakout: 0.3, skew: 0.4, event: 0.5 },
  };
  return table[label][family];
}

export type StrategyFamily = 'continuation' | 'reversion' | 'breakout' | 'skew' | 'event';
