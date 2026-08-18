/**
 * Walk-forward backtest engine.
 *
 * The Holly research is blunt that a nightly "Quantitative Combine" optimising
 * millions of parameter permutations against recent history is a curve-fitting
 * exercise: "an algorithm that survives the Combine with a stellar 2.5 Profit
 * Factor on a Tuesday may suffer catastrophic drawdowns on Wednesday when the
 * market transitions from a low-volatility trending regime to a high-volatility
 * mean-reverting regime."
 *
 * This engine therefore does the opposite of a parameter sweep. Parameters are
 * fixed (they are the documented ones), and what is measured is *out-of-sample
 * degradation*: every fold reports its in-sample and out-of-sample Sharpe and the
 * efficiency ratio between them. It also reports the four Combine survival
 * thresholds so a strategy can be judged against the legacy engine's own bar:
 *
 *   Win rate      > 60%
 *   Profit factor ≥ 2.0
 *   Sharpe        > 1.2
 *   Max drawdown  ≤ 15%
 *
 * The OddsMaker constraint — at most one entry per symbol per day — is honoured,
 * because comparing against Holly's numbers under a different entry policy would
 * be meaningless.
 */

import type {
  BacktestConfig,
  BacktestMetrics,
  BacktestResult,
  BacktestTrade,
  EquityPoint,
  WalkForwardFold,
} from '@/lib/domain/types';
import type { Bar } from '@/lib/quant/indicators';
import { atr, closes, last } from '@/lib/quant/indicators';
import { EPS, clamp, mean, quantile, stdev, sum } from '@/lib/quant/stats';
import { normCdf } from '@/lib/quant/stats';
import { isoDate, tradingDayCount } from '@/lib/market/calendar';
import {
  STRATEGY_IDS,
  type StrategyContext,
  type StrategyEvaluation,
  evaluateStrategies,
  strategyById,
} from './strategies';
import { classifyRegime, regimeMultiplier } from './regime';
import type { ComputedFeatures } from './compute';

/** Combine survival thresholds, verbatim from the Holly deconstruction. */
export const COMBINE_THRESHOLDS = {
  winRate: 0.6,
  profitFactor: 2.0,
  sharpe: 1.2,
  maxDrawdown: 0.15,
} as const;

/** OddsMaker's hardcoded single-entry-per-symbol-per-day parameter. */
export const MAX_ENTRIES_PER_SYMBOL_PER_DAY = 1;

const TRADING_DAYS_PER_YEAR = 252;

/**
 * The profit factor of a strategy that won every trade it took.
 *
 * Gross loss is zero, so the ratio is genuinely infinite, and `Infinity` does not
 * survive `JSON.stringify` — it becomes `null`, and the previous code turned it
 * into `0` instead, which reads as "no edge" for a perfect record and failed the
 * scorecard's "≥ 2.0" row. A large finite sentinel keeps the ordering correct
 * everywhere the figure is compared or sorted, and the UI renders it as "∞".
 */
export const PROFIT_FACTOR_NO_LOSSES = 999;

export interface BacktestBarSlice {
  symbol: string;
  /** Ascending daily bars for the whole test window. */
  bars: Bar[];
  /** Benchmark bars, index-aligned. */
  benchmarkBars: Bar[];
  /** Pre-computed features per bar index (sparse: null where not sampled). */
  features: (ComputedFeatures | null)[];
  /** Rolling 25Δ risk-reversal history aligned to bar index. */
  riskReversalHistory: number[];
  /** 30-day ADV. */
  adv30: number;
}

export interface BacktestInput {
  config: BacktestConfig;
  slices: BacktestBarSlice[];
  /** Benchmark series for the alpha/beta and tracking-error metrics. */
  benchmarkBars: Bar[];
}

interface OpenPosition {
  symbol: string;
  strategy: string;
  direction: 'long' | 'short';
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  quantity: number;
  stop: number;
  target1: number;
  target2: number;
  conviction: number;
  maxFavourable: number;
  maxAdverse: number;
}

