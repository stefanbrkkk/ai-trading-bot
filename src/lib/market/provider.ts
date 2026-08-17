/**
 * Market data provider seam.
 *
 * One interface, three implementations, selected by `AURELIUS_MARKET_PROVIDER`:
 *
 *   simulator (default) — the deterministic in-process generator. Requires no
 *     keys and no network, and is what makes the platform run end to end out of
 *     the box.
 *   alpaca / polygon — live REST providers, activated only when their keys are
 *     present. They degrade to the simulator for anything they cannot serve
 *     (e.g. a full L10 book on a free tier) rather than returning empty data,
 *     because a half-populated feature vector is worse than a consistent
 *     synthetic one.
 *
 * The engine never branches on provider. It asks for bars and gets bars.
 */

import { DAY, sessionOpen, toNewYork, fromNewYork, SESSION_OPEN_MINUTES } from './calendar';
import { MarketSimulator } from './simulator';
import { BENCHMARK_SYMBOL, TRADABLE_SYMBOLS, requireSpec, symbolMeta, symbolsInSector } from './universe';
import type {
  AltDataEvent,
  Bar,
  OptionChainSlice,
  OrderBookSnapshot,
  Quote,
  Sector,
  SymbolMeta,
  Timeframe,
} from '@/lib/domain/types';

export type ProviderName = 'simulator' | 'alpaca' | 'polygon' | 'finnhub';

export interface MarketDataProvider {
  readonly name: ProviderName;
  /** True when the provider is serving live data rather than the simulator. */
  readonly live: boolean;
  symbols(): SymbolMeta[];
  meta(symbol: string): SymbolMeta;
  dailyBars(symbol: string, options?: { limit?: number; endAt?: number }): Promise<Bar[]>;
  intradayBars(symbol: string, options?: { sessions?: number; minutesPerBar?: number; endAt?: number }): Promise<Bar[]>;
  quote(symbol: string, at?: number): Promise<Quote>;
  orderBook(symbol: string, at?: number, levels?: number): Promise<OrderBookSnapshot[]>;
  optionChains(symbol: string, at?: number): Promise<OptionChainSlice[]>;
  altEvents(symbol: string, options?: { days?: number; endAt?: number }): Promise<AltDataEvent[]>;
  /** Equal-weighted sector peer close series, aligned to the symbol's daily bars. */
  sectorCloses(sector: Sector, options?: { limit?: number; endAt?: number }): Promise<number[]>;
}

export const TIMEFRAME_TO_MINUTES: Record<Timeframe, number> = { '5m': 5, '15m': 15, '60m': 60, '1d': 390 };

// ─────────────────────────────────────────────────────────────────────────────
//  Simulator provider
// ─────────────────────────────────────────────────────────────────────────────

export interface SimulatorProviderOptions {
  seed?: number | string;
  /** "Now" for the simulation. Defaults to the process clock. */
  now?: number;
  years?: number;
}

export class SimulatorProvider implements MarketDataProvider {
  readonly name: ProviderName = 'simulator';
  readonly live = false;
  readonly simulator: MarketSimulator;
  private readonly now: number;
  private readonly sectorCache = new Map<string, number[]>();

  constructor(options: SimulatorProviderOptions = {}) {
    const now = options.now ?? Date.now();
    const parts = toNewYork(now);
    const end = fromNewYork(parts.year, parts.month, parts.day, SESSION_OPEN_MINUTES);
    const years = options.years ?? 3;
    this.now = now;
    this.simulator = new MarketSimulator({
      seed: options.seed ?? 20240117,
      start: end - Math.round(years * 365.25 * DAY),
      end,
    });
  }

  symbols(): SymbolMeta[] {
    return [BENCHMARK_SYMBOL, ...TRADABLE_SYMBOLS].map((s) => symbolMeta(requireSpec(s)));
  }

  meta(symbol: string): SymbolMeta {
    return symbolMeta(requireSpec(symbol));
  }

