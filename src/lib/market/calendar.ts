/**
 * US equity trading calendar.
 *
 * All session maths is done in UTC against the America/New_York offset so it is
 * deterministic regardless of the host timezone — a server in UTC and a laptop
 * in CET must produce identical bar timestamps, otherwise the seeded simulator
 * stops being reproducible.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Regular session: 09:30–16:00 America/New_York. */
export const SESSION_OPEN_MINUTES = 9 * 60 + 30;
export const SESSION_CLOSE_MINUTES = 16 * 60;
export const SESSION_LENGTH_MINUTES = SESSION_CLOSE_MINUTES - SESSION_OPEN_MINUTES; // 390

/** Early close at 13:00 ET (day after Thanksgiving, Christmas Eve, July 3). */
export const EARLY_CLOSE_MINUTES = 13 * 60;

/**
 * US DST: second Sunday in March → first Sunday in November.
 * Returns the UTC offset in hours (−4 during DST, −5 otherwise).
 */
export function newYorkUtcOffsetHours(utcMs: number): number {
  const d = new Date(utcMs);
  const year = d.getUTCFullYear();
  const dstStart = nthWeekdayUtc(year, 2, 0, 2, 7); // March, Sunday, 2nd, 07:00 UTC
  const dstEnd = nthWeekdayUtc(year, 10, 0, 1, 6); // November, Sunday, 1st, 06:00 UTC
  return utcMs >= dstStart && utcMs < dstEnd ? -4 : -5;
}

/** UTC ms of the `nth` `weekday` of `month` (0-indexed) at `hourUtc`. */
function nthWeekdayUtc(year: number, month: number, weekday: number, nth: number, hourUtc: number): number {
  const first = Date.UTC(year, month, 1, hourUtc, 0, 0, 0);
  const firstWeekday = new Date(first).getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  return first + (offset + (nth - 1) * 7) * DAY;
}

export interface NyDateParts {
  year: number;
  month: number;
  day: number;
  /** Minutes since local midnight. */
  minutes: number;
  /** 0 = Sunday. */
  weekday: number;
}

