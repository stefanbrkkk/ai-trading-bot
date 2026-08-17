import { handler, ok } from '@/lib/api/respond';
import { currentUser, entitlement, secretIsEphemeral } from '@/lib/auth/session';
import { TOS_VERSION } from '@/lib/compliance/disclosures';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const user = await currentUser();
  return ok({
    user,
    entitlement: entitlement(user),
    termsAccepted: Boolean(user?.tosAcceptedAt && user.tosVersion === TOS_VERSION),
    currentTosVersion: TOS_VERSION,
    /** Surfaced so the control centre can state plainly that the dev secret is in use. */
    sessionSecretIsEphemeral: secretIsEphemeral(),
  });
});
