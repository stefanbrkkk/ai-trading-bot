/**
 * The retrieval-augmented answering pipeline.
 *
 * Retrieve → diversify → synthesise → ground → cite. The synthesis step is the
 * only one that can use a language model, and it is the only one whose output is
 * then *checked*: whatever produced the prose, every sentence is graded against
 * the retrieved evidence before the answer is returned, and the per-claim
 * verdicts travel with it.
 *
 * That ordering is the substance of the design. A live model improves fluency and
 * can join evidence across two filings in a way extractive selection cannot; it
 * can also assert something no source says. Grading after the fact means the
 * second failure mode is visible in the response rather than hidden by it, and
 * means the deterministic path — which is extractive and therefore cannot invent
 * a number at all — is not a lesser mode but a different trade.
 *
 * The corpus is loaded from the ledger when it has been seeded, and generated in
 * process when it has not, so a fresh clone answers questions before `npm run
 * seed` has ever run.
 */

import { complete } from '@/lib/ai';
import { extractiveSummary, splitSentences } from '@/lib/ai/deterministic';
import { AUTHORITY, SOURCE_LABELS, buildCorpus, chunkDocument } from '@/lib/rag/corpus';
import { embed } from '@/lib/rag/embed';
import {
  diversify,
  hasRelevantEvidence,
  indexText,
  retrieve,
  type RetrievableChunk,
  type RetrievalTrace,
  type ScoredChunk,
} from '@/lib/rag/retrieve';
import { groundAnswer, type ComputedValues, type Evidence } from '@/lib/rag/ground';
import { ALL_SYMBOLS, getSpec } from '@/lib/market/universe';
import { PROHIBITED_PHRASES } from '@/lib/engine/narrative';
import type { RagAnswer, RagCitation, RagSourceType } from '@/lib/domain/types';

export type { RagDocument, CorpusOptions } from '@/lib/rag/corpus';
export { AUTHORITY, SOURCE_LABELS, buildCorpus, chunkDocument } from '@/lib/rag/corpus';
export { EMBEDDING_DIM, cosine, embed } from '@/lib/rag/embed';
export type { RetrievableChunk, RetrievalResult, RetrievalTrace, ScoredChunk } from '@/lib/rag/retrieve';
export {
  DENSE_RELEVANCE_FLOOR,
  diversify,
  expandQuery,
  hasRelevantEvidence,
  indexText,
  retrieve,
  stem,
} from '@/lib/rag/retrieve';
export type { ComputedValues, Evidence, GroundingResult } from '@/lib/rag/ground';
export { classifyClaim, extractQuantities, groundAnswer } from '@/lib/rag/ground';

/**
 * The chunk index.
 *
 * Built once per process and memoised: embedding a few thousand chunks costs
 * ~40ms, which is fine once and wasteful per request. The key includes the
 * corpus size so a re-seed in a running dev server invalidates it.
 */
let indexCache: { key: string; chunks: RetrievableChunk[] } | null = null;

/** Discards the memoised index. Used by the seed script and the tests. */
export function clearRagIndex(): void {
  indexCache = null;
}

/**
 * Loads the corpus from the ledger, or null when the store is absent or empty.
 *
 * Resolved through a runtime specifier for the same reason the seed does it: the
 * RAG surface must answer on a clone where the database has never been created,
 * and a static import would make the module unloadable in that state.
 */
async function chunksFromLedger(): Promise<RetrievableChunk[] | null> {
  let ns: Record<string, unknown>;
  try {
    ns = (await import('@/lib/db')) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }

  const listDocuments = ns.listRagDocuments;
  const listChunks = ns.listAllRagChunks;
  if (typeof listDocuments !== 'function' || typeof listChunks !== 'function') return null;

  try {
    /**
     * The limit is passed explicitly. `listRagDocuments` defaults to 200 ordered
     * by `published_at DESC`, which is a sensible default for a feed and the wrong
     * one for an index build: it silently dropped the oldest documents, and since
     * annual reports are by construction the oldest things in the corpus, the
     * effect was a retriever with no 10-K in it at all. The chunks were still
     * loaded, so they were then discarded for having no parent document — a
     * corpus quietly missing its highest-authority source with nothing logged.
     */
    const documents = (
      listDocuments as (query?: { limit?: number }) => {
        id: string;
        title: string;
        sourceType: RagSourceType;
        symbol: string | null;
        section: string;
        authority: number;
        publishedAt: number;
      }[]
    )({ limit: 20_000 });
    if (documents.length === 0) return null;
    const byId = new Map(documents.map((document) => [document.id, document]));

    const rows = (listChunks as (limit?: number) => { id: string; documentId: string; section: string; text: string; embedding: number[] | null }[])(8000);
    if (rows.length === 0) return null;

    const chunks: RetrievableChunk[] = [];
    for (const row of rows) {
      const document = byId.get(row.documentId);
      if (document === undefined) continue;
      chunks.push({
        id: row.id,
        documentId: row.documentId,
        documentTitle: document.title,
        sourceType: document.sourceType,
        symbol: document.symbol,
        section: row.section.length > 0 ? row.section : document.section,
        authority: document.authority,
        publishedAt: document.publishedAt,
        text: row.text,
        embedding: row.embedding,
      });
    }
    return chunks.length > 0 ? chunks : null;
  } catch {
    // A missing table (never migrated) is an expected state, not an error.
    return null;
  }
}

