/**
 * The account snapshot, read live from the broker.
 *
 * Control 4 of the 15c3-5 parallel requires a real pre-trade buying-power check,
 * so this is a genuine broker call rather than a cached figure. When the broker
 * cannot answer, the response says so explicitly and the risk engine fails closed
 * rather than assuming funds are available.
 */

import { ApiError, correlationId, handler, ok } from '@/lib/api/respond';
import { currentUser, entitlement } from '@/lib/auth/session';
import { getBroker } from '@/lib/broker';
import { upsertAccount } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const user = await currentUser();
  if (!user) throw new ApiError('UNAUTHENTICATED', 'Sign in to view your account.', 401);

  const url = new URL(request.url);
  const account = url.searchParams.get('account') === 'live' ? 'live' : 'paper';
  const gate = entitlement(user);
  if (account === 'live' && !gate.live) throw new ApiError('SUBSCRIPTION_REQUIRED', gate.reason, 402);

  const broker = getBroker();
  const correlation = correlationId();
  const result = await broker.getAccount(account, {
    correlationId: correlation,
    userId: user.id,
    dispatchedAt: Date.now(),
  });

  if (result.data) upsertAccount(user.id, result.data);

  return ok(
    {
      account: result.data,
      broker: broker.describe(),
      brokerStatus: result.status,
      available: result.ok && result.data !== null,
      error: result.data
        ? null
        : (result.error ?? 'The broker did not return an account snapshot.'),
      entitlement: gate,
    },
    { correlation },
  );
});
