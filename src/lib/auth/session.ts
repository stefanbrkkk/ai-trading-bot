/**
 * Authentication and session handling.
 *
 * Self-contained by design: no identity provider, no OAuth round trip, no
 * external dependency. Passwords are hashed with scrypt from `node:crypto`, and
 * sessions are opaque random tokens stored in the append-only ledger and carried
 * in an HttpOnly cookie. That keeps the "runs with an empty .env" guarantee true
 * for authentication as well as for market data.
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import {
  createSession,
  findActiveSession,
  findUserByEmail,
  findUserById,
  getUserCredentials,
  insertAuditEvent,
  recordTosAcceptance,
  revokeSession,
  touchSession,
  upsertSubscription,
  upsertUser,
} from '@/lib/db';
import { RISK_DISCLOSURES_VERSION, TOS_VERSION } from '@/lib/compliance/disclosures';
import type { ClickProvenance, User } from '@/lib/domain/types';

export const SESSION_COOKIE = 'aurelius_session';
/** Sessions last 14 days, matching the paper-sandbox trial length. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** The specified trial window for the paper sandbox. */
export const TRIAL_DAYS = 14;
/** Subscription price, in cents. Specified as $200/month. */
/**
 * Published monthly price, in cents.
 *
 * Validated rather than coerced: `Number('abc')` is `NaN`, and this is a
 * module-level constant, so a typo in `AURELIUS_PRICE_USD_MONTH` baked `NaN` into
 * the persisted subscription record, the liability-cap arithmetic and the price
 * shown on the portfolio page — with nothing anywhere reporting a bad value.
 */
export const PRICE_CENTS = resolvePriceCents(process.env.AURELIUS_PRICE_USD_MONTH);

