/**
 * Retrieval scope and grounding.
 *
 * The assertions that matter here are the negative ones. A retrieval pipeline
 * that answers everything is indistinguishable from one that answers well until
 * you ask it something it has no business answering — and this one did: "What is
 * the capital of France?" returned a fluent, six-citation, 100%-grounded answer,
 * because "capital" appears in "capital allocation" and in the risk disclosure's
 * "total loss of capital", and the scope test accepted any lexical match at all.
 *
 * So both sides of the relevance floor are pinned against the real corpus. BM25
 * is unnormalised, which makes the floor a property of this corpus rather than a
 * universal constant, and these tests are what will catch it drifting when the
 * corpus grows.
 */

import { describe, expect, it } from 'vitest';
import { chunksFromMemory } from '@/lib/rag';
import { BM25_RELEVANCE_FLOOR, hasRelevantEvidence, retrieve } from '@/lib/rag/retrieve';

const CHUNKS = chunksFromMemory(Date.UTC(2026, 7, 14, 20, 0, 0));

/** Questions the corpus genuinely covers. */
const IN_SCOPE = [
  'What did Apple report for revenue last quarter?',
  'What are the risks disclosed for NVDA?',
  'Can this platform place trades on my behalf or give me advice?',
  'What is insider activity at TSLA?',
  'Summarise the latest earnings call tone for MSFT',
];

/** Questions it does not, including one that collides on a single common word. */
const OUT_OF_SCOPE = [
  'What is the capital of France?',
  'What is the weather today?',
  'Who won the world cup in 2018?',
  'How do I bake bread?',
];

describe('retrieval scope', () => {
  it('indexes a non-trivial corpus', () => {
    expect(CHUNKS.length).toBeGreaterThan(100);
  });

  it('treats every in-scope question as answerable', () => {
    for (const question of IN_SCOPE) {
      const { trace } = retrieve(CHUNKS, question, {});
      expect(hasRelevantEvidence(trace), question).toBe(true);
    }
  });

  it('refuses every out-of-scope question', () => {
    for (const question of OUT_OF_SCOPE) {
      const { trace } = retrieve(CHUNKS, question, {});
      expect(hasRelevantEvidence(trace), question).toBe(false);
    }
  });

  it('keeps a margin either side of the floor, so the separation is not incidental', () => {
    const inScope = IN_SCOPE.map((q) => retrieve(CHUNKS, q, {}).trace.bestBm25);
    const outOfScope = OUT_OF_SCOPE.map((q) => retrieve(CHUNKS, q, {}).trace.bestBm25);
    expect(Math.min(...inScope)).toBeGreaterThan(BM25_RELEVANCE_FLOOR * 1.2);
    expect(Math.max(...outOfScope)).toBeLessThan(BM25_RELEVANCE_FLOOR * 0.8);
  });

  it('reports the channel scores it made the decision on', () => {
    const { trace } = retrieve(CHUNKS, 'What are the risks disclosed for NVDA?', {});
    expect(trace.queryTerms.length).toBeGreaterThan(0);
    expect(Number.isFinite(trace.bestBm25)).toBe(true);
    expect(Number.isFinite(trace.bestDense)).toBe(true);
  });
});
