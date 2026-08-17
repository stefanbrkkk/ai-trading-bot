/** The verbatim disclosure bundle, versioned. */
import { handler, ok } from '@/lib/api/respond';
import { PRIVACY_POLICY_SECTIONS, disclosureBundle } from '@/lib/compliance/disclosures';

export const dynamic = 'force-static';

export const GET = handler(async () =>
  ok({ ...disclosureBundle(), privacyPolicy: PRIVACY_POLICY_SECTIONS }),
);
