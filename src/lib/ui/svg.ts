/**
 * Raw-SVG chart mathematics.
 *
 * Chart libraries are banned by the design mandate — "DISCARD clunky,
 * retail-focused charting libraries … because they render via inflexible canvas
 * APIs or heavily bloated SVG wrappers that lack customizable
 * micro-interactions". So every chart in this application is built from `<path>`,
 * `<rect>`, `<circle>` and `<polyline>` positioned by the functions below.
 *
 * The geometric constants that the research specifies exactly are exported as
 * named constants rather than inlined, so a design change cannot silently
 * diverge from the spec.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  Mandated geometry
// ─────────────────────────────────────────────────────────────────────────────

/** Waterfall: normalises raw log-odds against the SVG viewBox. */
export const WATERFALL_SCALE_FACTOR = 400;
/** Waterfall: 48px row pitch, mandated to guarantee adequate touch targets. */
export const WATERFALL_ROW_PITCH = 48;
export const WATERFALL_BAR_HEIGHT = 28;
export const WATERFALL_BAR_RADIUS = 4;
/** Framer Motion spring for the waterfall bars. */
export const WATERFALL_SPRING = { type: 'spring' as const, stiffness: 70, damping: 20 };
/** Stagger: `delay = index × 0.05s`. */
export const WATERFALL_STAGGER = 0.05;

/**
 * Drops labels that would collide, keeping the first of each cluster.
 *
 * For an axis whose ticks are fixed by the data — a log time axis, a set of price
 * levels — the honest response to "these two labels overlap" is to print one of
 * them, not to print both on top of each other. Returns the indices to keep.
 */
export function thinLabels(positions: readonly number[], minGap: number): number[] {
  const order = positions.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const keep: number[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const item of order) {
    if (item.value - last < minGap) continue;
    keep.push(item.index);
    last = item.value;
  }
  return keep.sort((a, b) => a - b);
}

/**
 * Pushes labels apart so none overlaps, keeping their order and staying inside
 * `[lo, hi]`.
 *
 * Used where every label has to be shown — the four signal levels on the price
 * chart are each meaningful, and dropping "invalidation" because it sits near the
 * entry zone would remove the one a reader most needs. A single forward pass
 * separates them, then a backward pass pulls the overrun back inside the frame.
 */
export function spreadLabels(
  positions: readonly number[],
  minGap: number,
  lo: number,
  hi: number,
): number[] {
  const order = positions.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const placed = order.map((item) => item.value);
  for (let i = 1; i < placed.length; i += 1) {
    const previous = placed[i - 1] as number;
    if ((placed[i] as number) - previous < minGap) placed[i] = previous + minGap;
  }
  const overrun = (placed[placed.length - 1] ?? hi) - hi;
  if (overrun > 0) {
    for (let i = 0; i < placed.length; i += 1) placed[i] = (placed[i] as number) - overrun;
    for (let i = 1; i < placed.length; i += 1) {
      const previous = placed[i - 1] as number;
      if ((placed[i] as number) - previous < minGap) placed[i] = previous + minGap;
    }
  }
  if ((placed[0] as number) < lo) {
    const shift = lo - (placed[0] as number);
    for (let i = 0; i < placed.length; i += 1) placed[i] = (placed[i] as number) + shift;
  }
  const out = new Array<number>(positions.length);
  order.forEach((item, i) => {
    out[item.index] = placed[i] as number;
  });
  return out;
}

/** Conviction ring geometry. */
export const CONVICTION_RADIUS = 84;
export const CONVICTION_STROKE = 3;
export const CONVICTION_CIRCUMFERENCE = 2 * Math.PI * CONVICTION_RADIUS; // 527.7876…

/**
 * Flubber interpolation granularity for the conviction "unspool" morph.
 *
 * The research specifies 0.1, which on the r=84 ring means resampling a 528-unit
 * circumference into ~5,300 anchors and matching them against the axis on every
 * mixer construction. Measured on the publication list — five dials — that cost
 * 12.5s of blocked main thread on load and 1.4s on every hover, with the scores
 * frozen at "0" for the first seven seconds.
 *
 * At 4 the ring resamples to ~130 anchors, the morph is visually identical at the
 * sizes it is drawn (132–220px), and the construction is imperceptible. The dial
 * also builds the mixer lazily now, so a page that never morphs never pays for it
 * at all — see `ConvictionDial`.
 */
export const MORPH_MAX_SEGMENT_LENGTH = 4;

