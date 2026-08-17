/**
 * Hybrid retrieval.
 *
 * Four stages, each answering a failure the previous one cannot:
 *
 *   1. **BM25** over the chunk text. Exact term matching with document-length
 *      normalisation. Finds "Rule 10b5-1" and "$1.4 billion" — literals a dense
 *      model blurs.
 *
 *   2. **Dense cosine** over the hashed embeddings. Survives morphology and
 *      typography, so "amortization" retrieves "amortisation" and "10K"
 *      retrieves "10-K".
 *
 *   3. **Reciprocal-rank fusion** (Cormack, Clarke & Buettcher 2009):
 *      `score = Σ 1/(k + rank_i)` with k = 60. RRF is used rather than a weighted
 *      sum of the raw scores because BM25 is unbounded and cosine is bounded in
 *      [-1, 1] — combining them numerically requires a calibration that would
 *      have to be re-fit per corpus, while combining *ranks* requires none. k=60
 *      is the value from the paper, and it controls how sharply the top of each
 *      list dominates.
 *
 *   4. **Authority and recency re-rank.** The fused relevance is multiplied by a
 *      source-authority factor and a recency factor. Multiplicative rather than
 *      additive so a barely-relevant 10-K cannot outrank a highly-relevant news
 *      item purely on prestige: if relevance is near zero, authority has nothing
 *      to amplify.
 *
 * The stages are reported individually in `RetrievalTrace`, because a user who
 * wants to know why a filing was cited deserves to see which channel found it.
 */

import { cosine, embed } from '@/lib/rag/embed';
import { tokenise } from '@/lib/ai/deterministic';
import type { RagSourceType } from '@/lib/domain/types';

export interface RetrievableChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  sourceType: RagSourceType;
  symbol: string | null;
  section: string;
  authority: number;
  publishedAt: number;
  text: string;
  /** Precomputed at ingest. Recomputed on the fly when absent. */
  embedding: number[] | null;
}

export interface ScoredChunk {
  chunk: RetrievableChunk;
  bm25: number;
  bm25Rank: number | null;
  dense: number;
  denseRank: number | null;
  /** Reciprocal-rank fusion score, before authority and recency. */
  fused: number;
  authorityFactor: number;
  recencyFactor: number;
  /** The final ordering key. */
  score: number;
  /** Which channels surfaced this chunk. */
  channels: ('lexical' | 'dense')[];
}

export interface RetrievalTrace {
  queryTerms: string[];
  candidates: number;
  lexicalHits: number;
  denseHits: number;
  /** Symbols the query was resolved to, if any. */
  symbols: string[];
  /** Best raw score in each channel — the caller's out-of-scope test. */
  bestBm25: number;
  bestDense: number;
  /**
   * Query-dependent fusion weights, summing to 1. Surfaced because "this answer
   * was found lexically, not semantically" is diagnostic information a reader
   * auditing a citation genuinely wants.
   */
  lexicalWeight: number;
  denseWeight: number;
  /**
   * How many of the query's content terms occur anywhere in the candidate pool.
   * Zero means the question is about something the corpus does not cover.
   */
  termsInCorpus: number;
  elapsedMs: number;
}

/**
 * Minimum dense similarity for a chunk to count as evidence when no query term
 * matched lexically.
 *
 * The hashed embedding gives any two pieces of financial English a similarity
 * around 0.15–0.30 purely from shared character n-grams, so a threshold below
 * that would accept anything. 0.42 is above the observed unrelated-pair ceiling
 * on this corpus and below the score a genuine paraphrase earns, which is what
 * lets an off-topic question be refused rather than answered from whatever
 * happened to rank first.
 */
export const DENSE_RELEVANCE_FLOOR = 0.42;

/**
 * Whether the retrieval found anything that can support an answer.
 *
 * The test is deliberately asymmetric: any lexical match at all is enough,
 * because a shared content term means the corpus genuinely discusses the
 * subject. Absent that, only a strong dense match counts. A question about the
 * weather satisfies neither, and the caller refuses instead of synthesising from
 * the highest-authority chunk it happens to have.
 */
