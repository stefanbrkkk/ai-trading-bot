/**
 * Training-set construction.
 *
 * Walks the simulated history and, at each sample instant, computes the full
 * feature vector using only information available at that instant, then labels it
 * with the forward benchmark-relative return over the horizon.
 *
 * Two properties matter and are enforced here:
 *
 *   • No look-ahead. Bars, books, option chains and alt-data are all sliced to
 *     `≤ sampleTime`. The label reads bars strictly after it.
 *   • Distribution match. The same `computeFeatures` call produces the training
 *     vector and the inference vector, including the expensive SABR and MLOFI
 *     blocks, so there is no train/serve skew. That is why the sample budget is
 *     bounded rather than the feature set being trimmed.
 */

import { type ComputedFeatures, computeFeatures } from './compute';
import { AGENT_FEATURE_KEYS, AGENT_SEQUENCE_LENGTH, type TrainingDataset } from './model';
import { MODEL_FEATURE_KEYS } from './features';
import type { SimulatorProvider } from '@/lib/market/provider';
import { BENCHMARK_SYMBOL, requireSpec, symbolMeta } from '@/lib/market/universe';
import type { AltDataEvent, Bar, OptionChainSlice, Sector } from '@/lib/domain/types';
import { closes } from '@/lib/quant/indicators';
import { clamp } from '@/lib/quant/stats';

export interface DatasetOptions {
  /** Symbols to sample. Defaults to every tradable symbol. */
  symbols?: string[];
  /** Sample instants per symbol. */
  samplesPerSymbol?: number;
  /** Forward horizon in trading days for the label. */
  horizonDays?: number;
  /** Bars of history required before the first sample. */
  warmupBars?: number;
  /** Book snapshots per sample — the dominant cost, so it is tunable. */
  bookSnapshots?: number;
  /** Sequence length for the temporal agents. */
  sequenceLength?: number;
  onProgress?: (done: number, total: number, symbol: string) => void;
}

/**
 * A per-symbol feature history, kept so the agent sequences and the backtester
 * can reuse the same computed vectors instead of recomputing them.
 */
export interface SymbolFeatureHistory {
  symbol: string;
  /** Ascending by time. */
  entries: {
    time: number;
    /**
     * When the label became knowable — the close `horizonDays` sessions after
     * `time`. Carried so the trainer can purge samples whose label reaches into
     * the validation window; without it the split is out-of-time in its features
     * and in-time in its outcomes.
     */
    labelTime: number;
    features: ComputedFeatures;
    forwardReturn: number;
    label: number;
  }[];
}

export interface DatasetResult extends TrainingDataset {
  histories: SymbolFeatureHistory[];
  /** Wall-clock cost, reported by the seed script. */
  elapsedMs: number;
  /** Per-stage cost accounting, so the sample budget can be tuned. */
  costs: { symbols: number; samples: number; msPerSample: number };
}