export function runBacktest(input: BacktestInput): BacktestResult {
  const { config, slices } = input;
  const warnings: string[] = [];
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];

  if (slices.length === 0) {
    return emptyResult(config, ['No symbols supplied to the backtest.']);
  }

  const barCount = Math.min(...slices.map((s) => s.bars.length));
  if (barCount < 40) {
    return emptyResult(config, [`Insufficient history: only ${barCount} aligned bars.`]);
  }

  // A daily-bar backtest cannot evaluate a 5-minute pullback entry or a
  // session-volume gate. Those strategies are excluded and named, rather than
  // being fed daily proxies that would manufacture false evidence.
  const requestedStrategies = config.strategies.length > 0 ? config.strategies : STRATEGY_IDS;
  const intradayOnly = requestedStrategies.filter((id) => strategyById(id)?.requiresIntraday === true);
  const evaluableStrategies = requestedStrategies.filter((id) => strategyById(id)?.requiresIntraday !== true);
  if (intradayOnly.length > 0) {
    warnings.push(
      // Agreement follows the list, which is currently one strategy long.
      `${intradayOnly.length === 1 ? 'Excluded from this daily-bar backtest because its entry rules require' : 'Excluded from this daily-bar backtest because their entry rules require'} intraday bars: ${intradayOnly
        .map((id) => strategyById(id)?.name ?? id)
        .join(', ')}. ${intradayOnly.length === 1 ? 'It is' : 'They are'} evaluated live, not here.`,
    );
  }
  if (evaluableStrategies.length === 0) {
    return emptyResult(config, [
      ...warnings,
      'Every requested strategy requires intraday data, so there is nothing this backtest can evaluate.',
    ]);
  }

  const benchmarkCloses = closes(input.benchmarkBars.slice(-barCount));
  const atrBySymbol = new Map(slices.map((s) => [s.symbol, atr(s.bars, 14)]));

  let cash = config.initialCapital;
  let equity = config.initialCapital;
  let peakEquity = equity;
  const open: OpenPosition[] = [];
  const entriesToday = new Map<string, number>();
  let currentDay = '';
  let exposureBars = 0;
  let totalTurnover = 0;

  for (let i = 0; i < barCount; i += 1) {
    const time = (slices[0] as BacktestBarSlice).bars[i]?.time ?? 0;
    const day = isoDate(time);
    if (day !== currentDay) {
      currentDay = day;
      entriesToday.clear();
    }

    // ── Mark to market and manage open positions ─────────────────────────
    let markToMarket = 0;
    for (let p = open.length - 1; p >= 0; p -= 1) {
      const pos = open[p] as OpenPosition;
      const slice = slices.find((s) => s.symbol === pos.symbol);
      const bar = slice?.bars[i];
      if (!slice || !bar) continue;

      const sign = pos.direction === 'long' ? 1 : -1;
      const favourable = sign > 0 ? bar.high : bar.low;
      const adverse = sign > 0 ? bar.low : bar.high;
      pos.maxFavourable = Math.max(pos.maxFavourable, sign * ((favourable - pos.entryPrice) / pos.entryPrice));
      pos.maxAdverse = Math.min(pos.maxAdverse, sign * ((adverse - pos.entryPrice) / pos.entryPrice));

      // Stop is checked before target: within a single bar the pessimistic
      // ordering is the honest one, since intrabar sequence is unknown.
      let exitPrice: number | null = null;
      let exitReason: BacktestTrade['exitReason'] | null = null;
      if (sign > 0 ? bar.low <= pos.stop : bar.high >= pos.stop) {
        exitPrice = pos.stop;
        exitReason = 'stop';
      } else if (sign > 0 ? bar.high >= pos.target1 : bar.low <= pos.target1) {
        exitPrice = pos.target1;
        exitReason = 'target';
      } else if (i - pos.entryIndex >= horizonOf(pos.strategy)) {
        exitPrice = bar.close;
        exitReason = 'time';
      } else if (i === barCount - 1) {
        exitPrice = bar.close;
        exitReason = 'end_of_data';
      }

      if (exitPrice !== null && exitReason !== null) {
        const slippage = (exitPrice * config.slippageBps) / 10_000;
        const fill = exitPrice - sign * slippage;
        const gross = sign * (fill - pos.entryPrice) * pos.quantity;
        const commission = config.commissionPerShare * pos.quantity;
        const net = gross - commission;
        // Return the entry notional to cash and book the trade's net result.
        // A short's proceeds and its buy-back net out to the same arithmetic, so
        // both directions close the same way — there used to be a direction term
        // here multiplied by zero, which read as an unfinished short-side rule
        // rather than as the no-op it was.
        cash += net + pos.entryPrice * pos.quantity;
        totalTurnover += fill * pos.quantity;
        trades.push({
          symbol: pos.symbol,
          strategy: pos.strategy,
          direction: pos.direction,
          entryTime: pos.entryTime,
          entryPrice: pos.entryPrice,
          exitTime: bar.time,
          exitPrice: fill,
          quantity: pos.quantity,
          grossPnl: gross,
          commission,
          slippage: slippage * pos.quantity,
          netPnl: net,
          returnPercent: (net / (pos.entryPrice * pos.quantity)) * 100,
          barsHeld: i - pos.entryIndex,
          exitReason,
          convictionAtEntry: pos.conviction,
          maxFavourableExcursion: pos.maxFavourable * 100,
          maxAdverseExcursion: pos.maxAdverse * 100,
        });
        open.splice(p, 1);
      } else {
        markToMarket += sign * (bar.close - pos.entryPrice) * pos.quantity + pos.entryPrice * pos.quantity;
      }
    }

    equity = cash + markToMarket;
    if (open.length > 0) exposureBars += 1;

    // ── Look for new entries ─────────────────────────────────────────────
    if (open.length < config.maxConcurrentPositions) {
      for (const slice of slices) {
        if (open.length >= config.maxConcurrentPositions) break;
        if ((entriesToday.get(slice.symbol) ?? 0) >= MAX_ENTRIES_PER_SYMBOL_PER_DAY) continue;
        if (open.some((p) => p.symbol === slice.symbol)) continue;

        const features = slice.features[i];
        if (!features) continue;
        const bar = slice.bars[i];
        if (!bar) continue;

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

        const ctx: StrategyContext = {
          symbol: slice.symbol,
          dailyBars: slice.bars.slice(0, i + 1),
          intradayBars: [],
          hourlyBars: [],
          benchmarkBars: slice.benchmarkBars.slice(0, i + 1),
          benchmarkIntradayBars: [],
          features,
          adv30: slice.adv30,
          riskReversalHistory: slice.riskReversalHistory.slice(0, i + 1),
          now: bar.time,
        };

        const evaluations = evaluateStrategies(ctx, evaluableStrategies);
        const candidate = pickCandidate(evaluations);
        if (!candidate) continue;

        const conviction = candidate.conviction * regimeMultiplier(regime.label, familyOf(candidate.id)) * 100;
        if (conviction < config.minConviction) continue;
        const levels = candidate.levels;
        if (!levels) continue;

        // Fixed-fractional risk sizing on the *backtest's own* capital. This is
        // a simulation parameter, never a user-facing suggestion.
        const atrValue = Math.max(last(atrBySymbol.get(slice.symbol) ?? [], bar.close * 0.02), bar.close * 0.004);
        const riskPerShare = Math.max(Math.abs(bar.close - levels.invalidation), atrValue * 0.5);
        const riskBudget = equity * config.riskPerTrade;
        const quantity = Math.max(1, Math.floor(riskBudget / Math.max(riskPerShare, EPS)));
        const notional = quantity * bar.close;
        if (notional > equity * 0.5) continue; // never let one position dominate
        if (notional > cash && candidate.direction === 'long') continue;

        const slippage = (bar.close * config.slippageBps) / 10_000;
        const sign = candidate.direction === 'long' ? 1 : -1;
        const entryPrice = bar.close + sign * slippage;

        cash -= entryPrice * quantity;
        totalTurnover += entryPrice * quantity;
        entriesToday.set(slice.symbol, (entriesToday.get(slice.symbol) ?? 0) + 1);
        open.push({
          symbol: slice.symbol,
          strategy: candidate.id,
          direction: candidate.direction,
          entryIndex: i,
          entryTime: bar.time,
          entryPrice,
          quantity,
          stop: levels.invalidation,
          target1: levels.target1,
          target2: levels.target2,
          conviction,
          maxFavourable: 0,
          maxAdverse: 0,
        });
      }
    }

    peakEquity = Math.max(peakEquity, equity);
    const benchmarkStart = benchmarkCloses[0] ?? 1;
    equityCurve.push({
      time,
      equity,
      drawdown: peakEquity <= 0 ? 0 : (equity - peakEquity) / peakEquity,
      benchmark: config.initialCapital * ((benchmarkCloses[i] ?? benchmarkStart) / benchmarkStart),
      exposure: open.length / Math.max(1, config.maxConcurrentPositions),
    });
  }

  if (trades.length === 0) warnings.push('No trades were generated under the supplied filters.');

  const metrics = computeMetrics(trades, equityCurve, config, {
    exposure: barCount === 0 ? 0 : exposureBars / barCount,
    turnover: config.initialCapital <= 0 ? 0 : totalTurnover / config.initialCapital,
    strategiesTried: Math.max(1, evaluableStrategies.length),
  });

  return {
    id: `bt_${config.startTime.toString(36)}_${config.endTime.toString(36)}_${config.strategies.join('-').slice(0, 40)}`,
    createdAt: Date.now(),
    config,
    metrics,
    trades,
    equityCurve,
    byStrategy: summariseByStrategy(trades),
    monthlyReturns: monthlyReturns(equityCurve),
    folds: walkForwardFolds(equityCurve, trades, config),
    warnings,
  };
}

