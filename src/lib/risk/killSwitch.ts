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
 * Consequences for the design:
 *
 *   · The engaged flag lives in module scope and is read synchronously on every
 *     request. No cache, no TTL, no deploy — the next request after the admin
 *     click sees the halt.
 *   · `engage()` is synchronous and returns the pending-order list it registered
 *     for cancellation *before* any network I/O, so the halt cannot be delayed by
 *     a slow or hanging broker. The actual DELETE calls are flushed afterwards by
 *     `flushCancellations()`.
 *   · Outbound severance is expressed as an abort signal the broker adapters
 *     attach to their fetches, which is how "sever active API POST connections"
 *     is implemented in a runtime with no socket registry of its own.
 *   · State is mirrored through a port, so a restart mid-incident comes back
 *     halted rather than silently resuming routing.
 */

import type { KillSwitchState } from '@/lib/domain/types';
import { KILL_SWITCH_HTTP_STATUS } from '@/lib/risk/limits';
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
   * Signal the broker adapters attach to their outbound requests. Aborting it is
   * how an active POST is severed the instant the switch is thrown.
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

  /**
   * Route guard. Returns the 503 envelope while engaged so every handler sheds
   * load identically instead of each inventing its own response.
   */
  guard(): { allowed: true } | { allowed: false; status: number; message: string; retryAfterSeconds: number } {
    if (!this.current.engaged) return { allowed: true };
    return {
      allowed: false,
      status: KILL_SWITCH_HTTP_STATUS,
      message: SERVICE_UNAVAILABLE_MESSAGE,
      // PLATFORM POLICY: a halt is cleared by a human decision, not by elapsed
      // time, so the hint is a polling interval rather than a promise.
      retryAfterSeconds: 30,
    };
  }
}

/**
 * Process-wide switch. Module scope is what makes the control instantaneous:
 * every route in the process reads the same object, so the flag flips without a
 * deploy, a restart or a cache invalidation.
 */
let processSwitch: KillSwitch | null = null;

export function getKillSwitch(deps: KillSwitchDeps = {}): KillSwitch {
  if (processSwitch === null) processSwitch = new KillSwitch(deps);
  return processSwitch;
}

/** Installs a configured switch (real ports) or clears it for tests. */
export function setKillSwitch(instance: KillSwitch | null): void {
  processSwitch = instance;
}

/** Convenience read for the risk engine's first check. */
export function isKillSwitchEngaged(): boolean {
  return processSwitch !== null && processSwitch.engaged();
}
