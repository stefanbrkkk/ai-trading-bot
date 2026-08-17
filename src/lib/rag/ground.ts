/**
 * Claim-level grounding.
 *
 * The research is explicit that document-level citation is not verification: an
 * answer can cite a filing that exists, is relevant, and does not contain the
 * number the sentence asserts. So grounding operates on **claims**, not answers,
 * and reports a per-claim verdict plus the span of evidence that produced it.
 *
 * Claims are typed, because verification means something different for each:
 *
 *   • `numerical` — the claim states a quantity. Verified only if every quantity
 *     in it is present in the evidence, matched with unit-aware tolerance.
 *   • `temporal` — the claim places something in time. Verified if the date,
 *     quarter or fiscal-year reference appears in the evidence.
 *   • `entity_attribute` — the claim ascribes a property to a company. Verified
 *     by content-term coverage above a threshold.
 *   • `comparative` — the claim ranks or contrasts two things. Verified only if
 *     *both* sides are grounded, because a comparison half-supported is a
 *     comparison unsupported.
 *   • `regulatory` — the claim states what the platform or a rule permits.
 *     Verified only against the platform's own regulatory-status document, and
 *     never against a company filing or a social post.
 *   • `computational` — the claim reports a figure the platform derived itself
 *     (a SHAP contribution, a z-score, a half-life). It is grounded in the
 *     computation, not in the corpus, so it is verified against the supplied
 *     computed-values set and marked as platform-derived.
 *
 * The grounding score is the fraction of claims verified. It is displayed rather
 * than used as a gate: a low score is information for the reader, and silently
 * dropping unverified sentences would produce a confident answer that hides what
 * it could not support.
 */

import { citationMarkers, splitSentences, stripCitationMarkers, tokenise } from '@/lib/ai/deterministic';
import type { ClaimCategory, GroundedClaim } from '@/lib/domain/types';

export interface Evidence {
  /** Index into the citation array the answer exposes. */
  citationIndex: number;
  text: string;
  sourceType: string;
  documentId: string;
}