/**
 * The highest-conviction strategy that actually fired.
 *
 * The regime is deliberately not a tie-break here. It enters the backtest once,
 * through `regimeMultiplier`, which scales the conviction each strategy reports
 * *before* this comparison — so applying it again would count the same
 * adjustment twice. The parameter used to be taken and discarded with a `void`,
 * which left the reader to work that out.
 */
function pickCandidate(evaluations: readonly StrategyEvaluation[]): StrategyEvaluation | null {
  const fired = evaluations.filter((e) => e.fired && e.levels !== null);
  if (fired.length === 0) return null;
  return fired.reduce((best, e) => (e.conviction > best.conviction ? e : best));
}

function familyOf(strategyId: string): Parameters<typeof regimeMultiplier>[1] {
  return strategyById(strategyId)?.family ?? 'continuation';
}

function horizonOf(strategyId: string): number {
  return strategyById(strategyId)?.horizonDays ?? 5;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Metrics
// ─────────────────────────────────────────────────────────────────────────────

export function computeMetrics(
  trades: readonly BacktestTrade[],
  equityCurve: readonly EquityPoint[],
  config: BacktestConfig,
  extra: { exposure: number; turnover: number; strategiesTried: number },
): BacktestMetrics {
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const grossWin = sum(wins.map((t) => t.netPnl));
  const grossLoss = Math.abs(sum(losses.map((t) => t.netPnl)));

  /*
   * Every rate statistic is computed over the traded window, not over the whole
   * curve.
   *
   * The curve is emitted from the first bar the engine has data for, which on
   * the seeded fixture is a year before `config.startTime`. Those 260 leading
   * bars are flat by construction — 259 of the 260 daily returns are exactly
   * zero — but the benchmark moves through them, so the published
   * benchmarkReturn was +9.80% for a period in which the strategy held nothing.
   * Against the benchmark measured over the window the strategy actually traded
   * (−5.06%) the sign of relative performance reverses: the page reported a
   * strategy losing to its benchmark when it beat it.
   *
   * The flat prefix also drags volatility, Sharpe, alpha and beta towards zero
   * by padding the sample with non-observations.
   */
  const tradedFrom = equityCurve.findIndex((p) => p.time >= config.startTime);
  const traded: readonly EquityPoint[] = tradedFrom <= 0 ? equityCurve : equityCurve.slice(tradedFrom);

  const equity = equityCurve.map((p) => p.equity);
  const dailyReturns: number[] = [];
  for (let i = 1; i < traded.length; i += 1) {
    const prev = (traded[i - 1] as EquityPoint).equity;
    dailyReturns.push(prev <= 0 ? 0 : ((traded[i] as EquityPoint).equity - prev) / prev);
  }
  const benchmarkReturns: number[] = [];
  for (let i = 1; i < traded.length; i += 1) {
    const prev = (traded[i - 1] as EquityPoint).benchmark;
    benchmarkReturns.push(prev <= 0 ? 0 : ((traded[i] as EquityPoint).benchmark - prev) / prev);
  }

  const totalReturn =
    config.initialCapital <= 0 ? 0 : ((last(equity, config.initialCapital) - config.initialCapital) / config.initialCapital);
  const years = Math.max(tradingDayCount(config.startTime, config.endTime) / TRADING_DAYS_PER_YEAR, 1 / TRADING_DAYS_PER_YEAR);
  const cagr = totalReturn <= -1 ? -1 : Math.pow(1 + totalReturn, 1 / years) - 1;

  const volatility = stdev(dailyReturns) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  const meanDaily = mean(dailyReturns);
  const sharpe = volatility < EPS ? 0 : (meanDaily * TRADING_DAYS_PER_YEAR) / volatility;

  /*
   * Downside deviation is the semideviation over the FULL sample, not the mean
   * over the losing days alone.
   *
   * Averaging only the negatives divides a subset's sum by that subset's count,
   * which turns a partial-moment into an average loss and inflates it by roughly
   * sqrt(n/k). Measured on the seeded fixture: 42 negative days out of 753 gave a
   * downside deviation of 0.1151 against a volatility of 0.0384 — three times the
   * standard deviation of the same series, which is arithmetically impossible for
   * a quantity restricted to a subset of it. Because Sortino divides by it, the
   * page then reported |Sortino| 0.103 < |Sharpe| 0.308, the reverse of the
   * relationship the two ratios must have.
   */
  const downsideSquares = dailyReturns.map((r) => Math.min(0, r) ** 2);
  const downsideDeviation = Math.sqrt(mean(downsideSquares)) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  const sortino = downsideDeviation < EPS ? 0 : (meanDaily * TRADING_DAYS_PER_YEAR) / downsideDeviation;

  const drawdowns = equityCurve.map((p) => p.drawdown);
  const maxDrawdown = Math.abs(Math.min(0, ...drawdowns));
  const calmar = maxDrawdown < EPS ? 0 : cagr / maxDrawdown;
  /*
   * Over the traded window, for the same reason the return series is.
   *
   * The Ulcer Index is a root-mean-square, so unlike `maxDrawdown` it is diluted
   * rather than unmoved by the flat warm-up prefix: 260 padding bars at zero
   * drawdown pull the RMS down by roughly the square root of the padding's share
   * of the series, which flatters the number in exact proportion to how much
   * history the run happened to load.
   */
  const tradedDrawdowns = traded.map((p) => p.drawdown);
  const ulcerIndex = Math.sqrt(mean(tradedDrawdowns.map((d) => d * d * 10_000)));

  let maxDrawdownDurationDays = 0;
  let currentDuration = 0;
  for (const d of drawdowns) {
    if (d < -1e-9) {
      currentDuration += 1;
      maxDrawdownDurationDays = Math.max(maxDrawdownDurationDays, currentDuration);
    } else {
      currentDuration = 0;
    }
  }

  const var95 = dailyReturns.length > 4 ? quantile(dailyReturns, 0.05) : 0;
  const tail = dailyReturns.filter((r) => r <= var95);
  const cvar95 = tail.length > 0 ? mean(tail) : var95;

  const winRate = trades.length === 0 ? 0 : wins.length / trades.length;
  const averageWin = wins.length === 0 ? 0 : grossWin / wins.length;
  const averageLoss = losses.length === 0 ? 0 : grossLoss / losses.length;
  const expectancy = trades.length === 0 ? 0 : winRate * averageWin - (1 - winRate) * averageLoss;
  /*
   * `Infinity` when there were wins and no losses, and it stays Infinity.
   *
   * The serialisation below used to collapse a non-finite value to 0, so a
   * strategy that had never lost a trade published a profit factor of zero and
   * failed the "≥ 2.0" scorecard row — the worst possible reading of the best
   * possible record. `PROFIT_FACTOR_NO_LOSSES` is carried instead, which is a
   * number JSON can hold and every consumer can recognise.
   */
  const profitFactor = grossLoss < EPS ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLoss;
  const payoffRatio =
    losses.length === 0 || wins.length === 0
      ? 0
      : Math.max(...wins.map((t) => t.netPnl)) / Math.abs(Math.min(...losses.map((t) => t.netPnl)));

  // Kelly fraction implied by the realised win rate and payoff ratio. Reported
  // as a statistic of the *backtest*, never applied to a user account.
  const b = averageLoss < EPS ? 0 : averageWin / averageLoss;
  const kellyFraction = b <= 0 ? 0 : clamp(winRate - (1 - winRate) / b, 0, 1);

  const streaks = computeStreaks(trades);

  // Benchmark-relative.
  const benchmarkOpen = (traded[0] as EquityPoint | undefined)?.benchmark ?? config.initialCapital;
  const benchmarkReturn =
    traded.length === 0 || benchmarkOpen <= 0
      ? 0
      : (last(traded.map((p) => p.benchmark), benchmarkOpen) - benchmarkOpen) / benchmarkOpen;
  const { alpha, beta } = regress(dailyReturns, benchmarkReturns);
  const activeReturns = dailyReturns.map((r, i) => r - (benchmarkReturns[i] ?? 0));
  const trackingError = stdev(activeReturns) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  const informationRatio =
    trackingError < EPS ? 0 : (mean(activeReturns) * TRADING_DAYS_PER_YEAR) / trackingError;

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    profitFactor: Number.isFinite(profitFactor) ? profitFactor : PROFIT_FACTOR_NO_LOSSES,
    expectancy,
    averageWin,
    averageLoss,
    payoffRatio,
    totalReturn,
    cagr,
    sharpe,
    sortino,
    calmar,
    maxDrawdown,
    maxDrawdownDurationDays,
    volatility,
    downsideDeviation,
    var95,
    cvar95,
    ulcerIndex,
    kellyFraction,
    averageBarsHeld: trades.length === 0 ? 0 : mean(trades.map((t) => t.barsHeld)),
    exposure: extra.exposure,
    bestTrade: trades.length === 0 ? 0 : Math.max(...trades.map((t) => t.netPnl)),
    worstTrade: trades.length === 0 ? 0 : Math.min(...trades.map((t) => t.netPnl)),
    longestWinStreak: streaks.win,
    longestLossStreak: streaks.loss,
    deflatedSharpe: deflatedSharpe(sharpe, dailyReturns, extra.strategiesTried),
    probabilisticSharpe: probabilisticSharpe(sharpe, dailyReturns),
    turnover: extra.turnover,
    benchmarkReturn,
    alpha: alpha * TRADING_DAYS_PER_YEAR,
    beta,
    informationRatio,
    trackingError,
  };
}

