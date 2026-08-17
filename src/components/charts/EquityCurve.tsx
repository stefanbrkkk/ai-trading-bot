'use client';

/**
 * Equity curve with the underwater drawdown panel.
 *
 * The Combine rules discard a track record whose peak-to-trough drawdown exceeds
 * 15% — the same ceiling `engine/backtest` warns on. So this chart is not
 * "equity over time"; it is equity *against the constraint that would have ended
 * the account*. That is why the drawdown gets its own 30% panel descending from
 * its own zero line instead of a shaded region behind the curve: a drawdown drawn
 * behind an ascending equity line is decoration, whereas an axis that falls from
 * zero toward a labelled ceiling is a pass/fail read.
 *
 * The benchmark is deliberately the quietest mark here — 1px, dashed,
 * parchment-faint. It is context for the gold strategy line, not a competitor for
 * attention, and the mandate reserves gold for the primary series.
 *
 * No statistics are computed. Equity, benchmark and per-point drawdown all arrive
 * pre-computed; the only derivations are the argmax that positions the
 * max-drawdown bracket and the pixel projections.
 */

import { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  areaPath,
  downsample,
  extent,
  frame,
  linePath,
  linearScale,
  logScale as logDomainScale,
  niceTicks,
  smoothPath,
  type ChartFrame,
  type Point,
  type Scale,
} from '@/lib/ui/svg';
import {
  BURGUNDY,
  BURGUNDY_BRIGHT,
  GOLD,
  OBSIDIAN_EDGE,
  PARCHMENT_FAINT,
  fractionAsPercent,
  money,
  nyDate,
  signedFractionAsPercent,
} from '@/lib/ui/format';
import { EmptyState } from '@/components/ui/primitives';
import { useChartWidth } from './useChartWidth';

/** Mandated 70 / 30 split between the equity and drawdown panels. */
const EQUITY_SHARE = 0.7;
const PANEL_GAP = 18;
const AXIS_TEXT = 9;
const GRID_TICKS = 5;
const DATE_LABELS = 5;
/** Above this many samples the monotone cubic is sub-pixel and just costs DOM. */
const SMOOTH_LIMIT = 300;
/** The Combine's discard threshold. */
const DEFAULT_CEILING = 0.15;
/** A drawdown this small is a rounding artefact, not an underwater period. */
const UNDERWATER_EPS = 1e-9;

export interface EquityCurvePoint {
  time: number;
  equity: number;
  /** Signed or unsigned; only the magnitude is drawn (see `magnitudes`). */
  drawdown: number;
  benchmark: number;
  exposure: number;
}

export interface EquityCurveProps {
  points: EquityCurvePoint[];
  /** Decimal fraction. Default 0.15 — the Combine's discard threshold. */
  maxDrawdownCeiling?: number;
  /** viewBox width used for layout; the rendered width is the container's. */
  width?: number;
  height?: number;
  /** Log equity axis, for a curve spanning an order of magnitude. */
  logScale?: boolean;
}

interface AxisLabel {
  x: number;
  label: string;
  anchor: 'start' | 'middle' | 'end';
}

interface Layout {
  f: ChartFrame;
  count: number;
  eqY0: number;
  eqY1: number;
  ddY0: number;
  ddY1: number;
  yEquity: Scale;
  equityD: string;
  benchmarkD: string;
  drawdownD: string;
  gridTicks: number[];
  dateLabels: AxisLabel[];
  maxDrawdown: number;
  ddTop: number;
  trough: Point | null;
  bracket: { x0: number; x1: number; y: number; labelX: number; label: string } | null;
  ceiling: { y: number; label: string } | null;
  logUsed: boolean;
  firstTime: number;
  lastTime: number;
  lastEquity: number;
}

function isDrawable(p: EquityCurvePoint | undefined): p is EquityCurvePoint {
  return !!p && Number.isFinite(p.time) && Number.isFinite(p.equity);
}

