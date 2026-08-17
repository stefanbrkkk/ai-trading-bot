/**
 * Regulatory disclosure and terms text.
 *
 * The four risk-disclosure blocks and the acceptance label are reproduced
 * **verbatim** from the compliance research. They are not paraphrased, not
 * softened, and not shortened, because the whole point of the clickwrap gate is
 * that the user assented to this exact wording. Changing a word changes what was
 * agreed, so the version identifier below must be bumped whenever any of it
 * changes and the store keeps the accepted version per user.
 *
 * Presentation requirements (Phase 5 §3): the blocks render in capitalised, bold
 * type to meet the legal standard for conspicuousness, the copy is stark and
 * devoid of marketing jargon, and the acceptance checkbox stays disabled until
 * the user has scrolled to the absolute bottom.
 */

export const TOS_VERSION = '2026-01-15';
export const PRIVACY_VERSION = '2026-01-15';
export const RISK_DISCLOSURES_VERSION = '2026-01-15';

/** Trailing window over which the aggregate liability cap is computed. */
export const LIABILITY_CAP_MONTHS = 3;

export interface DisclosureBlock {
  id: 'publisher_status' | 'ai_error' | 'total_loss' | 'neutral_tool';
  /** Heading, exactly as the research names it. */
  title: string;
  /** Verbatim body text. */
  body: string;
}

/**
 * The four mandated disclosure categories: No Fiduciary Duty / Publisher Status,
 * AI Hallucination & Algorithmic Error, Market Volatility & Total Loss, and
 * Neutral Tool Acknowledgment.
 */
export const DISCLOSURE_BLOCKS: DisclosureBlock[] = [
  {
    id: 'publisher_status',
    title: 'No Fiduciary Duty / Publisher Status',
    body:
      'The Platform is strictly an educational data-processing software utility. The Platform does not provide ' +
      'personalized investment advice, financial planning, or tax advice. The Platform is NOT a Registered Investment ' +
      "Adviser, broker-dealer, or fiduciary. The data outputs, including 'Top 5' algorithmic lists, are purely " +
      'impersonal mathematical computations based on historical data and do not account for your individual financial ' +
      'situation, risk tolerance, or investment objectives.',
  },
  {
    id: 'ai_error',
    title: 'AI Hallucination & Algorithmic Error',
    body:
      'The Platform utilizes experimental machine learning algorithms to process market data. Users explicitly ' +
      "acknowledge that Artificial Intelligence systems are inherently subject to 'hallucinations,' calculation " +
      'errors, data lag, and logic failures. The algorithms may generate outputs that are entirely incorrect, ' +
      'irrational, or financially disastrous. The Platform makes no representations regarding the accuracy, ' +
      'reliability, or profitability of the algorithms.',
  },
  {
    id: 'total_loss',
    title: 'Market Volatility & Total Loss',
    body:
      'Securities trading involves substantial risk of catastrophic loss. Financial markets are subject to extreme ' +
      'volatility, flash crashes, and liquidity constraints. Users acknowledge that the value of any security can go ' +
      'to zero. The user assumes 100% of the financial risk associated with routing orders based on the Platform’s data.',
  },
  {
    id: 'neutral_tool',
    title: 'Neutral Tool Acknowledgment',
    body:
      'The Platform acts solely as a neutral routing technology. The user maintains absolute discretion and control ' +
      'over all trading decisions. The user is solely responsible for verifying all order parameters, including ' +
      'ticker symbol, quantity, and limit prices, prior to manual execution.',
  },
];

/** The checkbox label. Verbatim; the checkbox starts unchecked and disabled. */
export const ACCEPTANCE_LABEL =
  'I have read, understand, and explicitly agree to be bound by the Terms of Service and Risk Disclosures.';

/** The limitation-of-liability and market-data clause, verbatim. */
export const LIABILITY_CLAUSE =
  'The Operator shall not be liable for any damages incurred by Users arising from delays, failures, or errors in API ' +
  'routing, downstream broker-dealer outages, or the inaccuracy of third-party market data feeds. I understand that ' +
  'neither the Platform nor any supplier of market data guarantees the timeliness, sequence, accuracy, completeness, or ' +
  "reliability of market information or messages disseminated. In no event shall the platform's aggregate liability for " +
  'any claims exceed the total subscription fees paid by the user in the three (3) months preceding the event giving ' +
  'rise to the claim.';

export interface TosClause {
  id: string
  title: string;
  body: string;
  /** The regulatory or contractual reason this clause exists. */
  basis: string;
}

/**
 * The Terms of Service clause list. Each clause exists because the compliance
 * research names it as required, and each carries the reason so a reader can
 * audit the terms against the mandate rather than taking them on faith.
 */
