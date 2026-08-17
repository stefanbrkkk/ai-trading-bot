/**
 * The engine service: the single entry point every API route and Server
 * Component uses.
 *
 * Responsibilities:
 *   • assemble a `PipelineInput` from whichever market provider is configured;
 *   • memoise results per (symbol, 5-minute bucket) so a page that renders the
 *     screener, a signal and a chart does not run the pipeline three times;
 *   • pre-warm from the seeded artefact so the first request after a cold start
 *     is fast;
 *   • publish the daily Top 5 deterministically — the same list for every
 *     subscriber, which is a Lowe v. SEC requirement, not an optimisation.
 */

import { type ComputedFeatures, applyCrossSectionalNormalisation } from './compute';
import { type PipelineResult, runPipeline } from './pipeline';
import { loadArtefact, saveArtefact, tryLoadModelBundle } from './store';
import { NEUTRALITY_NOTICE, composePublicationNotice } from './narrative';
import { buildRiskReversalHistory } from './dataset';
import {
  type MarketDataProvider,
  SimulatorProvider,
  resolveMarketProvider,
} from '@/lib/market/provider';
import { BENCHMARK_SYMBOL, TRADABLE_SYMBOLS, requireSpec } from '@/lib/market/universe';
import { isoDate, sessionOpen } from '@/lib/market/calendar';
import { resample } from '@/lib/quant/indicators';
import type { Bar, ScreenerFilter, ScreenerRow, Signal } from '@/lib/domain/types';

/** Results are memoised per 5-minute bucket — the engine's own tick resolution. */
const BUCKET_MS = 5 * 60_000;
/** How many symbols the universe sweep will process in one request. */
export const UNIVERSE_SWEEP_LIMIT = 64;

export interface EngineOptions {
  /** Evaluation instant. Defaults to the provider's reference clock. */
  now?: number;
  /** Signal horizon in trading days. */
  horizonDays?: number;
}

function bucketOf(now: number): number {
  return Math.floor(now / BUCKET_MS);
}

interface SymbolCacheEntry {
  bucket: number;
  result: PipelineResult;
}

const symbolCache = new Map<string, SymbolCacheEntry>();
let universeCache: { bucket: number; rows: ScreenerRow[]; signals: Signal[] } | null = null;

export function clearEngineCache(): void {
  symbolCache.clear();
  universeCache = null;
  agentHistoryCache = undefined;
  riskReversalCache = undefined;
  profitFactorCache = undefined;
}

function referenceNow(provider: MarketDataProvider, options: EngineOptions): number {
  if (options.now !== undefined) return options.now;
  if (provider instanceof SimulatorProvider) return provider.referenceNow;
  return Date.now();
}

export interface EngineReadiness {
  ready: boolean;
  reason: string | null;
  provider: string;
  modelVersion: string | null;
}

export function engineReadiness(): EngineReadiness {
  const model = tryLoadModelBundle();
  const provider = resolveMarketProvider();
  return {
    ready: model !== null,
    reason: model
      ? null
      : 'The trading engine has no trained ensemble yet. Run `npm run seed` to train one; every other part of the platform works without it.',
    provider: provider.name,
    modelVersion: model?.version ?? null,
  };
}

/**
 * Builds the pipeline input for one symbol. Feature history for the temporal
 * agents comes from the seeded artefact when available, since recomputing 24
 * historical feature vectors per request would blow the latency budget.
 */
