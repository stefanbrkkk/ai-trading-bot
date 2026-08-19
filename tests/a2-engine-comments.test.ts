/**
 * The engine's comments about the ensemble say something true.
 *
 * Three source comments described measurements that the shipped bundle
 * contradicted. All three had been correct when they were written and were
 * falsified by a change somewhere else — a retrain, or a constant being raised —
 * which is the failure mode this file exists to catch, because nothing about a
 * stale sentence breaks a test or a page.
 *
 *   1. `model.ts` and `pipeline.ts` each quoted the agent-discrimination figures
 *      of a superseded seed while asserting they described the bundled one. The
 *      retrain that replaced the bundle moved README.md onto the new numbers and
 *      left the two comments behind.
 *   2. `service.ts` said the universe sweep reads each artefact 64 times. It
 *      reads it once per tradable symbol, and 64 was the truncating sweep limit
 *      that the docstring twenty lines above it records as a removed defect — so
 *      one file used the same 64 for two things that cannot both be true.
 *
 * The repair in both cases was to stop transcribing the number, exactly as
 * `tests/fix-signal-coherence.test.ts` §8 did for the feature-vector width:
 * substituting today's value only resets the clock on the same defect. So the
 * assertions below are of two kinds — the comments state no figure a retrain or
 * a universe edit can falsify, and the qualitative claims they do make are
 * checked against the artefacts they describe.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..');

// The engine store resolves the data directory at first use, so this has to be
// set before the dynamic imports below. `models/` is symlinked in where a seed
// exists so the bundle-backed cases run locally and skip on a fresh clone;
// nothing here writes to `.data/`.
const SCRATCH_DATA = mkdtempSync(join(tmpdir(), 'aurelius-engine-comments-'));
for (const dir of ['models', 'artefacts']) {
  const source = join(REPO_ROOT, '.data', dir);
  if (existsSync(source)) symlinkSync(source, join(SCRATCH_DATA, dir), 'dir');
}
process.env.AURELIUS_DATA_DIR = SCRATCH_DATA;

const { AGENT_DISCRIMINATION_FLOOR } = await import('@/lib/engine/model');
const { UNIVERSE_SWEEP_LIMIT } = await import('@/lib/engine/service');
const { tryLoadModelBundle } = await import('@/lib/engine/store');
const { TRADABLE_SYMBOLS } = await import('@/lib/market/universe');

const source = (file: string): string =>
  readFileSync(join(REPO_ROOT, 'src', 'lib', 'engine', file), 'utf8');

/**
 * The `/* … *\/` block whose opening sentence contains `anchor`.
 *
 * Scoped rather than whole-file: these modules legitimately write decimals in
 * code and in comments about other quantities, and only the two blocks that
 * reason about agent discrimination are under test here.
 */
function commentBlock(file: string, anchor: string): string {
  const blocks = source(file)
    .split('/*')
    .slice(1)
    .map((chunk) => chunk.split('*/')[0] ?? '');
  const match = blocks.filter((block) => block.includes(anchor));
  expect(match, `no comment block in ${file} contains "${anchor}"`).toHaveLength(1);
  return match[0] as string;
}

/** Text with every double-quoted span removed, so a quotation is not a claim. */
function unquoted(text: string): string {
  return text.replace(/"[^"]*"/g, '');
}

/** Comment text with the leading ` * ` gutter and wrapping collapsed to spaces. */
function prose(text: string): string {
  return text.replace(/\s*\n\s*\*\s?/g, ' ').replace(/\s+/g, ' ').trim();
}

const DECIMAL = /\d+\.\d+(?:e[+-]?\d+)?|\d+e[+-]?\d+/gi;

// ─────────────────────────────────────────────────────────────────────────────
//  1. No engine comment transcribes an agent's discrimination
// ─────────────────────────────────────────────────────────────────────────────

