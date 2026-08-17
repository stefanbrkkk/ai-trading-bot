/**
 * Risk subsystem barrel.
 *
 * The order route, the admin console and the limits endpoint all import from here
 * so that there is one published surface for the controls. Keeping it explicit
 * (rather than `export *`) makes the subsystem's public API reviewable: a
 * compliance reader can see every capability the rest of the application is able
 * to reach.
 */

// Limits — the enforced values and their published descriptors.
export {
  ADV_LOOKBACK_DAYS,
  ADV_PARTICIPATION_LIMIT,
  IDEMPOTENCY_WINDOW_MS,
  INTENT_TOKEN_FUTURE_SKEW_MS,
  INTENT_TOKEN_TTL_MS,
  KILL_SWITCH_HTTP_STATUS,
  MAINTENANCE_MARGIN_RATE,
  MAX_NOTIONAL_PER_ORDER_USD,
  MAX_NOTIONAL_PER_USER_PER_DAY_USD,
  MAX_OPEN_ORDERS,
  MIN_QUANTITY,
  ORDER_ENTRY_COLLAR_MULTIPLIER,
  ORDER_MESSAGES_PER_SECOND_PER_USER,
  PRICE_TOLERANCE_BANDS,
  RATE_LIMIT_HTTP_STATUS,
  RATE_LIMIT_WINDOW_MS,
  RISK_LIMIT_DESCRIPTORS,
  STOP_PRICE_SANITY_DEVIATION,
  limitPriceTolerance,
  riskLimitDescriptor,
} from '@/lib/risk/limits';
export type {
  PriceToleranceBand,
  RiskLimitCode,
  RiskLimitDescriptor,
  RiskLimitUnit,
} from '@/lib/risk/limits';

// Engine — the pre-trade decision.
export {
  RISK_ENGINE_SPIFFE_ID,
  RISK_REJECTION_LABELS,
  evaluateOrder,
  maxQuantityForAdv,
  nbboMid,
  notionalReferencePrice,
  orderNotionalUsd,
  priceCollarReference,
  priceDeviation,
  requiredCapitalUsd,
} from '@/lib/risk/engine';
export type {
  RiskEvaluationContext,
  RiskInstrumentContext,
  RiskSubscriptionContext,
} from '@/lib/risk/engine';

// Throttle — Control 5.
export {
  SlidingWindowRateLimiter,
  getOrderRateLimiter,
  rateLimitMessage,
  setOrderRateLimiter,
} from '@/lib/risk/rateLimit';
export type { RateLimitDecision, RateLimiterOptions } from '@/lib/risk/rateLimit';

// Kill switch — Control 6.
export { KillSwitch, getKillSwitch, isKillSwitchEngaged, setKillSwitch } from '@/lib/risk/killSwitch';
export type {
  CancellationAttempt,
  KillSwitchDeps,
  KillSwitchEngagement,
  KillSwitchOrderCanceller,
} from '@/lib/risk/killSwitch';

// Intent tokens — the per-trade affirmative-action gate.
export {
  INTENT_TOKEN_SECRET_ENV,
  INTENT_TOKEN_VERSION,
  deriveNonce,
  intentTokenFailureMessage,
  mintIntentToken,
  usingFallbackSecret,
  verifyIntentToken,
} from '@/lib/risk/intentToken';
export type {
  IntentTokenExpectation,
  IntentTokenFailure,
  IntentTokenPayload,
  IntentTokenVerification,
  MintedIntentToken,
  MintOptions,
  VerifyOptions,
} from '@/lib/risk/intentToken';

// Telemetry — the six mandatory audit fields and zero-trust correlation.
export {
  ADMIN_CONSOLE_SPIFFE_ID,
  BROKER_ERROR_MESSAGE,
  INSUFFICIENT_FUNDS_MESSAGE,
  INTENT_TOKEN_SPIFFE_ID,
  MAX_STORED_BROKER_BODY_CHARS,
  ORDER_ROUTER_SPIFFE_ID,
  RATE_LIMITER_SPIFFE_ID,
  SERVICE_UNAVAILABLE_MESSAGE,
  SPIFFE_NAMESPACE,
  SPIFFE_TRUST_DOMAIN,
  SVID_TTL_MS,
  boundBrokerBody,
  correlationId,
  issueSvid,
  orderCorrelationId,
  recordErrorPresentation,
  recordOrderTelemetry,
  serialiseOutboundPayload,
  spiffeId,
} from '@/lib/risk/telemetry';
export type {
  ErrorPresentationInput,
  OrderTelemetryInput,
  TelemetryService,
} from '@/lib/risk/telemetry';

// Persistence ports and their in-memory defaults.
export {
  InMemoryDailyNotionalStore,
  InMemoryIdempotencyStore,
  InMemoryIntentNonceStore,
  InMemoryKillSwitchStore,
  InMemoryPendingOrderStore,
  InMemoryRiskAudit,
} from '@/lib/risk/ports';
export type {
  AdminActionEntry,
  AdminActionType,
  DailyNotionalPort,
  ErrorPresentationEntry,
  IdempotencyPort,
  IntentNoncePort,
  KillSwitchPersistedState,
  KillSwitchStatePort,
  OrderTelemetryRecord,
  PendingOrderPort,
  PendingOrderRef,
  RateLimitRejectionEntry,
  RiskAuditPort,
  RiskDecisionAuditEntry,
  SvidIssuanceEntry,
} from '@/lib/risk/ports';