async function buildInput(
  provider: MarketDataProvider,
  symbol: string,
  now: number,
  horizonDays: number,
): Promise<Parameters<typeof runPipeline>[0]> {
  const spec = requireSpec(symbol);
  const meta = provider.meta(symbol);

  const [dailyBars, intradayBars, benchmarkBars, benchmarkIntradayBars, sectorCloses, books, chains, altEvents] =
    await Promise.all([
      provider.dailyBars(symbol, { limit: 400, endAt: now }),
      provider.intradayBars(symbol, { sessions: 2, minutesPerBar: 5, endAt: now }),
      provider.dailyBars(BENCHMARK_SYMBOL, { limit: 400, endAt: now }),
      provider.intradayBars(BENCHMARK_SYMBOL, { sessions: 1, minutesPerBar: 5, endAt: now }),
      provider.sectorCloses(spec.sector, { endAt: now }),
      provider.orderBook(symbol, now, 10),
      provider.optionChains(symbol, now),
      provider.altEvents(symbol, { days: 200, endAt: now }),
    ]);

  // Rebuilding a 50-session risk-reversal history means ten option-surface
  // constructions per symbol — ~130ms, which dominated the universe sweep. The
  // seed persists it; only fall back to building it when the artefact is absent.
  const riskReversalHistory =
    cachedRiskReversals()?.[symbol] ??
    (provider instanceof SimulatorProvider
      ? buildRiskReversalHistory(provider, symbol, { lookbackSessions: 50, strideDays: 10, endAt: now })
      : []);

  return {
    symbol,
    meta,
    dailyBars,
    intradayBars,
    benchmarkBars,
    benchmarkIntradayBars,
    sectorCloses,
    books,
    chains,
    altEvents,
    riskReversalHistory,
    now,
    horizonDays,
    profitFactors: cachedProfitFactors(),
  };
}

/**
 * Artefact reads are memoised per process: `loadArtefact` hits the filesystem and
 * parses JSON, and the universe sweep would otherwise do that 64 times per
 * artefact.
 */
let agentHistoryCache: Record<string, ComputedFeatures[]> | null | undefined;
let riskReversalCache: Record<string, number[]> | null | undefined;
let profitFactorCache: Record<string, number> | null | undefined;

function agentHistory(symbol: string): ComputedFeatures[] {
  if (agentHistoryCache === undefined) {
    agentHistoryCache = loadArtefact<Record<string, ComputedFeatures[]>>('agent-history');
  }
  return agentHistoryCache?.[symbol] ?? [];
}

function cachedRiskReversals(): Record<string, number[]> | null {
  if (riskReversalCache === undefined) {
    riskReversalCache = loadArtefact<Record<string, number[]>>('risk-reversal-history');
  }
  return riskReversalCache ?? null;
}

function cachedProfitFactors(): Record<string, number> {
  if (profitFactorCache === undefined) {
    profitFactorCache = loadArtefact<Record<string, number>>('strategy-profit-factors');
  }
  return profitFactorCache ?? {};
}

export async function getSignal(symbol: string, options: EngineOptions = {}): Promise<PipelineResult> {
  const provider = resolveMarketProvider();
  const now = referenceNow(provider, options);
  const bucket = bucketOf(now);
  const cacheKey = `${symbol}:${options.horizonDays ?? 5}`;
  const cached = symbolCache.get(cacheKey);
  if (cached && cached.bucket === bucket) return cached.result;

  const model = tryLoadModelBundle();
  if (!model) {
    throw new Error(
      'No trained ensemble is available. Run `npm run seed` to train one before requesting signals.',
    );
  }

  const input = await buildInput(provider, symbol, now, options.horizonDays ?? 5);
  const result = runPipeline(input, model, agentHistory(symbol));
  symbolCache.set(cacheKey, { bucket, result });
  return result;
}

export interface UniverseSnapshot {
  rows: ScreenerRow[];
  signals: Signal[];
  /**
   * The per-symbol feature vectors behind `rows`, after the cross-sectional ECDF
   * pass. Exposed because the sweep already computes them and the seed has to
   * persist them into `feature_values` — that table is what `v_equity_snapshot`
   * pivots, and therefore the only reason InvestGPT has anything to query. Left
   * empty when the snapshot is served from cache, since the cache stores the
   * derived rows rather than the vectors.
   */
  features: ComputedFeatures[];
  computedAt: number;
  provider: string;
  modelVersion: string;
}

/**
 * Sweeps the tradable universe. Runs the pipeline for every symbol, then applies
 * the cross-sectional ECDF pass so percentile columns are comparable across
 * names — that pass is why the sweep is done as a batch rather than per symbol.
 */
