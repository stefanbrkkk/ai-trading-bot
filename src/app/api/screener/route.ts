/**
 * The universe screener.
 *
 * Filters and sorting are applied to the *published* snapshot rather than being
 * pushed into signal generation: the ranking every user sees is identical, and a
 * filter is a view over it. That distinction matters — filtering a shared list is
 * a screener, whereas re-ranking per user would be personalisation.
 */

import { z } from 'zod';
import { ApiError, csvList, handler, ok, parseQuery, pendingSetup } from '@/lib/api/respond';
import { applyScreenerFilter, getUniverseSnapshot } from '@/lib/engine/service';
import { SECTORS } from '@/lib/market/universe';
import type { RegimeLabel, ScreenerFilter, Sector, SignalDirection } from '@/lib/domain/types';

export const dynamic = 'force-dynamic';

const SORT_KEYS = [
  'symbol', 'name', 'sector', 'price', 'changePercent', 'conviction', 'probability',
  'direction', 'regime', 'relativeVolume', 'atrPercent', 'rsi14', 'ouZScore',
  'mlofiIntent', 'riskReversal25', 'altComposite', 'marketCap', 'adv30',
] as const;

const querySchema = z.object({
  sectors: csvList.optional(),
  regimes: csvList.optional(),
  direction: z.enum(['long', 'short', 'flat']).optional(),
  minConviction: z.coerce.number().min(0).max(100).optional(),
  maxConviction: z.coerce.number().min(0).max(100).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  minMarketCap: z.coerce.number().min(0).optional(),
  maxMarketCap: z.coerce.number().min(0).optional(),
  minRelativeVolume: z.coerce.number().min(0).optional(),
  minRsi: z.coerce.number().min(0).max(100).optional(),
  maxRsi: z.coerce.number().min(0).max(100).optional(),
  search: z.string().max(80).optional(),
  sortBy: z.enum(SORT_KEYS).optional(),
  sortDirection: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const GET = handler(async (request: Request) => {
  const q = parseQuery(request, querySchema);
  let snapshot;
  try {
    snapshot = await getUniverseSnapshot();
  } catch (error) {
    return pendingSetup('ENGINE_NOT_READY', error instanceof Error ? error.message : 'Engine unavailable.');
  }

  const validSectors = new Set<string>(SECTORS);
  const filter: ScreenerFilter = {
    /*
     * An unrecognised sector is an error, not an empty filter.
     *
     * Filtering the list silently dropped `?sectors=Nope` and returned the whole
     * universe — the same class of bad input that returns 0 rows for an unknown
     * regime and a 422 for an unknown direction. Three behaviours for one mistake
     * is worse than any one of them.
     */
    ...(q.sectors ? { sectors: q.sectors as Sector[] } : {}),
    ...(q.regimes ? { regimes: q.regimes as RegimeLabel[] } : {}),
    ...(q.direction ? { direction: q.direction as SignalDirection } : {}),
    ...(q.minConviction !== undefined ? { minConviction: q.minConviction } : {}),
    ...(q.maxConviction !== undefined ? { maxConviction: q.maxConviction } : {}),
    ...(q.minPrice !== undefined ? { minPrice: q.minPrice } : {}),
    ...(q.maxPrice !== undefined ? { maxPrice: q.maxPrice } : {}),
    ...(q.minMarketCap !== undefined ? { minMarketCap: q.minMarketCap } : {}),
    ...(q.maxMarketCap !== undefined ? { maxMarketCap: q.maxMarketCap } : {}),
    ...(q.minRelativeVolume !== undefined ? { minRelativeVolume: q.minRelativeVolume } : {}),
    ...(q.minRsi !== undefined ? { minRsi: q.minRsi } : {}),
    ...(q.maxRsi !== undefined ? { maxRsi: q.maxRsi } : {}),
    ...(q.search ? { search: q.search } : {}),
    sortBy: q.sortBy ?? 'conviction',
    sortDirection: q.sortDirection ?? 'desc',
    limit: q.limit ?? 64,
  };

  /*
   * `matched` counts what the filter matched; `rows` is the page returned.
   *
   * Reading it off the truncated array made the screener's own headline tile read
   * "MATCHED 64 / of 67" with no filter applied at all, and "MATCHED 10" for
   * `?limit=10` — the limit was being reported as a property of the market.
   */
  const matchedRows = applyScreenerFilter(snapshot.rows, { ...filter, limit: 0 });
  const unknownSectors = (q.sectors ?? []).filter((sector) => !validSectors.has(sector));
  if (unknownSectors.length > 0) {
    throw new ApiError(
      'INVALID_REQUEST',
      `Unknown sector${unknownSectors.length > 1 ? 's' : ''}: ${unknownSectors.join(', ')}. Known sectors are ${SECTORS.join(', ')}.`,
      422,
    );
  }

  const rows = applyScreenerFilter(snapshot.rows, filter);
  return ok({
    rows,
    total: snapshot.rows.length,
    matched: matchedRows.length,
    returned: rows.length,
    computedAt: snapshot.computedAt,
    provider: snapshot.provider,
    modelVersion: snapshot.modelVersion,
    sectors: SECTORS,
    appliedFilter: filter,
  });
});