function computeStreaks(trades: readonly BacktestTrade[]): { win: number; loss: number } {
  let win = 0;
  let loss = 0;
  let currentWin = 0;
  let currentLoss = 0;
  for (const t of trades) {
    if (t.netPnl > 0) {
      currentWin += 1;
      currentLoss = 0;
    } else {
      currentLoss += 1;
      currentWin = 0;
    }
    win = Math.max(win, currentWin);
    loss = Math.max(loss, currentLoss);
  }
  return { win, loss };
}

function regress(y: readonly number[], x: readonly number[]): { alpha: number; beta: number } {
  const n = Math.min(y.length, x.length);
  if (n < 3) return { alpha: 0, beta: 0 };
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (x[i] as number) - mx;
    sxy += dx * ((y[i] as number) - my);
    sxx += dx * dx;
  }
  const beta = sxx < EPS ? 0 : sxy / sxx;
  return { alpha: my - beta * mx, beta };
}

/**
 * Probabilistic Sharpe Ratio (Bailey & López de Prado): the probability that the
 * true Sharpe exceeds zero, correcting for skew, kurtosis and sample length.
 */
export function probabilisticSharpe(sharpe: number, returns: readonly number[], benchmarkSharpe = 0): number {
  const n = returns.length;
  if (n < 8) return 0.5;
  const m = mean(returns);
  const s = stdev(returns);
  if (s < EPS) return 0.5;
  let skew = 0;
  let kurt = 0;
  for (const r of returns) {
    skew += ((r - m) / s) ** 3;
    kurt += ((r - m) / s) ** 4;
  }
  skew /= n;
  kurt /= n;
  const dailySharpe = sharpe / Math.sqrt(TRADING_DAYS_PER_YEAR);
  const denominator = Math.sqrt(Math.max(1 - skew * dailySharpe + ((kurt - 1) / 4) * dailySharpe * dailySharpe, EPS));
  const z = ((dailySharpe - benchmarkSharpe / Math.sqrt(TRADING_DAYS_PER_YEAR)) * Math.sqrt(n - 1)) / denominator;
  return clamp(normCdf(z), 0, 1);
}

