/**
 * The forensic audit feed.
 *
 * Admin-only, and the restriction is substantive rather than conventional: these
 * records contain click coordinates, IP addresses, user agents and raw broker
 * payloads for every user. That is exactly the evidence a regulator would ask for
 * and exactly the data a user should never be able to read about another user.
 *
 * Each order's telemetry carries the six mandatory fields and the click → API →
 * broker-ACK timestamp chain, so the latency of a routing decision can be
 * attributed to a stage rather than guessed at. The derived intervals are computed
 * here rather than client-side because the reconstruction has to agree between the
 * console and any exported evidence.
 */

import { z } from 'zod';
import { ApiError, handler, ok, parseQuery } from '@/lib/api/respond';
import { requireAdmin } from '@/lib/auth/session';
import {
  countAuditEvents,
  ledgerCounts,
  listAuditEvents,
  listRecentTelemetry,
  listRiskDecisions,
  rejectionCounts,
} from '@/lib/db';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  eventType: z.string().max(60).optional(),
  userId: z.string().max(120).optional(),
  orderId: z.string().max(120).optional(),
  correlationId: z.string().max(120).optional(),
  since: z.coerce.number().int().min(0).optional(),
  until: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const GET = handler(async (request: Request) => {
  // Throws AuthError (401) or ApiError (403); the handler maps both.
  const admin = await requireAdmin();
  const q = parseQuery(request, querySchema);

  const events = listAuditEvents({
    ...(q.eventType === undefined ? {} : { eventType: q.eventType }),
    ...(q.userId === undefined ? {} : { userId: q.userId }),
    ...(q.orderId === undefined ? {} : { orderId: q.orderId }),
    ...(q.correlationId === undefined ? {} : { correlationId: q.correlationId }),
    ...(q.since === undefined ? {} : { since: q.since }),
    ...(q.until === undefined ? {} : { until: q.until }),
    limit: q.limit ?? 200,
  });

  const telemetry = listRecentTelemetry(Math.min(q.limit ?? 50, 200)).map((record) => {
    const t = record.timestamps;
    return {
      ...record,
      /**
       * Derived intervals. `null` rather than a negative number when a stage did
       * not complete — a broker that never acknowledged has no ACK latency, and
       * reporting one as zero would understate the incident.
       */
      intervals: {
        clickToServerMs: t.serverReceived - t.clientClick,
        riskMs: t.riskCompleted - t.serverReceived,
        dispatchMs: t.brokerDispatched - t.riskCompleted,
        brokerAckMs: t.brokerAcknowledged === null ? null : t.brokerAcknowledged - t.brokerDispatched,
        totalMs: t.brokerAcknowledged === null ? null : t.brokerAcknowledged - t.clientClick,
      },
    };
  });

  const dayAgo = Date.now() - 86_400_000;

  return ok({
    events,
    eventTotal: countAuditEvents(),
    telemetry,
    riskDecisions: listRiskDecisions({ limit: 100 }),
    rejectionsLastDay: rejectionCounts(dayAgo),
    ledger: ledgerCounts(),
    /**
     * Echoed so the console can display which admin's session read the feed. An
     * audit console that is not itself auditable is a gap.
     */
    readBy: { userId: admin.id, email: admin.email },
  });
});

/** Rejects a write attempt explicitly rather than 405-ing on a missing export. */
export const POST = handler(async () => {
  throw new ApiError(
    'READ_ONLY',
    'The audit ledger is append-only and is written by the platform, never by a client.',
    405,
  );
});
