/**
 * The Human-Translation Engine.
 *
 * MASTER §4.2 / Phase 4 §1 / XAI research §Human-Translation Engine.
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
 * authoritative, and completely devoid of colloquialisms" across all 80 features.
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
 * research-verbatim copy are marked; the rest of the 80-feature surface is
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
      'Technical overextension (RSI at {val}) acts as a {pct}% headwind against further upside momentum.',
    semanticKey: 'overbought_technical_headwind',
  },
  'rsi_14|negative|STATE_DEEPLY_OVERBOUGHT': {
    template:
      'Technical overextension (RSI at {val}) acts as a {pct}% headwind against further upside momentum.',
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
  return template.replace(/\{pct\}/g, String(Math.round(pct))).replace(/\{val\}/g, val.toFixed(1));
}

/**
 * Generic composer for features without a verbatim matrix row.
 *
 * Shape for a supporting driver:
 *   "{pct}% of this {bullish|bearish} conviction is driven by {predicate}
 *    ({label} at {value}), {implication}."
 *
 * Shape for an opposing driver:
 *   "{predicate} ({label} at {value}) acts as a {pct}% headwind, {implication}."
 */
export function composeGenericNarrative(
  definition: FeatureDefinition,
  state: FeatureState,
  value: number,
  contributionPercent: number,
  direction: ImpactDirection,
  signalDirection: 'long' | 'short',
): string {
  const pct = Math.round(contributionPercent);
  const formatted = formatFeatureValue(definition, value);
  const supports = direction === 'positive';
  const stance = signalDirection === 'long' ? 'bullish' : 'bearish';

  if (supports) {
    return `${pct}% of this ${stance} conviction is driven by ${state.predicate} (${definition.label} at ${formatted}), ${state.implication}.`;
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
  return `${opening.charAt(0).toUpperCase()}${opening.slice(1)} acts as a ${pct}% headwind, ${state.implication}.`;
}

export interface TranslatedDriver extends SignalDriver {
  domain: XaiDomain;
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
  const signalDirection = options.signalDirection === 'short' ? 'short' : 'long';

  return ranked.map((c) => {
    const definition = featureDefinition(c.feature);
    const direction: ImpactDirection = c.shap >= 0 ? 'positive' : 'negative';
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
      };
    }

    // Stage 2: discretise the raw model input, never the SHAP output.
    const state = resolveState(definition, c.value);
    // Stage 3: tripartite lexical matrix query.
    const matrixKey = `${definition.key}|${direction}|${state.state}`;
    const entry = INSTITUTIONAL_MAPPING_MATRIX[matrixKey];

    // Stage 4: template hydration.
    const narrative = entry
      ? hydrateTemplate(entry.template, contributionPercentage, c.value)
      : composeGenericNarrative(definition, state, c.value, contributionPercentage, direction, signalDirection);

    return {
      featureKey: definition.key,
      label: definition.label,
      group: definition.group,
      value: c.value,
      shap: c.shap,
      share: c.share,
      direction,
      state: state.state,
      narrative,
      domain: domainForFeature(definition.key, definition.group),
      semanticKey: entry?.semanticKey ?? `${definition.key}_${state.state.toLowerCase()}`,
      contributionPercentage,
      fromMatrix: Boolean(entry),
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
  return `The strongest opposing driver is ${describeDriver(strongest)}, subtracting ${Math.round(
    strongest.contributionPercentage,
  )}% of total attribution. ${capitalise(strongest.narrative)}`;
}

function describeDriver(driver: TranslatedDriver): string {
  const definition = featureDefinition(driver.featureKey);
  if (!definition) return driver.label;
  const state = resolveState(definition, driver.value);
  return `${state.predicate} (${definition.label} at ${formatFeatureValue(definition, driver.value)})`;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
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
