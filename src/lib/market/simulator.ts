/**
 * Deterministic market simulator.
 *
 * The platform must run end-to-end with an empty `.env`, so the default market
 * data provider is a synthetic generator rather than a stub. It is built to
 * exhibit the statistical properties the quant core is designed to detect —
 * otherwise the OU calibrator, the regime classifier and the MLOFI/PCA filter
 * would be measuring nothing:
 *
 *   • A three-state Markov regime process (trend / mean-reversion / stress) with
 *     persistent transition probabilities, so the regime classifier has real
 *     regimes to find.
 *   • GARCH(1,1) conditional volatility on the market factor — volatility
 *     clustering and heteroskedasticity, which is exactly what Phase 1 §4 says
 *     static σ-channels cannot handle and the Kalman filter can.
 *   • A market factor + eleven sector factors + an Ornstein–Uhlenbeck
 *     idiosyncratic component, so β, relative strength and the OU half-life all
 *     have genuine signal.
 *   • Merton jumps at session boundaries, producing the overnight gaps the
 *     gap-and-go strategies trade.
 *   • Intraday volume and volatility U-curves, a realistic limit order book
 *     whose depth decays geometrically and skews with the idiosyncratic drift,
 *     and an options surface with a negative equity skew.
 *
 * Every draw comes from the seeded xoshiro generator, so a given
 * (seed, symbol, timestamp) always yields the same bar.
 */

import {
  DAY,
  MINUTE,
  SESSION_OPEN_MINUTES,
  fromNewYork,
  minutesSinceOpen,
  sessionMinutes,
  sessionOpen,
  toNewYork,
  tradingDaysBetween,
} from './calendar';
import { BENCHMARK_SYMBOL, UNIVERSE, type UniverseSpec, requireSpec } from './universe';
import { type Rng, createRng, hashSeed } from '@/lib/quant/rng';
import { clamp } from '@/lib/quant/stats';
import { blackScholes } from '@/lib/quant/blackscholes';
import { type SabrParams, sabrImpliedVol } from '@/lib/quant/sabr';
import type {
  AltDataEvent,
  Bar,
  OptionChainSlice,
  OptionQuote,
  OrderBookSnapshot,
  Quote,
  Sector,
} from '@/lib/domain/types';
import type { AltDataStream } from '@/lib/quant/decay';

const TRADING_DAYS_PER_YEAR = 252;

// ─────────────────────────────────────────────────────────────────────────────
//  Regime process
// ─────────────────────────────────────────────────────────────────────────────

export type SimRegime = 'trend' | 'revert' | 'stress';

/**
 * Row-stochastic transition matrix. Diagonals are high so regimes persist for
 * weeks rather than flickering day to day — persistence is what makes regime
 * detection a meaningful problem.
 */
const TRANSITIONS: Record<SimRegime, { to: SimRegime; p: number }[]> = {
  trend: [
    { to: 'trend', p: 0.965 },
    { to: 'revert', p: 0.028 },
    { to: 'stress', p: 0.007 },
  ],
  revert: [
    { to: 'revert', p: 0.955 },
    { to: 'trend', p: 0.038 },
    { to: 'stress', p: 0.007 },
  ],
  stress: [
    { to: 'stress', p: 0.9 },
    { to: 'revert', p: 0.07 },
    { to: 'trend', p: 0.03 },
  ],
};

const REGIME_PARAMS: Record<SimRegime, { driftMult: number; volMult: number; reversionMult: number }> = {
  trend: { driftMult: 1.6, volMult: 0.85, reversionMult: 0.35 },
  revert: { driftMult: 0.2, volMult: 1.0, reversionMult: 2.4 },
  stress: { driftMult: -2.2, volMult: 2.6, reversionMult: 0.9 },
};

