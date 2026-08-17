/** Open positions, read live from the broker. */
import { ApiError, correlationId, handler, ok } from '@/lib/api/respond';
import { currentUser, entitlement } from '@/lib/auth/session';
import { getBroker } from '@/lib/broker';
import { upsertPosition } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const user = await currentUser();
  if (!user) throw new ApiError('UNAUTHENTICATED', 'Sign in to view your positions.', 401);

  const url = new URL(request.url);
  const account = url.searchParams.get('account') === 'live' ? 'live' : 'paper';
  const gate = entitlement(user);
  if (account === 'live' && !gate.live) throw new ApiError('SUBSCRIPTION_REQUIRED', gate.reason, 402);

  const broker = getBroker();
  const correlation = correlationId();
  const result = await broker.getPositions(account, {
    correlationId: correlation,
    userId: user.id,
    dispatchedAt: Date.now(),
  });

  const positions = result.data ?? [];
  for (const position of positions) upsertPosition(user.id, position);

  return ok(
    {
      positions,
      brokerStatus: result.status,
      available: result.ok,
      error: result.ok ? null : (result.error ?? 'The broker did not return positions.'),
      /**
       * No suggested sizing accompanies this response. Position sizing is the
       * user's decision and the platform does not model it against their balance.
       */
      sizingNotice:
        'Aurelius does not compute position sizes from your account. Any exposure figure shown elsewhere is an impersonal model statistic.',
    },
    { correlation },
  );
});
