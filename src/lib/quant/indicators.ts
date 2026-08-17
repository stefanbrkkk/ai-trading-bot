/**
 * Technical indicator library.
 *
 * These are the *inputs* to the ensemble, not the strategy. Phase 1 §4 is
 * explicit that static EMA pullbacks and fixed standard-deviation channels are
 * lagging artefacts; Aurelius still computes them because (a) the feature vector
 * needs them as covariates, (b) the XAI narrative engine speaks in terms traders
 * recognise ("RSI at 28.4"), and (c) the Holly-AI replication strategies are
 * defined in these terms so we can benchmark against them.
 *
 * Every function returns an array aligned to the input length, with `NaN` for
 * warm-up bars. No look-ahead: value at index i uses only bars ≤ i.
 */

import { EPS, clamp, mean, stdev, sum } from './stats';

export interface Bar {
  /** Epoch ms of the bar open. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Volume-weighted average price for the bar, when available. */
  vwap?: number;
  /** Trade count, when available. */
  trades?: number;
}

export type Series = number[];

const nanArray = (n: number): Series => new Array<number>(n).fill(NaN);

export const closes = (bars: readonly Bar[]): Series => bars.map((b) => b.close);
export const highs = (bars: readonly Bar[]): Series => bars.map((b) => b.high);
export const lows = (bars: readonly Bar[]): Series => bars.map((b) => b.low);
export const opens = (bars: readonly Bar[]): Series => bars.map((b) => b.open);
export const volumes = (bars: readonly Bar[]): Series => bars.map((b) => b.volume);

/** Typical price (H+L+C)/3. */
export const typicalPrices = (bars: readonly Bar[]): Series =>
  bars.map((b) => (b.high + b.low + b.close) / 3);

// ── Moving averages ─────────────────────────────────────────────────────────

