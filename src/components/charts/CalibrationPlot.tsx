'use client';

/**
 * Reliability diagram for the calibrated probability head.
 *
 * The mandate publishes a *calibrated* probability, not a score, which means the
 * claim being made is testable: of the bars where the model said 60%, roughly 60%
 * should have resolved in its favour. This chart is that test, and the 45° line is
 * the null hypothesis — so it is drawn first, dashed and faint, as a reference the
 * gold series is measured against rather than a series of its own.
 *
 * Circle radius is proportional to √count, not to count, because area is what the
 * eye integrates: scaling the radius linearly would make a 500-sample bin look
 * twenty-five times heavier than a 20-sample bin instead of five. A small circle
 * far from the diagonal is a thin bin, not a broken model, and the radius is the
 * only thing on the chart that says so.
 *
 * Nothing is computed here. The binning, the observed frequencies, the Brier score
 * and the ECE all arrive pre-computed; this file projects them.
 */

import { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { frame, linearScale, smoothPath, type ChartFrame, type Scale } from '@/lib/ui/svg';
import { GOLD, OBSIDIAN_EDGE, PARCHMENT_DIM, PARCHMENT_FAINT, fractionAsPercent, integer, ratio } from '@/lib/ui/format';
import { EmptyState } from '@/components/ui/primitives';
import { useChartWidth } from './useChartWidth';

const AXIS_TEXT = 9;
/** 0.25 ticks on both axes, as specified. */
const TICKS = [0, 0.25, 0.5, 0.75, 1] as const;
const MIN_RADIUS = 2;
const MAX_RADIUS = 7;

export interface CalibrationBin {
  bin: number;
  meanPredicted: number;
  observedFrequency: number;
  count: number;
}

export interface CalibrationPlotProps {
  curve: CalibrationBin[];
  /** Mean squared error of the probability forecast, lower is better. */
  brier?: number;
  /** Expected calibration error. */
  ece?: number;
  /** viewBox width used for layout; the rendered width is the container's. */
  width?: number;
  height?: number;
}

interface Dot {
  key: string;
  cx: number;
  cy: number;
  r: number;
  title: string;
}

interface Layout {
  f: ChartFrame;
  x: Scale;
  y: Scale;
  dots: Dot[];
  curveD: string;
  observations: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function computeLayout(props: CalibrationPlotProps): Layout | null {
  const { curve, width = 380, height = 340 } = props;

  const clean = (Array.isArray(curve) ? curve : [])
    .filter((b) => !!b && Number.isFinite(b.meanPredicted) && Number.isFinite(b.observedFrequency))
    .slice()
    // The monotone cubic through the points needs an increasing x, and a bin list
    // arriving in insertion order is not guaranteed to be sorted by probability.
    .sort((a, b) => a.meanPredicted - b.meanPredicted);
  if (clean.length === 0) return null;

  // Left margin carries both the "100%" tick labels and the rotated axis title.
  const f = frame(width, height, { top: 14, right: 16, bottom: 30, left: 44 });
  if (f.innerWidth <= 0 || f.innerHeight <= 0) return null;

  const x = linearScale([0, 1], [f.x0, f.x1]);
  const y = linearScale([0, 1], [f.y1, f.y0]);

  let maxCount = 0;
  for (const b of clean) if (Number.isFinite(b.count)) maxCount = Math.max(maxCount, b.count);
  const scaleRoot = maxCount > 0 ? Math.sqrt(maxCount) : 0;

  const dots: Dot[] = clean.map((b, i) => {
    const count = Number.isFinite(b.count) ? Math.max(0, b.count) : 0;
    const r =
      scaleRoot > 0
        ? Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * (Math.sqrt(count) / scaleRoot)))
        : MIN_RADIUS;
    // A probability outside [0, 1] is malformed input; clamping keeps it on the
    // canvas instead of drawing outside the viewBox.
    const predicted = clamp01(b.meanPredicted);
    const observed = clamp01(b.observedFrequency);
    return {
      key: `bin-${Number.isFinite(b.bin) ? b.bin : i}-${i}`,
      cx: x(predicted),
      cy: y(observed),
      r,
      title:
        `Predicted ${fractionAsPercent(predicted, 1)}, observed ${fractionAsPercent(observed, 1)} ` +
        `over ${integer(count)} observations`,
    };
  });

  let observations = 0;
  for (const b of clean) if (Number.isFinite(b.count)) observations += Math.max(0, b.count);

  return {
    f,
    x,
    y,
    dots,
    curveD: smoothPath(dots.map((d) => ({ x: d.cx, y: d.cy }))),
    observations,
  };
}

