/**
 * The Human-Translation Engine.
 *
 * This is a **deterministic algorithmic mapping layer, not a Large Language
 * Model**. The research is explicit about why, and it is quoted here because it
 * is a compliance constraint rather than a preference:
 *
 *   "Unlike Large Language Models (LLMs), which introduce non-determinism,
 *    hallucination risks, and latency, this engine utilizes a rigorous
 *    algorithmic matrix to guarantee consistent, compliant, and instantaneous
 *    translations."
 *
 * Four stages, in order:
 *   1. Magnitude & Direction Normalisation — |φᵢ| / Σ|φ| → contribution_percentage,
 *      sign(φᵢ) → impact_direction. Both computed server-side so the client does
 *      zero arithmetic.
 *   2. Feature State Discretisation — the *raw model input* (never the SHAP
 *      output) is bucketed into a state label (RSI 28 → STATE_OVERSOLD; an ATR
 *      one standard deviation below its historical mean → STATE_COMPRESSED).
 *   3. Lexical Matrix Query — a tripartite key (featureKey, impactDirection,
 *      featureState) into the Institutional Mapping Matrix.
 *   4. Template Hydration — {pct} as an integer percent, {val} to one decimal.
 *
 * The six template strings in INSTITUTIONAL_MAPPING_MATRIX are reproduced
 * verbatim from the research. Every other feature falls through to a generic
 * composer that assembles the same grammatical shape from the feature registry's
 * own predicate/implication pair, so the tone stays "objective, analytical,
 * authoritative, and completely devoid of colloquialisms" across the whole
 * feature registry.
 *
 * That last clause used to write the registry's size out as a literal, as did
 * three other comments in the engine, and the registry had long since outgrown
 * the number — one of those files even contradicted its own header eighty-eight
 * lines further down, quoting two different widths for the same vector. A count
 * written into prose is a number with no test on it, so none of these sentences
 * names one any more: `MODEL_FEATURE_COUNT` is exported from the registry and is
 * the only place it is allowed to live.
 */

import {
  type FeatureDefinition,
  type FeatureState,
  featureDefinition,
  formatFeatureValue,
  resolveState,
} from './features';
import type { FeatureGroup, SignalDriver } from '@/lib/domain/types';
import type { ShapExplanation } from '@/lib/quant/shap';
import { rankContributions } from '@/lib/quant/shap';
import { clamp } from '@/lib/quant/stats';

export type ImpactDirection = 'positive' | 'negative';

/** The three domain tabs the XAI view exposes. */
export type XaiDomain = 'technical' | 'fundamental' | 'sentiment';

/**
 * Feature group → XAI domain. The research payload has exactly three domain
 * arrays; the registry has ten groups, so the mapping is fixed here once.
 */
export const GROUP_TO_DOMAIN: Record<FeatureGroup, XaiDomain> = {
  momentum: 'technical',
  trend: 'technical',
  volatility: 'technical',
  meanreversion: 'technical',
  microstructure: 'technical',
  volume: 'technical',
  regime: 'technical',
  skew: 'fundamental',
  relative: 'fundamental',
  altdata: 'sentiment',
};

/**
 * Features whose alt-data nature is structural rather than sentimental belong on
 * the Fundamental tab even though they live in the `altdata` group.
 */
const FUNDAMENTAL_ALTDATA = new Set([
  'insider_form4_score',
  'inst_13f_score',
  'analyst_revision_score',
  'short_interest_score',
  'structural_alt_score',
  'alt_evidence',
]);

export function domainForFeature(key: string, group: FeatureGroup): XaiDomain {
  if (group === 'altdata' && FUNDAMENTAL_ALTDATA.has(key)) return 'fundamental';
  return GROUP_TO_DOMAIN[group];
}

export interface MatrixEntry {
  /** Template with {pct} and {val} placeholders. */
  template: string;
  /** Stable key the client may use for i18n or styling. */
  semanticKey: string;
}

