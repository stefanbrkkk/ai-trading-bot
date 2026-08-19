/**
 * The chrome: what the header knows about the session, and what it claims about
 * the routes it runs on.
 *
 * Two defects, one behavioural and one documentary, and they meet in the same
 * three files.
 *
 *   1. `AccountMenu` read `/auth/me` once at mount and thereafter only on a
 *      60-second poll. The root layout survives a client-side navigation, so a
 *      user who signed up, accepted the clickwrap and landed on /terminal was
 *      shown "Sign in" by the only account control in the product for up to a
 *      full minute, while the page beneath it — and `/api/auth/me` fetched from
 *      that very page — had the session. Measured against a running build the
 *      header flipped at t+61s, having mounted at t+0.3s.
 *   2. The chrome counted the routes it runs on as thirteen, and `PageState`
 *      counted the pages it serves as fifteen. The tree holds sixteen `page.tsx`
 *      files, the README publishes sixteen, and the E2E `PAGES` array lists
 *      sixteen. Thirteen was the sixteen less /login, /signup and /onboarding —
 *      the three pages a new client sees first, and three the header runs on
 *      like any other.
 *
 * The environment is vitest's `node`, which has no DOM, so nothing here mounts a
 * component. The rule the fix turns on is a pure predicate exported from
 * `AccountMenu` for exactly that reason, and it is exercised directly; the wiring
 * that puts the predicate on the navigation path is asserted against the source,
 * which is the only place it is observable without a browser.
 *
 * The counts are read off the tree rather than transcribed, so the next page
 * added to `src/app` fails here and names the sentences that have to move with
 * it, rather than quietly making three comments wrong again.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { sessionNeedsReread } from '@/components/chrome/AccountMenu';

function path(relative: string): string {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}

function read(relative: string): string {
  return readFileSync(path(relative), 'utf8');
}

const ACCOUNT_MENU = read('src/components/chrome/AccountMenu.tsx');
const TOP_BAR = read('src/components/chrome/TopBar.tsx');
const PAGE_STATE = read('src/components/PageState.tsx');
const ROOT_LAYOUT = read('src/app/layout.tsx');
const README = read('README.md');

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
      else if (/\.tsx?$/.test(entry)) found.push(full);
    }
  };
  walk(root);
  return found;
}

/**
 * The number words these comments are written in.
 *
 * The prose in this codebase spells its counts out, so a test that only looked
 * for digits would pass over every claim it is meant to police.
 */
const NUMBER_WORD: Record<string, number> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

// ─────────────────────────────────────────────────────────────────────────────
//  1. The header re-reads the session when the route changes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replays a browsing path through the guard the effect uses.
 *
 * The ref is seeded with the path the header mounted on, and React re-runs the
 * effect on every render — including renders where nothing navigated — so the
 * sequence is fed through verbatim rather than de-duplicated first. What comes
 * back is the number of `/auth/me` requests the route-change re-read would
 * issue over that path, on top of the one `useApi` makes at mount.
 */
function rereadsAlong(visited: readonly string[]): number {
  let readOn: string | null = visited[0] ?? null;
  let rereads = 0;
  for (const pathname of visited) {
    if (!sessionNeedsReread(readOn, pathname)) continue;
    readOn = pathname;
    rereads += 1;
  }
  return rereads;
}

describe('the account control re-reads the session on a route change', () => {
  it('does not re-read the route it mounted on', () => {
    // `useApi` has already fetched this one; a second request would double every
    // cold load for nothing.
    expect(sessionNeedsReread('/terminal', '/terminal')).toBe(false);
    expect(rereadsAlong(['/terminal', '/terminal', '/terminal'])).toBe(0);
  });

  it('re-reads on the navigation a sign-in performs', () => {
    // AuthForm: `router.push('/terminal')` for an account that has accepted.
    expect(sessionNeedsReread('/login', '/terminal')).toBe(true);
    expect(rereadsAlong(['/login', '/terminal'])).toBe(1);
  });

  it('re-reads once per hop on the signup path, and not on the renders between', () => {
    // /signup → /onboarding (clickwrap) → /terminal, with the re-renders each
    // page performs as its own requests settle.
    expect(rereadsAlong(['/signup', '/signup', '/onboarding', '/onboarding', '/onboarding', '/terminal'])).toBe(2);
  });

  it('treats an absent pathname as nothing to do', () => {
    expect(sessionNeedsReread(null, null)).toBe(false);
    expect(sessionNeedsReread('/terminal', null)).toBe(false);
  });
});

