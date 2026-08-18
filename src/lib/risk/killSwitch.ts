/**
 * The Global Kill Switch — Rule 15c3-5 Control 6.
 *
 * The mandate is unusually prescriptive here, because broker-dealers treat this
 * as a precondition of the API partnership: an administrative control, usable by
 * the CTO or compliance personnel, that "immediately ceases ALL outbound API
 * order routing across the ENTIRE platform", is "triggerable instantaneously …
 * without a manual code deployment or server reboot", and on activation
 * (a) severs active outbound POST connections, (b) answers all incoming user
 * requests with HTTP 503 Service Unavailable, and (c) automatically attempts to
 * cancel every pending unexecuted order where the broker's API permits, logging
 * each attempt.
 *
 * WHAT IS ON THE EXECUTING PATH TODAY, exactly, because this file previously
 * described a design the platform does not run:
 *
 *   · The halt is a row in the `kill_switch` table, written by the admin route
 *     and read synchronously by `killSwitchState()` on every order request. No
 *     cache, no TTL, no deploy — the next request after the admin click sees it,
 *     and because the state is in the ledger rather than in a process, a second
 *     worker and a restarted one see it too.
 *   · `killSwitchShed()` below turns that state into the mandated 503 envelope,
 *     and both routing endpoints call it before any other work. That is (b), and
 *     it is the function in this file that production actually uses.
 *   · `buildOrderContext` passes the same state to the risk engine as
 *     `killSwitchEngaged`, where it is the first control evaluated, so a halt is
 *     also recorded as a refusal in the decision ledger rather than only as an
 *     HTTP status. The engine denies when the flag is absent.
 *   · (c) is performed inline by the admin route, which walks every working
 *     order — 'pending_risk', 'submitted', 'partially_filled' — and records each
 *     cancellation attempt with its broker status.
 *
 * WHAT IS NOT IMPLEMENTED. There is no severance of in-flight outbound POSTs.
 * `class KillSwitch` below models one, as an abort signal the broker adapters
 * would attach to their fetches — both adapters honour a `signal` on their
 * request context — but nothing in the platform constructs the class or
 * populates that field, so no such signal exists at runtime and sub-requirement
 * (a) is unmet. The class, `getKillSwitch`, `setKillSwitch` and
 * `isKillSwitchEngaged` have no caller anywhere in `src/`, `tests/`, `e2e/` or
 * `scripts/`: they are a reference implementation of the mandate's full shape,
 * not the mechanism the halt runs on, and `isKillSwitchEngaged()` in particular
 * returns a constant `false` because `processSwitch` is never installed. They
 * are documented as such rather than presented as the implementation, which is
 * what the previous version of this comment did.
 */

import type { KillSwitchState } from '@/lib/domain/types';
import { KILL_SWITCH_HTTP_STATUS } from '@/lib/risk/limits';
import { ERROR_COPY } from '@/lib/compliance/disclosures';
import {
  InMemoryKillSwitchStore,
  type KillSwitchStatePort,
  type PendingOrderPort,
  type PendingOrderRef,
  type RiskAuditPort,
} from '@/lib/risk/ports';
import { ADMIN_CONSOLE_SPIFFE_ID, SERVICE_UNAVAILABLE_MESSAGE } from '@/lib/risk/telemetry';

/**
 * Minimal shape the switch needs from a broker to unwind resting orders.
 * Declared structurally rather than importing `BrokerAdapter` so the risk layer
 * never depends on the broker layer — `BrokerAdapter` satisfies it as-is.
 */
export interface KillSwitchOrderCanceller {
  cancelOrder(
    brokerOrderId: string,
    ctx: { correlationId: string; userId: string },
  ): Promise<{ status: number; body: Record<string, unknown> | null }>;
}

/** One logged cancellation attempt. */
export interface CancellationAttempt {
  orderId: string;
  brokerOrderId: string | null;
  userId: string;
  symbol: string;
  account: 'paper' | 'live';
  /** Unfilled quantity at the moment of the halt. */
  openQuantity: number;
  requestedAt: number;
  /**
   * False when the order carries no broker order id — the mandate's "where the
   * broker's API permits" case. The attempt is still logged, because the absence
   * of a cancellation path is itself a fact the ledger has to show.
   */
  cancellable: boolean;
  /** Broker status once flushed; null while the attempt is outstanding. */
  status: number | null;
  body: string | null;
}

export interface KillSwitchEngagement {
  state: KillSwitchState;
  /** Every pending order the activation attempted to cancel. */
  attempts: CancellationAttempt[];
}

