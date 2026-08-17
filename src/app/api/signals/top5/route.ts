/**
 * The daily publication.
 *
 * This is the Lowe v. SEC surface. The handler takes **no user parameter of any
 * kind** — not a header, not a cookie, not a query filter — so the same request
 * from any subscriber returns byte-identical output. That structural absence is
 * the guarantee of impersonality; a per-user filter here would void the
 * Publisher's Exemption outright.
 */

import { z } from 'zod';
import { handler, ok, parseQuery, ApiError } from '@/lib/api/respond';
import { getPublication } from '@/lib/engine/service';
import { disclosureBundle } from '@/lib/compliance/disclosures';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export const GET = handler(async (request: Request) => {
  parseQuery(request, querySchema);
  const bundle = disclosureBundle();
  try {
    const publication = await getPublication();
    return ok({
      publicationDate: publication.publicationDate,
      publishedAt: publication.publishedAt,
      items: publication.items,
      notice: publication.notice,
      neutralityNotice: publication.neutralityNotice,
      modelVersion: publication.modelVersion,
      disclosures: bundle.blocks.map((b) => ({ id: b.id, title: b.title })),
    });
  } catch (error) {
    throw new ApiError(
      'ENGINE_NOT_READY',
      error instanceof Error ? error.message : 'The engine is not ready.',
      503,
    );
  }
});
