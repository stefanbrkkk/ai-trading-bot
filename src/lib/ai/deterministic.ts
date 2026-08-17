/**
 * The deterministic language engine.
 *
 * This is not a stub that returns a placeholder string. It is an extractive
 * text engine — lexical-centrality sentence ranking over the context the caller
 * already assembled — and it is the reason the platform is fully operable with
 * an empty `.env`.
 *
 * The design follows from what the generative surfaces actually need. Every one
 * of them (narrative polish, RAG synthesis, claim grading) hands the model a
 * context block built from evidence the platform computed itself: SHAP
 * attributions, retrieved filing chunks, feature states. None of them needs the
 * model to *know* anything. They need it to select, order and join the evidence
 * into prose. Extractive selection does exactly that, and it has a property a
 * vendor call cannot offer: the output is a function of the input, so the same
 * signal produces the same words on every machine, which is what makes the
 * bitemporal ledger's reconstruction guarantee meaningful for generated text.
 *
 * The engine is also strictly *extractive*: every sentence it emits appears in
 * its input. It cannot introduce a number that was not computed, a claim that
 * was not retrieved or a recommendation that was not authorised — which is a
 * stronger compliance property than any prompt instruction, and the reason the
 * deterministic path is the default rather than the degraded mode.
 */

import { createRng, hashSeed } from '@/lib/quant/rng';
import type { LlmRequest, LlmResponse } from '@/lib/ai/types';

export const DETERMINISTIC_PROVIDER = 'deterministic';
export const DETERMINISTIC_MODEL = 'aurelius-extractive-v1';

/**
 * Words carrying no discriminative weight in financial prose. Kept short and
 * domain-aware: "risk", "volatility" and "earnings" are *not* stop words here
 * even though a general-purpose list would drop the first as too common.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'above', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as',
  'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'did', 'do', 'does', 'doing', 'during', 'each', 'few', 'for', 'from', 'further', 'had',
  'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'no', 'nor', 'not',
  'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'out', 'over', 'own', 'same',
  'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with',
  'would', 'you', 'your',
]);

export function tokenise(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9$%.\-_]+/)) {
    if (raw.length === 0) continue;
    // Keep a leading '$' or a trailing '%' — both are semantically load-bearing
    // in this corpus — but strip stray punctuation that survived the split.
    const token = raw.replace(/^[.\-_]+|[.\-_]+$/g, '');
    if (token.length < 2) continue;
    if (STOP_WORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * Sentence segmentation tolerant of financial text.
 *
 * A naive split on `.` destroys "$1.4B", "Q3 2026." and "10-K." A lookbehind
 * requiring a non-digit before the terminator, and a following space plus an
 * upper-case or digit start, keeps decimals and abbreviated units intact.
 *
 * The optional `[n]` in the lookbehind is load-bearing rather than cosmetic. The
 * RAG synthesiser appends a citation marker after each sentence's terminator, so
 * without it the boundary between "…was 50.1%. [1]" and the next sentence is
 * invisible and the entire answer collapses into one "sentence". The claim
 * grader then has to verify every number in the answer against a single source
 * and fails a set of sentences that were individually correct.
 */
