/**
 * The table floor in `src/app/globals.css`, and the widths it is allowed to be
 * absent at.
 *
 * `TableShell` publishes a per-table minimum width as `--table-min-width` and a
 * single stylesheet rule applies it to `.scroll-x > table`. That rule used to be
 * wrapped in `@media (min-width: 640px)`, which meant the floor was switched off
 * at exactly the widths a floor is for. The reasoning recorded at the call site
 * was that a phone is better served by letting the table lay out to the width it
 * has and wrap — but an `auto`-layout table cannot be narrower than its own
 * min-content width, so releasing the floor does not fit the table to the port.
 * It parks it at min-content, every column crushed to its longest unbreakable
 * token at once. Measured against the running build at 375: /control's pre-trade
 * limits table sat at 563px inside a 333px scrollport — still scrolling
 * sideways, which is the one thing the gate was meant to avoid — with rows 193,
 * 271, 329 and 485px tall against 76px for the same rows at 1280.
 *
 * The environment is vitest's `node`, which has no layout engine, so nothing
 * here can re-measure a row. What it can do is pin the two things that made the
 * defect possible and would make it possible again:
 *
 *   1. the floor is applied unconditionally — asserted by parsing the
 *      stylesheet's block structure and reporting the at-rules a declaration is
 *      nested inside, rather than by matching a string that would still pass if
 *      someone re-wrapped the rule in a differently-spelled media query;
 *   2. the numbers the rule and its comment quote are read off the call sites
 *      rather than transcribed, so a `TableShell` default or a published floor
 *      that moves fails here and names the sentence that has to move with it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

const GLOBALS = read('src/app/globals.css');
const PRIMITIVES = read('src/components/ui/primitives.tsx');
const PORTFOLIO = read('src/app/portfolio/page.tsx');
const TERMINAL = read('src/app/terminal/[symbol]/page.tsx');
const ADMIN = read('src/app/admin/page.tsx');

/** One declaration found in the stylesheet, with the context it sits in. */
interface Declaration {
  /** The selector of the rule block holding it, whitespace-collapsed. */
  readonly selector: string;
  /** The property name, lower-cased. */
  readonly property: string;
  /** Everything after the colon, trimmed. */
  readonly value: string;
  /**
   * The `@media`/`@supports`/`@layer` preludes wrapping it, outermost first.
   * Empty means the declaration applies at every width and in every context.
   */
  readonly wrappedBy: readonly string[];
}

/**
 * Walks a stylesheet's braces and yields every declaration with the stack of
 * preludes above it.
 *
 * Deliberately structural rather than textual. The defect this file exists for
 * was a rule that was present, correct and completely inert because of one line
 * fifty characters away from it, and a test that greps for `min-width:
 * var(--table-min-width` would have passed throughout. Comments and strings are
 * skipped so a brace inside either — this stylesheet's comments quote CSS, and
 * its `select` arrow is a data URI full of punctuation — cannot shift the depth.
 */
function declarations(css: string): Declaration[] {
  const found: Declaration[] = [];
  const stack: string[] = [];
  let buffer = '';
  let i = 0;

  while (i < css.length) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < css.length && css[j] !== quote) j += css[j] === '\\' ? 2 : 1;
      buffer += css.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      stack.push(buffer.replace(/\s+/g, ' ').trim());
      buffer = '';
      i += 1;
      continue;
    }
    if (ch === '}') {
      stack.pop();
      buffer = '';
      i += 1;
      continue;
    }
    if (ch === ';') {
      const colon = buffer.indexOf(':');
      if (colon !== -1 && stack.length > 0) {
        found.push({
          selector: stack[stack.length - 1] ?? '',
          property: buffer.slice(0, colon).trim().toLowerCase(),
          value: buffer.slice(colon + 1).trim(),
          wrappedBy: stack.slice(0, -1).filter((prelude) => prelude.startsWith('@')),
        });
      }
      buffer = '';
      i += 1;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  return found;
}

const DECLARATIONS = declarations(GLOBALS);

