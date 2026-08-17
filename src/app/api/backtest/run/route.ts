/**
 * Walk-forward backtest.
 *
 * Serves the seeded fixture by default and recomputes on demand. The response
 * always includes the Combine survival scorecard *and* the out-of-sample
 * efficiency across folds, because the four survival thresholds on their own are
 * an in-sample result — which is precisely the criticism the research levels at
 * the nightly Quantitative Combine.
 */

import { z } from 'zod';
import { ApiError, handler, ok, parseBody, pendingSetup } from '@/lib/api/respond';
import { currentUser } from '@/lib/auth/session';
import {
  COMBINE_THRESHOLDS,
  DEFAULT_BACKTEST_CONFIG,
  type BacktestBarSlice,
  combineScorecard,
  runBacktest,
} from '@/lib/engine/backtest';
import { loadArtefact } from '@/lib/engine/store';
import { STRATEGY_IDS } from '@/lib/engine/strategies';
import { SimulatorProvider } from '@/lib/market/provider';
import { BENCHMARK_SYMBOL, TRADABLE_SYMBOLS, requireSpec, symbolMeta } from '@/lib/market/universe';
import { buildRiskReversalHistory } from '@/lib/engine/dataset';
import { referenceNow } from '@/lib/domain/clock';
import type { ComputedFeatures } from '@/lib/engine/compute';
import type { BacktestResult } from '@/lib/domain/types';

export const dynamic = 'force-dynamic';
/** A recompute walks three years of bars per symbol; cap the work per request. */
export const maxDuration = 60;

const bodySchema = z.object({
  symbols: z.array(z.string().min(1).max(12)).min(1).max(12).optional(),
  strategies: z.array(z.enum(STRATEGY_IDS as [string, ...string[]])).min(1).max(12).optional(),
  minConviction: z.number().min(0).max(100).optional(),
  riskPerTrade: z.number().min(0.001).max(0.1).optional(),
  maxConcurrentPositions: z.number().int().min(1).max(20).optional(),
  slippageBps: z.number().min(0).max(100).optional(),
  commissionPerShare: z.number().min(0).max(1).optional(),
  walkForward: z.object({ enabled: z.boolean(), trainBars: z.number().int().min(40).max(500), testBars: z.number().int().min(10).max(200) }).optional(),
});

export const GET = handler(async () => {
  const fixture = loadArtefact<BacktestResult>('backtest-default');
  if (!fixture) {
    return pendingSetup(
      'NO_BACKTEST_FIXTURE',
      'No seeded backtest is present. Seed the deployment, or POST to this endpoint to compute one.',
    );
  }
  return ok({ result: fixture, scorecard: combineScorecard(fixture), thresholds: COMBINE_THRESHOLDS, cached: true });
});

export const POST = handler(async (request: Request) => {
  const user = await currentUser();
  if (!user) throw new ApiError('UNAUTHENTICATED', 'Sign in to run a backtest.', 401);

  const body = await parseBody(request, bodySchema);
  const history = loadArtefact<Record<string, { time: number; raw: Record<string, number> }[]>>('agent-history');
  const featureSnapshots = loadArtefact<Record<string, ComputedFeatures[]>>('agent-history');
  if (!featureSnapshots) {
    return pendingSetup(
      'ENGINE_NOT_SEEDED',
      'Feature history is unavailable. Seed the deployment before running a backtest.',
    );
  }
  void history;

  const now = referenceNow(Date.now());
  const provider = new SimulatorProvider({ seed: process.env.AURELIUS_SEED ?? 20240117, now, years: 3 });
  const requested = (body.symbols ?? TRADABLE_SYMBOLS.slice(0, 8)).map((s) => s.toUpperCase());
  const benchmarkBars = provider.simulator.dailyBars(BENCHMARK_SYMBOL).bars;

  const slices: BacktestBarSlice[] = [];
  for (const symbol of requested) {
    const snapshots = featureSnapshots[symbol];
    if (!snapshots || snapshots.length === 0) continue;
    let spec;
    try {
      spec = requireSpec(symbol);
    } catch {
      continue;
    }
    const bars = provider.simulator.dailyBars(symbol).bars;
    const features: (ComputedFeatures | null)[] = new Array(bars.length).fill(null);
    for (const snapshot of snapshots) {
      // Snap each stored feature vector onto the nearest bar. The stored history
      // is sampled, so most bars legitimately have no features and the
      // backtester will not trade them.
      let best = -1;
      let bestDelta = Infinity;
      for (let i = 0; i < bars.length; i += 1) {
        const delta = Math.abs((bars[i]?.time ?? 0) - snapshot.now);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = i;
        }
      }
      if (best >= 0) features[best] = snapshot;
    }
    slices.push({
      symbol,
      bars,
      benchmarkBars: benchmarkBars.slice(0, bars.length),
      features,
      riskReversalHistory: buildRiskReversalHistory(provider, symbol, {
        lookbackSessions: bars.length,
        strideDays: 42,
        endAt: now,
      }),
      adv30: symbolMeta(spec).adv30,
    });
  }

  if (slices.length === 0) {
    throw new ApiError('NO_USABLE_SYMBOLS', 'None of the requested symbols have seeded feature history.', 422);
  }

  const startTime = provider.simulator.sessionTimes[260] ?? provider.simulator.sessionTimes[0] ?? now;
  const result = runBacktest({
    config: {
      ...DEFAULT_BACKTEST_CONFIG,
      symbols: slices.map((s) => s.symbol),
      ...(body.strategies ? { strategies: body.strategies } : {}),
      ...(body.minConviction !== undefined ? { minConviction: body.minConviction } : {}),
      ...(body.riskPerTrade !== undefined ? { riskPerTrade: body.riskPerTrade } : {}),
      ...(body.maxConcurrentPositions !== undefined ? { maxConcurrentPositions: body.maxConcurrentPositions } : {}),
      ...(body.slippageBps !== undefined ? { slippageBps: body.slippageBps } : {}),
      ...(body.commissionPerShare !== undefined ? { commissionPerShare: body.commissionPerShare } : {}),
      ...(body.walkForward ? { walkForward: body.walkForward } : {}),
      startTime,
      endTime: now,
    },
    slices,
    benchmarkBars,
  });

  return ok({ result, scorecard: combineScorecard(result), thresholds: COMBINE_THRESHOLDS, cached: false });
});
