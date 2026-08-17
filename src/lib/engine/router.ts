/**
 * The Multi-Agent Conflict-Resolution Router and the Hierarchical State Clock.
 *
 * This is the fusion layer specified verbatim by the AI Trading Engine
 * Architecture Blueprint (MADRLConflictRouter). Every constant below is taken
 * from that document; none are invented.
 *
 *   Step 1 — Regime Override Protocol
 *     IF c₆₀ ≥ τ (0.70) AND sign(ŷ₅) ≠ sign(ŷ₆₀) AND ŷ₅ ≠ 0:
 *         IF VPIN > 0.85 → ("ABORT_TOXIC_FLOW", 0.0)
 *         ELSE           → c₅ ← c₅ × 0.15
 *
 *   Step 2 — Asymmetrical Dynamic Agent Weighting
 *     W₅  = c₅  · edge₅  · max(0, 1 − VPIN)     edge₅  = 0.535
 *     W₁₅ = c₁₅ · edge₁₅                        edge₁₅ = 0.552
 *     W₆₀ = c₆₀ · edge₆₀ · (1 + 0.4·σ_RS)       edge₆₀ = 0.591
 *
 *   Step 3 — Aggregate Directional Signal
 *     S_agg = Σ ŷᵢ · (Wᵢ / ΣW)                  ∈ [−1, 1]
 *
 *   Step 4 — Sizing and action emission
 *     IF |S_agg| > 0.35:
 *         action = EXECUTE_LONG if S_agg > 0 else EXECUTE_SHORT
 *         p_composite = 0.50 + 0.50·|S_agg|
 *         f_opt = max(0, (p − (1−p)/b) · 0.5)   half-Kelly, b = 1
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COMPLIANCE BOUNDARY — read before wiring this anywhere near an order.
 *
 * `optimalSize` is a Kelly *exposure fraction of the model's own notional
 * unit*. It is computed only from the model's aggregate signal strength. It
 * never reads a user's balance, holdings, buying power or risk tolerance, and it
 * is never used to pre-fill an order quantity — MASTER §4.3 and Phase 5 §1
 * prohibit algorithmic position sizing outright. It is published as an
 * impersonal model statistic, identically for every subscriber, and the order
 * ticket ignores it completely.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { clamp } from '@/lib/quant/stats';
import { Sequence, SequenceBarrier } from './disruptor';

// ── Constants (verbatim from the blueprint) ─────────────────────────────────

/** Rolling historical accuracy ("edge") of each temporal agent. */
export const AGENT_EDGE = { '5m': 0.535, '15m': 0.552, '60m': 0.591 } as const;
/** Regime Override Threshold τ. */
export const REGIME_OVERRIDE_THRESHOLD = 0.7;
/** VPIN level above which a counter-macro micro-trade is aborted outright. */
export const TOXIC_FLOW_THRESHOLD = 0.85;
/** Conviction haircut applied to the 5m agent in the hedge scenario. */
export const CONVICTION_SUPPRESSION = 0.15;
/** Macro-volatility amplification coefficient on the 60m weight. */
export const MACRO_VOL_AMPLIFICATION = 0.4;
/** Absolute aggregate threshold below which nothing is emitted (noise floor). */
export const AGGREGATE_NOISE_FLOOR = 0.35;
/** Half-Kelly: the fraction of full Kelly actually used. */
export const KELLY_FRACTION = 0.5;

export type RouterAction =
  | 'ABORT_TOXIC_FLOW'
  | 'NEUTRAL'
  | 'HOLD'
  | 'EXECUTE_LONG'
  | 'EXECUTE_SHORT'
  | 'SKIP';

export interface AgentSignal {
  /** Directional prediction ŷ ∈ [−1, 1]. */
  direction: number;
  /** Conviction c ∈ [0, 1], from the model's softmax entropy. */
  conviction: number;
}

export interface RouterInput {
  agent5m: AgentSignal;
  agent15m: AgentSignal;
  agent60m: AgentSignal;
  /** VPIN order-flow toxicity ∈ [0, 1]. */
  vpinToxicity: number;
  /** Rogers–Satchell macro volatility. */
  rsVolatility: number;
  /** Payoff odds ratio b for Kelly (defaults to 1). */
  oddsRatio?: number;
  /** Set by the 60m agent's CAS inhibition flag; blocks long-side emission. */
  inhibitLong?: boolean;
  /** Mirror of the above for the short side. */
  inhibitShort?: boolean;
}

