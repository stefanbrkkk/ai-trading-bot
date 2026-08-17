/**
 * Per-trade cryptographic intent tokens.
 *
 * This is the mechanism that keeps the platform inside the Publisher's Exemption
 * (Investment Advisers Act §202(a)(11)(D)) and out of In re Weiss Research
 * (SEC 2006, Admin. Proc. IA-2525), where auto-trading published recommendations
 * without per-trade manual approval was held to constitute investment
 * discretion. The mandate's rule is mechanical: "every API call must only be
 * initiated by a verified HTTP request originating from a client-side user
 * session, carrying a unique, time-stamped cryptographic token generated at the
 * exact millisecond the user clicks 'Execute' or 'Confirm Route'."
 *
 * Four properties are enforced, and all four are load-bearing:
 *
 *   1. AUTHENTIC   — HMAC-SHA256 over the payload, verified with a timing-safe
 *                    comparison. An unsigned or tampered token authorises nothing.
 *   2. FRESH       — the click timestamp must be within INTENT_TOKEN_TTL_MS, so a
 *                    valid token is contemporaneous evidence of a physical click
 *                    and cannot be stockpiled for later unattended routing.
 *   3. SINGLE-USE  — the nonce is consumed through a port, so one click routes at
 *                    most one order.
 *   4. SINGLE-SECURITY, PARAMETER-BOUND — the token names exactly one symbol,
 *                    side, quantity and order type. A token minted for 10 shares
 *                    of AAPL cannot authorise 1,000 shares of anything, which is
 *                    what makes a "trade all five picks" batch route impossible
 *                    to construct even by a caller inside the platform.
 *
 * The token is minted server-side from the click's millisecond stamp rather than
 * in the browser, because the signing key must never reach a client. The click
 * handler mints on the physical click; the submission then presents the token.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { OrderSide, OrderType } from '@/lib/domain/types';
import { INTENT_TOKEN_FUTURE_SKEW_MS, INTENT_TOKEN_TTL_MS } from '@/lib/risk/limits';
import { InMemoryIntentNonceStore, type IntentNoncePort } from '@/lib/risk/ports';

/** Token format version, so a future key or layout change is distinguishable. */
export const INTENT_TOKEN_VERSION = 'v1';

export interface IntentTokenPayload {
  userId: string;
  /** Exactly one security per token — never a basket. */
  symbol: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  /** Millisecond-precision instant of the physical Execute click. */
  clickTsMs: number;
  /** Single-use marker. */
  nonce: string;
}

/**
 * Environment variable holding the signing secret. Absent in development, which
 * BUILD_CONTRACT requires to work: the fallback below keeps token minting and
 * verification fully functional with an empty `.env`.
 */
export const INTENT_TOKEN_SECRET_ENV = 'AURELIUS_SESSION_SECRET';

/**
 * Per-process fallback secret, generated once and never written down.
 *
 * The fallback used to be a fixed, published constant, on the reasoning that a
 * value which cannot be mistaken for a secret is safer than one that might be.
 * That reasoning is wrong here, and the audit demonstrated why: the platform is
 * built to run with an empty `.env`, so the published constant is the *default*
 * signing key, and the whole HMAC — `version|userId|symbol|side|quantity|…` — can
 * be reproduced offline from the repository. Anyone able to reach
 * `/api/orders/submit` could mint a token that verifies, which defeats the single
 * control the entire no-discretion posture rests on: that every routed order
 * carries proof of a physical Execute click.
 *
 * 32 random bytes per process keeps the empty-`.env` path working — mint and
 * verify happen in the same process — while making the key unguessable. Tokens do
 * not survive a restart, which is correct for a single-use credential with a
 * 60-second lifetime, and `usingFallbackSecret()` still reports that no durable
 * secret is configured so an operator can see it before going live.
 */
const EPHEMERAL_SECRET = randomBytes(32).toString('base64url');