/**
 * Deflated Sharpe Ratio: the PSR against a benchmark Sharpe raised to account
 * for the number of independent strategy configurations tried. This is the
 * direct antidote to the Combine's selection bias.
 */
export function deflatedSharpe(sharpe: number, returns: readonly number[], trials: number): number {
  if (returns.length < 8 || trials <= 1) return probabilisticSharpe(sharpe, returns);
  const gamma = 0.5772156649015329; // Euler–Mascheroni
  const varianceOfSharpe = stdev(returns) < EPS ? 0 : 1 / Math.sqrt(Math.max(returns.length - 1, 1));
  const expectedMax =
    varianceOfSharpe *
    ((1 - gamma) * inverseNormal(1 - 1 / trials) + gamma * inverseNormal(1 - 1 / (trials * Math.E)));
  return probabilisticSharpe(sharpe, returns, expectedMax * Math.sqrt(TRADING_DAYS_PER_YEAR));
}

function inverseNormal(p: number): number {
  // Small helper so this module does not need the full normInv import path.
  const clamped = clamp(p, 1e-9, 1 - 1e-9);
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (normCdf(mid) < clamped) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function summariseByStrategy(trades: readonly BacktestTrade[]): BacktestResult['byStrategy'] {
  const groups = new Map<string, BacktestTrade[]>();
  for (const t of trades) {
    const list = groups.get(t.strategy) ?? [];
    list.push(t);
    groups.set(t.strategy, list);
  }
  return Array.from(groups.entries())
    .map(([strategy, list]) => {
      const wins = list.filter((t) => t.netPnl > 0).length;
      const returns = list.map((t) => t.returnPercent / 100);
      const s = stdev(returns);
      return {
        strategy,
        trades: list.length,
        netPnl: sum(list.map((t) => t.netPnl)),
        winRate: list.length === 0 ? 0 : wins / list.length,
        sharpe: s < EPS ? 0 : (mean(returns) / s) * Math.sqrt(TRADING_DAYS_PER_YEAR / Math.max(mean(list.map((t) => t.barsHeld)), 1)),
      };
    })
    .sort((a, b) => b.netPnl - a.netPnl);
}

/**
 * Month-by-month returns, chained so that they compound to the total.
 *
 * A month's base is the *previous* month's close, not its own first point. Using
 * the first point inside the month silently discarded the move from the prior
 * close to it — the overnight or over-weekend gap between the last session of
 * one month and the first of the next — so the series did not compound to
 * `totalReturn` and every gap in the run went unreported. An equity of 100 on
 * 31 January, 110 on 1 February and 120 on 28 February published February as
 * +9.1% when the month actually returned +20%.
 *
 * The first month has no predecessor, so it is measured from its own opening
 * point, which is the only base that exists.
 */
function monthlyReturns(equityCurve: readonly EquityPoint[]): BacktestResult['monthlyReturns'] {
  if (equityCurve.length === 0) return [];
  const buckets = new Map<string, { start: number; end: number; year: number; month: number }>();
  const order: string[] = [];
  let previousClose: number | null = null;
  for (const p of equityCurve) {
    const d = new Date(p.time);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.end = p.equity;
    } else {
      buckets.set(key, {
        start: previousClose ?? p.equity,
        end: p.equity,
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
      });
      order.push(key);
    }
    previousClose = p.equity;
  }
  return order
    .map((key) => buckets.get(key) as { start: number; end: number; year: number; month: number })
    .map((b) => ({ year: b.year, month: b.month, ret: b.start <= 0 ? 0 : (b.end - b.start) / b.start }))
    .sort((a, b) => a.year - b.year || a.month - b.month);
}

