/**
 * The universe screener.
 *
 * Filters and sorting are applied to the *published* snapshot rather than being
 * pushed into signal generation: the ranking every user sees is identical, and a
 * filter is a view over it. That distinction matters — filtering a shared list is
 * a screener, whereas re-ranking per user would be personalisation.
 */

import { z } from 'zod';
import { ApiError, csvList, handler, ok, parseQuery } from '@/lib/api/respond';
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
    throw new ApiError('ENGINE_NOT_READY', error instanceof Error ? error.message : 'Engine unavailable.', 503);
  }

  const validSectors = new Set<string>(SECTORS);
  const filter: ScreenerFilter = {
    ...(q.sectors ? { sectors: q.sectors.filter((s) => validSectors.has(s)) as Sector[] } : {}),
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

  const rows = applyScreenerFilter(snapshot.rows, filter);
  return ok({
    rows,
    total: snapshot.rows.length,
    matched: rows.length,
    computedAt: snapshot.computedAt,
    provider: snapshot.provider,
    modelVersion: snapshot.modelVersion,
    sectors: SECTORS,
    appliedFilter: filter,
  });
});
