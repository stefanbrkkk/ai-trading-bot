/**
 * Row coercion helpers.
 *
 * SQLite is dynamically typed, so a column declared INTEGER can still hand
 * back a string if something wrote one. Rather than sprinkle casts through the
 * repositories, every read funnels through these narrowing helpers: they keep
 * `any` out of the layer entirely and make a schema drift surface as a
 * predictable value instead of a runtime type error deep inside the UI.
 */

import type { SqlRow, SqlValue } from '@/lib/db/driver';

/** Storage encoding for booleans — SQLite has no boolean type. */
export function flag(value: boolean): number {
  return value ? 1 : 0;
}

export function toNumber(value: SqlValue | undefined, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function num(row: SqlRow, key: string, fallback = 0): number {
  return toNumber(row[key], fallback);
}

export function numOrNull(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return toNumber(value, 0);
}

export function str(row: SqlRow, key: string, fallback = ''): string {
  const value = row[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return fallback;
}

export function strOrNull(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

export function bool(row: SqlRow, key: string): boolean {
  return num(row, key, 0) !== 0;
}

export function bytesOrNull(row: SqlRow, key: string): Uint8Array | null {
  const value = row[key];
  return value instanceof Uint8Array ? value : null;
}

/**
 * A narrowed enum read. Keeps a corrupted or newly-added label from
 * propagating as an impossible union member into typed domain objects.
 */
export function enumOr<T extends string>(
  row: SqlRow,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = str(row, key, fallback);
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** JSON columns are stored as TEXT; a parse failure degrades to `fallback`. */
export function parseJson<T>(raw: SqlValue | undefined, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function jsonColumn<T>(row: SqlRow, key: string, fallback: T): T {
  return parseJson(row[key], fallback);
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function jsonTextOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** Money is stored in cents (INTEGER) so no float ever reaches the ledger. */
export function toCents(usd: number): number {
  return Math.round(usd * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}
