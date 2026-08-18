/**
 * Order-message throttle — Rule 15c3-5 Control 5.
 *
 * The mandate's number is exact: "maximum 5 order messages per second per unique
 * user ID", keyed on the user ID rather than IP or session so that neither a
 * shared NAT nor a freshly minted session evades it. Its stated purpose is
 * protecting the downstream broker-dealer from flooding, "whether from repeated
 * 'Submit' clicks under network latency or from a malicious script" — the API
 * partners sever access at the first sign of infrastructural instability.
 *
 * The window is a true sliding window over retained timestamps, not a fixed
 * bucket. A fixed one-second bucket admits ten messages across a bucket
 * boundary, which is exactly double the disclosed limit; since the limit is
 * published to users through RISK_LIMIT_DESCRIPTORS, the enforced behaviour has
 * to match the disclosure.
 *
 * The clock is injected, so the limiter is deterministic under test and the
 * ledger's throttle records can be reproduced from the same inputs.
 */

import {
  ORDER_MESSAGES_PER_SECOND_PER_USER,
  RATE_LIMIT_HTTP_STATUS,
  RATE_LIMIT_WINDOW_MS,
} from '@/lib/risk/limits';
import type { RiskAuditPort } from '@/lib/risk/ports';
import { RATE_LIMITER_SPIFFE_ID } from '@/lib/risk/telemetry';

export interface RateLimitDecision {
  allowed: boolean;
  /** Messages counted inside the window, including this one when allowed. */
  count: number;
  limit: number;
  windowMs: number;
  /** Milliseconds until the oldest message leaves the window; 0 when allowed. */
  retryAfterMs: number;
  /** 429 on rejection, 0 when allowed (no HTTP response is implied). */
  httpStatus: number;
  /** Instant the decision was taken, millisecond precision. */
  decidedAt: number;
}

export interface RateLimiterOptions {
  limit?: number;
  windowMs?: number;
  /** Injectable clock. Defaults to wall time. */
  clock?: () => number;
  audit?: RiskAuditPort;
  /**
   * PLATFORM POLICY. Idle users are evicted so a long-lived process cannot
   * accumulate one timestamp array per account that ever traded. The threshold
   * is a multiple of the window; anything older cannot affect a decision.
   */
  idleEvictionWindows?: number;
}

/**
 * Deterministic sliding-window limiter.
 *
 * One instance guards the whole process. In a multi-instance deployment the
 * limiter must move behind a shared store, and the injected constructor
 * dependencies here (clock plus audit sink) are what make that substitution a
 * drop-in rather than a rewrite. There is no `RateLimiterPort` in
 * `risk/ports.ts` yet; adding one is the shape that change would take.
 */
export class SlidingWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly clock: () => number;
  private readonly audit: RiskAuditPort | undefined;
  private readonly idleEvictionMs: number;
  /** Ascending message timestamps per user. */
  private readonly hits = new Map<string, number[]>();
  private lastSweepAt = 0;

  constructor(options: RateLimiterOptions = {}) {
    this.limit = options.limit ?? ORDER_MESSAGES_PER_SECOND_PER_USER;
    this.windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
    this.clock = options.clock ?? (() => Date.now());
    this.audit = options.audit;
    this.idleEvictionMs = this.windowMs * (options.idleEvictionWindows ?? 60);
  }

  /**
   * Counts an inbound order message and decides.
   *
   * A rejected message is *not* recorded as a hit. Counting rejections would
   * turn a burst into an ever-extending lockout, punishing a user for the
   * platform's own retry behaviour; the disclosed limit is five accepted
   * messages per second, and that is what is enforced.
   */
  check(userId: string, correlationId: string): RateLimitDecision {
    const now = this.clock();
    const cutoff = now - this.windowMs;
    const timestamps = this.hits.get(userId) ?? [];

    // Drop expired entries from the front; the array is ascending by construction.
    let firstLive = 0;
    while (firstLive < timestamps.length && timestamps[firstLive] <= cutoff) firstLive += 1;
    const live = firstLive === 0 ? timestamps : timestamps.slice(firstLive);

    if (live.length >= this.limit) {
      const oldest = live[0];
      const retryAfterMs = Math.max(1, oldest + this.windowMs - now);
      this.hits.set(userId, live);
      const decision: RateLimitDecision = {
        allowed: false,
        count: live.length,
        limit: this.limit,
        windowMs: this.windowMs,
        retryAfterMs,
        httpStatus: RATE_LIMIT_HTTP_STATUS,
        decidedAt: now,
      };
      // The mandate requires throttle rejections be logged in the immutable
      // ledger, not merely dropped at the gateway.
      this.audit?.recordRateLimitRejection({
        correlationId,
        userId,
        spiffeId: RATE_LIMITER_SPIFFE_ID,
        observedCount: live.length,
        limit: this.limit,
        windowMs: this.windowMs,
        rejectedAt: now,
        httpStatus: RATE_LIMIT_HTTP_STATUS,
      });
      return decision;
    }

    live.push(now);
    this.hits.set(userId, live);
    this.sweep(now);
    return {
      allowed: true,
      count: live.length,
      limit: this.limit,
      windowMs: this.windowMs,
      retryAfterMs: 0,
      httpStatus: 0,
      decidedAt: now,
    };
  }

  /** Non-mutating view of the current window, for the admin surfaces. */
  peek(userId: string): { count: number; limit: number; windowMs: number } {
    const now = this.clock();
    const cutoff = now - this.windowMs;
    const timestamps = this.hits.get(userId) ?? [];
    let count = 0;
    for (const at of timestamps) if (at > cutoff) count += 1;
    return { count, limit: this.limit, windowMs: this.windowMs };
  }

  /** Number of users currently holding live or recent timestamps. */
  trackedUsers(): number {
    return this.hits.size;
  }

  /** Clears one user or all users. Test and admin-recovery affordance only. */
  reset(userId?: string): void {
    if (userId === undefined) this.hits.clear();
    else this.hits.delete(userId);
  }

  /** Evicts users whose most recent message is far outside the window. */
  private sweep(now: number): void {
    if (now - this.lastSweepAt < this.idleEvictionMs) return;
    this.lastSweepAt = now;
    for (const [userId, timestamps] of this.hits) {
      const newest = timestamps.length === 0 ? 0 : timestamps[timestamps.length - 1];
      if (now - newest > this.idleEvictionMs) this.hits.delete(userId);
    }
  }
}

/**
 * Process-wide limiter shared by every order route.
 *
 * Held in module scope so that all handlers in the process count against one
 * window — a per-request limiter would enforce nothing at all.
 */
let processLimiter: SlidingWindowRateLimiter | null = null;

export function getOrderRateLimiter(options: RateLimiterOptions = {}): SlidingWindowRateLimiter {
  if (processLimiter === null) processLimiter = new SlidingWindowRateLimiter(options);
  return processLimiter;
}

/** Replaces the process limiter. Used by the integrator's wiring and by tests. */
export function setOrderRateLimiter(limiter: SlidingWindowRateLimiter | null): void {
  processLimiter = limiter;
}

/** Human-readable throttle message. Sterile, no urgency language. */
export function rateLimitMessage(decision: RateLimitDecision): string {
  return `Order message rate limit reached (${decision.limit} per second). Retry in ${decision.retryAfterMs} ms.`;
}