export function hasRelevantEvidence(trace: RetrievalTrace): boolean {
  if (trace.termsInCorpus > 0 && trace.bestBm25 > 0) return true;
  return trace.bestDense >= DENSE_RELEVANCE_FLOOR;
}

export interface RetrievalResult {
  hits: ScoredChunk[];
  trace: RetrievalTrace;
}

/** BM25 saturation. 1.2 is the standard value; higher rewards repetition more. */
const BM25_K1 = 1.2;
/** BM25 length normalisation. 0.75 is standard. */
const BM25_B = 0.75;
/**
 * RRF constant.
 *
 * Cormack et al. (2009) use k = 60, fitted against TREC runs of ~1000 documents
 * where the purpose of a large k is to flatten the long tail so that a document
 * ranked 200th by one system is not effectively discarded. This corpus retrieves
 * over candidate pools of tens of chunks, and at that scale k = 60 flattens the
 * list into near-uniformity: rank 1 scores 0.0164 and rank 20 scores 0.0125, a
 * spread of 31%, which is *smaller* than the spread of the authority and recency
 * factors applied afterwards. The consequence is a retriever that orders by
 * prestige and freshness and effectively ignores relevance — a 10-Q outranking a
 * Form 4 on a question about insider buying.
 *
 * k = 10 restores the intended precedence: rank 1 scores 0.091 against rank 20's
 * 0.033, a 2.8× spread that dominates the ≤1.4× spread the re-rank factors can
 * contribute. The constant is chosen from the list length, which is what it is
 * for.
 */
const RRF_K = 10;
/**
 * Recency half-life. 180 days: a filing from two quarters ago should still be
 * highly retrievable — it is often the most recent authoritative statement — but
 * a two-year-old note should not compete with this quarter's.
 */
const RECENCY_HALF_LIFE_MS = 180 * 86_400_000;

/**
 * The text actually indexed for a chunk.
 *
 * The document title and section heading are prepended because they carry terms
 * the body never repeats: an Item 1A chunk lists risks without ever using the
 * phrase "risk factors", so a question asking for "the risk factors disclosed by
 * MSFT" has no lexical path to it. Prepending the heading is the contextual-chunk
 * convention, and it is why a section-shaped question can find a section.
 *
 * Callers that persist embeddings must embed *this*, not the raw body, or the
 * dense channel and the lexical channel will be searching different documents.
 */
export function indexText(chunk: Pick<RetrievableChunk, 'documentTitle' | 'section' | 'text'>): string {
  return `${chunk.documentTitle}. ${chunk.section}. ${chunk.text}`;
}

/**
 * Light suffix stripping.
 *
 * Not a full Porter stemmer — those over-stem financial vocabulary ("operating"
 * → "oper", colliding with "operator" and "operation" in ways that hurt more
 * than they help on a corpus this specific). This handles only the four
 * inflections that actually cause misses here: regular plurals, `-ies` plurals,
 * and the `-ing`/`-ed` verb forms. Without it a query for "quarter" cannot match
 * a filing that writes "quarters", which is not a subtle failure.
 *
 * The 4-character floor prevents mangling short tokens where a trailing 's' is
 * part of the word ("gas", "eps").
 */
export function stem(token: string): string {
  if (token.length < 5) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.endsWith('sses')) return token.slice(0, -2);
  if (token.endsWith('ing') && token.length > 6) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 5) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) return token.slice(0, -1);
  return token;
}

/**
 * Domain synonyms, mapping the words a user types to the words a filing uses.
 *
 * This is the vocabulary-mismatch problem in its purest form: nobody asks "show
 * me statements of changes in beneficial ownership", they ask about *insider
 * buying*, and no Form 4 contains the word "insider". Dense retrieval is supposed
 * to bridge that, but a hashed n-gram embedding bridges morphology, not meaning —
 * so the mapping is supplied explicitly. Keys are stemmed; values are appended to
 * the query for the lexical channel only, which is where the miss occurs.
 *
 * Deliberately small. A large hand-built thesaurus becomes a maintenance liability
 * and starts injecting noise; these are the terms that measurably fail.
 */