export interface KillSwitchDeps {
  state?: KillSwitchStatePort;
  pendingOrders?: PendingOrderPort;
  audit?: RiskAuditPort;
  clock?: () => number;
}

const IDLE_STATE: KillSwitchState = {
  engaged: false,
  engagedAt: null,
  engagedBy: null,
  reason: null,
  cancelledOrders: 0,
};

/**
 * The mandate's full Control 6 shape, as a testable unit.
 *
 * Not wired: nothing in the platform constructs it. The operative halt is the
 * `kill_switch` ledger row described at the top of this file, and the engagement
 * ordering, the abort-on-engage severance and the best-effort cancellation flush
 * below are the reference for what a wired implementation has to do — including
 * the two things the ledger-backed path does not do at all, which are severing
 * in-flight POSTs and re-aborting the controller when a process restarts into an
 * engaged state.
 */
export class KillSwitch {
  private current: KillSwitchState;
  private readonly statePort: KillSwitchStatePort;
  private readonly pendingOrders: PendingOrderPort | undefined;
  private readonly audit: RiskAuditPort | undefined;
  private readonly clock: () => number;
  /** Aborted on engagement so in-flight broker POSTs are severed, not awaited. */
  private controller: AbortController;
  private outstanding: CancellationAttempt[] = [];

  constructor(deps: KillSwitchDeps = {}) {
    this.statePort = deps.state ?? new InMemoryKillSwitchStore();
    this.pendingOrders = deps.pendingOrders;
    this.audit = deps.audit;
    this.clock = deps.clock ?? (() => Date.now());
    this.controller = new AbortController();
    const persisted = this.statePort.load();
    this.current = persisted === null ? { ...IDLE_STATE } : { ...persisted };
    // A process that restarts into an engaged state must come up halted, and its
    // fresh controller must already be aborted or the first outbound POST would
    // slip through the severance.
    if (this.current.engaged) this.controller.abort(SERVICE_UNAVAILABLE_MESSAGE);
  }

  /** Current state. Cheap enough to call on every request. */
  state(): KillSwitchState {
    return { ...this.current };
  }

  engaged(): boolean {
    return this.current.engaged;
  }

  /**
   * The signal a broker adapter would attach to its outbound requests; aborting
   * it is how an active POST gets severed the instant the switch is thrown. Both
   * adapters accept one on their request context and honour it, but no call site
   * passes this signal to them, so today it severs nothing.
   */
  signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * Engages the halt.
   *
   * Ordering is deliberate: the flag flips and persists first, so no further
   * request can start routing while the pending-order list is being gathered.
   */
  engage(actor: string, reason: string): KillSwitchEngagement {
    const at = this.clock();
    if (!this.current.engaged) this.controller.abort(SERVICE_UNAVAILABLE_MESSAGE);

    const pending: PendingOrderRef[] = this.pendingOrders?.listPending() ?? [];
    const attempts: CancellationAttempt[] = pending.map((order) => {
      this.pendingOrders?.markCancellationRequested(order.orderId, at);
      return {
        orderId: order.orderId,
        brokerOrderId: order.brokerOrderId,
        userId: order.userId,
        symbol: order.symbol,
        account: order.account,
        openQuantity: Math.max(0, order.quantity - order.filledQuantity),
        requestedAt: at,
        cancellable: order.brokerOrderId !== null,
        status: null,
        body: null,
      };
    });

    this.current = {
      engaged: true,
      engagedAt: at,
      engagedBy: actor,
      reason,
      cancelledOrders: attempts.length,
    };
    this.statePort.save(this.current);
    this.outstanding = attempts;

    this.audit?.recordAdminAction({
      action: 'KILL_SWITCH_ENGAGED',
      actor,
      reason,
      actedAt: at,
      spiffeId: ADMIN_CONSOLE_SPIFFE_ID,
      affectedOrderIds: attempts.map((a) => a.orderId),
    });

    return { state: this.state(), attempts };
  }

  /**
   * Releases the halt. A fresh AbortController is installed, because an aborted
   * signal can never be un-aborted and reusing it would leave every subsequent
   * broker call severed at birth.
   */
  disengage(actor: string): KillSwitchState {
    const at = this.clock();
    this.controller = new AbortController();
    this.current = {
      engaged: false,
      engagedAt: null,
      engagedBy: null,
      reason: null,
      // Retains the count from the last engagement: the admin panel shows what
      // the most recent halt unwound, and the ledger keeps the full history.
      cancelledOrders: this.current.cancelledOrders,
    };
    this.statePort.save(this.current);
    this.audit?.recordAdminAction({
      action: 'KILL_SWITCH_DISENGAGED',
      actor,
      reason: null,
      actedAt: at,
      spiffeId: ADMIN_CONSOLE_SPIFFE_ID,
      affectedOrderIds: [],
    });
    return this.state();
  }

