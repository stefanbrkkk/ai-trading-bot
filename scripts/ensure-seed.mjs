/**
 * Trains the ensemble after a build if the deployment has none.
 *
 * `.data/` is git-ignored — a model file has no business in version control — so a
 * clone that runs the three commands anyone runs (`npm ci`, `npm run build`,
 * `npm start`) came up with no ensemble, and five of the sixteen routes rendered
 * "run `npm run seed`" instead of a terminal. The README said to run it; that is
 * not the same as the product working when someone does the obvious thing.
 *
 * Guarded on the bundle's presence, so the usual case is a few milliseconds and a
 * rebuild never retrains. `AURELIUS_SKIP_SEED=1` skips it outright, which is what
 * a CI job that only wants to typecheck a build should set.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DATA_DIR = process.env.AURELIUS_DATA_DIR ?? '.data';
const bundle = join(resolve(DATA_DIR), 'models', 'ensemble.json');

if (process.env.AURELIUS_SKIP_SEED === '1') {
  process.stdout.write('AURELIUS_SKIP_SEED=1 — leaving the ensemble untrained.\n');
} else if (existsSync(bundle)) {
  process.stdout.write(`Ensemble already present at ${bundle}; not retraining.\n`);
} else {
  process.stdout.write(
    `\nNo ensemble in ${DATA_DIR}. Training one now so this deployment can serve signals.\n` +
      'This runs once, takes a few minutes, and is skippable with AURELIUS_SKIP_SEED=1.\n',
  );
  execFileSync('npm', ['run', 'seed'], { stdio: 'inherit', env: process.env });
}