/**
 * How a bar's entry animation is expressed, and why it is not `width`.
 *
 * Animating the `width` attribute puts the solver's intermediate values straight
 * into the DOM, and SVG rejects a negative width with a console error. Two rounds
 * of clamping the endpoints proved that endpoints are the wrong place to clamp: a
 * spring integrating towards 1.8e-15 emits -1.8e-15 on the settle, and a tween
 * shrinking a bar to zero evaluates its easing at t=1 as 1+ε and lands on
 * -7.1e-15. Neither value is an endpoint; both reach the DOM.
 *
 * So the width attribute is a plain, non-negative number that React writes, and
 * the growth is a `scaleX` transform. A transform of -1e-15 is perfectly legal —
 * it mirrors the bar by an invisible amount for one frame — so the whole class of
 * defect stops existing rather than being guarded against case by case.
 *
 * `transform-box: fill-box` makes the origin relative to the rect's own bounding
 * box, so "grow from the left edge" is `left center` with no coordinate
 * arithmetic, whatever the bar's position in the chart.
 */
export const BAR_GROW_LEFT = { transformBox: 'fill-box', transformOrigin: 'left center' } as const;
export const BAR_GROW_RIGHT = { transformBox: 'fill-box', transformOrigin: 'right center' } as const;

/**
 * Below this a bar is drawn at its final size rather than animated: a solver run
 * towards something indistinguishable from zero is work with no product in it.
 */
export const MIN_ANIMATED_BAR_WIDTH = 0.5;

/** Z-oscillator reference lines: entry at ±2.0σ, exit band at ±0.5σ. */
export const Z_ENTRY_THRESHOLD = 2.0;
export const Z_EXIT_THRESHOLD = 0.5;
export const Z_AXIS_LIMIT = 4;

/** Depth ladder: 24px per level, opacity decaying 0.08 per level. */
export const LADDER_ROW_PITCH = 24;
export const LADDER_OPACITY_DECAY = 0.08;

// ─────────────────────────────────────────────────────────────────────────────
//  Scales
// ─────────────────────────────────────────────────────────────────────────────

export interface Scale {
  (value: number): number;
  domain: [number, number];
  range: [number, number];
  invert: (pixel: number) => number;
}

/** Linear scale from a data domain to a pixel range. */
export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const fn = ((value: number): number => {
    if (Math.abs(span) < 1e-12) return (r0 + r1) / 2;
    return r0 + ((value - d0) / span) * (r1 - r0);
  }) as Scale;
  fn.domain = domain;
  fn.range = range;
  fn.invert = (pixel: number): number => {
    const rSpan = r1 - r0;
    if (Math.abs(rSpan) < 1e-12) return d0;
    return d0 + ((pixel - r0) / rSpan) * span;
  };
  return fn;
}

/** Log scale, for equity curves spanning an order of magnitude. */
export function logScale(domain: [number, number], range: [number, number]): Scale {
  const safe = (v: number): number => Math.log(Math.max(v, 1e-9));
  const l0 = safe(domain[0]);
  const l1 = safe(domain[1]);
  const [r0, r1] = range;
  const fn = ((value: number): number => {
    if (Math.abs(l1 - l0) < 1e-12) return (r0 + r1) / 2;
    return r0 + ((safe(value) - l0) / (l1 - l0)) * (r1 - r0);
  }) as Scale;
  fn.domain = domain;
  fn.range = range;
  fn.invert = (pixel: number): number => Math.exp(l0 + ((pixel - r0) / (r1 - r0)) * (l1 - l0));
  return fn;
}

/** Band scale for categorical axes (candles, ladder rows, monthly cells). */
export interface BandScale {
  (index: number): number;
  bandwidth: number;
  step: number;
}

export function bandScale(count: number, range: [number, number], paddingRatio = 0.22): BandScale {
  const [r0, r1] = range;
  const step = count <= 0 ? 0 : (r1 - r0) / count;
  const bandwidth = Math.max(step * (1 - paddingRatio), 0.5);
  const fn = ((index: number): number => r0 + index * step + (step - bandwidth) / 2) as BandScale;
  fn.bandwidth = bandwidth;
  fn.step = step;
  return fn;
}

/** Padded [min, max] of a series, ignoring non-finite values. */
export function extent(values: readonly number[], padRatio = 0.06): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.05, 1);
    return [min - pad, max + pad];
  }
  const pad = (max - min) * padRatio;
  return [min - pad, max + pad];
}

/** Symmetric extent around zero — used wherever the sign is the message. */
export function symmetricExtent(values: readonly number[], padRatio = 0.1): [number, number] {
  let max = 0;
  for (const v of values) if (Number.isFinite(v)) max = Math.max(max, Math.abs(v));
  const limit = max === 0 ? 1 : max * (1 + padRatio);
  return [-limit, limit];
}

/**
 * "Nice" tick values for an axis — powers of 1, 2, 5 × 10ⁿ. Produces round
 * numbers a trader can read at a glance instead of arbitrary interval boundaries.
 */
