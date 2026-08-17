/**
 * Hard-coded pre-trade risk limits.
 *
 * Every constant here exists because the compliance mandate requires the
 * platform's internal risk engine to "perfectly parallel" FINRA/SEC Rule 15c3-5
 * (Market Access Rule) as a prophylactic shield for the API partners
 * (Interactive Brokers, Alpaca, Tradier), who will sever API access at the first
 * sign of infrastructural instability. The values are compile-time constants
 * rather than configuration because a limit that can be relaxed at runtime by an
 * operator is not a control a broker-dealer can rely on.
 *
 * Where the research document supplies a number it is used verbatim and the
 * `regulatoryBasis` field of the descriptor cites it. Where the document
 * mandates that a control exist without fixing a number (the price-tolerance
 * collar, the daily aggregate ceiling, the open-order cap, the token TTL) the
 * value is labelled PLATFORM POLICY and the reasoning is written out in full, so
 * the compliance file can defend the choice rather than discover it.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  15c3-5 Control 1 — notional value ceilings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Research value: "$100,000 (stated internal retail limit)". The worked example
 * in the mandate is a user physically typing $5,000,000 into the ticket; the
 * engine must intercept the payload rather than trusting client-side validation.
 */
export const MAX_NOTIONAL_PER_ORDER_USD = 100_000;

/**
 * PLATFORM POLICY. The mandate requires that a "per user per day" aggregate
 * ceiling exist but supplies no second number, and the reconstruction notes
 * suggest reusing $100,000 "unless configured otherwise". Reusing it would make
 * the daily ceiling indistinguishable from the per-order ceiling — a subscriber
 * who legitimately trades twice in a day would be blocked, which pushes users
 * toward working around the control. $500,000 is set at exactly five times the
 * per-order ceiling: it preserves a real aggregate brake (the single largest
 * loss vector, a script looping the Execute button, is capped at five orders'
 * worth of notional) while leaving room for ordinary manual retail activity.
 */
export const MAX_NOTIONAL_PER_USER_PER_DAY_USD = 500_000;

/**
 * PLATFORM POLICY. Reg T / FINRA Rule 4210 sets the 25% minimum maintenance
 * requirement for long equity positions; the projected-deficit arm of the
 * buying-power check uses it to decide whether a fill would create or increase
 * an intraday margin deficit, which is the condition Alpaca's own pre-trade
 * checks reject on.
 */
export const MAINTENANCE_MARGIN_RATE = 0.25;

// ─────────────────────────────────────────────────────────────────────────────
//  15c3-5 Control 2 — maximum order size versus liquidity
// ─────────────────────────────────────────────────────────────────────────────

/** Research value: reject when quantity exceeds 5% of the security's ADV. */
export const ADV_PARTICIPATION_LIMIT = 0.05;

/** Research value: the ADV reference window is 30 trading sessions. */
export const ADV_LOOKBACK_DAYS = 30;

// ─────────────────────────────────────────────────────────────────────────────
//  15c3-5 Control 3 — order price parameters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PLATFORM POLICY, anchored to a published standard. The mandate specifies the
 * control and one failing case (a $100 buy limit against a $10 market — a 900%
 * deviation) but explicitly leaves the collar as "a required configurable".
 *
 * Inventing a flat percentage would be arbitrary, so the bands mirror the
 * regular-hours numerical guidelines of FINRA Rule 11892 (Clearly Erroneous
 * Executions), which are the industry's existing definition of "a price far
 * from the prevailing market": 10% for securities up to $25, 5% for $25–$50, 3%
 * above $50. Those figures are the threshold at which a *print* gets broken.
 */
export interface PriceToleranceBand {
  /** Upper bound of the band, on the reference price. */
  maxReferencePriceUsd: number;
  /** FINRA 11892 regular-hours clearly-erroneous deviation for the band. */
  clearlyErroneousDeviation: number;
}

export const PRICE_TOLERANCE_BANDS: readonly PriceToleranceBand[] = [
  { maxReferencePriceUsd: 25, clearlyErroneousDeviation: 0.1 },
  { maxReferencePriceUsd: 50, clearlyErroneousDeviation: 0.05 },
  { maxReferencePriceUsd: Number.POSITIVE_INFINITY, clearlyErroneousDeviation: 0.03 },
];

/**
 * PLATFORM POLICY. Order *entry* collars must be looser than execution-busting
 * thresholds, or a deliberately aggressive-but-rational limit (crossing the
 * spread hard to guarantee a fill in a fast market) would be rejected as
 * erroneous. The entry collar is therefore twice the FINRA 11892 band, giving
 * 20% / 10% / 6%. The mandated failing case still fails by two orders of
 * magnitude: 900% deviation against a 20% collar.
 */
