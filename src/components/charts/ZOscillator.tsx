'use client';

/**
 * The mean-reversion z-score oscillator.
 *
 * Both statistical pillars of the swing mandate publish their state as a
 * z-score: the OU spread as Z = (X_t − θ)/(σ/√(2κ)), and the options surface as
 * the 50-day rolling z-score of the 25Δ risk reversal. The mandate's gate is an
 * *intersection* of the two ("long requires Z_OU < −2 AND Z_RR > +2"), so the
 * only thing this chart has to make legible is the relationship between the
 * series and four fixed horizontal lines — entry at ±2.0σ, exit inside ±0.5σ.
 * Everything else is subordinate to that reading, which is why the time axis
 * carries two dates and no ticks.
 *
 * The vertical mapping is the mandated one, y = h/2 − (z/4)·(h/2 − pad), with the
 * ±4σ limit from `Z_AXIS_LIMIT`. A fixed limit rather than a data-driven extent is
 * deliberate: a threshold chart whose scale moves with the data would make ±2σ
 * land in a different place every render, and the whole point is that the reader
 * learns where the line is.
 *
 * Regions beyond ±entry are shaded by *setup*, not by sign: a stretched-negative
 * spread z is the long setup, so it is sage; a stretched-positive z is the short
 * setup, so it is burgundy.
 */

import { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Z_AXIS_LIMIT,
  Z_ENTRY_THRESHOLD,
  Z_EXIT_THRESHOLD,
  frame,
  linearScale,
  type ChartFrame,
} from '@/lib/ui/svg';
import {
  BURGUNDY,
  CHAMPAGNE,
  GOLD,
  GOLD_BRIGHT,
  OBSIDIAN_EDGE,
  PARCHMENT,
  PARCHMENT_FAINT,
  SAGE,
  nyDate,
  ratio,
  sigma,
} from '@/lib/ui/format';

/** Vertical padding; also the `pad` term of the mandated y mapping. */
const PAD = 18;
/** Right gutter holds the four threshold captions ("+2.0 entry" at 9px mono). */
const RIGHT_GUTTER = 64;
const AXIS_TEXT = 9;

export interface ZOscillatorPoint {
  time: number;
  z: number;
}

export interface ZOscillatorProps {
  values: ZOscillatorPoint[];
  /** Absolute entry threshold in σ. Defaults to the mandated 2.0. */
  entryThreshold?: number;
  /** Absolute exit band in σ. Defaults to the mandated 0.5. */
  exitThreshold?: number;
  /** Names the series being oscillated — "OU spread", "25Δ risk reversal". */
  label: string;
  /** viewBox height; the rendered height is the container's. */
  height?: number;
  /** viewBox width used for layout only. */
  width?: number;
  /** Prefix for the terminal readout, e.g. "Z_RR". */
  currentLabel?: string;
}

interface Layout {
  f: ChartFrame;
  points: { x: number; y: number }[];
  polyline: string;
  entry: number;
  exit: number;
  centreY: number;
  yFor: (z: number) => number;
  last: { x: number; y: number; z: number; time: number } | null;
  firstTime: number;
  lastTime: number;
  count: number;
}