export function sma(values: readonly number[], period: number): Series {
  const out = nanArray(values.length);
  if (period <= 0) return out;
  let acc = 0;
  for (let i = 0; i < values.length; i += 1) {
    acc += values[i] as number;
    if (i >= period) acc -= values[i - period] as number;
    if (i >= period - 1) out[i] = acc / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values (Wilder-compatible). */
export function ema(values: readonly number[], period: number): Series {
  const out = nanArray(values.length);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = mean(values.slice(0, period));
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = (values[i] as number) * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (RMA) — α = 1/period. */
export function rma(values: readonly number[], period: number): Series {
  const out = nanArray(values.length);
  if (period <= 0 || values.length < period) return out;
  let prev = mean(values.slice(0, period));
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = ((values[i] as number) + prev * (period - 1)) / period;
    out[i] = prev;
  }
  return out;
}

/** Weighted moving average with linear weights. */
export function wma(values: readonly number[], period: number): Series {
  const out = nanArray(values.length);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i += 1) {
    let acc = 0;
    for (let j = 0; j < period; j += 1) acc += (values[i - period + 1 + j] as number) * (j + 1);
    out[i] = acc / denom;
  }
  return out;
}

/** Hull moving average: WMA(2·WMA(n/2) − WMA(n), √n). */
export function hma(values: readonly number[], period: number): Series {
  const half = Math.max(1, Math.floor(period / 2));
  const sqrtP = Math.max(1, Math.round(Math.sqrt(period)));
  const w1 = wma(values, half);
  const w2 = wma(values, period);
  const raw = values.map((_, i) => {
    const a = w1[i] as number;
    const b = w2[i] as number;
    return Number.isNaN(a) || Number.isNaN(b) ? NaN : 2 * a - b;
  });
  const clean = raw.map((v) => (Number.isNaN(v) ? 0 : v));
  const smoothed = wma(clean, sqrtP);
  return smoothed.map((v, i) => (Number.isNaN(raw[i] as number) ? NaN : v));
}

// ── Momentum / oscillators ──────────────────────────────────────────────────

/**
 * Wilder's RSI.
 *   RS  = avgGain / avgLoss    (both Wilder-smoothed over `period`)
 *   RSI = 100 − 100/(1 + RS)
 */
export function rsi(values: readonly number[], period = 14): Series {
  const out = nanArray(values.length);
  if (values.length <= period) return out;
  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < values.length; i += 1) {
    const d = (values[i] as number) - (values[i - 1] as number);
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  let avgGain = mean(gains.slice(1, period + 1));
  let avgLoss = mean(losses.slice(1, period + 1));
  out[period] = avgLoss < EPS ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    avgGain = (avgGain * (period - 1) + (gains[i] as number)) / period;
    avgLoss = (avgLoss * (period - 1) + (losses[i] as number)) / period;
    out[i] = avgLoss < EPS ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdResult {
  macd: Series;
  signal: Series;
  histogram: Series;
}

/** MACD(fast, slow, signal) — default 12 / 26 / 9. */
export function macd(values: readonly number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const line = values.map((_, i) => {
    const f = emaFast[i] as number;
    const s = emaSlow[i] as number;
    return Number.isNaN(f) || Number.isNaN(s) ? NaN : f - s;
  });
  const firstValid = line.findIndex((v) => !Number.isNaN(v));
  const signal = nanArray(values.length);
  if (firstValid >= 0) {
    const compact = line.slice(firstValid);
    const sig = ema(compact, signalPeriod);
    for (let i = 0; i < sig.length; i += 1) signal[firstValid + i] = sig[i] as number;
  }
  const histogram = line.map((v, i) => {
    const s = signal[i] as number;
    return Number.isNaN(v) || Number.isNaN(s) ? NaN : v - s;
  });
  return { macd: line, signal, histogram };
}

export interface StochasticResult {
  k: Series;
  d: Series;
}

/** Stochastic oscillator %K/%D. */
export function stochastic(bars: readonly Bar[], kPeriod = 14, dPeriod = 3, smoothK = 3): StochasticResult {
  const raw = nanArray(bars.length);
  for (let i = kPeriod - 1; i < bars.length; i += 1) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j += 1) {
      const b = bars[j] as Bar;
      if (b.high > hh) hh = b.high;
      if (b.low < ll) ll = b.low;
    }
    const range = hh - ll;
    raw[i] = range < EPS ? 50 : (((bars[i] as Bar).close - ll) / range) * 100;
  }
  const k = smoothSeries(raw, smoothK);
  const d = smoothSeries(k, dPeriod);
  return { k, d };
}

function smoothSeries(values: Series, period: number): Series {
  if (period <= 1) return values.slice();
  const out = nanArray(values.length);
  for (let i = 0; i < values.length; i += 1) {
    if (i < period - 1) continue;
    const window = values.slice(i - period + 1, i + 1);
    if (window.some((v) => Number.isNaN(v))) continue;
    out[i] = mean(window);
  }
  return out;
}

/** Williams %R — the inverted, unsmoothed stochastic. */
export function williamsR(bars: readonly Bar[], period = 14): Series {
  const out = nanArray(bars.length);
  for (let i = period - 1; i < bars.length; i += 1) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j += 1) {
      const b = bars[j] as Bar;
      if (b.high > hh) hh = b.high;
      if (b.low < ll) ll = b.low;
    }
    const range = hh - ll;
    out[i] = range < EPS ? -50 : ((hh - (bars[i] as Bar).close) / range) * -100;
  }
  return out;
}

/** Rate of change, in percent. */
export function roc(values: readonly number[], period = 10): Series {
  const out = nanArray(values.length);
  for (let i = period; i < values.length; i += 1) {
    const prev = values[i - period] as number;
    out[i] = prev === 0 ? 0 : (((values[i] as number) - prev) / prev) * 100;
  }
  return out;
}

/** Commodity Channel Index. */
export function cci(bars: readonly Bar[], period = 20): Series {
  const tp = typicalPrices(bars);
  const out = nanArray(bars.length);
  const ma = sma(tp, period);
  for (let i = period - 1; i < bars.length; i += 1) {
    const window = tp.slice(i - period + 1, i + 1);
    const m = ma[i] as number;
    const md = mean(window.map((v) => Math.abs(v - m)));
    out[i] = md < EPS ? 0 : ((tp[i] as number) - m) / (0.015 * md);
  }
  return out;
}