describe('the re-read is wired to the navigation, not only to the poll', () => {
  it('takes the pathname from the router and seeds the ref with it', () => {
    expect(ACCOUNT_MENU).toContain("import { usePathname } from 'next/navigation';");
    expect(ACCOUNT_MENU).toContain('const pathname = usePathname();');
    // Seeded, not null: that is what makes the mount a no-op rather than a
    // duplicate request.
    expect(ACCOUNT_MENU).toContain('const readOn = useRef<string | null>(pathname);');
  });

  it('calls reload() from an effect that depends on the pathname', () => {
    const effect = /useEffect\(\(\) => \{\s*if \(!sessionNeedsReread\(readOn\.current, pathname\)\) return;\s*readOn\.current = pathname;\s*reload\(\);\s*\}, \[pathname, reload\]\);/;
    expect(ACCOUNT_MENU).toMatch(effect);
  });

  it('keeps the poll, which is what covers a sign-out in another tab', () => {
    expect(ACCOUNT_MENU).toContain("useApi<MeResponse>('/auth/me', { pollMs: 60_000 })");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. The route count the chrome publishes
// ─────────────────────────────────────────────────────────────────────────────

describe('the chrome counts the routes it actually runs on', () => {
  const pages = filesNamed(path('src/app'), 'page.tsx');

  it('finds sixteen pages, which is what the README publishes', () => {
    expect(pages).toHaveLength(16);
    expect(README).toContain('16 pages and 31 API routes');
  });

  it('renders the header from the one root layout, so no page can opt out', () => {
    const roots = sourceFiles(path('src/app')).filter((file) => readFileSync(file, 'utf8').includes('<html'));
    expect(roots).toEqual([path('src/app/layout.tsx')]);
    expect(ROOT_LAYOUT).toContain('<TopBar />');
    // No route check and no early return: the header is returned unconditionally.
    expect(TOP_BAR).toContain('export function TopBar() {');
    expect(TOP_BAR).not.toContain('usePathname');
  });

  it('states that count as sixteen in both chrome files', () => {
    for (const [name, source] of [
      ['TopBar', TOP_BAR],
      ['AccountMenu', ACCOUNT_MENU],
    ] as const) {
      const claims = [...source.matchAll(/\b([a-z]+)\s+routes\b/g)]
        .map((match) => match[1] as string)
        .filter((word) => word in NUMBER_WORD);
      expect(claims.length, `${name} makes no route-count claim`).toBeGreaterThan(0);
      for (const word of claims) expect(NUMBER_WORD[word], `${name} says "${word} routes"`).toBe(pages.length);
    }
  });

  it('no longer publishes the denominator that dropped the three auth routes', () => {
    // The three it dropped, each a real page that renders this header.
    for (const route of ['login', 'signup', 'onboarding']) {
      expect(pages.some((file) => file.endsWith(`/${route}/page.tsx`))).toBe(true);
    }
    expect(TOP_BAR).not.toContain('12 of 13 routes');
    expect(ACCOUNT_MENU).not.toContain('thirteen routes');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. The counts PageState publishes
// ─────────────────────────────────────────────────────────────────────────────

describe('PageState counts what it serves', () => {
  it('counts the async panels it announces for', () => {
    const panels = sourceFiles(path('src')).reduce(
      (total, file) => total + (readFileSync(file, 'utf8').match(/<AsyncSlot\b/g)?.length ?? 0),
      0,
    );
    expect(panels).toBe(17);
    const claim = /on every async panel in the product, ([a-z]+) of them/.exec(PAGE_STATE.replace(/\s+/g, ' '));
    expect(claim, 'PageState no longer counts its async panels').not.toBeNull();
    expect(NUMBER_WORD[(claim as RegExpExecArray)[1] as string]).toBe(panels);
  });

  it('makes no page count that disagrees with the pages that load data', () => {
    /*
     * "fifteen pages" matched nothing in the tree: sixteen pages import this
     * module, ten of them render an `AsyncSlot`, and the three states the
     * sentence is about are the ones `AsyncSlot` renders. A restatement is what
     * this file carries now, so the guard is that any number put back here has
     * to be the real one.
     */
    const dataPages = filesNamed(path('src/app'), 'page.tsx').filter((file) =>
      readFileSync(file, 'utf8').includes('<AsyncSlot'),
    );
    expect(dataPages).toHaveLength(10);
    for (const match of PAGE_STATE.replace(/\s+/g, ' ').matchAll(/\b([a-z]+)\s+pages\b/g)) {
      const word = match[1] as string;
      if (!(word in NUMBER_WORD)) continue;
      expect(NUMBER_WORD[word], `PageState says "${word} pages"`).toBe(dataPages.length);
    }
  });
});
