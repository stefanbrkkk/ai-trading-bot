/**
 * The user's own pre-trade risk decisions.
 *
 * Distinct from the admin audit feed in one respect that matters: this endpoint is
 * scoped to the caller. A user is entitled to the complete record of every check
 * run against their own orders — which limit fired, what it observed, what the
 * threshold was — and to nothing at all about anyone else's. The `userId` filter is
 * applied from the session, never from a query parameter, so there is no shape of
 * request that widens it.
 *
 * Rejections are the useful half of this record. An approved order is visible in
 * the blotter; a rejected one leaves no other trace, and "why was I stopped" is the
 * question this exists to answer.
 */

import { z } from 'zod';
import { ApiError, handler, ok, parseQuery } from '@/lib/api/respond';
import { currentUser } from '@/lib/auth/session';
import { listRiskDecisions } from '@/lib/db';
import { RISK_LIMIT_DESCRIPTORS } from '@/lib/risk';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  symbol: z.string().max(12).optional(),
  approved: z.enum(['true', 'false']).optional(),
  since: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const GET = handler(async (request: Request) => {
  const user = await currentUser();
  if (!user) throw new ApiError('UNAUTHENTICATED', 'Sign in to read your risk decisions.', 401);

  const q = parseQuery(request, querySchema);
  const limit = q.limit ?? 100;

  /**
   * `listRiskDecisions` has no symbol predicate, so the symbol filter is applied
   * after the query. The row limit is therefore raised before filtering — asking
   * the store for `limit` rows and then discarding the ones for other symbols
   * would return far fewer than requested and look like a missing history.
   */
  const fetched = listRiskDecisions({
    // Bound to the session, not to the request.
    userId: user.id,
    ...(q.approved === undefined ? {} : { approved: q.approved === 'true' }),
    ...(q.since === undefined ? {} : { since: q.since }),
    limit: q.symbol === undefined ? limit : Math.min(limit * 20, 2000),
  });

  const symbol = q.symbol?.toUpperCase();
  const decisions = (symbol === undefined ? fetched : fetched.filter((record) => record.symbol === symbol)).slice(
    0,
    limit,
  );

  const rejections = decisions.filter((record) => !record.decision.approved);
  const byCode = new Map<string, number>();
  for (const record of rejections) {
    const code = record.decision.rejection?.code ?? 'UNKNOWN';
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
  }

  return ok({
    decisions,
    total: decisions.length,
    approved: decisions.length - rejections.length,
    rejected: rejections.length,
    rejectionsByCode: [...byCode.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    /**
     * The published limits are returned with the history so the two are read
     * together. A rejection code without its threshold is not actionable.
     */
    limits: RISK_LIMIT_DESCRIPTORS,
  });
});
