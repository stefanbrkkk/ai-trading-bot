/**
 * The evaluation instant.
 *
 * `lastCompletedSessionClose` is what makes the platform self-consistent, so it
 * gets its own tests rather than being covered incidentally. The daily
 * publication is persisted to disk — it is immutable for its date, one ranking
 * identical for every subscriber — while the screener sweep and every symbol
 * page recompute per request. If the instant those recomputations use moved with
 * the wall clock, the cached list and the pages it links to would disagree, and
 * they did: a list published with SCHW at 33.6 long, MRK at 22.6 long and DE at
 * 22.3 long, whose own detail pages read 0 flat, 15.7 short and 12.6 short.
 *
 * What has to hold is that the instant is a function of the calendar: constant
 * across every hour of a session, and moving exactly once, at the close.
 */

import { describe, expect, it } from 'vitest';
import {
  DAY,
  isTradingDay,
  isoDate,
  lastCompletedSessionClose,
  previousTradingDay,
  sessionClose,
} from '@/lib/market/calendar';

/** 2026-08-17 is a Monday; 2026-08-14 the Friday before it. */
const MONDAY_OPEN = Date.UTC(2026, 7, 17, 13, 30);
const MONDAY_CLOSE = Date.UTC(2026, 7, 17, 20, 0);
const HOUR = 60 * 60 * 1000;

describe('lastCompletedSessionClose', () => {
  it('is the previous session while today is still open', () => {
    const friday = sessionClose(previousTradingDay(MONDAY_OPEN));
    for (const minutesIn of [0, 30, 120, 300, 388]) {
      const at = MONDAY_OPEN + minutesIn * 60_000;
      expect(lastCompletedSessionClose(at), `${minutesIn}m into the session`).toBe(friday);
    }
  });

  it('moves to today once the session has closed, and then stays put', () => {
    expect(lastCompletedSessionClose(MONDAY_CLOSE)).toBe(MONDAY_CLOSE);
    for (const hoursAfter of [1, 3, 6, 8]) {
      expect(lastCompletedSessionClose(MONDAY_CLOSE + hoursAfter * HOUR)).toBe(MONDAY_CLOSE);
    }
  });

  it('never returns an instant that is not a completed session close', () => {
    // A fortnight of hourly samples, including both weekends.
    for (let at = MONDAY_OPEN - 7 * DAY; at < MONDAY_OPEN + 7 * DAY; at += HOUR) {
      const close = lastCompletedSessionClose(at);
      expect(close, `at ${new Date(at).toISOString()}`).toBeLessThanOrEqual(at);
      expect(isTradingDay(close), `${isoDate(close)} is a trading day`).toBe(true);
      expect(close).toBe(sessionClose(close));
    }
  });

  it('holds one value across a whole weekend', () => {
    // Saturday morning through Sunday night all resolve to Friday's close.
    const saturday = MONDAY_OPEN - 2 * DAY;
    const friday = lastCompletedSessionClose(saturday);
    const seen = new Set<number>();
    for (let at = saturday; at < MONDAY_OPEN; at += HOUR) seen.add(lastCompletedSessionClose(at));
    expect([...seen]).toEqual([friday]);
  });
});