export async function getUniverseSnapshot(options: EngineOptions = {}): Promise<UniverseSnapshot> {
  const provider = resolveMarketProvider();
  const now = referenceNow(provider, options);
  const bucket = bucketOf(now);
  if (universeCache && universeCache.bucket === bucket) {
    return {
      rows: universeCache.rows,
      signals: universeCache.signals,
      features: [],
      computedAt: now,
      provider: provider.name,
      modelVersion: universeCache.signals[0]?.modelVersion ?? 'unknown',
    };
  }

  const model = tryLoadModelBundle();
  if (!model) throw new Error('No trained ensemble is available. Run `npm run seed` first.');

  const symbols = TRADABLE_SYMBOLS.slice(0, UNIVERSE_SWEEP_LIMIT);
  const results: PipelineResult[] = [];
  for (const symbol of symbols) {
    try {
      const input = await buildInput(provider, symbol, now, options.horizonDays ?? 5);
      results.push(runPipeline(input, model, agentHistory(symbol)));
    } catch {
      // One bad symbol must not take down the screener.
      continue;
    }
  }

  applyCrossSectionalNormalisation(results.map((r) => r.features));
  const rows = results.map((r) => toScreenerRow(r, provider));
  const signals = results.map((r) => r.signal);
  universeCache = { bucket, rows, signals };

  return {
    rows,
    signals,
    features: results.map((r) => r.features),
    computedAt: now,
    provider: provider.name,
    modelVersion: model.version,
  };
}

