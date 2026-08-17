/**
 * Publishes the universe sweep into the store.
 *
 * `v_equity_snapshot` is the relation InvestGPT compiles against, and it pivots
 * `feature_values` and joins the newest quote. Only the seed ever wrote those, at
 * the instant the seed pinned — so the SQL surface answered from a snapshot that
 * aged away from the rest of the platform. Measured three days after a seed:
 * "top 10 by conviction" returned PEP 34.7, COST 31.9, TSLA 29.3 while the
 * screener beside it read PG 37.4, PEP 35.1, NKE 28.8, and a name InvestGPT
 * reported as short did not appear in the screener's list at all. One platform
 * has to have one set of numbers.
 *
 * The write is idempotent per evaluation instant. That instant is the last
 * completed session close, so a server that restarts six times in a day writes
 * once, and the store keeps its append-only shape: a new vintage is added beside
 * the old one rather than replacing it, which is what makes "what did you believe
 * on the 14th" still answerable after this runs on the 17th.
 */

import { insertQuotes, insertSignal, latestFeatureAsOf, upsertSymbols } from '@/lib/db';
import { ALL_SYMBOLS, requireSpec, symbolMeta } from '@/lib/market/universe';
import { resolveMarketProvider } from '@/lib/market/provider';
import type { UniverseSnapshot } from './service';

export interface PersistResult {
  /** False when a vintage at or after this instant is already stored. */
  written: boolean;
  asOf: number;
  signals: number;
  quotes: number;
}

export async function persistUniverseSnapshot(snapshot: UniverseSnapshot): Promise<PersistResult> {
  const asOf = snapshot.computedAt;
  const first = snapshot.signals[0];
  if (first === undefined) return { written: false, asOf, signals: 0, quotes: 0 };

  // One probe is enough: the sweep writes every symbol in the same pass, so the
  // vintage is either present for all of them or for none.
  const stored = latestFeatureAsOf(first.symbol);
  if (stored !== null && stored >= asOf) return { written: false, asOf, signals: 0, quotes: 0 };

  /*
   * `v_equity_snapshot` inner-joins `symbols`, so a name with feature rows and no
   * dimension row is invisible to the view — a silent hole in the screener rather
   * than an error. The dimension table is pure reference metadata and costs
   * nothing to fill completely.
   */
  upsertSymbols(ALL_SYMBOLS.map((symbol) => symbolMeta(requireSpec(symbol))));

  const provider = resolveMarketProvider();
  const symbols = snapshot.signals.map((signal) => signal.symbol);
  const quotes = (await Promise.all(symbols.map((symbol) => provider.quote(symbol, asOf).catch(() => null)))).filter(
    (quote): quote is NonNullable<typeof quote> => quote !== null,
  );
  if (quotes.length > 0) insertQuotes(quotes);

  // `insertSignal` writes the signal's own feature values as a side effect, which
  // is what populates the view.
  for (const signal of snapshot.signals) insertSignal(signal);

  return { written: true, asOf, signals: snapshot.signals.length, quotes: quotes.length };
}
