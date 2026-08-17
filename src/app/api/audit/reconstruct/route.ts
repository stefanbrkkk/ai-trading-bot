/**
 * Bitemporal reconstruction.
 *
 * Answers the question a regulator actually asks, which is not "what does the
 * record say now" but "what did the platform believe at 14:32 on the day of the
 * trade, using only what it knew at that moment". Those are different questions,
 * and a store with one time axis can only answer the first.
 *
 * The two axes are independent:
 *
 *   • `asOf` is *valid time* — the instant in the modelled world being rebuilt.
 *   • `recordedAsOf` is *transaction time* — the cutoff on what the platform had
 *     learned. Setting it earlier excludes corrections made afterwards.
 *
 * Holding `asOf` fixed and moving `recordedAsOf` shows how the platform's account
 * of a past moment changed as it learned more, which is precisely what
 * distinguishes a genuine bitemporal ledger from a versioned table. The append-only
 * proof is returned alongside, because a reconstruction is only evidence if the
 * rows behind it provably cannot have been edited.
 */

import { z } from 'zod';
import { handler, ok, parseQuery } from '@/lib/api/respond';
import { requireAdmin } from '@/lib/auth/session';
import { assertAppendOnly, history, ledgerCounts, reconstruct } from '@/lib/db';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  entityKind: z.string().min(1).max(60),
  entityId: z.string().min(1).max(120),
  facet: z.string().min(1).max(60),
  asOf: z.coerce.number().int().min(0).optional(),
  recordedAsOf: z.coerce.number().int().min(0).optional(),
  /** Include the full snapshot/delta chain, not just the rebuilt state. */
  includeHistory: z.coerce.boolean().optional(),
});

export const GET = handler(async (request: Request) => {
  await requireAdmin();
  const q = parseQuery(request, querySchema);

  const key = { entityKind: q.entityKind, entityId: q.entityId, facet: q.facet };
  const state = reconstruct({
    ...key,
    ...(q.asOf === undefined ? {} : { asOf: q.asOf }),
    ...(q.recordedAsOf === undefined ? {} : { recordedAsOf: q.recordedAsOf }),
  });

  return ok({
    key,
    reconstruction: state,
    /**
     * A facet with no snapshot at or before `asOf` reconstructs to null. That is a
     * correct answer — the platform did not know about this entity yet — and it is
     * labelled as such so the console does not render it as an error.
     */
    exists: state.state !== null,
    ...(q.includeHistory === true ? { history: history({ ...key, limit: 500 }) } : {}),
    ledger: ledgerCounts(),
    appendOnly: safeProof(),
  });
});

/**
 * The append-only proof, guarded.
 *
 * `assertAppendOnly` verifies enforcement by attempting a real UPDATE and a real
 * DELETE against a real row and confirming the engine aborts both. If the triggers
 * were somehow absent the attempt would *succeed*, so the function throws rather
 * than returning false — and a thrown proof must not take down the reconstruction
 * that a reviewer is in the middle of reading. It is reported as unenforced
 * instead, which is the finding.
 */
function safeProof(): { enforced: boolean; triggers: string[]; updateBlocked: boolean; deleteBlocked: boolean; error: string | null } {
  try {
    const proof = assertAppendOnly();
    return { ...proof, error: null };
  } catch (error) {
    return {
      enforced: false,
      triggers: [],
      updateBlocked: false,
      deleteBlocked: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