const SYNONYMS: Record<string, readonly string[]> = {
  insider: ['form', 'beneficial', 'ownership', 'reporting', 'person', 'officer', 'director'],
  bought: ['purchase', 'acquired', 'acquisition'],
  buy: ['purchase', 'acquired'],
  sold: ['sale', 'disposed'],
  sell: ['sale', 'disposed'],
  institution: ['13f', 'holding', 'manager'],
  guidance: ['outlook', 'forecast', 'midpoint'],
  risk: ['1a', 'factor', 'adverse'],
  margin: ['gross', 'operating', 'profitability'],
  revenue: ['sale', 'top-line'],
  debt: ['note', 'leverage', 'covenant', 'facility'],
  cash: ['liquidity', 'equivalent', 'flow'],
  layoff: ['restructuring', 'position'],
  acquisition: ['acquire', 'definitive', 'agreement'],
  dividend: ['distribution', 'shareholder'],
  buyback: ['repurchase', 'authorisation'],
  quarter: ['10-q', 'sequential'],
  annual: ['10-k', 'fiscal'],
  sentiment: ['retail', 'social', 'crowd'],
  employee: ['people', 'headcount'],
  competitor: ['competition', 'competitive'],
};

/** Query terms plus their domain synonyms, stemmed and de-duplicated. */
export function expandQuery(terms: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const term of terms) {
    const stemmed = stem(term);
    expanded.add(stemmed);
    for (const synonym of SYNONYMS[stemmed] ?? []) expanded.add(stem(synonym));
  }
  return [...expanded];
}

/**
 * BM25 over the candidate set.
 *
 * IDF uses the Robertson–Sparck Jones form with the +0.5 smoothing and a floor at
 * zero. Without the floor, a term appearing in more than half the corpus gets a
 * negative IDF and *penalises* the documents containing it, which for a
 * single-symbol corpus (where the ticker appears everywhere) inverts the ranking.
 */
function bm25Scores(chunks: readonly RetrievableChunk[], queryTerms: readonly string[]): number[] {
  if (chunks.length === 0 || queryTerms.length === 0) return chunks.map(() => 0);

  const tokenised = chunks.map((chunk) => tokenise(indexText(chunk)).map(stem));
  const lengths = tokenised.map((tokens) => tokens.length);
  const avgLength = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);

  const termFrequencies = tokenised.map((tokens) => {
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return counts;
  });

  const documentFrequency = new Map<string, number>();
  for (const term of new Set(queryTerms)) {
    let df = 0;
    for (const counts of termFrequencies) if (counts.has(term)) df += 1;
    documentFrequency.set(term, df);
  }

  const n = chunks.length;
  return chunks.map((_, index) => {
    const counts = termFrequencies[index] as Map<string, number>;
    const length = lengths[index] as number;
    let score = 0;
    for (const term of queryTerms) {
      const tf = counts.get(term);
      if (tf === undefined) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.max(0, Math.log((n - df + 0.5) / (df + 0.5) + 1));
      const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (length / Math.max(1, avgLength)));
      score += idf * ((tf * (BM25_K1 + 1)) / denominator);
    }
    return score;
  });
}

/** Dense-rank positions (1-based) for the entries scoring above `floor`. */
function rankMap(scores: readonly number[], floor: number): Map<number, number> {
  const ordered = scores
    .map((score, index) => ({ score, index }))
    .filter((entry) => entry.score > floor)
    .sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score));
  const ranks = new Map<number, number>();
  ordered.forEach((entry, position) => ranks.set(entry.index, position + 1));
  return ranks;
}

/**
 * How much a channel's ordering should be trusted on *this* query.
 *
 * Reciprocal-rank fusion assumes both input lists are individually informative,
 * and combines their ranks with equal weight. On this corpus the dense channel
 * frequently violates that assumption: because the embedding is a hashed n-gram
 * map, every chunk of financial English scores 0.34–0.40 against a given query, a
 * relative spread of ~14%. Its *ordering* within that band is close to arbitrary,
 * but RRF cannot tell — it sees a ranked list and gives it a full vote. The
 * observed consequence was concrete: for "has any insider at NVDA bought shares",
 * BM25 put the two Form 4 chunks first (17.5 and 13.6) and the 10-Q fifth (2.8),
 * and the fusion still returned the 10-Q first, purely because the noise ordering
 * happened to place it fourth.
 *
 * Confidence is the relative dispersion of the admitted scores,
 * `(max − min) / max`. A channel that separates its candidates strongly earns a
 * value near 1; a channel returning a flat band earns one near 0. The two are
 * then normalised to sum to 1, so a query where only the lexical channel
 * discriminates is decided by the lexical channel, and a paraphrased query with
 * no term overlap — where BM25 is flat or empty and the dense channel is not — is
 * decided by the dense channel. Neither is hard-wired to win.
 */