/** Money Flow Index — a volume-weighted RSI. */
export function mfi(bars: readonly Bar[], period = 14): Series {
  const tp = typicalPrices(bars);
  const out = nanArray(bars.length);
  const pos: number[] = [0];
  const neg: number[] = [0];
  for (let i = 1; i < bars.length; i += 1) {
    const flow = (tp[i] as number) * (bars[i] as Bar).volume;
    const up = (tp[i] as number) > (tp[i - 1] as number);
    pos.push(up ? flow : 0);
    neg.push(up ? 0 : flow);
  }
  for (let i = period; i < bars.length; i += 1) {
    const p = sum(pos.slice(i - period + 1, i + 1));
    const n = sum(neg.slice(i - period + 1, i + 1));
    out[i] = n < EPS ? 100 : 100 - 100 / (1 + p / n);
  }
  return out;
}

// ── Volatility / range ──────────────────────────────────────────────────────

/** True range: max(H−L, |H−C_prev|, |L−C_prev|). */
export function trueRange(bars: readonly Bar[]): Series {
  const out = nanArray(bars.length);
  if (bars.length > 0) out[0] = (bars[0] as Bar).high - (bars[0] as Bar).low;
  for (let i = 1; i < bars.length; i += 1) {
    const b = bars[i] as Bar;
    const pc = (bars[i - 1] as Bar).close;
    out[i] = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }
  return out;
}

/** Average True Range (Wilder). */
export function atr(bars: readonly Bar[], period = 14): Series {
  return rma(trueRange(bars), period);
}

/** ATR as a fraction of close — the scale-free volatility feature. */
export function atrPercent(bars: readonly Bar[], period = 14): Series {
  const a = atr(bars, period);
  return a.map((v, i) => {
    const c = (bars[i] as Bar).close;
    return Number.isNaN(v) || c < EPS ? NaN : v / c;
  });
}

export interface BandsResult {
  upper: Series;
  middle: Series;
  lower: Series;
  /** (upper − lower) / middle. */
  width: Series;
  /** (price − lower) / (upper − lower) ∈ [0, 1] when inside the band. */
  percentB: Series;
}

/**
 * Bollinger Bands. Included as a *benchmark* feature — Phase 1 §4 documents
 * precisely why a fixed-σ channel lags, and the UI contrasts it against the
 * Kalman innovation band.
 */
export function bollinger(values: readonly number[], period = 20, mult = 2): BandsResult {
  const middle = sma(values, period);
  const upper = nanArray(values.length);
  const lower = nanArray(values.length);
  const width = nanArray(values.length);
  const percentB = nanArray(values.length);
  for (let i = period - 1; i < values.length; i += 1) {
    const sd = stdev(values.slice(i - period + 1, i + 1), 0);
    const m = middle[i] as number;
    const u = m + mult * sd;
    const l = m - mult * sd;
    upper[i] = u;
    lower[i] = l;
    width[i] = m < EPS ? 0 : (u - l) / m;
    percentB[i] = u - l < EPS ? 0.5 : ((values[i] as number) - l) / (u - l);
  }
  return { upper, middle, lower, width, percentB };
}

/** Keltner Channels: EMA ± mult·ATR. */
export function keltner(bars: readonly Bar[], period = 20, mult = 2, atrPeriod = 10): BandsResult {
  const middle = ema(closes(bars), period);
  const a = atr(bars, atrPeriod);
  const upper = nanArray(bars.length);
  const lower = nanArray(bars.length);
  const width = nanArray(bars.length);
  const percentB = nanArray(bars.length);
  for (let i = 0; i < bars.length; i += 1) {
    const m = middle[i] as number;
    const av = a[i] as number;
    if (Number.isNaN(m) || Number.isNaN(av)) continue;
    const u = m + mult * av;
    const l = m - mult * av;
    upper[i] = u;
    lower[i] = l;
    width[i] = m < EPS ? 0 : (u - l) / m;
    percentB[i] = u - l < EPS ? 0.5 : ((bars[i] as Bar).close - l) / (u - l);
  }
  return { upper, middle, lower, width, percentB };
}