/** Generates the corpus in process and chunks it. */
/**
 * Builds the retrievable index straight from the in-memory corpus, with no store.
 *
 * Exported for the scope tests, which have to measure the real retrieval scores
 * against the real corpus — a floor calibrated against a stub would pin nothing.
 */
export function chunksFromMemory(now: number): RetrievableChunk[] {
  const chunks: RetrievableChunk[] = [];
  for (const document of buildCorpus({ now })) {
    for (const piece of chunkDocument(document)) {
      const chunk: RetrievableChunk = {
        id: `${document.id}#${piece.ordinal}`,
        documentId: document.id,
        documentTitle: document.title,
        sourceType: document.sourceType,
        symbol: document.symbol,
        section: document.section,
        authority: document.authority,
        publishedAt: document.publishedAt,
        text: piece.text,
        embedding: null,
      };
      // Embedded over the heading-prefixed text so the dense channel and the
      // lexical channel are searching the same document.
      chunk.embedding = embed(indexText(chunk));
      chunks.push(chunk);
    }
  }
  return chunks;
}

export async function ragIndex(now = Date.now()): Promise<RetrievableChunk[]> {
  const fromLedger = await chunksFromLedger();
  const chunks = fromLedger ?? chunksFromMemory(now);
  const key = `${fromLedger === null ? 'memory' : 'ledger'}:${chunks.length}`;
  if (indexCache?.key === key) return indexCache.chunks;

  // Embeddings are absent on ledger rows written before the embedding column was
  // populated; filling them here keeps the dense channel working either way.
  for (const chunk of chunks) {
    if (chunk.embedding === null || chunk.embedding.length === 0) chunk.embedding = embed(indexText(chunk));
  }

  indexCache = { key, chunks };
  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Symbol resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finds the tickers a question is about.
 *
 * Ticker matching is word-boundary and case-sensitive-on-uppercase, because
 * lower-cased matching turns "a" into a symbol and "it" into ITB. Company names
 * are matched on their distinctive leading word, which is what users actually
 * type ("Apple", not "Apple Inc.").
 */
export function resolveSymbols(question: string): string[] {
  const found = new Set<string>();

  for (const match of question.matchAll(/\b[A-Z]{1,5}\b/g)) {
    const candidate = match[0];
    if (getSpec(candidate) !== undefined) found.add(candidate);
  }

  const lower = question.toLowerCase();
  for (const symbol of ALL_SYMBOLS) {
    if (found.has(symbol)) continue;
    const spec = getSpec(symbol);
    if (spec === undefined) continue;
    const leading = spec.name.split(/[\s,]/)[0];
    if (leading === undefined || leading.length < 4) continue;
    if (lower.includes(leading.toLowerCase())) found.add(symbol);
  }

  return [...found];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Synthesis
// ─────────────────────────────────────────────────────────────────────────────

const SYNTHESIS_SYSTEM = [
  'You summarise retrieved financial documents for a research terminal.',
  '',
  'Absolute constraints:',
  '• Use ONLY the numbered excerpts supplied. If they do not answer the question, say so.',
  '• Never state a number that does not appear verbatim in an excerpt.',
  '• Never recommend buying, selling or holding anything. Never suggest a position size, an entry price or a target.',
  '• Never address the reader as an individual or refer to "your portfolio", "your position" or "your risk tolerance".',
  '• Attribute each statement to its excerpt number in square brackets, e.g. [2].',
  '• Describe what the documents say. Do not forecast, and do not characterise anything as an opportunity.',
  '',
  'Write four to seven sentences of plain, specific prose. No preamble, no bullet list, no closing summary.',
].join('\n');

/** The excerpt block handed to whichever engine synthesises the answer. */
function evidenceBlock(hits: readonly ScoredChunk[]): string {
  return hits
    .map(
      (hit, index) =>
        `[${index + 1}] ${SOURCE_LABELS[hit.chunk.sourceType]} — ${hit.chunk.documentTitle} — ${hit.chunk.section}\n${hit.chunk.text}`,
    )
    .join('\n\n');
}

/**
 * Deterministic synthesis.
 *
 * Extractive: the answer is a selection of sentences that exist in the retrieved
 * chunks, each tagged with its citation index. Because every sentence is copied
 * rather than generated, the numerical grounding check on the result is a
 * tautology — which is the point. This path cannot fabricate.
 */
function synthesiseDeterministic(question: string, hits: readonly ScoredChunk[]): string {
  if (hits.length === 0) {
    return 'The corpus does not contain a passage that addresses this question. Nothing is asserted where there is no source to support it.';
  }

  const parts: string[] = [];
  /**
   * Only hits within striking distance of the best one contribute a sentence.
   *
   * Without the cut-off the answer draws one sentence from each of the top five
   * regardless of how far they have fallen off, which appends genuine but
   * irrelevant material — a Rule 10b5-1 clause tacked onto an answer about gross
   * margin. The citations stay in the list either way, so nothing is hidden; they
   * simply stop putting words in the answer.
   */
  const cutoff = (hits[0]?.score ?? 0) * 0.45;
  // Two sentences from the strongest hit, one from each of the next few. The top
  // chunk usually carries the direct answer; the others add corroboration and
  // keep the citation set diverse enough to cross-check.
  hits.slice(0, 5).forEach((hit, index) => {
    if (index > 0 && hit.score < cutoff) return;
    const budget = index === 0 ? 2 : 1;
    const extract = extractiveSummary(hit.chunk.text, question, budget);
    if (extract.length === 0) return;
    for (const sentence of splitSentences(extract)) {
      parts.push(`${sentence} [${index + 1}]`);
    }
  });

  return parts.length > 0
    ? parts.join(' ')
    : 'The retrieved passages contain no sentence specific enough to answer the question.';
}

/**
 * Strips a directive that slipped past the prompt.
 *
 * A live model can produce a recommendation despite being told not to, and the
 * publisher's exemption does not survive individualised advice. So the output is
 * filtered, not trusted: any sentence containing a prohibited phrase is dropped
 * and the removal is reported in the answer's notes. Dropping the sentence rather
 * than rejecting the whole answer keeps the rest of a useful reply.
 */
function stripProhibited(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];

  for (const sentence of splitSentences(text)) {
    const lower = sentence.toLowerCase();
    const offending = PROHIBITED_PHRASES.find((phrase) => lower.includes(phrase.toLowerCase()));
    if (offending === undefined) kept.push(sentence);
    else removed.push(offending);
  }

  return { text: kept.join(' '), removed: [...new Set(removed)] };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface AskOptions {
  /** Restricts retrieval. Inferred from the question when omitted. */
  symbols?: readonly string[];
  sourceTypes?: readonly RagSourceType[];
  /** Platform-derived figures the answer may cite; graded as `computational`. */
  computed?: ComputedValues;
  topK?: number;
  now?: number;
  signal?: AbortSignal;
  correlationId?: string;
}

export interface RagResult extends RagAnswer {
  /** Retrieval diagnostics, surfaced on the research page. */
  trace: RetrievalTrace;
  /** Non-fatal notes: inferred symbols, filtered sentences, degraded provider. */
  notes: string[];
}

export async function ask(question: string, options: AskOptions = {}): Promise<RagResult> {
  const startedAt = Date.now();
  const now = options.now ?? Date.now();
  const notes: string[] = [];

  const chunks = await ragIndex(now);

  const symbols = options.symbols ?? resolveSymbols(question);
  if (options.symbols === undefined && symbols.length > 0) {
    notes.push(`Retrieval was scoped to ${symbols.join(', ')}, inferred from the question.`);
  }

  const { hits, trace } = retrieve(chunks, question, {
    topK: (options.topK ?? 6) * 3,
    symbols: symbols.length > 0 ? symbols : undefined,
    sourceTypes: options.sourceTypes,
    now,
  });

  /**
   * Out-of-scope questions are refused before synthesis.
   *
   * Without this gate the pipeline still returns hits — the fusion admits its
   * top-ranked chunks whatever their absolute score — and the synthesiser then
   * writes a fluent, well-cited answer about earnings guidance in reply to a
   * question about the weather. A confidently wrong answer is the worst
   * available outcome for a research tool, so the relevance floor is checked
   * against the raw channel scores rather than the fused ranking.
   */
  const relevant = hasRelevantEvidence(trace);
  const selected = relevant ? diversify(hits, 2, options.topK ?? 6) : [];
  if (!relevant && hits.length > 0) {
    notes.push(
      `The question shares no indexed term with the corpus (best lexical score ${trace.bestBm25.toFixed(2)}, best semantic similarity ${trace.bestDense.toFixed(2)}), so no passage was treated as evidence.`,
    );
  }

  const citations: RagCitation[] = selected.map((hit) => ({
    documentId: hit.chunk.documentId,
    documentTitle: hit.chunk.documentTitle,
    sourceType: hit.chunk.sourceType,
    section: hit.chunk.section,
    authority: hit.chunk.authority,
    score: hit.score,
    snippet: hit.chunk.text.length > 320 ? `${hit.chunk.text.slice(0, 317)}…` : hit.chunk.text,
    publishedAt: hit.chunk.publishedAt,
  }));

  let answer: string;
  let source: RagAnswer['source'] = 'deterministic_synthesis';
  let llmProvider: string | null = null;

  if (selected.length === 0) {
    answer =
      'No passage in the corpus addresses this question, so no answer is offered. This is a completeness result rather than a failure: asserting something unsupported would be worse than returning nothing.';
    notes.push('Retrieval returned no candidate above the relevance floor.');
  } else {
    const response = await complete({
      task: 'rag_synthesis',
      system: SYNTHESIS_SYSTEM,
      messages: [{ role: 'user', content: `Question: ${question}\n\nExcerpts:\n\n${evidenceBlock(selected)}` }],
      temperature: 0,
      maxTokens: 700,
      signal: options.signal,
      correlationId: options.correlationId,
    });

    if (response.live) {
      const filtered = stripProhibited(response.text);
      if (filtered.removed.length > 0) {
        notes.push(
          `${filtered.removed.length} sentence(s) were removed from the model's reply for containing prohibited advisory language (${filtered.removed.join('; ')}).`,
        );
      }
      // A model whose entire reply was filtered has produced nothing usable, so
      // the extractive path answers instead of returning an empty string.
      if (filtered.text.trim().length > 0) {
        answer = filtered.text;
        source = 'llm';
        llmProvider = response.provider;
      } else {
        answer = synthesiseDeterministic(question, selected);
        notes.push('The model reply was filtered in full, so the extractive synthesis was used.');
      }
    } else {
      answer = synthesiseDeterministic(question, selected);
      if (response.fallbackReason !== null) notes.push(`Live inference was unavailable: ${response.fallbackReason}`);
    }
  }

  const evidence: Evidence[] = selected.map((hit, index) => ({
    citationIndex: index,
    text: hit.chunk.text,
    sourceType: hit.chunk.sourceType,
    documentId: hit.chunk.documentId,
  }));

  /**
   * A refusal is not graded.
   *
   * Grading it produces the worst possible reading: the sentence "no passage
   * addresses this question" is itself unverifiable against a corpus that
   * contains no relevant passage, so the answer reports 0% grounded — which looks
   * like a hallucination warning attached to the one answer that asserts nothing.
   * No claims means no claims.
   */
  const grounding =
    selected.length === 0
      ? { claims: [], groundingScore: 1 }
      : groundAnswer(answer, evidence, options.computed ?? {});

  return {
    question,
    answer,
    citations,
    claims: grounding.claims,
    source,
    llmProvider,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    groundingScore: grounding.groundingScore,
    trace,
    notes,
  };
}

/** Corpus statistics for the research page's header. */
export async function corpusStats(now = Date.now()): Promise<{
  documents: number;
  chunks: number;
  symbols: number;
  bySource: { sourceType: RagSourceType; documents: number; authority: number }[];
  oldest: number;
  newest: number;
}> {
  const chunks = await ragIndex(now);
  const documents = new Map<string, RetrievableChunk>();
  for (const chunk of chunks) if (!documents.has(chunk.documentId)) documents.set(chunk.documentId, chunk);

  const counts = new Map<RagSourceType, number>();
  const symbols = new Set<string>();
  let oldest = Number.POSITIVE_INFINITY;
  let newest = 0;

  for (const document of documents.values()) {
    counts.set(document.sourceType, (counts.get(document.sourceType) ?? 0) + 1);
    if (document.symbol !== null) symbols.add(document.symbol);
    oldest = Math.min(oldest, document.publishedAt);
    newest = Math.max(newest, document.publishedAt);
  }

  return {
    documents: documents.size,
    chunks: chunks.length,
    symbols: symbols.size,
    bySource: [...counts.entries()]
      .map(([sourceType, count]) => ({ sourceType, documents: count, authority: AUTHORITY[sourceType] }))
      .sort((a, b) => b.authority - a.authority || a.sourceType.localeCompare(b.sourceType)),
    oldest: Number.isFinite(oldest) ? oldest : now,
    newest: newest > 0 ? newest : now,
  };
}
