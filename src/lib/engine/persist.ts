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
 * The sweep is written on every call, and the write is idempotent by content:
 * `insertSignal` upserts on the deterministic signal id, `writeFeatureValues` on
 * (symbol, as_of, feature_key) and `insertQuotes` on (symbol, ts), so re-running
 * it at the same instant replaces each row with the identical row. The store
 * keeps its append-only shape across instants — a new vintage is added beside
 * the old one rather than replacing it, which is what makes "what did you
 * believe on the 14th" still answerable after this runs on the 17th.
 *
 * It did not always. This function used to skip the write whenever the store
 * already held a vintage at or after the evaluation instant:
 *
 *     if (stored !== null && stored >= asOf) return { written: false, … }
 *
 * The evaluation instant is the last completed session close — a function of the
 * calendar, deliberately, so that every surface agrees on when it is evaluating.
 * That makes the instant *stop moving* for a whole trading day, and the guard
 * read "a vintage exists at this instant" as "the store is current", which is a
 * different claim: the sweep's output also depends on the model and on the code.
 * Change either, restart, and the equality branch fires and discards the new
 * sweep forever, because no later boot can ever produce a larger instant on that
 * day either. Measured on the shipped store: 59 of 67 conviction scores, 16 of
 * 67 directions and all 67 prices disagreed between InvestGPT — which compiles
 * against `v_equity_snapshot`, i.e. this table — and the screener beside it. SO
 * answered flat/0/133.13 to the SQL surface and long/32.1/131.98 to every live
 * one; `/api/signals/top5` led with SO while InvestGPT's own top row was SCHW at
 * 41.8, a name the terminal scored 16.7.
 *
 * There is no cheap content probe that would have caught it. Probing one symbol
 * is what the old guard did, and a change that moves some symbols and not others
 * — the flat-levels repair in pipeline.ts is exactly one — leaves the probe
 * symbol identical while the sweep behind it has moved. Reading all 67 back to
 * compare costs about what writing them costs. So the guard is gone: this runs
 * once per process at boot (`src/instrumentation.ts`), and paying for ~67 upserts
 * there is the price of the store never disagreeing with the platform again.
 */

import { insertQuotes, insertSignal, upsertSymbols } from '@/lib/db';
import { ALL_SYMBOLS, requireSpec, symbolMeta } from '@/lib/market/universe';
import { resolveMarketProvider } from '@/lib/market/provider';
import type { UniverseSnapshot } from './service';

export interface PersistResult {
  /** False only when the snapshot carried no signals, so there was nothing to write. */
  written: boolean;
  asOf: number;
  signals: number;
  quotes: number;
}

export async function persistUniverseSnapshot(snapshot: UniverseSnapshot): Promise<PersistResult> {
  const asOf = snapshot.computedAt;
  if (snapshot.signals.length === 0) return { written: false, asOf, signals: 0, quotes: 0 };

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