/**
 * The Institutional Mapping Matrix.
 *
 * Keyed `featureKey|impactDirection|featureState`. The six entries carrying
 * research-verbatim copy are marked; the rest of the registry surface is
 * handled by `composeGenericNarrative`.
 */
export const INSTITUTIONAL_MAPPING_MATRIX: Record<string, MatrixEntry> = {
  // ── Verbatim from the XAI research ──────────────────────────────────────
  'rsi_14|positive|STATE_OVERSOLD': {
    template:
      '{pct}% of this bullish conviction is driven by an exhaustion of sell-side pressure (RSI at {val}), indicating a high-probability mean reversion.',
    semanticKey: 'oversold_institutional_accumulation',
  },
  'rsi_14|positive|STATE_DEEPLY_OVERSOLD': {
    template:
      '{pct}% of this bullish conviction is driven by an exhaustion of sell-side pressure (RSI at {val}), indicating a high-probability mean reversion.',
    semanticKey: 'oversold_institutional_accumulation',
  },
  'rsi_14|negative|STATE_OVERBOUGHT': {
    template:
      'Technical overextension (RSI at {val}) acts as {art} {pct}% headwind against further upside momentum.',
    semanticKey: 'overbought_technical_headwind',
  },
  'rsi_14|negative|STATE_DEEPLY_OVERBOUGHT': {
    template:
      'Technical overextension (RSI at {val}) acts as {art} {pct}% headwind against further upside momentum.',
    semanticKey: 'overbought_technical_headwind',
  },
  'inst_13f_score|positive|STATE_ACCUMULATION': {
    template:
      'Sustained institutional accumulation over the trailing 48 hours constitutes {pct}% of the current conviction score.',
    semanticKey: 'sustained_institutional_inflow',
  },
  'insider_form4_score|positive|STATE_INSIDER_BUYING': {
    template:
      'Sustained institutional accumulation over the trailing 48 hours constitutes {pct}% of the current conviction score.',
    semanticKey: 'sustained_institutional_inflow',
  },
  'atr_pct_14|positive|STATE_VERY_QUIET': {
    template:
      'Severe volatility compression (ATR at {val}) contributes {pct}% to the breakout probability, suggesting an imminent directional expansion.',
    semanticKey: 'volatility_compression_breakout',
  },
  'atr_pct_14|negative|STATE_EXTREME': {
    template:
      "Elevated market volatility (ATR at {val}) introduces a {pct}% penalty to the signal's risk-adjusted reliability.",
    semanticKey: 'elevated_volatility_penalty',
  },
  'atr_pct_14|negative|STATE_ELEVATED': {
    template:
      "Elevated market volatility (ATR at {val}) introduces a {pct}% penalty to the signal's risk-adjusted reliability.",
    semanticKey: 'elevated_volatility_penalty',
  },
  'news_sentiment|negative|STATE_NEGATIVE_COVERAGE': {
    template:
      "Deteriorating macroeconomic sentiment across tier-1 news outlets introduces a {pct}% structural drag on the asset's near-term outlook.",
    semanticKey: 'macro_sentiment_drag',
  },
  'alt_composite|negative|STATE_STRONGLY_NEGATIVE': {
    template:
      "Deteriorating macroeconomic sentiment across tier-1 news outlets introduces a {pct}% structural drag on the asset's near-term outlook.",
    semanticKey: 'macro_sentiment_drag',
  },
};

/** Hydrates {pct} as an integer percent and {val} to one decimal place. */
export function hydrateTemplate(template: string, pct: number, val: number): string {
  return template
    .replace(/\{pct\}/g, String(Math.round(pct)))
    .replace(/\{val\}/g, val.toFixed(1))
    // `{art}` is the indefinite article for the percentage that follows it, so a
    // verbatim row can read "acts as an 8% headwind" without forking the template.
    .replace(/\{art\}/g, indefiniteArticle(pct));
}

