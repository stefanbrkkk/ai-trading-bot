/**
 * The two charts a reader takes numbers off, and the claims they make about
 * themselves.
 *
 * Both cases here were confirmed by an adversarial audit of the shipped tree.
 *
 *   1. On `/terminal/AAPL` every published level — the entry zone, the
 *      invalidation, both targets and VWAP — was printed straight onto the plot
 *      with nothing behind it, so each one had a dashed rule, a grid line, the
 *      gold entry band or a candle drawn through its digits. `spreadLabels`
 *      separates the labels from each *other*, which was read as having solved
 *      collision; it had not, because moving a label off its own line moves it
 *      onto somebody else's.
 *
 *   2. `ConvictionDial`'s header asserted that the Flubber mixer "mounts on the
 *      first morph and not before" and that "a dial that is never unspooled
 *      never loads it", after `prewarmMorph` had made both false for the symbol
 *      page. That is a documentation defect with no runtime symptom, so it is
 *      checked here the way `fix-docs.test.ts` checks the README: by reading the
 *      shipped file and the thing it describes and asserting they agree.
 *
 * The first case is asserted against the SVG the component actually emits rather
 * than against a re-implementation of its layout, because a re-implementation
 * would agree with itself no matter what the component did. `useChartWidth`
 * returns its fallback under a server render, so the geometry is the 920-unit
 * viewBox the symbol page lays out at; it is also width-independent here — the
 * height is fixed and the viewBox scales uniformly — which is why the audit
 * measured the identical collision set at six breakpoints.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/*
 * The project compiles JSX through Next, so `tsconfig.json` sets `jsx:
 * "preserve"` and vitest's esbuild falls back to the classic
 * `React.createElement` transform with no automatic runtime to import it. The
 * component modules are therefore rendered against a global `React`, and the
 * import that follows is dynamic so the global is in place before any of them
 * evaluate.
 */
(globalThis as unknown as { React: typeof React }).React = React;

const { PriceChart, levelLabelPlate } = await import('@/components/charts/PriceChart');

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. The published levels, and what is drawn through them
// ─────────────────────────────────────────────────────────────────────────────

/** AAPL's published levels and session VWAP, verbatim from `GET /api/signals/AAPL`. */
const LEVELS = {
  entryZoneLow: 140.6038630667431,
  entryZoneHigh: 142.7961369332569,
  invalidation: 148.2768215995413,
  target1: 131.834767600688,
  target2: 124.1618090678898,
};
const VWAP = 140.85393293206351;

/**
 * Twelve bars that reproduce the price domain of AAPL's 180 real ones.
 *
 * The collision is a property of the domain, not of the bar count: the levels
 * span 124.16–148.28 inside a domain running to 338.35, so all five labels land
 * within 36px of each other and `spreadLabels` pushes each onto its neighbours'
 * rules. Padding out to 180 recorded bars would change nothing but the size of
 * this file — with these endpoints the emitted baselines are the same numbers to
 * the last decimal as the live series produces.
 */
function bars() {
  const rows = [];
  for (let i = 0; i < 12; i += 1) {
    const close = 313 - i * 15;
    rows.push({
      time: 1_764_340_200_000 + i * 86_400_000,
      open: close + 2,
      high: close + 4,
      low: close - 4,
      close,
      volume: 1_000_000,
    });
  }
  // The top of the domain is the Kalman band's first upper bound on the real
  // series, and the bottom of the bars is the lowest session low.
  rows[0]!.high = 338.3476164704765;
  rows[11]!.low = 137.7;
  return rows;
}