export const TOS_CLAUSES: TosClause[] = [
  {
    id: 'as_is',
    title: 'Provision AS IS and AS AVAILABLE',
    body:
      'The Platform is provided on an AS IS and AS AVAILABLE basis, without warranty of any kind. The Operator ' +
      'disclaims all express and implied warranties, including the implied warranties of merchantability, fitness for a ' +
      'particular purpose, non-infringement, and uninterrupted or error-free availability.',
    basis:
      'Required to prevent an implied warranty of profitability or availability attaching to algorithmic output.',
  },
  {
    id: 'not_an_adviser',
    title: 'No advisory relationship',
    body:
      'Nothing in the Platform creates an advisory, fiduciary, agency, or brokerage relationship between the Operator ' +
      'and the User. The Operator does not exercise authority over User funds, holds no discretion over User accounts, ' +
      'and does not accept instructions to trade on a User’s behalf. All output is impersonal and is distributed ' +
      'identically to every subscriber on a fixed schedule.',
    basis:
      "Invokes the Publisher's Exemption, Section 202(a)(11)(D) of the Investment Advisers Act of 1940, under the " +
      'three-prong test of Lowe v. SEC (1985): impersonal, bona fide, and of general and regular circulation.',
  },
  {
    id: 'no_discretion',
    title: 'No discretionary or automated execution',
    body:
      'The Platform will never submit an order without a contemporaneous, affirmative action by the User for that ' +
      'specific security. There is no automated execution facility, no standing instruction, and no mechanism by which ' +
      'published output can be routed to a broker without the User’s individual click.',
    basis:
      'In the Matter of Weiss Research, Inc. (SEC 2006) held that auto-trading published recommendations constitutes ' +
      "investment discretion and categorically defeats the Publisher's Exemption.",
  },
  {
    id: 'no_position_sizing',
    title: 'No position sizing or allocation advice',
    body:
      'The Platform does not read, evaluate, or consider the User’s account balance, buying power, holdings, income, ' +
      'age, or risk tolerance, and will not suggest a quantity, allocation percentage, or dollar amount for any order.',
    basis:
      'Reading an account balance to suggest an allocation crosses from impersonal publication into personalised ' +
      'advice and would void the exemption under Lowe.',
  },
  {
    id: 'liability_cap',
    title: 'Limitation of liability',
    body: LIABILITY_CLAUSE,
    basis:
      'Caps aggregate exposure at the trailing three months of subscription fees, the only backstop available once ' +
      'broker API agreements require the Operator to indemnify the broker.',
  },
  {
    id: 'market_data',
    title: 'Third-party market data',
    body:
      'Market data, corporate filings, and alternative data are obtained from third parties and are provided without ' +
      'warranty as to timeliness, sequence, accuracy, completeness, or reliability. The Operator is not liable for any ' +
      'loss arising from an inaccuracy, delay, or interruption in a third-party feed.',
    basis: 'Required disclaimer for redistributed market data.',
  },
  {
    id: 'arbitration',
    title: 'Mandatory binding arbitration',
    body:
      'Any dispute arising out of or relating to the Platform shall be resolved exclusively by final and binding ' +
      'individual arbitration administered by the American Arbitration Association (AAA) or JAMS under its ' +
      'then-current rules. The User waives any right to a trial by jury or by a judge.',
    basis: 'Confines a localised failure to individual arbitration rather than public litigation.',
  },
  {
    id: 'class_waiver',
    title: 'Class action waiver',
    body:
      'The User agrees to bring any claim solely in the User’s individual capacity and not as a plaintiff or class ' +
      'member in any purported class, collective, consolidated, or representative proceeding.',
    basis:
      'Prevents a single API failure affecting many users from becoming a class action, which the research identifies ' +
      'as the principal solvency risk to the Operator.',
  },
  {
    id: 'ai_capability',
    title: 'Accurate description of AI capability',
    body:
      'The Operator makes no claim of guaranteed returns, unbeatable performance, or risk-free machine learning. The ' +
      'model card published within the Platform states the model’s architecture, training data, measured performance, ' +
      'and known limitations, and is the authoritative description of what the algorithms do.',
    basis:
      'SEC "AI washing" enforcement (Delphia; Global Predictions) penalises advertising AI capability a firm cannot ' +
      'substantiate. Marketing must match the model card.',
  },
  {
    id: 'audit',
    title: 'Immutable audit trail',
    body:
      'Every interaction that results in an order is recorded in an append-only ledger, including the authenticated ' +
      'user, a millisecond-precision timestamp, the originating IP address and browser user agent, the coordinates of ' +
      'the physical click, the exact payload transmitted to the broker, and the broker’s response status and body. ' +
      'These records cannot be modified or deleted.',
    basis:
      'Evidentiary requirement for proving the Platform acted as a neutral conduit for user-directed commands; a ' +
      'mutable log is worthless in discovery.',
  },
  {
    id: 'termination',
    title: 'Suspension and the global kill switch',
    body:
      'The Operator may halt all outbound order routing platform-wide at any time, without notice, in response to ' +
      'algorithmic malfunction, corrupted market data, or disorderly market conditions. While halted, order requests ' +
      'are rejected and pending orders are cancelled where the broker permits.',
    basis: 'FINRA/SEC Rule 15c3-5 requires a market-access kill switch as a condition of broker API access.',
  },
];