/**
 * "a 3% headwind" but "an 8% headwind".
 *
 * English takes the article from the *sound* of what follows, and a percentage is
 * read aloud as its digits, so 8, 11, 18 and the eighties all begin with a vowel
 * sound. The templates hard-coded "a", which shipped "acts as a 8% headwind" and
 * "acts as a 18% headwind" to the attribution table.
 */
export function indefiniteArticle(pct: number): string {
  const n = Math.abs(Math.round(pct));
  if (n === 8 || n === 11 || n === 18) return 'an';
  if (n >= 80 && n <= 89) return 'an';
  return 'a';
}

/**
 * True when the model's attribution and the registry's own reading of a feature
 * state point opposite ways.
 *
 * Two independent lines of evidence describe one driver. The SHAP value says
 * which way this input moved the model's probability. `FeatureState.polarity`
 * says which way that state normally leans, authored per band in the registry
 * beside the predicate and the implication every sentence here is assembled
 * from. They usually agree. When they do not, no sentence that takes its frame
 * from one and its words from the other is true, and the composers below say so
 * instead of picking a side.
 *
 * A neutral band leans neither way and therefore cannot be contested.
 */
export function attributionContestsState(state: FeatureState, pushesProbabilityUp: boolean): boolean {
  if (state.polarity === 'neutral') return false;
  return state.polarity !== (pushesProbabilityUp ? 'bullish' : 'bearish');
}

/** Inserted before the implication wherever the two lines of evidence disagree. */
const CONTESTED_CLAUSE = 'against the way that state normally leans';

/**
 * Generic composer for features without a verbatim matrix row.
 *
 * Shape for a supporting driver:
 *   "{pct}% of this {bullish|bearish} conviction is driven by {predicate}
 *    ({label} at {value}), {implication}."
 *
 * Shape for an opposing driver:
 *   "{predicate} ({label} at {value}) acts as a {pct}% headwind, {implication}."
 *
 * Either shape gains `CONTESTED_CLAUSE` when `attributionContestsState` holds.
 * Without it the two halves of the sentence argued against each other: the frame
 * comes from the SHAP sign and the predicate and implication come from the
 * registry, so wherever those disagreed the engine published, in one breath,
 * "3% of this bullish conviction is driven by a primary downtrend (EMA 50/200
 * spread at −31.05%), a regime in which long setups have materially lower base
 * rates" on BA, and the mirror image on MSFT's short, which credited net
 * institutional *accumulation* with driving a bearish conviction. Measured over
 * one published sweep: 107 of 374 polarised driver sentences, on 49 of the 54
 * directional names, and 33 of 65 on the flat ones.
 *
 * The disagreement belongs to the model rather than to the prose — the tree
 * ensemble is fitted, not authored, and it is allowed to weight an input against
 * its usual sign — so it is named and both readings are kept, which is the same
 * posture the counter-thesis takes towards the thesis.
 *
 * `supports` is signal-relative and must be computed by the caller, because a
 * raw SHAP sign does not answer the question on its own. This took `direction`
 * and read `positive` as supporting, which is right for a long signal and
 * exactly backwards for a short: a driver pushing the modelled probability *down*
 * is what a short thesis rests on. `composeThesis` and `composeCounterThesis`
 * have always used the signal-relative convention, so on every short signal the
 * two disagreed and the page contradicted itself in consecutive sentences —
 *
 *   "The strongest opposing driver is net institutional distribution …
 *    subtracting 7% of total attribution. 7% of this bearish conviction is
 *    driven by net institutional distribution …"
 *
 * — the same driver, named as both the leading argument against the thesis and
 * the thing driving it. Roughly half the published universe is short.
 */
