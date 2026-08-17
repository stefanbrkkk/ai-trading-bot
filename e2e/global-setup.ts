/**
 * Seeds the E2E data directory when it is empty.
 *
 * The suite needs a trained ensemble: without one every signal endpoint answers
 * `503 ENGINE_NOT_READY` and fourteen tests fail on a symptom — an empty chart, a
 * missing conviction card — rather than on the cause. That is exactly what a
 * fresh clone gets, because `.data/` is git-ignored, so "checkout, install, run
 * the tests" did not work and the failure did not say why.
 *
 * The seed runs only when the bundle is absent, so the usual case is a few
 * milliseconds. `seed:fast` is the reduced budget the README names for CI and
 * E2E; the fixed `AURELIUS_SEED` is what makes the assertions in the suite
 * reproducible run to run.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DATA_DIR = process.env.AURELIUS_DATA_DIR ?? '.data/e2e';
const SEED = process.env.AURELIUS_SEED ?? '424242';

export default function globalSetup(): void {
  const bundle = join(resolve(DATA_DIR), 'models', 'ensemble.json');
  if (existsSync(bundle)) return;

  process.stdout.write(`\nNo ensemble in ${DATA_DIR}; seeding (fast budget, seed ${SEED})…\n`);
  execFileSync('npm', ['run', 'seed:fast'], {
    stdio: 'inherit',
    env: { ...process.env, AURELIUS_DATA_DIR: DATA_DIR, AURELIUS_SEED: SEED },
  });
}