export function niceTicks(domain: [number, number], count = 5): number[] {
  const [d0, d1] = domain;
  const span = d1 - d0;
  if (!Number.isFinite(span) || span <= 0) return [d0];
  const rawStep = span / Math.max(1, count);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalised = rawStep / magnitude;
  const step = (normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1) * magnitude;
  const first = Math.ceil(d0 / step) * step;
  const ticks: number[] = [];
  for (let t = first; t <= d1 + step * 1e-9; t += step) {
    ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  }
  return ticks;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Path builders
// ─────────────────────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

/** Polyline path through points, skipping non-finite values. */
export function linePath(points: readonly Point[]): string {
  const parts: string[] = [];
  let pen = false;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      pen = false;
      continue;
    }
    parts.push(`${pen ? 'L' : 'M'}${round(p.x)} ${round(p.y)}`);
    pen = true;
  }
  return parts.join(' ');
}

/**
 * Monotone cubic path (Fritsch–Carlson). Smooth without the overshoot a plain
 * Catmull–Rom produces — an equity curve must never appear to dip below a low it
 * never made.
 */
export function smoothPath(points: readonly Point[]): string {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = pts.length;
  if (n === 0) return '';
  if (n < 3) return linePath(pts);

  const dx: number[] = [];
  const dy: number[] = [];
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const a = pts[i] as Point;
    const b = pts[i + 1] as Point;
    const h = b.x - a.x;
    dx.push(h);
    dy.push(b.y - a.y);
    slopes.push(Math.abs(h) < 1e-12 ? 0 : (b.y - a.y) / h);
  }

  const tangents: number[] = new Array(n).fill(0);
  tangents[0] = slopes[0] as number;
  tangents[n - 1] = slopes[n - 2] as number;
  for (let i = 1; i < n - 1; i += 1) {
    const s0 = slopes[i - 1] as number;
    const s1 = slopes[i] as number;
    tangents[i] = s0 * s1 <= 0 ? 0 : (s0 + s1) / 2;
  }
  // Fritsch–Carlson monotonicity filter.
  for (let i = 0; i < n - 1; i += 1) {
    const s = slopes[i] as number;
    if (Math.abs(s) < 1e-12) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const alpha = (tangents[i] as number) / s;
    const beta = (tangents[i + 1] as number) / s;
    const magnitude = Math.hypot(alpha, beta);
    if (magnitude > 3) {
      const tau = 3 / magnitude;
      tangents[i] = tau * alpha * s;
      tangents[i + 1] = tau * beta * s;
    }
  }

  const first = pts[0] as Point;
  const parts = [`M${round(first.x)} ${round(first.y)}`];
  for (let i = 0; i < n - 1; i += 1) {
    const a = pts[i] as Point;
    const b = pts[i + 1] as Point;
    const h = (dx[i] as number) / 3;
    parts.push(
      `C${round(a.x + h)} ${round(a.y + (tangents[i] as number) * h)} ` +
        `${round(b.x - h)} ${round(b.y - (tangents[i + 1] as number) * h)} ` +
        `${round(b.x)} ${round(b.y)}`,
    );
  }
  return parts.join(' ');
}

/** Closed area path between a line and a baseline. */
export function areaPath(points: readonly Point[], baselineY: number, smooth = false): string {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length === 0) return '';
  const top = smooth ? smoothPath(pts) : linePath(pts);
  const lastPoint = pts[pts.length - 1] as Point;
  const firstPoint = pts[0] as Point;
  return `${top} L${round(lastPoint.x)} ${round(baselineY)} L${round(firstPoint.x)} ${round(baselineY)} Z`;
}

/** Band between two series — the Kalman channel and the OU envelope. */
export function bandPath(upper: readonly Point[], lower: readonly Point[], smooth = false): string {
  const up = upper.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const down = lower.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).slice().reverse();
  if (up.length === 0 || down.length === 0) return '';
  const top = smooth ? smoothPath(up) : linePath(up);
  const bottom = smooth ? smoothPath(down) : linePath(down);
  return `${top} L${round((down[0] as Point).x)} ${round((down[0] as Point).y)} ${bottom.replace(/^M/, 'L')} Z`;
}

/** Rounded rectangle, for the waterfall bars and ladder cells. */
export function roundedRectPath(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2));
  const x0 = width < 0 ? x + width : x;
  const w = Math.abs(width);
  return (
    `M${round(x0 + r)} ${round(y)} H${round(x0 + w - r)} A${round(r)} ${round(r)} 0 0 1 ${round(x0 + w)} ${round(y + r)} ` +
    `V${round(y + height - r)} A${round(r)} ${round(r)} 0 0 1 ${round(x0 + w - r)} ${round(y + height)} ` +
    `H${round(x0 + r)} A${round(r)} ${round(r)} 0 0 1 ${round(x0)} ${round(y + height - r)} ` +
    `V${round(y + r)} A${round(r)} ${round(r)} 0 0 1 ${round(x0 + r)} ${round(y)} Z`
  );
}