export function composeGenericNarrative(
  definition: FeatureDefinition,
  state: FeatureState,
  value: number,
  contributionPercent: number,
  supports: boolean,
  signalDirection: 'long' | 'short' | 'flat',
): string {
  const pct = Math.round(contributionPercent);
  const formatted = formatFeatureValue(definition, value);
  /*
   * `supports` is signal-relative and inverts the raw SHAP sign on a short, so
   * the raw sign is recovered here rather than passed in: the two are exact
   * inverses of one another under the convention documented above, and a second
   * parameter carrying the same bit is a second thing a caller can get wrong.
   */
  const pushesProbabilityUp = signalDirection === 'short' ? !supports : supports;
  const contested = attributionContestsState(state, pushesProbabilityUp);
  // ", implication." normally; " — implication." when the clause intervenes.
  const tail = contested ? `, ${CONTESTED_CLAUSE} — ${state.implication}.` : `, ${state.implication}.`;

  /*
   * A flat signal has no stance to attribute anything to.
   *
   * Both shapes below name one — "this bullish conviction", "a headwind" — and a
   * flat signal is published with the thesis "the model holds no directional
   * conviction; aggregate driver contributions offset to within the noise
   * floor". Printing "46% of this bullish conviction is driven by …" underneath
   * that contradicts it in the same panel, and roughly a third of the universe
   * publishes flat on any given day.
   *
   * So a flat signal describes the direction each driver pushed the model,
   * which is true regardless of where the aggregate landed, and claims nothing
   * about a conviction that does not exist.
   */
  if (signalDirection === 'flat') {
    const opening = `${state.predicate} (${definition.label} at ${formatted})`;
    const capitalised = `${opening.charAt(0).toUpperCase()}${opening.slice(1)}`;
    return supports
      ? `${capitalised} pushes the model's probability up by ${pct}% of total attribution${tail}`
      : `${capitalised} pushes it down by ${pct}% of total attribution${tail}`;
  }

  const stance = signalDirection === 'long' ? 'bullish' : 'bearish';

  if (supports) {
    return `${pct}% of this ${stance} conviction is driven by ${state.predicate} (${definition.label} at ${formatted})${tail}`;
  }
  /*
   * Capitalise the sentence, not the article.
   *
   * The old rule uppercased `^an? ` — which handles "a dislocation above fair
   * value" and does nothing at all for the 130-odd predicates that begin with an
   * adjective. "bearish retail chatter (Social sentiment at -1.000) acts as a 3%
   * headwind…" shipped to the attribution table with a lowercase first letter,
   * beside eleven sentences that were capitalised correctly.
   */
  const opening = `${state.predicate} (${definition.label} at ${formatted})`;
  return `${opening.charAt(0).toUpperCase()}${opening.slice(1)} acts as ${indefiniteArticle(pct)} ${pct}% headwind${tail}`;
}

export interface TranslatedDriver extends SignalDriver {
  domain: XaiDomain;
  /**
   * Whether this driver argues for the direction that was published.
   *
   * Distinct from `direction`, which is the raw SHAP sign. On a short signal a
   * driver with a negative SHAP value is a *supporting* one. On a flat signal
   * there is no published direction to support, so this degenerates to the raw
   * sign — the flat copy reads it as "pushed the probability up".
   */
  supports: boolean;
  /**
   * What this feature's state means, as a clause. Carried separately from
   * `narrative` so a composer can use the reasoning without re-stating the
   * driver's name and value alongside it.
   */
  implication: string;
  /** Stable semantic key for the client. */
  semanticKey: string;
  /** contribution_percentage, 0–100. */
  contributionPercentage: number;
  /** True when the copy came from a verbatim research template. */
  fromMatrix: boolean;
}

export interface TranslateOptions {
  /** Direction of the overall signal — decides whether "bullish" or "bearish". */
  signalDirection: 'long' | 'short' | 'flat';
  /** Cap on how many drivers are translated. */
  topK?: number;
  /** Drop drivers contributing less than this share of |Σφ|. */
  minShare?: number;
}

/**
 * Stages 1–4 for every contribution in a SHAP explanation.
 *
 * Note the direction convention: `impact_direction` is the sign of the SHAP
 * value in the model's own log-odds space (positive = pushes the probability of
 * the modelled event up). For a short signal the *supporting* drivers are the
 * ones pushing the probability down, so the stance word is chosen from the
 * signal direction while the sign is preserved for colour and ordering.
 */
