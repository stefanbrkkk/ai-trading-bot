/**
 * Display formatting.
 *
 * Every number the user sees passes through here, for two reasons. First,
 * consistency: decimals must align in a monospaced column, so the number of
 * fraction digits is a property of the *quantity*, not of the call site. Second,
 * compliance: the research forbids showing raw model floats, so there is no path
 * that renders a SHAP value directly — attribution is always shown as a share or
 * as narrative.
 */

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const USD_WHOLE = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function money(value: number, options: { whole?: boolean } = {}): string {
  if (!Number.isFinite(value)) return '—';
  /*
   * `Intl` emits U+002D HYPHEN-MINUS, and every other formatter in this module
   * emits U+2212 MINUS SIGN. That meant negative currency was the one quantity in
   * the product rendered with a different glyph — the backtest blotter showed
   * "-$118.93" in a column beside "−1.90%", four pixels apart at 11px, and there
   * was not a single "−$" anywhere in the application.
   */
  const formatted = options.whole ? USD_WHOLE.format(value) : USD.format(value);
  return formatted.replace('-', '−');
}

export function price(value: number): string {
  if (!Number.isFinite(value)) return '—';
  // Sub-dollar names need more precision than a two-decimal currency format.
  const digits = Math.abs(value) < 1 ? 4 : 2;
  return fixed(value, digits);
}

export function signedPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}%`;
}

export function percent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return `${fixed(value, digits)}%`;
}

/** Formats a decimal fraction (0.0342) as a percentage string. */
export function fractionAsPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function signedFractionAsPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(digits)}%`;
}

export function integer(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return INT.format(Math.round(value));
}

/**
 * Compact notation for volumes and market caps: `1.24B`, `892.00M`, `34.1K`, `512`.
 *
 * `digits` governs the T/B/M bands only. Below a million the precision is fixed —
 * one decimal for thousands, none at all for a raw count — because those bands
 * are share volumes and order sizes, where "512.00 shares" is noise dressed as
 * precision. The bands really do differ; the previous docstring implied they did
 * not, and its own example (`892M`) was unreachable at the default of two
 * decimals.
 */
export function compact(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(digits)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

export function sigma(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}σ`;
}

export function bps(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '' : '−'}${Math.abs(value).toFixed(digits)} bp`;
}

export function volPoints(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)} vp`;
}

export function multiple(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}×`;
}

export function ratio(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '—';
  return fixed(value, digits);
}

/**
 * A probability, rendered so that a very small one is still readable.
 *
 * Joint-tail probabilities span six orders of magnitude — 3.4e-3 for a
 * concentrated book, 6.3e-6 for the same book under independence — and neither a
 * percentage nor a fixed number of decimals can show both. "0.000625%" is a
 * string a reader counts zeros in; "6.25 × 10⁻⁶" is a number they can compare at
 * a glance to the one beside it.
 *
 * Above a tenth of a percent the exponent is noise, so it reads as a plain
 * percentage instead — one formatter, chosen by magnitude, so two probabilities
 * in the same panel are never written in two different systems by accident.
 */
export function probability(value: number, digits = 2): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0';
  if (value >= 0.001) return fractionAsPercent(value, digits);
  const exponent = Math.floor(Math.log10(value));
  const mantissa = value / 10 ** exponent;
  const superscripts: Record<string, string> = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
    '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  };
  const digitsOfExponent = String(Math.abs(exponent))
    .split('')
    .map((d) => superscripts[d] ?? d)
    .join('');
  return `${fixed(mantissa, digits)} × 10⁻${digitsOfExponent}`;
}

/**
 * `toFixed` with the typographic minus, and without a signed zero.
 *
 * Two defects come from `toFixed` alone. It emits U+002D HYPHEN-MINUS while every
 * signed formatter above emits U+2212 MINUS SIGN, so "CAGR −1.90%" and
 * "Sortino -0.10" sat adjacent in the same 11px row with visibly different
 * glyphs. And it rounds −0.004 to "-0.00", which reads as a small negative number
 * when the value is a rounding artefact — the screener's 5-day return column
 * showed "−0.00" for three names at once.
 */
export function fixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Number(value.toFixed(digits));
  const magnitude = Math.abs(rounded).toFixed(digits);
  return rounded < 0 ? `−${magnitude}` : magnitude;
}

