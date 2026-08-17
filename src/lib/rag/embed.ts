/**
 * Deterministic dense embeddings.
 *
 * The retrieval mandate calls for hybrid search — a sparse lexical channel and a
 * dense semantic channel fused by reciprocal rank. A hosted embedding model
 * would satisfy the dense half, but it would also make the platform's core
 * retrieval unusable with an empty `.env`, which the build contract forbids.
 *
 * The dense channel is therefore a **hashed feature map**: character n-grams and
 * word unigrams/bigrams projected into a fixed-width space by a signed hash,
 * sub-linearly weighted and L2-normalised. This is the "hashing trick" of
 * Weinberger et al. (2009), and its relevant property is that the inner product
 * of two hashed vectors is an unbiased estimator of the inner product of the
 * underlying explicit feature vectors. So cosine similarity in this space
 * approximates cosine similarity over shared n-grams.
 *
 * What that buys, concretely, is morphological and typographic robustness the
 * sparse channel does not have: "amortisation"/"amortization", "10-K"/"10K" and
 * "guidance cut"/"cut guidance" land close together because they share character
 * n-grams, even though BM25 sees different terms. What it does *not* buy is
 * distributional semantics — "revenue" and "turnover" remain unrelated. That is
 * an honest limitation, and it is why the fusion keeps a lexical channel with
 * real weight instead of trusting the dense scores alone.
 *
 * If a hosted embedding provider is configured later, only `embed()` changes;
 * the retriever consumes vectors, not a model.
 */

/**
 * 256 dimensions. Wide enough that hash collisions stay rare at this corpus size
 * (a few hundred documents, a few thousand distinct n-grams per document), and
 * narrow enough that a stored embedding costs 1KB — which matters because they
 * are persisted as blobs alongside every chunk.
 */
export const EMBEDDING_DIM = 256;

/** Character n-gram width. Three is the standard choice for this purpose. */
const CHAR_NGRAM = 3;

/**
 * FNV-1a, 32-bit. Chosen over a cryptographic hash because the requirement is
 * uniform distribution and speed, not preimage resistance, and over `hashSeed`
 * because the sign bit is used as the feature's signed direction and FNV's
 * avalanche behaviour on short strings is well characterised.
 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // 16777619, as shift-adds — Math.imul keeps this in 32-bit integer space.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normaliseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9%$.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text: string): string[] {
  return normaliseText(text)
    .split(' ')
    .filter((word) => word.length > 0);
}

/**
 * Accumulates one feature into the vector.
 *
 * The sign is taken from a second hash of the same string rather than from a bit
 * of the first, so the bucket index and the sign are independent — a
 * correlated sign would bias the collision behaviour the estimator relies on.
 */
function accumulate(vector: Float64Array, feature: string, weight: number): void {
  const hash = fnv1a(feature);
  const index = hash % EMBEDDING_DIM;
  const sign = (fnv1a(`${feature}`) & 1) === 0 ? 1 : -1;
  vector[index] = (vector[index] as number) + sign * weight;
}

/**
 * Embeds text.
 *
 * Weights: unigrams 1.0, bigrams 0.7 (word order carries less signal than the
 * words themselves in filing prose), character trigrams 0.35 each — individually
 * weak but numerous, so the block contributes comparable total mass while
 * providing the fuzzy matching. Term frequency is damped by `1 + ln(tf)`, the
 * standard sub-linear scaling, so a filing that repeats "risk" forty times does
 * not drown out everything else.
 */
export function embed(text: string): number[] {
  const vector = new Float64Array(EMBEDDING_DIM);
  const tokens = words(text);
  if (tokens.length === 0) return Array.from(vector);

  const unigrams = new Map<string, number>();
  for (const token of tokens) unigrams.set(token, (unigrams.get(token) ?? 0) + 1);
  for (const [token, count] of unigrams) accumulate(vector, `u:${token}`, 1.0 * (1 + Math.log(count)));

  const bigrams = new Map<string, number>();
  for (let i = 1; i < tokens.length; i += 1) {
    const bigram = `${tokens[i - 1]} ${tokens[i]}`;
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }
  for (const [bigram, count] of bigrams) accumulate(vector, `b:${bigram}`, 0.7 * (1 + Math.log(count)));

  // Character trigrams over the space-padded token, so word boundaries are part
  // of the n-gram alphabet and a prefix match scores higher than an infix one.
  const grams = new Map<string, number>();
  for (const token of unigrams.keys()) {
    const padded = ` ${token} `;
    for (let i = 0; i + CHAR_NGRAM <= padded.length; i += 1) {
      const gram = padded.slice(i, i + CHAR_NGRAM);
      grams.set(gram, (grams.get(gram) ?? 0) + 1);
    }
  }
  for (const [gram, count] of grams) accumulate(vector, `c:${gram}`, 0.35 * (1 + Math.log(count)));

  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i += 1) norm += (vector[i] as number) ** 2;
  norm = Math.sqrt(norm);
  if (norm === 0) return Array.from(vector);
  for (let i = 0; i < EMBEDDING_DIM; i += 1) vector[i] = (vector[i] as number) / norm;

  return Array.from(vector);
}

/**
 * Cosine similarity of two embeddings.
 *
 * Both inputs are already unit vectors, so this is a plain dot product; the
 * norms are recomputed anyway because a decoded Float32 blob is unit-length only
 * to within float32 precision, and skipping the correction lets a rounding
 * artefact leak into the fused score.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