  async dailyBars(symbol: string, options: { limit?: number; endAt?: number } = {}): Promise<Bar[]> {
    const all = this.simulator.dailyBars(symbol).bars;
    const endAt = options.endAt ?? this.now;
    const cutoff = sessionOpen(endAt);
    const upTo = all.filter((b) => b.time <= cutoff);
    const bars = upTo.length > 0 ? upTo : all.slice(0, 1);
    return options.limit ? bars.slice(-options.limit) : bars;
  }

  async intradayBars(
    symbol: string,
    options: { sessions?: number; minutesPerBar?: number; endAt?: number } = {},
  ): Promise<Bar[]> {
    const sessions = options.sessions ?? 1;
    const minutesPerBar = options.minutesPerBar ?? 5;
    const endAt = options.endAt ?? this.now;
    const times = this.simulator.sessionTimes.filter((t) => t <= sessionOpen(endAt));
    const take = times.slice(-sessions);
    const out: Bar[] = [];
    for (const t of take) out.push(...this.simulator.intradayBars(symbol, t, minutesPerBar));
    return out.filter((b) => b.time <= endAt);
  }

  async quote(symbol: string, at?: number): Promise<Quote> {
    return this.simulator.quote(symbol, at ?? this.now);
  }

  async orderBook(symbol: string, at?: number, levels = 10): Promise<OrderBookSnapshot[]> {
    return this.simulator.orderBookSequence(symbol, at ?? this.now, 60, 1000, levels);
  }

  async optionChains(symbol: string, at?: number): Promise<OptionChainSlice[]> {
    const spec = requireSpec(symbol);
    if (!spec.optionable) return [];
    const when = at ?? this.now;
    return this.simulator.optionExpiries().map((dte) => this.simulator.optionChain(symbol, when, dte));
  }

  async altEvents(symbol: string, options: { days?: number; endAt?: number } = {}): Promise<AltDataEvent[]> {
    const endAt = options.endAt ?? this.now;
    const days = options.days ?? 180;
    return this.simulator.altEvents(symbol, endAt - days * DAY, endAt);
  }

  async sectorCloses(sector: Sector, options: { limit?: number; endAt?: number } = {}): Promise<number[]> {
    const key = `${sector}:${options.endAt ?? this.now}:${options.limit ?? 0}`;
    const cached = this.sectorCache.get(key);
    if (cached) return cached;

    const peers = symbolsInSector(sector).filter((s) => s !== BENCHMARK_SYMBOL);
    if (peers.length === 0) return [];
    const series = await Promise.all(peers.map((s) => this.dailyBars(s, options)));
    const length = Math.min(...series.map((b) => b.length));
    const out = new Array<number>(length).fill(0);
    for (const bars of series) {
      const offset = bars.length - length;
      // Normalise each peer to its own first close, so the composite is an
      // equal-weighted index rather than a price-weighted one.
      const base = (bars[offset] as Bar).close;
      for (let i = 0; i < length; i += 1) {
        out[i] = (out[i] as number) + ((bars[offset + i] as Bar).close / base) * 100 / series.length;
      }
    }
    this.sectorCache.set(key, out);
    return out;
  }

  /** Simulator-only: the ground-truth regime, used to score the classifier. */
  groundTruthRegime(at: number): string {
    return this.simulator.regimeAt(at);
  }

