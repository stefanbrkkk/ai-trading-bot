import { z } from 'zod';
import { ApiError, handler, ok, parseBody } from '@/lib/api/respond';
import { entitlement, signIn } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ email: z.string().min(3).max(254), password: z.string().min(1).max(200) });

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  const result = await signIn(body.email, body.password);
  // A failed sign-in returns 401 with a single generic message: distinguishing
  // "no such account" from "wrong password" is an account-enumeration oracle.
  if (!result.ok || !result.user) throw new ApiError('INVALID_CREDENTIALS', result.error ?? 'Sign-in failed.', 401);
  return ok({ user: result.user, entitlement: entitlement(result.user) });
});
