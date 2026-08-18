'use client';

/**
 * When a chart is allowed to draw itself in.
 *
 * Every chart here animates on mount — a path that draws, bars that grow from
 * their baseline, a ribbon that spreads. That reads beautifully for the chart
 * you are looking at, and it was being spent on the eight you were not: the
 * attribution page mounts nine charts at once and only two of them are above
 * the fold at 900px, so seven finished their entrance while off-screen and were
 * already static by the time the reader scrolled to them. The animation existed
 * and nobody ever saw it.
 *
 * The fix is one prop set, shared by every chart, rather than a per-chart guess
 * at what "visible" means:
 *
 *   - the root `<motion.svg>` carries `initial="still" whileInView="shown"` and
 *     this viewport contract;
 *   - every animated element inside carries `variants={{ still, shown }}` and no
 *     `animate` of its own, so Framer propagates the active label down through
 *     the plain `<g>` wrappers via context.
 *
 * Observing the root SVG rather than each element matters: bars at the far right
 * of a horizontally-scrolled chart may never intersect the viewport themselves,
 * and per-element observers would leave them stuck at `still` — a permanently
 * invisible bar. One observer on the full-width root cannot miss.
 *
 * `once` because an entrance replayed on every scroll-past is a nervous tic, not
 * a flourish. `amount: 0.25` because a chart peeking one pixel over the bottom
 * edge should not spend its entrance there either; a quarter of the drawing in
 * view means the reader is actually looking at it.
 *
 * Reduced motion never reaches any of this: those charts mount at `shown`
 * directly, so the drawing is complete and correct without an observer ever
 * firing.
 */

import type { ComponentProps } from 'react';
import type { motion } from 'framer-motion';

export const CHART_VIEWPORT: ComponentProps<typeof motion.svg>['viewport'] = {
  once: true,
  amount: 0.25,
};

/**
 * The two labels every chart's variants are keyed on.
 *
 * Exported as constants so a typo becomes a type error rather than an element
 * that silently never animates — a wrong label matches no variant, and Framer's
 * fallback is to leave the element exactly where it is.
 */
export const CHART_STILL = 'still';
export const CHART_SHOWN = 'shown';
