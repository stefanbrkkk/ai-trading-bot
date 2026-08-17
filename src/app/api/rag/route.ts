/**
 * The research endpoint — retrieval-augmented answering over the document corpus.
 *
 * Two properties of the response are worth stating because they are unusual.
 *
 * First, the per-claim verdicts travel with the answer. Every sentence is typed and
 * graded against the passage that supports it, and the unverified ones are returned
 * as unverified rather than removed. Dropping them would produce a cleaner-looking
 * answer that hides exactly what the reader most needs to know.
 *
 * Second, a question the corpus cannot answer is refused. The pipeline is capable
 * of writing a fluent, well-cited paragraph in reply to anything, and that is the
 * failure mode worth engineering against: a confidently wrong answer from a
 * research tool is worse than no answer.
 *
 * The corpus is synthetic and internally consistent. That is disclosed in the
 * response rather than buried in a comment, because a citation that looks like an
 * SEC filing and is not one would be materially misleading.
 */

import { z } from 'zod';
import { handler, ok, parseBody } from '@/lib/api/respond';
import { currentUser } from '@/lib/auth/session';
import { SOURCE_LABELS, ask, corpusStats, resolveSymbols } from '@/lib/rag';
import { aiStatus } from '@/lib/api/optional';
import { hitRateLimit } from '@/lib/db';
import type { RagSourceType } from '@/lib/domain/types';

export const dynamic = 'force-dynamic';

const RAG_SPIFFE_ID = 'spiffe://aurelius.local/ns/analytics/sa/research';

const SOURCE_TYPES: readonly RagSourceType[] = [
  'sec_10k', 'sec_10q', 'sec_8k', 'sec_13f', 'sec_form4',
  'earnings_transcript', 'analyst_note', 'news', 'social_x', 'reddit',
];

const CORPUS_NOTICE =
  'The document corpus is generated deterministically and is internally consistent, but it is synthetic: no passage is a statement about a real company. Citations demonstrate the retrieval and grounding pipeline, not real filings. Replacing the corpus with an EDGAR ingest changes nothing downstream.';

const bodySchema = z.object({
  question: z.string().min(3).max(600),
  symbols: z.array(z.string().min(1).max(12)).max(12).optional(),
  sourceTypes: z.array(z.enum(SOURCE_TYPES as [RagSourceType, ...RagSourceType[]])).max(10).optional(),
  topK: z.number().int().min(1).max(12).optional(),
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  const user = await currentUser();

  const verdict = hitRateLimit(`rag:${user?.id ?? 'anonymous'}`, { limit: 6, windowMs: 1000 });
  if (!verdict.allowed) {
    return ok(
      {
        error: { code: 'RATE_LIMITED', message: 'Too many questions in quick succession. Wait a moment and try again.' },
        retryAfterMs: Math.max(0, verdict.resetAt - Date.now()),
      },
      { status: 429 },
    );
  }

  const answer = await ask(body.question, {
    ...(body.symbols === undefined ? {} : { symbols: body.symbols.map((symbol) => symbol.toUpperCase()) }),
    ...(body.sourceTypes === undefined ? {} : { sourceTypes: body.sourceTypes }),
    ...(body.topK === undefined ? {} : { topK: body.topK }),
  });

  return ok({
    ...answer,
    unverifiedClaims: answer.claims.filter((claim) => !claim.verified).length,
    sourceLabels: SOURCE_LABELS,
    corpusNotice: CORPUS_NOTICE,
    ai: await aiStatus(),
    spiffeId: RAG_SPIFFE_ID,
  });
});

/** Corpus composition, for the research page's header and source filter. */
export const GET = handler(async () => {
  const stats = await corpusStats();
  return ok({
    ...stats,
    sourceLabels: SOURCE_LABELS,
    sourceTypes: SOURCE_TYPES,
    corpusNotice: CORPUS_NOTICE,
    examples: [
      'What did management say about gross margin guidance?',
      'Has any insider bought shares recently?',
      'What are the main risk factors disclosed?',
      'Can this platform place trades on my behalf or give me advice?',
      'What is the current volatility regime across the index?',
    ],
    ai: await aiStatus(),
  });
});

/** Exposed so the client can pre-scope a question before sending it. */
export const PUT = handler(async (request: Request) => {
  const body = await parseBody(request, z.object({ question: z.string().min(1).max(600) }));
  return ok({ symbols: resolveSymbols(body.question) });
});