describe('the parser the rest of this file depends on', () => {
  it('reports the nesting of a declaration rather than its text', () => {
    const parsed = declarations(`
      /* a comment with a { brace in it */
      .plain { min-width: 10px; }
      @media (min-width: 640px) {
        @supports (display: grid) {
          .nested { min-width: 20px; }
        }
      }
      .quoted { background-image: url("data:image/svg+xml,%3Csvg}%3E"); }
    `);
    expect(parsed.map((d) => [d.selector, d.property, d.wrappedBy])).toEqual([
      ['.plain', 'min-width', []],
      ['.nested', 'min-width', ['@media (min-width: 640px)', '@supports (display: grid)']],
      ['.quoted', 'background-image', []],
    ]);
  });
});

describe('the table floor applies at every width', () => {
  const floors = DECLARATIONS.filter((d) => d.selector === '.scroll-x > table' && d.property === 'min-width');

  it('declares the floor exactly once, and outside every at-rule', () => {
    expect(floors).toHaveLength(1);
    // The whole defect: this list used to be ['@media (min-width: 640px)'].
    expect(floors[0]?.wrappedBy).toEqual([]);
  });

  it('reads the floor the call site published rather than hard-coding one', () => {
    expect(floors[0]?.value).toBe('var(--table-min-width, 900px)');
  });

  it('keeps the clipping guard that stops the overflow reaching the page body', () => {
    /*
     * The floor and the guard only work as a pair. `min-width: 0` is what lets
     * `.scroll-x` be narrower than its content inside a grid or flex parent; a
     * 900px table under a container that refuses to shrink pushes the cell, the
     * cell pushes the page, and the phone scrolls sideways as a whole. Raising
     * the floor at sub-640px widths is precisely the change that would expose
     * that, so the guard is pinned here rather than left to be noticed.
     */
    const guard = DECLARATIONS.filter((d) => d.selector === '.scroll-x' && d.property === 'min-width');
    expect(guard).toHaveLength(1);
    expect(guard[0]?.value).toBe('0');
    expect(guard[0]?.wrappedBy).toEqual([]);
  });
});

describe('the numbers the stylesheet quotes are the numbers the call sites publish', () => {
  /*
   * The rule's own docstring, unwrapped into one line.
   *
   * Matching it as it sits in the file would make these assertions hostage to
   * where the 100-column wrap happens to fall: "/portfolio (520), /terminal
   * (560) and /admin (980)" is one phrase to a reader and two lines with a
   * ` * ` between them to `indexOf`. Stripping the comment furniture and
   * collapsing the whitespace tests the sentence rather than its typesetting.
   */
  const start = GLOBALS.indexOf("A table's minimum width");
  const comment = GLOBALS.slice(start, GLOBALS.indexOf('.scroll-x > table', start))
    .replace(/^\s*\*\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  it('quotes the same default as TableShell', () => {
    const fallback = /var\(--table-min-width,\s*(\d+)px\)/.exec(GLOBALS)?.[1];
    const shellDefault = /minWidth\s*=\s*(\d+)\s*,/.exec(PRIMITIVES)?.[1];
    expect(shellDefault).toBeDefined();
    expect(fallback).toBe(shellDefault);
    expect(comment).toContain(`blanket ${shellDefault}px default`);
  });

  it('names three pages that really do publish their own floor', () => {
    // The comment offers `minWidth` as the escape hatch for a table that fits a
    // phone, and cites three call sites as proof it is a used API rather than a
    // suggestion. If one of them stops publishing, the proof goes with it.
    expect(PORTFOLIO).toContain('minWidth={520}');
    expect(TERMINAL).toContain('minWidth={560}');
    expect(ADMIN).toContain('minWidth={980}');
    expect(comment).toContain('/portfolio (520), /terminal (560) and /admin (980)');
  });

  it('no longer describes the floor as conditional', () => {
    // The sentence that has to move with the rule. It read "applied only from
    // `sm` up", which is what the media query made true and nothing else does.
    expect(comment).not.toContain('only from `sm` up');
    // Structural, not textual: the comment itself quotes the gate it removed, so
    // the stylesheet still contains that string and always should. What must not
    // come back is a width-conditional block wrapping anything at all.
    const widthGated = DECLARATIONS.filter((d) => d.wrappedBy.some((prelude) => prelude.includes('width')));
    expect(widthGated).toEqual([]);
  });
});