/** Prohibited phrasings, kept here so the compliance page can publish them. */
export const PROHIBITED_COPY_EXAMPLES: { phrase: string; reason: string }[] = [
  { phrase: 'We recommend you buy X', reason: 'A recommendation makes the Platform an adviser.' },
  { phrase: 'X is the optimal choice', reason: 'Implies a suitability judgement about a specific user.' },
  { phrase: 'X is perfectly suited for your portfolio', reason: 'Personalised advice; voids the exemption.' },
  { phrase: 'Automatically trade the daily Top 5 picks', reason: 'The exact control that triggered SEC enforcement in Weiss Research.' },
  { phrase: 'Guaranteed returns', reason: 'AI-washing and anti-fraud exposure.' },
  { phrase: 'Unbeatable AI', reason: 'Unsubstantiable capability claim.' },
  { phrase: 'Risk-free machine learning', reason: 'Unsubstantiable capability claim.' },
  { phrase: 'Best price / preferred route', reason: 'Assumes the broker-dealer duty of best execution.' },
];

/** The required neutral framing for the published list. */
export const NEUTRAL_FRAMING_TEMPLATE =
  "The algorithm's highest-scoring equities based on 30-day historical momentum parameters are X, Y, and Z.";

/** The six mandatory forensic audit fields, published so the record is auditable. */
export const MANDATORY_AUDIT_FIELDS: { field: string; purpose: string }[] = [
  { field: 'Unique user ID and cryptographic session token', purpose: 'Binds the action to an authenticated principal.' },
  { field: 'Millisecond-precision timestamp', purpose: 'Establishes sequence against broker and market events.' },
  { field: 'IP address and browser user agent', purpose: 'Corroborates the origin of the request.' },
  { field: 'UI click coordinates (X/Y) at the Execute click', purpose: 'Evidence of physical human intent rather than automation.' },
  { field: 'Raw outbound JSON payload', purpose: 'Proves exactly what was transmitted, field for field.' },
  { field: 'Broker HTTP status and response payload', purpose: 'Distinguishes a broker failure from a platform failure.' },
];

/** Error strings shown verbatim, because they are also logged as audit events. */
export const ERROR_COPY = {
  insufficientFunds: 'Insufficient Funds / Margin Limit Exceeded',
  brokerError: 'Broker API Error',
  killSwitch: 'Order routing is halted platform-wide. No orders can be submitted.',
  rateLimited: 'Order message rate limit exceeded. Wait a moment before resubmitting.',
} as const;

export interface DisclosureBundle {
  tosVersion: string;
  privacyVersion: string;
  riskDisclosuresVersion: string;
  blocks: DisclosureBlock[];
  acceptanceLabel: string;
  tosClauses: TosClause[];
  liabilityCapMonths: number;
  prohibitedCopy: { phrase: string; reason: string }[];
  auditFields: { field: string; purpose: string }[];
  neutralFraming: string;
}

export function disclosureBundle(): DisclosureBundle {
  return {
    tosVersion: TOS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    riskDisclosuresVersion: RISK_DISCLOSURES_VERSION,
    blocks: DISCLOSURE_BLOCKS,
    acceptanceLabel: ACCEPTANCE_LABEL,
    tosClauses: TOS_CLAUSES,
    liabilityCapMonths: LIABILITY_CAP_MONTHS,
    prohibitedCopy: PROHIBITED_COPY_EXAMPLES,
    auditFields: MANDATORY_AUDIT_FIELDS,
    neutralFraming: NEUTRAL_FRAMING_TEMPLATE,
  };
}

/** The privacy policy body, kept short and factual. */
export const PRIVACY_POLICY_SECTIONS: { title: string; body: string }[] = [
  {
    title: 'What is collected',
    body:
      'Account email and display name; a salted password hash (never the password); session tokens; the IP address and ' +
      'browser user agent of each request; and, for any order you submit, the click coordinates, timestamps, payload ' +
      'and broker response required by the audit obligations described in the Terms.',
  },
  {
    title: 'What is not collected',
    body:
      'The Platform does not ingest your brokerage holdings, balances, or buying power for the purpose of generating ' +
      'signals. The ranking model is blind to every user attribute; that blindness is a regulatory requirement, not a ' +
      'preference, and it is asserted in the test suite.',
  },
  {
    title: 'Retention',
    body:
      'Order and audit records are written to an append-only ledger and are retained indefinitely. They cannot be ' +
      'modified or deleted, including on request, because their evidentiary value depends on immutability.',
  },
  {
    title: 'Third parties',
    body:
      'Where you supply market-data, language-model, or broker API keys, requests are made directly to those providers ' +
      'under their own terms. With no keys configured, the Platform makes no outbound requests at all.',
  },
];
