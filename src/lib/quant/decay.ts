/**
 * Alpha decay — continuous exponential decay of alternative-data signals.
 *
 * Phase 2 §2: "We mathematically enforce the reality of alpha decay using
 * continuous exponential decay functions. High-noise streams like Reddit and
 * social media sentiment are subjected to a steep exponential decay curve with a
 * calibrated half-life of minutes to hours. Conversely, high-signal structural
 * data, such as Form 4 Insider Trading accumulation, utilizes a one-step
 * smoothed decay with a half-life of 30 to 90 days."
 *
 *     w(Δt) = exp( −ln2 · Δt / H )        H = half-life
 *
 * so w(H) = 0.5 exactly, and the instantaneous decay rate is λ = ln2 / H.
 */

import { EPS, clamp, sum } from './stats';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Alt-data stream identifiers used across ingestion, features and the UI. */
export type AltDataStream =
  | 'social_reddit'
  | 'social_x'
  | 'stocktwits'
  | 'news_headline'
  | 'analyst_revision'
  | 'options_flow'
  | 'insider_form4'
  | 'institutional_13f'
  | 'sec_filing_8k'
  | 'sec_filing_10k'
  | 'earnings_call'
  | 'job_postings'
  | 'glassdoor_sentiment'
  | 'app_downloads'
  | 'web_traffic'
  | 'supply_chain'
  | 'patent_filings'
  | 'short_interest';

export interface DecayProfile {
  stream: AltDataStream;
  /** Half-life in milliseconds. */
  halfLifeMs: number;
  /** Human label for the UI. */
  label: string;
  /**
   * `sharp` — plain exponential, appropriate for noise-dominated streams.
   * `smoothed` — one-step smoothed decay: a short plateau of full weight (the
   * information is still being priced in) followed by exponential decay. Phase 2
   * mandates this for Form 4 accumulation.
   */
  shape: 'sharp' | 'smoothed';
  /** Plateau length for the smoothed shape, in ms. */
  plateauMs?: number;
  /**
   * Authority multiplier from Phase 2 §3 (SEC 10-K/13F = 1.0, Twitter/X = 0.30).
   * Applied to the weight so a decayed social print can never outrank a filing.
   */
  authority: number;
}

/**
 * Calibrated decay table. Half-lives are taken directly from the research
 * mandate; where a range is given (minutes-to-hours, 30–90 days) the mid of the
 * range is used and the extremes remain reachable via `withHalfLife`.
 */
