'use client';

/**
 * The SHAP waterfall — Phase 3 of the mandated drill-down.
 *
 * Geometry is specified verbatim by the XAI research and is therefore taken from
 * the exported constants rather than inlined: "compute the running total starting
 * at expected_value; per bar compute width = |endValue - startValue| * 400,
 * x = min(startValue, endValue) * 400, y = index * 48, height 28, rx 4, fill
 * #5F7161 for positive / #8C3A3A for negative; animate with Framer Motion spring
 * stiffness 70, damping 20, delay index * 0.05, initial width 0 and initial
 * x = startValue * 400". The 48px row pitch is mandated "to ensure adequate touch
 * targets", so it is never compressed to fit more rows on screen.
 *
 * Two consequences of using the mandated pixels-per-log-odd factor of 400 rather
 * than fitting the domain to the viewBox:
 *
 *  1. Bar x-coordinates are raw and frequently negative (a base value of −0.4
 *     log-odds sits at x = −160), so the whole plot group is translated by an
 *     offset derived from the min/max of every start/end value. Nothing is
 *     clipped — the viewBox grows instead, and a wide waterfall is handled by the
 *     CALLER wrapping this component in `.scroll-x`.
 *  2. A fitted `linearScale` is deliberately not used here: it would silently
 *     rescale the bars per-signal, and the mandate fixes the factor so that a
 *     given log-odds contribution has the same physical width in every signal.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  MIN_ANIMATED_BAR_WIDTH,
  WATERFALL_BAR_HEIGHT,
  WATERFALL_BAR_RADIUS,
  WATERFALL_ROW_PITCH,
  WATERFALL_SCALE_FACTOR,
  WATERFALL_SPRING,
  WATERFALL_STAGGER,
} from '@/lib/ui/svg';
import {
  BURGUNDY,
  GOLD,
  OBSIDIAN_EDGE,
  PARCHMENT,
  PARCHMENT_FAINT,
  SAGE,
  fractionAsPercent,
  integer,
  truncate,
} from '@/lib/ui/format';
import { EmptyState } from '@/components/ui/primitives';
import { useChartWidth } from './useChartWidth';
import {
  DriverTooltip,
  elementPoint,
  pointerPoint,
  tooltipAnchor,
  type HostPoint,
} from './DriverTooltip';

/** Structurally the `WaterfallStep` emitted by `@/lib/quant/shap`, plus UI keys. */
export interface ShapWaterfallStep {
  label: string;
  shap: number;
  /** Running total in log-odds. Accepted for payload parity; the running total is
   *  recomputed here because the mandate defines the bar geometry from it. */
  cumulative: number;
  cumulativeProbability: number;
  direction: 'positive' | 'negative';
  narrative?: string;
  featureKey?: string;
  /** Discretised state, surfaced in the tooltip as an audit label. */
  state?: string;
}

export interface ShapWaterfallProps {
  /** E[f(x)] in log-odds. */
  baseValue: number;
  steps: ShapWaterfallStep[];
  /** E[f(x)] + Σφ in log-odds. */
  finalValue: number;
  onHover?: (featureKey: string | null) => void;
  hoveredKey?: string | null;
  /** Minimum viewBox width; the plot grows past it rather than clipping. */
  width?: number;
  /** Server-supplied probabilities. Omitted → derived via the logit link below. */
  baseProbability?: number;
  finalProbability?: number;
}

const LABEL_COLUMN = 176;
const VALUE_COLUMN = 62;
const GUTTER = 14;
/** Narrowest the plot column is allowed to get before the viewBox grows instead. */
const MIN_PLOT_SPAN = 130;
/** Room for the E[f(x)] hairline caption above the first row. */
const HEADER = 38;
/** Room for the f(x) hairline caption below the last row. */
const FOOTER = 38;
const LABEL_CHARS = 24;

interface Row {
  key: string;
  label: string;
  narrative: string;
  state?: string;
  direction: 'positive' | 'negative';
  share: number;
  start: number;
  end: number;
  probability: number;
}

/**
 * The logit link the research names for converting a SHAP log-odds total into a
 * probability (`p = 1/(1+exp(-z))`). This is a label transform, not a statistic —
 * every real statistic arrives pre-computed, and callers that already have the
 * server's `prediction_probability` should pass it instead.
 */
