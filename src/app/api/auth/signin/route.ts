import { z } from 'zod';
import { ApiError, handler, ok, parseBody } from '@/lib/api/respond';
import { CREDENTIAL_ATTEMPTS_PER_MINUTE, CREDENTIAL_WINDOW_MS } from '@/lib/risk';
import { hitRateLimit } from '@/lib/db';
import { requestContext } from '@/lib/auth/session';
import { entitlement, signIn } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ email: z.string().min(3).max(254), password: z.string().min(1).max(200) });

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);

  /*
   * Rate limited before the credential is touched. Without it this endpoint
   * served unlimited attempts, which makes an online guess against a weak
   * password a matter of patience rather than difficulty.
   *
   * Keyed on the account first, and on the client address only when there is a
   * trusted proxy to attest to it. Address alone was the whole control, and an
   * address is whatever the caller's `X-Real-IP` header says it is: rotating it
   * per request handed every attempt a fresh budget. The account key cannot be
   * rotated — it is the thing being attacked — so credential stuffing against one
   * login is throttled no matter where it comes from.
   */
  const ctx = await requestContext();
  const attributable = ctx.ipAddress !== 'unattributed' && ctx.ipAddress !== 'unavailable';
  const buckets = [
    // Without an attributable address, rotating account names must not bypass
    // all limits before the synchronous password KDF runs.
    ...(attributable ? [] : ['auth:signin:global']),
    `auth:signin:acct:${body.email.trim().toLowerCase()}`,
    ...(attributable ? [`auth:signin:ip:${ctx.ipAddress}`] : []),
  ];
  for (const bucket of buckets) {
    const verdict = hitRateLimit(bucket, {
      limit: bucket === 'auth:signin:global'
        ? CREDENTIAL_ATTEMPTS_PER_MINUTE * 20
        : CREDENTIAL_ATTEMPTS_PER_MINUTE,
      windowMs: CREDENTIAL_WINDOW_MS,
    });
    if (!verdict.allowed) {
      throw new ApiError('RATE_LIMITED', 'Too many attempts. Wait a minute and try again.', 429, {
        retryAfterMs: Math.max(0, verdict.resetAt - Date.now()),
      });
    }
  }
  const result = await signIn(body.email, body.password);
  // A failed sign-in returns 401 with a single generic message: distinguishing
  // "no such account" from "wrong password" is an account-enumeration oracle.
  if (!result.ok || !result.user) throw new ApiError('INVALID_CREDENTIALS', result.error ?? 'Sign-in failed.', 401);
  return ok({ user: result.user, entitlement: entitlement(result.user) });
});
