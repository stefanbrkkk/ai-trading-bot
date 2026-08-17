/**
 * Administered entitlements: role, subscription and the live-routing unlock.
 *
 * This endpoint exists because the platform documented a live-routing path that
 * no user could ever reach. `setUserRole`, `setLiveTradingUnlocked` and
 * `insertPayment` were all written, tested by nothing and called by nothing, so
 * `entitlement()` returned `live: false` for every account that had ever existed
 * while the order ticket's own copy read "Live routing requires an active
 * subscription and an explicit unlock". A control that cannot be exercised is not
 * a control, it is a claim.
 *
 * Two decisions worth stating:
 *
 *   • **The unlock is a second key, not a consequence of paying.** Activating a
 *     subscription never unlocks live routing on its own. An administrator has to
 *     turn it on separately, and cancelling revokes it immediately. That is the
 *     Weiss Research posture applied to entitlement rather than to execution: the
 *     platform should not be able to widen a user's blast radius as a side effect
 *     of a billing event.
 *   • **Activation writes a payment row.** There is no billing provider wired, so
 *     the record is marked `provider: 'manual'` and carries the administrator's
 *     id. It exists because the Terms cap liability at the fees paid in the
 *     preceding three months, and `liabilityCapCents` computes that from the
 *     payment ledger — which had no writer at all, so the cap silently evaluated
 *     to zero for every user.
 *
 * Every action writes an audit event with the acting administrator, the subject
 * and the before/after state, because these are the changes least likely to be
 * reconstructable from anywhere else.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, handler, ok, parseBody } from '@/lib/api/respond';
import { PRICE_CENTS, requestContext, requireAdmin } from '@/lib/auth/session';
import {
  findSubscription,
  findUserByEmail,
  insertAuditEvent,
  insertPayment,
  liabilityCapCents,
  listUsers,
  setLiveTradingUnlocked,
  setUserRole,
  upsertSubscription,
} from '@/lib/db';

export const dynamic = 'force-dynamic';

const ADMIN_SPIFFE_ID = 'spiffe://aurelius.local/ns/platform/sa/admin-console';

/** A month, for the subscription period. Calendar months are not needed here. */
const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

const bodySchema = z.object({
  email: z.string().min(3).max(254),
  action: z.enum(['activate_subscription', 'cancel_subscription', 'set_live_unlock', 'set_role']),
  /** `set_live_unlock` only. */
  unlocked: z.boolean().optional(),
  /** `set_role` only. */
  role: z.enum(['trader', 'admin']).optional(),
  /** `activate_subscription` only. Whole months, 1–12. */
  months: z.number().int().min(1).max(12).optional(),
});

export const GET = handler(async () => {
  await requireAdmin();
  const users = listUsers(200);
  return ok({
    priceUsdPerMonth: PRICE_CENTS / 100,
    users: users.map((user) => ({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt,
      subscriptionStatus: user.subscription.status,
      currentPeriodEnd: user.subscription.currentPeriodEnd,
      liveTradingUnlocked: user.liveTradingUnlocked,
      /** Published so the cap the Terms promise is inspectable per account. */
      liabilityCapUsd: liabilityCapCents(user.id) / 100,
    })),
  });
});

export const POST = handler(async (request: Request) => {
  const admin = await requireAdmin();
  const body = await parseBody(request, bodySchema);
  const ctx = await requestContext();

  const subject = findUserByEmail(body.email.trim().toLowerCase());
  if (subject === null) {
    throw new ApiError('UNKNOWN_USER', `No account exists for ${body.email}.`, 404);
  }

  const before = {
    role: subject.role,
    status: subject.subscription.status,
    liveTradingUnlocked: subject.liveTradingUnlocked,
  };
  const now = Date.now();
  let detail: string;

  switch (body.action) {
    case 'activate_subscription': {
      const months = body.months ?? 1;
      const existing = findSubscription(subject.id);
      const subscription = upsertSubscription({
        userId: subject.id,
        status: 'active',
        trialEndsAt: existing?.trialEndsAt ?? null,
        currentPeriodEnd: now + months * PERIOD_MS,
        priceCents: PRICE_CENTS,
        provider: 'simulated',
        externalId: null,
      });
      insertPayment({
        userId: subject.id,
        subscriptionId: subscription.id,
        amountCents: PRICE_CENTS * months,
        currency: 'USD',
        status: 'succeeded',
        provider: 'manual',
        externalId: null,
        paidAt: now,
        periodStart: now,
        periodEnd: now + months * PERIOD_MS,
        raw: { grantedBy: admin.id, grantedByEmail: admin.email, months },
      });
      detail = `activated for ${months} month${months === 1 ? '' : 's'}`;
      break;
    }

    case 'cancel_subscription': {
      const existing = findSubscription(subject.id);
      upsertSubscription({
        userId: subject.id,
        status: 'canceled',
        trialEndsAt: existing?.trialEndsAt ?? null,
        currentPeriodEnd: existing?.currentPeriodEnd ?? null,
        priceCents: existing?.priceCents ?? PRICE_CENTS,
        provider: existing?.provider ?? 'simulated',
        externalId: existing?.externalId ?? null,
      });
      // Revoked in the same transaction of intent: an entitlement that outlives
      // the subscription funding it is exactly the state this endpoint exists to
      // make impossible.
      setLiveTradingUnlocked(subject.id, false);
      detail = 'cancelled, live routing revoked';
      break;
    }

    case 'set_live_unlock': {
      const unlocked = body.unlocked === true;
      if (unlocked && subject.subscription.status !== 'active') {
        throw new ApiError(
          'SUBSCRIPTION_REQUIRED',
          `Live routing cannot be unlocked while the subscription is "${subject.subscription.status}". Activate it first.`,
          409,
        );
      }
      setLiveTradingUnlocked(subject.id, unlocked);
      detail = unlocked ? 'live routing unlocked' : 'live routing locked';
      break;
    }

    case 'set_role': {
      const role = body.role ?? 'trader';
      if (subject.id === admin.id && role !== 'admin') {
        // Losing the last administrator locks the kill switch away from everyone.
        throw new ApiError('SELF_DEMOTION', 'An administrator cannot remove their own admin role.', 409);
      }
      setUserRole(subject.id, role);
      detail = `role set to ${role}`;
      break;
    }
  }

  const after = findUserByEmail(subject.email);
  insertAuditEvent({
    eventType: `admin_entitlement_${body.action}`,
    userId: admin.id,
    sessionToken: null,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    clickX: null,
    clickY: null,
    resource: subject.email,
    orderId: null,
    rawPayload: JSON.stringify({
      subjectId: subject.id,
      before,
      after: after === null
        ? null
        : { role: after.role, status: after.subscription.status, liveTradingUnlocked: after.liveTradingUnlocked },
      detail,
    }),
    brokerStatus: null,
    brokerBody: null,
    spiffeId: ADMIN_SPIFFE_ID,
    correlationId: `cor_${randomUUID()}`,
  });

  return ok({
    email: subject.email,
    detail,
    user: after === null
      ? null
      : {
          role: after.role,
          subscriptionStatus: after.subscription.status,
          currentPeriodEnd: after.subscription.currentPeriodEnd,
          liveTradingUnlocked: after.liveTradingUnlocked,
          liabilityCapUsd: liabilityCapCents(after.id) / 100,
        },
  });
});