export function translateExplanation(
  explanation: ShapExplanation,
  options: TranslateOptions,
): TranslatedDriver[] {
  const ranked = rankContributions(explanation, {
    topK: options.topK ?? 12,
    minShare: options.minShare ?? 0.002,
  });
  /*
   * Kept as the three-valued direction, not collapsed to long/short.
   *
   * Collapsing 'flat' to 'long' made every flat signal's driver sentences claim
   * a bullish conviction the page had just said did not exist.
   */
  const signalDirection = options.signalDirection;

  return ranked.map((c) => {
    const definition = featureDefinition(c.feature);
    /*
     * `direction` is the raw sign of the SHAP value in the model's own log-odds
     * space, and stays raw — it is published as `impact_direction` and is a
     * statement about the model, not about the trade.
     *
     * `supports` is the different question the prose needs: does this driver
     * argue *for* the direction that was actually published? For a long signal
     * the two coincide; for a short they are opposites.
     */
    const direction: ImpactDirection = c.shap >= 0 ? 'positive' : 'negative';
    const supports = signalDirection === 'short' ? c.shap < 0 : c.shap >= 0;
    const contributionPercentage = clamp(c.share * 100, 0, 100);

    if (!definition) {
      return {
        featureKey: c.feature,
        label: c.feature,
        group: 'regime' as FeatureGroup,
        value: c.value,
        shap: c.shap,
        share: c.share,
        direction,
        state: 'STATE_UNKNOWN',
        narrative: `${Math.round(contributionPercentage)}% of the model output is attributed to ${c.feature}.`,
        domain: 'technical' as XaiDomain,
        semanticKey: 'unmapped_feature',
        contributionPercentage,
        fromMatrix: false,
        supports,
        implication: 'no registry definition is available for this input.',
      };
    }

    // Stage 2: discretise the raw model input, never the SHAP output.
    const state = resolveState(definition, c.value);
    // Stage 3: tripartite lexical matrix query.
    const matrixKey = `${definition.key}|${direction}|${state.state}`;
    const entry = INSTITUTIONAL_MAPPING_MATRIX[matrixKey];

    /*
     * Stage 4: template hydration — but only for a driver that supports the
     * published direction.
     *
     * The matrix is keyed on the *SHAP* direction, and its templates state a
     * stance outright: the `rsi_14|positive|STATE_OVERSOLD` row reads "…% of this
     * bullish conviction is driven by an exhaustion of sell-side pressure". That
     * is exactly right for the driver it was written for, and on a short signal
     * it lands under a headline reading "bearish", asserting the opposite of the
     * page it is printed on — and `composeCounterThesis` appends this very
     * sentence after naming the driver as the strongest argument *against* the
     * thesis.
     *
     * An opposing driver therefore takes the generic composition, whose
     * "acts as a …% headwind" shape is signal-relative by construction. The
     * institutional phrasing is not lost: the generic composer is built from the
     * same `state.predicate` and `state.implication` the matrix row draws on, so
     * the vocabulary is identical and only the framing changes.
     *
     * A contested state falls through for the same reason. A verbatim row is one
     * fixed string and has nowhere to put the qualifying clause the generic
     * composer adds, so it would assert the stance flatly. No row in the matrix
     * is contested today — each is keyed on the SHAP direction its own state
     * leans — but the matrix is copy, edited by hand, and this keeps a future
     * row from re-opening the defect the composer was hardened against.
     */
    const contested = attributionContestsState(state, c.shap >= 0);
    // A flat signal has no stance, and every matrix row asserts one.
    const verbatim =
      entry !== undefined && supports && !contested && signalDirection !== 'flat' ? entry : undefined;
    const narrative = verbatim
      ? hydrateTemplate(verbatim.template, contributionPercentage, c.value)
      : composeGenericNarrative(definition, state, c.value, contributionPercentage, supports, signalDirection);

    return {
      featureKey: definition.key,
      label: definition.label,
      group: definition.group,
      value: c.value,
      shap: c.shap,
      share: c.share,
      direction,
      /** Signal-relative: does this driver argue for the published direction? */
      supports,
      implication: state.implication,
      state: state.state,
      narrative,
      domain: domainForFeature(definition.key, definition.group),
      semanticKey: entry?.semanticKey ?? `${definition.key}_${state.state.toLowerCase()}`,
      contributionPercentage,
      fromMatrix: verbatim !== undefined,
    };
  });
}

