'use client';

/**
 * Tick-to-trade latency against its budget.
 *
 * Phase 3 fixes the budget at sub-150ms from market tick to order dispatch, so the
 * question this chart answers is never "how long did the pipeline take" in the
 * abstract — it is "how much of the budget is left, and which stage is eating it".
 * That is why the x domain is `max(total, budget)` rather than `total`: a bar
 * scaled to its own total would render a 12ms pipeline and a 400ms pipeline
 * identically, and the budget line — the only reference that makes the bar mean
 * anything — would fall off the axis. The line is therefore always on screen,
 * even when the total is a fraction of it.
 *
 * Stages run gold → parchment so the ordering of the pipeline is legible without
 * a colour key, and the sequence reads as one object rather than as competing
 * categories. Burgundy is reserved for the segment past the budget: it is the only
 * thing on this chart that constitutes a failure.
 */

import { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { frame, linearScale, mixColour, type ChartFrame } from '@/lib/ui/svg';
import {
  BURGUNDY,
  BURGUNDY_BRIGHT,
  GOLD,
  OBSIDIAN_EDGE,
  PARCHMENT,
  PARCHMENT_FAINT,
  duration,
  fractionAsPercent,
} from '@/lib/ui/format';
import { Badge, EmptyState } from '@/components/ui/primitives';
import { useChartWidth } from './useChartWidth';

const BAR_H = 28;
const AXIS_TEXT = 9;
const SEGMENT_GAP = 1;
/** Below this, the gap between the total and the itemised stages is float noise. */
const UNATTRIBUTED_EPS = 0.05;

export interface LatencyStage {
  stage: string;
  ms: number;
}

export interface LatencyBarProps {
  stages: LatencyStage[];
  totalMs: number;
  /** Phase 3's tick-to-trade budget, in ms. */
  budgetMs: number;
  withinBudget: boolean;
  /** viewBox width used for layout; the rendered width is the container's. */
  width?: number;
  height?: number;
}

interface Segment {
  key: string;
  stage: string;
  ms: number;
  share: number;
  colour: string;
  /** Within-budget portion. */
  x: number;
  w: number;
  /** Portion past the budget, drawn burgundy. Null when the stage stays inside. */
  overflow: { x: number; w: number } | null;
}

interface Layout {
  f: ChartFrame;
  barY: number;
  segments: Segment[];
  total: number;
  budget: number | null;
  budgetX: number | null;
  budgetAnchor: 'middle' | 'end';
  overrunMs: number;
  totalX: number;
  totalOnUpperLine: boolean;
}

function computeLayout(props: LatencyBarProps): Layout | null {
  const { stages, totalMs, budgetMs, width = 760, height = 92 } = props;

  const itemised = (Array.isArray(stages) ? stages : []).filter(
    (s) => !!s && typeof s.stage === 'string' && Number.isFinite(s.ms) && s.ms >= 0,
  );
  const summed = itemised.reduce((acc, s) => acc + s.ms, 0);
  // The caller's total is authoritative — it includes anything the stage list does
  // not itemise — but a missing or nonsensical one falls back to the stages rather
  // than poisoning every share with a division by zero.
  const total = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : summed;
  if (itemised.length === 0 && total <= 0) return null;

  // A bar that stops short of its own stated total would sit inside the budget
  // while the badge reads "over budget", so the unattributed remainder is drawn
  // as its own segment rather than silently dropped.
  const remainder = total - summed;
  const clean: LatencyStage[] =
    remainder > UNATTRIBUTED_EPS ? [...itemised, { stage: 'Unattributed', ms: remainder }] : itemised;

  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : null;
  const axisMax = Math.max(total, budget ?? 0) * 1.08;
  if (!(axisMax > 0)) return null;

  /*
   * 36px of headroom, because two captions sit above the bar.
   *
   * The bar starts at `f.y0`, so with a 22px top margin the second caption line
   * (`barY - 22`) landed on y = 0 and was clipped out of the viewBox — which is
   * why moving the total up there did not separate it from the budget label, it
   * just hid it. The margin now holds both lines.
   */
  const f = frame(width, height, { top: 36, right: 16, bottom: 22, left: 16 });
  if (f.innerWidth <= 0 || f.innerHeight <= 0) return null;

  const x = linearScale([0, axisMax], [f.x0, f.x1]);
  const barY = f.y0;

  const segments: Segment[] = [];
  let cursor = 0;
  clean.forEach((stage, i) => {
    const start = cursor;
    const end = cursor + stage.ms;
    cursor = end;

    const boundary = budget === null ? end : Math.min(end, budget);
    const insideStart = x(start);
    const insideEnd = x(boundary);
    const overflowStart = budget !== null && end > budget ? x(Math.max(start, budget)) : null;

    segments.push({
      key: `${i}-${stage.stage}`,
      stage: stage.stage,
      ms: stage.ms,
      share: total > 0 ? stage.ms / total : 0,
      // A single-stage pipeline sits at the gold end of the ramp rather than
      // dividing by zero to land in the middle of it.
      colour: mixColour(GOLD, PARCHMENT, clean.length <= 1 ? 0 : i / (clean.length - 1)),
      x: insideStart,
      w: Math.max(0, insideEnd - insideStart - SEGMENT_GAP),
      overflow:
        overflowStart === null ? null : { x: overflowStart, w: Math.max(0, x(end) - overflowStart - SEGMENT_GAP) },
    });
  });

  const budgetX = budget === null ? null : x(budget);

  return {
    f,
    barY,
    segments,
    total,
    budget,
    budgetX,
    // Near the right edge the centred label would overflow the viewBox.
    budgetAnchor: budgetX !== null && budgetX > f.x1 - 56 ? 'end' : 'middle',
    overrunMs: budget !== null && total > budget ? total - budget : 0,
    totalX: x(total),
    /*
     * The total sits on its own line whenever a budget line is drawn.
     *
     * Sharing one baseline, a run near its budget — 113ms against 150ms — printed
     * the two strings through each other. Deciding by estimated text width was
     * fragile at the narrow end; two fixed lines cannot collide at any width, and
     * the ordering (total above, budget below, against the bar) reads as the
     * measurement above its reference.
     */
    totalOnUpperLine: budgetX !== null,
  };
}

export function LatencyBar({ stages, totalMs, budgetMs, withinBudget, width: widthFallback = 760, height = 92 }: LatencyBarProps) {
  const { ref: chartRef, width } = useChartWidth(widthFallback);
  const reduceMotion = useReducedMotion();
  const layout = useMemo(
    () => computeLayout({ stages, totalMs, budgetMs, withinBudget, width, height }),
    [stages, totalMs, budgetMs, withinBudget, width, height],
  );

  if (!layout) {
    return (
      <EmptyState
        title="No latency telemetry"
        detail="This signal carries no stage timings, so the tick-to-trade budget cannot be accounted for."
      />
    );
  }

  const { f, barY, segments, total, budget, budgetX, budgetAnchor, overrunMs, totalX, totalOnUpperLine } = layout;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <p className="eyebrow">Tick-to-trade</p>
        {/* The badge follows the caller's verdict, not the pixels: `withinBudget`
            is the value the risk audit recorded, and the chart must not appear to
            overrule it. */}
        <Badge tone={withinBudget ? 'sage' : 'burgundy'}>
          {duration(total)} {budget !== null ? `/ ${duration(budget)}` : ''} {withinBudget ? 'within budget' : 'over budget'}
        </Badge>
      </div>

      <svg
        ref={chartRef}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        role="img"
        aria-label={
          `Latency budget: ${duration(total)} total across ${segments.length} pipeline stages` +
          (budget !== null ? ` against a ${duration(budget)} budget` : '') +
          `. ${withinBudget ? 'Within budget' : `Over budget by ${duration(overrunMs)}`}.`
        }
      >
        {/* ── Track, so an under-budget bar still reads against its container ─ */}
        <rect
          x={f.x0}
          y={barY}
          width={f.innerWidth}
          height={BAR_H}
          fill="none"
          stroke={OBSIDIAN_EDGE}
          strokeOpacity={0.45}
          strokeWidth={1}
          aria-hidden
        />

        {/* ── Stacked stages ───────────────────────────────────────────────── */}
        {segments.map((segment, i) => (
          <g key={segment.key}>
            <title>{`${segment.stage}: ${duration(segment.ms)} (${fractionAsPercent(segment.share, 1)} of total)`}</title>
            {segment.w > 0 ? (
              <motion.rect
                x={segment.x}
                y={barY}
                height={BAR_H}
                fill={segment.colour}
                initial={reduceMotion ? false : { width: 0 }}
                animate={{ width: segment.w }}
                transition={{ duration: reduceMotion ? 0 : 0.5, delay: reduceMotion ? 0 : i * 0.05, ease: [0.16, 1, 0.3, 1] }}
                width={segment.w}
              />
            ) : null}
            {segment.overflow && segment.overflow.w > 0 ? (
              <motion.rect
                x={segment.overflow.x}
                y={barY}
                height={BAR_H}
                fill={BURGUNDY}
                initial={reduceMotion ? false : { width: 0 }}
                animate={{ width: segment.overflow.w }}
                transition={{ duration: reduceMotion ? 0 : 0.5, delay: reduceMotion ? 0 : i * 0.05, ease: [0.16, 1, 0.3, 1] }}
                width={segment.overflow.w}
              />
            ) : null}
          </g>
        ))}

        {/* ── The budget line: always visible, whatever the total ───────────── */}
        {budgetX !== null && budget !== null ? (
          <g aria-hidden>
            <line
              x1={budgetX}
              x2={budgetX}
              y1={barY - 7}
              y2={barY + BAR_H + 7}
              stroke={BURGUNDY_BRIGHT}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text
              x={budgetAnchor === 'end' ? budgetX - 4 : budgetX}
              y={barY - 11}
              textAnchor={budgetAnchor}
              fontSize={AXIS_TEXT}
              fill={BURGUNDY_BRIGHT}
              className="tabular"
            >
              BUDGET {duration(budget)}
            </text>
          </g>
        ) : null}

        {/* ── Overrun, labelled at the segment that broke the budget ────────── */}
        {overrunMs > 0 && budgetX !== null ? (
          <text
            x={Math.min(budgetX + 5, f.x1)}
            y={barY + BAR_H + 17}
            textAnchor="start"
            fontSize={AXIS_TEXT}
            fill={BURGUNDY_BRIGHT}
            className="tabular"
            aria-hidden
          >
            OVER BY {duration(overrunMs)}
          </text>
        ) : null}

        {/* ── Total, read off the bar's own end ────────────────────────────── */}
        <text
          x={Math.min(totalX, f.x1)}
          y={barY - (totalOnUpperLine ? 22 : 11)}
          textAnchor={totalX > f.x1 - 56 ? 'end' : 'start'}
          fontSize={AXIS_TEXT}
          fill={PARCHMENT_FAINT}
          className="tabular"
          aria-hidden
        >
          {duration(total)}
        </text>
        <text x={f.x0} y={barY + BAR_H + 17} fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT} className="tabular" aria-hidden>
          0
        </text>
      </svg>

      {/* Per-stage legend. HTML, not SVG: it is a table of figures that has to wrap
          on a narrow viewport, and text in an SVG cannot. */}
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {segments.map((segment) => (
          <div key={`legend-${segment.key}`} className="flex items-baseline gap-2.5">
            <span className="mt-[3px] h-2 w-2 shrink-0" style={{ backgroundColor: segment.colour }} aria-hidden />
            <dt className="min-w-0 flex-1 truncate text-[0.6875rem] text-parchment-dim">{segment.stage}</dt>
            {/* The stage that crossed the line states its own figure in burgundy —
                the legend has to name the culprit, not just the totals row. */}
            <dd
              className={`tabular shrink-0 text-[0.6875rem] ${segment.overflow ? 'text-burgundy-bright' : 'text-parchment'}`}
            >
              {duration(segment.ms)}
            </dd>
            <dd className="tabular shrink-0 text-[0.6875rem] text-parchment-faint">
              {fractionAsPercent(segment.share, 1)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