export const ORDER_ENTRY_COLLAR_MULTIPLIER = 2;

/**
 * PLATFORM POLICY. Stop prices are *intentionally* placed away from the market
 * on both sides — a buy stop above it, a sell stop below it — so the NBBO collar
 * above cannot apply to them without rejecting legitimate breakout and
 * protective orders. This far wider symmetric band catches only unambiguous
 * typography: a stop half again away from the reference price is a
 * mis-keystroke, not a strategy.
 */
export const STOP_PRICE_SANITY_DEVIATION = 0.5;

/** Entry collar for the aggressive side of a limit price, given its reference. */
export function limitPriceTolerance(referencePrice: number): number {
  const price = Math.abs(referencePrice);
  for (const band of PRICE_TOLERANCE_BANDS) {
    if (price <= band.maxReferencePriceUsd) {
      return band.clearlyErroneousDeviation * ORDER_ENTRY_COLLAR_MULTIPLIER;
    }
  }
  // Unreachable: the final band is unbounded. Kept so the function is total.
  /*
     * The multiplier belongs here too. This fallback is reached when `price` is
     * NaN — the loop's comparisons are all false — and it returned the raw FINRA
     * band, 3% rather than the 6% every other path applies, so an unpriceable
     * order was judged against a stricter collar than a priced one.
     */
  return (
    PRICE_TOLERANCE_BANDS[PRICE_TOLERANCE_BANDS.length - 1].clearlyErroneousDeviation *
    ORDER_ENTRY_COLLAR_MULTIPLIER
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  15c3-5 Control 5 — message and execution throttles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Research value: "maximum 5 order messages per second per unique user ID",
 * keyed on the user ID rather than IP or session so that neither a shared NAT
 * nor a freshly minted session evades it.
 */
export const ORDER_MESSAGES_PER_SECOND_PER_USER = 5;

/** Research value: the throttle window is one sliding second. */
export const RATE_LIMIT_WINDOW_MS = 1_000;

/** Research value: throttled order messages are answered with 429. */
export const RATE_LIMIT_HTTP_STATUS = 429;

/**
 * Credential attempts allowed per client address per minute.
 *
 * InvestGPT (10/s), retrieval (6/s) and order routing (5/s) were all limited and
 * the two endpoints that take a password were not, so `/api/auth/signin` served
 * unlimited wrong-password attempts with no counter, delay or lockout, and
 * `/api/auth/signup` — which necessarily distinguishes "this address is taken" —
 * could be walked to enumerate the user table. Ten a minute leaves a person who
 * has forgotten their password entirely unaffected.
 */
export const CREDENTIAL_ATTEMPTS_PER_MINUTE = 10;
export const CREDENTIAL_WINDOW_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
//  15c3-5 Control 6 — global kill switch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Research value: while the Global Kill Switch is engaged the platform answers
 * every incoming user request with 503 Service Unavailable.
 */
export const KILL_SWITCH_HTTP_STATUS = 503;

// ─────────────────────────────────────────────────────────────────────────────
//  Order-ticket integrity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The quantity field defaults to null and is populated only by physical keyboard
 * entry, so the engine's job is to reject anything that is not a whole positive
 * share count. Fractional quantities are refused outright rather than rounded:
 * rounding would mean the platform altered a user parameter, and the immutable
 * ledger's whole evidentiary purpose is proving it never does.
 */
export const MIN_QUANTITY = 1;

/**
 * PLATFORM POLICY. No number is given in the mandate. The cap exists so a
 * malfunctioning client cannot accumulate resting orders that the kill switch
 * would then have to unwind one REST call at a time — cancellation is
 * best-effort "where the broker's API permits", so the size of the worst-case
 * unwind has to be bounded. 20 open orders is well beyond any manual
 * per-security workflow and still cancellable inside a single admin action.
 */
export const MAX_OPEN_ORDERS = 20;

/**
 * PLATFORM POLICY. The mandate requires the intent token be generated "at the
 * exact millisecond the user clicks" and be single-use, but sets no lifetime.
 * 30 seconds is long enough to absorb a slow network round-trip plus the
 * pre-trade broker account query, and short enough that a token cannot be
 * stockpiled: a valid token is contemporaneous evidence of a physical click, and
 * an hour-old one would not be.
 */
export const INTENT_TOKEN_TTL_MS = 30_000;

/**
 * PLATFORM POLICY. The click timestamp originates on an unsynchronised client
 * clock, so a small amount of forward skew has to be tolerated or honest users
 * with a fast clock are locked out. Anything further ahead than this is treated
 * as a forged timestamp.
 */
export const INTENT_TOKEN_FUTURE_SKEW_MS = 2_000;

/**
 * PLATFORM POLICY. Idempotency keys are remembered for a full day so that a
 * retried submission is recognised as a duplicate for as long as the order it
 * created could still be resting, and so the memory footprint stays bounded.
 */
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1_000;

// ─────────────────────────────────────────────────────────────────────────────
//  Descriptors — the payload behind GET /api/risk/limits
// ─────────────────────────────────────────────────────────────────────────────

export type RiskLimitCode =
  | 'MAX_NOTIONAL_PER_ORDER'
  | 'MAX_NOTIONAL_PER_USER_PER_DAY'
  | 'ADV_PARTICIPATION'
  | 'ADV_LOOKBACK'
  | 'LIMIT_PRICE_TOLERANCE'
  | 'STOP_PRICE_SANITY'
  | 'MAINTENANCE_MARGIN'
  | 'ORDER_MESSAGE_RATE'
  | 'MIN_QUANTITY'
  | 'MAX_OPEN_ORDERS'
  | 'INTENT_TOKEN_TTL'
  | 'KILL_SWITCH_STATUS';

/**
 * Units are declared locally rather than reusing `FeatureUnit`: these describe
 * governance limits, not model features, and the two vocabularies must be free
 * to diverge.
 */
export type RiskLimitUnit =
  | 'currency'
  | 'percent'
  | 'shares'
  | 'count'
  | 'days'
  | 'milliseconds'
  | 'messages_per_second'
  | 'http_status';

export interface RiskLimitDescriptor {
  code: RiskLimitCode;
  label: string;
  /** Numeric value; tiered limits publish their most permissive tier. */
  value: number;
  unit: RiskLimitUnit;
  /** Why the platform enforces it, in the operator's own words. */
  rationale: string;
  /** The authority the control answers to. */
  regulatoryBasis: string;
}

/**
 * Published so that `GET /api/risk/limits` and the limits panel render from the
 * same source the engine enforces. A UI that restates limits from a second copy
 * would eventually disagree with the engine, and a disclosed limit that is not
 * the enforced limit is a misrepresentation.
 */
export const RISK_LIMIT_DESCRIPTORS: readonly RiskLimitDescriptor[] = [
  {
    code: 'MAX_NOTIONAL_PER_ORDER',
    label: 'Maximum notional per order',
    value: MAX_NOTIONAL_PER_ORDER_USD,
    unit: 'currency',
    rationale:
      'Fat-finger ceiling. The order payload is rejected before transmission even when a larger figure was typed into the ticket.',
    regulatoryBasis: 'SEC Rule 15c3-5(c)(1)(i) — Control 1, notional value ceilings',
  },
  {
    code: 'MAX_NOTIONAL_PER_USER_PER_DAY',
    label: 'Maximum aggregate notional per user per day',
    value: MAX_NOTIONAL_PER_USER_PER_DAY_USD,
    unit: 'currency',
    rationale:
      'Aggregate daily brake. Bounds the total notional a single account can route in one session, so a repeated submission loop cannot accumulate unbounded exposure. Platform policy.',
    regulatoryBasis: 'SEC Rule 15c3-5(c)(1)(i) — Control 1, per-user-per-day ceiling',
  },
  {
    code: 'ADV_PARTICIPATION',
    label: 'Maximum participation in 30-day average daily volume',
    value: ADV_PARTICIPATION_LIMIT * 100,
    unit: 'percent',
    rationale:
      'Liquidity limiter. An order representing a large fraction of a thinly traded name is a manipulative footprint that trips exchange circuit breakers and broker-dealer alerts. Fails closed when volume history is unavailable.',
    regulatoryBasis: 'SEC Rule 15c3-5(c)(1)(i) — Control 2, maximum order size',
  },
  {
    code: 'ADV_LOOKBACK',
    label: 'Average daily volume lookback',
    value: ADV_LOOKBACK_DAYS,
    unit: 'days',
    rationale: 'Arithmetic mean of the trailing 30 trading sessions of share volume.',
    regulatoryBasis: 'SEC Rule 15c3-5(c)(1)(i) — Control 2, liquidity reference window',
  },
  {
    code: 'LIMIT_PRICE_TOLERANCE',
    /*
     * The published figure is the *tightest* tier, not the widest.
     *
     * The collar is tiered by reference price — 20% under $25, 10% to $50, 6%
     * above — and publishing the first band's 20% meant /control advertised a
     * tolerance four times looser than the one actually enforced on a $142 stock,
     * whose own rejection message reads "outside the 6% tolerance band". Where a
     * control varies, the number a user is shown has to be the one that binds
     * first; the tiering is stated in full in the rationale.
     */
    label: 'Limit-price collar versus NBBO (tightest tier)',
    value:
      PRICE_TOLERANCE_BANDS[PRICE_TOLERANCE_BANDS.length - 1].clearlyErroneousDeviation *
      ORDER_ENTRY_COLLAR_MULTIPLIER *
      100,
    unit: 'percent',
    rationale:
      'Tiered against the reference price: 20% under $25, 10% to $50, 6% above — the 6% tier is published here because it is the one that binds for most of the universe. Only the aggressive side is collared — a buy priced above the offer, a sell priced below the bid. Bands are twice the FINRA Rule 11892 clearly-erroneous guidelines so that deliberately aggressive orders still route.',
    regulatoryBasis: 'SEC Rule 15c3-5(c)(1)(i) — Control 3, order price parameters; FINRA Rule 11892',
  },
  {
    code: 'STOP_PRICE_SANITY',
    label: 'Stop-price sanity band',
    value: STOP_PRICE_SANITY_DEVIATION * 100,
    unit: 'percent',
    rationale:
      'Stops are placed away from the market by design, so they carry a wide symmetric band that catches only unambiguous mis-keying. Platform policy.',
    regulatoryBasis: 'SEC Rule 15c3-5(c)(1)(i) — Control 3, erroneous order prevention',
  },
  {
    code: 'MAINTENANCE_MARGIN',
    label: 'Maintenance margin requirement',
    value: MAINTENANCE_MARGIN_RATE * 100,
    unit: 'percent',
    rationale:
      'Applied to projected post-trade exposure. A trade that would create or increase an intraday margin deficit is intercepted here rather than at the broker.',
    regulatoryBasis: 'SEC Rule 15c3-5(c)(1)(i) — Control 4, intraday margin; FINRA Rule 4210',
  },
  {
    code: 'ORDER_MESSAGE_RATE',
    label: 'Order messages per second per user',
    value: ORDER_MESSAGES_PER_SECOND_PER_USER,
    unit: 'messages_per_second',
    rationale:
      'Sliding-second throttle keyed on user ID. Prevents repeated Execute clicks under network latency, or a script, from flooding the downstream broker-dealer.',
    regulatoryBasis: 'SEC Rule 15c3-5(c)(1)(i) — Control 5, message and execution throttles',
  },
  {
    code: 'MIN_QUANTITY',
    label: 'Minimum order quantity',
    value: MIN_QUANTITY,
    unit: 'shares',
    rationale:
      'Whole positive share counts only. Fractional or zero quantities are rejected rather than rounded, because the platform must never alter a user-supplied parameter.',
    regulatoryBasis: 'Neutral Tool defence — the user populates every order parameter',
  },
  {
    code: 'MAX_OPEN_ORDERS',
    label: 'Maximum concurrent open orders',
    value: MAX_OPEN_ORDERS,
    unit: 'count',
    rationale:
      'Bounds the worst-case unwind the kill switch has to perform, since cancellation is best-effort per resting order. Platform policy.',
    regulatoryBasis: 'SEC Rule 15c3-5(c)(1)(i) — Control 6, kill-switch recoverability',
  },
  {
    code: 'INTENT_TOKEN_TTL',
    label: 'Intent token lifetime',
    value: INTENT_TOKEN_TTL_MS,
    unit: 'milliseconds',
    rationale:
      'Single-use, single-security token minted at the millisecond of the physical Execute click. Short-lived so a valid token is contemporaneous proof of that click and cannot be stockpiled. Platform policy.',
    regulatoryBasis: 'Investment Advisers Act §202(a)(11)(D); In re Weiss Research (2006) — no auto-execution',
  },
  {
    code: 'KILL_SWITCH_STATUS',
    label: 'Response status while the kill switch is engaged',
    value: KILL_SWITCH_HTTP_STATUS,
    unit: 'http_status',
    rationale:
      'Every inbound routing request is shed with 503 Service Unavailable the instant an administrator engages the switch — no deploy, no restart.',
    regulatoryBasis: 'SEC Rule 15c3-5(c)(1)(i) — Control 6, Global Kill Switch',
  },
];

/** Descriptor lookup for the limits panel and the rejection detail views. */
export function riskLimitDescriptor(code: RiskLimitCode): RiskLimitDescriptor | undefined {
  return RISK_LIMIT_DESCRIPTORS.find((d) => d.code === code);
}