function logistic(z: number): number {
  return Number.isFinite(z) ? 1 / (1 + Math.exp(-z)) : Number.NaN;
}

export function ShapWaterfall({
  baseValue,
  steps,
  finalValue,
  onHover,
  hoveredKey,
  width: widthFallback = 720,
  baseProbability,
  finalProbability,
}: ShapWaterfallProps) {
  const { ref: chartRef, width } = useChartWidth(widthFallback);
  const reduceMotion = useReducedMotion();
  const host = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ key: string; point: HostPoint } | null>(null);
  /*
   * The tooltip stays mounted once it has been shown, and `visible` carries the
   * hover state instead.
   *
   * Unmounting it on mouse-out took the `AnimatePresence` boundary with it, so the
   * exit animation it declares could never run — the tooltip vanished on the frame
   * the pointer left. Retaining the last hover keeps a position to fade out from.
   * Declared here, above the empty-state return, so the hooks run unconditionally.
   */
  const [restingHover, setRestingHover] = useState(hover);
  useEffect(() => {
    if (hover !== null) setRestingHover(hover);
  }, [hover]);

  const layout = useMemo(() => {
    const base = Number.isFinite(baseValue) ? baseValue : 0;

    // Σ|φ| over the rows actually drawn, so the shares in the value column always
    // sum to 100% of what the reader can see.
    let totalAbs = 0;
    for (const step of steps) if (Number.isFinite(step.shap)) totalAbs += Math.abs(step.shap);

    const rows: Row[] = [];
    let running = base;
    for (const step of steps) {
      // A non-finite contribution would propagate into a width/x attribute.
      if (!Number.isFinite(step.shap)) continue;
      const start = running;
      const end = running + step.shap;
      running = end;
      rows.push({
        key: step.featureKey ?? step.label,
        label: step.label,
        narrative: step.narrative ?? '',
        state: step.state,
        direction: step.direction,
        share: totalAbs > 0 ? Math.abs(step.shap) / totalAbs : 0,
        start,
        end,
        probability: step.cumulativeProbability,
      });
    }

    const last = rows[rows.length - 1];
    const final = Number.isFinite(finalValue) ? finalValue : running;

    let lo = Math.min(base, final);
    let hi = Math.max(base, final);
    for (const row of rows) {
      lo = Math.min(lo, row.start, row.end);
      hi = Math.max(hi, row.start, row.end);
    }

    const plotX0 = LABEL_COLUMN + GUTTER;
    /*
     * The plot is compressed to fit rather than the viewBox widened to hold it.
     *
     * Widening was the original behaviour, and it made the drawing wider than its
     * host on a phone — where `w-full` then scaled the whole thing, type included,
     * to 0.75 and put the labels at 6.8px. The label and value columns cannot
     * shrink (they hold real words and real numbers), so the plot span is what
     * gives: below `MIN_PLOT_SPAN` of room the viewBox does grow, because a
     * two-pixel-wide waterfall is worse than a scaled one.
     */
    const fixedColumns = plotX0 + GUTTER + VALUE_COLUMN;
    const viewWidth = Math.max(width, fixedColumns + MIN_PLOT_SPAN);
    const area = viewWidth - fixedColumns;
    const magnitude = Math.max(0, hi - lo);
    const scale = magnitude > 0 ? Math.min(WATERFALL_SCALE_FACTOR, area / magnitude) : WATERFALL_SCALE_FACTOR;
    const span = magnitude * scale;
    // Centre the plot inside whatever room is left, then shift it so the leftmost
    // bar edge lands on plotX0.
    const offset = plotX0 + Math.max(0, (area - span) / 2) - lo * scale;

    return {
      rows,
      base,
      final,
      offset,
      scale,
      viewWidth,
      viewHeight: HEADER + rows.length * WATERFALL_ROW_PITCH + FOOTER,
      baseP: Number.isFinite(baseProbability) ? (baseProbability as number) : logistic(base),
      finalP: Number.isFinite(finalProbability)
        ? (finalProbability as number)
        : last && Number.isFinite(last.probability)
          ? last.probability
          : logistic(final),
    };
  }, [baseValue, steps, finalValue, width, baseProbability, finalProbability]);

  const { rows, offset, scale, viewWidth, viewHeight } = layout;

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No attribution available"
        detail="This signal carries no finite feature contributions, so there is nothing to decompose."
      />
    );
  }

  // A parent may drive the hover (linked highlighting across panels); local hover
  // still works when it passes null, and only local hover can position a tooltip.
  const activeKey = hoveredKey ?? hover?.key ?? null;
  const xView = (value: number): number => value * scale + offset;
  const rowsTop = HEADER;
  const rowsBottom = HEADER + rows.length * WATERFALL_ROW_PITCH;

  const enter = (key: string, point: HostPoint): void => {
    setHover({ key, point });
    onHover?.(key);
  };
  const leave = (): void => {
    setHover(null);
    onHover?.(null);
  };

  const basePct = fractionAsPercent(layout.baseP, 1);
  const finalPct = fractionAsPercent(layout.finalP, 1);
  const hoveredRow = hover ? rows.find((row) => row.key === hover.key) : undefined;
  const tip = hover && hoveredRow ? { row: hoveredRow, point: hover.point } : null;
  const shownHover = hover ?? restingHover;
  const shownRowOrSegment = shownHover ? rows.find((r) => r.key === shownHover.key) : undefined;
  const shownTip = shownHover && shownRowOrSegment ? { row: shownRowOrSegment, point: shownHover.point } : null;

  return (
    <div ref={host} className="relative">
      <svg
        ref={chartRef}
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        /*
         * `group`, not `img`.
         *
         * `role="img"` prunes the whole subtree from the accessibility tree, so
         * the focusable, individually-labelled drivers inside this chart were
         * built and then hidden: a screen-reader user could tab onto them and
         * hear nothing. `role="group"` keeps the container's own name and lets
         * its interactive children be announced.
         */
        role="group"
        aria-label={`SHAP waterfall: ${rows.length} drivers carrying the probability from a ${basePct} baseline to ${finalPct}`}
      >
        {/* Expected-value hairline. Gold is reserved for the conviction anchor,
            and these two rules ARE the anchor projected onto the plot. */}
        <line
          x1={xView(layout.base)}
          x2={xView(layout.base)}
          y1={rowsTop - 8}
          y2={rowsBottom + 4}
          stroke={GOLD}
          strokeWidth={1}
          strokeOpacity={0.55}
          strokeDasharray="2 3"
        />
        <text x={xView(layout.base)} y={14} textAnchor="middle" fontSize={9} fill={PARCHMENT_FAINT}>
          E[f(x)]
        </text>
        <text x={xView(layout.base)} y={27} textAnchor="middle" fontSize={10} fill={GOLD} className="tabular">
          {basePct}
        </text>

        {/* Outcome hairline. */}
        <line
          x1={xView(layout.final)}
          x2={xView(layout.final)}
          y1={rowsTop - 4}
          y2={rowsBottom + 8}
          stroke={GOLD}
          strokeWidth={1}
          strokeOpacity={0.9}
        />
        <text
          x={xView(layout.final)}
          y={rowsBottom + 20}
          textAnchor="middle"
          fontSize={10}
          fill={GOLD}
          className="tabular"
        >
          {finalPct}
        </text>
        {/* 13px below the figure, matching the E[f(x)] pair above: at 10px the
            two captions' line boxes touched and the glyphs printed into each
            other's descenders. */}
        <text
          x={xView(layout.final)}
          y={rowsBottom + 33}
          textAnchor="middle"
          fontSize={9}
          fill={PARCHMENT_FAINT}
        >
          f(x)
        </text>

        {rows.map((row, index) => {
          const y = index * WATERFALL_ROW_PITCH;
          const rowY = rowsTop + y;
          const active = activeKey === row.key;
          const dimmed = activeKey !== null && !active;
          const barWidth = Math.abs(row.end - row.start) * scale;
          const barX = Math.min(row.start, row.end) * scale;
          const fill = row.direction === 'positive' ? SAGE : BURGUNDY;

          return (
            <g
              key={`${row.key}-${index}`}
              role="button"
              tabIndex={0}
              aria-label={`${row.label}: ${integer(row.share * 100)} percent of attribution, ${
                row.direction === 'positive' ? 'supporting' : 'opposing'
              }${row.narrative ? `. ${row.narrative}` : ''}`}
              className="cursor-default outline-none transition-opacity duration-150"
              opacity={dimmed ? 0.45 : 1}
              onMouseEnter={(event) => enter(row.key, pointerPoint(event, host.current))}
              onMouseMove={(event) => setHover({ key: row.key, point: pointerPoint(event, host.current) })}
              onMouseLeave={leave}
              onFocus={(event) => enter(row.key, elementPoint(event.currentTarget, host.current))}
              onBlur={leave}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  leave();
                  return;
                }
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  enter(row.key, elementPoint(event.currentTarget, host.current));
                }
              }}
            >
              {/* Full-width hit area: the mandated 48px pitch is the touch target,
                  not the 28px bar, and a narrow contribution must still be
                  reachable by pointer and by finger. */}
              <rect x={0} y={rowY} width={viewWidth} height={WATERFALL_ROW_PITCH} fill="transparent" />

              {/* Doubles as the keyboard focus indicator — SVG groups do not get a
                  reliable native focus ring. */}
              {active ? (
                <rect
                  x={1}
                  y={rowY + 1}
                  width={viewWidth - 2}
                  height={WATERFALL_ROW_PITCH - 2}
                  fill="none"
                  stroke={GOLD}
                  strokeWidth={1}
                  strokeOpacity={0.3}
                />
              ) : null}

              <text
                x={LABEL_COLUMN}
                y={rowY + WATERFALL_BAR_HEIGHT / 2}
                textAnchor="end"
                dominantBaseline="central"
                fontSize={10}
                fill={active ? PARCHMENT : PARCHMENT_FAINT}
              >
                {truncate(row.label, LABEL_CHARS)}
              </text>

              {/* The translated plot group: everything inside is in raw
                  log-odds × 400 space, exactly as the mandate specifies. */}
              <g transform={`translate(${offset} ${rowY})`}>
                {/* No static `x` attribute: Framer Motion treats `x` as a CSS
                    transform, so an attribute here would be added to the
                    translation and offset every bar twice. The mandated
                    `x = min(start, end) × 400` is therefore the transform target,
                    which is exactly how the research's snippet positions it. */}
                <motion.rect
                  y={0}
                  width={barWidth}
                  height={WATERFALL_BAR_HEIGHT}
                  rx={WATERFALL_BAR_RADIUS}
                  fill={fill}
                  /*
                    A driver whose contribution rounds to zero is not animated.
                    The guard used to be `<= 0`, which is the wrong threshold: a
                    target of 1.8e-15 is greater than zero, so the spring ran, and
                    on the settle it emitted -1.8e-15 — a negative `width`, which
                    SVG rejects with a console error. See MIN_ANIMATED_BAR_WIDTH.
                  */
                  initial={
                    reduceMotion || barWidth < MIN_ANIMATED_BAR_WIDTH
                      ? false
                      : { width: 0, x: row.start * scale }
                  }
                  animate={{ width: Math.max(0, barWidth), x: barX }}
                  transition={
                    reduceMotion || barWidth < MIN_ANIMATED_BAR_WIDTH
                      ? { duration: 0 }
                      : { ...WATERFALL_SPRING, delay: index * WATERFALL_STAGGER }
                  }
                />
              </g>

              <text
                x={viewWidth - 6}
                y={rowY + WATERFALL_BAR_HEIGHT / 2}
                textAnchor="end"
                dominantBaseline="central"
                fontSize={10}
                fill={active ? PARCHMENT : PARCHMENT_FAINT}
                className="tabular"
              >
                {integer(row.share * 100)}%
              </text>

              {/* Row rule, to keep a 48px pitch from reading as loose spacing. */}
              <line
                x1={LABEL_COLUMN + GUTTER}
                x2={viewWidth - VALUE_COLUMN - GUTTER}
                y1={rowY + WATERFALL_ROW_PITCH - 10}
                y2={rowY + WATERFALL_ROW_PITCH - 10}
                stroke={OBSIDIAN_EDGE}
                strokeWidth={1}
                strokeOpacity={0.45}
                aria-hidden
              />
            </g>
          );
        })}
      </svg>

      {shownTip ? (
        <DriverTooltip
          label={shownTip.row.label}
          narrative={shownTip.row.narrative}
          share={shownTip.row.share}
          state={shownTip.row.state}
          x={shownTip.point.x}
          y={shownTip.point.y}
          anchor={tooltipAnchor(shownTip.point.x, shownTip.point.hostWidth)}
          visible={tip !== null}
        />
      ) : null}
    </div>
  );
}