export const DECAY_PROFILES: Record<AltDataStream, DecayProfile> = {
  social_reddit: { stream: 'social_reddit', halfLifeMs: 45 * MINUTE_MS, label: 'Reddit chatter', shape: 'sharp', authority: 0.3 },
  social_x: { stream: 'social_x', halfLifeMs: 30 * MINUTE_MS, label: 'X / Twitter flow', shape: 'sharp', authority: 0.3 },
  stocktwits: { stream: 'stocktwits', halfLifeMs: 40 * MINUTE_MS, label: 'StockTwits', shape: 'sharp', authority: 0.3 },
  news_headline: { stream: 'news_headline', halfLifeMs: 6 * HOUR_MS, label: 'Newswire', shape: 'sharp', authority: 0.6 },
  analyst_revision: { stream: 'analyst_revision', halfLifeMs: 21 * DAY_MS, label: 'Analyst revisions', shape: 'smoothed', plateauMs: 2 * DAY_MS, authority: 0.75 },
  options_flow: { stream: 'options_flow', halfLifeMs: 3 * HOUR_MS, label: 'Unusual options flow', shape: 'sharp', authority: 0.7 },
  insider_form4: { stream: 'insider_form4', halfLifeMs: 60 * DAY_MS, label: 'Form 4 insider accumulation', shape: 'smoothed', plateauMs: 5 * DAY_MS, authority: 1.0 },
  institutional_13f: { stream: 'institutional_13f', halfLifeMs: 75 * DAY_MS, label: '13F institutional positioning', shape: 'smoothed', plateauMs: 7 * DAY_MS, authority: 1.0 },
  sec_filing_8k: { stream: 'sec_filing_8k', halfLifeMs: 10 * DAY_MS, label: '8-K material events', shape: 'smoothed', plateauMs: DAY_MS, authority: 1.0 },
  sec_filing_10k: { stream: 'sec_filing_10k', halfLifeMs: 90 * DAY_MS, label: '10-K / 10-Q fundamentals', shape: 'smoothed', plateauMs: 3 * DAY_MS, authority: 1.0 },
  earnings_call: { stream: 'earnings_call', halfLifeMs: 30 * DAY_MS, label: 'Earnings call tone', shape: 'smoothed', plateauMs: 2 * DAY_MS, authority: 0.85 },
  job_postings: { stream: 'job_postings', halfLifeMs: 45 * DAY_MS, label: 'Hiring velocity', shape: 'smoothed', plateauMs: 7 * DAY_MS, authority: 0.55 },
  glassdoor_sentiment: { stream: 'glassdoor_sentiment', halfLifeMs: 60 * DAY_MS, label: 'Employee sentiment', shape: 'smoothed', plateauMs: 7 * DAY_MS, authority: 0.45 },
  app_downloads: { stream: 'app_downloads', halfLifeMs: 30 * DAY_MS, label: 'App download velocity', shape: 'smoothed', plateauMs: 3 * DAY_MS, authority: 0.5 },
  web_traffic: { stream: 'web_traffic', halfLifeMs: 21 * DAY_MS, label: 'Web traffic trend', shape: 'smoothed', plateauMs: 2 * DAY_MS, authority: 0.5 },
  supply_chain: { stream: 'supply_chain', halfLifeMs: 40 * DAY_MS, label: 'Supply-chain throughput', shape: 'smoothed', plateauMs: 5 * DAY_MS, authority: 0.6 },
  patent_filings: { stream: 'patent_filings', halfLifeMs: 120 * DAY_MS, label: 'Patent filings', shape: 'smoothed', plateauMs: 14 * DAY_MS, authority: 0.65 },
  short_interest: { stream: 'short_interest', halfLifeMs: 14 * DAY_MS, label: 'Short interest / borrow', shape: 'smoothed', plateauMs: DAY_MS, authority: 0.8 },
};

/** λ = ln2 / H. */
export function decayRate(halfLifeMs: number): number {
  return halfLifeMs <= 0 ? Infinity : Math.LN2 / halfLifeMs;
}

/** Plain exponential weight w(Δt) = 2^(−Δt/H) ∈ (0, 1]. */
export function exponentialDecay(ageMs: number, halfLifeMs: number): number {
  if (ageMs <= 0) return 1;
  if (halfLifeMs <= 0) return 0;
  return Math.pow(2, -ageMs / halfLifeMs);
}

/**
 * One-step smoothed decay: full weight for `plateauMs`, then exponential.
 * Structural information (an insider buying pattern, a 13F position) does not
 * begin losing relevance the microsecond it is published.
 */
export function smoothedDecay(ageMs: number, halfLifeMs: number, plateauMs: number): number {
  if (ageMs <= plateauMs) return 1;
  return exponentialDecay(ageMs - plateauMs, halfLifeMs);
}

/** Weight for a stream's profile at a given age, before authority weighting. */
export function decayWeight(profile: DecayProfile, ageMs: number): number {
  return profile.shape === 'smoothed'
    ? smoothedDecay(ageMs, profile.halfLifeMs, profile.plateauMs ?? 0)
    : exponentialDecay(ageMs, profile.halfLifeMs);
}

/** Decay weight × authority multiplier — the effective weight of one event. */
export function effectiveWeight(profile: DecayProfile, ageMs: number): number {
  return decayWeight(profile, ageMs) * profile.authority;
}

export function withHalfLife(profile: DecayProfile, halfLifeMs: number): DecayProfile {
  return { ...profile, halfLifeMs };
}

export interface DecayableEvent {
  stream: AltDataStream;
  /** Epoch ms of the event. */
  timestamp: number;
  /** Signed signal in [−1, 1] (or any bounded score). */
  value: number;
  /** Optional per-event confidence in [0, 1]. */
  confidence?: number;
}

