/**
 * Universe invariants.
 *
 * These are cheap assertions about a hand-maintained table, and they exist
 * because the table is the one part of the engine that a person edits by hand.
 * The sweep-limit check is the important one: it caught a limit of 64 sitting
 * under a 67-name tradable universe, which dropped the last three names from the
 * screener and the published ranking while leaving their symbol and order pages
 * fully functional — the platform covered a symbol or not depending on the route
 * taken to it, with nothing anywhere reporting a truncation.
 */

import { describe, expect, it } from 'vitest';
import { SECTORS, TRADABLE_SYMBOLS, UNIVERSE, symbolsInSector } from '@/lib/market/universe';
import { UNIVERSE_SWEEP_LIMIT } from '@/lib/engine/service';

describe('universe table', () => {
  it('never exceeds the sweep limit, so no name is silently dropped', () => {
    expect(TRADABLE_SYMBOLS.length).toBeLessThanOrEqual(UNIVERSE_SWEEP_LIMIT);
  });

  it('has unique symbols', () => {
    expect(new Set(UNIVERSE.map((u) => u.symbol)).size).toBe(UNIVERSE.length);
  });

  it('separates benchmarks from the tradable set', () => {
    const benchmarks = UNIVERSE.filter((u) => u.isBenchmark);
    expect(benchmarks.length).toBeGreaterThan(0);
    expect(TRADABLE_SYMBOLS.length).toBe(UNIVERSE.length - benchmarks.length);
    for (const b of benchmarks) expect(TRADABLE_SYMBOLS).not.toContain(b.symbol);
  });

  it('gives every name a positive market cap, ADV and share count', () => {
    for (const spec of UNIVERSE) {
      expect(spec.marketCap, spec.symbol).toBeGreaterThan(0);
      expect(spec.adv30, spec.symbol).toBeGreaterThan(0);
      expect(spec.sharesOutstanding, spec.symbol).toBeGreaterThan(0);
    }
  });

  it('places every name in a sector that resolves back to it', () => {
    for (const spec of UNIVERSE) {
      expect(SECTORS).toContain(spec.sector);
      expect(symbolsInSector(spec.sector)).toContain(spec.symbol);
    }
  });
});
