/**
 * Feature and backtest statistics that described something other than what they
 * measured.
 *
 * Each case here is a published number whose label, state bands or documented
 * guarantee disagreed with the arithmetic underneath it. Grouped by the claim
 * each one restores:
 *
 *   1. VPIN measures order-flow toxicity, not the coarseness of its own buckets;
 *   2. the regime score's three declared states are all reachable, and evidence
 *      of stationarity can argue for reversion rather than merely fall silent;
 *   3. `FeatureValue.normalised` is a placeholder off the universe sweep, and
 *      the module says so;
 *   4. "Payoff" is the ratio of averages the rest of the backtest page prints;
 *   5. the Sortino/Sharpe relationship the module asserted is not a theorem, and
 *      the bound that *is* true holds where the old one breaks.
 *
 * Everything is synthetic and in-process: no data directory, no market provider,
 * no trained ensemble. The fixtures are seeded through `createRng`, so a failure
 * here is reproducible from the seed string in the message.
 */

import { describe, expect, it } from 'vitest';
import {
  type ComputeInput,
  applyCrossSectionalNormalisation,
  computeFeatures,
} from '@/lib/engine/compute';
import { DEFAULT_BACKTEST_CONFIG, computeMetrics } from '@/lib/engine/backtest';
import { requireFeature, resolveState } from '@/lib/engine/features';
import { TOXIC_FLOW_THRESHOLD } from '@/lib/engine/router';
import { vpin } from '@/lib/quant/orderflow';
import { mean } from '@/lib/quant/stats';
import { createRng } from '@/lib/quant/rng';
import type { Bar } from '@/lib/quant/indicators';
import type {
  BacktestConfig,
  BacktestTrade,
  EquityPoint,
  SymbolMeta,
} from '@/lib/domain/types';

const DAY = 24 * 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const T0 = Date.UTC(2024, 0, 2, 14, 30);

const META: SymbolMeta = {
  symbol: 'TEST',
  name: 'Test Instrument',
  sector: 'Technology',
  industry: 'Software',
  marketCap: 1e11,
  adv30: 5e6,
  sharesOutstanding: 1e9,
  exchange: 'NASDAQ',
  isBenchmark: false,
  referenceBeta: 1,
  dividendYield: 0,
  optionable: false,
};

/** Bars from a close series, each opening at the previous close. */
function barsFrom(closes: readonly number[], stepMs: number, volumes?: readonly number[]): Bar[] {
  return closes.map((close, i) => {
    const open = i > 0 ? (closes[i - 1] as number) : close;
    return {
      time: T0 + i * stepMs,
      open,
      high: Math.max(close, open) * 1.001,
      low: Math.min(close, open) * 0.999,
      close,
      volume: volumes?.[i] ?? 1_000_000,
    };
  });
}

/**
 * A `ComputeInput` with no book, no option chain and no alt-data — the blocks
 * under test read only the bar series, and leaving the rest empty keeps a
 * failure attributable to the series that produced it.
 */
function input(daily: readonly number[], benchmark: readonly number[], intraday: Bar[] = []): ComputeInput {
  return {
    symbol: 'TEST',
    meta: META,
    dailyBars: barsFrom(daily, DAY),
    intradayBars: intraday,
    benchmarkBars: barsFrom(benchmark, DAY),
    sectorCloses: [...benchmark],
    books: [],
    chains: [],
    altEvents: [],
    now: T0 + daily.length * DAY,
    horizonDays: 5,
  };
}

const FLAT_BENCHMARK = Array.from({ length: 300 }, () => 100);

/** A seeded daily random walk — the neutral series the other two vary from. */
function randomWalk(seed: string, sd = 0.012): number[] {
  const rng = createRng(seed);
  const out: number[] = [];
  let logPrice = 0;
  for (let i = 0; i < 300; i += 1) {
    logPrice += rng.normal() * sd;
    out.push(100 * Math.exp(logPrice));
  }
  return out;
}

/** Strongly mean-reverting: an AR(1) in log price with a pull of 0.75 per day. */
function meanRevertingSeries(seed: string): number[] {
  const rng = createRng(seed);
  const out: number[] = [];
  let logPrice = 0;
  for (let i = 0; i < 300; i += 1) {
    logPrice = 0.25 * logPrice + rng.normal() * 0.02;
    out.push(100 * Math.exp(logPrice));
  }
  return out;
}