function buildLayout(
  values: readonly ZOscillatorPoint[],
  entryThreshold: number,
  exitThreshold: number,
  width: number,
  height: number,
): Layout | null {
  const series = (Array.isArray(values) ? values : []).filter((p) => p && Number.isFinite(p.z));
  if (series.length === 0) return null;

  const f = frame(width, height, { top: PAD, right: RIGHT_GUTTER, bottom: PAD, left: 8 });

  // The mandated mapping, written once. Out-of-range prints are clamped rather
  // than dropped — a 6σ dislocation must still show as pinned at the rail, and an
  // unclamped value would place the dot outside the viewBox.
  const centreY = height / 2;
  const amplitude = Math.max(1, height / 2 - PAD);
  const yFor = (z: number): number => {
    const clamped = Math.max(-Z_AXIS_LIMIT, Math.min(Z_AXIS_LIMIT, z));
    return centreY - (clamped / Z_AXIS_LIMIT) * amplitude;
  };

  const x = linearScale([0, Math.max(1, series.length - 1)], [f.x0, f.x1]);
  const points = series.map((p, i) => ({ x: x(i), y: yFor(p.z) }));

  const lastPoint = series[series.length - 1] as ZOscillatorPoint;
  const lastXy = points[points.length - 1] as { x: number; y: number };

  // Thresholds are user-supplied, so a zero, a negative or a NaN would otherwise
  // put a reference line on top of the zero line or off the canvas entirely.
  const safeThreshold = (value: number, fallback: number): number => {
    const abs = Math.abs(value);
    return Number.isFinite(abs) && abs > 0 && abs <= Z_AXIS_LIMIT ? abs : fallback;
  };

  return {
    f,
    points,
    polyline: points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' '),
    entry: safeThreshold(entryThreshold, Z_ENTRY_THRESHOLD),
    exit: safeThreshold(exitThreshold, Z_EXIT_THRESHOLD),
    centreY,
    yFor,
    last: { x: lastXy.x, y: lastXy.y, z: lastPoint.z, time: lastPoint.time },
    firstTime: (series[0] as ZOscillatorPoint).time,
    lastTime: lastPoint.time,
    count: series.length,
  };
}