/** Millisecond duration, scaled to the most readable unit. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * A half-life in trading sessions.
 *
 * `sessionHalfLife` and `halfLife` are two different quantities and were being
 * formatted by one function. The Ornstein-Uhlenbeck fit reports ln2/θ in
 * *sessions* — `engine/strategies.ts` prints the same field as "25.3 days" — and
 * the symbol page passed it to the millisecond formatter, so a 25.7-session
 * half-life was read as 25.7 ms and rendered "0 min" on every symbol in the
 * universe, directly above a hint reading "The half-life above carries the
 * information."
 */
export function sessionHalfLife(sessions: number): string {
  if (!Number.isFinite(sessions)) return '∞';
  if (sessions < 1) return `${(sessions * 6.5).toFixed(1)} h`;
  return `${sessions.toFixed(1)} ${sessions < 2 ? 'session' : 'sessions'}`;
}

/** Half-life or decay window in milliseconds, in the largest sensible unit. */
export function halfLife(ms: number): string {
  if (!Number.isFinite(ms)) return '∞';
  const minutes = ms / 60_000;
  if (minutes < 90) return `${minutes.toFixed(0)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(0)} d`;
}

const NY_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const NY_DATETIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const NY_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
});

/** All times are shown in New York, the market's own clock. */
export function nyTime(epochMs: number): string {
  return Number.isFinite(epochMs) ? `${NY_TIME.format(new Date(epochMs))} ET` : '—';
}

export function nyDateTime(epochMs: number): string {
  return Number.isFinite(epochMs) ? `${NY_DATETIME.format(new Date(epochMs))} ET` : '—';
}

export function nyDate(epochMs: number): string {
  return Number.isFinite(epochMs) ? NY_DATE.format(new Date(epochMs)) : '—';
}

/** Millisecond-precision stamp for the forensic telemetry views. */
export function forensicStamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '—';
  const d = new Date(epochMs);
  return `${NY_DATETIME.format(d)}.${String(d.getUTCMilliseconds()).padStart(3, '0')} ET`;
}

export function relativeTime(epochMs: number, now = Date.now()): string {
  if (!Number.isFinite(epochMs)) return '—';
  const delta = now - epochMs;
  const abs = Math.abs(delta);
  const suffix = delta >= 0 ? 'ago' : 'from now';
  if (abs < 60_000) return `${Math.round(abs / 1000)}s ${suffix}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${suffix}`;
  return `${Math.round(abs / 86_400_000)}d ${suffix}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Semantic colour selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sage for positive, burgundy for negative, parchment for neutral.
 *
 * These are the only two directional colours in the system. Neon green and red
 * are banned by the design mandate: they read as retail and, per the research,
 * "subtly signal a cheap or high-anxiety environment".
 */
export function directionalClass(value: number, options: { neutralBand?: number } = {}): string {
  const band = options.neutralBand ?? 0;
  if (value > band) return 'text-sage-bright';
  if (value < -band) return 'text-burgundy-bright';
  return 'text-parchment-dim';
}

export const SAGE = '#5F7161';
export const SAGE_BRIGHT = '#83A086';
export const BURGUNDY = '#8C3A3A';
export const BURGUNDY_BRIGHT = '#C47474';
export const GOLD = '#D4AF37';
export const GOLD_BRIGHT = '#E8C860';
export const CHAMPAGNE = '#F7E7CE';
export const PARCHMENT = '#EDE8DC';
export const PARCHMENT_DIM = '#B8B2A5';
export const PARCHMENT_FAINT = '#948F84';
export const PARCHMENT_GHOST = '#8A857A';
export const OBSIDIAN_EDGE = '#343435';
export const CHARCOAL = '#141414';
export const VANTA = '#0A0A0A';

/** Hex for a SHAP driver's sign — the exact values the design mandate names. */
export function driverColour(shap: number): string {
  return shap >= 0 ? SAGE : BURGUNDY;
}

export function driverColourBright(shap: number): string {
  return shap >= 0 ? SAGE_BRIGHT : BURGUNDY_BRIGHT;
}

/** Conviction band label — never a recommendation, only a description. */
export function convictionBand(conviction: number): { label: string; className: string } {
  if (conviction >= 70) return { label: 'High', className: 'text-gold-bright' };
  if (conviction >= 50) return { label: 'Moderate', className: 'text-gold' };
  if (conviction >= 30) return { label: 'Low', className: 'text-parchment-dim' };
  if (conviction > 0) return { label: 'Marginal', className: 'text-parchment-faint' };
  return { label: 'None', className: 'text-parchment-ghost' };
}

export function directionLabel(direction: 'long' | 'short' | 'flat'): string {
  if (direction === 'long') return 'Long bias';
  if (direction === 'short') return 'Short bias';
  return 'No directional bias';
}

/** Truncates to a character budget on a word boundary. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max)}…`;
}
