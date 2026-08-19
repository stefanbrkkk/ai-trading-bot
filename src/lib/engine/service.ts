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
import { loadArtefact, tryLoadModelBundle } from './store';
import { NEUTRALITY_NOTICE, composePublicationNotice } from './narrative';
import { buildRiskReversalHistory } from './dataset';
import {
  type MarketDataProvider,
  SimulatorProvider,
  resolveMarketProvider,
} from '@/lib/market/provider';
import { BENCHMARK_SYMBOL, TRADABLE_SYMBOLS, requireSpec } from '@/lib/market/universe';
import { isoDate, lastCompletedSessionClose, sessionOpen } from '@/lib/market/calendar';
import { resample } from '@/lib/quant/indicators';
import { ouZScore } from '@/lib/quant/ou';
import { sabrSmileCurve } from '@/lib/quant/sabr';
import type { Bar, ScreenerFilter, ScreenerRow, Signal } from '@/lib/domain/types';

/** Results are memoised per 5-minute bucket — the engine's own tick resolution. */
const BUCKET_MS = 5 * 60_000;
/**
 * How many symbols the universe sweep will process in one request.
 *
 * This is a runaway guard, not a budget: it has to stay at or above the tradable
 * count, or the sweep silently truncates. At 64 it dropped the last three names
 * in the universe (SMCI, RIOT, BYND) from the screener and from the terminal's
 * ranking, while `/terminal/SMCI` and an order ticket for it still worked — so
 * the platform both did and did not cover the same symbol depending on the route.
 * `tests/universe.test.ts` fails if the universe ever grows past it again.
 */
export const UNIVERSE_SWEEP_LIMIT = 128;

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

/**
 * The instant every part of the engine evaluates at.
 *
 * It is the last completed session's close, not the wall clock, and that is a
 * correctness requirement rather than a preference. The daily publication is
 * persisted to disk — it has to be, it is immutable for its date, one ranking
 * identical for every subscriber — while the screener sweep and each symbol page
 * recompute per request. Evaluated at the wall clock those two disagree, because
 * the intraday series grows through the session: measured across one afternoon,
 * the cached list published SCHW at 33.6 long, MRK at 22.6 long and DE at 22.3
 * long, while `/terminal/SCHW` read 0 and flat, MRK read 15.7 *short* and DE
 * 12.6 short. Five cards, none of whose own detail pages agreed with them. A
 * process restart made it total: an entirely different five names.
 *
 * Snapping to the session close removes the disagreement at the source rather
 * than papering over it with a vintage label. The instant is a function of the
 * calendar, so any process, on any machine, at any hour of the day, recomputes
 * byte-identical output and the cached artefact is never stale. It is also the
 * cadence the product already publishes on every page — end of day, five-day
 * horizon — so the terminal now computes what its own status strip says it does.
 *
 * `options.now` still overrides, which is what the backtester and the seed use
 * to evaluate at a historical instant.
 */