function toScreenerRow(result: PipelineResult, provider: MarketDataProvider): ScreenerRow {
  const { signal, features } = result;
  const meta = provider.meta(signal.symbol);
  const topDriver = signal.drivers[0];
  return {
    symbol: signal.symbol,
    name: meta.name,
    sector: meta.sector,
    price: features.artefacts.price,
    changePercent: features.artefacts.changePercent,
    conviction: signal.conviction,
    probability: signal.probability,
    direction: signal.direction,
    regime: signal.regime,
    relativeVolume: features.raw.rel_volume_20 ?? 1,
    atrPercent: features.raw.atr_pct_14 ?? 0,
    rsi14: features.raw.rsi_14 ?? 50,
    ouZScore: features.raw.ou_zscore ?? 0,
    mlofiIntent: features.raw.mlofi_intent ?? 0,
    riskReversal25: features.raw.rr25_30d ?? 0,
    altComposite: features.raw.alt_composite ?? 0,
    marketCap: meta.marketCap,
    adv30: meta.adv30,
    topDriver: topDriver ? topDriver.label : '—',
    signalId: signal.id,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Screening
// ─────────────────────────────────────────────────────────────────────────────

export function applyScreenerFilter(rows: readonly ScreenerRow[], filter: ScreenerFilter): ScreenerRow[] {
  let out = rows.slice();
  if (filter.sectors && filter.sectors.length > 0) {
    const set = new Set(filter.sectors);
    out = out.filter((r) => set.has(r.sector));
  }
  if (filter.regimes && filter.regimes.length > 0) {
    const set = new Set(filter.regimes);
    out = out.filter((r) => set.has(r.regime));
  }
  if (filter.direction) out = out.filter((r) => r.direction === filter.direction);
  if (filter.minConviction !== undefined) out = out.filter((r) => r.conviction >= (filter.minConviction as number));
  if (filter.maxConviction !== undefined) out = out.filter((r) => r.conviction <= (filter.maxConviction as number));
  if (filter.minPrice !== undefined) out = out.filter((r) => r.price >= (filter.minPrice as number));
  if (filter.maxPrice !== undefined) out = out.filter((r) => r.price <= (filter.maxPrice as number));
  if (filter.minMarketCap !== undefined) out = out.filter((r) => r.marketCap >= (filter.minMarketCap as number));
  if (filter.maxMarketCap !== undefined) out = out.filter((r) => r.marketCap <= (filter.maxMarketCap as number));
  if (filter.minRelativeVolume !== undefined) out = out.filter((r) => r.relativeVolume >= (filter.minRelativeVolume as number));
  if (filter.minRsi !== undefined) out = out.filter((r) => r.rsi14 >= (filter.minRsi as number));
  if (filter.maxRsi !== undefined) out = out.filter((r) => r.rsi14 <= (filter.maxRsi as number));
  if (filter.search) {
    const q = filter.search.trim().toLowerCase();
    if (q.length > 0) {
      out = out.filter((r) => r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
    }
  }

  const sortBy = filter.sortBy ?? 'conviction';
  const dir = filter.sortDirection === 'asc' ? 1 : -1;
  out.sort((a, b) => {
    const av = a[sortBy];
    const bv = b[sortBy];
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });

  return filter.limit ? out.slice(0, filter.limit) : out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Daily publication (the Top 5)
// ─────────────────────────────────────────────────────────────────────────────

export interface PublicationItem {
  rank: number;
  symbol: string;
  name: string;
  conviction: number;
  probability: number;
  direction: Signal['direction'];
  regime: Signal['regime'];
  referencePrice: number;
  expectedReturn: number;
  strategy: string | null;
  signalId: string;
  topDriver: string;
}

export interface Publication {
  /** New York calendar date of the publication. */
  publicationDate: string;
  publishedAt: number;
  items: PublicationItem[];
  /** The mandated neutral framing sentence. */
  notice: string;
  neutralityNotice: string;
  modelVersion: string;
}

/**
 * The daily Top 5.
 *
 * Deterministic in (date, seed, model version) and computed once per session
 * date: every subscriber receives byte-identical output. There is no user
 * parameter anywhere in this function's signature, which is the structural
 * guarantee that the publication stays impersonal.
 */
export async function getPublication(options: EngineOptions = {}): Promise<Publication> {
  const provider = resolveMarketProvider();
  const now = referenceNow(provider, options);
  const publicationDate = isoDate(sessionOpen(now));

  const cached = loadArtefact<Publication>(`publication-${publicationDate}`);
  if (cached) return cached;

  const snapshot = await getUniverseSnapshot(options);
  const ranked = snapshot.signals
    .filter((s) => s.direction !== 'flat')
    .sort((a, b) => b.conviction - a.conviction || a.symbol.localeCompare(b.symbol))
    .slice(0, 5);

  const items: PublicationItem[] = ranked.map((s, i) => ({
    rank: i + 1,
    symbol: s.symbol,
    name: provider.meta(s.symbol).name,
    conviction: s.conviction,
    probability: s.probability,
    direction: s.direction,
    regime: s.regime,
    referencePrice: s.referencePrice,
    expectedReturn: s.expectedReturn,
    strategy: s.strategy,
    signalId: s.id,
    topDriver: s.drivers[0]?.label ?? '—',
  }));

  const publication: Publication = {
    publicationDate,
    publishedAt: sessionOpen(now),
    items,
    notice: composePublicationNotice(items.map((i) => i.symbol)),
    neutralityNotice: NEUTRALITY_NOTICE,
    modelVersion: snapshot.modelVersion,
  };
  saveArtefact(`publication-${publicationDate}`, publication);
  return publication;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Chart data
// ─────────────────────────────────────────────────────────────────────────────

export interface ChartSeries {
  symbol: string;
  daily: Bar[];
  intraday: Bar[];
  hourly: Bar[];
  /** Kalman innovation band, aligned to the tail of `daily`. */
  kalmanBand: { time: number; level: number; upper: number; lower: number }[];
  /** Bollinger band for the explicit contrast the UI draws. */
  bollinger: { time: number; upper: number; middle: number; lower: number }[];
  /** OU band on the benchmark-relative spread, in price terms. */
  ouBand: { upper: number; lower: number; mid: number };
  vwap: number;
}

export async function getChartSeries(symbol: string, options: EngineOptions = {}): Promise<ChartSeries> {
  const result = await getSignal(symbol, options);
  const provider = resolveMarketProvider();
  const now = referenceNow(provider, options);
  const daily = await provider.dailyBars(symbol, { limit: 180, endAt: now });
  const intraday = await provider.intradayBars(symbol, { sessions: 2, minutesPerBar: 5, endAt: now });
  const artefacts = result.features.artefacts;

  const bandSeries = artefacts.kalmanSeries.slice(-daily.length);
  const offset = daily.length - bandSeries.length;
  const kalmanBand = bandSeries.map((p, i) => ({
    time: (daily[offset + i] as Bar | undefined)?.time ?? 0,
    level: p.level,
    upper: p.upper,
    lower: p.lower,
  }));

  return {
    symbol,
    daily,
    intraday,
    hourly: resample(intraday, 60),
    kalmanBand,
    bollinger: daily.map((b) => ({
      time: b.time,
      upper: artefacts.bollingerUpper,
      middle: artefacts.ema20,
      lower: artefacts.bollingerLower,
    })),
    ouBand: artefacts.ouBand,
    vwap: artefacts.vwapValue,
  };
}