function resolveSecret(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const fromEnv = process.env[INTENT_TOKEN_SECRET_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return EPHEMERAL_SECRET;
}

/** True when the deterministic development secret is in force. */
export function usingFallbackSecret(): boolean {
  const fromEnv = process.env[INTENT_TOKEN_SECRET_ENV];
  return fromEnv === undefined || fromEnv.length === 0;
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

/**
 * Field delimiter for the signing string. A NUL is used because it cannot occur
 * in a symbol, side, order type or user id, which is what makes the encoding
 * unambiguous — with a printable separator, `symbol='AAPL'` + `side='buy'` and
 * `symbol='AAPL|buy'` would produce the same signing string and therefore the
 * same signature.
 */
const FIELD_SEPARATOR = '\u0000';

/** Canonical signing input: fixed field order, unambiguous delimiter. */
function canonical(payload: IntentTokenPayload): string {
  return [
    INTENT_TOKEN_VERSION,
    payload.userId,
    payload.symbol.toUpperCase(),
    payload.side,
    String(payload.quantity),
    payload.orderType,
    String(payload.clickTsMs),
    payload.nonce,
  ].join(FIELD_SEPARATOR);
}

function sign(payload: IntentTokenPayload, secret: string): Buffer {
  return createHmac('sha256', secret).update(canonical(payload)).digest();
}

/**
 * Deterministic nonce for a click.
 *
 * Derived from the exact click parameters rather than drawn at random: the
 * BUILD_CONTRACT bans unseeded randomness, and the derivation has a useful
 * property of its own — two clicks with identical parameters at the identical
 * millisecond derive the same nonce, so the second is caught as a replay. That
 * is precisely the double-submit-under-latency case the single-use rule exists
 * to stop.
 */
export function deriveNonce(input: {
  userId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  clickTsMs: number;
  /** Optional discriminator when a caller genuinely needs two distinct tokens. */
  salt?: string;
}): string {
  const parts = [
    input.userId,
    input.symbol.toUpperCase(),
    input.side,
    String(input.quantity),
    input.orderType,
    String(input.clickTsMs),
    input.salt ?? '',
  ].join(FIELD_SEPARATOR);
  return createHmac('sha256', 'aurelius-intent-nonce').update(parts).digest('hex').slice(0, 32);
}

export interface MintOptions {
  /** Overrides the environment secret; used by the test suite. */
  secret?: string;
}

export interface MintedIntentToken {
  token: string;
  payload: IntentTokenPayload;
  /** Wall-clock instant after which verification refuses the token. */
  expiresAtMs: number;
}

/**
 * Mints a token at the millisecond of the click.
 *
 * `clickTsMs` is the physical click instant supplied by the client, not the
 * server's own clock, because the mandate ties the token to the click and the
 * audit trail has to show the click preceding the transmission.
 */
export function mintIntentToken(
  input: {
    userId: string;
    symbol: string;
    side: OrderSide;
    quantity: number;
    orderType: OrderType;
    clickTsMs: number;
    nonce?: string;
  },
  options: MintOptions = {},
): MintedIntentToken {
  const payload: IntentTokenPayload = {
    userId: input.userId,
    symbol: input.symbol.toUpperCase(),
    side: input.side,
    quantity: input.quantity,
    orderType: input.orderType,
    clickTsMs: input.clickTsMs,
    nonce: input.nonce ?? deriveNonce(input),
  };
  const secret = resolveSecret(options.secret);
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = base64url(sign(payload, secret));
  return {
    token: `${INTENT_TOKEN_VERSION}.${body}.${signature}`,
    payload,
    expiresAtMs: input.clickTsMs + INTENT_TOKEN_TTL_MS,
  };
}

export type IntentTokenFailure =
  | 'MALFORMED'
  | 'UNSUPPORTED_VERSION'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'CLOCK_SKEW'
  | 'PARAMETER_MISMATCH'
  | 'REPLAYED';

export interface IntentTokenVerification {
  valid: boolean;
  failure: IntentTokenFailure | null;
  /** Populated once the signature verifies, so the ledger can log what was presented. */
  payload: IntentTokenPayload | null;
  /** Which order parameter diverged, when `failure` is PARAMETER_MISMATCH. */
  mismatchedField: keyof IntentTokenPayload | null;
  /** Age of the click at verification time, in milliseconds. */
  ageMs: number | null;
}

/** The submitted order the token has to match, exactly. */
export interface IntentTokenExpectation {
  userId: string;
  symbol: string;
  side: OrderSide;
  quantity: number | null;
  orderType: OrderType;
}

export interface VerifyOptions {
  secret?: string;
  /** Injectable clock; defaults to wall time. */
  now?: number;
  /** Single-use ledger. Defaults to a process-local store. */
  nonces?: IntentNoncePort;
  ttlMs?: number;
  futureSkewMs?: number;
  /**
   * Set false to inspect a token without spending it — used by read-only
   * surfaces such as the pre-flight preview. The order route must never set it.
   */
  consume?: boolean;
}

/** Process-local nonce ledger so verification is single-use out of the box. */
const defaultNonces = new InMemoryIntentNonceStore();

function fail(
  failure: IntentTokenFailure,
  payload: IntentTokenPayload | null,
  extra: { mismatchedField?: keyof IntentTokenPayload; ageMs?: number } = {},
): IntentTokenVerification {
  return {
    valid: false,
    failure,
    payload,
    mismatchedField: extra.mismatchedField ?? null,
    ageMs: extra.ageMs ?? null,
  };
}

function decodePayload(body: string): IntentTokenPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64url(body).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.userId !== 'string' ||
    typeof candidate.symbol !== 'string' ||
    (candidate.side !== 'buy' && candidate.side !== 'sell') ||
    typeof candidate.quantity !== 'number' ||
    typeof candidate.orderType !== 'string' ||
    typeof candidate.clickTsMs !== 'number' ||
    typeof candidate.nonce !== 'string'
  ) {
    return null;
  }
  if (
    candidate.orderType !== 'market' &&
    candidate.orderType !== 'limit' &&
    candidate.orderType !== 'stop' &&
    candidate.orderType !== 'stop_limit'
  ) {
    return null;
  }
  return {
    userId: candidate.userId,
    symbol: candidate.symbol,
    side: candidate.side,
    quantity: candidate.quantity,
    orderType: candidate.orderType,
    clickTsMs: candidate.clickTsMs,
    nonce: candidate.nonce,
  };
}