/** Donchian channel over `period` bars. */
export function donchian(bars: readonly Bar[], period = 20): { upper: Series; lower: Series; middle: Series } {
  const upper = nanArray(bars.length);
  const lower = nanArray(bars.length);
  const middle = nanArray(bars.length);
  for (let i = period - 1; i < bars.length; i += 1) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j += 1) {
      const b = bars[j] as Bar;
      if (b.high > hh) hh = b.high;
      if (b.low < ll) ll = b.low;
    }
    upper[i] = hh;
    lower[i] = ll;
    middle[i] = (hh + ll) / 2;
  }
  return { upper, lower, middle };
}

/**
 * Bollinger "squeeze" percentile: where the current band width sits in its own
 * `lookback` distribution. Low values precede expansion.
 */
export function squeezePercentile(width: Series, lookback = 120): Series {
  const out = nanArray(width.length);
  for (let i = 0; i < width.length; i += 1) {
    const w = width[i] as number;
    if (Number.isNaN(w)) continue;
    const start = Math.max(0, i - lookback + 1);
    const window = width.slice(start, i + 1).filter((v) => !Number.isNaN(v));
    if (window.length < 10) continue;
    let below = 0;
    for (const v of window) if (v <= w) below += 1;
    out[i] = below / window.length;
  }
  return out;
}

/** Annualised realised volatility from log returns over `period` bars. */
export function realisedVolatility(values: readonly number[], period = 20, barsPerYear = 252): Series {
  const out = nanArray(values.length);
  const rets: number[] = [0];
  for (let i = 1; i < values.length; i += 1) {
    const p = values[i - 1] as number;
    const c = values[i] as number;
    rets.push(p > 0 && c > 0 ? Math.log(c / p) : 0);
  }
  for (let i = period; i < values.length; i += 1) {
    out[i] = stdev(rets.slice(i - period + 1, i + 1)) * Math.sqrt(barsPerYear);
  }
  return out;
}

/**
 * Garman–Klass–Yang–Zhang OHLC volatility estimator — far more efficient than
 * close-to-close, which matters at the 5m/15m horizons where we have few bars.
 */
export function garmanKlassVolatility(bars: readonly Bar[], period = 20, barsPerYear = 252): Series {
  const out = nanArray(bars.length);
  const contrib = bars.map((b, i) => {
    if (i === 0 || b.high <= 0 || b.low <= 0 || b.open <= 0 || b.close <= 0) return NaN;
    const prevClose = (bars[i - 1] as Bar).close;
    if (prevClose <= 0) return NaN;
    const o = Math.log(b.open / prevClose);
    const u = Math.log(b.high / b.open);
    const d = Math.log(b.low / b.open);
    const c = Math.log(b.close / b.open);
    return o * o + 0.5 * (u - d) ** 2 - (2 * Math.LN2 - 1) * c * c;
  });
  for (let i = period; i < bars.length; i += 1) {
    const window = contrib.slice(i - period + 1, i + 1).filter((v) => !Number.isNaN(v));
    if (window.length < Math.max(2, period / 2)) continue;
    out[i] = Math.sqrt(Math.max(mean(window), 0) * barsPerYear);
  }
  return out;
}

/**
 * Rogers–Satchell volatility.
 *
 * The engine blueprint mandates this specific estimator for the 60m macro agent
 * because Garman–Klass assumes zero drift: applied to a trending 60-minute
 * series it grossly *overestimates* variance. Rogers–Satchell is drift-invariant,
 * so the macro agent's volatility feature is decoupled from the direction of the
 * trend.
 *
 *   rsᵢ = ln(Hᵢ/Cᵢ)·ln(Hᵢ/Oᵢ) + ln(Lᵢ/Cᵢ)·ln(Lᵢ/Oᵢ)      (each term ≥ 0)
 *   σ_RS = √( (1/N)·Σ rsᵢ )
 */