/** Spread-free min/max: a multi-year daily curve overflows the argument list. */
function bounds(values: readonly number[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

function computeLayout(props: EquityCurveProps): Layout | null {
  const { points, maxDrawdownCeiling, width = 920, height = 400, logScale = false } = props;

  // Sorted by time before anything is projected: the monotone cubic assumes an
  // increasing x, and an out-of-order series would render as a folded ribbon.
  const clean = (Array.isArray(points) ? points : []).filter(isDrawable).sort((a, b) => a.time - b.time);
  if (clean.length === 0) return null;

  const f = frame(width, height, { top: 14, right: 62, bottom: 24, left: 10 });
  if (f.innerWidth <= 0 || f.innerHeight <= 0) return null;

  const panelHeight = Math.max(0, f.innerHeight - PANEL_GAP);
  const eqY0 = f.y0;
  const eqY1 = eqY0 + panelHeight * EQUITY_SHARE;
  const ddY0 = eqY1 + PANEL_GAP;
  const ddY1 = f.y1;
  if (eqY1 - eqY0 < 4 || ddY1 - ddY0 < 4) return null;

  // Two samples per pixel is the resolution limit of the display; past that LTTB
  // is drawing detail nobody can see. Selecting *rows* by index rather than
  // interpolating keeps equity, benchmark and drawdown aligned to one another.
  const maxPoints = Math.max(3, Math.round(f.innerWidth * 2));
  const shown =
    clean.length <= maxPoints
      ? clean
      : downsample(
          clean.map((p, i) => ({ x: i, y: p.equity })),
          maxPoints,
        )
          .map((p) => clean[p.x])
          .filter(isDrawable);
  if (shown.length === 0) return null;

  const firstTime = (shown[0] as EquityCurvePoint).time;
  const lastPoint = shown[shown.length - 1] as EquityCurvePoint;
  const x = linearScale([firstTime, lastPoint.time], [f.x0, f.x1]);

  const levels: number[] = [];
  for (const p of shown) {
    levels.push(p.equity);
    if (Number.isFinite(p.benchmark)) levels.push(p.benchmark);
  }
  const [levelMin, levelMax] = bounds(levels);

  // A log axis is only defined on a strictly positive domain. A blown-up account
  // touches zero, so the request is honoured when it can be and silently
  // downgraded when it cannot — an empty panel would be worse than a linear one.
  const logUsed = logScale && levelMin > 0;
  const eqDomain: [number, number] = logUsed
    ? [levelMin / 1.04, levelMax * 1.04]
    : extent(levels, 0.06);
  const yEquity = logUsed ? logDomainScale(eqDomain, [eqY1, eqY0]) : linearScale(eqDomain, [eqY1, eqY0]);

  const smooth = shown.length <= SMOOTH_LIMIT;
  const equityPoints: Point[] = shown.map((p) => ({ x: x(p.time), y: yEquity(p.equity) }));
  const benchmarkPoints: Point[] = shown.map((p) => ({
    x: x(p.time),
    // NaN breaks the pen rather than closing a gap the benchmark never covered.
    y: Number.isFinite(p.benchmark) ? yEquity(p.benchmark) : NaN,
  }));

  // `drawdown` is negative in `engine/backtest` but the magnitude is what the
  // panel encodes, so either sign convention renders identically.
  const magnitudes = shown.map((p) => (Number.isFinite(p.drawdown) ? Math.abs(p.drawdown) : 0));
  const maxDrawdown = Math.max(0, bounds(magnitudes)[1]);

  const rawCeiling = Number.isFinite(maxDrawdownCeiling) ? Math.abs(maxDrawdownCeiling as number) : DEFAULT_CEILING;
  const ceilingBreached = rawCeiling > 0 && maxDrawdown > rawCeiling;

  // The domain always has positive span, so the scale never collapses to the
  // midpoint and never emits NaN for a flat, never-underwater curve.
  const ddTop = Math.max(maxDrawdown * 1.15, ceilingBreached ? rawCeiling * 1.15 : 0, 0.01);
  const yDrawdown = linearScale([0, ddTop], [ddY0, ddY1]);
  const drawdownPoints: Point[] = shown.map((p, i) => ({ x: x(p.time), y: yDrawdown(magnitudes[i] as number) }));

  let trough: Point | null = null;
  let bracket: Layout['bracket'] = null;
  if (maxDrawdown > UNDERWATER_EPS) {
    let argmax = 0;
    for (let i = 1; i < magnitudes.length; i += 1) {
      if ((magnitudes[i] as number) > (magnitudes[argmax] as number)) argmax = i;
    }
    // The bracket spans the underwater *period* containing the trough: from the
    // last equity high before it to the recovery after it (or to the right edge
    // when the curve never recovered, which is itself the finding).
    let start = argmax;
    while (start > 0 && (magnitudes[start - 1] as number) > UNDERWATER_EPS) start -= 1;
    let end = argmax;
    while (end < magnitudes.length - 1 && (magnitudes[end + 1] as number) > UNDERWATER_EPS) end += 1;

    trough = { x: x((shown[argmax] as EquityCurvePoint).time), y: yDrawdown(magnitudes[argmax] as number) };
    const bx0 = x((shown[start] as EquityCurvePoint).time);
    const bx1 = x((shown[end] as EquityCurvePoint).time);
    if (bx1 - bx0 >= 2) {
      bracket = {
        x0: bx0,
        x1: bx1,
        y: ddY0 + 4,
        // The label shares the annotation line above the panel with the DRAWDOWN
        // eyebrow, so it is clamped clear of it rather than centred blindly.
        labelX: Math.min(Math.max((bx0 + bx1) / 2, f.x0 + 82), f.x1 - 42),
        label: `MAX DD ${signedFractionAsPercent(-maxDrawdown, 2)}`,
      };
    }
  }

  // Bounded by width: five 70px dates do not fit a 308px mobile chart.
  const labelCount = Math.max(2, Math.min(DATE_LABELS, shown.length, Math.floor(f.innerWidth / 95)));
  const step = labelCount <= 1 ? 0 : (shown.length - 1) / (labelCount - 1);
  const seen = new Set<number>();
  const dateLabels: AxisLabel[] = [];
  for (let k = 0; k < labelCount; k += 1) {
    const index = Math.round(k * step);
    if (seen.has(index)) continue;
    seen.add(index);
    dateLabels.push({
      x: x((shown[index] as EquityCurvePoint).time),
      label: nyDate((shown[index] as EquityCurvePoint).time),
      anchor: index === 0 ? 'start' : index === shown.length - 1 ? 'end' : 'middle',
    });
  }

  return {
    f,
    count: shown.length,
    eqY0,
    eqY1,
    ddY0,
    ddY1,
    yEquity,
    equityD: smooth ? smoothPath(equityPoints) : linePath(equityPoints),
    benchmarkD: linePath(benchmarkPoints),
    drawdownD: areaPath(drawdownPoints, ddY0, smooth),
    gridTicks: niceTicks(eqDomain, GRID_TICKS),
    dateLabels,
    maxDrawdown,
    ddTop,
    trough,
    bracket,
    ceiling: ceilingBreached
      ? { y: yDrawdown(rawCeiling), label: `${fractionAsPercent(rawCeiling, 0)} Combine ceiling` }
      : null,
    logUsed,
    firstTime,
    lastTime: lastPoint.time,
    lastEquity: lastPoint.equity,
  };
}

export function EquityCurve({
  points,
  maxDrawdownCeiling,
  width: widthFallback = 920,
  height = 400,
  logScale = false,
}: EquityCurveProps) {
  const { ref: chartRef, width } = useChartWidth(widthFallback);
  const reduceMotion = useReducedMotion();
  const layout = useMemo(
    () => computeLayout({ points, maxDrawdownCeiling, width, height, logScale }),
    [points, maxDrawdownCeiling, width, height, logScale],
  );

  if (!layout) {
    return (
      <EmptyState
        title="No equity curve"
        detail="This run produced no drawable equity points. Nothing is extrapolated from an empty series."
      />
    );
  }

  const {
    f,
    count,
    eqY0,
    eqY1,
    ddY0,
    ddY1,
    yEquity,
    equityD,
    benchmarkD,
    drawdownD,
    gridTicks,
    dateLabels,
    maxDrawdown,
    ddTop,
    trough,
    bracket,
    ceiling,
    logUsed,
    firstTime,
    lastTime,
    lastEquity,
  } = layout;

  const hasBenchmark = benchmarkD.length > 0;

  return (
    <div>
      {/* Legend is chrome, so it is HTML — an SVG legend cannot wrap on a phone. */}
      <div className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[0.6875rem] leading-none text-parchment-faint">
        <span className="inline-flex items-center gap-1.5">
          <svg width={16} height={8} viewBox="0 0 16 8" aria-hidden className="shrink-0">
            <line x1={0} x2={16} y1={4} y2={4} stroke={GOLD} strokeWidth={1.5} />
          </svg>
          Strategy equity{logUsed ? ' — log axis' : ''}
        </span>
        {hasBenchmark ? (
          <span className="inline-flex items-center gap-1.5">
            <svg width={16} height={8} viewBox="0 0 16 8" aria-hidden className="shrink-0">
              <line x1={0} x2={16} y1={4} y2={4} stroke={PARCHMENT_FAINT} strokeWidth={1} strokeDasharray="4 3" />
            </svg>
            Benchmark
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1.5">
          <svg width={16} height={8} viewBox="0 0 16 8" aria-hidden className="shrink-0">
            <rect x={0} y={0} width={16} height={8} fill={BURGUNDY} fillOpacity={0.35} />
          </svg>
          Underwater drawdown
        </span>
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
          `Equity curve, ${count} points from ${nyDate(firstTime)} to ${nyDate(lastTime)}. ` +
          `Ending equity ${money(lastEquity, { whole: true })}. ` +
          `Maximum drawdown ${fractionAsPercent(maxDrawdown, 2)}${ceiling ? `, above the ${ceiling.label}` : ''}.`
        }
      >
        {/* ── 1. Equity grid and right-hand money axis ─────────────────────── */}
        <g aria-hidden>
          {gridTicks.map((tick) => {
            const y = yEquity(tick);
            if (y < eqY0 - 0.5 || y > eqY1 + 0.5) return null;
            return (
              <g key={`eq-grid-${tick}`}>
                <line
                  x1={f.x0}
                  x2={f.x1}
                  y1={y}
                  y2={y}
                  stroke={OBSIDIAN_EDGE}
                  strokeOpacity={0.45}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={f.x1 + 6}
                  y={y}
                  dominantBaseline="middle"
                  fontSize={AXIS_TEXT}
                  fill={PARCHMENT_FAINT}
                  className="tabular"
                >
                  {money(tick, { whole: true })}
                </text>
              </g>
            );
          })}
        </g>

        {/* ── 2. Benchmark, drawn first so the strategy line owns the top ──── */}
        {hasBenchmark ? (
          <path
            d={benchmarkD}
            fill="none"
            stroke={PARCHMENT_FAINT}
            strokeOpacity={0.75}
            strokeWidth={1}
            strokeDasharray="4 3"
            aria-hidden
          />
        ) : null}

        {/* ── 3. Strategy equity — the one gold mark, drawn in on mount ────── */}
        {equityD ? (
          <motion.path
            d={equityD}
            fill="none"
            stroke={GOLD}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            initial={reduceMotion ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: reduceMotion ? 0 : 1.1, ease: [0.16, 1, 0.3, 1] }}
            aria-hidden
          />
        ) : null}

        {/* ── 4. Underwater panel ──────────────────────────────────────────── */}
        <g aria-hidden>
          <line
            x1={f.x0}
            x2={f.x1}
            y1={ddY0}
            y2={ddY0}
            stroke={OBSIDIAN_EDGE}
            strokeOpacity={0.45}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          {drawdownD ? <path d={drawdownD} fill={BURGUNDY} fillOpacity={0.35} stroke="none" /> : null}
          <text x={f.x0 + 2} y={ddY0 - 5} fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT} className="tabular">
            DRAWDOWN
          </text>
          <text
            x={f.x1 + 6}
            y={ddY0}
            dominantBaseline="middle"
            fontSize={AXIS_TEXT}
            fill={PARCHMENT_FAINT}
            className="tabular"
          >
            0%
          </text>
          <text
            x={f.x1 + 6}
            y={ddY1}
            dominantBaseline="middle"
            fontSize={AXIS_TEXT}
            fill={PARCHMENT_FAINT}
            className="tabular"
          >
            {signedFractionAsPercent(-ddTop, 0)}
          </text>
        </g>

        {/* ── 5. The 15% ceiling, drawn only when it was actually breached ─── */}
        {ceiling ? (
          <g aria-hidden>
            <line
              x1={f.x0}
              x2={f.x1}
              y1={ceiling.y}
              y2={ceiling.y}
              stroke={BURGUNDY_BRIGHT}
              strokeWidth={1}
              strokeDasharray="5 4"
              shapeRendering="crispEdges"
            />
            <text x={f.x0 + 2} y={ceiling.y + 10} fontSize={AXIS_TEXT} fill={BURGUNDY_BRIGHT} className="tabular">
              {ceiling.label}
            </text>
          </g>
        ) : null}

        {/* ── 6. Max-drawdown bracket over its underwater span ─────────────── */}
        {bracket ? (
          <g aria-hidden>
            <line
              x1={bracket.x0}
              x2={bracket.x1}
              y1={bracket.y}
              y2={bracket.y}
              stroke={BURGUNDY_BRIGHT}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <line x1={bracket.x0} x2={bracket.x0} y1={bracket.y} y2={bracket.y + 4} stroke={BURGUNDY_BRIGHT} strokeWidth={1} />
            <line x1={bracket.x1} x2={bracket.x1} y1={bracket.y} y2={bracket.y + 4} stroke={BURGUNDY_BRIGHT} strokeWidth={1} />
            <text
              x={bracket.labelX}
              y={bracket.y - 9}
              textAnchor="middle"
              fontSize={AXIS_TEXT}
              fill={BURGUNDY_BRIGHT}
              className="tabular"
            >
              {bracket.label}
            </text>
          </g>
        ) : null}
        {trough ? <circle cx={trough.x} cy={trough.y} r={2} fill={BURGUNDY_BRIGHT} aria-hidden /> : null}

        {/* ── X axis ───────────────────────────────────────────────────────── */}
        <g aria-hidden>
          {dateLabels.map((label) => (
            <text
              key={`${label.label}-${label.x}`}
              x={label.x}
              y={f.y1 + 14}
              textAnchor={label.anchor}
              fontSize={AXIS_TEXT}
              fill={PARCHMENT_FAINT}
              className="tabular"
            >
              {label.label}
            </text>
          ))}
        </g>
      </svg>
    </div>
  );
}
