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

import { useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
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
/** Room for the E[f(x)] hairline caption above the first row. */
const HEADER = 38;
/** Room for the f(x) hairline caption below the last row. */
const FOOTER = 32;
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
  width = 720,
  baseProbability,
  finalProbability,
}: ShapWaterfallProps) {
  const reduceMotion = useReducedMotion();
  const host = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ key: string; point: HostPoint } | null>(null);

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

    const span = Math.max(0, (hi - lo) * WATERFALL_SCALE_FACTOR);
    const plotX0 = LABEL_COLUMN + GUTTER;
    const viewWidth = Math.max(width, plotX0 + span + GUTTER + VALUE_COLUMN);
    const area = viewWidth - plotX0 - GUTTER - VALUE_COLUMN;
    // Centre the raw plot inside whatever room is left, then shift it so the
    // leftmost bar edge lands on plotX0.
    const offset = plotX0 + Math.max(0, (area - span) / 2) - lo * WATERFALL_SCALE_FACTOR;

    return {
      rows,
      base,
      final,
      offset,
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

  const { rows, offset, viewWidth, viewHeight } = layout;

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
  const xView = (value: number): number => value * WATERFALL_SCALE_FACTOR + offset;
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

  return (
    <div ref={host} className="relative">
      <svg
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        role="img"
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
        <text
          x={xView(layout.final)}
          y={rowsBottom + 30}
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
          const barWidth = Math.abs(row.end - row.start) * WATERFALL_SCALE_FACTOR;
          const barX = Math.min(row.start, row.end) * WATERFALL_SCALE_FACTOR;
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
                  initial={
                    reduceMotion ? false : { width: 0, x: row.start * WATERFALL_SCALE_FACTOR }
                  }
                  animate={{ width: barWidth, x: barX }}
                  transition={
                    reduceMotion
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

      {tip ? (
        <DriverTooltip
          label={tip.row.label}
          narrative={tip.row.narrative}
          share={tip.row.share}
          state={tip.row.state}
          x={tip.point.x}
          y={tip.point.y}
          anchor={tooltipAnchor(tip.point.x, tip.point.hostWidth)}
          visible
        />
      ) : null}
    </div>
  );
}