export function rogersSatchellVolatility(
  bars: readonly Bar[],
  period = 20,
  barsPerYear = 0,
): Series {
  const out = nanArray(bars.length);
  const contrib = bars.map((b) => {
    if (b.high <= 0 || b.low <= 0 || b.open <= 0 || b.close <= 0) return NaN;
    return (
      Math.log(b.high / b.close) * Math.log(b.high / b.open) +
      Math.log(b.low / b.close) * Math.log(b.low / b.open)
    );
  });
  const annualise = barsPerYear > 0 ? Math.sqrt(barsPerYear) : 1;
  for (let i = period - 1; i < bars.length; i += 1) {
    const window = contrib.slice(i - period + 1, i + 1).filter((v) => !Number.isNaN(v));
    if (window.length < Math.max(2, Math.floor(period / 2))) continue;
    out[i] = Math.sqrt(Math.max(mean(window), 0)) * annualise;
  }
  return out;
}

// ── Trend strength ──────────────────────────────────────────────────────────

export interface AdxResult {
  adx: Series;
  plusDi: Series;
  minusDi: Series;
}

/** Wilder's ADX / +DI / −DI. */
export function adx(bars: readonly Bar[], period = 14): AdxResult {
  const n = bars.length;
  const plusDm: number[] = [0];
  const minusDm: number[] = [0];
  for (let i = 1; i < n; i += 1) {
    const up = (bars[i] as Bar).high - (bars[i - 1] as Bar).high;
    const down = (bars[i - 1] as Bar).low - (bars[i] as Bar).low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  const trSmooth = rma(trueRange(bars), period);
  const plusSmooth = rma(plusDm, period);
  const minusSmooth = rma(minusDm, period);

  const plusDi = nanArray(n);
  const minusDi = nanArray(n);
  const dx = nanArray(n);
  for (let i = 0; i < n; i += 1) {
    const tr = trSmooth[i] as number;
    const p = plusSmooth[i] as number;
    const m = minusSmooth[i] as number;
    if (Number.isNaN(tr) || Number.isNaN(p) || Number.isNaN(m) || tr < EPS) continue;
    const pdi = (p / tr) * 100;
    const mdi = (m / tr) * 100;
    plusDi[i] = pdi;
    minusDi[i] = mdi;
    const denom = pdi + mdi;
    dx[i] = denom < EPS ? 0 : (Math.abs(pdi - mdi) / denom) * 100;
  }
  const firstValid = dx.findIndex((v) => !Number.isNaN(v));
  const adxOut = nanArray(n);
  if (firstValid >= 0) {
    const compact = dx.slice(firstValid).map((v) => (Number.isNaN(v) ? 0 : v));
    const smoothed = rma(compact, period);
    for (let i = 0; i < smoothed.length; i += 1) adxOut[firstValid + i] = smoothed[i] as number;
  }
  return { adx: adxOut, plusDi, minusDi };
}

/** Aroon up/down and oscillator. */
export function aroon(bars: readonly Bar[], period = 25): { up: Series; down: Series; oscillator: Series } {
  const up = nanArray(bars.length);
  const down = nanArray(bars.length);
  const oscillator = nanArray(bars.length);
  for (let i = period; i < bars.length; i += 1) {
    let hi = -Infinity;
    let lo = Infinity;
    let hiIdx = i;
    let loIdx = i;
    for (let j = i - period; j <= i; j += 1) {
      const b = bars[j] as Bar;
      if (b.high >= hi) {
        hi = b.high;
        hiIdx = j;
      }
      if (b.low <= lo) {
        lo = b.low;
        loIdx = j;
      }
    }
    up[i] = ((period - (i - hiIdx)) / period) * 100;
    down[i] = ((period - (i - loIdx)) / period) * 100;
    oscillator[i] = (up[i] as number) - (down[i] as number);
  }
  return { up, down, oscillator };
}

/** Supertrend (ATR-band trailing stop). `direction` is +1 up, −1 down. */
export function supertrend(
  bars: readonly Bar[],
  period = 10,
  multiplier = 3,
): { line: Series; direction: Series } {
  const a = atr(bars, period);
  const line = nanArray(bars.length);
  const direction = nanArray(bars.length);
  let prevUpper = NaN;
  let prevLower = NaN;
  let dir = 1;
  for (let i = 0; i < bars.length; i += 1) {
    const av = a[i] as number;
    if (Number.isNaN(av)) continue;
    const b = bars[i] as Bar;
    const mid = (b.high + b.low) / 2;
    let upper = mid + multiplier * av;
    let lower = mid - multiplier * av;
    const prevClose = i > 0 ? (bars[i - 1] as Bar).close : b.close;
    if (!Number.isNaN(prevUpper)) upper = upper < prevUpper || prevClose > prevUpper ? upper : prevUpper;
    if (!Number.isNaN(prevLower)) lower = lower > prevLower || prevClose < prevLower ? lower : prevLower;
    if (!Number.isNaN(prevUpper) && !Number.isNaN(prevLower)) {
      if (b.close > prevUpper) dir = 1;
      else if (b.close < prevLower) dir = -1;
    }
    direction[i] = dir;
    line[i] = dir === 1 ? lower : upper;
    prevUpper = upper;
    prevLower = lower;
  }
  return { line, direction };
}

// ── Volume ──────────────────────────────────────────────────────────────────

/** On-Balance Volume. */
export function obv(bars: readonly Bar[]): Series {
  const out = new Array<number>(bars.length).fill(0);
  for (let i = 1; i < bars.length; i += 1) {
    const b = bars[i] as Bar;
    const prev = bars[i - 1] as Bar;
    const dir = b.close > prev.close ? 1 : b.close < prev.close ? -1 : 0;
    out[i] = (out[i - 1] as number) + dir * b.volume;
  }
  return out;
}

/** Session-anchored VWAP; resets when `sessionOf` changes. */
export function vwap(bars: readonly Bar[], sessionOf?: (bar: Bar) => string): Series {
  const out = nanArray(bars.length);
  let pv = 0;
  let vol = 0;
  let session: string | null = null;
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i] as Bar;
    const s = sessionOf ? sessionOf(b) : 'all';
    if (s !== session) {
      session = s;
      pv = 0;
      vol = 0;
    }
    const tp = b.vwap ?? (b.high + b.low + b.close) / 3;
    pv += tp * b.volume;
    vol += b.volume;
    out[i] = vol < EPS ? tp : pv / vol;
  }
  return out;
}