export interface AggregatedStream {
  stream: AltDataStream;
  label: string;
  /** Weighted mean signal in the same units as the inputs. */
  score: number;
  /** Σ effective weights — how much live evidence there is. */
  evidence: number;
  /** Count of events considered. */
  events: number;
  /** Age of the most recent event, in ms. */
  freshnessMs: number;
  /** Weight the newest event currently carries. */
  currentWeight: number;
  halfLifeMs: number;
  authority: number;
  /** The profile's decay shape, carried through so a client can draw the curve. */
  shape: DecayProfile['shape'];
  /** Plateau length for the smoothed shape, in ms; 0 for a sharp profile. */
  plateauMs: number;
}

/**
 * Decay-weighted aggregation of one stream:
 *
 *     score = Σ w_i·c_i·v_i / Σ w_i·c_i,     w_i = decay(age_i) · authority
 */
export function aggregateStream(
  stream: AltDataStream,
  events: readonly DecayableEvent[],
  now: number,
  overrideProfile?: DecayProfile,
): AggregatedStream {
  const profile = overrideProfile ?? DECAY_PROFILES[stream];
  const relevant = events.filter((e) => e.stream === stream && e.timestamp <= now);
  let num = 0;
  let den = 0;
  let newest = -Infinity;
  for (const e of relevant) {
    const w = effectiveWeight(profile, now - e.timestamp) * (e.confidence ?? 1);
    num += w * e.value;
    den += w;
    if (e.timestamp > newest) newest = e.timestamp;
  }
  const freshnessMs = Number.isFinite(newest) ? now - newest : Infinity;
  return {
    stream,
    label: profile.label,
    score: den < EPS ? 0 : num / den,
    evidence: den,
    events: relevant.length,
    freshnessMs,
    currentWeight: Number.isFinite(freshnessMs) ? decayWeight(profile, freshnessMs) : 0,
    halfLifeMs: profile.halfLifeMs,
    authority: profile.authority,
    shape: profile.shape,
    plateauMs: profile.plateauMs ?? 0,
  };
}

/** Aggregates every stream present in `events`. */
export function aggregateAllStreams(
  events: readonly DecayableEvent[],
  now: number,
): AggregatedStream[] {
  const present = new Set(events.map((e) => e.stream));
  return Array.from(present).map((s) => aggregateStream(s, events, now));
}

/**
 * Composite alt-data score: evidence-weighted blend of the per-stream scores,
 * squashed to [−1, 1].
 *
 * A stream's evidence is `Σ wᵢ` over its events, and each `wᵢ` already carries
 * the stream's authority multiplier and its decay against age. So the blend is
 * weighted by authority and by freshness — a *decayed* Reddit spike genuinely
 * cannot outvote a fresh Form 4, which is what this comment used to claim.
 *
 * It is weighted by volume too, and that is worth stating rather than leaving to
 * be discovered: the sum grows linearly with event count, so a stream can make
 * up for low authority by being numerous. Two hundred fresh Reddit posts
 * (authority 0.30) do outvote one fresh Form 4 (authority 1.00), 0.98 of the
 * share against 0.02. That is the intended reading — two hundred independent
 * observations are more evidence than one, whatever the per-observation quality
 * — but it is not what "authority dominates" would mean, and the two were being
 * conflated here.
 */
export function compositeAltScore(streams: readonly AggregatedStream[]): {
  score: number;
  evidence: number;
  contributions: { stream: AltDataStream; label: string; contribution: number; share: number }[];
} {
  const totalEvidence = sum(streams.map((s) => s.evidence));
  if (totalEvidence < EPS) return { score: 0, evidence: 0, contributions: [] };
  const contributions = streams.map((s) => ({
    stream: s.stream,
    label: s.label,
    contribution: (s.evidence / totalEvidence) * s.score,
    share: s.evidence / totalEvidence,
  }));
  return {
    score: clamp(sum(contributions.map((c) => c.contribution)), -1, 1),
    evidence: totalEvidence,
    contributions: contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
  };
}

/**
 * Half-life implied by an observed decay: given that a signal retained
 * `retention` of its value after `ageMs`, H = −ln2·Δt / ln(retention).
 * Used by the calibration report to show that the configured half-lives match
 * measured decay in the backtest.
 */
export function impliedHalfLife(ageMs: number, retention: number): number {
  const r = clamp(retention, 1e-9, 1 - 1e-9);
  return (-Math.LN2 * ageMs) / Math.log(r);
}
