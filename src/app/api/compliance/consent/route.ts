/**
 * Clickwrap acceptance.
 *
 * The server independently requires `scrolledToBottom` and a trusted click. A
 * browsewrap acceptance — one the user could have given without being shown the
 * terms — is not accepted, because the enforceability of the agreement is exactly
 * what this record exists to establish.
 */

import { z } from 'zod';
import { ApiError, clickProvenanceSchema, handler, ok, parseBody } from '@/lib/api/respond';
import { acceptTerms, currentUser } from '@/lib/auth/session';
import { PRIVACY_VERSION, RISK_DISCLOSURES_VERSION, TOS_VERSION } from '@/lib/compliance/disclosures';
import { listTosAcceptances } from '@/lib/db';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  tosVersion: z.string().min(1),
  privacyVersion: z.string().min(1),
  riskDisclosuresVersion: z.string().min(1),
  scrolledToBottom: z.literal(true),
  checkboxChecked: z.literal(true),
  scrollDurationMs: z.number().int().min(0).max(86_400_000),
  click: clickProvenanceSchema,
});

export const GET = handler(async () => {
  const user = await currentUser();
  if (!user) throw new ApiError('UNAUTHENTICATED', 'Sign in to view your consent record.', 401);
  return ok({
    currentVersions: {
      tos: TOS_VERSION,
      privacy: PRIVACY_VERSION,
      riskDisclosures: RISK_DISCLOSURES_VERSION,
    },
    accepted: user.tosAcceptedAt !== null && user.tosVersion === TOS_VERSION,
    acceptedAt: user.tosAcceptedAt,
    acceptedVersion: user.tosVersion,
    history: listTosAcceptances(user.id),
  });
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (body.tosVersion !== TOS_VERSION) {
    throw new ApiError('STALE_TERMS_VERSION', 'The terms have changed. Reload and read the current version.', 409);
  }
  const result = await acceptTerms({
    scrolledToBottom: body.scrolledToBottom,
    scrollDurationMs: body.scrollDurationMs,
    click: body.click,
    tosVersion: body.tosVersion,
    riskDisclosuresVersion: body.riskDisclosuresVersion,
  });
  if (!result.ok) throw new ApiError('CONSENT_REJECTED', result.error ?? 'Consent was not recorded.', 400);
  return ok({ consentRecorded: true, acceptedAt: result.acceptedAt, brokerLinkingUnlocked: true });
});