/** Relative volume: volume / SMA(volume, period). */
export function relativeVolume(bars: readonly Bar[], period = 20): Series {
  const vols = volumes(bars);
  const avg = sma(vols, period);
  return vols.map((v, i) => {
    const a = avg[i] as number;
    return Number.isNaN(a) || a < EPS ? NaN : v / a;
  });
}

/** Average Daily Volume over `period` bars — the risk engine's ADV input. */
export function averageDailyVolume(bars: readonly Bar[], period = 30): number {
  const vols = volumes(bars).slice(-period);
  return vols.length === 0 ? 0 : mean(vols);
}

/** Accumulation/Distribution line. */
export function accumulationDistribution(bars: readonly Bar[]): Series {
  const out = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i] as Bar;
    const range = b.high - b.low;
    const mfm = range < EPS ? 0 : (2 * b.close - b.low - b.high) / range;
    out[i] = (i > 0 ? (out[i - 1] as number) : 0) + mfm * b.volume;
  }
  return out;
}

/** Chaikin Money Flow over `period`. */
export function chaikinMoneyFlow(bars: readonly Bar[], period = 20): Series {
  const out = nanArray(bars.length);
  const mfv = bars.map((b) => {
    const range = b.high - b.low;
    return range < EPS ? 0 : ((2 * b.close - b.low - b.high) / range) * b.volume;
  });
  const vols = volumes(bars);
  for (let i = period - 1; i < bars.length; i += 1) {
    const v = sum(vols.slice(i - period + 1, i + 1));
    out[i] = v < EPS ? 0 : sum(mfv.slice(i - period + 1, i + 1)) / v;
  }
  return out;
}