interface Mark {
  /** Document order. Later means painted on top. */
  order: number;
  tag: string;
  attrs: Record<string, string>;
  content: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Advance width and cap height of the 9px mono face the labels are drawn in. */
const CHAR_PX = 5.4;
const CAP_PX = 6.57;

/**
 * Every `rect`, `line` and `text` the chart emitted, boxed and in paint order.
 *
 * `text` boxes are the glyph ink: the advance width from the anchor, and the cap
 * height above the baseline. Nothing in this environment has layout, which is
 * exactly why the component sizes its plates from the same arithmetic instead of
 * from a `getBBox` — see `LEVEL_CHAR_PX` in `PriceChart`.
 */
function marks(html: string): Mark[] {
  const out: Mark[] = [];
  const element = /<(rect|line|text)\b([^>]*)>([^<]*)/g;
  let match: RegExpExecArray | null;
  while ((match = element.exec(html)) !== null) {
    const attrs: Record<string, string> = {};
    for (const pair of (match[2] as string).matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attrs[pair[1] as string] = pair[2] as string;
    }
    const num = (key: string): number => Number(attrs[key] ?? NaN);
    const tag = match[1] as string;
    const content = tag === 'text' ? (match[3] as string) : '';
    let box: [number, number, number, number];
    if (tag === 'rect') {
      box = [num('x'), num('y'), num('x') + num('width'), num('y') + num('height')];
    } else if (tag === 'line') {
      box = [
        Math.min(num('x1'), num('x2')),
        Math.min(num('y1'), num('y2')),
        Math.max(num('x1'), num('x2')),
        Math.max(num('y1'), num('y2')),
      ];
    } else {
      const width = content.length * CHAR_PX;
      const left = attrs['text-anchor'] === 'end' ? num('x') - width : num('x');
      box = [left, num('y') - CAP_PX, left + width, num('y')];
    }
    out.push({ order: out.length, tag, attrs, content, x0: box[0], y0: box[1], x1: box[2], y1: box[3] });
  }
  return out;
}

function overlaps(a: Mark, b: Mark): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function contains(outer: Mark, inner: Mark): boolean {
  return outer.x0 <= inner.x0 && outer.y0 <= inner.y0 && outer.x1 >= inner.x1 && outer.y1 >= inner.y1;
}

const PLATE_FILL = '#141414';

const CHART = marks(
  renderToStaticMarkup(React.createElement(PriceChart, { bars: bars(), levels: LEVELS, vwap: VWAP })),
);

/** The five figures a reader acts on, as they are printed on the chart. */
const PUBLISHED = ['INVALIDATION 148.28', 'T1 131.83', 'T2 124.16', 'ENTRY 140.60–142.80', 'VWAP 140.85'];

function label(text: string): Mark {
  const found = CHART.filter((mark) => mark.tag === 'text' && mark.content === text);
  expect(found, `${text} is drawn exactly once`).toHaveLength(1);
  return found[0] as Mark;
}

function plateFor(text: string): Mark {
  const glyphs = label(text);
  const found = CHART.filter(
    (mark) => mark.tag === 'rect' && mark.attrs['fill'] === PLATE_FILL && contains(mark, glyphs),
  );
  expect(found, `${text} has exactly one plate containing its glyphs`).toHaveLength(1);
  return found[0] as Mark;
}

describe('the price chart publishes its levels legibly', () => {
  it('draws all five figures', () => {
    for (const text of PUBLISHED) expect(label(text).content).toBe(text);
  });

  it('backs every figure with an opaque plate, painted under it', () => {
    for (const text of PUBLISHED) {
      const plate = plateFor(text);
      const glyphs = label(text);
      expect(plate.order, `${text}'s plate is painted before its glyphs`).toBeLessThan(glyphs.order);
      // Room above the cap line and below the baseline, so an accent or a comma
      // is inside the plate rather than hanging off it.
      expect(glyphs.y0 - plate.y0).toBeGreaterThan(1.5);
      expect(plate.y1 - glyphs.y1).toBeGreaterThan(1.5);
    }
  });

  it('has something to hide behind each of them', () => {
    /*
     * The guard against a plate that is technically present and does nothing.
     * These are the crossings the audit measured on this exact domain: T1 struck
     * by its own sage rule, T2 by its own rule and a grid line, ENTRY by the
     * champagne VWAP rule and the gold entry band, VWAP by the burgundy
     * invalidation rule, and INVALIDATION — clear of every rule — printed over
     * red candle bodies. If a future change unclusters the levels this assertion
     * fails first, and the test is telling the truth when it does.
     */
    for (const text of PUBLISHED) {
      const plate = plateFor(text);
      const glyphs = label(text);
      const beneath = CHART.filter(
        (mark) =>
          mark.order < plate.order &&
          mark.tag !== 'text' &&
          mark.attrs['fill'] !== 'transparent' &&
          overlaps(mark, glyphs),
      );
      expect(beneath.length, `${text} has marks under it that the plate hides`).toBeGreaterThan(0);
    }
  });

  it('paints nothing over a figure once its plate is down', () => {
    for (const text of PUBLISHED) {
      const plate = plateFor(text);
      const glyphs = label(text);
      const over = CHART.filter(
        (mark) =>
          mark.order > plate.order &&
          mark.tag !== 'text' &&
          mark.attrs['fill'] !== 'transparent' &&
          overlaps(mark, glyphs),
      );
      expect(
        over.map((mark) => `${mark.tag} ${mark.attrs['stroke'] ?? mark.attrs['fill']} at ${mark.y0}`),
        `${text} is crossed by nothing painted after its plate`,
      ).toEqual([]);
    }
  });

  it('keeps the plates from covering each other at the narrowest layout', () => {
    /*
     * A plate is opaque, so two that overlap lose a published number outright —
     * a worse failure than the one being fixed. Vertically they cannot: every
     * plate is shorter than the gap `spreadLabels` guarantees. Horizontally the
     * only pair that can meet is VWAP against the level column, and it is
     * closest at `MIN_CHART_WIDTH`, below which the chart scales down rather
     * than laying out narrower. At 240 they abut and do not cross.
     */
    const narrow = marks(
      renderToStaticMarkup(
        React.createElement(PriceChart, { bars: bars(), levels: LEVELS, vwap: VWAP, width: 240 }),
      ),
    );
    const plates = narrow.filter((mark) => mark.attrs['fill'] === PLATE_FILL);
    expect(plates).toHaveLength(PUBLISHED.length);
    for (const a of plates) {
      for (const b of plates) {
        if (a.order >= b.order) continue;
        expect(overlaps(a, b), `plates at ${a.y0} and ${b.y0} overlap`).toBe(false);
      }
    }
  });

  it('leaves the leaders that name each displaced line visible', () => {
    // The leader runs down x = f.x1 − 2 and the plates stop at f.x1 − 3, so the
    // label block cannot bury the one mark that says which rule a moved label
    // belongs to.
    const leaders = CHART.filter(
      (mark) => mark.tag === 'line' && mark.x0 === mark.x1 && mark.attrs['stroke-opacity'] === '0.5',
    );
    expect(leaders.length, 'the clustered levels displace at least one label').toBeGreaterThan(0);
    for (const leader of leaders) {
      const buried = CHART.filter(
        (mark) => mark.attrs['fill'] === PLATE_FILL && mark.x1 >= leader.x0 && mark.x0 <= leader.x1,
      );
      expect(buried, `no plate reaches the leader lane at x=${leader.x0}`).toEqual([]);
    }
  });
});

describe('levelLabelPlate', () => {
  it('boxes a right-anchored label around its glyphs', () => {
    const plate = levelLabelPlate('T1 131.83', 860, 263.46, 'end');
    expect(plate.x + plate.width).toBeCloseTo(863, 10);
    expect(plate.x).toBeCloseTo(860 - 9 * CHAR_PX - 3, 10);
    expect(plate.width).toBeCloseTo(9 * CHAR_PX + 6, 10);
  });

  it('boxes a left-anchored label the other way round', () => {
    const plate = levelLabelPlate('VWAP 140.85', 12, 247.82, 'start');
    expect(plate.x).toBeCloseTo(9, 10);
    expect(plate.width).toBeCloseTo(11 * CHAR_PX + 6, 10);
  });

  it('stays shorter than the gap spreadLabels guarantees', () => {
    /*
     * The plates are only non-overlapping because every label is at least
     * `LEVEL_LABEL_GAP` = 12 from its neighbour. A taller plate would knock the
     * label above it out — the failure this fix exists to prevent, reintroduced
     * by the fix itself.
     */
    const plate = levelLabelPlate('ENTRY 140.60–142.80', 860, 251.46, 'end');
    expect(plate.height).toBeLessThan(12);
    expect(plate.height).toBeGreaterThan(CAP_PX);
  });

  it('sizes the en dash like every other glyph', () => {
    // JetBrains Mono is monospaced throughout, so the entry range is 19 advances
    // and not 18 plus a guess.
    const dashed = levelLabelPlate('ENTRY 140.60–142.80', 860, 251.46, 'end');
    const plain = levelLabelPlate('ENTRY 140.60-142.80', 860, 251.46, 'end');
    expect(dashed.width).toBe(plain.width);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. The conviction dial's account of when it builds the Flubber mixer
// ─────────────────────────────────────────────────────────────────────────────

const DIAL = read('src/components/charts/ConvictionDial.tsx');
const HEADER = DIAL.slice(0, DIAL.indexOf('*/'));

describe('ConvictionDial documents the gate it actually has', () => {
  it('gates the mixer on a morph or on the prewarm', () => {
    expect(DIAL).toMatch(/if \(morph > 0 \|\| prewarmMorph\) setEverMorphed\(true\)/);
  });

  it('says so in the header, not only 190 lines down', () => {
    expect(HEADER).toContain('prewarmMorph');
    expect(HEADER).not.toContain('first morph and not before');
    /*
     * "A dial that is never unspooled never loads it" claimed a general rule,
     * and the symbol page is a standing counter-example to it. The header may
     * still quote the sentence — this file's own standard is that naming what
     * was withdrawn beats deleting it silently — but it may not assert it, so
     * the phrase is allowed exactly once and only inside a "used to" clause.
     */
    const retired = HEADER.split('\n').filter((line) => line.includes('never unspooled never loads it'));
    expect(retired.length).toBeLessThanOrEqual(1);
    for (const line of retired) expect(line).toMatch(/used to/);
  });

  it('is right about which caller prewarms and which does not', () => {
    // The 12.5s measurement the header carries is the publication list's, and it
    // still holds only because that list passes neither prop.
    const list = read('src/app/terminal/page.tsx');
    expect(list).toContain('<ConvictionDial score={item.conviction}');
    expect(list).not.toContain('prewarmMorph');
    expect(read('src/app/terminal/[symbol]/page.tsx')).toContain('prewarmMorph={useIdleMount()}');
  });

  it('does not claim the gate keeps Flubber out of the bundle', () => {
    // `interpolate` is a module-scope import, so the library ships to every page
    // that renders a dial whatever the gate does. What the gate saves is the
    // construction of the mixer, which is the expensive part.
    expect(DIAL).toMatch(/^import \{ interpolate \} from 'flubber';$/m);
    expect(HEADER).toContain('construction, not the download');
  });
});
