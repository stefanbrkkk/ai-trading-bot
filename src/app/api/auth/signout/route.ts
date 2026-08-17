import { handler, ok } from '@/lib/api/respond';
import { signOut } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export const POST = handler(async () => {
  await signOut();
  return ok({ signedOut: true });
});