// ── Structure / composite ───────────────────────────────────────────────────

/** Overnight gap in percent versus the previous close. */
export function gapPercent(bars: readonly Bar[]): Series {
  const out = nanArray(bars.length);
  for (let i = 1; i < bars.length; i += 1) {
    const prev = (bars[i - 1] as Bar).close;
    out[i] = prev < EPS ? 0 : (((bars[i] as Bar).open - prev) / prev) * 100;
  }
  return out;
}

/** Distance from the rolling `period` high, in percent (≤ 0). */
export function distanceFromHigh(bars: readonly Bar[], period = 252): Series {
  const out = nanArray(bars.length);
  for (let i = 0; i < bars.length; i += 1) {
    const start = Math.max(0, i - period + 1);
    let hh = -Infinity;
    for (let j = start; j <= i; j += 1) hh = Math.max(hh, (bars[j] as Bar).high);
    out[i] = hh < EPS ? 0 : (((bars[i] as Bar).close - hh) / hh) * 100;
  }
  return out;
}

/** Distance from the rolling `period` low, in percent (≥ 0). */
export function distanceFromLow(bars: readonly Bar[], period = 252): Series {
  const out = nanArray(bars.length);
  for (let i = 0; i < bars.length; i += 1) {
    const start = Math.max(0, i - period + 1);
    let ll = Infinity;
    for (let j = start; j <= i; j += 1) ll = Math.min(ll, (bars[j] as Bar).low);
    out[i] = ll < EPS ? 0 : (((bars[i] as Bar).close - ll) / ll) * 100;
  }
  return out;
}

/** Consecutive up (positive) or down (negative) closes ending at each bar. */
export function consecutiveCloses(bars: readonly Bar[]): Series {
  const out = new Array<number>(bars.length).fill(0);
  for (let i = 1; i < bars.length; i += 1) {
    const up = (bars[i] as Bar).close > (bars[i - 1] as Bar).close;
    const prev = out[i - 1] as number;
    out[i] = up ? (prev > 0 ? prev + 1 : 1) : (prev < 0 ? prev - 1 : -1);
  }
  return out;
}

/** Close position within the bar range, 0 = at low, 1 = at high. */
export function closeLocation(bars: readonly Bar[]): Series {
  return bars.map((b) => {
    const r = b.high - b.low;
    return r < EPS ? 0.5 : clamp((b.close - b.low) / r, 0, 1);
  });
}

/** Linear-regression slope of the last `period` closes, normalised by price. */
export function trendSlope(values: readonly number[], period = 20): Series {
  const out = nanArray(values.length);
  const xs = Array.from({ length: period }, (_, i) => i);
  const mx = mean(xs);
  let sxx = 0;
  for (const x of xs) sxx += (x - mx) ** 2;
  for (let i = period - 1; i < values.length; i += 1) {
    const window = values.slice(i - period + 1, i + 1);
    const my = mean(window);
    let sxy = 0;
    for (let j = 0; j < period; j += 1) sxy += ((xs[j] as number) - mx) * ((window[j] as number) - my);
    const slope = sxx < EPS ? 0 : sxy / sxx;
    out[i] = my < EPS ? 0 : (slope / my) * 100;
  }
  return out;
}

