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
   * Rate limited by client address before the credential is touched. Without it
   * this endpoint served unlimited attempts, which makes an online guess against
   * a weak password a matter of patience rather than difficulty.
   */
  const ctx = await requestContext();
  const verdict = hitRateLimit(`auth:signin:${ctx.ipAddress || 'unknown'}`, {
    limit: CREDENTIAL_ATTEMPTS_PER_MINUTE,
    windowMs: CREDENTIAL_WINDOW_MS,
  });
  if (!verdict.allowed) {
    throw new ApiError('RATE_LIMITED', 'Too many attempts. Wait a minute and try again.', 429, {
      retryAfterMs: Math.max(0, verdict.resetAt - Date.now()),
    });
  }
  const result = await signIn(body.email, body.password);
  // A failed sign-in returns 401 with a single generic message: distinguishing
  // "no such account" from "wrong password" is an account-enumeration oracle.
  if (!result.ok || !result.user) throw new ApiError('INVALID_CREDENTIALS', result.error ?? 'Sign-in failed.', 401);
  return ok({ user: result.user, entitlement: entitlement(result.user) });
});
