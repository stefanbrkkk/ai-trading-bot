/**
 * AI status for the route layer.
 *
 * This module used to resolve `@/lib/ai` through a *variable* specifier so that a
 * deployment without the AI subsystem would still compile. That indirection has
 * outlived its purpose — the subsystem is part of the platform, and its own design
 * already guarantees the thing the indirection was protecting against: `aiStatus()`
 * reports the deterministic engine when no credential is present, and `complete()`
 * never rejects. There was nothing left to degrade *to*.
 *
 * It also had a cost. A dynamic specifier webpack cannot resolve statically emits
 * "Critical dependency: the request of a dependency is an expression" on every
 * build that touches a route importing this file, and a build warning that is
 * merely tolerated is a build warning nobody reads. The import is static now.
 *
 * The wrapper is kept rather than inlined so route handlers keep a single import
 * for the status object, and so the try/catch stays in one place: a status call is
 * decoration on a health or query response, and it must never be the reason one
 * fails.
 */

import { aiStatus as resolveAiStatus, type AiStatus } from '@/lib/ai';

export type { AiStatus } from '@/lib/ai';

/** The last-resort description, used only if status resolution itself throws. */
const UNKNOWN: AiStatus = {
  provider: 'deterministic',
  model: 'aurelius-extractive-v1',
  live: false,
  configuredProviders: [],
  reason:
    'The deterministic narrative, grading and query engines are serving. Add a provider key to switch to live inference; nothing else changes.',
};

export async function aiStatus(): Promise<AiStatus> {
  try {
    return resolveAiStatus();
  } catch {
    return UNKNOWN;
  }
}