export interface RouterDecision {
  action: RouterAction;
  /** Kelly exposure fraction — an impersonal model statistic, never an order size. */
  optimalSize: number;
  /** S_agg ∈ [−1, 1]. */
  aggregateDirection: number;
  /** Composite pseudo-probability fed to Kelly. */
  compositeProbability: number;
  /** Normalised weights actually used, for the UI's weight bars. */
  weights: { w5m: number; w15m: number; w60m: number };
  /** Raw (unnormalised) weights. */
  rawWeights: { w5m: number; w15m: number; w60m: number };
  /** True when the Regime Override Protocol suppressed the 5m agent. */
  regimeOverrideApplied: boolean;
  /** Conviction of the 5m agent after any suppression. */
  effectiveConviction5m: number;
  /** Human-readable account of which branch fired. */
  rationale: string;
}

/**
 * Continuous-time Kelly with the half-Kelly haircut.
 *
 *   f* = p − (1 − p)/b,   f_opt = max(0, f*·kellyFraction)
 *   p ≤ 0.50 ⇒ 0 (no statistical edge)
 */
export function continuousKelly(winProb: number, oddsRatio = 1, kellyFraction = KELLY_FRACTION): number {
  if (winProb <= 0.5) return 0;
  const b = oddsRatio <= 0 ? 1 : oddsRatio;
  const kellyF = winProb - (1 - winProb) / b;
  return Math.max(0, kellyF * kellyFraction);
}

