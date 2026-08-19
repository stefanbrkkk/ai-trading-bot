/**
 * The documentation as a checkable surface.
 *
 * This codebase treats its prose as part of the product, which cuts both ways: a
 * README that counts the charts, the pages and the API routes is more useful than
 * one that gestures at them, and it is also wrong the moment someone adds a file.
 * Every claim asserted here was found stale by an audit, and every one of them was
 * a number a reader could have checked in ten seconds — seventeen charts in a
 * directory holding fifteen, five routes where six answer, a build that trains
 * before it compiles when npm runs `postbuild` after `build`, a pruning floor of
 * ten columns that one of the platform's own worked examples goes under.
 *
 * So the fix is not only to correct the sentences. It is to make the next drift
 * fail here rather than in front of a buyer. Each test reads the shipped document
 * and the thing the document describes, and asserts they agree; when a legitimate
 * change moves the number, this file names the sentence that has to move with it.
 *
 * The environment is `node` and nothing here renders or trains. The one test that
 * executes platform code runs the schema pruner, which is pure over the catalog.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Before anything resolves the data directory: nothing in this file touches `.data/`.
process.env.AURELIUS_DATA_DIR = ':memory:';
const { EXAMPLE_QUESTIONS } = await import('@/lib/investgpt');
const { pruneSchema } = await import('@/lib/investgpt/prune');
const { CATALOG } = await import('@/lib/investgpt/catalog');

function path(relative: string): string {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}

function read(relative: string): string {
  return readFileSync(path(relative), 'utf8');
}

const README = read('README.md');
const ENV_EXAMPLE = read('.env.example');
const FONTS_CSS = read('public/fonts/fonts.css');

/*
 * The README is hard-wrapped at about 86 columns, so a sentence that survives a
 * rewrap is the same sentence. Prose claims are matched against the collapsed
 * text; the Layout block, where the column alignment is the layout, is matched
 * verbatim against `README`.
 */
const README_PROSE = README.replace(/\s+/g, ' ');

/** Every file under `root` whose basename is `name`, walked depth-first. */
function filesNamed(root: string, name: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === name) found.push(full);
    }
  };
  walk(root);
  return found;
}

/** Every `.ts`/`.tsx` file under `root`. */
function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(full);
    }
  };
  walk(root);
  return found;
}

describe('README counts what the tree actually holds', () => {
  it('counts the charts, and counts the two shared helpers separately', () => {
    /*
     * `src/components/charts/` holds seventeen files, and the README said
     * "17 hand-written SVG charts" in its Layout block while saying "Fifteen of
     * them" in The stack, forty lines apart. Fifteen is the true figure:
     * `DriverHover` is a React context provider and `DriverTooltip` is an HTML
     * tooltip, and neither emits an SVG element. The discriminator is that same
     * property rather than a hand-maintained list, so a new chart counts itself.
     */
    const svgElement = /<(svg|rect|circle|line|path|polyline|polygon|text|ellipse|defs)[\s/>]/;
    const dir = path('src/components/charts');
    const components = readdirSync(dir).filter((f) => f.endsWith('.tsx'));
    const charts = components.filter((f) => svgElement.test(readFileSync(`${dir}/${f}`, 'utf8')));
    const helpers = components.filter((f) => !charts.includes(f));

    expect(charts).toHaveLength(15);
    expect(helpers.sort()).toEqual(['DriverHover.tsx', 'DriverTooltip.tsx']);
    expect(README).toContain('src/components/charts/  15 hand-written SVG charts + tooltip and hover context.');
    // The prose forty lines up has to carry the same number as the tree.
    expect(README_PROSE).toContain('Every chart is hand-written SVG. Fifteen of them');
    expect(README).not.toContain('17 hand-written SVG charts');
  });

  it('counts the pages and the API routes', () => {
    const pages = filesNamed(path('src/app'), 'page.tsx').length;
    const routes = filesNamed(path('src/app/api'), 'route.ts').length;
    expect(README).toContain(`src/app/              ${pages} pages and ${routes} API routes.`);
  });

  it('counts the routes that answer with the pending-setup state', () => {
    /*
     * The README and `.env.example` both told the reader how many routes need a
     * trained ensemble, and both said five. Six route files answer 200 with
     * `setupRequired: true` through `pendingSetup`, so an unseeded deployment
     * shows the "run npm run seed" state on one more surface than documented.
     */
    const pending = sourceFiles(path('src/app/api')).filter((f) =>
      readFileSync(f, 'utf8').includes('pendingSetup('),
    );
    expect(pending).toHaveLength(6);
    expect(README_PROSE).toContain('the six routes that need the engine say what to run instead of failing');
    expect(ENV_EXAMPLE).toContain('fresh clone has no `.data/` and six routes need one');
  });
});