/**
 * Walk-forward folds. Each fold reports the in-sample Sharpe of the training
 * window, the out-of-sample Sharpe of the following test window, and the
 * efficiency ratio — the single number that reveals curve-fitting.
 */
export function walkForwardFolds(
  equityCurve: readonly EquityPoint[],
  trades: readonly BacktestTrade[],
  config: BacktestConfig,
): WalkForwardFold[] {
  if (!config.walkForward.enabled) return [];
  const trainBars = config.walkForward.trainBars;
  const testBars = config.walkForward.testBars;
  if (trainBars < 20 || testBars < 5 || equityCurve.length < trainBars + testBars) return [];

  const folds: WalkForwardFold[] = [];
  let index = 0;
  let start = 0;
  while (start + trainBars + testBars <= equityCurve.length) {
    const trainSlice = equityCurve.slice(start, start + trainBars);
    const testSlice = equityCurve.slice(start + trainBars, start + trainBars + testBars);
    const inSampleSharpe = sharpeOfCurve(trainSlice);
    const outOfSampleSharpe = sharpeOfCurve(testSlice);
    const testStart = (testSlice[0] as EquityPoint).time;
    const testEnd = (testSlice[testSlice.length - 1] as EquityPoint).time;
    const foldTrades = trades.filter((t) => t.entryTime >= testStart && t.entryTime <= testEnd);
    const firstEquity = (testSlice[0] as EquityPoint).equity;
    const lastEquity = (testSlice[testSlice.length - 1] as EquityPoint).equity;

    folds.push({
      index,
      trainStart: (trainSlice[0] as EquityPoint).time,
      trainEnd: (trainSlice[trainSlice.length - 1] as EquityPoint).time,
      testStart,
      testEnd,
      inSampleSharpe,
      outOfSampleSharpe,
      outOfSampleReturn: firstEquity <= 0 ? 0 : (lastEquity - firstEquity) / firstEquity,
      trades: foldTrades.length,
      efficiency: Math.abs(inSampleSharpe) < EPS ? 0 : outOfSampleSharpe / inSampleSharpe,
    });
    index += 1;
    start += testBars;
  }
  return folds;
}