function referenceNow(provider: MarketDataProvider, options: EngineOptions): number {
  if (options.now !== undefined) return options.now;
  const wall = provider instanceof SimulatorProvider ? provider.referenceNow : Date.now();
  return lastCompletedSessionClose(wall);
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
      // The remedy belongs to whatever renders this, not to the sentence — the
      // terminal's banner appends it, and printing it here too put "run npm run
      // seed" twice in one paragraph on the first screen a deployment shows.
      : 'The trading engine has no trained ensemble yet. Every other part of the platform works without one.',
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
 * parses JSON, and the universe sweep would otherwise do that once per tradable
 * symbol for each of the three artefacts below.
 *
 * The count is not written out. It said "64 times", which held while
 * `UNIVERSE_SWEEP_LIMIT` was 64 and stayed behind when the limit moved to 128 —
 * so one file used the same 64 for two incompatible things: the truncating limit
 * its docstring above records as a defect, and the number of symbols the sweep
 * actually processes. The sweep covers all of `TRADABLE_SYMBOLS`, which is a
 * number that moves whenever the table is edited by hand.
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
      'No trained ensemble is available. Train one before requesting signals.',
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
  if (!model) throw new Error('No trained ensemble is available.');

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
  /**
   * The instant the list was evaluated at — identical to the `generatedAt` on
   * every signal it contains, and to `UniverseSnapshot.computedAt`.
   */
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

  /*
   * The list is derived from the snapshot on every call. It is not cached to disk,
   * and that is the third and final attempt at getting this right.
   *
   * A published list is immutable for its date — the Lowe v. SEC posture, one
   * ranking identical for every subscriber — and the earlier versions tried to
   * express that by persisting it under a key naming its inputs. Keyed on the
   * date alone it survived a retrain, so /terminal served SCHW at 52.5 while
   * /terminal/SCHW computed 33.6 from the model actually in force. Keyed on date
   * and model it survived a change to the evaluation rule, and published DUK at
   * 24.5 against a symbol page reading 23.3. Keyed on date, model and evaluation
   * instant it survived a change to the *code*: measured on this build, the
   * stored list led with SCHW at 41.8 while every live surface computed 16.7 —
   * a twenty-five point contradiction between the front page and the page it
   * links to.
   *
   * Each fix added another input to the key, and the next thing that changed was
   * always one the key did not name. The mistake is the shape, not the key: a
   * durable cache of a derived value can always outlive its derivation.
   *
   * So there is nothing to outlive. `getUniverseSnapshot` already memoises the
   * expensive part per evaluation instant, and this is a sort and a slice over
   * sixty-seven signals — microseconds. Immutability comes from determinism
   * rather than from storage: identical inputs give an identical list, and when
   * an input does change the list changes with it, everywhere, at once.
   */
  const snapshot = await getUniverseSnapshot(options);
  /*
   * Directional names first, then the highest-scoring remainder to make five.
   *
   * The filter used to be absolute, which was fine while every symbol in the
   * universe published as long and became a hole in the product the moment the
   * agents were calibrated: on a day when the model declines to take a side on
   * most names, `filter(direction !== 'flat')` can leave fewer than five — or
   * none, and the terminal is the front page. Ranking by conviction and letting
   * flat names fill the tail keeps the list at its published fixed size, and each
   * card already states its own direction, so nothing is implied that the data
   * does not say.
   */
  const byConviction = (a: Signal, b: Signal): number =>
    b.conviction - a.conviction || a.symbol.localeCompare(b.symbol);
  const directional = snapshot.signals.filter((s) => s.direction !== 'flat').sort(byConviction);
  const undecided = snapshot.signals.filter((s) => s.direction === 'flat').sort(byConviction);
  const ranked = [...directional, ...undecided].slice(0, 5);

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
    /*
     * The instant the list was evaluated at, which is the instant every signal in
     * it carries.
     *
     * This was `sessionOpen(now)` — 09:30 ET of the publication's NY date — while
     * `now` is the last completed session close and is threaded into `buildInput`
     * and stamped onto each signal as `generatedAt`. So the terminal's header
     * announced "AUG 17, 2026 / 09:30 ET" above a list whose every card linked to
     * a page reading "Generated Aug 17, 2026, 16:00 ET", from a model whose card
     * says it was fitted at 22:39 ET: a publication timestamped six and a half
     * hours before its own contents existed. `publishedAt` is typed and rendered
     * as an instant, and the NY calendar date it does not have to carry is
     * already carried by `publicationDate` above.
     *
     * `snapshot.computedAt` is `now` on both the cache-hit and cold paths, and is
     * named here rather than `now` because the coupling to the signals is the
     * whole point: whatever instant the snapshot was evaluated at is the instant
     * the publication is stamped with.
     */
    publishedAt: snapshot.computedAt,
    items,
    notice: composePublicationNotice(items.map((i) => i.symbol)),
    neutralityNotice: NEUTRALITY_NOTICE,
    modelVersion: snapshot.modelVersion,
  };
  return publication;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Chart data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standardises the OU spread window and aligns it to the daily bars.
 *
 * The window is the last ≤180 spread observations and `daily` is the last ≤180
 * bars, but the two are trimmed independently upstream, so the shorter one governs
 * and both are read from the tail.
 */
function ouZSeries(artefacts: ComputedFeatures['artefacts'], daily: readonly Bar[]): { time: number; z: number }[] {
  const window = artefacts.ouSpreadWindow;
  const n = Math.min(window.length, daily.length);
  if (n === 0) return [];
  const spreadTail = window.slice(window.length - n);
  const barTail = daily.slice(daily.length - n);
  return spreadTail.map((value, i) => ({
    time: (barTail[i] as Bar).time,
    z: ouZScore(artefacts.ou, value),
  }));
}

/** The published smile, or null when there is nothing calibrated to publish. */
function smileFor(artefacts: ComputedFeatures['artefacts'], now: number): ChartSeries['smile'] {
  const params = artefacts.sabr;
  const skew = artefacts.skew;
  if (params === null || skew === null || !params.converged) return null;
  const tau = params.dte / 365;
  const forward = params.forward;
  void now;
  return {
    tau,
    forward,
    curve: sabrSmileCurve(forward, tau, params),
    quotes: params.quotes,
    strike25Call: skew.strike25Call,
    strike25Put: skew.strike25Put,
    vol25Call: skew.vol25Call,
    vol25Put: skew.vol25Put,
    volAtm: skew.volAtm,
    riskReversal: (skew.vol25Call - skew.vol25Put) * 100,
    rmse: params.rmse,
  };
}

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
  /**
   * The OU spread standardised by the fitted equilibrium σ, aligned to the tail of
   * `daily`. This is the series the ±2σ entry rule is written against, so the
   * oscillator the terminal draws and the threshold the strategy fires on are the
   * same numbers.
   */
  ouZ: { time: number; z: number }[];
  /**
   * The calibrated SABR smile, or `null` when the name has no listed options or
   * the fit did not converge. Generated here rather than in the browser: the curve
   * is `sabrImpliedVol` evaluated across strikes, and a second evaluation in the
   * client would be a second implementation of the model that agrees with the
   * published RR₂₅ only by coincidence.
   */
  smile: {
    tau: number;
    forward: number;
    curve: { strike: number; logMoneyness: number; vol: number }[];
    /** The OPRA-style call quotes the fit was calibrated against. */
    quotes: { strike: number; vol: number }[];
    strike25Call: number;
    strike25Put: number;
    vol25Call: number;
    vol25Put: number;
    volAtm: number;
    /** RR₂₅ in vol points, matching the `rr25_30d` convention. */
    riskReversal: number;
    rmse: number;
  } | null;
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
    ouZ: ouZSeries(artefacts, daily),
    smile: smileFor(artefacts, result.features.now),
    vwap: artefacts.vwapValue,
  };
}