describe('README describes the commands npm actually runs', () => {
  it('states the build order npm imposes', () => {
    /*
     * The README said `npm run build` "trains the ensemble on first build, then
     * compiles". The trainer is wired to `postbuild`, and there is no `prebuild`,
     * so npm runs it *after* `next build` — the stated order was the reverse of
     * the one a reader would observe, on the first line of the file.
     */
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.prebuild).toBeUndefined();
    expect(pkg.scripts.build).toBe('next build');
    expect(pkg.scripts.postbuild).toContain('ensure-seed');
    expect(README).toContain('npm run build       # compiles, then trains the ensemble on first build (~3 min)');
  });
});

describe('README describes .env.example as it ships', () => {
  it('does not claim every variable is blank, because eleven are not', () => {
    /*
     * "Every variable in `.env.example` is optional and blank by default" was
     * refuted by the code block printed three lines below it, which shows
     * `AURELIUS_LLM_PROVIDER=deterministic`, `AURELIUS_MARKET_PROVIDER=simulator`
     * and `AURELIUS_BROKER=paper`. Eleven of the twenty-five assignments carry a
     * value. The claim worth making — and the one the platform's behaviour rests
     * on — is the narrower one about credentials.
     */
    const assignments = ENV_EXAMPLE.split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l));
    const nonBlank = assignments.filter((l) => /^[A-Z0-9_]+=.+/.test(l));
    expect(assignments.length).toBeGreaterThan(20);
    expect(nonBlank.length).toBeGreaterThan(0);
    expect(README_PROSE).not.toContain('optional and blank by default');
    expect(README_PROSE).toContain('what is blank is every credential');
  });

  it('ships every credential blank, which is what selects the deterministic path', () => {
    const credential = /_(API_KEY|API_KEY_ID|SECRET_KEY|SECRET|EMAIL)$|^DATABASE_URL$/;
    for (const line of ENV_EXAMPLE.split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match === null) continue;
      const [, key, value] = match;
      if (key !== undefined && credential.test(key)) expect(value, key).toBe('');
    }
  });
});

describe('README describes the pruner the code implements', () => {
  it('states the ceiling the pruner enforces, and a floor no example goes under', () => {
    /*
     * The README published "down to 10–46 columns". The ceiling is real —
     * `MAX_COLUMNS` in `prune.ts` — but there is no floor anywhere in the pruner:
     * `keptColumns` is just the number of entries that scored above the floor. The
     * platform's own second starter chip, "Technology stocks sorted by conviction
     * descending", keeps 8. A published range whose lower bound one shipped
     * example breaks is worse than no range, so the sentence now leads with the
     * bound the code guarantees.
     */
    expect(README_PROSE).toContain('829 catalog surfaces down to at most 46 columns');
    expect(README_PROSE).toContain('the eight example questions the page ships land between 8 and 46');
    expect(CATALOG.length).toBe(829);

    const kept = EXAMPLE_QUESTIONS.map((q) => pruneSchema(q).report.keptColumns);
    expect(kept).toHaveLength(8);
    for (const [i, n] of kept.entries()) {
      expect(n, `${EXAMPLE_QUESTIONS[i] ?? ''} kept ${n}`).toBeLessThanOrEqual(46);
      expect(n, `${EXAMPLE_QUESTIONS[i] ?? ''} kept ${n}`).toBeGreaterThanOrEqual(8);
    }
    expect(Math.max(...kept)).toBe(46);
  });
});

describe('README describes the broker seam the code has', () => {
  it('claims one submitter, not one broker caller', () => {
    /*
     * "`POST /api/orders/submit` is the only code path that can reach a broker"
     * overstated a control that is real. Five routes and one lib module hold a
     * broker handle: `/api/account` and `/api/positions` read it, `/api/risk/tail`
     * reads positions, `orderContext` reads the account for the margin check, and
     * the admin kill switch cancels working orders. What is singular — and what
     * the sentence was reaching for — is the submission path.
     */
    const outside = sourceFiles(path('src')).filter((f) => !f.includes('/lib/broker/'));
    const submitters = outside.filter((f) => readFileSync(f, 'utf8').includes('.submitOrder('));
    expect(submitters.map((f) => f.slice(f.indexOf('src/')))).toEqual([
      'src/app/api/orders/submit/route.ts',
    ]);
    expect(README_PROSE).toContain('`broker.submitOrder` has exactly one caller in the whole codebase');
    expect(README_PROSE).not.toContain('is the only code path that can reach a broker');
  });
});

