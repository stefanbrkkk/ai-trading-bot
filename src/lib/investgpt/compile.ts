/**
 * The deterministic natural-language-to-SQL compiler.
 *
 * This is not a fallback for when the API key is missing. It is the default path,
 * and the reason is a property a language model cannot offer: the SQL it produces
 * is a *function* of the question. The same question yields the same statement on
 * every machine and every run, which means the query behind a screening result
 * can be reconstructed from the audit ledger months later and re-executed to the
 * same rows. For a platform whose entire regulatory posture rests on publishing
 * impersonal, reproducible analysis, that is worth more than the extra recall a
 * model would add on unusual phrasings.
 *
 * It is a genuine compiler, not a template matcher: a scanner recognises typed
 * spans in the question (feature references, comparators, quantities, categorical
 * values, ordering intent), a resolver binds each span to a catalog column, and
 * an emitter renders a parameterised statement. It handles what it recognises and
 * says plainly what it did not — `notes` records every interpretation it made and
 * `unparsed` records every clause it ignored, so a user is never left guessing why
 * a filter had no effect.
 *
 * Where a live model *is* configured, `index.ts` runs it in parallel and prefers
 * its SQL only when the validator passes it and it references nothing outside the
 * pruned schema. The compiler stays the floor beneath it.
 */

import { FEATURE_DEFINITIONS, type FeatureDefinition } from '@/lib/engine/features';
import { SECTORS, getSpec } from '@/lib/market/universe';
import { SNAPSHOT_TABLE, tableSpec } from '@/lib/investgpt/catalog';
import type { RegimeLabel, Sector, SignalDirection } from '@/lib/domain/types';

/** Parameterised SQL. Values are never interpolated into the statement text. */
export interface CompiledQuery {
  sql: string;
  params: (string | number)[];
  /** Columns the projection will return, in order. */
  columns: string[];
  /** Interpretations the compiler made, in user-facing language. */
  notes: string[];
  /** Fragments of the question the compiler did not understand. */
  unparsed: string[];
  /** Plain-English restatement of the emitted query. */
  explanation: string;
  /** Structured plan, surfaced in the query inspector. */
  plan: QueryPlan;
}