/** Decomposes a UTC instant into America/New_York calendar parts. */
export function toNewYork(utcMs: number): NyDateParts {
  const shifted = new Date(utcMs + newYorkUtcOffsetHours(utcMs) * HOUR);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** UTC ms for a New York wall-clock date and minute-of-day. */
export function fromNewYork(year: number, month: number, day: number, minutes: number): number {
  // Resolve the offset with a first guess, then confirm (handles DST boundaries).
  const guess = Date.UTC(year, month - 1, day, 12, 0, 0, 0);
  const offset = newYorkUtcOffsetHours(guess);
  return Date.UTC(year, month - 1, day, 0, minutes, 0, 0) - offset * HOUR;
}

export function isoDate(utcMs: number): string {
  const p = toNewYork(utcMs);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * NYSE holidays 2019–2029. Hard-coded rather than computed because the rules
 * (observed-on-Friday/Monday shifts, Good Friday, Juneteenth from 2022) have
 * enough exceptions that a table is both shorter and more obviously correct.
 */
const HOLIDAYS = new Set<string>([
  // 2019
  '2019-01-01','2019-01-21','2019-02-18','2019-04-19','2019-05-27','2019-07-04','2019-09-02','2019-11-28','2019-12-25',
  // 2020
  '2020-01-01','2020-01-20','2020-02-17','2020-04-10','2020-05-25','2020-07-03','2020-09-07','2020-11-26','2020-12-25',
  // 2021
  '2021-01-01','2021-01-18','2021-02-15','2021-04-02','2021-05-31','2021-07-05','2021-09-06','2021-11-25','2021-12-24',
  // 2022
  '2022-01-17','2022-02-21','2022-04-15','2022-05-30','2022-06-20','2022-07-04','2022-09-05','2022-11-24','2022-12-26',
  // 2023
  '2023-01-02','2023-01-16','2023-02-20','2023-04-07','2023-05-29','2023-06-19','2023-07-04','2023-09-04','2023-11-23','2023-12-25',
  // 2024
  '2024-01-01','2024-01-15','2024-02-19','2024-03-29','2024-05-27','2024-06-19','2024-07-04','2024-09-02','2024-11-28','2024-12-25',
  // 2025
  '2025-01-01','2025-01-09','2025-01-20','2025-02-17','2025-04-18','2025-05-26','2025-06-19','2025-07-04','2025-09-01','2025-11-27','2025-12-25',
  // 2026
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  // 2027
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24',
  // 2028
  '2028-01-17','2028-02-21','2028-04-14','2028-05-29','2028-06-19','2028-07-04','2028-09-04','2028-11-23','2028-12-25',
  // 2029
  '2029-01-01','2029-01-15','2029-02-19','2029-03-30','2029-05-28','2029-06-19','2029-07-04','2029-09-03','2029-11-22','2029-12-25',
]);

/** Half-day sessions closing at 13:00 ET. */
const EARLY_CLOSES = new Set<string>([
  '2019-07-03','2019-11-29','2019-12-24',
  '2020-11-27','2020-12-24',
  '2021-11-26',
  '2022-11-25',
  '2023-07-03','2023-11-24',
  '2024-07-03','2024-11-29','2024-12-24',
  '2025-07-03','2025-11-28','2025-12-24',
  '2026-11-27','2026-12-24',
  '2027-11-26',
  '2028-07-03','2028-11-24',
  '2029-07-03','2029-11-23','2029-12-24',
]);

export function isTradingDay(utcMs: number): boolean {
  const p = toNewYork(utcMs);
  if (p.weekday === 0 || p.weekday === 6) return false;
  return !HOLIDAYS.has(isoDate(utcMs));
}

export function sessionCloseMinutes(utcMs: number): number {
  return EARLY_CLOSES.has(isoDate(utcMs)) ? EARLY_CLOSE_MINUTES : SESSION_CLOSE_MINUTES;
}

export function sessionMinutes(utcMs: number): number {
  return sessionCloseMinutes(utcMs) - SESSION_OPEN_MINUTES;
}

/** UTC ms of the 09:30 ET open for the session containing `utcMs`. */
export function sessionOpen(utcMs: number): number {
  const p = toNewYork(utcMs);
  return fromNewYork(p.year, p.month, p.day, SESSION_OPEN_MINUTES);
}

export function sessionClose(utcMs: number): number {
  const p = toNewYork(utcMs);
  return fromNewYork(p.year, p.month, p.day, sessionCloseMinutes(utcMs));
}

export function isMarketOpen(utcMs: number): boolean {
  if (!isTradingDay(utcMs)) return false;
  const p = toNewYork(utcMs);
  return p.minutes >= SESSION_OPEN_MINUTES && p.minutes < sessionCloseMinutes(utcMs);
}

/** Minutes elapsed since the open (0 before the open, session length after). */
export function minutesSinceOpen(utcMs: number): number {
  const p = toNewYork(utcMs);
  const close = sessionCloseMinutes(utcMs);
  if (p.minutes < SESSION_OPEN_MINUTES) return 0;
  if (p.minutes >= close) return close - SESSION_OPEN_MINUTES;
  return p.minutes - SESSION_OPEN_MINUTES;
}

/** Next trading day's session open, strictly after `utcMs`. */
export function nextSessionOpen(utcMs: number): number {
  let cursor = utcMs + DAY;
  for (let i = 0; i < 30; i += 1) {
    if (isTradingDay(cursor)) return sessionOpen(cursor);
    cursor += DAY;
  }
  return sessionOpen(cursor);
}

export function previousTradingDay(utcMs: number): number {
  let cursor = utcMs - DAY;
  for (let i = 0; i < 30; i += 1) {
    if (isTradingDay(cursor)) return cursor;
    cursor -= DAY;
  }
  return cursor;
}

/**
 * The close of the most recent session that has finished at `utcMs`.
 *
 * Today's close if the session is over, otherwise the previous trading day's.
 * This is the platform's evaluation instant: it is a function of the calendar
 * rather than of the wall clock, so every process evaluating "now" on a given
 * day agrees, which is what lets a cached daily publication and a
 * recomputed-per-request symbol page carry the same number.
 */
export function lastCompletedSessionClose(utcMs: number): number {
  if (isTradingDay(utcMs) && utcMs >= sessionClose(utcMs)) return sessionClose(utcMs);
  return sessionClose(previousTradingDay(utcMs));
}

/** Ascending list of session-open instants in [start, end]. */
export function tradingDaysBetween(start: number, end: number): number[] {
  const out: number[] = [];
  const p = toNewYork(start);
  let cursor = fromNewYork(p.year, p.month, p.day, SESSION_OPEN_MINUTES);
  while (cursor <= end) {
    if (isTradingDay(cursor)) out.push(sessionOpen(cursor));
    const nextDay = toNewYork(cursor + DAY + HOUR);
    cursor = fromNewYork(nextDay.year, nextDay.month, nextDay.day, SESSION_OPEN_MINUTES);
  }
  return out;
}

/** Count of trading days in [start, end]. */
export function tradingDayCount(start: number, end: number): number {
  return tradingDaysBetween(start, end).length;
}

/** Formats an instant as `HH:MM` New York time. */
export function formatNyTime(utcMs: number): string {
  const p = toNewYork(utcMs);
  return `${String(Math.floor(p.minutes / 60)).padStart(2, '0')}:${String(p.minutes % 60).padStart(2, '0')}`;
}

/**
 * Session phase, used by the UI header and by the intraday volatility profile.
 */
export type SessionPhase = 'pre_market' | 'opening_auction' | 'morning' | 'midday' | 'closing_auction' | 'after_hours' | 'closed';

export function sessionPhase(utcMs: number): SessionPhase {
  if (!isTradingDay(utcMs)) return 'closed';
  const p = toNewYork(utcMs);
  const close = sessionCloseMinutes(utcMs);
  if (p.minutes < 4 * 60) return 'closed';
  if (p.minutes < SESSION_OPEN_MINUTES) return 'pre_market';
  if (p.minutes < SESSION_OPEN_MINUTES + 30) return 'opening_auction';
  if (p.minutes < 12 * 60) return 'morning';
  if (p.minutes < close - 45) return 'midday';
  if (p.minutes < close) return 'closing_auction';
  if (p.minutes < 20 * 60) return 'after_hours';
  return 'closed';
}