  /** Attempts still awaiting a broker response. */
  pendingCancellations(): readonly CancellationAttempt[] {
    return this.outstanding;
  }

  /**
   * Issues the actual cancellations, best effort.
   *
   * Never throws and never short-circuits: one broker refusing a DELETE must not
   * prevent the remaining orders from being attempted, and every outcome —
   * including a transport failure, recorded as status 0 — is written to the
   * ledger, because the mandate requires the attempt and its response to be
   * logged whether or not it succeeded.
   */
  async flushCancellations(broker: KillSwitchOrderCanceller): Promise<CancellationAttempt[]> {
    const attempts = this.outstanding;
    this.outstanding = [];
    for (const attempt of attempts) {
      if (!attempt.cancellable || attempt.brokerOrderId === null) {
        attempt.status = 0;
        attempt.body = 'no broker order id — cancellation not supported for this order';
        this.pendingOrders?.recordCancellationOutcome(attempt.orderId, 0, attempt.body);
        continue;
      }
      try {
        const result = await broker.cancelOrder(attempt.brokerOrderId, {
          correlationId: `killswitch:${attempt.orderId}`,
          userId: attempt.userId,
        });
        attempt.status = result.status;
        attempt.body = result.body === null ? null : JSON.stringify(result.body);
      } catch (error) {
        // A thrown cancellation is still an outcome the ledger must carry.
        attempt.status = 0;
        attempt.body = error instanceof Error ? error.message : String(error);
      }
      this.pendingOrders?.recordCancellationOutcome(
        attempt.orderId,
        attempt.status ?? 0,
        attempt.body,
      );
    }
    return attempts;
  }

  /**
   * HTTP status a request should be answered with. 503 while engaged, per the
   * mandate; 0 means "no override — handle the request normally".
   */
  httpStatusForRequest(): number {
    return this.current.engaged ? KILL_SWITCH_HTTP_STATUS : 0;
  }
}

/**
 * PLATFORM POLICY. A halt is cleared by a human decision, not by elapsed time, so
 * the `Retry-After` hint is a polling interval rather than a promise.
 */
export const KILL_SWITCH_RETRY_AFTER_SECONDS = 30;

/**
 * The shed envelope for a routing request, or `null` when routing is open.
 *
 * Takes the state as an argument rather than reading `this.current`, because the
 * authoritative answer to "is the platform halted right now" is the ledger, not
 * an in-process field: a second server process, or this one after a restart, has
 * a `KillSwitch` instance that never saw the engagement. Both routing endpoints
 * therefore read `killSwitchState()` and format the response through here, so the
 * two cannot drift — which they had, one answering 503 and the other 422 for the
 * same halt.
 */
export function killSwitchShed(state: Pick<KillSwitchState, 'engaged' | 'reason' | 'engagedAt'>): {
  code: 'KILL_SWITCH_ENGAGED';
  message: string;
  status: number;
  details: { reason: string | null; engagedAt: number | null; retryAfterSeconds: number };
} | null {
  if (!state.engaged) return null;
  return {
    code: 'KILL_SWITCH_ENGAGED',
    message: ERROR_COPY.killSwitch,
    status: KILL_SWITCH_HTTP_STATUS,
    details: {
      reason: state.reason,
      engagedAt: state.engagedAt,
      retryAfterSeconds: KILL_SWITCH_RETRY_AFTER_SECONDS,
    },
  };
}

/**
 * Holder for a process-wide switch instance. Nothing installs one — see the
 * note at the top of the file — so it is null for the life of every process the
 * platform runs, and the three accessors below are part of the unwired
 * reference surface rather than of the halt.
 */
let processSwitch: KillSwitch | null = null;

export function getKillSwitch(deps: KillSwitchDeps = {}): KillSwitch {
  if (processSwitch === null) processSwitch = new KillSwitch(deps);
  return processSwitch;
}

/** Installs a configured switch (real ports) or clears it. */
export function setKillSwitch(instance: KillSwitch | null): void {
  processSwitch = instance;
}

/**
 * Whether an installed process switch is engaged.
 *
 * Not the platform's halt state, and it must not be used as a proxy for one: no
 * switch is ever installed, so this returns `false` however engaged the real
 * halt is. The risk engine used to fall back to it when no halt state was
 * supplied, which made that fallback a constant "routing is open"; it now denies
 * instead. The authoritative read is `killSwitchState()` against the ledger.
 */
export function isKillSwitchEngaged(): boolean {
  return processSwitch !== null && processSwitch.engaged();
}
