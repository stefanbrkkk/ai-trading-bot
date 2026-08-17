/** The authenticated user's order history, newest first. */
import { z } from 'zod';
import { ApiError, handler, ok, parseQuery } from '@/lib/api/respond';
import { currentUser } from '@/lib/auth/session';
import { getOrderTelemetry, listOrders } from '@/lib/db';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  status: z.enum(['pending_risk', 'rejected_risk', 'submitted', 'partially_filled', 'filled', 'canceled', 'broker_error']).optional(),
  account: z.enum(['paper', 'live']).optional(),
  since: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  withTelemetry: z.enum(['true', 'false']).optional(),
});

export const GET = handler(async (request: Request) => {
  const user = await currentUser();
  if (!user) throw new ApiError('UNAUTHENTICATED', 'Sign in to view your orders.', 401);
  const q = parseQuery(request, querySchema);

  const orders = listOrders({
    userId: user.id,
    ...(q.status ? { status: q.status } : {}),
    ...(q.account ? { account: q.account } : {}),
    ...(q.since !== undefined ? { since: q.since } : {}),
    limit: q.limit ?? 100,
  });

  const withTelemetry = q.withTelemetry === 'true';
  return ok({
    orders: orders.map((order) =>
      withTelemetry ? { ...order, telemetry: getOrderTelemetry(order.id) } : order,
    ),
    count: orders.length,
  });
});