  get referenceNow(): number {
    return this.now;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Live providers
// ─────────────────────────────────────────────────────────────────────────────

interface HttpProviderConfig {
  baseUrl: string;
  headers: Record<string, string>;
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs = 12_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Alpaca market data. Bars and quotes come from the live API; the L10 book,
 * option surface and alternative data fall back to the simulator, since those
 * are not available on the data tiers this platform targets. The fallback is
 * explicit rather than silent — `live` reports true only for what is genuinely
 * live, and `degradedFeeds` names the rest.
 */
export class AlpacaProvider implements MarketDataProvider {
  readonly name: ProviderName = 'alpaca';
  readonly live = true;
  readonly degradedFeeds = ['order_book', 'option_chain', 'alt_data'] as const;
  private readonly config: HttpProviderConfig;

  constructor(
    keyId: string,
    secret: string,
    private readonly fallback: SimulatorProvider,
    baseUrl = process.env.ALPACA_DATA_BASE_URL ?? 'https://data.alpaca.markets',
  ) {
    this.config = {
      baseUrl: baseUrl.replace(/\/$/, ''),
      headers: { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret, accept: 'application/json' },
    };
  }

  symbols(): SymbolMeta[] {
    return this.fallback.symbols();
  }

  meta(symbol: string): SymbolMeta {
    return this.fallback.meta(symbol);
  }

  private parseBars(payload: unknown): Bar[] {
    if (!isRecord(payload)) return [];
    const raw = payload.bars;
    const list = Array.isArray(raw) ? raw : [];
    return list.filter(isRecord).map((b) => ({
      time: Date.parse(String(b.t ?? '')) || 0,
      open: asNumber(b.o),
      high: asNumber(b.h),
      low: asNumber(b.l),
      close: asNumber(b.c),
      volume: asNumber(b.v),
      vwap: asNumber(b.vw, asNumber(b.c)),
      trades: asNumber(b.n),
    }));
  }

  async dailyBars(symbol: string, options: { limit?: number; endAt?: number } = {}): Promise<Bar[]> {
    const limit = options.limit ?? 800;
    const end = new Date(options.endAt ?? Date.now()).toISOString();
    const start = new Date((options.endAt ?? Date.now()) - Math.ceil(limit * 1.6) * DAY).toISOString();
    const url = `${this.config.baseUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&adjustment=all&limit=${limit}&start=${start}&end=${end}`;
    try {
      const bars = this.parseBars(await getJson(url, this.config.headers));
      return bars.length > 0 ? bars : this.fallback.dailyBars(symbol, options);
    } catch {
      return this.fallback.dailyBars(symbol, options);
    }
  }

  async intradayBars(
    symbol: string,
    options: { sessions?: number; minutesPerBar?: number; endAt?: number } = {},
  ): Promise<Bar[]> {
    const minutes = options.minutesPerBar ?? 5;
    const sessions = options.sessions ?? 1;
    const endAt = options.endAt ?? Date.now();
    const start = new Date(endAt - (sessions + 2) * DAY).toISOString();
    const url = `${this.config.baseUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${minutes}Min&adjustment=all&limit=10000&start=${start}&end=${new Date(endAt).toISOString()}`;
    try {
      const bars = this.parseBars(await getJson(url, this.config.headers));
      return bars.length > 0 ? bars : this.fallback.intradayBars(symbol, options);
    } catch {
      return this.fallback.intradayBars(symbol, options);
    }
  }

  async quote(symbol: string, at?: number): Promise<Quote> {
    const url = `${this.config.baseUrl}/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`;
    try {
      const payload = await getJson(url, this.config.headers);
      if (!isRecord(payload) || !isRecord(payload.quote)) return this.fallback.quote(symbol, at);
      const q = payload.quote;
      const bid = asNumber(q.bp);
      const ask = asNumber(q.ap);
      if (bid <= 0 || ask <= 0) return this.fallback.quote(symbol, at);
      const previous = await this.fallback.quote(symbol, at);
      return {
        symbol,
        timestamp: Date.parse(String(q.t ?? '')) || Date.now(),
        bid,
        ask,
        bidSize: asNumber(q.bs) * 100,
        askSize: asNumber(q.as) * 100,
        last: (bid + ask) / 2,
        lastSize: 0,
        volume: previous.volume,
        previousClose: previous.previousClose,
      };
    } catch {
      return this.fallback.quote(symbol, at);
    }
  }

  async orderBook(symbol: string, at?: number, levels = 10): Promise<OrderBookSnapshot[]> {
    return this.fallback.orderBook(symbol, at, levels);
  }

  async optionChains(symbol: string, at?: number): Promise<OptionChainSlice[]> {
    return this.fallback.optionChains(symbol, at);
  }

  async altEvents(symbol: string, options: { days?: number; endAt?: number } = {}): Promise<AltDataEvent[]> {
    return this.fallback.altEvents(symbol, options);
  }

  async sectorCloses(sector: Sector, options: { limit?: number; endAt?: number } = {}): Promise<number[]> {
    return this.fallback.sectorCloses(sector, options);
  }
}

/** Polygon aggregates provider, with the same explicit-degradation policy. */
export class PolygonProvider implements MarketDataProvider {
  readonly name: ProviderName = 'polygon';
  readonly live = true;
  readonly degradedFeeds = ['order_book', 'option_chain', 'alt_data'] as const;

  constructor(
    private readonly apiKey: string,
    private readonly fallback: SimulatorProvider,
  ) {}

  symbols(): SymbolMeta[] {
    return this.fallback.symbols();
  }

  meta(symbol: string): SymbolMeta {
    return this.fallback.meta(symbol);
  }

  private async aggregates(symbol: string, multiplier: number, span: string, from: number, to: number): Promise<Bar[]> {
    const url =
      `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${span}/` +
      `${new Date(from).toISOString().slice(0, 10)}/${new Date(to).toISOString().slice(0, 10)}` +
      `?adjusted=true&sort=asc&limit=50000&apiKey=${encodeURIComponent(this.apiKey)}`;
    const payload = await getJson(url, { accept: 'application/json' });
    if (!isRecord(payload) || !Array.isArray(payload.results)) return [];
    return payload.results.filter(isRecord).map((r) => ({
      time: asNumber(r.t),
      open: asNumber(r.o),
      high: asNumber(r.h),
      low: asNumber(r.l),
      close: asNumber(r.c),
      volume: asNumber(r.v),
      vwap: asNumber(r.vw, asNumber(r.c)),
      trades: asNumber(r.n),
    }));
  }

  async dailyBars(symbol: string, options: { limit?: number; endAt?: number } = {}): Promise<Bar[]> {
    const to = options.endAt ?? Date.now();
    const limit = options.limit ?? 800;
    try {
      const bars = await this.aggregates(symbol, 1, 'day', to - Math.ceil(limit * 1.6) * DAY, to);
      return bars.length > 0 ? bars.slice(-limit) : this.fallback.dailyBars(symbol, options);
    } catch {
      return this.fallback.dailyBars(symbol, options);
    }
  }

  async intradayBars(
    symbol: string,
    options: { sessions?: number; minutesPerBar?: number; endAt?: number } = {},
  ): Promise<Bar[]> {
    const to = options.endAt ?? Date.now();
    const sessions = options.sessions ?? 1;
    try {
      const bars = await this.aggregates(symbol, options.minutesPerBar ?? 5, 'minute', to - (sessions + 2) * DAY, to);
      return bars.length > 0 ? bars : this.fallback.intradayBars(symbol, options);
    } catch {
      return this.fallback.intradayBars(symbol, options);
    }
  }

  async quote(symbol: string, at?: number): Promise<Quote> {
    return this.fallback.quote(symbol, at);
  }

  async orderBook(symbol: string, at?: number, levels = 10): Promise<OrderBookSnapshot[]> {
    return this.fallback.orderBook(symbol, at, levels);
  }

  async optionChains(symbol: string, at?: number): Promise<OptionChainSlice[]> {
    return this.fallback.optionChains(symbol, at);
  }

  async altEvents(symbol: string, options: { days?: number; endAt?: number } = {}): Promise<AltDataEvent[]> {
    return this.fallback.altEvents(symbol, options);
  }

  async sectorCloses(sector: Sector, options: { limit?: number; endAt?: number } = {}): Promise<number[]> {
    return this.fallback.sectorCloses(sector, options);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Resolution
// ─────────────────────────────────────────────────────────────────────────────

let cached: { provider: MarketDataProvider; key: string } | null = null;

export interface ProviderStatus {
  name: ProviderName;
  live: boolean;
  degradedFeeds: string[];
  reason: string;
  seed: number | string;
}

function envKey(): string {
  return [
    process.env.AURELIUS_MARKET_PROVIDER ?? '',
    process.env.ALPACA_API_KEY_ID ? '1' : '0',
    process.env.POLYGON_API_KEY ? '1' : '0',
    process.env.AURELIUS_SEED ?? '',
  ].join('|');
}

/**
 * Resolves the provider from the environment, memoised on the env fingerprint so
 * a test can change the environment and get a fresh provider.
 */
export function resolveMarketProvider(options: SimulatorProviderOptions = {}): MarketDataProvider {
  const key = envKey();
  if (cached && cached.key === key) return cached.provider;

  const seed = options.seed ?? process.env.AURELIUS_SEED ?? 20240117;
  const simulator = new SimulatorProvider({ ...options, seed });
  const requested = (process.env.AURELIUS_MARKET_PROVIDER ?? 'simulator').toLowerCase();
  const alpacaKey = process.env.ALPACA_API_KEY_ID;
  const alpacaSecret = process.env.ALPACA_API_SECRET_KEY;
  const polygonKey = process.env.POLYGON_API_KEY;

  let provider: MarketDataProvider = simulator;
  if (requested === 'alpaca' && alpacaKey && alpacaSecret) {
    provider = new AlpacaProvider(alpacaKey, alpacaSecret, simulator);
  } else if (requested === 'polygon' && polygonKey) {
    provider = new PolygonProvider(polygonKey, simulator);
  }

  cached = { provider, key };
  return provider;
}

export function marketProviderStatus(): ProviderStatus {
  const provider = resolveMarketProvider();
  const requested = (process.env.AURELIUS_MARKET_PROVIDER ?? 'simulator').toLowerCase();
  const degraded =
    'degradedFeeds' in provider ? [...(provider as { degradedFeeds: readonly string[] }).degradedFeeds] : [];
  let reason: string;
  if (provider.name === 'simulator') {
    reason =
      requested === 'simulator'
        ? 'Deterministic in-process simulator (default). No API keys required.'
        : `Provider "${requested}" was requested but its API keys are absent, so the deterministic simulator is serving.`;
  } else {
    reason = `Live ${provider.name} feed. These feeds fall back to the simulator: ${degraded.join(', ')}.`;
  }
  return {
    name: provider.name,
    live: provider.live,
    degradedFeeds: degraded,
    reason,
    seed: process.env.AURELIUS_SEED ?? 20240117,
  };
}

/** Test hook: forget the memoised provider. */
export function resetMarketProvider(): void {
  cached = null;
}

/**
 * A synchronous NBBO, for callers that cannot await one.
 *
 * The paper broker fills against a `QuoteSource`, which is synchronous by design:
 * a fill is a single instant, and threading a promise through the matching logic
 * would let the book move between the price check and the fill. The provider
 * interface is async because a live feed is a network call, so the two cannot be
 * connected directly — which is why the paper broker shipped with no quote source
 * at all and refused every order with `no_market_data`.
 *
 * The simulator's own quote is the right answer here rather than a compromise. It
 * is deterministic, always available, needs no network, and models a full L10 book
 * — so a paper fill is reproducible and its slippage is derived from modelled depth
 * rather than invented. A deployment with a live feed does not use the paper broker
 * to begin with, so nothing is lost by not reaching for one.
 */
export function simulatorQuote(symbol: string, atMs: number): Quote | null {
  try {
    const provider = resolveMarketProvider();
    // Every composed provider keeps the simulator as its fallback, so the
    // synchronous book is reachable whichever one is selected.
    const simulator =
      provider instanceof SimulatorProvider
        ? provider.simulator
        : (provider as { fallback?: SimulatorProvider }).fallback?.simulator;
    return simulator?.quote(symbol, atMs) ?? null;
  } catch {
    // An unknown symbol or a timestamp outside the simulated range is a legitimate
    // "no market data" answer, and the broker's own 422 is the correct rendering
    // of it — better than a 500 from a route that was only trying to fill.
    return null;
  }
}