describe('the agent-discrimination comments', () => {
  const blocks = [
    ['model.ts', "How much each agent's output actually moves with its input"],
    ['pipeline.ts', 'An agent that does not discriminate carries no conviction into the router'],
  ] as const;

  it.each(blocks)('states no measured figure in %s', (file, anchor) => {
    /*
     * `model.ts` opened "~0.492 … a spread of 1.4e-3 … against 0.17 for the
     * LSTM" and `pipeline.ts` "scores 1.4e-3 against 0.17 for the 5m LSTM", both
     * asserting the figures described the bundled seed. The seed on disk read
     * 0.0027 for the TFT and 0.072 for the LSTM, and 0.17 matched none of the
     * three agents. `.data/` is git-ignored, so every deployment refits these
     * numbers and no transcription of them survives contact with `npm run seed`.
     *
     * Both blocks now name `AGENT_DISCRIMINATION_FLOOR` and describe the shape.
     * Each still records verbatim what it used to say, in quotes, so the quoted
     * spans are stripped before the scan: a comment may report the old figure as
     * history, but it may not assert a new one.
     */
    const decimals = unquoted(commentBlock(file, anchor)).match(DECIMAL) ?? [];
    expect(decimals, `${file} writes a measurement out as a literal`).toEqual([]);
  });

  it.each(blocks)('points %s at the surface that publishes the live figure', (file, anchor) => {
    // The comments' own answer to "then what is the number?" has to stay
    // reachable, or stripping the literal just deletes the information.
    expect(commentBlock(file, anchor)).toMatch(/model-card|\/transparency/);
  });

  it('describes the shape the served bundle actually has', () => {
    const bundle = tryLoadModelBundle();
    if (!bundle) return; // Unseeded clone: there is no bundle to disagree with.
    const { lstm, bilstm, tft } = bundle.training.discrimination;

    // "The 60m TFT collapses … a spread below `AGENT_DISCRIMINATION_FLOOR`".
    expect(tft).toBeLessThan(AGENT_DISCRIMINATION_FLOOR);
    // "…while the 5m LSTM and the 15m BiLSTM clear that floor several times
    // over." Several is taken as three; the seeded pair clear it by 7x and 12x,
    // and the superseded seed this comment used to quote cleared it by 17x and
    // 16x, so the claim is about the shape rather than about either fit.
    expect(lstm).toBeGreaterThan(AGENT_DISCRIMINATION_FLOOR * 3);
    expect(bilstm).toBeGreaterThan(AGENT_DISCRIMINATION_FLOOR * 3);

    // "one fixed offset applied to all 67 names rather than a reading of any of
    // them" — exactly one agent is discarded, so the router still has a vote.
    const collapsed = [lstm, bilstm, tft].filter((d) => d < AGENT_DISCRIMINATION_FLOOR);
    expect(collapsed).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. The artefact-memo docstring counts what the sweep actually does
// ─────────────────────────────────────────────────────────────────────────────

describe('the artefact-memo docstring in service.ts', () => {
  const memo = (): string =>
    commentBlock('service.ts', 'Artefact reads are memoised per process');

  it('names no read count', () => {
    /*
     * It said the sweep "would otherwise do that 64 times per artefact". The
     * sweep runs `TRADABLE_SYMBOLS.slice(0, UNIVERSE_SWEEP_LIMIT)`, and the
     * limit had been raised to 128 precisely because 64 truncated the universe —
     * so the file was using 64 both as the number of names swept and as the
     * number that was too small to sweep them.
     */
    expect(unquoted(memo())).not.toMatch(/\b\d+ times\b/);
    expect(prose(memo())).toMatch(/once per tradable symbol/);
  });

  it('is right that the sweep covers every tradable name', () => {
    expect(TRADABLE_SYMBOLS.length).toBeLessThanOrEqual(UNIVERSE_SWEEP_LIMIT);
    expect(TRADABLE_SYMBOLS.slice(0, UNIVERSE_SWEEP_LIMIT)).toHaveLength(TRADABLE_SYMBOLS.length);
    // The retired literal is not a synonym for the current count, which is the
    // whole reason it read as current.
    expect(TRADABLE_SYMBOLS.length).not.toBe(64);
  });

  it('memoises the three artefacts it says it does', () => {
    // "once per tradable symbol for each of the three artefacts below" — one
    // `loadArtefact` call behind one lazily-filled module slot, three times over.
    // `universeCache` is deliberately not counted: it memoises the sweep's own
    // output, not a file read, and is invalidated per 5-minute bucket.
    const text = source('service.ts');
    const artefacts = [...text.matchAll(/loadArtefact<[^(]*\('([a-z-]+)'\)/g)].map((m) => m[1]);
    expect(new Set(artefacts).size).toBe(3);
    expect(text.match(/^let \w+Cache: [^;]*\| null \| undefined;$/gm) ?? []).toHaveLength(3);
  });

  it('still drops the three names the sweep-limit docstring names', () => {
    // The post-mortem above `UNIVERSE_SWEEP_LIMIT` is the sentence that makes 64
    // read as a defect rather than as a budget, so it has to keep being true of
    // the table it describes.
    expect(TRADABLE_SYMBOLS.slice(64)).toEqual(['SMCI', 'RIOT', 'BYND']);
  });
});

process.on('exit', () => rmSync(SCRATCH_DATA, { recursive: true, force: true }));