function resolvePriceCents(raw: string | undefined): number {
  const DEFAULT_USD = 200;
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return DEFAULT_USD * 100;
  const usd = Number(trimmed);
  if (!Number.isFinite(usd) || usd < 0) {
    console.warn(
      `[aurelius] AURELIUS_PRICE_USD_MONTH="${trimmed}" is not a non-negative number; using $${DEFAULT_USD}.`,
    );
    return DEFAULT_USD * 100;
  }
  return Math.round(usd * 100);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Secrets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The signing secret. A blank `AURELIUS_SESSION_SECRET` derives a deterministic
 * development value rather than failing to boot — the platform must run with an
 * empty environment. `secretIsEphemeral()` reports the difference so the control
 * centre can say so plainly instead of implying production-grade secrecy.
 */
export function sessionSecret(): string {
  const configured = process.env.AURELIUS_SESSION_SECRET;
  if (configured && configured.length >= 32) return configured;
  return createHmac('sha256', 'aurelius-development-session-secret')
    .update(process.env.AURELIUS_SEED ?? '20240117')
    .digest('hex');
}

export function secretIsEphemeral(): boolean {
  const configured = process.env.AURELIUS_SESSION_SECRET;
  return !configured || configured.length < 32;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Password hashing
// ─────────────────────────────────────────────────────────────────────────────

const SCRYPT_KEYLEN = 64;
/** N=2^15, r=8, p=1 — OWASP's floor for interactive logins. */
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  const expected = Buffer.from(hash, 'hex');
  // Length check first: timingSafeEqual throws on a mismatch, which would leak
  // through an exception rather than through timing.
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export interface PasswordPolicyResult {
  ok: boolean;
  problems: string[];
}

/**
 * Password policy. Length-first, because length dominates entropy; a composition
 * rule on a 12-character minimum adds little and drives users to predictable
 * substitutions.
 */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  const problems: string[] = [];
  if (password.length < 12) problems.push('Use at least 12 characters.');
  if (password.length > 200) problems.push('Use at most 200 characters.');
  if (/^\s|\s$/.test(password)) problems.push('Remove leading or trailing whitespace.');
  if (/^(.)\1+$/.test(password)) problems.push('Use more than one distinct character.');
  const common = ['password', '123456', 'qwerty', 'letmein', 'aurelius', 'trading'];
  if (common.some((c) => password.toLowerCase().includes(c))) {
    problems.push('Avoid common words such as "password" or the product name.');
  }
  return { ok: problems.length === 0, problems };
}

export function isValidEmail(email: string): boolean {
  // Deliberately permissive: the goal is to reject obvious typos, not to
  // re-implement RFC 5322.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Request context
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestContext {
  ipAddress: string;
  userAgent: string;
}

/**
 * Whether forwarding headers may be believed.
 *
 * They may not, by default. `X-Forwarded-For` and its cousins are written by the
 * client and rewritten by each hop, so a deployment that trusts them without a
 * proxy in front is letting the caller choose their own identity. That is not an
 * abstract concern here: the value is both the rate-limiter's bucket key and the
 * `ip_address` column in the audit ledger. Rotating `X-Real-IP: 1.2.3.<n>` gave
 * every request of a credential-stuffing run its own fresh ten-per-minute
 * budget, and let the attacker dictate what the compliance record said about
 * them.
 *
 * Set `AURELIUS_TRUST_PROXY=1` only when the app genuinely sits behind a proxy
 * that overwrites these headers (Vercel, Cloudflare, an ingress controller).
 */
const TRUST_PROXY_HEADERS = ['1', 'true', 'yes'].includes(
  (process.env.AURELIUS_TRUST_PROXY ?? '').trim().toLowerCase(),
);

/**
 * The IP and user agent, which are two of the six mandatory audit fields.
 *
 * Falls back to a marker rather than an empty string, so an audit row never looks
 * like it simply failed to record the field.
 *
 * On a deployment without `AURELIUS_TRUST_PROXY` — which is the documented
 * default, and the shape the platform ships in — that marker is what the address
 * field records on every row, without exception: there is no attacker-independent
 * address available to a Next route handler, and the alternative is writing down
 * whatever the caller typed into a header. Anything the platform publishes about
 * this field has to say so, which is why the mandatory-audit-field descriptor in
 * `@/lib/compliance/disclosures` states the "unattributed" case in the same
 * sentence as the field itself.
 */
export async function requestContext(): Promise<RequestContext> {
  const h = await headers();
  if (!TRUST_PROXY_HEADERS) {
    // Next.js does not expose the socket address to a route handler, so with no
    // trusted proxy there is no attacker-independent address to record. Saying
    // so is honest; recording a value the caller chose is not.
    return { ipAddress: 'unattributed', userAgent: h.get('user-agent') ?? 'unavailable' };
  }
  const forwarded = h.get('x-forwarded-for');
  const ip =
    h.get('cf-connecting-ip') ??
    h.get('x-real-ip') ??
    (forwarded ? (forwarded.split(',')[0] ?? '').trim() : '') ??
    '';
  return {
    ipAddress: ip.length > 0 ? ip : 'unavailable',
    userAgent: h.get('user-agent') ?? 'unavailable',
  };
}


/**
 * Writes one audit row. Every authentication event is auditable, and centralising
 * the write means the SPIFFE identity and the six mandatory fields are supplied
 * consistently rather than at each call site.
 */
function recordAudit(
  eventType: string,
  userId: string | null,
  ctx: RequestContext,
  detail: Record<string, unknown>,
  click: { clickX: number; clickY: number } | null = null,
): void {
  insertAuditEvent({
    eventType,
    userId,
    sessionToken: null,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    clickX: click?.clickX ?? null,
    clickY: click?.clickY ?? null,
    resource: null,
    orderId: null,
    rawPayload: Object.keys(detail).length > 0 ? JSON.stringify(detail) : null,
    brokerStatus: null,
    brokerBody: null,
    spiffeId: AUTH_SPIFFE_ID,
    correlationId: null,
  });
}

/** SPIFFE identity of the authentication service, for zero-trust log correlation. */
export const AUTH_SPIFFE_ID = 'spiffe://aurelius.local/ns/platform/sa/auth';

// ─────────────────────────────────────────────────────────────────────────────
//  Session lifecycle
// ─────────────────────────────────────────────────────────────────────────────

function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface SignUpInput {
  email: string;
  password: string;
  displayName?: string;
}

export interface AuthResult {
  ok: boolean;
  user?: User;
  error?: string;
}

/**
 * Creates an account and starts the 14-day paper sandbox. Live routing stays
 * locked: it requires both an accepted clickwrap and an active subscription.
 */
export async function signUp(input: SignUpInput): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();
  if (!isValidEmail(email)) return { ok: false, error: 'Enter a valid email address.' };
  const policy = checkPasswordPolicy(input.password);
  if (!policy.ok) return { ok: false, error: policy.problems.join(' ') };
  if (findUserByEmail(email)) return { ok: false, error: 'An account already exists for that email address.' };

  const { hash, salt } = hashPassword(input.password);
  /*
   * No admin bootstrap unless the operator asked for one, by name.
   *
   * This used to fall back to `admin@aurelius.local` — the same address printed
   * in `.env.example` — and signup is open and unauthenticated. On a deployment
   * running the documented empty `.env`, the first person to POST that address
   * to /api/auth/signup was minted an administrator: the platform kill switch,
   * every user's forensic telemetry, and the live-routing entitlement grant. It
   * was a race the operator loses by default, because an attacker can register
   * before the operator gets round to it.
   *
   * An unset variable now means "this deployment has no admin", which is the
   * safe reading of silence. `AURELIUS_ADMIN_EMAIL` must be set deliberately,
   * and it is matched exactly.
   */
  const configuredAdmin = process.env.AURELIUS_ADMIN_EMAIL?.trim().toLowerCase();
  const isAdmin = configuredAdmin !== undefined && configuredAdmin.length > 0 && email === configuredAdmin;
  const now = Date.now();

  const user = upsertUser({
    email,
    displayName: input.displayName?.trim() || email.split('@')[0] || 'Trader',
    role: isAdmin ? 'admin' : 'trader',
    passwordHash: hash,
    passwordSalt: salt,
    liveTradingUnlocked: false,
    tosAcceptedAt: null,
    tosVersion: null,
    createdAt: now,
  });

  upsertSubscription({
    userId: user.id,
    status: 'trialing',
    trialEndsAt: now + TRIAL_DAYS * 24 * 60 * 60 * 1000,
    currentPeriodEnd: null,
    priceCents: PRICE_CENTS,
    provider: null,
    externalId: null,
  });

  await establishSession(user.id);
  const ctx = await requestContext();
  recordAudit('account_created', user.id, ctx, { email, role: user.role });

  return { ok: true, user: findUserById(user.id) ?? user };
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  const normalised = email.trim().toLowerCase();
  const user = findUserByEmail(normalised);
  const credentials = user ? getUserCredentials(user.id) : null;

  // Run the KDF even when the account does not exist, so a missing account and a
  // wrong password take the same time.
  const hash = credentials?.passwordHash ?? '00'.repeat(SCRYPT_KEYLEN);
  const salt = credentials?.passwordSalt ?? 'unusable-salt';
  const matches = verifyPassword(password, hash, salt);

  if (!user || !credentials?.passwordHash || !matches) {
    return { ok: false, error: 'Those credentials do not match an account.' };
  }

  await establishSession(user.id);
  const ctx = await requestContext();
  recordAudit('session_started', user.id, ctx, { email: normalised });
  return { ok: true, user };
}

async function establishSession(userId: string): Promise<string> {
  const token = newSessionToken();
  const ctx = await requestContext();
  createSession({
    token,
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return token;
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    const session = findActiveSession(token);
    revokeSession(token);
    if (session) {
      const ctx = await requestContext();
      recordAudit('session_ended', session.userId, ctx, {});
    }
  }
  store.delete(SESSION_COOKIE);
}

/** The authenticated user, or null. Safe to call from any Server Component. */
export async function currentUser(): Promise<User | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = findActiveSession(token);
  if (!session) return null;
  touchSession(token);
  return findUserById(session.userId);
}

export async function currentSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new AuthError('Sign in to continue.', 401);
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (user.role !== 'admin') throw new AuthError('This action requires an administrator.', 403);
  return user;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Clickwrap
// ─────────────────────────────────────────────────────────────────────────────

export interface AcceptTermsInput {
  scrolledToBottom: boolean;
  scrollDurationMs: number;
  click: ClickProvenance;
  tosVersion?: string;
  riskDisclosuresVersion?: string;
}

export interface AcceptTermsResult {
  ok: boolean;
  error?: string;
  brokerLinkingUnlocked?: boolean;
  acceptedAt?: number;
}

/**
 * Records clickwrap acceptance.
 *
 * `scrolledToBottom` and the click's `trusted` flag are attestations the browser
 * makes, and this function refuses an acceptance that does not carry both, so
 * they are always present in the record and an acceptance missing them is never
 * written. What the record establishes is that the client asserted a scrolled,
 * physically-clicked acceptance under an authenticated session, at a stated
 * time, against a stated version — durably and immutably.
 *
 * It does not establish that the presentation happened, and this docstring used
 * to say it did ("the server re-checks … rather than trusting the client's
 * word"). There is nothing here to re-check against: the values are read back
 * out of the same request body that asserted them, nothing binds the acceptance
 * to a fetch of the terms, and `scrollDurationMs` is the client's own
 * measurement. A caller holding a session cookie can post a well-formed
 * acceptance without ever having rendered the document. Making the stronger
 * claim true would mean minting a single-use consent nonce when the disclosures
 * are served — the same shape as the order intent token — requiring it here, and
 * deriving the presentation interval server-side from mint to acceptance.
 */
export async function acceptTerms(input: AcceptTermsInput): Promise<AcceptTermsResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Sign in before accepting the terms.' };
  if (!input.scrolledToBottom) {
    return { ok: false, error: 'The terms must be scrolled to the bottom before they can be accepted.' };
  }
  if (!input.click.trusted) {
    return { ok: false, error: 'Acceptance must come from a physical click on the checkbox.' };
  }

  const ctx = await requestContext();
  const acceptedAt = Date.now();
  const version = input.tosVersion ?? TOS_VERSION;

  recordTosAcceptance({
    userId: user.id,
    version,
    acceptedAt,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    // The value actually asserted, not a literal. It can only be `true` here —
    // the guard above returns otherwise — but a consent row that hardcodes the
    // field it is evidence of is worth nothing as evidence.
    scrolledToBottom: input.scrolledToBottom,
    scrollDurationMs: Math.max(0, Math.round(input.scrollDurationMs)),
    click: input.click,
    deviceFootprint: deviceFootprint(ctx, input.click),
  });

  /*
   * The live-routing entitlement is carried through, not left out.
   *
   * `upsertUser`'s conflict clause writes `live_trading_unlocked` from the bound
   * parameter unconditionally, and that parameter is `input.liveTradingUnlocked
   * ?? false` — so omitting the field here does not leave the flag alone, it
   * clears it. Accepting the terms silently revoked live routing from any
   * account that had been granted it, and because `hasAcceptedTerms` requires
   * the *current* version, every version bump forces a re-acceptance and would
   * revoke it again. The flag is granted and withdrawn by `setLiveTradingUnlocked`,
   * which is the audited path; a clickwrap write must not be a second, silent
   * one that only ever moves it downwards.
   */
  upsertUser({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    liveTradingUnlocked: user.liveTradingUnlocked,
    tosAcceptedAt: acceptedAt,
    tosVersion: version,
  });

  recordAudit(
    'tos_accepted',
    user.id,
    ctx,
    {
      tosVersion: version,
      riskDisclosuresVersion: input.riskDisclosuresVersion ?? RISK_DISCLOSURES_VERSION,
      scrollDurationMs: input.scrollDurationMs,
    },
    { clickX: input.click.clickX, clickY: input.click.clickY },
  );

  return { ok: true, brokerLinkingUnlocked: true, acceptedAt };
}

