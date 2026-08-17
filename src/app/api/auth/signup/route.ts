import { z } from 'zod';
import { ApiError, handler, ok, parseBody } from '@/lib/api/respond';
import { entitlement, signUp } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(200),
  displayName: z.string().max(80).optional(),
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  const result = await signUp(body);
  if (!result.ok || !result.user) throw new ApiError('SIGNUP_REJECTED', result.error ?? 'Sign-up failed.', 400);
  return ok({ user: result.user, entitlement: entitlement(result.user) }, { status: 201 });
});