/** Strongly trending: a drift five times the daily noise. */
function trendingSeries(seed: string): number[] {
  const rng = createRng(seed);
  const out: number[] = [];
  let logPrice = 0;
  for (let i = 0; i < 300; i += 1) {
    logPrice += 0.004 + rng.normal() * 0.004;
    out.push(100 * Math.exp(logPrice));
  }
  return out;
}

/**
 * A session of five-minute bars with a controllable tape:
 *
 *   • `balanced`    — direction is a fair coin, magnitude uniform. No information.
 *   • `oneSided`    — every bar up. The toxic case.
 *   • `alternating` — up, down, up, down. Perfectly two-sided.
 */
function session(kind: 'balanced' | 'oneSided' | 'alternating', seed: string): Bar[] {
  const rng = createRng(seed);
  const closes: number[] = [];
  const volumes: number[] = [];
  let price = 100;
  for (let i = 0; i < 78; i += 1) {
    const step =
      kind === 'balanced'
        ? (rng.next() < 0.5 ? -1 : 1) * 0.05 * (0.5 + rng.next())
        : kind === 'oneSided'
          ? 0.05 * (0.5 + rng.next())
          : (i % 2 === 0 ? 1 : -1) * 0.05;
    price += step;
    closes.push(price);
    volumes.push(100_000 * Math.exp(0.4 * rng.normal()));
  }
  return barsFrom(closes, FIVE_MINUTES, volumes);
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. VPIN measures toxicity, not bucket coarseness
// ─────────────────────────────────────────────────────────────────────────────

describe('vpin is a statement about the tape, not about the bucket size', () => {
  const definition = requireFeature('vpin');
  const daily = randomWalk('vpin:daily', 0.01);

  it('does not call balanced coin-flip flow toxic', () => {
    for (const seed of ['v1', 'v2', 'v3', 'v4']) {
      const tape = session('balanced', `balanced:${seed}`);
      const value = computeFeatures(input(daily, FLAT_BENCHMARK, tape)).raw.vpin as number;
      expect(resolveState(definition, value).state, `seed ${seed}: vpin ${value}`).not.toBe(
        'STATE_TOXIC_FLOW',
      );
      // The band edge is 0.30 and balanced flow's own null sits at 0.206.
      expect(value, `seed ${seed}`).toBeLessThan(0.3);
    }
  });

  it('is the bucket sizing and the classification that used to floor it', () => {
    /*
     * The same balanced tape through the call this module used to make: the tick
     * rule, so every bar is 100% buy or 100% sell, in buckets of three times mean
     * bar volume. Three coin-flip bars split 3-0 or 2-1, so the bucket imbalance
     * is 1 or ⅓ and never anything else. That is the whole defect — the number
     * below is a property of the arithmetic, not of the flow.
     */
    for (const seed of ['v1', 'v2', 'v3', 'v4']) {
      const window = session('balanced', `balanced:${seed}`).slice(-60);
      const tickRule = window.map((bar, i, arr) => {
        const previous = i > 0 ? (arr[i - 1] as Bar).close : bar.open;
        return { volume: bar.volume, signedVolume: (bar.close >= previous ? 1 : -1) * bar.volume };
      });
      const legacy = vpin(tickRule, Math.max(1, mean(tickRule.map((t) => t.volume)) * 3), 20);
      expect(legacy, `seed ${seed}: legacy shape on information-free flow`).toBeGreaterThan(0.4);
      expect(resolveState(definition, legacy).state).toBe('STATE_TOXIC_FLOW');
    }
  });

  it('reaches every state it publishes, including the router abort', () => {
    const observed = new Set<string>();
    for (const seed of ['v1', 'v2', 'v3']) {
      for (const kind of ['balanced', 'oneSided', 'alternating'] as const) {
        const value = computeFeatures(input(daily, FLAT_BENCHMARK, session(kind, `${kind}:${seed}`)))
          .raw.vpin as number;
        observed.add(resolveState(definition, value).state);
        if (kind === 'oneSided') {
          // `ABORT_TOXIC_FLOW` is the only gate in the router that reads this
          // feature, and nothing the old estimator could produce ever tripped it.
          expect(value, `seed ${seed}: one-sided tape vs the abort threshold`).toBeGreaterThan(
            TOXIC_FLOW_THRESHOLD,
          );
        }
        if (kind === 'alternating') {
          expect(resolveState(definition, value).state, `seed ${seed}`).toBe('STATE_BENIGN_FLOW');
        }
      }
    }
    expect([...observed].sort()).toEqual([
      'STATE_BENIGN_FLOW',
      'STATE_NORMAL_FLOW',
      'STATE_TOXIC_FLOW',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. The regime score's evidence is two-sided
// ─────────────────────────────────────────────────────────────────────────────

/** The expression that shipped, for comparison on identical inputs. */
function legacyRegimeScore(hurst: number, adf: number, adx: number): number {
  return Math.tanh(2 * (hurst - 0.5) + adx / 60 + Math.max(0, adf + 2) / 3);
}

describe('regime_trend_score can argue for reversion', () => {
  const definition = requireFeature('regime_trend_score');

  it('lets stationarity subtract, where the old expression could only fail to add', () => {
    /*
     * The symbol is a random walk and the benchmark tracks it with a
     * mean-reverting error, so the log spread the ADF test runs on rejects the
     * unit root outright while Hurst and ADX say little. Stationarity is the only
     * significant evidence present, and it points one way.
     */
    const rows = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'].map((seed) => {
      const symbol = randomWalk(`regime:${seed}`);
      const rng = createRng(`regime-bench:${seed}`);
      let error = 0;
      const benchmark = symbol.map((close) => {
        error = 0.2 * error + rng.normal() * 0.01;
        return close * Math.exp(-error);
      });
      const raw = computeFeatures(input(symbol, benchmark)).raw;
      const score = raw.regime_trend_score as number;
      return {
        seed,
        adf: raw.adf_stat_120 as number,
        score,
        legacy: legacyRegimeScore(raw.hurst_100 as number, raw.adf_stat_120 as number, raw.adx_14 as number),
      };
    });

    for (const row of rows) {
      expect(row.adf, `seed ${row.seed}: fixture must actually reject the unit root`).toBeLessThan(
        -2.86,
      );
      // `max(0, adf + 2)/3` clipped at zero and `adx/60` was non-negative, so on a
      // spread this stationary the old sum had nothing that could pull it down.
      expect(
        row.legacy,
        `seed ${row.seed}: the shipped expression on the same hurst/adf/adx`,
      ).toBeGreaterThan(0);
      expect(row.score, `seed ${row.seed}: legacy ${row.legacy}`).toBeLessThan(row.legacy - 0.5);
    }

    const reverting = (score: number): boolean =>
      resolveState(definition, score).state === 'STATE_REVERSION_REGIME';
    expect(rows.filter((r) => reverting(r.score)).length).toBeGreaterThanOrEqual(6);
    expect(rows.filter((r) => reverting(r.legacy))).toHaveLength(0);
  });

  it('reaches all three of the states it publishes', () => {
    const observed = new Set<string>();
    for (const seed of ['a', 'b', 'c', 'd']) {
      for (const [label, series] of [
        ['reverting', meanRevertingSeries(`mr:${seed}`)],
        ['trending', trendingSeries(`tr:${seed}`)],
        ['random walk', randomWalk(`rw:${seed}`)],
      ] as [string, number[]][]) {
        const score = computeFeatures(input(series, FLAT_BENCHMARK)).raw
          .regime_trend_score as number;
        expect(Number.isFinite(score), `${label} ${seed}`).toBe(true);
        observed.add(resolveState(definition, score).state);
      }
    }
    expect([...observed].sort()).toEqual([
      'STATE_MIXED_REGIME',
      'STATE_REVERSION_REGIME',
      'STATE_TREND_REGIME',
    ]);
  });

  it('scores a market with no regime at zero rather than at a trend', () => {
    /*
     * Every term is centred on the value it takes under a null: Hurst 0.5, ADX
     * 25, and a Dickey–Fuller τ of −1.51 rather than 0. A series that is a random
     * walk against a flat benchmark therefore has to land near the middle of the
     * range and not, as the old expression did for every name in the universe,
     * hard against the top of it.
     */
    const scores = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map(
      (seed) => computeFeatures(input(randomWalk(`null:${seed}`), FLAT_BENCHMARK)).raw
        .regime_trend_score as number,
    );
    expect(Math.abs(mean(scores)), `scores ${scores.map((s) => s.toFixed(3)).join(', ')}`)
      .toBeLessThan(0.35);
    expect(Math.min(...scores)).toBeLessThan(0.25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. `normalised` is a placeholder until the universe sweep runs
// ─────────────────────────────────────────────────────────────────────────────

describe('FeatureValue.normalised', () => {
  it('is the 0.5 placeholder on a single-symbol computation', () => {
    const computed = computeFeatures(input(randomWalk('norm:one'), FLAT_BENCHMARK));
    expect(computed.values.length).toBeGreaterThan(0);
    expect(new Set(computed.values.map((f) => f.normalised))).toEqual(new Set([0.5]));
  });

  it('is only filled in by the cross-sectional pass', () => {
    const universe = ['u1', 'u2', 'u3', 'u4', 'u5'].map((seed) =>
      computeFeatures(input(randomWalk(`norm:${seed}`), FLAT_BENCHMARK)),
    );
    applyCrossSectionalNormalisation(universe);
    const rsi = universe.map(
      (c) => (c.values.find((f) => f.key === 'rsi_14') as { normalised: number }).normalised,
    );
    for (const v of rsi) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
    // Five distinct series cannot all share one rank.
    expect(new Set(rsi).size).toBeGreaterThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. "Payoff" is the ratio of averages
// ─────────────────────────────────────────────────────────────────────────────

function trade(netPnl: number, i: number): BacktestTrade {
  return {
    symbol: 'TEST',
    strategy: 'test',
    direction: 'long',
    entryTime: T0 + i * DAY,
    entryPrice: 100,
    exitTime: T0 + (i + 1) * DAY,
    exitPrice: 100 + netPnl / 100,
    quantity: 100,
    grossPnl: netPnl,
    commission: 0,
    slippage: 0,
    netPnl,
    returnPercent: netPnl / 10_000,
    barsHeld: 1,
    exitReason: 'signal',
    convictionAtEntry: 0.5,
    maxFavourableExcursion: Math.max(netPnl, 0),
    maxAdverseExcursion: Math.min(netPnl, 0),
  };
}

function backtestConfig(): BacktestConfig {
  return {
    ...DEFAULT_BACKTEST_CONFIG,
    symbols: ['TEST'],
    startTime: T0,
    endTime: T0 + 400 * DAY,
  };
}

/** A seeded equity curve, optionally drifting. */
function equityCurve(bars: number, drift: number, seed: string): EquityPoint[] {
  const equityRng = createRng(`${seed}:equity`);
  const benchRng = createRng(`${seed}:benchmark`);
  const out: EquityPoint[] = [];
  let equity = 100_000;
  let benchmark = 100_000;
  let peak = equity;
  for (let i = 0; i < bars; i += 1) {
    equity *= 1 + drift + equityRng.normal() * 0.01;
    benchmark *= 1 + benchRng.normal() * 0.008;
    peak = Math.max(peak, equity);
    out.push({
      time: T0 + i * DAY,
      equity,
      drawdown: peak <= 0 ? 0 : equity / peak - 1,
      benchmark,
      exposure: 1,
    });
  }
  return out;
}

const EXTRA = { exposure: 0.5, turnover: 1.2, strategiesTried: 5 };

describe('payoffRatio', () => {
  it('is averageWin / averageLoss, not best trade / worst trade', () => {
    // One outlier win and one outlier loss, so the two definitions cannot
    // coincide by accident.
    const pnls = [3000, 600, 500, 400, -800, -700, -600, -500];
    const trades = pnls.map(trade);
    const metrics = computeMetrics(trades, equityCurve(300, 0, 'payoff'), backtestConfig(), EXTRA);

    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p <= 0);
    const expected = mean(wins) / Math.abs(mean(losses));
    const bestOverWorst = Math.max(...wins) / Math.abs(Math.min(...losses));

    expect(metrics.payoffRatio).toBeCloseTo(expected, 12);
    expect(metrics.payoffRatio).toBeCloseTo(metrics.averageWin / metrics.averageLoss, 12);
    // 1.73 against 3.75 on this fixture. One outlying win is all it takes, which
    // is why the page's tile disagreed with its own average-win/average-loss panel.
    expect(bestOverWorst - metrics.payoffRatio).toBeGreaterThan(1);
  });

  it('is the same b the Kelly fraction is derived from', () => {
    const trades = [2500, 1200, 900, -400, -450, -700].map(trade);
    const metrics = computeMetrics(trades, equityCurve(300, 0, 'kelly'), backtestConfig(), EXTRA);
    const expectedKelly = Math.max(
      0,
      Math.min(1, metrics.winRate - (1 - metrics.winRate) / metrics.payoffRatio),
    );
    expect(metrics.kellyFraction).toBeCloseTo(expectedKelly, 12);
  });

  it('is zero rather than a division artefact when a side is empty', () => {
    const noLosses = computeMetrics(
      [1000, 500].map(trade),
      equityCurve(300, 0, 'no-losses'),
      backtestConfig(),
      EXTRA,
    );
    const noWins = computeMetrics(
      [-1000, -500].map(trade),
      equityCurve(300, 0, 'no-wins'),
      backtestConfig(),
      EXTRA,
    );
    expect(noLosses.payoffRatio).toBe(0);
    expect(noWins.payoffRatio).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  5. The Sortino/Sharpe bound that is actually true
// ─────────────────────────────────────────────────────────────────────────────

describe('downside deviation against volatility', () => {
  /*
   * The module used to state that a downside deviation above the volatility was
   * "arithmetically impossible" and that |Sortino| < |Sharpe| was "the reverse of
   * the relationship the two ratios must have". Neither is true of the
   * semideviation it computes: that measures dispersion about a MAR of zero while
   * volatility measures it about the sample mean, so
   *
   *     downsideDeviation² = volatility² + 252·meanDaily² − 252·E[max(0, r)²]
   *
   * and the only bound available is `≤ volatility² + 252·meanDaily²`. The old
   * assertion held on the shipped fixtures — which drift by at most 0.2%/day —
   * and nowhere else, which is the worst property a regression test can have.
   */
  const TRADING_DAYS_PER_YEAR = 252;
  const DRIFT_RATIOS = [0, 0.2, 0.4, 0.6, 1, 2, 4];

  it('satisfies the bound the semideviation actually obeys, at any drift', () => {
    for (const seed of ['a', 'e', 'z']) {
      for (const sign of [-1, 1]) {
        for (const ratio of DRIFT_RATIOS) {
          const m = computeMetrics(
            [],
            equityCurve(252, sign * ratio * 0.01, seed),
            backtestConfig(),
            EXTRA,
          );
          // 252·meanDaily², rewritten through sharpe = 252·meanDaily / volatility.
          const meanSquareTerm = (m.sharpe * m.volatility) ** 2 / TRADING_DAYS_PER_YEAR;
          expect(
            m.downsideDeviation,
            `seed ${seed} drift ${sign * ratio}: dd ${m.downsideDeviation}, vol ${m.volatility}`,
          ).toBeLessThanOrEqual(Math.sqrt(m.volatility ** 2 + meanSquareTerm) + 1e-9);
        }
      }
    }
  });

  it('does exceed the volatility under strong drift, so the naive bound is not a theorem', () => {
    const violations = ['a', 'e', 'z'].flatMap((seed) =>
      [0.6, 1, 2].filter((ratio) => {
        const m = computeMetrics([], equityCurve(252, -ratio * 0.01, seed), backtestConfig(), EXTRA);
        return m.downsideDeviation > m.volatility && Math.abs(m.sortino) < Math.abs(m.sharpe);
      }),
    );
    expect(
      violations.length,
      'a curve losing money on most days has to be able to break dd ≤ vol',
    ).toBeGreaterThan(0);
  });
});