/**
 * Executive thesis: the two strongest supporting drivers, joined into one
 * sentence. Framed strictly as the output of a computation — never as advice.
 */
export function composeThesis(
  symbol: string,
  drivers: readonly TranslatedDriver[],
  signalDirection: 'long' | 'short' | 'flat',
  conviction: number,
): string {
  if (signalDirection === 'flat' || drivers.length === 0) {
    return `The model holds no directional conviction on ${symbol}; aggregate driver contributions offset to within the noise floor.`;
  }
  const stance = signalDirection === 'long' ? 'bullish' : 'bearish';
  const supporting = drivers.filter((d) => (signalDirection === 'long' ? d.shap > 0 : d.shap < 0));
  const primary = supporting[0] ?? drivers[0];
  const secondary = supporting[1];

  if (!primary) {
    return `The model scores ${symbol} at ${conviction.toFixed(0)}/100 with no single dominant driver.`;
  }

  const state = describeDriver(primary);
  const base =
    `The model scores ${symbol} at ${conviction.toFixed(0)}/100 ${stance} conviction, ` +
    `led by ${state} at ${Math.round(primary.contributionPercentage)}% of total attribution`;

  if (!secondary) return `${base}.`;
  return `${base}, reinforced by ${describeDriver(secondary)} at ${Math.round(secondary.contributionPercentage)}%.`;
}

/**
 * Counter-thesis: names the strongest *opposing* driver explicitly. Presenting
 * the strongest argument against the model's own output is part of the
 * "disinterested commentary and analysis" the Publisher's Exemption requires.
 */
export function composeCounterThesis(
  drivers: readonly TranslatedDriver[],
  signalDirection: 'long' | 'short' | 'flat',
): string {
  if (signalDirection === 'flat') {
    return 'No opposing driver is material while the aggregate signal sits inside the noise floor.';
  }
  const opposing = drivers.filter((d) => (signalDirection === 'long' ? d.shap < 0 : d.shap > 0));
  const strongest = opposing[0];
  if (!strongest) {
    return 'No material driver currently opposes the model output, which is itself a concentration risk: the thesis rests on a single side of the feature set.';
  }
  /*
   * Names the driver once.
   *
   * This used to append the driver's whole narrative sentence, which restated
   * the predicate, the label, the value and the percentage that the first half
   * had just given — "…is short-horizon selling exhaustion (RSI (2) at 10.0),
   * subtracting 33% of total attribution. Short-horizon selling exhaustion (RSI
   * (2) at 10.0) acts as a 33% headwind, favouring a snap-back." Every noun in
   * that second sentence is already in the first. Only the implication was new,
   * so only the implication is carried.
   *
   * Carrying the implication carries the contest with it, and the same clause
   * `composeGenericNarrative` uses is needed for the same reason. On a short,
   * the strongest opposing driver is the one pushing the modelled probability
   * up, and where the registry reads that state as bearish the sentence named it
   * as the strongest argument *against* the thesis and then gave a reason that
   * argues for it: MSFT published "The strongest opposing driver is a primary
   * downtrend (EMA 50/200 spread at −16.42%), subtracting 3% of total
   * attribution — a regime in which long setups have materially lower base
   * rates." Nineteen of the forty-six directional counter-theses on one sweep.
   * The driver table beside it now qualifies the same pairing, so leaving this
   * one bare would put the qualification on one surface and not the other.
   */
  const state = driverState(strongest);
  const contested = state !== null && attributionContestsState(state, strongest.shap >= 0);
  return (
    `The strongest opposing driver is ${describeDriver(strongest)}, subtracting ${Math.round(
      strongest.contributionPercentage,
    )}% of total attribution` +
    (contested ? `, ${CONTESTED_CLAUSE}` : '') +
    ` — ${strongest.implication}`
  );
}

