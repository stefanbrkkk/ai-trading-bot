/**
 * The reference instant.
 *
 * `AURELIUS_NOW` pins the evaluation instant so a seed and a backtest can be
 * reproduced months later. It was being read as `Number(process.env.AURELIUS_NOW
 * ?? Date.now())`, which is correct for epoch milliseconds and silently
 * catastrophic for anything else: `AURELIUS_NOW=2026-08-14` — the form a person
 * actually types — parses to `NaN`, and `NaN` propagates through the simulator
 * into every price, feature and signal without throwing anywhere. The output is
 * a fully-rendered terminal of blanks.
 *
 * So both forms are accepted, and an unparseable value falls back to the caller's
 * default with a warning rather than poisoning the run. Fixing the clock is a
 * reproducibility feature; a fixed clock that quietly became `NaN` is the
 * opposite.
 */

export const REFERENCE_NOW_ENV = 'AURELIUS_NOW';

/**
 * Resolves a pinned instant from an environment value.
 *
 * Accepts epoch milliseconds (`1755201600000`) or anything `Date` parses
 * (`2026-08-14`, `2026-08-14T20:00:00Z`). Returns `fallback` for blank, absent or
 * unparseable input.
 */
export function resolveReferenceNow(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return fallback;

  // Digits only, so `20240117` stays epoch-ms rather than becoming a year.
  if (/^-?\d+$/.test(trimmed)) {
    const epoch = Number(trimmed);
    if (Number.isFinite(epoch)) return epoch;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return parsed;

  console.warn(
    `[aurelius] ${REFERENCE_NOW_ENV}="${trimmed}" is neither epoch milliseconds nor a date ` +
      `Date.parse understands; using the default reference clock instead.`,
  );
  return fallback;
}

/** Convenience wrapper reading `process.env`. */
export function referenceNow(fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  return resolveReferenceNow(env[REFERENCE_NOW_ENV], fallback);
}