function stepRegime(current: SimRegime, u: number): SimRegime {
  let acc = 0;
  for (const t of TRANSITIONS[current]) {
    acc += t.p;
    if (u <= acc) return t.to;
  }
  return current;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Simulator
// ─────────────────────────────────────────────────────────────────────────────

export interface SimulatorOptions {
  seed?: number | string;
  /** Inclusive first session (epoch ms). */
  start: number;
  /** Inclusive last session (epoch ms). */
  end: number;
  /** Risk-free rate used for option pricing. */
  riskFreeRate?: number;
}

export interface DailySeries {
  symbol: string;
  bars: Bar[];
  /** Regime label per bar — ground truth the classifier is scored against. */
  regimes: SimRegime[];
  /** Conditional annualised volatility per bar. */
  conditionalVol: number[];
}

export interface MarketFactorPath {
  /** Session-open instants. */
  times: number[];
  /** Daily log return of the market factor. */
  returns: number[];
  /** GARCH conditional daily σ. */
  sigma: number[];
  regimes: SimRegime[];
}

export class MarketSimulator {
  readonly seed: number;
  readonly start: number;
  readonly end: number;
  readonly riskFreeRate: number;
  private readonly sessions: number[];
  private marketPath: MarketFactorPath | null = null;
  private readonly sectorPaths = new Map<Sector, number[]>();
  private readonly dailyCache = new Map<string, DailySeries>();

  constructor(options: SimulatorOptions) {
    this.seed = hashSeed(options.seed ?? 20240117);
    this.start = options.start;
    this.end = options.end;
    this.riskFreeRate = options.riskFreeRate ?? 0.042;
    this.sessions = tradingDaysBetween(options.start, options.end);
    if (this.sessions.length === 0) {
      throw new Error('MarketSimulator: no trading sessions in the requested range');
    }
  }

  get sessionCount(): number {
    return this.sessions.length;
  }

  get sessionTimes(): number[] {
    return this.sessions.slice();
  }

  private rngFor(scope: string): Rng {
    return createRng(`${this.seed}:${scope}`);
  }

  /**
   * Market factor path: GARCH(1,1) volatility with regime-dependent drift.
   *
   *   σ²_t = ω + α·ε²_{t−1} + β·σ²_{t−1}
   *   r_t  = μ(regime_t)/252 + σ_t · z_t ,  z_t ~ t₆ scaled to unit variance
   *
   * Student-t innovations give the fat tails that make the tail-risk metrics
   * (CVaR, copula tail dependence, 25Δ risk reversal) non-degenerate.
   */
  marketFactor(): MarketFactorPath {
    if (this.marketPath) return this.marketPath;
    const rng = this.rngFor('market');
    const n = this.sessions.length;
    const omega = 2.4e-6;
    const alpha = 0.09;
    const beta = 0.88;
    const longRunVar = omega / (1 - alpha - beta);

    const returns = new Array<number>(n).fill(0);
    const sigma = new Array<number>(n).fill(Math.sqrt(longRunVar));
    const regimes = new Array<SimRegime>(n).fill('trend');

    let variance = longRunVar;
    let regime: SimRegime = 'trend';
    const nu = 6;
    const tScale = Math.sqrt((nu - 2) / nu); // rescale t₆ to unit variance

    for (let i = 0; i < n; i += 1) {
      regime = i === 0 ? 'trend' : stepRegime(regime, rng.next());
      regimes[i] = regime;
      const params = REGIME_PARAMS[regime];

      // The regime multiplier scales the *observed* return only. Feeding the
      // multiplied innovation back into the recursion would make the effective
      // persistence α·volMult² + β > 1 in the stress state and the variance
      // would diverge; the GARCH state must evolve on the unscaled innovation.
      const baseSigma = Math.sqrt(variance);
      const z = rng.studentT(nu) * tScale;
      const baseEps = baseSigma * z;
      const s = baseSigma * params.volMult;
      sigma[i] = s;
      const drift = (0.075 * params.driftMult) / TRADING_DAYS_PER_YEAR;
      returns[i] = drift + s * z;
      variance = omega + alpha * baseEps * baseEps + beta * variance;
    }

    this.marketPath = { times: this.sessions.slice(), returns, sigma, regimes };
    return this.marketPath;
  }

  /** Sector factor: AR(1) around zero, partially loaded on the market factor. */
  sectorFactor(sector: Sector): number[] {
    const cached = this.sectorPaths.get(sector);
    if (cached) return cached;
    const rng = this.rngFor(`sector:${sector}`);
    const market = this.marketFactor();
    const n = this.sessions.length;
    const out = new Array<number>(n).fill(0);
    const phi = 0.94;
    const sd = 0.006;
    let level = 0;
    for (let i = 0; i < n; i += 1) {
      level = phi * level + sd * rng.normal();
      out[i] = level + 0.18 * (market.returns[i] as number);
    }
    this.sectorPaths.set(sector, out);
    return out;
  }

  /**
   * Daily OHLCV for one symbol.
   *
   *   r_t = β_m·f^market_t + β_s·f^sector_t + idio_t + jump_t
   *   idio_t = idio_{t−1}·e^{−θ/252} + σ_idio/√252 · z_t   (OU, mean 0)
   *
   * The OU idiosyncratic component is what the OU/MLE calibrator recovers, and
   * `reversionTheta` per symbol gives a real cross-section of half-lives.
   */
  dailyBars(symbol: string): DailySeries {
    const cached = this.dailyCache.get(symbol);
    if (cached) return cached;

    const spec = requireSpec(symbol);
    const rng = this.rngFor(`daily:${symbol}`);
    const market = this.marketFactor();
    const sector = this.sectorFactor(spec.sector);
    const n = this.sessions.length;

    const bars: Bar[] = [];
    const regimes: SimRegime[] = [];
    const conditionalVol: number[] = [];

    let price = spec.basePrice;
    let idio = 0;
    let previousIdio = 0;
    // Rewind the price so the *last* bar lands near basePrice, which keeps the
    // universe's quoted price levels meaningful.
    const totalDrift = (spec.drift / TRADING_DAYS_PER_YEAR) * n;
    price = spec.basePrice * Math.exp(-totalDrift);

    const dailyIdioSd = spec.idioVol / Math.sqrt(TRADING_DAYS_PER_YEAR);
    const jumpProb = spec.jumpIntensity / TRADING_DAYS_PER_YEAR;

    for (let i = 0; i < n; i += 1) {
      const time = this.sessions[i] as number;
      const regime = market.regimes[i] as SimRegime;
      const params = REGIME_PARAMS[regime];
      regimes.push(regime);

      const decay = Math.exp((-spec.reversionTheta * params.reversionMult) / TRADING_DAYS_PER_YEAR);
      idio = idio * decay + dailyIdioSd * params.volMult * rng.normal();

      let jump = 0;
      if (rng.bernoulli(jumpProb)) {
        jump = spec.jumpSigma * rng.studentT(4) * 0.7;
      }

      const systematic =
        spec.marketBeta * (market.returns[i] as number) + spec.sectorBeta * (sector[i] as number) * 0.5;
      // The idiosyncratic *level* must move the price level, so the log return
      // carries its increment (cumsum of increments reproduces the level).
      const idioIncrement = idio - previousIdio;
      const drift = spec.drift / TRADING_DAYS_PER_YEAR;
      const logReturn = drift + systematic + idioIncrement + jump;
      previousIdio = idio;

      const prevClose = price;
      const close = prevClose * Math.exp(logReturn);

      // Split the session into an overnight gap and an intraday range.
      const gapShare = 0.32;
      const open = prevClose * Math.exp(logReturn * gapShare + 0.0008 * rng.normal());
      const dayVol = Math.abs(logReturn) + Math.abs(spec.marketBeta) * (market.sigma[i] as number) * 0.9;
      const range = Math.max(dayVol, 0.0035) * (1.4 + 0.7 * rng.next());
      const mid = (open + close) / 2;
      const high = Math.max(open, close) + mid * range * 0.45 * rng.next();
      const low = Math.min(open, close) - mid * range * 0.45 * rng.next();

      // Volume: log-normal around ADV, boosted by |return| and by stress.
      const volumeShock = Math.exp(0.34 * rng.normal() + 2.6 * Math.abs(logReturn));
      const regimeVolume = regime === 'stress' ? 1.7 : regime === 'revert' ? 1.0 : 0.92;
      const volume = Math.max(1000, Math.round(spec.adv30 * volumeShock * regimeVolume));

      const typical = (high + low + close) / 3;
      bars.push({
        time,
        open: round2(open),
        high: round2(Math.max(high, open, close)),
        low: round2(Math.min(low, open, close, high)),
        close: round2(close),
        volume,
        vwap: round4(typical * (1 + 0.0006 * rng.normal())),
        trades: Math.max(1, Math.round(volume / (140 + 90 * rng.next()))),
      });
      conditionalVol.push((market.sigma[i] as number) * spec.marketBeta * Math.sqrt(TRADING_DAYS_PER_YEAR) + spec.idioVol);
      price = close;
    }

    const series: DailySeries = { symbol, bars, regimes, conditionalVol };
    this.dailyCache.set(symbol, series);
    return series;
  }

  /**
   * Intraday 5-minute bars for one session, constructed as a Brownian bridge
   * between the session's open and close so the intraday path is consistent with
   * the daily bar, with a U-shaped volatility and volume profile layered on.
   */
  intradayBars(symbol: string, sessionTime: number, minutesPerBar = 5): Bar[] {
    const spec = requireSpec(symbol);
    const daily = this.dailyBars(symbol);
    const open = sessionOpen(sessionTime);
    const index = daily.bars.findIndex((b) => sessionOpen(b.time) === open);
    if (index < 0) return [];
    const bar = daily.bars[index] as Bar;
    const totalMinutes = sessionMinutes(open);
    const steps = Math.floor(totalMinutes / minutesPerBar);
    if (steps <= 0) return [];

    const rng = this.rngFor(`intraday:${symbol}:${open}`);
    const logOpen = Math.log(bar.open);
    const logClose = Math.log(bar.close);
    const dayRange = Math.log(bar.high / Math.max(bar.low, 1e-6));
    const stepSigma = Math.max(dayRange / Math.sqrt(steps) / 3.2, 1e-5);

    // U-shaped intraday activity: high at the open and the close, trough midday.
    const profile: number[] = [];
    let profileSum = 0;
    for (let i = 0; i < steps; i += 1) {
      const u = (i + 0.5) / steps;
      const shape = 0.55 + 1.35 * (Math.exp(-8 * u) + Math.exp(-7 * (1 - u)));
      profile.push(shape);
      profileSum += shape;
    }

    // Brownian bridge on the log price, then rescale so the extremes reproduce
    // the daily high/low.
    const increments: number[] = [];
    for (let i = 0; i < steps; i += 1) {
      increments.push(stepSigma * (profile[i] as number) * rng.normal());
    }
    const path: number[] = [];
    let acc = 0;
    for (let i = 0; i < steps; i += 1) {
      acc += increments[i] as number;
      path.push(acc);
    }
    const endpoint = path[steps - 1] as number;
    for (let i = 0; i < steps; i += 1) {
      const t = (i + 1) / steps;
      path[i] = (path[i] as number) - endpoint * t + (logClose - logOpen) * t;
    }

    const pathMax = Math.max(...path, 0);
    const pathMin = Math.min(...path, 0);
    const targetMax = Math.log(bar.high) - logOpen;
    const targetMin = Math.log(bar.low) - logOpen;
    const upScale = pathMax > 1e-9 ? Math.min(2.5, Math.max(targetMax, 0) / pathMax) : 1;
    const downScale = pathMin < -1e-9 ? Math.min(2.5, Math.min(targetMin, 0) / pathMin) : 1;

    const bars: Bar[] = [];
    let prevLog = logOpen;
    for (let i = 0; i < steps; i += 1) {
      const raw = path[i] as number;
      const scaled = raw >= 0 ? raw * upScale : raw * downScale;
      const closeLog = logOpen + scaled;
      const o = Math.exp(prevLog);
      const c = Math.exp(closeLog);
      const wiggle = stepSigma * (profile[i] as number) * 0.6;
      const h = Math.max(o, c) * Math.exp(Math.abs(wiggle) * rng.next());
      const l = Math.min(o, c) * Math.exp(-Math.abs(wiggle) * rng.next());
      const shareOfVolume = (profile[i] as number) / profileSum;
      const volume = Math.max(100, Math.round(bar.volume * shareOfVolume * Math.exp(0.22 * rng.normal())));
      const typical = (h + l + c) / 3;
      bars.push({
        time: open + i * minutesPerBar * MINUTE,
        open: round2(o),
        high: round2(h),
        low: round2(l),
        close: round2(c),
        volume,
        vwap: round4(typical),
        trades: Math.max(1, Math.round(volume / (110 + 70 * rng.next()))),
      });
      prevLog = closeLog;
    }

    // Force the final close to the daily close so the two resolutions reconcile.
    const lastBar = bars[bars.length - 1] as Bar;
    lastBar.close = bar.close;
    lastBar.high = Math.max(lastBar.high, bar.close);
    lastBar.low = Math.min(lastBar.low, bar.close);
    void spec;
    return bars;
  }

  /** Concatenated intraday bars for the last `sessions` sessions. */
  recentIntraday(symbol: string, sessions: number, minutesPerBar = 5): Bar[] {
    const take = this.sessions.slice(Math.max(0, this.sessions.length - sessions));
    const out: Bar[] = [];
    for (const s of take) out.push(...this.intradayBars(symbol, s, minutesPerBar));
    return out;
  }

  /** Top-of-book quote at an instant. */
  quote(symbol: string, at: number): Quote {
    const spec = requireSpec(symbol);
    const daily = this.dailyBars(symbol);
    const last = this.priceAt(symbol, at);
    const idx = this.sessionIndexFor(at);
    const previousClose = idx > 0 ? (daily.bars[idx - 1] as Bar).close : (daily.bars[0] as Bar).open;

    const rng = createRng(`${this.seed}:quote:${symbol}:${Math.floor(at / MINUTE)}`);
    const phase = minutesSinceOpen(at) / Math.max(1, sessionMinutes(at));
    // Spreads are widest at the open and narrow through the session.
    const spreadMult = 1 + 1.6 * Math.exp(-6 * phase);
    const halfSpread = (last * (spec.spreadBps / 10_000) * spreadMult) / 2;
    const bid = round2(last - halfSpread);
    const ask = round2(last + halfSpread);
    const baseSize = Math.max(1, Math.round((spec.adv30 / 3900) * (0.4 + 1.2 * rng.next())));

    const bar = daily.bars[idx] as Bar;
    const sessionProgress = clamp(phase, 0, 1);
    return {
      symbol,
      timestamp: at,
      bid,
      ask,
      bidSize: baseSize,
      askSize: Math.max(1, Math.round(baseSize * (0.7 + 0.6 * rng.next()))),
      last: round2(last),
      lastSize: Math.max(1, Math.round(baseSize * 0.2 * rng.next() + 1)),
      volume: Math.round(bar.volume * sessionProgress),
      previousClose,
    };
  }

  /**
   * Level-`levels` limit order book.
   *
   * Depth decays geometrically away from the touch and is skewed by the
   * short-horizon drift, so the MLOFI/PCA pipeline sees a first principal
   * component that genuinely tracks directional intent instead of noise.
   */
  orderBook(symbol: string, at: number, levels = 10): OrderBookSnapshot {
    const spec = requireSpec(symbol);
    const q = this.quote(symbol, at);
    const rng = createRng(`${this.seed}:book:${symbol}:${Math.floor(at / (5 * MINUTE))}:${at % (5 * MINUTE)}`);
    const tick = Math.max(0.01, round2(q.last * 0.00008));
    const drift = this.shortHorizonDrift(symbol, at);
    // Positive drift ⇒ thicker bids, thinner offers.
    const skew = clamp(drift * 26, -0.6, 0.6);

    const bids: { price: number; size: number }[] = [];
    const asks: { price: number; size: number }[] = [];
    const baseSize = Math.max(1, (spec.adv30 / 3900) * 0.9);

    for (let m = 0; m < levels; m += 1) {
      const decay = Math.exp(-m / 4.2);
      const noiseB = 0.55 + 0.9 * rng.next();
      const noiseA = 0.55 + 0.9 * rng.next();
      bids.push({
        price: round2(q.bid - m * tick),
        size: Math.max(1, Math.round(baseSize * decay * noiseB * (1 + skew))),
      });
      asks.push({
        price: round2(q.ask + m * tick),
        size: Math.max(1, Math.round(baseSize * decay * noiseA * (1 - skew))),
      });
    }
    return { timestamp: at, bids, asks };
  }

  /** A sequence of book snapshots `stepMs` apart — the MLOFI input. */
  orderBookSequence(symbol: string, endAt: number, count = 60, stepMs = 1000, levels = 10): OrderBookSnapshot[] {
    const out: OrderBookSnapshot[] = [];
    for (let i = count - 1; i >= 0; i -= 1) out.push(this.orderBook(symbol, endAt - i * stepMs, levels));
    return out;
  }

  /**
   * Options chain for one expiry, priced off a SABR surface whose ρ is negative
   * (equity skew) and whose ν scales with the symbol's own volatility. The
   * resulting smile is what `calibrateSabr` recovers and what the 25Δ risk
   * reversal is extracted from.
   */
  optionChain(symbol: string, at: number, dte: number): OptionChainSlice {
    const spec = requireSpec(symbol);
    const spot = this.priceAt(symbol, at);
    const tau = Math.max(dte, 1) / 365;
    const forward = spot * Math.exp((this.riskFreeRate - spec.dividendYield) * tau);
    const rng = createRng(`${this.seed}:opt:${symbol}:${Math.floor(at / DAY)}:${dte}`);

    const realised = this.realisedVolatility(symbol, at, 20);
    // Variance risk premium: implied sits above realised.
    const atmVol = clamp(realised * (1.06 + 0.12 * rng.next()), 0.08, 2.5);
    const params: SabrParams = {
      alpha: atmVol * Math.pow(forward, 0.5),
      beta: 0.5,
      rho: clamp(-0.32 - 0.22 * rng.next() - 0.1 * spec.marketBeta, -0.92, -0.05),
      nu: clamp(0.42 + 0.9 * spec.idioVol + 0.2 * rng.next(), 0.1, 2.6),
    };

    const strikeStep = strikeIncrement(spot);
    const centre = Math.round(spot / strikeStep) * strikeStep;
    const quotes: OptionQuote[] = [];
    const width = 9;
    for (let k = -width; k <= width; k += 1) {
      const strike = round2(centre + k * strikeStep);
      if (strike <= 0) continue;
      const iv = sabrImpliedVol(forward, strike, tau, params);
      for (const type of ['call', 'put'] as const) {
        const g = blackScholes({
          spot,
          strike,
          tau,
          vol: iv,
          rate: this.riskFreeRate,
          dividend: spec.dividendYield,
          type,
        });
        const mid = Math.max(g.price, 0.01);
        const relSpread = clamp(0.02 + 0.35 / Math.max(1, mid * 8), 0.01, 0.4);
        const moneyness = Math.abs(Math.log(strike / spot));
        const oiBase = spec.adv30 / 900;
        quotes.push({
          symbol,
          strike,
          expiry: at + dte * DAY,
          type,
          bid: round2(Math.max(0.01, mid * (1 - relSpread / 2))),
          ask: round2(mid * (1 + relSpread / 2)),
          mid: round4(mid),
          impliedVolatility: round4(iv),
          delta: round4(g.delta),
          gamma: round4(g.gamma),
          vega: round4(g.vega),
          theta: round4(g.theta),
          openInterest: Math.max(0, Math.round(oiBase * Math.exp(-moneyness * 9) * (0.4 + rng.next()))),
          volume: Math.max(0, Math.round(oiBase * 0.14 * Math.exp(-moneyness * 12) * (0.2 + rng.next()))),
        });
      }
    }
    return { symbol, dte, expiry: at + dte * DAY, forward: round4(forward), quotes };
  }

  /**
   * Expiry ladder. Exactly the three the feature set consumes: 30d drives the
   * SABR fit and the 25Δ risk reversal, while 7d and 90d define the term-structure
   * slope. A 60d slice was built and never read, so it is not built.
   */
  optionExpiries(): number[] {
    return [7, 30, 90];
  }

  /**
   * Alt-data event stream. Volumes and polarities are tied to the underlying
   * simulated path (insiders buy after drawdowns, social sentiment chases
   * momentum, analysts revise with a lag), so the decay-weighted aggregation
   * produces features that actually predict something.
   */
  altEvents(symbol: string, from: number, to: number): AltDataEvent[] {
    const spec = requireSpec(symbol);
    const daily = this.dailyBars(symbol);
    const rng = this.rngFor(`alt:${symbol}`);
    const out: AltDataEvent[] = [];
    let counter = 0;

    const push = (
      stream: AltDataStream,
      timestamp: number,
      value: number,
      confidence: number,
      headline: string,
      source: string,
      payload?: Record<string, string | number | boolean>,
    ): void => {
      if (timestamp < from || timestamp > to) return;
      counter += 1;
      out.push({
        id: `${symbol}-${stream}-${counter}`,
        symbol,
        stream,
        timestamp,
        value: round4(clamp(value, -1, 1)),
        confidence: round4(clamp(confidence, 0, 1)),
        headline,
        source,
        ...(payload ? { payload } : {}),
      });
    };

    for (let i = 20; i < daily.bars.length; i += 1) {
      const bar = daily.bars[i] as Bar;
      const prev = daily.bars[i - 1] as Bar;
      const ret5 = (bar.close - (daily.bars[i - 5] as Bar).close) / (daily.bars[i - 5] as Bar).close;
      const ret20 = (bar.close - (daily.bars[i - 20] as Bar).close) / (daily.bars[i - 20] as Bar).close;
      const dayRet = (bar.close - prev.close) / prev.close;
      const t = bar.time;

      // Social: chases 5-day momentum, very noisy, several prints per day.
      const socialCount = rng.int(0, 3);
      for (let k = 0; k < socialCount; k += 1) {
        const stream: AltDataStream = rng.bernoulli(0.5) ? 'social_reddit' : 'social_x';
        const v = clamp(ret5 * 7 + rng.normal() * 0.7, -1, 1);
        push(
          stream,
          t + rng.int(0, 380) * MINUTE,
          v,
          0.25 + 0.3 * rng.next(),
          v > 0.2
            ? `Retail chatter turning bullish on ${symbol}`
            : v < -0.2
              ? `Retail chatter turning bearish on ${symbol}`
              : `Mixed retail chatter on ${symbol}`,
          stream === 'social_reddit' ? 'r/wallstreetbets' : 'X / Twitter firehose',
        );
      }

      // News: reacts to the day's move.
      if (rng.bernoulli(0.36)) {
        const v = clamp(dayRet * 12 + rng.normal() * 0.4, -1, 1);
        push(
          'news_headline',
          t + rng.int(0, 380) * MINUTE,
          v,
          0.5 + 0.3 * rng.next(),
          v > 0
            ? `${spec.name} coverage skews positive after session move`
            : `${spec.name} coverage skews negative after session move`,
          'Aggregated newswire',
        );
      }

      // Form 4: insiders accumulate into weakness — a genuine contrarian signal.
      if (rng.bernoulli(clamp(0.012 - ret20 * 0.09, 0.002, 0.11))) {
        const shares = rng.int(1200, 68000);
        const isBuy = ret20 < 0 ? rng.bernoulli(0.82) : rng.bernoulli(0.34);
        const officer = rng.pick(['CEO', 'CFO', 'COO', 'Director', 'EVP Operations', 'Chief Accounting Officer']);
        push(
          'insider_form4',
          t + rng.int(0, 380) * MINUTE,
          (isBuy ? 1 : -1) * clamp(0.35 + shares / 90000, 0.2, 1),
          0.85 + 0.15 * rng.next(),
          `Form 4: ${officer} reports ${isBuy ? 'open-market purchase' : 'disposition'} of ${shares.toLocaleString('en-US')} shares`,
          'SEC EDGAR Form 4',
          {
            insiderRole: officer,
            shares,
            transactionCode: isBuy ? 'P' : 'S',
            valueUsd: Math.round(shares * bar.close),
          },
        );
      }

      // 13F: quarterly institutional positioning.
      const nyParts = toNewYork(t);
      if (nyParts.day === 15 && [2, 5, 8, 11].includes(nyParts.month) && rng.bernoulli(0.55)) {
        const v = clamp(ret20 * 3 + rng.normal() * 0.35, -1, 1);
        push(
          'institutional_13f',
          t,
          v,
          0.9,
          v > 0
            ? `13F filings show net institutional accumulation in ${symbol}`
            : `13F filings show net institutional distribution in ${symbol}`,
          'SEC EDGAR 13F-HR',
          { holdersChange: Math.round(v * 42), quarterEnd: nyParts.month },
        );
      }

      // Analyst revisions: lag price by roughly a week.
      if (rng.bernoulli(0.05)) {
        const v = clamp(ret20 * 4 + rng.normal() * 0.3, -1, 1);
        const house = rng.pick(['Morgan Stanley', 'Goldman Sachs', 'Jefferies', 'Barclays', 'Wells Fargo', 'BofA', 'UBS']);
        push(
          'analyst_revision',
          t + rng.int(0, 120) * MINUTE,
          v,
          0.7 + 0.2 * rng.next(),
          `${house} ${v > 0 ? 'raises' : 'lowers'} ${symbol} price target`,
          `${house} Research`,
          { targetChangePercent: round2(v * 14) },
        );
      }

      // Unusual options flow: correlates with the coming few days.
      if (rng.bernoulli(0.09)) {
        const ahead = daily.bars[Math.min(i + 3, daily.bars.length - 1)] as Bar;
        const fwd = (ahead.close - bar.close) / bar.close;
        const v = clamp(fwd * 9 + rng.normal() * 0.55, -1, 1);
        push(
          'options_flow',
          t + rng.int(0, 380) * MINUTE,
          v,
          0.6 + 0.25 * rng.next(),
          v > 0
            ? `Sweep: aggressive call buying in ${symbol} front expiries`
            : `Sweep: aggressive put buying in ${symbol} front expiries`,
          'Consolidated options tape',
          { premiumUsd: rng.int(250_000, 8_400_000) },
        );
      }

      // Short interest: bi-monthly settlement prints.
      if ((nyParts.day === 15 || nyParts.day === 28) && rng.bernoulli(0.6)) {
        const v = clamp(-ret20 * 3 + rng.normal() * 0.3, -1, 1);
        push(
          'short_interest',
          t,
          v,
          0.8,
          `Short interest ${v > 0 ? 'declines' : 'builds'} in ${symbol}`,
          'FINRA short interest',
          { percentFloat: round2(clamp(4 + v * -6 + rng.next() * 3, 0.4, 38)) },
        );
      }

      // Slower structural streams.
      if (rng.bernoulli(0.014)) {
        push('job_postings', t, clamp(ret20 * 2.5 + rng.normal() * 0.4, -1, 1), 0.55, `Hiring velocity ${ret20 > 0 ? 'accelerating' : 'cooling'} at ${spec.name}`, 'Careers-page crawl');
      }
      if (rng.bernoulli(0.01)) {
        push('web_traffic', t, clamp(ret20 * 2 + rng.normal() * 0.45, -1, 1), 0.5, `Web traffic trend ${ret20 > 0 ? 'improving' : 'deteriorating'} for ${spec.name}`, 'Clickstream panel');
      }
      if (rng.bernoulli(0.008)) {
        push('glassdoor_sentiment', t, clamp(rng.normal() * 0.5, -1, 1), 0.45, `Employee sentiment update for ${spec.name}`, 'Employer review scrape (TLS-impersonated)');
      }
      if (rng.bernoulli(0.006)) {
        push('supply_chain', t, clamp(ret20 * 1.8 + rng.normal() * 0.5, -1, 1), 0.6, `Supplier throughput signal for ${spec.name}`, 'Bill-of-lading panel');
      }
      if (rng.bernoulli(0.004)) {
        push('patent_filings', t, clamp(0.2 + rng.normal() * 0.4, -1, 1), 0.65, `New patent grants recorded for ${spec.name}`, 'USPTO full-text');
      }
      if (rng.bernoulli(0.004)) {
        push('sec_filing_8k', t, clamp(dayRet * 10 + rng.normal() * 0.4, -1, 1), 0.95, `8-K material event filed by ${spec.name}`, 'SEC EDGAR 8-K');
      }
      // Quarterly earnings cluster.
      if (nyParts.day >= 20 && nyParts.day <= 27 && [1, 4, 7, 10].includes(nyParts.month) && rng.bernoulli(0.12)) {
        const v = clamp(rng.normal() * 0.6, -1, 1);
        push('earnings_call', t, v, 0.85, `${spec.name} earnings call tone reads ${v > 0 ? 'constructive' : 'cautious'}`, 'Earnings call transcript');
        push('sec_filing_10k', t + DAY, clamp(v * 0.6, -1, 1), 0.95, `${spec.name} files quarterly report`, 'SEC EDGAR 10-Q');
      }
    }

    return out.sort((a, b) => a.timestamp - b.timestamp);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Session index containing `at`, clamped to the available range. */
  sessionIndexFor(at: number): number {
    const open = sessionOpen(at);
    let lo = 0;
    let hi = this.sessions.length - 1;
    if (open <= (this.sessions[0] as number)) return 0;
    if (open >= (this.sessions[hi] as number)) return hi;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.sessions[mid] as number) < open) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Interpolated price at an arbitrary instant. */
  priceAt(symbol: string, at: number): number {
    const daily = this.dailyBars(symbol);
    const idx = this.sessionIndexFor(at);
    const bar = daily.bars[idx] as Bar;
    const phase = clamp(minutesSinceOpen(at) / Math.max(1, sessionMinutes(at)), 0, 1);
    if (phase <= 0) return bar.open;
    if (phase >= 1) return bar.close;
    const intraday = this.intradayBars(symbol, at);
    if (intraday.length === 0) return bar.open + (bar.close - bar.open) * phase;
    const i = Math.min(intraday.length - 1, Math.floor(phase * intraday.length));
    return (intraday[i] as Bar).close;
  }

  /** 5-day log drift, used to skew the order book. */
  private shortHorizonDrift(symbol: string, at: number): number {
    const daily = this.dailyBars(symbol);
    const idx = this.sessionIndexFor(at);
    const back = Math.max(0, idx - 5);
    const now = (daily.bars[idx] as Bar).close;
    const then = (daily.bars[back] as Bar).close;
    return then <= 0 ? 0 : Math.log(now / then) / 5;
  }

  /** Annualised close-to-close realised volatility over `window` sessions. */
  realisedVolatility(symbol: string, at: number, window = 20): number {
    const daily = this.dailyBars(symbol);
    const idx = this.sessionIndexFor(at);
    const start = Math.max(1, idx - window + 1);
    const rets: number[] = [];
    for (let i = start; i <= idx; i += 1) {
      const p = (daily.bars[i - 1] as Bar).close;
      const c = (daily.bars[i] as Bar).close;
      if (p > 0 && c > 0) rets.push(Math.log(c / p));
    }
    if (rets.length < 2) return 0.25;
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    let v = 0;
    for (const r of rets) v += (r - m) ** 2;
    return Math.sqrt(v / (rets.length - 1)) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  }

  /** Ground-truth regime for a session — used to score the classifier. */
  regimeAt(at: number): SimRegime {
    const market = this.marketFactor();
    return (market.regimes[this.sessionIndexFor(at)] ?? 'trend') as SimRegime;
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/** Standard US option strike increments by price band. */
export function strikeIncrement(spot: number): number {
  if (spot < 25) return 1;
  if (spot < 100) return 2.5;
  if (spot < 250) return 5;
  if (spot < 600) return 10;
  return 25;
}

/** Convenience factory covering the default history window. */
export function createDefaultSimulator(options: { seed?: number | string; now?: number; years?: number } = {}): MarketSimulator {
  const now = options.now ?? Date.now();
  const years = options.years ?? 3;
  const nowParts = toNewYork(now);
  const end = fromNewYork(nowParts.year, nowParts.month, nowParts.day, SESSION_OPEN_MINUTES);
  return new MarketSimulator({
    seed: options.seed ?? 20240117,
    start: end - Math.round(years * 365.25 * DAY),
    end,
  });
}

export const SIMULATED_SECTORS = Array.from(new Set(UNIVERSE.map((u) => u.sector))) as Sector[];
export { BENCHMARK_SYMBOL };
export type { UniverseSpec };
