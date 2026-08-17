/**
 * Model persistence and the in-process engine cache.
 *
 * The trained bundle lives as a single JSON file under the data directory.
 * Requests only ever read it, and it is parsed once per process. If the file is
 * missing the caller is told so explicitly rather than silently getting random
 * weights — a signal from an untrained model would be worse than no signal.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ModelBundle, type SerialisedModelBundle } from './model';

export function dataDir(): string {
  return resolve(process.env.AURELIUS_DATA_DIR ?? '.data');
}

export function modelPath(): string {
  return join(dataDir(), 'models', 'ensemble.json');
}

export function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function saveModelBundle(bundle: ModelBundle): string {
  const path = modelPath();
  ensureDir(path);
  writeFileSync(path, JSON.stringify(bundle.serialise()), 'utf8');
  return path;
}

export interface ModelStatus {
  present: boolean;
  path: string;
  version: string | null;
  createdAt: number | null;
  sizeBytes: number | null;
  /** Reason the model is unavailable, when it is. */
  reason: string | null;
}

export function modelStatus(): ModelStatus {
  const path = modelPath();
  if (!existsSync(path)) {
    return {
      present: false,
      path,
      version: null,
      createdAt: null,
      sizeBytes: null,
      reason: 'No trained ensemble found. Run `npm run seed` to train and persist one.',
    };
  }
  try {
    const stats = statSync(path);
    const bundle = loadModelBundle();
    return {
      present: true,
      path,
      version: bundle.version,
      createdAt: bundle.createdAt,
      sizeBytes: stats.size,
      reason: null,
    };
  } catch (error) {
    return {
      present: false,
      path,
      version: null,
      createdAt: null,
      sizeBytes: null,
      reason: `The persisted ensemble could not be loaded: ${error instanceof Error ? error.message : 'unknown error'}. Re-run \`npm run seed\`.`,
    };
  }
}

let cachedBundle: { bundle: ModelBundle; mtimeMs: number } | null = null;

/**
 * Loads the persisted bundle, memoised on the file's mtime so a re-seed is
 * picked up without a restart.
 */
export function loadModelBundle(): ModelBundle {
  const path = modelPath();
  if (!existsSync(path)) {
    throw new Error(
      `No trained ensemble at ${path}. Run \`npm run seed\` to build one — the platform ships without a checked-in model file.`,
    );
  }
  const stats = statSync(path);
  if (cachedBundle && cachedBundle.mtimeMs === stats.mtimeMs) return cachedBundle.bundle;

  const raw = JSON.parse(readFileSync(path, 'utf8')) as SerialisedModelBundle;
  const bundle = ModelBundle.deserialise(raw);
  cachedBundle = { bundle, mtimeMs: stats.mtimeMs };
  return bundle;
}

/** Returns the bundle, or null when it is absent or unreadable. */
export function tryLoadModelBundle(): ModelBundle | null {
  try {
    return loadModelBundle();
  } catch {
    return null;
  }
}

export function clearModelCache(): void {
  cachedBundle = null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Generic JSON artefact store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Small helper for the other seeded artefacts (feature history, publication
 * snapshots, backtest fixtures). Keeps them beside the model rather than in the
 * database, since they are derived data that a re-seed regenerates wholesale.
 */
export function artefactPath(name: string): string {
  return join(dataDir(), 'artefacts', `${name}.json`);
}

export function saveArtefact(name: string, value: unknown): string {
  const path = artefactPath(name);
  ensureDir(path);
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

export function loadArtefact<T>(name: string): T | null {
  const path = artefactPath(name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function artefactExists(name: string): boolean {
  return existsSync(artefactPath(name));
}
