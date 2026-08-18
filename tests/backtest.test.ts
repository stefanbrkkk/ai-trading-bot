/**
 * Invariants the published backtest statistics have to satisfy.
 *
 * These exist because two of them did not, on the figures shipped to the page.
 *
 *   • Downside deviation was computed as the root mean square of the *losing*
 *     days only — a subset's sum over that subset's count. On the seeded fixture
 *     that gave 0.1151 against a volatility of 0.0384: three times the standard
 *     deviation of the very series it is a restriction of, which cannot happen.
 *     Sortino divides by it, so the page reported |Sortino| 0.103 < |Sharpe|
 *     0.308 — the reverse of the relationship the two ratios must have.
 *   • The benchmark's return was measured over the whole equity curve, and the
 *     curve begins a year before the strategy trades. 260 leading bars are flat
 *     by construction while the benchmark moves through them, so the published
 *     +9.80% described a period in which the strategy held nothing, and the sign
 *     of relative performance came out backwards.
 *
 * Neither needed market data to catch. Both are properties of the arithmetic.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKTEST_CONFIG, computeMetrics } from '@/lib/engine/backtest';
import { createRng } from '@/lib/quant/rng';
import type { BacktestConfig, EquityPoint } from '@/lib/domain/types';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2024, 0, 2);

function config(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    ...DEFAULT_BACKTEST_CONFIG,
    symbols: ['AAPL'],
    startTime: START,
    endTime: START + 400 * DAY,
    ...overrides,
  };
}

/**
 * A curve with a controllable shape: `leadingFlatBars` of untraded prefix, then
 * a seeded random walk for the strategy and a separate one for the benchmark.
 */
function curve(options: {
  bars: number;
  leadingFlatBars?: number;
  drift?: number;
  benchmarkDrift?: number;
  seed?: string;
}): EquityPoint[] {
  const { bars, leadingFlatBars = 0, drift = 0, benchmarkDrift = 0 } = options;
  /*
   * Two independent streams. Sharing one would make the traded series depend on
   * how many prefix bars the benchmark drew through, so "the same traded series
   * with and without a prefix" — the thing the last test compares — would not be
   * the same series at all.
   */
  const equityRng = createRng(`${options.seed ?? 'backtest-invariants'}:equity`);
  const benchRng = createRng(`${options.seed ?? 'backtest-invariants'}:benchmark`);
  const out: EquityPoint[] = [];
  let equity = 100_000;
  let benchmark = 100_000;
  let peak = equity;
  for (let i = 0; i < bars; i += 1) {
    if (i >= leadingFlatBars) {
      equity *= 1 + drift + equityRng.normal() * 0.01;
    }
    benchmark *= 1 + benchmarkDrift + benchRng.normal() * 0.008;
    peak = Math.max(peak, equity);
    out.push({
      // The prefix sits strictly before `config.startTime`.
      time: START + (i - leadingFlatBars) * DAY,
      equity,
      drawdown: peak <= 0 ? 0 : equity / peak - 1,
      benchmark,
      exposure: i >= leadingFlatBars ? 1 : 0,
    });
  }
  return out;
}

const extra = { exposure: 0.5, turnover: 1.2, strategiesTried: 5 };

describe('backtest metric invariants', () => {
  it('never reports a downside deviation above the volatility', () => {
    // Twelve seeded shapes, including ones with very few losing days — the
    // regime where averaging over the subset alone diverges most.
    for (const seed of ['a', 'b', 'c', 'd']) {
      for (const drift of [-0.002, 0, 0.004]) {
        const m = computeMetrics([], curve({ bars: 300, drift, seed }), config(), extra);
        expect(
          m.downsideDeviation,
          `seed ${seed} drift ${drift}: downside ${m.downsideDeviation} > vol ${m.volatility}`,
        ).toBeLessThanOrEqual(m.volatility + 1e-12);
      }
    }
  });

  it('never reports a Sortino smaller in magnitude than the Sharpe', () => {
    for (const seed of ['e', 'f', 'g']) {
      for (const drift of [-0.002, 0.001, 0.005]) {
        const m = computeMetrics([], curve({ bars: 300, drift, seed }), config(), extra);
        if (Math.abs(m.sharpe) < 1e-9 || Math.abs(m.sortino) < 1e-9) continue;
        // Same numerator, a denominator that can only be smaller.
        expect(Math.abs(m.sortino), `seed ${seed} drift ${drift}`).toBeGreaterThanOrEqual(
          Math.abs(m.sharpe) - 1e-9,
        );
      }
    }
  });

  it('measures the benchmark over the window the strategy actually traded', () => {
    // 100 flat bars before `startTime`, during which the benchmark climbs hard,
    // then 200 traded bars during which it falls.
    const points = curve({ bars: 300, leadingFlatBars: 100, drift: 0.0005, benchmarkDrift: 0, seed: 'h' });
    for (let i = 0; i < 100; i += 1) {
      (points[i] as EquityPoint).benchmark = 100_000 * (1 + 0.004 * i);
    }
    const openAtStart = (points[100] as EquityPoint).benchmark;
    for (let i = 100; i < 300; i += 1) {
      (points[i] as EquityPoint).benchmark = openAtStart * (1 - 0.0005 * (i - 100));
    }

    const m = computeMetrics([], points, config(), extra);
    // The benchmark rose 40% before the strategy started and fell 10% after.
    // Only the second number describes the comparison being published.
    expect(m.benchmarkReturn, 'benchmark measured over the traded window').toBeLessThan(0);
    expect(m.benchmarkReturn).toBeGreaterThan(-0.2);
  });

  it('does not let a flat untraded prefix suppress the volatility', () => {
    const withPrefix = computeMetrics(
      [],
      curve({ bars: 400, leadingFlatBars: 200, drift: 0, seed: 'i' }),
      config(),
      extra,
    );
    const withoutPrefix = computeMetrics([], curve({ bars: 200, drift: 0, seed: 'i' }), config(), extra);
    // The same traded series either way, so the annualised figure has to agree —
    // padding the sample with 200 zero-return days used to halve it.
    expect(withPrefix.volatility).toBeCloseTo(withoutPrefix.volatility, 6);
  });

  it('keeps drawdown, win rate and exposure inside their definitions', () => {
    const m = computeMetrics([], curve({ bars: 250, drift: -0.001, seed: 'j' }), config(), extra);
    expect(m.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(m.maxDrawdown).toBeLessThanOrEqual(1);
    expect(m.winRate).toBeGreaterThanOrEqual(0);
    expect(m.winRate).toBeLessThanOrEqual(1);
    expect(Number.isFinite(m.sharpe)).toBe(true);
    expect(Number.isFinite(m.sortino)).toBe(true);
    expect(Number.isFinite(m.calmar)).toBe(true);
  });
});