export function ZOscillator({
  values,
  entryThreshold = Z_ENTRY_THRESHOLD,
  exitThreshold = Z_EXIT_THRESHOLD,
  label,
  height = 190,
  width = 620,
  currentLabel,
}: ZOscillatorProps) {
  const reduceMotion = useReducedMotion();
  const layout = useMemo(
    () => buildLayout(values, entryThreshold, exitThreshold, width, height),
    [values, entryThreshold, exitThreshold, width, height],
  );

  if (!layout) {
    // A quiet empty frame, not an `EmptyState` block: this chart sits in a fixed
    // panel slot beside the signal gate and must not change the panel's height.
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        role="img"
        aria-label={`${label}: no z-score history available`}
      >
        <line
          x1={8}
          x2={width - RIGHT_GUTTER}
          y1={height / 2}
          y2={height / 2}
          stroke={OBSIDIAN_EDGE}
          strokeWidth={1}
          shapeRendering="crispEdges"
          aria-hidden
        />
        <text x={width / 2} y={height / 2 - 10} textAnchor="middle" fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT}>
          no z-score history
        </text>
      </svg>
    );
  }

  const { f, polyline, entry, exit, centreY, yFor, last, firstTime, lastTime, count } = layout;

  const yEntryHigh = yFor(entry);
  const yEntryLow = yFor(-entry);
  const yExitHigh = yFor(exit);
  const yExitLow = yFor(-exit);

  const zone =
    last === null
      ? 'flat'
      : last.z >= entry
        ? 'short setup'
        : last.z <= -entry
          ? 'long setup'
          : Math.abs(last.z) <= exit
            ? 'normalised'
            : 'in transit';

  const captions: { y: number; text: string; colour: string }[] = [
    { y: yEntryHigh, text: `+${ratio(entry, 1)} entry`, colour: GOLD },
    { y: yExitHigh, text: `+${ratio(exit, 1)} exit`, colour: CHAMPAGNE },
    { y: yExitLow, text: `−${ratio(exit, 1)} exit`, colour: CHAMPAGNE },
    { y: yEntryLow, text: `−${ratio(entry, 1)} entry`, colour: GOLD },
  ];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-auto w-full"
      role="img"
      aria-label={`${label} z-score oscillator. ${count} observations, current ${
        last ? sigma(last.z, 2) : '—'
      }, ${zone}. Entry threshold ±${ratio(entry, 1)} sigma, exit band ±${ratio(exit, 1)} sigma, axis limit ±${Z_AXIS_LIMIT} sigma.`}
    >
      {/* ── 1. Setup regions, shaded by which side of the trade they arm ───── */}
      <g aria-hidden>
        <rect
          x={f.x0}
          y={f.y0}
          width={f.innerWidth}
          height={Math.max(0, yEntryHigh - f.y0)}
          fill={BURGUNDY}
          fillOpacity={0.07}
        />
        <rect
          x={f.x0}
          y={yEntryLow}
          width={f.innerWidth}
          height={Math.max(0, f.y1 - yEntryLow)}
          fill={SAGE}
          fillOpacity={0.07}
        />
      </g>

      {/* ── 2. Zero line, then the exit band, then the entry rails ─────────── */}
      <g aria-hidden>
        <line
          x1={f.x0}
          x2={f.x1}
          y1={centreY}
          y2={centreY}
          stroke={OBSIDIAN_EDGE}
          strokeWidth={1}
          shapeRendering="crispEdges"
        />
        {[yExitHigh, yExitLow].map((y, i) => (
          <line
            key={`exit-${i}`}
            x1={f.x0}
            x2={f.x1}
            y1={y}
            y2={y}
            stroke={CHAMPAGNE}
            strokeOpacity={0.4}
            strokeWidth={1}
            strokeDasharray="1 3"
            shapeRendering="crispEdges"
          />
        ))}
        {[yEntryHigh, yEntryLow].map((y, i) => (
          <line
            key={`entry-${i}`}
            x1={f.x0}
            x2={f.x1}
            y1={y}
            y2={y}
            stroke={GOLD}
            strokeOpacity={0.55}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        ))}
      </g>

      {/* ── 3. Right-hand captions. Threshold lines are worthless unlabelled. ─ */}
      <g aria-hidden>
        {captions.map((caption) => (
          <text
            key={caption.text}
            x={f.x1 + 5}
            y={caption.y}
            dominantBaseline="middle"
            fontSize={AXIS_TEXT}
            fill={PARCHMENT_FAINT}
            className="tabular"
          >
            {caption.text}
          </text>
        ))}
        <text
          x={f.x1 + 5}
          y={centreY}
          dominantBaseline="middle"
          fontSize={AXIS_TEXT}
          fill={PARCHMENT_FAINT}
          className="tabular"
        >
          0
        </text>
      </g>

      {/* ── 4. The series. Parchment, because the colour in this chart belongs
              to the thresholds and the regions, not to the line. ───────────── */}
      <motion.polyline
        points={polyline}
        fill="none"
        stroke={PARCHMENT}
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={reduceMotion ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: reduceMotion ? 0 : 0.9, ease: [0.16, 1, 0.3, 1] }}
      />

      {/* ── 5. Terminal print — the only number this chart states outright. ── */}
      {last ? (
        <motion.g
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduceMotion ? 0 : 0.35, delay: reduceMotion ? 0 : 0.85 }}
        >
          <circle cx={last.x} cy={last.y} r={2.75} fill={GOLD_BRIGHT} />
          {/* The readout normally sits behind the dot, where the drawn series is;
              with a single sample the dot is at the left edge and there is no room,
              so it flips. */}
          <text
            x={last.x < f.x0 + 90 ? last.x + 6 : last.x - 6}
            y={last.y - 7}
            textAnchor={last.x < f.x0 + 90 ? 'start' : 'end'}
            fontSize={AXIS_TEXT}
            fill={PARCHMENT}
            className="tabular"
          >
            {currentLabel ? `${currentLabel} ` : ''}
            {sigma(last.z, 2)}
          </text>
        </motion.g>
      ) : null}

      {/* ── 6. Two dates. The x axis exists to date the window, nothing more. ─ */}
      <g aria-hidden>
        <text x={f.x0} y={height - 4} fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT}>
          {nyDate(firstTime)}
        </text>
        <text x={f.x1} y={height - 4} textAnchor="end" fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT}>
          {nyDate(lastTime)}
        </text>
      </g>
    </svg>
  );
}