function channelConfidence(scores: readonly number[], ranks: ReadonlyMap<number, number>, depth: number): number {
  const admitted: number[] = [];
  for (const [index, rank] of ranks) {
    if (rank <= depth) admitted.push(scores[index] as number);
  }
  if (admitted.length < 2) return admitted.length === 1 ? 1 : 0;
  const max = Math.max(...admitted);
  const min = Math.min(...admitted);
  if (max <= 0) return 0;
  return Math.max(0, Math.min(1, (max - min) / max));
}

export interface RetrieveOptions {
  /** Chunks returned after re-ranking. */
  topK?: number;
  /** Restricts the candidate pool. Applied before scoring. */
  symbols?: readonly string[];
  sourceTypes?: readonly RagSourceType[];
  /** Reference instant for the recency factor. */
  now?: number;
  /** How many chunks each channel contributes to the fusion. */
  channelDepth?: number;
}

export function retrieve(
  chunks: readonly RetrievableChunk[],
  question: string,
  options: RetrieveOptions = {},
): RetrievalResult {
  const startedAt = Date.now();
  const topK = options.topK ?? 8;
  const now = options.now ?? Date.now();
  const channelDepth = options.channelDepth ?? 40;

  const symbolFilter = options.symbols === undefined ? null : new Set(options.symbols.map((s) => s.toUpperCase()));
  const typeFilter = options.sourceTypes === undefined ? null : new Set(options.sourceTypes);

  /**
   * Market-wide documents (`symbol === null`) survive a symbol filter. A question
   * about one name still needs the regulatory-status and macro documents, and
   * excluding them would make "can the platform trade AAPL for me?" unanswerable.
   */
  const candidates = chunks.filter((chunk) => {
    if (typeFilter !== null && !typeFilter.has(chunk.sourceType)) return false;
    if (symbolFilter !== null && chunk.symbol !== null && !symbolFilter.has(chunk.symbol.toUpperCase())) return false;
    return true;
  });

  const queryTerms = tokenise(question);
  const lexical = bm25Scores(candidates, expandQuery(queryTerms));

  const queryVector = embed(question);
  const dense = candidates.map((chunk) => cosine(queryVector, chunk.embedding ?? embed(indexText(chunk))));

  // A dense floor of 0.02 keeps the fusion from admitting the entire corpus:
  // hashed embeddings give almost every pair of financial documents a small
  // positive similarity, so without a floor every chunk earns an RRF term.
  const lexicalRanks = rankMap(lexical, 0);
  const denseRanks = rankMap(dense, 0.02);

  /**
   * Channel depth is capped relative to the pool, not just by the option.
   *
   * With a fixed depth of 40 and a symbol-scoped pool of ~25 chunks, every chunk
   * enters the fusion through both channels and the RRF term stops discriminating
   * — the fusion admits the whole corpus and the re-rank decides everything.
   * Admitting at most the top ~40% of each channel (never fewer than five) keeps
   * the fusion a filter rather than a formality.
   */
  const depth = Math.min(channelDepth, Math.max(5, Math.ceil(candidates.length * 0.4)));

  const lexicalConfidence = channelConfidence(lexical, lexicalRanks, depth);
  const denseConfidence = channelConfidence(dense, denseRanks, depth);
  const totalConfidence = lexicalConfidence + denseConfidence;
  // Equal weight is the honest default when neither channel separated anything:
  // the result will fail the relevance floor regardless, and the ordering of a
  // set nothing distinguishes is arbitrary either way.
  const lexicalWeight = totalConfidence === 0 ? 0.5 : lexicalConfidence / totalConfidence;
  const denseWeight = totalConfidence === 0 ? 0.5 : denseConfidence / totalConfidence;

  const scored: ScoredChunk[] = candidates.map((chunk, index) => {
    const bm25 = lexical[index] as number;
    const denseScore = dense[index] as number;
    const bm25Rank = lexicalRanks.get(index) ?? null;
    const denseRank = denseRanks.get(index) ?? null;

    let fused = 0;
    const channels: ('lexical' | 'dense')[] = [];
    if (bm25Rank !== null && bm25Rank <= depth) {
      fused += lexicalWeight * (1 / (RRF_K + bm25Rank));
      channels.push('lexical');
    }
    if (denseRank !== null && denseRank <= depth) {
      fused += denseWeight * (1 / (RRF_K + denseRank));
      channels.push('dense');
    }

    /**
     * Both factors are narrow bands close to 1, deliberately.
     *
     * They exist to break ties between comparably-relevant passages — prefer the
     * 10-K to the tweet, prefer this quarter to last — not to reorder the list.
     * Recency spans [0.75, 1] and authority [0.78, 1], so together they can move
     * a chunk by at most ~1.7×, while the fusion term spans ~2.8× across the
     * admitted depth. Relevance therefore decides the ordering and provenance
     * decides the near-ties, which is the intended precedence.
     */
    const ageMs = Math.max(0, now - chunk.publishedAt);
    const recencyFactor = 0.75 + 0.25 * Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS);
    const authorityFactor = 0.78 + 0.22 * chunk.authority;

    return {
      chunk,
      bm25,
      bm25Rank,
      dense: denseScore,
      denseRank,
      fused,
      authorityFactor,
      recencyFactor,
      score: fused * authorityFactor * recencyFactor,
      channels,
    };
  });

  const hits = scored
    .filter((entry) => entry.fused > 0)
    .sort((a, b) => (b.score === a.score ? a.chunk.id.localeCompare(b.chunk.id) : b.score - a.score))
    .slice(0, topK);

  // Term coverage is measured against the candidate pool rather than the whole
  // corpus, so "insider buying at a symbol with no Form 4" reports honestly
  // rather than matching the word "insider" in an unrelated name's filing.
  // Measured on the *unexpanded* query. Synonym expansion exists to improve
  // ranking, and letting it decide scope would make an out-of-corpus question
  // look in-scope because one of its synonyms happens to appear somewhere.
  const corpusTerms = new Set<string>();
  for (const chunk of candidates) for (const token of tokenise(indexText(chunk))) corpusTerms.add(stem(token));
  const uniqueQueryTerms = new Set(queryTerms.map(stem));
  const termsInCorpus = [...uniqueQueryTerms].filter((term) => corpusTerms.has(term)).length;

  return {
    hits,
    trace: {
      queryTerms,
      candidates: candidates.length,
      lexicalHits: lexicalRanks.size,
      denseHits: denseRanks.size,
      symbols: symbolFilter === null ? [] : [...symbolFilter],
      bestBm25: lexical.length === 0 ? 0 : Math.max(...lexical),
      bestDense: dense.length === 0 ? 0 : Math.max(...dense),
      lexicalWeight,
      denseWeight,
      termsInCorpus,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    },
  };
}

/**
 * Diversifies the hit list so one document cannot own the whole citation set.
 *
 * A 10-K split into three chunks will frequently take the top three slots, which
 * leaves an answer cited three times to the same paragraph. Capping per document
 * and back-filling from the remainder produces a citation set a reader can
 * actually cross-check. This is maximal-marginal-relevance in spirit, using
 * document identity as the redundancy proxy instead of pairwise similarity.
 */
export function diversify(hits: readonly ScoredChunk[], perDocument = 2, limit = 6): ScoredChunk[] {
  const counts = new Map<string, number>();
  const kept: ScoredChunk[] = [];
  const overflow: ScoredChunk[] = [];

  for (const hit of hits) {
    const seen = counts.get(hit.chunk.documentId) ?? 0;
    if (seen < perDocument) {
      counts.set(hit.chunk.documentId, seen + 1);
      kept.push(hit);
    } else {
      overflow.push(hit);
    }
  }

  return [...kept, ...overflow].slice(0, limit);
}