/**
 * A stable, non-identifying device fingerprint for the consent record. Derived
 * from the user agent and viewport rather than from anything cross-site
 * trackable — its purpose is non-repudiation of one signature, not tracking.
 */
function deviceFootprint(ctx: RequestContext, click: ClickProvenance): string {
  return createHmac('sha256', sessionSecret())
    .update(`${ctx.userAgent}|${click.viewportWidth}x${click.viewportHeight}`)
    .digest('hex')
    .slice(0, 32);
}

export function hasAcceptedTerms(user: User | null): boolean {
  return Boolean(user?.tosAcceptedAt && user.tosVersion === TOS_VERSION);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Entitlement
// ─────────────────────────────────────────────────────────────────────────────

export interface Entitlement {
  /** Paper routing is always available once the terms are accepted. */
  paper: boolean;
  /** Live routing requires terms plus an active or trialing subscription. */
  live: boolean;
  reason: string;
  trialEndsAt: number | null;
  trialDaysRemaining: number | null;
  status: User['subscription']['status'];
  priceUsdPerMonth: number;
}

/**
 * The entitlement gate. Phase 5 §4 describes the funnel: a 14-day paper sandbox,
 * then a hard paywall before live API routing is unlocked. Paper trading is never
 * gated on payment, because the sandbox is what establishes trust.
 */
export function entitlement(user: User | null): Entitlement {
  const priceUsdPerMonth = PRICE_CENTS / 100;
  if (!user) {
    return {
      paper: false,
      live: false,
      reason: 'Sign in to use the terminal.',
      trialEndsAt: null,
      trialDaysRemaining: null,
      status: 'none',
      priceUsdPerMonth,
    };
  }
  if (!hasAcceptedTerms(user)) {
    return {
      paper: false,
      live: false,
      reason: 'Accept the terms and risk disclosures before routing any order.',
      trialEndsAt: user.subscription.trialEndsAt,
      trialDaysRemaining: daysRemaining(user.subscription.trialEndsAt),
      status: user.subscription.status,
      priceUsdPerMonth,
    };
  }

  /**
   * Live routing needs an active subscription *and* an explicit unlock.
   *
   * Both conditions, and this must agree exactly with `evaluateOrder`'s
   * entitlement check — it previously did not. This function granted live routing
   * for the duration of the `trialing` status while the risk engine required
   * `liveTradingUnlocked && status === 'active'`, so the two authorities
   * disagreed. The visible result was a user who had signed up seconds earlier
   * being shown live routing as available, minting a live intent token, and only
   * then being rejected at the risk gate — and the reason string cheerfully
   * described a *paper* sandbox trial as unlocking live routing.
   *
   * The risk engine is the correct authority: it implements the Rule 15c3-5
   * pre-trade controls, and a trial is a paper sandbox by definition. Linking a
   * broker and turning live routing on is a deliberate act, not something a trial
   * confers by default.
   */
  const status = user.subscription.status;
  const live = status === 'active' && user.liveTradingUnlocked;
  const trialActive = status === 'trialing' && (user.subscription.trialEndsAt ?? 0) > Date.now();

  return {
    paper: true,
    live,
    reason: live
      ? 'Live routing is unlocked by an active subscription.'
      : status === 'active'
        ? 'Live routing is available on this subscription but is not yet enabled for this account. Link a broker and enable it explicitly.'
        : trialActive
          ? `The paper sandbox is available for the remainder of the trial. Live routing requires an active subscription at $${priceUsdPerMonth}/month and an explicit unlock.`
          : `Live routing requires an active subscription at $${priceUsdPerMonth}/month. Paper routing remains available.`,
    trialEndsAt: user.subscription.trialEndsAt,
    trialDaysRemaining: daysRemaining(user.subscription.trialEndsAt),
    status,
    priceUsdPerMonth,
  };
}

function daysRemaining(endsAt: number | null): number | null {
  if (!endsAt) return null;
  return Math.max(0, Math.ceil((endsAt - Date.now()) / (24 * 60 * 60 * 1000)));
}