export function CalibrationPlot({ curve, brier, ece, width: widthFallback = 380, height = 340 }: CalibrationPlotProps) {
  const { ref: chartRef, width } = useChartWidth(widthFallback);
  const reduceMotion = useReducedMotion();
  const layout = useMemo(() => computeLayout({ curve, width, height }), [curve, width, height]);

  if (!layout) {
    return (
      <EmptyState
        title="No calibration data"
        detail="No resolved forecasts have accumulated for this model version, so reliability cannot be assessed yet."
      />
    );
  }

  const { f, x, y, dots, curveD, observations } = layout;
  const hasBrier = Number.isFinite(brier);
  const hasEce = Number.isFinite(ece);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[0.6875rem] leading-none text-parchment-faint">
        <span className="inline-flex items-center gap-1.5">
          <svg width={16} height={8} viewBox="0 0 16 8" aria-hidden className="shrink-0">
            <line x1={0} x2={16} y1={4} y2={4} stroke={PARCHMENT_FAINT} strokeWidth={1} strokeDasharray="3 3" />
          </svg>
          Perfect calibration
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width={16} height={8} viewBox="0 0 16 8" aria-hidden className="shrink-0">
            <line x1={0} x2={16} y1={4} y2={4} stroke={GOLD} strokeWidth={1.25} />
            <circle cx={8} cy={4} r={2.5} fill={GOLD} />
          </svg>
          Observed — circle area ∝ bin count
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
          `Reliability diagram, ${dots.length} probability bins over ${integer(observations)} observations. ` +
          'Predicted probability on the horizontal axis against observed frequency on the vertical.' +
          (hasBrier ? ` Brier score ${ratio(brier as number, 3)}.` : '') +
          (hasEce ? ` Expected calibration error ${ratio(ece as number, 3)}.` : '')
        }
      >
        {/* ── 1. Grid and 0.25 ticks on both axes ──────────────────────────── */}
        <g aria-hidden>
          {TICKS.map((tick) => (
            <g key={`tick-${tick}`}>
              <line
                x1={f.x0}
                x2={f.x1}
                y1={y(tick)}
                y2={y(tick)}
                stroke={OBSIDIAN_EDGE}
                strokeOpacity={0.45}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <line
                x1={x(tick)}
                x2={x(tick)}
                y1={f.y0}
                y2={f.y1}
                stroke={OBSIDIAN_EDGE}
                strokeOpacity={0.45}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={f.x0 - 6}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={AXIS_TEXT}
                fill={PARCHMENT_FAINT}
                className="tabular"
              >
                {fractionAsPercent(tick, 0)}
              </text>
              <text
                x={x(tick)}
                y={f.y1 + 13}
                textAnchor={tick === 0 ? 'start' : tick === 1 ? 'end' : 'middle'}
                fontSize={AXIS_TEXT}
                fill={PARCHMENT_FAINT}
                className="tabular"
              >
                {fractionAsPercent(tick, 0)}
              </text>
            </g>
          ))}
          <text x={(f.x0 + f.x1) / 2} y={f.y1 + 26} textAnchor="middle" fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT} className="tabular">
            PREDICTED PROBABILITY
          </text>
          <text
            x={12}
            y={(f.y0 + f.y1) / 2}
            textAnchor="middle"
            fontSize={AXIS_TEXT}
            fill={PARCHMENT_FAINT}
            className="tabular"
            transform={`rotate(-90 12 ${(f.y0 + f.y1) / 2})`}
          >
            OBSERVED FREQUENCY
          </text>
        </g>

        {/* ── 2. The null hypothesis, drawn beneath the observations ───────── */}
        <line
          x1={x(0)}
          x2={x(1)}
          y1={y(0)}
          y2={y(1)}
          stroke={PARCHMENT_FAINT}
          strokeWidth={1}
          strokeDasharray="3 3"
          aria-hidden
        />

        {/* ── 3. Observed reliability curve ────────────────────────────────── */}
        {curveD ? (
          <motion.path
            d={curveD}
            fill="none"
            stroke={GOLD}
            strokeWidth={1.25}
            strokeLinejoin="round"
            initial={reduceMotion ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: reduceMotion ? 0 : 0.9, ease: [0.16, 1, 0.3, 1] }}
            aria-hidden
          />
        ) : null}

        {/* ── 4. Bins. `<title>` carries the exact figures on hover ────────── */}
        {dots.map((dot) => (
          <g key={dot.key}>
            <title>{dot.title}</title>
            <circle cx={dot.cx} cy={dot.cy} r={dot.r} fill={GOLD} fillOpacity={0.85} stroke={GOLD} strokeWidth={0.75} />
          </g>
        ))}

        {/* ── 5. Scores, in the corner the diagonal leaves empty ───────────── */}
        {hasBrier || hasEce ? (
          <g aria-hidden>
            {hasBrier ? (
              <text x={f.x0 + 6} y={f.y0 + 11} fontSize={AXIS_TEXT} fill={PARCHMENT_DIM} className="tabular">
                BRIER {ratio(brier as number, 3)}
              </text>
            ) : null}
            {hasEce ? (
              <text x={f.x0 + 6} y={f.y0 + (hasBrier ? 24 : 11)} fontSize={AXIS_TEXT} fill={PARCHMENT_DIM} className="tabular">
                ECE {ratio(ece as number, 3)}
              </text>
            ) : null}
          </g>
        ) : null}
      </svg>

      <p className="mt-2.5 text-[0.6875rem] leading-relaxed text-parchment-faint">
        Points <span className="text-parchment-dim">above</span> the diagonal mean the model is under-confident: the
        outcome occurred more often than it predicted. Points below it mean the opposite — it claimed more certainty
        than the record supports. A point sitting on the line is a forecast that means exactly what it says.
      </p>
    </div>
  );
}