/** Circular arc path used by the conviction ring when it is drawn as a path. */
export function arcPath(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): string {
  const start = polar(cx, cy, radius, startAngle);
  const end = polar(cx, cy, radius, endAngle);
  const largeArc = Math.abs(endAngle - startAngle) > Math.PI ? 1 : 0;
  const sweep = endAngle > startAngle ? 1 : 0;
  return `M${round(start.x)} ${round(start.y)} A${round(radius)} ${round(radius)} 0 ${largeArc} ${sweep} ${round(end.x)} ${round(end.y)}`;
}

export function polar(cx: number, cy: number, radius: number, angle: number): Point {
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

/**
 * The full circle as a path, starting at 12 o'clock and running clockwise.
 * Split into two arcs because a single 360° arc is degenerate in SVG.
 */
export function circlePath(cx: number, cy: number, radius: number): string {
  return (
    `M${round(cx)} ${round(cy - radius)} ` +
    `A${round(radius)} ${round(radius)} 0 0 1 ${round(cx)} ${round(cy + radius)} ` +
    `A${round(radius)} ${round(radius)} 0 0 1 ${round(cx)} ${round(cy - radius)}`
  );
}

/** A horizontal line as a path — the target shape of the conviction "unspool". */
export function horizontalPath(x0: number, x1: number, y: number): string {
  return `M${round(x0)} ${round(y)} L${round(x1)} ${round(y)}`;
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Chart frame
// ─────────────────────────────────────────────────────────────────────────────

export interface ChartFrame {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  innerWidth: number;
  innerHeight: number;
  /** Inner drawing area bounds. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export function frame(
  width: number,
  height: number,
  margin: Partial<ChartFrame['margin']> = {},
): ChartFrame {
  const m = { top: margin.top ?? 12, right: margin.right ?? 48, bottom: margin.bottom ?? 24, left: margin.left ?? 8 };
  return {
    width,
    height,
    margin: m,
    innerWidth: Math.max(0, width - m.left - m.right),
    innerHeight: Math.max(0, height - m.top - m.bottom),
    x0: m.left,
    x1: width - m.right,
    y0: m.top,
    y1: height - m.bottom,
  };
}

/**
 * Downsamples a series to at most `maxPoints` using Largest-Triangle-Three-Buckets,
 * which preserves visual extremes far better than uniform sampling. A 3-year daily
 * series in a 900px-wide chart has more points than pixels; drawing all of them
 * bloats the DOM for no visual gain.
 */
export function downsample(points: readonly Point[], maxPoints: number): Point[] {
  const n = points.length;
  if (n <= maxPoints || maxPoints < 3) return points.slice();

  const bucketSize = (n - 2) / (maxPoints - 2);
  const out: Point[] = [points[0] as Point];
  let a = 0;

  for (let i = 0; i < maxPoints - 2; i += 1) {
    const rangeStart = Math.floor((i + 1) * bucketSize) + 1;
    const rangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);
    let avgX = 0;
    let avgY = 0;
    for (let j = rangeStart; j < rangeEnd; j += 1) {
      avgX += (points[j] as Point).x;
      avgY += (points[j] as Point).y;
    }
    const count = Math.max(1, rangeEnd - rangeStart);
    avgX /= count;
    avgY /= count;

    const bucketStart = Math.floor(i * bucketSize) + 1;
    const bucketEnd = Math.floor((i + 1) * bucketSize) + 1;
    const pointA = points[a] as Point;
    let bestArea = -1;
    let bestIndex = bucketStart;
    for (let j = bucketStart; j < Math.min(bucketEnd, n); j += 1) {
      const p = points[j] as Point;
      const area = Math.abs((pointA.x - avgX) * (p.y - pointA.y) - (pointA.x - p.x) * (avgY - pointA.y)) / 2;
      if (area > bestArea) {
        bestArea = area;
        bestIndex = j;
      }
    }
    out.push(points[bestIndex] as Point);
    a = bestIndex;
  }

  out.push(points[n - 1] as Point);
  return out;
}

/**
 * Interpolates two colours in linear RGB. Used by the SABR surface mesh, which
 * the research specifies as interpolating from sage (low IV) to burgundy (high).
 * Lab would be closer to perceptually uniform, but linear RGB is monotone in
 * these two hues and needs no colour-space round trip.
 */
export function mixColour(from: string, to: string, t: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const k = Math.max(0, Math.min(1, t));
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const gamma = (c: number): number => {
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, s)) * 255);
  };
  const r = gamma(lin(a.r) * (1 - k) + lin(b.r) * k);
  const g = gamma(lin(a.g) * (1 - k) + lin(b.g) * k);
  const bl = gamma(lin(a.b) * (1 - k) + lin(b.b) * k);
  return `#${[r, g, bl].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}
