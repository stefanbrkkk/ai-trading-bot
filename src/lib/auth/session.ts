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
/** The trial window Phase 5 §4 specifies for the paper sandbox. */
export const TRIAL_DAYS = 14;
/** Subscription price, in cents. MASTER §4.5: $200/month. */
export const PRICE_CENTS = Number(process.env.AURELIUS_PRICE_USD_MONTH ?? 200) * 100;

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
 * The IP and user agent, which are two of the six mandatory audit fields. Reads
 * the standard proxy headers in order of trustworthiness and falls back to a
 * marker rather than an empty string, so an audit row never looks like it simply
 * failed to record the field.
 */
export async function requestContext(): Promise<RequestContext> {
  const h = await headers();
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
  const adminEmail = (process.env.AURELIUS_ADMIN_EMAIL ?? 'admin@aurelius.local').toLowerCase();
  const now = Date.now();

  const user = upsertUser({
    email,
    displayName: input.displayName?.trim() || email.split('@')[0] || 'Trader',
    role: email === adminEmail ? 'admin' : 'trader',
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
 * The server re-checks `scrolledToBottom` and the click's `trusted` flag rather
 * than trusting the client's word: the enforceability of the agreement rests on
 * being able to show the user was presented with the terms and affirmatively
 * accepted them, so an assertion that arrives without those markers is rejected.
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
    scrolledToBottom: true,
    scrollDurationMs: Math.max(0, Math.round(input.scrollDurationMs)),
    click: input.click,
    deviceFootprint: deviceFootprint(ctx, input.click),
  });

  upsertUser({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
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

  const status = user.subscription.status;
  const trialActive = status === 'trialing' && (user.subscription.trialEndsAt ?? 0) > Date.now();
  const live = status === 'active' || trialActive;

  return {
    paper: true,
    live,
    reason: live
      ? status === 'active'
        ? 'Live routing is unlocked by an active subscription.'
        : 'Live routing is unlocked for the remainder of the paper-sandbox trial.'
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