function sharpeOfCurve(curve: readonly EquityPoint[]): number {
  const returns: number[] = [];
  for (let i = 1; i < curve.length; i += 1) {
    const prev = (curve[i - 1] as EquityPoint).equity;
    returns.push(prev <= 0 ? 0 : ((curve[i] as EquityPoint).equity - prev) / prev);
  }
  const s = stdev(returns);
  return s < EPS ? 0 : (mean(returns) * TRADING_DAYS_PER_YEAR) / (s * Math.sqrt(TRADING_DAYS_PER_YEAR));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Combine survival scorecard
// ─────────────────────────────────────────────────────────────────────────────

export interface CombineScorecardRow {
  metric: string;
  observed: number;
  threshold: number;
  comparator: '>' | '>=' | '<=';
  passed: boolean;
  rationale: string;
}

export interface CombineScorecard {
  rows: CombineScorecardRow[];
  survived: boolean;
  /** Out-of-sample degradation across folds — what the Combine never measured. */
  meanEfficiency: number;
  note: string;
}

/**
 * Scores a result against the four Combine survival thresholds, and adds the
 * out-of-sample efficiency the legacy process omitted. A strategy can clear all
 * four thresholds in-sample and still fail here, which is exactly the point.
 */
export function combineScorecard(result: BacktestResult): CombineScorecard {
  const m = result.metrics;
  const rows: CombineScorecardRow[] = [
    {
      metric: 'Win rate',
      observed: m.winRate,
      threshold: COMBINE_THRESHOLDS.winRate,
      comparator: '>',
      passed: m.winRate > COMBINE_THRESHOLDS.winRate,
      rationale:
        'The strategy must yield a profitable outcome, net of simulated slippage and commissions, in over sixty percent of all simulated occurrences.',
    },
    {
      metric: 'Profit factor',
      observed: m.profitFactor,
      threshold: COMBINE_THRESHOLDS.profitFactor,
      comparator: '>=',
      passed: m.profitFactor >= COMBINE_THRESHOLDS.profitFactor,
      rationale:
        'A factor of 2.0 ensures the average dollar value of winning trades significantly outpaces the losers, providing a buffer against unforeseen market-impact costs.',
    },
    {
      metric: 'Sharpe ratio',
      observed: m.sharpe,
      threshold: COMBINE_THRESHOLDS.sharpe,
      comparator: '>',
      passed: m.sharpe > COMBINE_THRESHOLDS.sharpe,
      rationale:
        'Excess return per unit of volatility above 1.2, which penalises algorithms that rely on wild equity swings.',
    },
    {
      metric: 'Maximum drawdown',
      observed: m.maxDrawdown,
      threshold: COMBINE_THRESHOLDS.maxDrawdown,
      comparator: '<=',
      passed: m.maxDrawdown <= COMBINE_THRESHOLDS.maxDrawdown,
      rationale:
        'Deepest peak-to-trough loss; algorithms breaching 15% on historical data are discarded from the live roster.',
    },
  ];
  const meanEfficiency = result.folds.length === 0 ? 0 : mean(result.folds.map((f) => f.efficiency));
  return {
    rows,
    survived: rows.every((r) => r.passed),
    meanEfficiency,
    note:
      result.folds.length === 0
        ? 'Walk-forward analysis was disabled, so out-of-sample degradation is unmeasured. A scorecard without it is an in-sample result.'
        : `Mean out-of-sample Sharpe efficiency across ${result.folds.length} folds is ${meanEfficiency.toFixed(2)}. Values well below 1.0 indicate the in-sample result does not survive out of sample.`,
  };
}

function emptyResult(config: BacktestConfig, warnings: string[]): BacktestResult {
  return {
    id: `bt_empty_${config.startTime.toString(36)}`,
    createdAt: Date.now(),
    config,
    metrics: computeMetrics([], [], config, { exposure: 0, turnover: 0, strategiesTried: 1 }),
    trades: [],
    equityCurve: [],
    byStrategy: [],
    monthlyReturns: [],
    folds: [],
    warnings,
  };
}

export const DEFAULT_BACKTEST_CONFIG: Omit<BacktestConfig, 'symbols' | 'startTime' | 'endTime'> = {
  strategies: ['ou_reversion', 'rs_continuation', 'squeeze_expansion', 'five_day_bounce', 'gap_fill'],
  timeframe: '1d',
  initialCapital: 100_000,
  riskPerTrade: 0.01,
  maxConcurrentPositions: 6,
  commissionPerShare: 0.005,
  slippageBps: 4,
  minConviction: 35,
  walkForward: { enabled: true, trainBars: 120, testBars: 40 },
  benchmarkSymbol: 'SPY',
};