/** The registry band this driver's raw value falls in, or null for an unmapped key. */
function driverState(driver: TranslatedDriver): FeatureState | null {
  const definition = featureDefinition(driver.featureKey);
  if (!definition) return null;
  return resolveState(definition, driver.value);
}

function describeDriver(driver: TranslatedDriver): string {
  const definition = featureDefinition(driver.featureKey);
  if (!definition) return driver.label;
  const state = resolveState(definition, driver.value);
  return `${state.predicate} (${definition.label} at ${formatFeatureValue(definition, driver.value)})`;
}

/**
 * The Insufficient Data Protocol (Financial NLP RAG §Defense Layer 5).
 * When evidence is too thin to ground a thesis the engine must publish a
 * neutralised signal rather than a speculative one: score exactly 0.0, an
 * explicit low-confidence marker, and no directional claim.
 */
export const INSUFFICIENT_DATA_THESIS =
  'Insufficient grounded evidence is available to support a directional thesis. The sentiment score is neutralised to 0.0 and this signal carries a low-confidence marker; no directional claim is published.';

export function isInsufficientEvidence(altEvidence: number, driverCount: number): boolean {
  return altEvidence < 0.5 || driverCount === 0;
}

/**
 * Prohibited-copy guard.
 *
 * Phase 5 §1 bans recommendation phrasing and AI-washing claims outright. This
 * runs over every user-facing string the engine generates, in tests and at
 * runtime, so a template edit can never quietly introduce advisory language.
 */
export const PROHIBITED_PHRASES: readonly string[] = [
  'we recommend',
  'you should buy',
  'you should sell',
  'optimal choice',
  'perfectly suited for your portfolio',
  'best price',
  'guaranteed return',
  'guaranteed returns',
  'unbeatable ai',
  'risk-free machine learning',
  'risk free machine learning',
  'automatically trade',
  'trade while you are away',
  'allocate 5%',
  'we advise',
  'sure thing',
  "can't lose",
  'cannot lose',
];

export interface ProhibitedCopyFinding {
  phrase: string;
  index: number;
}

/** Returns every prohibited phrase found in `text` (case-insensitive). */
export function findProhibitedCopy(text: string): ProhibitedCopyFinding[] {
  const lower = text.toLowerCase();
  const out: ProhibitedCopyFinding[] = [];
  for (const phrase of PROHIBITED_PHRASES) {
    const index = lower.indexOf(phrase);
    if (index >= 0) out.push({ phrase, index });
  }
  return out;
}

export function assertCompliantCopy(text: string, context: string): void {
  const findings = findProhibitedCopy(text);
  if (findings.length > 0) {
    throw new Error(
      `Prohibited advisory copy in ${context}: ${findings.map((f) => `"${f.phrase}"`).join(', ')}`,
    );
  }
}

/**
 * The mandated neutral framing for the daily publication (Phase 5 §1):
 * "The algorithm's highest-scoring equities based on 30-day historical momentum
 *  parameters are X, Y, and Z."
 */
export function composePublicationNotice(symbols: readonly string[]): string {
  if (symbols.length === 0) {
    return "The algorithm produced no qualifying equities based on 30-day historical momentum parameters for this publication.";
  }
  const list =
    symbols.length === 1
      ? symbols[0]
      : `${symbols.slice(0, -1).join(', ')}, and ${symbols[symbols.length - 1]}`;
  return `The algorithm's highest-scoring equities based on 30-day historical momentum parameters are ${list}.`;
}

/** Fixed neutrality notice rendered alongside every published signal list. */
export const NEUTRALITY_NOTICE =
  'This list is an impersonal mathematical computation published on a fixed daily schedule and distributed identically to every subscriber. It is not personalised, does not consider any individual financial situation, and is not a recommendation. Every order must be entered and executed by you.';