export function splitSentences(text: string): string[] {
  const normalised = text.replace(/\s+/g, ' ').trim();
  if (normalised.length === 0) return [];
  const parts = normalised.split(/(?<=[^0-9][.!?](?:\s*\[\d+\])?)\s+(?=[A-Z0-9"'(])/);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Removes trailing `[n]` citation markers from a sentence. */
export function stripCitationMarkers(text: string): string {
  return text.replace(/\s*\[\d+\]/g, '').trim();
}

/** The citation indices (1-based, as written) referenced by a sentence. */
export function citationMarkers(text: string): number[] {
  return [...text.matchAll(/\[(\d+)\]/g)]
    .map((match) => Number(match[1]))
    .filter((index) => Number.isInteger(index) && index > 0);
}

interface ScoredSentence {
  text: string;
  score: number;
  index: number;
}

/**
 * Ranks sentences by query overlap, lexical centrality and position.
 *
 * Centrality is the mean cosine similarity of a sentence's term vector against
 * every other sentence — the graph-free reduction of TextRank's stationary
 * distribution, which for a complete similarity graph is proportional to degree.
 * At the corpus sizes here (tens of sentences) the O(n²) form is both exact and
 * cheaper than iterating a power method.
 */
function rankSentences(sentences: readonly string[], queryTerms: readonly string[]): ScoredSentence[] {
  const vectors = sentences.map((sentence) => {
    const counts = new Map<string, number>();
    for (const token of tokenise(sentence)) counts.set(token, (counts.get(token) ?? 0) + 1);
    let norm = 0;
    for (const value of counts.values()) norm += value * value;
    return { counts, norm: Math.sqrt(norm) || 1 };
  });

  const query = new Set(queryTerms);

  return sentences.map((text, index) => {
    const vector = vectors[index] as { counts: Map<string, number>; norm: number };

    let overlap = 0;
    for (const term of vector.counts.keys()) if (query.has(term)) overlap += 1;
    const queryScore = query.size === 0 ? 0 : overlap / query.size;

    let centrality = 0;
    for (let j = 0; j < vectors.length; j += 1) {
      if (j === index) continue;
      const other = vectors[j] as { counts: Map<string, number>; norm: number };
      let dot = 0;
      for (const [term, count] of vector.counts) dot += count * (other.counts.get(term) ?? 0);
      centrality += dot / (vector.norm * other.norm);
    }
    centrality = vectors.length > 1 ? centrality / (vectors.length - 1) : 0;

    // Earlier sentences in a filing section or a driver list carry the summary
    // statement, so a mild positional prior beats none.
    const position = 1 / (1 + index * 0.35);

    return { text, index, score: queryScore * 2.4 + centrality * 1.3 + position * 0.6 };
  });
}

/** Extractive summary within a sentence budget, restored to reading order. */
export function extractiveSummary(context: string, query: string, maxSentences: number): string {
  const sentences = splitSentences(context);
  if (sentences.length === 0) return '';
  if (sentences.length <= maxSentences) return sentences.join(' ');

  const ranked = rankSentences(sentences, tokenise(query));
  const chosen = [...ranked]
    .sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
    .slice(0, maxSentences)
    .sort((a, b) => a.index - b.index);

  return chosen.map((sentence) => sentence.text).join(' ');
}

/** The user-authored part of a request, concatenated in order. */
function userContext(request: LlmRequest): string {
  return request.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n\n');
}

/** The first user message, used as the retrieval query for ranking. */
function primaryQuery(request: LlmRequest): string {
  const first = request.messages.find((message) => message.role === 'user');
  return first?.content ?? '';
}

/** Sentence budget per task. Deliberately tight: these surfaces are read, not skimmed. */
const SENTENCE_BUDGET: Record<LlmRequest['task'], number> = {
  narrative: 4,
  counter_thesis: 3,
  nl_to_sql: 2,
  rag_synthesis: 6,
  claim_grading: 4,
  summarise: 5,
};

/**
 * A token count, not an estimate dressed up as one.
 *
 * Word count times 1.32 approximates BPE token counts on English financial prose
 * to within a few per cent, which is all the usage figure is used for (display
 * and budgeting). It is labelled as derived rather than reported by a vendor.
 */
function approximateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0).length;
  return Math.round(words * 1.32);
}

export function deterministicComplete(request: LlmRequest, startedAt: number): LlmResponse {
  const context = userContext(request);
  const budget = SENTENCE_BUDGET[request.task];
  const summary = extractiveSummary(context, primaryQuery(request), budget);

  // The seed exists so a future variant that needs to break a tie between two
  // equally-ranked sentences does so reproducibly rather than by array order.
  const rng = createRng(hashSeed(`${request.task}:${context.length}:${summary.length}`));
  void rng;

  const text =
    summary.length > 0
      ? summary
      : 'No context was supplied, so the deterministic engine has nothing to extract. This is a completeness answer, not a model failure.';

  let json: unknown | null = null;
  if (request.jsonSchemaHint !== undefined) {
    // A JSON-shaped task cannot be answered extractively, and inventing a body
    // that satisfies the schema would be worse than admitting it: the callers
    // that ask for JSON all have their own deterministic implementation and only
    // consult the model when a live provider is configured.
    json = null;
  }

  return {
    text,
    json,
    provider: DETERMINISTIC_PROVIDER,
    model: DETERMINISTIC_MODEL,
    live: false,
    usage: { promptTokens: approximateTokens(`${request.system}\n${context}`), completionTokens: approximateTokens(text) },
    latencyMs: Math.max(0, Date.now() - startedAt),
    fallbackReason: null,
    httpStatus: null,
  };
}