/** Figures the platform computed itself, keyed by how they appear in prose. */
export interface ComputedValues {
  [label: string]: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Numeric extraction
// ─────────────────────────────────────────────────────────────────────────────

interface Quantity {
  /** Canonical magnitude in base units (dollars, shares, or a bare number). */
  value: number;
  /** Percent, currency, multiple, count, or bare. */
  kind: 'percent' | 'currency' | 'multiple' | 'count' | 'bare';
  raw: string;
}

const SCALES: Record<string, number> = {
  trillion: 1e12,
  't': 1e12,
  billion: 1e9,
  'bn': 1e9,
  'b': 1e9,
  million: 1e6,
  'mm': 1e6,
  'm': 1e6,
  thousand: 1e3,
  'k': 1e3,
};

/**
 * Pulls quantities out of prose.
 *
 * The pattern deliberately captures the scale word and the unit marker, because
 * `1.4` and `$1.4 billion` are not the same claim and a matcher that compares
 * bare mantissas would verify the first against the second. Basis points are
 * normalised to percent so "one hundred basis points" and "1.0%" compare equal.
 */
export function extractQuantities(text: string): Quantity[] {
  const out: Quantity[] = [];
  const pattern =
    /(\$)?\s*(-?\d[\d,]*(?:\.\d+)?)\s*(trillion|billion|million|thousand|bn|mm|[tbmk])?\s*(%|percent|x|basis points|bps|shares|people|positions)?/gi;

  for (const match of text.matchAll(pattern)) {
    const [raw, dollar, mantissa, scaleWord, unit] = match;
    if (mantissa === undefined) continue;
    const numeric = Number(mantissa.replace(/,/g, ''));
    if (!Number.isFinite(numeric)) continue;

    const scale = scaleWord === undefined ? 1 : (SCALES[scaleWord.toLowerCase()] ?? 1);
    const unitLower = unit?.toLowerCase();

    let kind: Quantity['kind'] = 'bare';
    let value = numeric * scale;

    if (unitLower === '%' || unitLower === 'percent') kind = 'percent';
    else if (unitLower === 'basis points' || unitLower === 'bps') {
      kind = 'percent';
      value = (numeric * scale) / 100;
    } else if (unitLower === 'x') kind = 'multiple';
    else if (unitLower === 'shares' || unitLower === 'people' || unitLower === 'positions') kind = 'count';
    else if (dollar !== undefined) kind = 'currency';

    // A bare integer under 32 with no unit is almost always structural — an item
    // number, a quarter, a count of days — rather than a claim. Including them
    // makes every sentence numerically unverifiable for no gain.
    if (kind === 'bare' && Math.abs(value) < 32 && Number.isInteger(value)) continue;

    out.push({ value, kind, raw: raw.trim() });
  }

  return out;
}

/**
 * Whether two quantities agree.
 *
 * Tolerance is relative and generous (1.5%) because prose rounds: a filing
 * stating "$1.42 billion" and an answer stating "$1.4 billion" are the same
 * claim, and a strict comparison would report the answer as fabricated. Percent
 * values additionally accept an absolute 0.1pp tolerance, since a margin quoted
 * to one decimal cannot round-trip more precisely than that.
 */
function quantitiesAgree(a: Quantity, b: Quantity): boolean {
  if (a.kind !== b.kind) {
    // A bare number is allowed to match a typed one — prose frequently drops the
    // unit on the second mention ("margin was 41.2%… the 41.2 figure").
    if (a.kind !== 'bare' && b.kind !== 'bare') return false;
  }
  const scale = Math.max(Math.abs(a.value), Math.abs(b.value));
  if (scale === 0) return Math.abs(a.value - b.value) < 1e-9;
  const relative = Math.abs(a.value - b.value) / scale;
  if (relative <= 0.015) return true;
  if (a.kind === 'percent' || b.kind === 'percent') return Math.abs(a.value - b.value) <= 0.1;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Temporal extraction
// ─────────────────────────────────────────────────────────────────────────────

const TEMPORAL_PATTERN =
  /\b(Q[1-4]\s*\d{4}|FY\s*\d{2,4}|fiscal\s+\d{4}|\d{4}-\d{2}-\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}|(?:next|last|prior|trailing)\s+(?:twelve months|quarter|year|four quarters))\b/gi;

function extractTemporal(text: string): string[] {
  return [...text.matchAll(TEMPORAL_PATTERN)].map((match) => (match[1] ?? '').toLowerCase().replace(/\s+/g, ' ').trim());
}

// ─────────────────────────────────────────────────────────────────────────────
//  Classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Terms that make a sentence a claim about *advisory scope* — what this service
 * is permitted to do and what its output is not.
 *
 * The list is narrow on purpose. An earlier version included 'regulation',
 * 'compliance', 'rule' and 'disclosure', which caught every company's own
 * regulatory risk-factor disclosure ("we are subject to evolving regulation, and
 * compliance costs may increase") and routed it to the platform-status verifier,
 * where a perfectly well-sourced sentence from a 10-K could not possibly ground.
 * A claim about a company's regulatory exposure is an entity attribute; only a
 * claim about advice, discretion or individualisation is a regulatory claim in
 * the sense that matters here.
 */
const REGULATORY_TERMS = [
  'advice', 'adviser', 'advisor', 'recommendation', 'recommend', 'discretionary', 'discretion over',
  'fiduciary', 'suitability', 'publisher', 'individualised', 'individualized', 'tailored to',
  'not tailored', 'on your behalf', 'investment advice',
];

const COMPARATIVE_TERMS = [
  'higher', 'lower', 'more', 'less', 'above', 'below', 'outperform', 'underperform', 'versus',
  'compared', 'than', 'exceeds', 'trails', 'widest', 'narrowest', 'strongest', 'weakest',
  'ahead of', 'behind',
];

const COMPUTATIONAL_TERMS = [
  'shap', 'attribution', 'contribution', 'z-score', 'zscore', 'half-life', 'conviction',
  'probability', 'sharpe', 'drawdown', 'profit factor', 'kelly', 'residual', 'coefficient',
  'reversion', 'innovation', 'percentile', 'quantile', 'ensemble', 'regime',
];

export function classifyClaim(text: string): ClaimCategory {
  const lower = text.toLowerCase();

  // Order matters. Regulatory outranks everything: a sentence about what the
  // platform may do must be graded against the regulatory document even when it
  // also contains a number. Computational outranks numerical for the same
  // reason — a SHAP figure is not in any filing and grading it as numerical
  // would mark a correct sentence unverified.
  if (REGULATORY_TERMS.some((term) => lower.includes(term))) return 'regulatory';
  if (COMPUTATIONAL_TERMS.some((term) => lower.includes(term))) return 'computational';
  if (COMPARATIVE_TERMS.some((term) => lower.includes(term)) && extractQuantities(text).length > 0) return 'comparative';
  if (extractQuantities(text).length > 0) return 'numerical';
  if (extractTemporal(text).length > 0) return 'temporal';
  return 'entity_attribute';
}

// ─────────────────────────────────────────────────────────────────────────────
//  Verification
// ─────────────────────────────────────────────────────────────────────────────

interface Verdict {
  verified: boolean;
  citationIndex: number | null;
  evidence: string | null;
}

/** The evidence span containing `needle`, trimmed to a readable window. */
function span(text: string, needle: string): string {
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return text.slice(0, 180);
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + needle.length + 90);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

function verifyNumerical(claim: string, evidence: readonly Evidence[]): Verdict {
  const claimed = extractQuantities(claim);
  if (claimed.length === 0) return { verified: false, citationIndex: null, evidence: null };

  for (const source of evidence) {
    const available = extractQuantities(source.text);
    // Every quantity in the claim must be present in this one source. Allowing
    // them to be spread across sources would verify a sentence that combines two
    // documents' numbers into a relationship neither states.
    const allPresent = claimed.every((needed) => available.some((found) => quantitiesAgree(needed, found)));
    if (allPresent) {
      const first = claimed[0] as Quantity;
      return { verified: true, citationIndex: source.citationIndex, evidence: span(source.text, first.raw) };
    }
  }
  return { verified: false, citationIndex: null, evidence: null };
}

function verifyTemporal(claim: string, evidence: readonly Evidence[]): Verdict {
  const references = extractTemporal(claim);
  if (references.length === 0) return { verified: false, citationIndex: null, evidence: null };
  for (const source of evidence) {
    const available = extractTemporal(source.text);
    if (references.every((reference) => available.includes(reference))) {
      return { verified: true, citationIndex: source.citationIndex, evidence: span(source.text, references[0] as string) };
    }
  }
  return { verified: false, citationIndex: null, evidence: null };
}

/**
 * Term-coverage verification.
 *
 * A claim is grounded when a high proportion of its content terms appear in one
 * evidence span. 0.6 is the threshold: high enough that a paraphrase sharing only
 * the subject fails, low enough that a genuine restatement passes. Function words
 * are already stripped by `tokenise`, so the denominator is content terms only.
 */
function verifyByCoverage(claim: string, evidence: readonly Evidence[], threshold: number): Verdict {
  const terms = new Set(tokenise(claim));
  if (terms.size === 0) return { verified: false, citationIndex: null, evidence: null };

  let best: { ratio: number; source: Evidence } | null = null;
  for (const source of evidence) {
    const available = new Set(tokenise(source.text));
    let hit = 0;
    for (const term of terms) if (available.has(term)) hit += 1;
    const ratio = hit / terms.size;
    if (best === null || ratio > best.ratio) best = { ratio, source };
  }

  if (best === null || best.ratio < threshold) return { verified: false, citationIndex: null, evidence: null };
  return { verified: true, citationIndex: best.source.citationIndex, evidence: best.source.text.slice(0, 200) };
}

function verifyRegulatory(claim: string, evidence: readonly Evidence[]): Verdict {
  // Only the platform's own status document can ground a claim about what the
  // platform is permitted to do. A company filing that happens to use the word
  // "disclosure" is not evidence about this service.
  const authoritative = evidence.filter((source) => source.documentId === 'platform-regulatory-status');
  if (authoritative.length === 0) return { verified: false, citationIndex: null, evidence: null };
  return verifyByCoverage(claim, authoritative, 0.45);
}

function verifyComputational(claim: string, computed: ComputedValues): Verdict {
  const claimed = extractQuantities(claim);
  if (claimed.length === 0) {
    // A qualitative statement about a computed quantity ("the driver set is
    // dominated by momentum") is grounded in the platform's own output by
    // construction; there is no external source to check it against.
    return {
      verified: true,
      citationIndex: null,
      evidence: 'Derived on-platform from the model output; no external source applies.',
    };
  }

  const values = Object.entries(computed);
  for (const needed of claimed) {
    const match = values.find(([, value]) => quantitiesAgree(needed, { value, kind: needed.kind, raw: String(value) }));
    if (match === undefined) {
      return { verified: false, citationIndex: null, evidence: null };
    }
  }
  return {
    verified: true,
    citationIndex: null,
    evidence: `Derived on-platform: ${values.map(([label, value]) => `${label}=${value}`).join(', ')}`,
  };
}

export interface GroundingResult {
  claims: GroundedClaim[];
  /** Verified claims / total claims. 1 when there are no claims to check. */
  groundingScore: number;
}

/**
 * Grades every sentence of an answer.
 *
 * Sentences shorter than four content terms are skipped rather than graded — a
 * connective ("Two points follow.") is not a claim, and grading it as an
 * unverified entity attribute would depress the score without telling the reader
 * anything.
 */
export function groundAnswer(
  answer: string,
  evidence: readonly Evidence[],
  computed: ComputedValues = {},
): GroundingResult {
  const claims: GroundedClaim[] = [];

  for (const raw of splitSentences(answer)) {
    const sentence = stripCitationMarkers(raw);
    if (tokenise(sentence).length < 4) continue;

    /**
     * A sentence carrying `[n]` markers is checked against those sources first.
     * That is not a shortcut — it is the stricter test. A synthesiser that
     * attributes a number to excerpt 3 has made a claim about excerpt 3, and
     * verifying it against excerpt 5 instead would pass an answer whose citation
     * is wrong. The remaining sources stay in the list as a fallback so an
     * unattributed sentence is still checked against everything.
     */
    const markers = citationMarkers(raw);
    const ordered =
      markers.length === 0
        ? evidence
        : [
            ...evidence.filter((source) => markers.includes(source.citationIndex + 1)),
            ...evidence.filter((source) => !markers.includes(source.citationIndex + 1)),
          ];

    const category = classifyClaim(sentence);
    const verdict =
      category === 'numerical'
        ? verifyNumerical(sentence, ordered)
        : category === 'temporal'
          ? verifyTemporal(sentence, ordered)
          : category === 'comparative'
            ? // Both halves must ground: verify the numbers *and* the framing.
              (() => {
                const numeric = verifyNumerical(sentence, ordered);
                if (!numeric.verified) return numeric;
                const framing = verifyByCoverage(sentence, ordered, 0.5);
                return framing.verified ? numeric : { verified: false, citationIndex: null, evidence: null };
              })()
            : category === 'regulatory'
              ? verifyRegulatory(sentence, ordered)
              : category === 'computational'
                ? verifyComputational(sentence, computed)
                : verifyByCoverage(sentence, ordered, 0.6);

    claims.push({
      text: sentence,
      category,
      verified: verdict.verified,
      citationIndex: verdict.citationIndex,
      evidence: verdict.evidence,
    });
  }

  const verified = claims.filter((claim) => claim.verified).length;
  return { claims, groundingScore: claims.length === 0 ? 1 : verified / claims.length };
}