/** Beta and idiosyncratic α of `values` against `benchmark` over `period`. */
export function rollingBeta(
  values: readonly number[],
  benchmark: readonly number[],
  period = 60,
): { beta: Series; alpha: Series; correlation: Series } {
  const n = Math.min(values.length, benchmark.length);
  const beta = nanArray(n);
  const alpha = nanArray(n);
  const corr = nanArray(n);
  const rv: number[] = [0];
  const rb: number[] = [0];
  for (let i = 1; i < n; i += 1) {
    const pv = values[i - 1] as number;
    const pb = benchmark[i - 1] as number;
    rv.push(pv < EPS ? 0 : ((values[i] as number) - pv) / pv);
    rb.push(pb < EPS ? 0 : ((benchmark[i] as number) - pb) / pb);
  }
  for (let i = period; i < n; i += 1) {
    const wv = rv.slice(i - period + 1, i + 1);
    const wb = rb.slice(i - period + 1, i + 1);
    const varB = stdev(wb) ** 2;
    if (varB < EPS) continue;
    const mv = mean(wv);
    const mb = mean(wb);
    let cov = 0;
    for (let j = 0; j < wv.length; j += 1) cov += ((wv[j] as number) - mv) * ((wb[j] as number) - mb);
    cov /= wv.length - 1;
    const b = cov / varB;
    beta[i] = b;
    alpha[i] = mv - b * mb;
    const sv = stdev(wv);
    const sb = stdev(wb);
    corr[i] = sv < EPS || sb < EPS ? 0 : clamp(cov / (sv * sb), -1, 1);
  }
  return { beta, alpha, correlation: corr };
}

/** Latest finite value of a series (or `fallback`). */
export function last(series: Series, fallback = 0): number {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const v = series[i] as number;
    if (Number.isFinite(v)) return v;
  }
  return fallback;
}

/** Value `back` bars from the end (or `fallback`). */
export function at(series: Series, back: number, fallback = 0): number {
  const idx = series.length - 1 - back;
  if (idx < 0) return fallback;
  const v = series[idx] as number;
  return Number.isFinite(v) ? v : fallback;
}

/** True when `a` crossed above `b` on the last bar. */
export function crossedAbove(a: Series, b: Series): boolean {
  const n = Math.min(a.length, b.length);
  if (n < 2) return false;
  const a1 = a[n - 1] as number;
  const a0 = a[n - 2] as number;
  const b1 = b[n - 1] as number;
  const b0 = b[n - 2] as number;
  if ([a0, a1, b0, b1].some((v) => !Number.isFinite(v))) return false;
  return a0 <= b0 && a1 > b1;
}

/** True when `a` crossed below `b` on the last bar. */
export function crossedBelow(a: Series, b: Series): boolean {
  const n = Math.min(a.length, b.length);
  if (n < 2) return false;
  const a1 = a[n - 1] as number;
  const a0 = a[n - 2] as number;
  const b1 = b[n - 1] as number;
  const b0 = b[n - 2] as number;
  if ([a0, a1, b0, b1].some((v) => !Number.isFinite(v))) return false;
  return a0 >= b0 && a1 < b1;
}

/** Bars since `predicate` was last true (Infinity if never). */
export function barsSince(bars: readonly Bar[], predicate: (bar: Bar, index: number) => boolean): number {
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (predicate(bars[i] as Bar, i)) return bars.length - 1 - i;
  }
  return Infinity;
}

/** Aggregates 1-minute bars up to a coarser timeframe. */
export function resample(bars: readonly Bar[], minutesPerBar: number): Bar[] {
  if (minutesPerBar <= 1) return bars.slice();
  const bucketMs = minutesPerBar * 60_000;
  const out: Bar[] = [];
  let current: Bar | null = null;
  let bucket = -1;
  let pvAcc = 0;
  for (const b of bars) {
    const idx = Math.floor(b.time / bucketMs);
    if (idx !== bucket) {
      if (current) {
        current.vwap = current.volume > EPS ? pvAcc / current.volume : current.close;
        out.push(current);
      }
      bucket = idx;
      current = { time: idx * bucketMs, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, trades: b.trades ?? 0 };
      pvAcc = (b.vwap ?? (b.high + b.low + b.close) / 3) * b.volume;
    } else if (current) {
      current.high = Math.max(current.high, b.high);
      current.low = Math.min(current.low, b.low);
      current.close = b.close;
      current.volume += b.volume;
      current.trades = (current.trades ?? 0) + (b.trades ?? 0);
      pvAcc += (b.vwap ?? (b.high + b.low + b.close) / 3) * b.volume;
    }
  }
  if (current) {
    current.vwap = current.volume > EPS ? pvAcc / current.volume : current.close;
    out.push(current);
  }
  return out;
}