export function routeSignals(input: RouterInput): RouterDecision {
  const vpin = clamp(input.vpinToxicity, 0, 1);
  const sigmaRs = Math.max(0, input.rsVolatility);
  const dir5 = clamp(input.agent5m.direction, -1, 1);
  const dir15 = clamp(input.agent15m.direction, -1, 1);
  const dir60 = clamp(input.agent60m.direction, -1, 1);
  const conv15 = clamp(input.agent15m.conviction, 0, 1);
  const conv60 = clamp(input.agent60m.conviction, 0, 1);
  let conv5 = clamp(input.agent5m.conviction, 0, 1);

  const emptyWeights = { w5m: 0, w15m: 0, w60m: 0 };
  let regimeOverrideApplied = false;
  let rationale = '';

  // ── Step 1: Regime Override Protocol ─────────────────────────────────────
  if (conv60 >= REGIME_OVERRIDE_THRESHOLD) {
    if (Math.sign(dir5) !== Math.sign(dir60) && dir5 !== 0) {
      if (vpin > TOXIC_FLOW_THRESHOLD) {
        return {
          action: 'ABORT_TOXIC_FLOW',
          optimalSize: 0,
          aggregateDirection: 0,
          compositeProbability: 0.5,
          weights: emptyWeights,
          rawWeights: emptyWeights,
          regimeOverrideApplied: true,
          effectiveConviction5m: conv5,
          rationale:
            `The 60m macro agent holds ${(conv60 * 100).toFixed(0)}% conviction against the 5m signal ` +
            `while order-flow toxicity reads ${vpin.toFixed(2)} — above the 0.85 abort threshold. ` +
            'The micro-trade is aborted rather than routed into a liquidity vacuum.',
        };
      }
      conv5 *= CONVICTION_SUPPRESSION;
      regimeOverrideApplied = true;
      rationale =
        `The 5m tactical agent is pointing against a high-conviction 60m macro read, so its ` +
        `conviction is cut by 85% to a hedge weight rather than executed as a primary position. `;
    }
  }

  // ── Step 2: Asymmetrical dynamic weighting ───────────────────────────────
  const w5m = conv5 * AGENT_EDGE['5m'] * Math.max(0, 1 - vpin);
  const w15m = conv15 * AGENT_EDGE['15m'];
  const w60m = conv60 * AGENT_EDGE['60m'] * (1 + sigmaRs * MACRO_VOL_AMPLIFICATION);
  const total = w5m + w15m + w60m;
  const rawWeights = { w5m, w15m, w60m };

  if (total === 0) {
    return {
      action: 'NEUTRAL',
      optimalSize: 0,
      aggregateDirection: 0,
      compositeProbability: 0.5,
      weights: emptyWeights,
      rawWeights,
      regimeOverrideApplied,
      effectiveConviction5m: conv5,
      rationale: `${rationale}Every agent weight collapsed to zero, so no directional view is published.`,
    };
  }

  // ── Step 3: Aggregate directional signal ─────────────────────────────────
  const nw5 = w5m / total;
  const nw15 = w15m / total;
  const nw60 = w60m / total;
  const aggregateDirection = clamp(dir5 * nw5 + dir15 * nw15 + dir60 * nw60, -1, 1);
  const weights = { w5m: nw5, w15m: nw15, w60m: nw60 };

  // ── Step 4: Sizing and action ────────────────────────────────────────────
  let action: RouterAction = 'HOLD';
  let optimalSize = 0;
  let compositeProbability = 0.5;

  if (Math.abs(aggregateDirection) > AGGREGATE_NOISE_FLOOR) {
    const wantLong = aggregateDirection > 0;
    // Atomic inhibition flags set by the 60m agent take precedence over sizing.
    if (wantLong && input.inhibitLong) {
      action = 'SKIP';
      rationale += 'The 60m agent has set the systemic inhibit-long flag, so the long-side emission is skipped.';
    } else if (!wantLong && input.inhibitShort) {
      action = 'SKIP';
      rationale += 'The 60m agent has set the systemic inhibit-short flag, so the short-side emission is skipped.';
    } else {
      action = wantLong ? 'EXECUTE_LONG' : 'EXECUTE_SHORT';
      compositeProbability = 0.5 + Math.abs(aggregateDirection) * 0.5;
      optimalSize = continuousKelly(compositeProbability, input.oddsRatio ?? 1);
      rationale +=
        `Aggregate signal ${aggregateDirection >= 0 ? '+' : ''}${aggregateDirection.toFixed(3)} clears the ` +
        `${AGGREGATE_NOISE_FLOOR} noise floor; weights are ${(nw5 * 100).toFixed(0)}% / ${(nw15 * 100).toFixed(0)}% / ` +
        `${(nw60 * 100).toFixed(0)}% across the 5m, 15m and 60m agents.`;
    }
  } else {
    rationale +=
      `Aggregate signal ${aggregateDirection >= 0 ? '+' : ''}${aggregateDirection.toFixed(3)} sits inside the ` +
      `±${AGGREGATE_NOISE_FLOOR} noise floor, so the engine holds rather than trading noise.`;
  }

  return {
    action,
    optimalSize,
    aggregateDirection,
    compositeProbability,
    weights,
    rawWeights,
    regimeOverrideApplied,
    effectiveConviction5m: conv5,
    rationale: rationale.trim(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Hierarchical State Clock
// ─────────────────────────────────────────────────────────────────────────────

export type MacroRegime = 'REGIME_BULL' | 'REGIME_BEAR' | 'REGIME_CHOP';

export interface MacroStateVector {
  /** Tick sequence this state belongs to. */
  sequence: number;
  probabilities: Record<MacroRegime, number>;
  label: MacroRegime;
  /** Set via CAS when a structural breakdown is detected. */
  inhibitLong: boolean;
  inhibitShort: boolean;
}

const EMPTY_MACRO: MacroStateVector = {
  sequence: -1,
  probabilities: { REGIME_BULL: 1 / 3, REGIME_BEAR: 1 / 3, REGIME_CHOP: 1 / 3 },
  label: 'REGIME_CHOP',
  inhibitLong: false,
  inhibitShort: false,
};

/**
 * Time is the deterministic sequence ID of the incoming tick, never the server
 * clock. The 5m agent may not publish for tick Tₙ until the barrier confirms it
 * has read the 60m and 15m macro state up to Tₙ₋₁.
 *
 * In a single-threaded event loop the CAS on the inhibition flags cannot race,
 * but the *ordering contract* is what matters and it is enforced here rather
 * than assumed: `publish5m` throws if the barrier is not satisfied.
 */
export class HierarchicalStateClock {
  private currentSequence = -1;
  private readonly sequence60m = new Sequence();
  private readonly sequence15m = new Sequence();
  private readonly sequence5m = new Sequence();
  private readonly barrier: SequenceBarrier;
  private macro60m: MacroStateVector = { ...EMPTY_MACRO };
  private macro15m: MacroStateVector = { ...EMPTY_MACRO };
  /** Records every barrier violation, surfaced on the engine health panel. */
  private violations = 0;

  constructor() {
    this.barrier = new SequenceBarrier(() => this.currentSequence, [this.sequence60m, this.sequence15m]);
  }

  /** Advances the clock to the next tick and returns its sequence ID. */
  tick(): number {
    this.currentSequence += 1;
    return this.currentSequence;
  }

  get sequence(): number {
    return this.currentSequence;
  }

  get barrierViolations(): number {
    return this.violations;
  }

  /** The 60m agent commits its macro state for a sequence. */
  publish60m(state: Omit<MacroStateVector, 'sequence'>, sequence: number): void {
    this.macro60m = { ...state, sequence };
    this.sequence60m.set(sequence);
  }

  /** The 15m agent commits its macro state for a sequence. */
  publish15m(state: Omit<MacroStateVector, 'sequence'>, sequence: number): void {
    this.macro15m = { ...state, sequence };
    this.sequence15m.set(sequence);
  }

  /**
   * Reads the macro state the 5m agent is allowed to see for tick `sequence`:
   * the state committed up to `sequence − 1`. Returns null when the barrier is
   * not yet satisfied, which the caller must treat as "do not publish".
   */
  readMacroForTick(sequence: number): { macro60m: MacroStateVector; macro15m: MacroStateVector } | null {
    const required = sequence - 1;
    if (required < 0) return { macro60m: this.macro60m, macro15m: this.macro15m };
    if (this.sequence60m.get() < required || this.sequence15m.get() < required) return null;
    return { macro60m: this.macro60m, macro15m: this.macro15m };
  }

  /** True when the 5m agent may publish for `sequence`. */
  canPublish5m(sequence: number): boolean {
    return this.readMacroForTick(sequence) !== null;
  }

  /**
   * Publishes the 5m agent's inference under the sequence barrier. Throws rather
   * than silently proceeding, because a violation means the engine executed a
   * micro-trade without seeing the macro state — exactly the race the clock
   * exists to prevent.
   */
  publish5m(sequence: number): { macro60m: MacroStateVector; macro15m: MacroStateVector } {
    const macro = this.readMacroForTick(sequence);
    if (!macro) {
      this.violations += 1;
      throw new Error(
        `HierarchicalStateClock: sequence barrier not satisfied for tick ${sequence} ` +
          `(60m at ${this.sequence60m.get()}, 15m at ${this.sequence15m.get()}, required ${sequence - 1})`,
      );
    }
    this.sequence5m.set(sequence);
    return macro;
  }

  /** Highest sequence the execution consumer may safely read. */
  availableSequence(): number {
    return this.barrier.availableSequence();
  }

  /** Current inhibition flags, as the 5m agent would read them. */
  inhibitionFlags(): { inhibitLong: boolean; inhibitShort: boolean } {
    return {
      inhibitLong: this.macro60m.inhibitLong || this.macro15m.inhibitLong,
      inhibitShort: this.macro60m.inhibitShort || this.macro15m.inhibitShort,
    };
  }

  snapshot(): {
    sequence: number;
    sequence5m: number;
    sequence15m: number;
    sequence60m: number;
    macro60m: MacroStateVector;
    macro15m: MacroStateVector;
    violations: number;
  } {
    return {
      sequence: this.currentSequence,
      sequence5m: this.sequence5m.get(),
      sequence15m: this.sequence15m.get(),
      sequence60m: this.sequence60m.get(),
      macro60m: this.macro60m,
      macro15m: this.macro15m,
      violations: this.violations,
    };
  }
}

/**
 * Derives a macro regime distribution from the agent's probability and the
 * measured trend/volatility state. The 60m agent produces a directional
 * probability; the clock needs a distribution over {BULL, BEAR, CHOP}.
 */
export function macroRegimeDistribution(
  probability: number,
  trendStrength: number,
  volatilityPercentile: number,
): { probabilities: Record<MacroRegime, number>; label: MacroRegime; inhibitLong: boolean; inhibitShort: boolean } {
  // Chop mass rises when trend strength is low; direction splits the remainder.
  const chop = clamp(1 - clamp(trendStrength, 0, 1), 0.05, 0.9);
  const directional = 1 - chop;
  const bull = directional * clamp(probability, 0, 1);
  const bear = directional * (1 - clamp(probability, 0, 1));
  const probabilities: Record<MacroRegime, number> = {
    REGIME_BULL: bull,
    REGIME_BEAR: bear,
    REGIME_CHOP: chop,
  };
  const label: MacroRegime =
    bull >= bear && bull >= chop ? 'REGIME_BULL' : bear >= chop ? 'REGIME_BEAR' : 'REGIME_CHOP';

  // A structural breakdown — bearish macro conviction coinciding with a
  // top-quintile volatility regime — sets the atomic inhibit-long flag.
  const inhibitLong = label === 'REGIME_BEAR' && bear > 0.55 && volatilityPercentile > 0.8;
  const inhibitShort = label === 'REGIME_BULL' && bull > 0.55 && volatilityPercentile > 0.8;
  return { probabilities, label, inhibitLong, inhibitShort };
}