export async function buildTrainingDataset(
  provider: SimulatorProvider,
  options: DatasetOptions = {},
): Promise<DatasetResult> {
  const started = Date.now();
  const symbols = options.symbols ?? provider.symbols().filter((s) => !s.isBenchmark).map((s) => s.symbol);
  const samplesPerSymbol = options.samplesPerSymbol ?? 34;
  const horizonDays = options.horizonDays ?? 5;
  const warmupBars = options.warmupBars ?? 260;
  const bookSnapshots = options.bookSnapshots ?? 24;
  const sequenceLength = options.sequenceLength ?? AGENT_SEQUENCE_LENGTH;

  const sessions = provider.simulator.sessionTimes;
  const benchmarkAll = provider.simulator.dailyBars(BENCHMARK_SYMBOL).bars;
  const benchmarkCloses = closes(benchmarkAll);

  // Sector composites are expensive and shared, so compute each once over the
  // full history and slice per sample.
  const sectorSeries = new Map<Sector, number[]>();
  const sectorsPresent = Array.from(new Set(symbols.map((s) => requireSpec(s).sector)));
  for (const sector of sectorsPresent) {
    sectorSeries.set(sector, await provider.sectorCloses(sector, { endAt: provider.referenceNow }));
  }

  const histories: SymbolFeatureHistory[] = [];
  const x: number[][] = [];
  const y: number[] = [];
  const forwardReturn: number[] = [];
  const sequences: number[][][] = [];
  const meta: { symbol: string; time: number; labelTime: number }[] = [];

  // Sample instants are evenly spaced across the usable range so the training
  // set spans every regime the simulator produced rather than clustering.
  const firstIndex = warmupBars;
  const lastIndex = sessions.length - horizonDays - 2;
  if (lastIndex <= firstIndex) {
    throw new Error(`buildTrainingDataset: not enough history (${sessions.length} sessions)`);
  }

  let processed = 0;
  for (const symbol of symbols) {
    const spec = requireSpec(symbol);
    const symbolMetaValue = symbolMeta(spec);
    const dailyAll = provider.simulator.dailyBars(symbol).bars;
    const symbolCloses = closes(dailyAll);
    const sector = sectorSeries.get(spec.sector) ?? [];
    const altAll = provider.simulator.altEvents(
      symbol,
      sessions[Math.max(0, firstIndex - 200)] as number,
      sessions[sessions.length - 1] as number,
    );

    const history: SymbolFeatureHistory = { symbol, entries: [] };
    const step = Math.max(1, Math.floor((lastIndex - firstIndex) / samplesPerSymbol));

    for (let idx = firstIndex; idx <= lastIndex; idx += step) {
      const sampleTime = sessions[idx] as number;
      // Evaluate near the close so the intraday block is fully populated.
      const evaluateAt = sampleTime + 380 * 60_000;

      const dailyBars = dailyAll.slice(0, idx + 1);
      const benchmarkBars = benchmarkAll.slice(0, idx + 1);
      const intradayBars = provider.simulator.intradayBars(symbol, sampleTime, 5);
      const books = provider.simulator.orderBookSequence(symbol, evaluateAt, bookSnapshots, 1000, 10);
      const chains: OptionChainSlice[] = spec.optionable
        ? [provider.simulator.optionChain(symbol, evaluateAt, 30)]
        : [];
      const altEvents: AltDataEvent[] = altAll.filter((e) => e.timestamp <= evaluateAt);

      let features: ComputedFeatures;
      try {
        features = computeFeatures({
          symbol,
          meta: symbolMetaValue,
          dailyBars,
          intradayBars,
          benchmarkBars,
          sectorCloses: sector.slice(0, idx + 1),
          books,
          chains,
          altEvents,
          now: evaluateAt,
          horizonDays,
        });
      } catch {
        continue;
      }

      // Label: did the symbol beat the benchmark over the horizon?
      const future = idx + horizonDays;
      const symbolNow = symbolCloses[idx] as number;
      const symbolThen = symbolCloses[future] as number | undefined;
      const benchNow = benchmarkCloses[idx] as number;
      const benchThen = benchmarkCloses[future] as number | undefined;
      if (symbolThen === undefined || benchThen === undefined || symbolNow <= 0 || benchNow <= 0) continue;

      const symbolReturn = (symbolThen - symbolNow) / symbolNow;
      const benchReturn = (benchThen - benchNow) / benchNow;
      const relative = symbolReturn - benchReturn;
      const label = relative > 0 ? 1 : 0;

      const labelTime = sessions[future] as number;
      history.entries.push({ time: evaluateAt, labelTime, features, forwardReturn: relative, label });
      processed += 1;
      options.onProgress?.(processed, symbols.length * samplesPerSymbol, symbol);
    }

    // Agent sequences use the symbol's own consecutive feature history.
    for (let i = 0; i < history.entries.length; i += 1) {
      const entry = history.entries[i] as SymbolFeatureHistory['entries'][number];
      const window = history.entries.slice(Math.max(0, i - sequenceLength + 1), i + 1).map((e) => e.features);
      const sequence = toSequence(window, sequenceLength);
      x.push(MODEL_FEATURE_KEYS.map((k) => sanitiseValue(entry.features.raw[k] ?? 0)));
      y.push(entry.label);
      forwardReturn.push(clamp(entry.forwardReturn, -0.4, 0.4));
      sequences.push(sequence);
      meta.push({ symbol, time: entry.time, labelTime: entry.labelTime });
    }

    histories.push(history);
  }

  // Chronological ordering across the whole set, so the train/validation split
  // in `trainModelBundle` is a genuine out-of-time split.
  const order = meta.map((m, i) => ({ i, time: m.time })).sort((a, b) => a.time - b.time);
  const elapsedMs = Date.now() - started;

  return {
    x: order.map((o) => x[o.i] as number[]),
    y: order.map((o) => y[o.i] as number),
    forwardReturn: order.map((o) => forwardReturn[o.i] as number),
    sequences: order.map((o) => sequences[o.i] as number[][]),
    meta: order.map((o) => meta[o.i] as { symbol: string; time: number; labelTime: number }),
    histories,
    elapsedMs,
    costs: {
      symbols: symbols.length,
      samples: order.length,
      msPerSample: order.length === 0 ? 0 : Math.round((elapsedMs / order.length) * 100) / 100,
    },
  };
}

