/**
 * The global kill switch.
 *
 * FINRA/SEC Rule 15c3-5 requires a market-access halt that an operator can
 * trigger instantaneously, with no code deployment and no server reboot. On
 * engagement the platform rejects every incoming order request with HTTP 503,
 * stops routing, and attempts to cancel pending orders where the broker permits —
 * and each cancellation attempt is logged whether or not it succeeded.
 */

import { z } from 'zod';
import { ApiError, handler, ok, parseBody } from '@/lib/api/respond';
import { requireAdmin, requestContext } from '@/lib/auth/session';
import { killSwitchHistory, killSwitchState, listOrders, recordKillSwitch, insertAuditEvent } from '@/lib/db';
import { getBroker } from '@/lib/broker';

export const dynamic = 'force-dynamic';

const ADMIN_SPIFFE_ID = 'spiffe://aurelius.local/ns/platform/sa/admin-console';

const bodySchema = z.object({
  active: z.boolean(),
  reason: z.string().min(4).max(500),
});

export const GET = handler(async () => {
  await requireAdmin();
  const state = killSwitchState();
  return ok({ ...state, history: killSwitchHistory(25) });
});

export const POST = handler(async (request: Request) => {
  const admin = await requireAdmin();
  const body = await parseBody(request, bodySchema);
  const ctx = await requestContext();
  const now = Date.now();

  if (body.active === killSwitchState().engaged) {
    throw new ApiError('NO_CHANGE', `The kill switch is already ${body.active ? 'engaged' : 'released'}.`, 409);
  }

  const cancelAttempts: { orderId: string; brokerOrderId: string | null; status: number | null; ok: boolean }[] = [];

  if (body.active) {
    // Attempt to cancel everything still working. Failures are recorded rather
    // than swallowed: the audit record must show the attempt was made.
    const working: readonly ('submitted' | 'partially_filled' | 'pending_risk')[] = [
      'submitted',
      'partially_filled',
      'pending_risk',
    ];
    const pending = working.flatMap((status) => listOrders({ status }));
    const broker = getBroker();
    for (const order of pending) {
      if (!order.brokerOrderId) {
        cancelAttempts.push({ orderId: order.id, brokerOrderId: null, status: null, ok: false });
        continue;
      }
      try {
        const result = await broker.cancelOrder(order.brokerOrderId, {
          correlationId: `kill_${now}`,
          userId: admin.id,
          dispatchedAt: now,
        });
        cancelAttempts.push({
          orderId: order.id,
          brokerOrderId: order.brokerOrderId,
          status: result.status,
          ok: result.ok,
        });
      } catch {
        cancelAttempts.push({ orderId: order.id, brokerOrderId: order.brokerOrderId, status: null, ok: false });
      }
    }
  }

  const state = recordKillSwitch({
    engaged: body.active,
    engagedAt: body.active ? now : null,
    engagedBy: admin.email,
    reason: body.reason,
    cancelledOrders: cancelAttempts.filter((a) => a.ok).length,
  });

  insertAuditEvent({
    eventType: body.active ? 'kill_switch_engaged' : 'kill_switch_released',
    userId: admin.id,
    sessionToken: null,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    clickX: null,
    clickY: null,
    resource: 'kill_switch',
    orderId: null,
    rawPayload: JSON.stringify({ reason: body.reason, cancelAttempts }),
    brokerStatus: null,
    brokerBody: null,
    spiffeId: ADMIN_SPIFFE_ID,
    correlationId: `kill_${now}`,
  });

  return ok({ ...state, cancelAttempts });
});
