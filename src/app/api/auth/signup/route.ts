import { z } from 'zod';
import { ApiError, handler, ok, parseBody } from '@/lib/api/respond';
import { CREDENTIAL_ATTEMPTS_PER_MINUTE, CREDENTIAL_WINDOW_MS } from '@/lib/risk';
import { hitRateLimit } from '@/lib/db';
import { requestContext } from '@/lib/auth/session';
import { entitlement, signUp } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(200),
  displayName: z.string().max(80).optional(),
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);

  /*
   * Rate limited before the account is created, so registration cannot be used
   * to flood the ledger.
   *
   * Unlike sign-in there is no per-account key worth having — an attacker picks a
   * fresh email every time — so the client address is the only useful bucket, and
   * it is only a real bucket when a trusted proxy attests to it. Without one, all
   * that is left is a global floodgate. It is set an order of magnitude higher on
   * purpose: a shared bucket at the per-address limit would let one script lock
   * every visitor out of registering, which trades a nuisance for an outage.
   */
  const ctx = await requestContext();
  const attributable = ctx.ipAddress !== 'unattributed' && ctx.ipAddress !== 'unavailable';
  const verdict = attributable
    ? hitRateLimit(`auth:signup:ip:${ctx.ipAddress}`, {
        limit: CREDENTIAL_ATTEMPTS_PER_MINUTE,
        windowMs: CREDENTIAL_WINDOW_MS,
      })
    : hitRateLimit('auth:signup:global', {
        limit: CREDENTIAL_ATTEMPTS_PER_MINUTE * 20,
        windowMs: CREDENTIAL_WINDOW_MS,
      });
  if (!verdict.allowed) {
    throw new ApiError('RATE_LIMITED', 'Too many attempts. Wait a minute and try again.', 429, {
      retryAfterMs: Math.max(0, verdict.resetAt - Date.now()),
    });
  }
  const result = await signUp(body);
  if (!result.ok || !result.user) throw new ApiError('SIGNUP_REJECTED', result.error ?? 'Sign-up failed.', 400);
  return ok({ user: result.user, entitlement: entitlement(result.user) }, { status: 201 });
});