/**
 * Verifies a token against the order actually submitted.
 *
 * Check order matters. Signature and freshness come first because they are
 * cheap and cannot be influenced by the submitted body. Parameter matching comes
 * next. The nonce is consumed *last*, once the token is known to be authentic,
 * fresh and correctly scoped, so a rejected submission does not burn a token the
 * user legitimately holds — while a genuine replay, which passes every earlier
 * check, still fails here.
 */
export function verifyIntentToken(
  token: string,
  expected: IntentTokenExpectation,
  options: VerifyOptions = {},
): IntentTokenVerification {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? INTENT_TOKEN_TTL_MS;
  const skewMs = options.futureSkewMs ?? INTENT_TOKEN_FUTURE_SKEW_MS;

  if (typeof token !== 'string' || token.length === 0) return fail('MALFORMED', null);
  const parts = token.split('.');
  if (parts.length !== 3) return fail('MALFORMED', null);
  const [version, body, signature] = parts;
  if (version !== INTENT_TOKEN_VERSION) return fail('UNSUPPORTED_VERSION', null);

  const payload = decodePayload(body);
  if (payload === null) return fail('MALFORMED', null);

  const secret = resolveSecret(options.secret);
  const presented = fromBase64url(signature);
  const computed = sign(payload, secret);
  // Length is compared first because timingSafeEqual throws on a length mismatch;
  // the length of an HMAC-SHA256 digest is public, so this leaks nothing.
  if (presented.length !== computed.length || !timingSafeEqual(presented, computed)) {
    return fail('BAD_SIGNATURE', null);
  }

  const ageMs = now - payload.clickTsMs;
  if (ageMs < -skewMs) return fail('CLOCK_SKEW', payload, { ageMs });
  if (ageMs > ttlMs) return fail('EXPIRED', payload, { ageMs });

  if (payload.userId !== expected.userId) {
    return fail('PARAMETER_MISMATCH', payload, { mismatchedField: 'userId', ageMs });
  }
  if (payload.symbol !== expected.symbol.toUpperCase()) {
    return fail('PARAMETER_MISMATCH', payload, { mismatchedField: 'symbol', ageMs });
  }
  if (payload.side !== expected.side) {
    return fail('PARAMETER_MISMATCH', payload, { mismatchedField: 'side', ageMs });
  }
  if (payload.orderType !== expected.orderType) {
    return fail('PARAMETER_MISMATCH', payload, { mismatchedField: 'orderType', ageMs });
  }
  if (expected.quantity === null || payload.quantity !== expected.quantity) {
    return fail('PARAMETER_MISMATCH', payload, { mismatchedField: 'quantity', ageMs });
  }

  if (options.consume !== false) {
    const store = options.nonces ?? defaultNonces;
    if (!store.consume(payload.nonce, payload.clickTsMs + ttlMs)) {
      return fail('REPLAYED', payload, { ageMs });
    }
  }

  return { valid: true, failure: null, payload, mismatchedField: null, ageMs };
}

/**
 * Human-readable reason for a token failure.
 *
 * The copy is deliberately sterile and mechanical — the mandate requires the
 * interface to read like a terminal, with no behavioural nudging — and it never
 * blames the user for a control the platform chose to impose.
 */
export function intentTokenFailureMessage(failure: IntentTokenFailure): string {
  switch (failure) {
    case 'MALFORMED':
      return 'Order authorisation token malformed. Re-submit from the order ticket.';
    case 'UNSUPPORTED_VERSION':
      return 'Order authorisation token version not recognised. Reload and re-submit.';
    case 'BAD_SIGNATURE':
      return 'Order authorisation token signature invalid. Order not transmitted.';
    case 'EXPIRED':
      return 'Order authorisation token expired. Each order requires a fresh Execute click.';
    case 'CLOCK_SKEW':
      return 'Order authorisation token timestamp is ahead of server time. Order not transmitted.';
    case 'PARAMETER_MISMATCH':
      return 'Order parameters do not match the authorised token. Order not transmitted.';
    case 'REPLAYED':
      return 'Order authorisation token already used. Each Execute click authorises one order.';
    default:
      return 'Order authorisation token rejected. Order not transmitted.';
  }
}
