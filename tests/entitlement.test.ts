/**
 * The live-routing entitlement, end to end through the store.
 *
 * These exist because the gate was unreachable rather than wrong: `entitlement()`
 * required `liveTradingUnlocked`, and the only function that could set it —
 * `setLiveTradingUnlocked` — had no caller anywhere in the product. Every account
 * that had ever existed returned `live: false`, underneath copy that told the user
 * live routing needed "an active subscription and an explicit unlock". So what is
 * asserted here is not only that the rules hold, but that a real sequence of
 * administrative actions moves an account through them.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

process.env.AURELIUS_DATA_DIR = ':memory:';

const { closeDb, resetDb } = await import('@/lib/db/client');
const {
  findUserByEmail,
  insertPayment,
  liabilityCapCents,
  recordTosAcceptance,
  setLiveTradingUnlocked,
  setUserRole,
  upsertSubscription,
  upsertUser,
} = await import('@/lib/db/repositories');
const { PRICE_CENTS, entitlement } = await import('@/lib/auth/session');
const { TOS_VERSION } = await import('@/lib/compliance/disclosures');

const EMAIL = 'trader@aurelius.test';
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function seedUser(): string {
  const user = upsertUser({
    email: EMAIL,
    displayName: 'Test Trader',
    role: 'trader',
  });
  recordTosAcceptance({
    userId: user.id,
    // The live version: `hasAcceptedTerms` requires the acceptance to match it.
    version: TOS_VERSION,
    acceptedAt: Date.now(),
    ipAddress: '127.0.0.1',
    userAgent: 'vitest',
    scrolledToBottom: true,
    scrollDurationMs: 4_000,
    click: {
      clickX: 10,
      clickY: 10,
      viewportWidth: 1280,
      viewportHeight: 800,
      clickedAt: Date.now(),
      trusted: true,
      targetId: 'accept-terms',
    },
  });
  return user.id;
}

function reload() {
  const user = findUserByEmail(EMAIL);
  if (user === null) throw new Error('the test user vanished');
  return user;
}

beforeEach(() => {
  resetDb();
});

afterAll(() => {
  closeDb();
});

describe('live-routing entitlement', () => {
  it('withholds live routing from a fresh account', () => {
    seedUser();
    const gate = entitlement(reload());
    expect(gate.paper).toBe(true);
    expect(gate.live).toBe(false);
  });

  it('still withholds it once the subscription is active but nothing is unlocked', () => {
    const id = seedUser();
    upsertSubscription({
      userId: id,
      status: 'active',
      trialEndsAt: null,
      currentPeriodEnd: Date.now() + MONTH_MS,
      priceCents: PRICE_CENTS,
      provider: 'simulated',
      externalId: null,
    });
    // The second key is the point: paying does not widen the blast radius.
    expect(entitlement(reload()).live).toBe(false);
  });

  it('grants it only when the subscription is active and the unlock is set', () => {
    const id = seedUser();
    upsertSubscription({
      userId: id,
      status: 'active',
      trialEndsAt: null,
      currentPeriodEnd: Date.now() + MONTH_MS,
      priceCents: PRICE_CENTS,
      provider: 'simulated',
      externalId: null,
    });
    setLiveTradingUnlocked(id, true);
    expect(entitlement(reload()).live).toBe(true);
  });

  it('withdraws it when the subscription is cancelled, even if the unlock is left set', () => {
    const id = seedUser();
    upsertSubscription({
      userId: id,
      status: 'active',
      trialEndsAt: null,
      currentPeriodEnd: Date.now() + MONTH_MS,
      priceCents: PRICE_CENTS,
      provider: 'simulated',
      externalId: null,
    });
    setLiveTradingUnlocked(id, true);
    expect(entitlement(reload()).live).toBe(true);

    upsertSubscription({
      userId: id,
      status: 'canceled',
      trialEndsAt: null,
      currentPeriodEnd: null,
      priceCents: PRICE_CENTS,
      provider: 'simulated',
      externalId: null,
    });
    expect(entitlement(reload()).live).toBe(false);
  });

  it('never grants live routing on a trial, however long it has left', () => {
    const id = seedUser();
    upsertSubscription({
      userId: id,
      status: 'trialing',
      trialEndsAt: Date.now() + 14 * 24 * 60 * 60 * 1000,
      currentPeriodEnd: null,
      priceCents: PRICE_CENTS,
      provider: 'simulated',
      externalId: null,
    });
    setLiveTradingUnlocked(id, true);
    const gate = entitlement(reload());
    expect(gate.paper).toBe(true);
    expect(gate.live).toBe(false);
  });

  it('promotes and demotes a role', () => {
    const id = seedUser();
    expect(reload().role).toBe('trader');
    setUserRole(id, 'admin');
    expect(reload().role).toBe('admin');
    setUserRole(id, 'trader');
    expect(reload().role).toBe('trader');
  });
});

describe('liability cap', () => {
  it('is zero until a payment is recorded, and reflects one afterwards', () => {
    const id = seedUser();
    expect(liabilityCapCents(id)).toBe(0);

    const now = Date.now();
    insertPayment({
      userId: id,
      subscriptionId: null,
      amountCents: PRICE_CENTS,
      currency: 'USD',
      status: 'succeeded',
      provider: 'manual',
      externalId: null,
      paidAt: now,
      periodStart: now,
      periodEnd: now + MONTH_MS,
      raw: null,
    });
    expect(liabilityCapCents(id)).toBe(PRICE_CENTS);
  });

  it('counts only the trailing three months', () => {
    const id = seedUser();
    const now = Date.now();
    const base = {
      userId: id,
      subscriptionId: null,
      amountCents: PRICE_CENTS,
      currency: 'USD',
      status: 'succeeded',
      provider: 'manual',
      externalId: null,
      periodStart: null,
      periodEnd: null,
      raw: null,
    };
    insertPayment({ ...base, paidAt: now });
    // Six months ago: outside the window the Terms describe.
    insertPayment({ ...base, paidAt: now - 6 * MONTH_MS });
    expect(liabilityCapCents(id, now)).toBe(PRICE_CENTS);
  });

  it('ignores a payment that did not succeed', () => {
    const id = seedUser();
    const now = Date.now();
    insertPayment({
      userId: id,
      subscriptionId: null,
      amountCents: PRICE_CENTS,
      currency: 'USD',
      status: 'failed',
      provider: 'manual',
      externalId: null,
      paidAt: now,
      periodStart: null,
      periodEnd: null,
      raw: null,
    });
    expect(liabilityCapCents(id, now)).toBe(0);
  });
});