describe('the fonts carry the licence they are distributed under', () => {
  it('ships the OFL text beside the binaries it covers', () => {
    /*
     * Three OFL 1.1 families are served to every visitor from `public/fonts/`.
     * Clause 2 requires the licence and the copyright notice to travel with the
     * font software; the subsetter had stripped nameID 13 (License Description)
     * from all eight `.woff2`, leaving a bare URL in nameID 14 as the only thing
     * accompanying them. The notices in `OFL.txt` are copied from each font's own
     * nameID 0, so they are the fonts' own words rather than a paraphrase.
     */
    const ofl = read('public/fonts/OFL.txt');
    expect(ofl).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
    expect(ofl).toContain('PERMISSION & CONDITIONS');
    expect(ofl).toContain('TERMINATION');
    expect(ofl).toContain('DISCLAIMER');
    expect(ofl).toContain('Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)');
    expect(ofl).toContain(
      'Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)',
    );
    expect(ofl).toContain(
      'Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name "Playfair Display".',
    );
    expect(FONTS_CSS).toContain('/fonts/OFL.txt');
  });

  it('covers every family it serves, and serves every file it declares', () => {
    const families = [...FONTS_CSS.matchAll(/font-family: '([^']+)'/g)].map((m) => m[1]);
    const ofl = read('public/fonts/OFL.txt');
    for (const family of new Set(families)) {
      expect(family).toBeDefined();
      if (family === undefined) continue;
      // A family served with no copyright line in OFL.txt is the defect returning
      // one font at a time.
      expect(ofl, family).toContain(family);
    }
    const shipped = readdirSync(path('public/fonts')).filter((f) => f.endsWith('.woff2'));
    expect(shipped).toHaveLength(8);
    for (const file of shipped) expect(FONTS_CSS, file).toContain(`/fonts/${file}`);
  });
});

describe('docs/BUILD_CONTRACT.md is addressed to whoever owns the code now', () => {
  it('is reachable from the README and cited from the source', () => {
    /*
     * `docs/` held one file, an internal build contract written to the agent that
     * built the platform: "Read this before writing any module", "Existing modules
     * you may import (do not modify them)". Nothing in the repository linked to it.
     * The document is accurate and six source comments cite it by name, so the
     * repair is its framing and a route to it, not its deletion — and the path has
     * to stay put, because `src/lib/quant/kalman.ts` cites it by path.
     */
    const contract = read('docs/BUILD_CONTRACT.md');
    expect(contract).toContain('# Project Aurelius — build contract');
    expect(contract).not.toContain('internal build contract');
    expect(contract).not.toContain('do not modify them');
    expect(README).toContain('[docs/BUILD_CONTRACT.md](docs/BUILD_CONTRACT.md)');

    const citing = sourceFiles(path('src')).filter((f) => readFileSync(f, 'utf8').includes('BUILD_CONTRACT'));
    expect(citing.length).toBeGreaterThan(0);
  });
});


describe('the Testing section counts the suite it is describing', () => {
  /**
   * Asked of vitest, not counted by eye or by regex.
   *
   * The README advertised 465 unit tests against a suite of 477 — the first
   * testable number in that section, and wrong, which is precisely the kind of
   * discrepancy that makes a reader start doubting the numbers on the page that
   * are right. A regex over `it(` cannot settle it either: several files
   * register their cases from a loop, so the call sites and the tests are
   * different quantities.
   *
   * `vitest list` collects the suite without executing it, so this cannot
   * recurse into itself. It costs a few seconds, and it is the only thing in
   * this file that shells out.
   *
   * `AURELIUS_LIST_ALL=1` is passed because a listing omits skipped cases, and
   * eight of this suite's cases skip themselves when no ensemble has been
   * trained. Without the flag the listing is 581 here and 573 on a clone that
   * has never run a build — so this assertion passed on the machine that wrote
   * it and failed the documented `npm run verify` on the customer's, which is
   * the only machine where it had to pass. The flag makes collection register
   * every case on both; it cannot make any of them run, because listing does not
   * execute.
   */
  it('states the number vitest actually collects', () => {
    const listed = execFileSync('npx', ['vitest', 'list', '--json'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CI: '1', AURELIUS_LIST_ALL: '1' },
    });
    const collected = (JSON.parse(listed) as unknown[]).length;
    expect(collected).toBeGreaterThan(0);

    const claimed = /^\s*(\d+)\s+unit tests\s+\(vitest\)\s*$/m.exec(README);
    expect(claimed, 'the README must state a unit-test count in its Testing block').not.toBeNull();
    expect(Number(claimed?.[1])).toBe(collected);
  }, 120_000);

  it('states the number Playwright actually collects', () => {
    const listed = execFileSync('npx', ['playwright', 'test', '--list', '--reporter=json'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CI: '1' },
    });
    /*
     * Counted by walking the suite tree, not read off `stats.expected`.
     *
     * A listing run executes nothing, so Playwright reports every case under
     * `stats.skipped` and leaves `expected` at zero — a field that looks like
     * the answer and is zero for a healthy suite.
     */
    interface Suite {
      specs?: { tests?: unknown[] }[];
      suites?: Suite[];
    }
    const countSpecs = (suites: Suite[]): number =>
      suites.reduce(
        (total, suite) =>
          total +
          (suite.specs ?? []).reduce((n, spec) => n + Math.max(1, (spec.tests ?? []).length), 0) +
          countSpecs(suite.suites ?? []),
        0,
      );
    const report = JSON.parse(listed) as { suites?: Suite[] };
    const collected = countSpecs(report.suites ?? []);
    expect(collected).toBeGreaterThan(0);

    const claimed = /^\s*(\d+)\s+E2E tests/m.exec(README);
    expect(claimed, 'the README must state an E2E count in its Testing block').not.toBeNull();
    expect(Number(claimed?.[1])).toBe(collected);
  }, 180_000);
});