export interface QueryPlan {
  intent: 'list' | 'count' | 'aggregate';
  filters: { column: string; operator: string; value: string; source: string }[];
  orderBy: { column: string; direction: 'ASC' | 'DESC' } | null;
  limit: number;
  aggregate: { function: string; column: string } | null;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

// ─────────────────────────────────────────────────────────────────────────────
//  Lexicon
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Comparators, longest-first.
 *
 * Order is load-bearing: "greater than or equal to" must be tried before
 * "greater than", and "at least" before "least", or the shorter form consumes the
 * span and the emitted operator is wrong in a way that silently changes results.
 */
const COMPARATORS: readonly { phrases: readonly string[]; op: '>' | '<' | '>=' | '<=' | '=' | '!=' }[] = [
  { phrases: ['greater than or equal to', 'at least', 'no less than', 'not below', '>='], op: '>=' },
  { phrases: ['less than or equal to', 'at most', 'no more than', 'not above', '<='], op: '<=' },
  { phrases: ['greater than', 'more than', 'higher than', 'above', 'over', 'exceeds', 'exceeding', 'beyond', '>'], op: '>' },
  { phrases: ['less than', 'lower than', 'smaller than', 'below', 'under', 'beneath', '<'], op: '<' },
  { phrases: ['not equal to', 'other than', 'excluding', '!=', '<>'], op: '!=' },
  { phrases: ['equal to', 'equals', 'exactly', 'is', '=='], op: '=' },
];

/** The comparator a negated comparison means instead. */
const NEGATED_COMPARATOR: Readonly<Record<string, '>' | '<' | '>=' | '<=' | '=' | '!='>> = {
  '>': '<=',
  '<': '>=',
  '>=': '<',
  '<=': '>',
  '=': '!=',
  '!=': '=',
};

/**
 * Words that invert the predicate they govern.
 *
 * The comparator table above already carries "not below", "not above", "no less
 * than" and "other than", so a negated *number* written one of those four ways
 * has always compiled correctly. Everything else negated did not, and it failed
 * in the one way this compiler is built to make impossible: silently, and with
 * every surface agreeing. "Which names are not optionable?" emitted
 * `optionable = 1`; "Which stocks are not in the Technology sector?" emitted
 * `sector IN ('Technology')`; "stocks that are not bullish" emitted
 * `direction = 'long'`. In each case the SQL, the structured plan, the English
 * readback and the row set all said the same thing, and all of them said the
 * opposite of the question. Nothing landed in `notes` and nothing landed in
 * `unparsed`, so a user checking the compiler's work — which is the entire reason
 * the statement is published — found a clean parse of a question nobody asked.
 *
 * A negation the compiler cannot express is reported rather than dropped. A
 * negation it can express inverts the predicate and says so in `notes`.
 */
const NEGATION_CUES =
  /\b(?:not|non|no|never|without|excluding|exclude|except|other than|apart from|outside|isn't|aren't|doesn't|don't)\b/g;

/**
 * What may sit between a negation cue and the phrase it negates.
 *
 * Scope is the hard part, not detection. A fixed lookback window of a few dozen
 * characters reads "names that are not oversold in the technology sector" as a
 * negated *sector*, which would replace one silent misreading with another. So a
 * cue only binds to a phrase when everything between them is grammatical
 * filler — articles, prepositions, copulas, hyphens. A single content word in the
 * gap means the negation belongs to that word, and this phrase is not negated.
 */
const NEGATION_FILLER =
  /^[\s\-–—]*(?:(?:an?|the|any|all|is|are|be|being|been|in|on|of|to|for|from|within|inside|part|currently|those|these|that|which|it|they|them)[\s\-–—]+)*$/;

/**
 * The negation cue governing the phrase starting at `at`, or null.
 *
 * The cue text is returned rather than a boolean so the compiler can quote the
 * user's own word back in `notes`. "Read \"not\" as excluding Technology" is
 * checkable; a filter that merely happens to be right is not.
 */
function negationCueFor(lower: string, at: number): string | null {
  let cue: string | null = null;
  for (const match of lower.slice(0, at).matchAll(NEGATION_CUES)) {
    const gap = lower.slice((match.index ?? 0) + match[0].length, at);
    if (NEGATION_FILLER.test(gap)) cue = match[0];
  }
  return cue;
}

/**
 * Negates a predicate, keeping rows whose value is unknown.
 *
 * SQL's three-valued logic is the trap here. `direction != 'long'` is *false* for
 * a symbol carrying no signal at all, so the naive negation of "bullish names" is
 * not "every other name" — it silently drops the whole unranked tail. A user who
 * screens both halves of a partition and finds they do not add up to the universe
 * has been given two correct-looking answers and no way to tell which one lied.
 * The snapshot view declares its nullability, so the compiler reads it rather
 * than guessing: a NOT NULL column negates plainly, and a nullable one admits its
 * NULLs explicitly.
 */
function negatePredicate(column: string, bounds: readonly string[]): string {
  const spec = tableSpec(SNAPSHOT_TABLE);
  const nullable = spec?.columns.find((candidate) => candidate.name === column)?.nullable ?? true;
  const inner = `NOT (${bounds.join(' AND ')})`;
  return nullable ? `(${column} IS NULL OR ${inner})` : inner;
}

/** Words that mean "sort descending" / "sort ascending". */
const SUPERLATIVE_DESC = [
  'most', 'highest', 'largest', 'biggest', 'greatest', 'strongest', 'best', 'top', 'maximum', 'max',
];
const SUPERLATIVE_ASC = [
  'least', 'lowest', 'smallest', 'weakest', 'worst', 'bottom', 'minimum', 'min', 'cheapest',
];

/**
 * Market-capitalisation buckets.
 *
 * The boundaries are the conventional US equity definitions. They are published
 * here and echoed in `notes` on every use, because "mid-cap" is a convention
 * rather than a fact and a user comparing results against another tool needs to
 * know which convention was applied.
 */
const CAP_BUCKETS: readonly { phrases: readonly string[]; label: string; min: number | null; max: number | null }[] = [
  { phrases: ['mega cap', 'mega-cap', 'megacap'], label: 'mega-cap', min: 200e9, max: null },
  { phrases: ['large cap', 'large-cap', 'largecap'], label: 'large-cap', min: 10e9, max: null },
  { phrases: ['mid cap', 'mid-cap', 'midcap', 'medium cap'], label: 'mid-cap', min: 2e9, max: 10e9 },
  { phrases: ['small cap', 'small-cap', 'smallcap'], label: 'small-cap', min: 300e6, max: 2e9 },
  { phrases: ['micro cap', 'micro-cap', 'microcap'], label: 'micro-cap', min: null, max: 300e6 },
];

const DIRECTION_WORDS: readonly { phrases: readonly string[]; value: SignalDirection }[] = [
  { phrases: ['bullish', 'long signal', 'long side', 'upside signal', 'buy signal'], value: 'long' },
  { phrases: ['bearish', 'short signal', 'short side', 'downside signal', 'sell signal'], value: 'short' },
  { phrases: ['no signal', 'flat signal', 'neutral signal', 'no directional'], value: 'flat' },
];

const REGIME_WORDS: readonly { phrases: readonly string[]; value: RegimeLabel }[] = [
  { phrases: ['trending bull', 'bull trend', 'uptrend regime', 'trending up'], value: 'trending_bull' },
  { phrases: ['trending bear', 'bear trend', 'downtrend regime', 'trending down'], value: 'trending_bear' },
  { phrases: ['mean reverting', 'mean-reverting', 'range bound', 'range-bound', 'choppy'], value: 'mean_reverting' },
  { phrases: ['high volatility', 'high-volatility', 'volatile regime'], value: 'high_volatility' },
  { phrases: ['low volatility', 'low-volatility', 'quiet drift', 'low vol drift'], value: 'low_volatility_drift' },
  { phrases: ['illiquid', 'thin', 'thinly traded'], value: 'illiquid' },
];

/**
 * State-band words too generic to identify a feature on their own.
 *
 * Every feature's band names are drawn from the same small vocabulary of
 * intensity words, so "high relative volume" matches `STATE_HIGH` on RSI(2),
 * MACD, VPIN and a dozen others — and the first one scanned wins, producing a
 * filter on a feature the question never mentioned. Words on this list only
 * trigger a band match when the feature's own name or alias appears next to
 * them; distinctive words ("oversold", "squeeze", "capitulation") identify their
 * feature unambiguously and need no such support.
 */
const GENERIC_BAND_WORDS: ReadonlySet<string> = new Set([
  'high', 'low', 'strong', 'weak', 'normal', 'neutral', 'balanced', 'elevated', 'wide', 'tight',
  'positive', 'negative', 'rising', 'falling', 'flat', 'bullish', 'bearish', 'extreme', 'moderate',
  'stable', 'calm', 'quiet', 'active', 'heavy', 'light', 'above', 'below', 'inline', 'benign',
]);

/** How close a feature reference must be to license a generic band word. */
const GENERIC_BAND_WINDOW = 28;

/** Columns every listing carries. */
const BASE_PROJECTION: readonly string[] = [
  'symbol',
  'name',
  'sector',
  'price',
  'change_percent',
  'direction',
  'conviction',
];

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Feature definitions ordered so a longer alias is matched before a prefix of it. */
const FEATURE_PHRASES: readonly { phrase: string; definition: FeatureDefinition }[] = FEATURE_DEFINITIONS.flatMap(
  (definition) => [
    { phrase: definition.label.toLowerCase(), definition },
    { phrase: definition.sqlColumn.toLowerCase(), definition },
    ...definition.aliases.map((alias) => ({ phrase: alias.toLowerCase(), definition })),
  ],
)
  .filter((entry) => entry.phrase.length >= 3)
  .sort((a, b) => b.phrase.length - a.phrase.length);

/** Non-feature numeric columns addressable by name. */
const DIMENSION_PHRASES: readonly { phrase: string; column: string; label: string }[] = [
  { phrase: 'market cap', column: 'market_cap', label: 'market capitalisation' },
  { phrase: 'market capitalisation', column: 'market_cap', label: 'market capitalisation' },
  { phrase: 'market capitalization', column: 'market_cap', label: 'market capitalisation' },
  { phrase: 'conviction', column: 'conviction', label: 'conviction' },
  { phrase: 'probability', column: 'probability', label: 'probability' },
  { phrase: 'expected return', column: 'expected_return', label: 'expected return' },
  { phrase: 'price', column: 'price', label: 'price' },
  { phrase: 'last price', column: 'price', label: 'price' },
  { phrase: 'change percent', column: 'change_percent', label: 'session change' },
  { phrase: 'daily change', column: 'change_percent', label: 'session change' },
  { phrase: 'session change', column: 'change_percent', label: 'session change' },
  { phrase: 'adv', column: 'adv30', label: '30-day average daily volume' },
  { phrase: 'average daily volume', column: 'adv30', label: '30-day average daily volume' },
  { phrase: 'volume', column: 'session_volume', label: 'session volume' },
  { phrase: 'beta', column: 'reference_beta', label: 'reference beta' },
  { phrase: 'dividend yield', column: 'dividend_yield', label: 'dividend yield' },
  { phrase: 'horizon', column: 'horizon_days', label: 'signal horizon' },
  { phrase: 'shares outstanding', column: 'shares_outstanding', label: 'shares outstanding' },
].sort((a, b) => b.phrase.length - a.phrase.length);

interface Resolved {
  column: string;
  label: string;
  /** Present when the reference resolved to a model feature. */
  definition: FeatureDefinition | null;
  /** The literal phrase that matched, so the caller can claim only that span. */
  matchedPhrase: string | null;
}

/** Binds a phrase to a column, preferring the longest match. */
/**
 * Resolves the column a fragment is talking about.
 *
 * Candidates are ranked by where they *end*, then by length — nearest the
 * comparison wins, and a longer phrase beats a shorter one that ends in the same
 * place.
 *
 * Longest-anywhere was the previous rule and it read the wrong subject out of any
 * sentence carrying two of them: "technology stocks in a trending bear regime
 * with price under 50" matched "trend" from earlier in the string over "price"
 * immediately before the operator, and filtered on `regime_trend_score < 50` —
 * returning rows priced 187.23, 281.86 and 94.44 in answer to "price under 50".
 * A query that quietly answers a different question is the worst failure this
 * compiler has, because the SQL is shown and looks perfectly reasonable.
 *
 * Ranking on the end position keeps "relative volume" winning over "volume":
 * both end at the same index, so the longer phrase takes it.
 */
function resolveColumn(text: string): Resolved | null {
  const lower = text.toLowerCase();
  let best: { end: number; length: number; resolved: Resolved } | null = null;

  const consider = (phrase: string, resolved: Resolved): void => {
    const at = lower.lastIndexOf(phrase);
    if (at < 0) return;
    const end = at + phrase.length;
    if (best !== null && (end < best.end || (end === best.end && phrase.length <= best.length))) return;
    best = { end, length: phrase.length, resolved };
  };

  for (const entry of DIMENSION_PHRASES) {
    consider(entry.phrase, {
      column: entry.column,
      label: entry.label,
      definition: null,
      matchedPhrase: entry.phrase,
    });
  }
  for (const entry of FEATURE_PHRASES) {
    consider(entry.phrase, {
      column: entry.definition.sqlColumn,
      label: entry.definition.label,
      definition: entry.definition,
      matchedPhrase: entry.phrase,
    });
  }

  return best === null ? null : (best as { resolved: Resolved }).resolved;
}

/** The text surrounding a span, used by the adjacency tests. */
function neighbourhood(lower: string, at: number, length: number): string {
  return lower.slice(Math.max(0, at - GENERIC_BAND_WINDOW), Math.min(lower.length, at + length + GENERIC_BAND_WINDOW));
}

/** Whether any feature reference sits within the window around a span. */
function featureNear(lower: string, at: number, length: number): boolean {
  const window = neighbourhood(lower, at, length);
  return FEATURE_PHRASES.some((entry) => entry.phrase.length >= 4 && window.includes(entry.phrase));
}

/** Whether *this* feature's own name or an alias sits within the window. */
function definitionNear(lower: string, at: number, length: number, definition: FeatureDefinition): boolean {
  const window = neighbourhood(lower, at, length);
  const names = [definition.label, definition.sqlColumn, ...definition.aliases]
    .map((name) => name.toLowerCase())
    .filter((name) => name.length >= 3);
  return names.some((name) => window.includes(name));
}

/**
 * Parses a quantity, honouring the unit suffix.
 *
 * `2b` and `2` differ by nine orders of magnitude, and a screening filter that
 * silently reads "$2b market cap" as "$2 market cap" returns the entire universe
 * while looking like it filtered. Percent signs are *not* scaled: every percent
 * column in the view already stores whole percentage points, so "above 5%" is
 * `> 5`.
 */
function parseQuantity(raw: string): number | null {
  const match = /^(-?\d[\d,]*(?:\.\d+)?)\s*(%|percent|bn|billion|b|mm|million|m|k|thousand|t|trillion|x)?$/i.exec(
    raw.trim(),
  );
  if (match === null) return null;
  const value = Number((match[1] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;

  switch ((match[2] ?? '').toLowerCase()) {
    case 't':
    case 'trillion':
      return value * 1e12;
    case 'b':
    case 'bn':
    case 'billion':
      return value * 1e9;
    case 'm':
    case 'mm':
    case 'million':
      return value * 1e6;
    case 'k':
    case 'thousand':
      return value * 1e3;
    default:
      return value;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Compiler
// ─────────────────────────────────────────────────────────────────────────────

interface Clause {
  sql: string;
  params: (string | number)[];
  plan: QueryPlan['filters'][number];
  /** Columns the clause needs in the projection so the result explains itself. */
  project: string[];
}

/**
 * Words that make a fragment read like a filter rather than framing.
 *
 * Comparisons were the whole list, which missed every qualitative predicate the
 * compiler also understands — "positive MLOFI intent", "bullish", "oversold" —
 * so those went unreported when they failed to compile.
 */
const CONSTRAINT_LIKE =
  /\b(above|below|over|under|than|between|at least|at most|is|has|have|positive|negative|bullish|bearish|rising|falling|oversold|overbought|strong|weak|high|low|trending|reverting)\b/i;

export function compileQuestion(question: string): CompiledQuery {
  const original = question.trim();
  const lower = original.toLowerCase();
  const notes: string[] = [];
  const unparsed: string[] = [];
  const clauses: Clause[] = [];
  /** Spans already consumed, so a phrase is not parsed twice. */
  const consumed: { start: number; end: number }[] = [];

  const claim = (start: number, end: number): boolean => {
    if (consumed.some((span) => start < span.end && end > span.start)) return false;
    consumed.push({ start, end });
    return true;
  };

  // ── Intent ───────────────────────────────────────────────────────────────
  const isCount = /\b(how many|count of|number of|count)\b/.test(lower);

  /**
   * The phases run most-specific first, and each claims the span it consumed.
   *
   * The ordering is not cosmetic. A categorical value ("mean reverting regime",
   * "energy") identifies exactly one column, so it must be resolved before the
   * comparison scanner — whose subject window is necessarily wide — has a chance
   * to swallow it. When the comparison scanner ran first it claimed the span from
   * the start of the question through the comparator, which silently deleted every
   * sector, regime and cap filter that appeared before a numeric constraint. The
   * query still ran, still looked plausible, and returned the wrong universe.
   *
   *   1. categorical values — sector, cap bucket, direction, regime, optionable,
   *      explicit tickers
   *   2. numeric comparisons — `<feature> <comparator> <quantity>`
   *   3. qualitative state bands — the residual, and the most ambiguous
   */

  // ── Phase 1a: sectors ────────────────────────────────────────────────────
  const sectorAliases: Record<string, Sector> = {
    tech: 'Technology',
    technology: 'Technology',
    healthcare: 'Health Care',
    'health care': 'Health Care',
    health: 'Health Care',
    financial: 'Financials',
    financials: 'Financials',
    banks: 'Financials',
    'consumer discretionary': 'Consumer Discretionary',
    'consumer staples': 'Consumer Staples',
    industrials: 'Industrials',
    industrial: 'Industrials',
    energy: 'Energy',
    materials: 'Materials',
    utilities: 'Utilities',
    'real estate': 'Real Estate',
    'communication services': 'Communication Services',
    communications: 'Communication Services',
    telecom: 'Communication Services',
  };

  const sectors = new Set<Sector>();
  const excludedSectors = new Set<Sector>();
  let sectorCue: string | null = null;
  for (const [phrase, sector] of Object.entries(sectorAliases).sort((a, b) => b[0].length - a[0].length)) {
    const at = lower.indexOf(phrase);
    if (at < 0) continue;
    if (!claim(at, at + phrase.length)) continue;
    const cue = negationCueFor(lower, at);
    if (cue === null) {
      sectors.add(sector);
    } else {
      excludedSectors.add(sector);
      sectorCue = cue;
    }
  }
  if (sectors.size > 0) {
    const list = [...sectors];
    clauses.push({
      sql: `sector IN (${list.map(() => '?').join(', ')})`,
      params: list,
      plan: { column: 'sector', operator: 'IN', value: list.join(', '), source: 'sector reference' },
      project: ['sector'],
    });
  }
  if (excludedSectors.size > 0) {
    const list = [...excludedSectors];
    clauses.push({
      sql: `sector NOT IN (${list.map(() => '?').join(', ')})`,
      params: list,
      plan: { column: 'sector', operator: 'NOT IN', value: list.join(', '), source: 'negated sector reference' },
      project: ['sector'],
    });
    notes.push(`Read "${sectorCue ?? 'not'}" as excluding ${list.join(', ')} rather than selecting it.`);
  }

  // ── Phase 1b: capitalisation buckets ─────────────────────────────────────
  for (const bucket of CAP_BUCKETS) {
    const phrase = bucket.phrases.find((candidate) => lower.includes(candidate));
    if (phrase === undefined) continue;
    const at = lower.indexOf(phrase);
    if (!claim(at, at + phrase.length)) continue;

    const bounds: string[] = [];
    const params: number[] = [];
    if (bucket.min !== null) {
      bounds.push('market_cap >= ?');
      params.push(bucket.min);
    }
    if (bucket.max !== null) {
      bounds.push('market_cap < ?');
      params.push(bucket.max);
    }
    const cue = negationCueFor(lower, at);
    clauses.push({
      sql:
        cue === null
          ? bounds.length === 1
            ? (bounds[0] as string)
            : `(${bounds.join(' AND ')})`
          : negatePredicate('market_cap', bounds),
      params,
      plan: {
        column: 'market_cap',
        operator: cue === null ? 'in band' : 'outside band',
        value: bucket.label,
        source: cue === null ? phrase : `${cue} ${phrase}`,
      },
      project: ['market_cap'],
    });
    const bandText = `${bucket.min === null ? 'below' : `from $${(bucket.min / 1e9).toFixed(bucket.min < 1e9 ? 1 : 0)}B`}${bucket.min !== null && bucket.max !== null ? ' to ' : ''}${bucket.max === null ? ' and above' : `$${(bucket.max / 1e9).toFixed(bucket.max < 1e9 ? 1 : 0)}B`}`;
    notes.push(
      cue === null
        ? `Interpreted "${phrase}" as market capitalisation ${bandText}.`
        : `Interpreted "${cue} ${phrase}" as market capitalisation outside the ${bucket.label} band (${bandText}).`,
    );
    break;
  }

  // ── Phase 1c: direction, regime, optionable ──────────────────────────────
  for (const entry of DIRECTION_WORDS) {
    const phrase = entry.phrases.find((candidate) => lower.includes(candidate));
    if (phrase === undefined) continue;
    const at = lower.indexOf(phrase);

    /**
     * "bullish" is both a signal direction and a band name on half a dozen
     * features. Standing alone it means the signal ("show me bullish names"); next
     * to a feature it means that feature's band ("bullish MACD histogram"). The
     * disambiguator is proximity, and when a feature is adjacent this phase yields
     * so the band phase can bind it.
     */
    if (GENERIC_BAND_WORDS.has(phrase) && featureNear(lower, at, phrase.length)) continue;

    if (!claim(at, at + phrase.length)) continue;
    const cue = negationCueFor(lower, at);
    clauses.push({
      sql: cue === null ? 'direction = ?' : negatePredicate('direction', ['direction = ?']),
      params: [entry.value],
      plan: {
        column: 'direction',
        operator: cue === null ? '=' : '!=',
        value: entry.value,
        source: cue === null ? phrase : `${cue} ${phrase}`,
      },
      project: ['direction'],
    });
    if (cue !== null) {
      notes.push(`Read "${cue} ${phrase}" as any signal direction other than ${entry.value}, including symbols carrying no signal.`);
    }
    break;
  }

  for (const entry of REGIME_WORDS) {
    const phrase = entry.phrases.find((candidate) => lower.includes(candidate));
    if (phrase === undefined) continue;
    const at = lower.indexOf(phrase);
    if (!claim(at, at + phrase.length)) continue;
    const cue = negationCueFor(lower, at);
    clauses.push({
      sql: cue === null ? 'regime = ?' : negatePredicate('regime', ['regime = ?']),
      params: [entry.value],
      plan: {
        column: 'regime',
        operator: cue === null ? '=' : '!=',
        value: entry.value,
        source: cue === null ? phrase : `${cue} ${phrase}`,
      },
      project: ['regime'],
    });
    if (cue !== null) {
      notes.push(`Read "${cue} ${phrase}" as any regime other than ${entry.value}, including symbols with no classified regime.`);
    }
    break;
  }

  /**
   * `optionable` is a boolean and NOT NULL, so its negation is the other value
   * rather than a NOT wrapper — `optionable = 0` reads plainly in the published
   * statement and partitions the universe exactly.
   */
  const optionable = /\boptionable\b|\bwith options\b|\blisted options\b/.exec(lower);
  if (optionable !== null) {
    const cue = negationCueFor(lower, optionable.index);
    clauses.push({
      sql: cue === null ? 'optionable = 1' : 'optionable = 0',
      params: [],
      plan: {
        column: 'optionable',
        operator: '=',
        value: cue === null ? 'true' : 'false',
        source: cue === null ? optionable[0] : `${cue} ${optionable[0]}`,
      },
      project: ['optionable'],
    });
    if (cue !== null) notes.push(`Read "${cue} ${optionable[0]}" as excluding symbols that have listed options.`);
  }

  // ── Phase 1d: explicit symbols ───────────────────────────────────────────
  /**
   * Validated against the universe, not against a shape.
   *
   * An earlier version accepted any 2–5 letter upper-case token, which turned
   * "RSI", "ATR" and "OU" into tickers and produced `symbol IN ('RSI','ATR')` — a
   * filter matching nothing, appended to an otherwise correct query, so the
   * question returned zero rows for no visible reason. Only symbols the platform
   * actually trades are accepted.
   */
  const tickers = [
    ...new Set(
      [...original.matchAll(/\b[A-Z]{1,5}\b/g)]
        .map((match) => match[0])
        .filter((candidate) => getSpec(candidate) !== undefined),
    ),
  ];
  if (tickers.length > 0 && tickers.length <= 24) {
    // A question can name symbols on both sides of a negation ("AAPL and MSFT but
    // not NVDA"), so the tickers are partitioned rather than negated wholesale.
    const included: string[] = [];
    const excluded: string[] = [];
    let tickerCue: string | null = null;
    for (const ticker of tickers) {
      const at = original.indexOf(ticker);
      if (at >= 0) claim(at, at + ticker.length);
      const cue = at < 0 ? null : negationCueFor(lower, at);
      if (cue === null) {
        included.push(ticker);
      } else {
        excluded.push(ticker);
        tickerCue = cue;
      }
    }
    if (included.length > 0) {
      clauses.push({
        sql: `symbol IN (${included.map(() => '?').join(', ')})`,
        params: included,
        plan: { column: 'symbol', operator: 'IN', value: included.join(', '), source: 'explicit tickers' },
        project: ['symbol'],
      });
    }
    if (excluded.length > 0) {
      clauses.push({
        sql: `symbol NOT IN (${excluded.map(() => '?').join(', ')})`,
        params: excluded,
        plan: { column: 'symbol', operator: 'NOT IN', value: excluded.join(', '), source: 'excluded tickers' },
        project: ['symbol'],
      });
      notes.push(`Read "${tickerCue ?? 'not'}" as excluding ${excluded.join(', ')} rather than selecting ${excluded.length === 1 ? 'it' : 'them'}.`);
    }
  }

  // ── Phase 2: numeric comparisons ─────────────────────────────────────────
  /**
   * Scanned as `<subject> <comparator> <quantity>`, with the subject window capped
   * at 60 characters — long enough to hold "the 25 delta risk reversal".
   *
   * Only the *resolved* part of the subject is claimed, not the whole window. The
   * window has to be wide to tolerate intervening words, but claiming all of it
   * would consume whatever preceded the feature name, which is exactly how the
   * earlier version deleted the sector and regime filters sitting in front of a
   * numeric constraint.
   */
  const comparatorAlternatives = COMPARATORS.flatMap((entry) => entry.phrases)
    .map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const comparisonPattern = new RegExp(
    `([\\w\\s%$.()\\-]{0,60}?)\\s*(?:\\bis\\s+)?(${comparatorAlternatives})\\s*(-?\\$?\\d[\\d,]*(?:\\.\\d+)?\\s*(?:%|percent|bn|billion|b|mm|million|m|k|thousand|t|trillion|x)?)`,
    'gi',
  );

  for (const match of original.matchAll(comparisonPattern)) {
    const [whole, subject, comparatorText, quantityText] = match;
    const start = match.index ?? 0;
    if (whole === undefined || subject === undefined || comparatorText === undefined || quantityText === undefined) {
      continue;
    }

    const resolved = resolveColumn(subject);
    const value = parseQuantity(quantityText.replace(/\$/g, ''));
    if (resolved === null || value === null) continue;

    const comparator = COMPARATORS.find((entry) => entry.phrases.includes(comparatorText.toLowerCase().trim()));
    if (comparator === undefined) continue;

    // Claim from where the resolved reference actually begins.
    const subjectAt = resolved.matchedPhrase === null ? subject.length : subject.toLowerCase().indexOf(resolved.matchedPhrase);
    const claimStart = start + Math.max(0, subjectAt);
    if (!claim(claimStart, start + whole.length)) continue;

    /**
     * A comparator can be negated by a word standing outside it.
     *
     * The table above spells out "not below" and "not above" as comparators in
     * their own right, which covers those two phrasings and leaves every other
     * one inverted: "conviction not greater than 60" compiled to
     * `conviction > 60`. The scanner already knows where the comparator starts,
     * so the same scope test the categorical phases use answers this too, and the
     * operator flips rather than the question.
     */
    const comparatorAt = lower.indexOf(comparatorText.toLowerCase(), start + subject.length);
    const negationCue = comparatorAt < 0 ? null : negationCueFor(lower, comparatorAt);
    const operator = negationCue === null ? comparator.op : (NEGATED_COMPARATOR[comparator.op] ?? comparator.op);

    // `market_cap` in the view is dollars, and a user writing "market cap above
    // 10" almost certainly means billions rather than ten dollars.
    let effective = value;
    if (resolved.column === 'market_cap' && Math.abs(value) < 10_000) {
      effective = value * 1e9;
      notes.push(`Interpreted "market cap ${comparatorText} ${quantityText.trim()}" as ${comparatorText} $${value}B.`);
    }

    /**
     * The quoted span is the claim, not the regex match.
     *
     * `whole` starts wherever the 60-character subject window happened to begin,
     * which is not a word boundary and frequently not even a word: on the
     * platform's own example chip, "Which optionable large cap names have a 25
     * delta risk reversal below -2?", the window cannot reach index 0 and the
     * match starts at index 2, so the query inspector rendered the filter's
     * provenance as ← "ich optionable large cap names have a 25 delta risk
     * reversal below -2". `claimStart` is already the start of the phrase that
     * resolved to this column, and it is what the reader is being shown evidence
     * for, so the span is quoted from there.
     */
    if (negationCue !== null) {
      notes.push(
        `Read "${negationCue} ${comparatorText.trim()}" as ${operator}, so the filter is ${resolved.column} ${operator} ${effective}.`,
      );
    }

    clauses.push({
      sql: `${resolved.column} ${operator} ?`,
      params: [effective],
      plan: {
        column: resolved.column,
        operator,
        value: String(effective),
        source: original.slice(claimStart, start + whole.length).trim(),
      },
      project: [resolved.column],
    });
  }

  // ── Phase 3: qualitative state predicates ────────────────────────────────
  /**
   * A feature's `states` array is a published discretisation with numeric bounds,
   * so "oversold" has an exact meaning: the band whose state name contains
   * OVERSOLD. Emitting the band's bounds rather than a hand-picked threshold means
   * the SQL agrees with the state label the terminal renders for the same row — if
   * they disagreed, a screener hit would contradict its own detail page.
   */
  for (const definition of FEATURE_DEFINITIONS) {
    for (const band of definition.states) {
      const words = band.state
        .replace(/^STATE_/, '')
        .toLowerCase()
        .split('_')
        .filter((word) => word.length >= 4);
      if (words.length === 0) continue;
      const phrase = words.join(' ');
      const at = lower.indexOf(phrase);
      if (at < 0) continue;

      // A single generic intensity word only binds when its feature is adjacent.
      if (words.length === 1 && GENERIC_BAND_WORDS.has(phrase) && !definitionNear(lower, at, phrase.length, definition)) {
        continue;
      }
      if (!claim(at, at + phrase.length)) continue;

      const bounds: string[] = [];
      const params: (string | number)[] = [];
      if (Number.isFinite(band.min)) {
        bounds.push(`${definition.sqlColumn} >= ?`);
        params.push(band.min);
      }
      if (Number.isFinite(band.max)) {
        bounds.push(`${definition.sqlColumn} < ?`);
        params.push(band.max);
      }
      if (bounds.length === 0) continue;

      const cue = negationCueFor(lower, at);
      clauses.push({
        sql:
          cue === null
            ? bounds.length === 1
              ? (bounds[0] as string)
              : `(${bounds.join(' AND ')})`
            : negatePredicate(definition.sqlColumn, bounds),
        params,
        plan: {
          column: definition.sqlColumn,
          operator: cue === null ? 'in band' : 'outside band',
          value: band.state,
          source: cue === null ? phrase : `${cue} ${phrase}`,
        },
        project: [definition.sqlColumn],
      });
      const bandText = `${Number.isFinite(band.min) ? band.min : '−∞'} to ${Number.isFinite(band.max) ? band.max : '∞'}`;
      notes.push(
        cue === null
          ? `Read "${phrase}" as ${definition.label} in its published ${band.state} band (${bandText}).`
          : `Read "${cue} ${phrase}" as ${definition.label} outside its published ${band.state} band (${bandText}), including symbols with no value for it.`,
      );
    }
  }

  // ── Ordering ─────────────────────────────────────────────────────────────
  let orderBy: QueryPlan['orderBy'] = null;

  const sortedBy = /\b(?:sorted|ordered|rank(?:ed)?)\s+by\s+([\w\s%().-]{3,40})/i.exec(original);
  if (sortedBy !== null) {
    const resolved = resolveColumn(sortedBy[1] ?? '');
    if (resolved !== null) {
      const ascending = /\bascending\b|\basc\b/i.test(original);
      orderBy = { column: resolved.column, direction: ascending ? 'ASC' : 'DESC' };
    }
  }

  if (orderBy === null) {
    for (const word of [...SUPERLATIVE_DESC, ...SUPERLATIVE_ASC]) {
      const pattern = new RegExp(`\\b${word}\\b\\s*(?:\\d+\\s+)?([\\w\\s%().-]{0,40})`, 'i');
      const match = pattern.exec(original);
      if (match === null) continue;
      const resolved = resolveColumn(match[1] ?? '');
      if (resolved === null) continue;
      orderBy = {
        column: resolved.column,
        // "most oversold" means the *lowest* RSI: a superlative on a bearish-low
        // feature inverts. The polarity comes from the feature's own state bands,
        // so this is read from the registry rather than guessed per column.
        direction: SUPERLATIVE_DESC.includes(word.toLowerCase())
          ? inversePolarity(resolved, match[1] ?? '')
            ? 'ASC'
            : 'DESC'
          : inversePolarity(resolved, match[1] ?? '')
            ? 'DESC'
            : 'ASC',
      };
      break;
    }
  }

  if (orderBy === null) {
    // Conviction descending is the platform's published default ordering, and the
    // one the screener and the Top 5 both use.
    orderBy = { column: 'conviction', direction: 'DESC' };
    if (!isCount) notes.push('No ordering was specified, so results are ranked by conviction, highest first.');
  }

  // ── Limit ────────────────────────────────────────────────────────────────
  let limit = DEFAULT_LIMIT;
  const limitMatch = /\b(?:top|first|bottom|last|show me|give me|list)\s+(\d{1,3})\b|\b(\d{1,3})\s+(?:most|highest|lowest|largest|smallest|best|worst|names|stocks|symbols|tickers)\b/i.exec(
    original,
  );
  if (limitMatch !== null) {
    const parsed = Number(limitMatch[1] ?? limitMatch[2]);
    if (Number.isInteger(parsed) && parsed > 0) limit = Math.min(parsed, MAX_LIMIT);
  }

  // ── Unparsed clauses ─────────────────────────────────────────────────────
  /**
   * Anything left over that looks like a constraint is reported. A user who asks
   * for something the compiler cannot express deserves to be told, not handed a
   * result that quietly ignored half the question.
   */
  // A question with no constraints is not a parse failure — "top 10 by conviction"
  // is fully understood and has no WHERE clause. It belongs in `notes`, which
  // reports interpretations, rather than in `unparsed`, which reports text the
  // compiler could not read.
  if (clauses.length === 0 && !isCount) {
    notes.push('The question carries no filter, so the query ranks the whole tradable universe.');
  }
  for (const fragment of original.split(/\s+(?:and|with|where|that|which)\s+/i)) {
    const trimmed = fragment.trim();
    if (trimmed.length < 8) continue;
    const start = original.indexOf(trimmed);
    const covered = consumed.some((span) => start < span.end && start + trimmed.length > span.start);
    if (covered) continue;
    /*
     * A fragment that names a known column and still produced no clause is the
     * case that most needs reporting, not the case to skip.
     *
     * `resolveColumn(trimmed) !== null → continue` did the opposite, and combined
     * with a constraint pattern that only recognised comparisons it made the
     * platform's own example chip — "Which symbols have relative volume above 2
     * and a positive MLOFI intent?" — compile to SQL carrying the volume filter
     * alone, with nothing anywhere saying the second half had been dropped. A
     * query that silently answers a different question than the one asked is
     * worse than one that refuses.
     */
    // Only report fragments that read like constraints, not the question's framing.
    if (!CONSTRAINT_LIKE.test(trimmed)) continue;
    unparsed.push(trimmed);
  }

  // ── Emit ─────────────────────────────────────────────────────────────────
  const projection = isCount
    ? ['COUNT(*) AS matches']
    : [...new Set([...BASE_PROJECTION, ...clauses.flatMap((clause) => clause.project), orderBy.column])];

  // The benchmark ETF is published for reference and is not part of the tradable
  // set, so it is excluded from every screen unless named explicitly.
  const where = ['is_benchmark = 0', ...clauses.map((clause) => clause.sql)];
  const params = clauses.flatMap((clause) => clause.params);

  const sql = isCount
    ? `SELECT COUNT(*) AS matches\nFROM ${SNAPSHOT_TABLE}\nWHERE ${where.join('\n  AND ')}`
    : [
        `SELECT ${projection.join(', ')}`,
        `FROM ${SNAPSHOT_TABLE}`,
        `WHERE ${where.join('\n  AND ')}`,
        // NULLS LAST by hand: SQLite sorts NULL first on DESC, which would put
        // symbols with no signal at the top of a conviction ranking.
        `ORDER BY ${orderBy.column} IS NULL, ${orderBy.column} ${orderBy.direction}, symbol ASC`,
        `LIMIT ${limit}`,
      ].join('\n');

  return {
    sql,
    params,
    columns: isCount ? ['matches'] : projection,
    notes,
    unparsed,
    explanation: explain(isCount, clauses, orderBy, limit),
    plan: {
      intent: isCount ? 'count' : 'list',
      filters: clauses.map((clause) => clause.plan),
      orderBy,
      limit,
      aggregate: isCount ? { function: 'COUNT', column: '*' } : null,
    },
  };
}

/**
 * Whether a superlative on this column should sort ascending.
 *
 * "Most oversold" wants the lowest RSI; "most overbought" wants the highest. The
 * answer is in the feature's own state bands: if the phrase names a band and that
 * band sits at the bottom of the range, the superlative inverts. Falling back to
 * the phrase's own polarity words covers columns without bands.
 */
function inversePolarity(resolved: Resolved, phrase: string): boolean {
  const lower = phrase.toLowerCase();
  if (resolved.definition !== null) {
    for (const band of resolved.definition.states) {
      const name = band.state.replace(/^STATE_/, '').toLowerCase().replace(/_/g, ' ');
      if (!lower.includes(name)) continue;
      const bands = resolved.definition.states;
      const midpoint = (bands.length - 1) / 2;
      return bands.indexOf(band) < midpoint;
    }
  }
  return /\boversold\b|\bcheap\b|\bdiscount\b|\bcompressed\b|\bnegative\b/.test(lower);
}

function explain(
  isCount: boolean,
  clauses: readonly Clause[],
  orderBy: QueryPlan['orderBy'],
  limit: number,
): string {
  const parts: string[] = [];
  parts.push(
    isCount
      ? `Counts symbols in the latest cross-sectional snapshot`
      : `Selects up to ${limit} symbol${limit === 1 ? '' : 's'} from the latest cross-sectional snapshot`,
  );

  if (clauses.length === 0) parts.push('with no filter applied');
  else {
    parts.push(
      `where ${clauses
        .map((clause) => `${clause.plan.column} ${clause.plan.operator} ${clause.plan.value}`)
        .join(', and ')}`,
    );
  }

  if (!isCount && orderBy !== null) {
    parts.push(`ordered by ${orderBy.column} ${orderBy.direction === 'DESC' ? 'descending' : 'ascending'}`);
  }
  parts.push('excluding the benchmark ETF');

  return `${parts.join(', ')}.`;
}

/** Sectors the compiler recognises, for the query builder's help text. */
export const RECOGNISED_SECTORS: readonly Sector[] = SECTORS;