function toSequence(window: readonly ComputedFeatures[], sequenceLength: number): number[][] {
  const rows = window.map((f) => AGENT_FEATURE_KEYS.map((k) => sanitiseValue(f.raw[k] ?? 0)));
  while (rows.length < sequenceLength && rows.length > 0) rows.unshift((rows[0] as number[]).slice());
  while (rows.length < sequenceLength) rows.unshift(new Array<number>(AGENT_FEATURE_KEYS.length).fill(0));
  return rows.slice(-sequenceLength);
}

function sanitiseValue(x: number): number {
  return Number.isFinite(x) ? clamp(x, -50, 50) : 0;
}

/**
 * Rolling 25Δ risk-reversal history for a symbol, used by the skew strategy.
 * Sampled every `strideDays` sessions and forward-filled, because calibrating
 * SABR on every session for every symbol would cost more than the signal is
 * worth.
 */
export function buildRiskReversalHistory(
  provider: SimulatorProvider,
  symbol: string,
  options: { lookbackSessions?: number; strideDays?: number; endAt?: number } = {},
): number[] {
  const spec = requireSpec(symbol);
  if (!spec.optionable) return [];
  const lookback = options.lookbackSessions ?? 50;
  const stride = options.strideDays ?? 5;
  const sessions = provider.simulator.sessionTimes;
  const endAt = options.endAt ?? provider.referenceNow;
  const usable = sessions.filter((t) => t <= endAt).slice(-lookback);
  const out: number[] = [];

  for (let i = 0; i < usable.length; i += 1) {
    if (i % stride === 0 || out.length === 0) {
      const at = (usable[i] as number) + 380 * 60_000;
      const chain = provider.simulator.optionChain(symbol, at, 30);
      const calls = chain.quotes.filter((q) => q.type === 'call' && q.impliedVolatility > 0);
      if (calls.length < 6) {
        out.push(out[out.length - 1] ?? 0);
        continue;
      }
      // Read the 25Δ risk reversal straight off the simulated surface rather
      // than refitting SABR — the simulator built the smile from SABR, so the
      // quoted IVs already carry it.
      const callLeg = nearestByDelta(calls, 0.25);
      const puts = chain.quotes.filter((q) => q.type === 'put' && q.impliedVolatility > 0);
      const putLeg = nearestByDelta(puts, -0.25);
      out.push(callLeg && putLeg ? callLeg.impliedVolatility - putLeg.impliedVolatility : (out[out.length - 1] ?? 0));
    } else {
      out.push(out[out.length - 1] as number);
    }
  }
  return out;
}

function nearestByDelta<T extends { delta: number }>(quotes: readonly T[], target: number): T | undefined {
  let best: T | undefined;
  let bestDistance = Infinity;
  for (const q of quotes) {
    const d = Math.abs(q.delta - target);
    if (d < bestDistance) {
      bestDistance = d;
      best = q;
    }
  }
  return best;
}

/** Aligns a benchmark series to a symbol's bar count for the pipeline input. */
export function alignBenchmark(symbolBars: readonly Bar[], benchmarkBars: readonly Bar[]): Bar[] {
  return benchmarkBars.slice(-symbolBars.length);
}
