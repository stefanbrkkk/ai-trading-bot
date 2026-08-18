'use client';

/**
 * The alt-data decay profile.
 *
 * Phase 2 mandates that "the initial impact weight remains constant (plateaus) for
 * a specified lag period (e.g. 24 hours to 5 days) before the exponential decay
 * initiates" for high-signal structural streams, while noise-dominated streams get
 * a steep exponential from the first tick. The operator-facing requirement is
 * equally explicit: "show live residual signal weight w_e(t) per event so
 * operators can see decayed-to-near-zero signals versus fresh ones, including the
 * plateau segment". This chart is that surface.
 *
 *     w(Δt) = authority                                for Δt ≤ plateau
 *     w(Δt) = authority · 0.5^((Δt − plateau)/H)       thereafter
 *
 * so w(plateau + H) = authority/2 exactly, and that point is ticked on every
 * curve — the half-life is the parameter the research calibrates, so it should be
 * findable on the drawing rather than only in a table.
 *
 * The x axis is logarithmic in age because the calibrated half-lives span 30
 * minutes (X/Twitter) to 90 days (10-K fundamentals). On a linear axis every
 * social curve collapses into the left-hand pixel column and the chart says
 * nothing; on a log axis each stream gets comparable horizontal room. Ticks are
 * labelled through `halfLife()` so the units stay human (min / h / d) rather than
 * milliseconds.
 *
 * Stroke is a gold → parchment ramp keyed to authority, so the streams the
 * research trusts most (SEC filings, authority 1.0) are the brightest lines and a
 * decayed social print can never visually outrank a filing.
 */

import { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useChartWidth } from './useChartWidth';
import { CHART_SHOWN, CHART_STILL, CHART_VIEWPORT } from './reveal';
import {
  frame,
  linePath,
  linearScale,
  logScale,
  mixColour,
  niceTicks,
  type ChartFrame,
  type Point,
  type Scale,
  thinLabels,
  spreadLabels,
} from '@/lib/ui/svg';
import {
  GOLD,
  OBSIDIAN_EDGE,
  PARCHMENT,
  PARCHMENT_FAINT,
  PARCHMENT_GHOST,
  fractionAsPercent,
  halfLife,
  truncate,
} from '@/lib/ui/format';

const AXIS_TEXT = 9;
/** Mandated sample count for the piecewise path. */
const SAMPLES = 200;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/**
 * Right margin holds the curve-end labels; left holds the weight axis. The margin
 * and the character budget are matched: 9px JetBrains Mono advances ≈ 5.4px, so a
 * 24-character label needs ≈ 130px and must not be given more room than that.
 */
const RIGHT_MARGIN = 150;
const LABEL_CHARS = 16;
/** Minimum vertical gap between two curve-end labels. */
/** Narrowest gap between two time-axis labels before one is dropped. */
const TICK_LABEL_MIN_GAP = 42;
const LABEL_PITCH = 13;

/** Candidate log ticks. Filtered to the domain, so a 6-hour chart is not labelled in days. */
const TICK_CANDIDATES = [
  MINUTE_MS,
  5 * MINUTE_MS,
  15 * MINUTE_MS,
  HOUR_MS,
  6 * HOUR_MS,
  DAY_MS,
  3 * DAY_MS,
  7 * DAY_MS,
  14 * DAY_MS,
  30 * DAY_MS,
  90 * DAY_MS,
  180 * DAY_MS,
  365 * DAY_MS,
];

export interface DecayProfileInput {
  stream: string;
  label: string;
  halfLifeMs: number;
  plateauMs: number;
  shape: 'sharp' | 'smoothed';
  /** Authority multiplier ∈ [0, 1] — SEC filings 1.0, social 0.30. */
  authority: number;
  /** Age of this stream's most recent event, if one is live. */
  currentAgeMs?: number;
}

export interface DecayCurveProps {
  profiles: DecayProfileInput[];
  /** Right-hand edge of the age axis. Defaults to six half-lives of the slowest stream. */
  horizonMs?: number;
  height?: number;
  width?: number;
}

interface CurveLayout {
  stream: string;
  label: string;
  d: string;
  colour: string;
  /** Native tooltip text: the calibration behind the line. */
  hint: string;
  /** Half-life tick at Δt = plateau + H, where w = authority/2. */
  tick: { x: number; y: number } | null;
  /** `anchorY` is where the curve ends; `y` is where the label was placed. */
  endLabel: { x: number; y: number; anchorY: number; text: string };
  current: { x: number; y: number; weight: number } | null;
}

interface Layout {
  f: ChartFrame;
  x: Scale;
  y: Scale;
  curves: CurveLayout[];
  xTicks: number[];
  yTicks: number[];
  domain: [number, number];
}

/**
 * The mandated memory function. Guarded rather than trusted: a zero or negative
 * half-life arrives from a mis-seeded profile, and `0.5^(Δt/0)` is Infinity, which
 * would put `NaN` into a `d` attribute.
 */
function weightAt(profile: DecayProfileInput, ageMs: number): number {
  const authority = Number.isFinite(profile.authority)
    ? Math.max(0, Math.min(1, profile.authority))
    : 0;
  const plateau = Number.isFinite(profile.plateauMs) ? Math.max(0, profile.plateauMs) : 0;
  const h = profile.halfLifeMs;
  if (ageMs <= plateau) return authority;
  if (!Number.isFinite(h) || h <= 0) return 0;
  const w = authority * Math.pow(0.5, (ageMs - plateau) / h);
  return Number.isFinite(w) ? w : 0;
}

function buildLayout(
  profiles: readonly DecayProfileInput[],
  horizonMs: number | undefined,
  width: number,
  height: number,
): Layout | null {
  const rows = (Array.isArray(profiles) ? profiles : []).filter(
    (p) => p && Number.isFinite(p.halfLifeMs) && p.halfLifeMs > 0,
  );
  if (rows.length === 0) return null;

  const f = frame(width, height, { top: 16, right: RIGHT_MARGIN, bottom: 34, left: 34 });

  let slowest = 0;
  let fastest = Infinity;
  let peak = 0;
  for (const row of rows) {
    const plateau = Number.isFinite(row.plateauMs) ? Math.max(0, row.plateauMs) : 0;
    slowest = Math.max(slowest, plateau + row.halfLifeMs);
    fastest = Math.min(fastest, row.halfLifeMs);
    peak = Math.max(peak, Number.isFinite(row.authority) ? Math.max(0, row.authority) : 0);
  }
  const ages = rows
    .map((row) => row.currentAgeMs)
    .filter((v): v is number => Number.isFinite(v as number) && (v as number) > 0);

  // A log axis cannot show Δt = 0, so it opens an order of magnitude below the
  // fastest half-life: fresh enough that every curve starts on its plateau.
  const lower = Math.max(MINUTE_MS, fastest / 10);
  const requested = Number.isFinite(horizonMs) && (horizonMs as number) > 0 ? (horizonMs as number) : slowest * 6;
  const upper = Math.max(lower * 10, requested, ...ages);
  const domain: [number, number] = [lower, upper];

  const x = logScale(domain, [f.x0, f.x1]);
  const y = linearScale([0, Math.max(peak, 0.001)], [f.y1, f.y0]);

  // Sampling is uniform in log age, i.e. uniform in *pixels*, so the 200 samples
  // are spent where they are visible. The plateau shoulder and the half-life point
  // are injected because a log grid straddles the kink and would round it off.
  const logLower = Math.log(lower);
  const logUpper = Math.log(upper);
  const step = (logUpper - logLower) / (SAMPLES - 1);

  const claimed = new Set<string>();
  const curves: CurveLayout[] = rows.map((row) => {
    const plateau = Number.isFinite(row.plateauMs) ? Math.max(0, row.plateauMs) : 0;
    const authority = Number.isFinite(row.authority) ? Math.max(0, Math.min(1, row.authority)) : 0;

    const sampleAges: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) sampleAges.push(Math.exp(logLower + i * step));
    for (const marker of [plateau, plateau + row.halfLifeMs]) {
      if (marker > lower && marker < upper) sampleAges.push(marker);
    }
    sampleAges.sort((a, b) => a - b);

    const points: Point[] = sampleAges.map((age) => ({ x: x(age), y: y(weightAt(row, age)) }));
    const tailWeight = weightAt(row, upper);

    // `shape` is descriptive metadata here — the plateau length is what actually
    // bends the curve — but a `smoothed` profile with no plateau is a data bug, so
    // it is called out on hover rather than in the label, which has a fixed budget.
    const text = `${truncate(row.label, LABEL_CHARS)} · ${halfLife(row.halfLifeMs)}`;
    const hint =
      row.shape === 'smoothed' && plateau <= 0
        ? `${row.label} — half-life ${halfLife(row.halfLifeMs)}, declared smoothed but carries no plateau`
        : `${row.label} — half-life ${halfLife(row.halfLifeMs)}, plateau ${
            plateau > 0 ? halfLife(plateau) : 'none'
          }, authority ${fractionAsPercent(authority, 0)}`;

    // Two streams may legitimately share a label slot; `stream` is the identity, so
    // a duplicated identifier gets a suffix rather than colliding React keys.
    let key = row.stream;
    while (claimed.has(key)) key = `${key}·`;
    claimed.add(key);

    const age = row.currentAgeMs;
    const hasAge = Number.isFinite(age as number) && (age as number) > 0;
    const currentWeight = hasAge ? weightAt(row, age as number) : 0;

    return {
      stream: key,
      label: row.label,
      hint,
      d: linePath(points),
      // Highest authority is the brightest line; parchment out-reads gold.
      colour: mixColour(GOLD, PARCHMENT, authority),
      tick:
        plateau + row.halfLifeMs <= upper
          ? { x: x(plateau + row.halfLifeMs), y: y(authority / 2) }
          : null,
      endLabel: { x: f.x1 + 6, y: y(tailWeight), anchorY: y(tailWeight), text },
      current: hasAge
        ? {
            x: x(Math.max(lower, Math.min(upper, age as number))),
            y: y(currentWeight),
            weight: currentWeight,
          }
        : null,
    };
  });

  /*
   * De-overlap the curve-end labels.
   *
   * Most of these streams have decayed to nearly nothing by the right edge, so a
   * dozen labels arrive at the same y. The previous pass walked down from the top
   * clamping to `f.y1`, which meant every label past the frame's capacity piled up
   * on that one baseline — six of the twelve printed through each other. Spreading
   * distributes them and pulls the overrun back inside the frame, so all twelve
   * are legible and each keeps a leader to its curve.
   */
  const labelYs = spreadLabels(
    curves.map((curve) => curve.endLabel.y),
    LABEL_PITCH,
    f.y0,
    f.y1,
  );
  curves.forEach((curve, i) => {
    curve.endLabel.anchorY = curve.endLabel.y;
    curve.endLabel.y = labelYs[i] as number;
  });

  return {
    f,
    x,
    y,
    curves,
    /*
     * Thinned by pixel distance, not just by range. The axis is logarithmic over
     * five orders of magnitude, so "5 min", "15 min" and "60 min" land within a
     * dozen pixels of each other at the left end and print through one another.
     * Keeping the first of each cluster loses a gridline and keeps the axis
     * readable, which is the right trade for a chart about half-lives.
     */
    xTicks: (() => {
      const inRange = TICK_CANDIDATES.filter((t) => t >= lower && t <= upper);
      const keep = new Set(thinLabels(inRange.map((t) => x(t)), TICK_LABEL_MIN_GAP));
      return inRange.filter((_, i) => keep.has(i));
    })(),
    /*
     * Ticks are dropped when their label would repeat or their gridline would sit
     * on top of the one before it. On a symbol whose alt-data has all decayed the
     * peak weight is a fraction of a percent, so `niceTicks` returned four levels
     * that every formatted to "0%" and printed on top of one another 11px apart.
     */
    yTicks: (() => {
      const candidates = niceTicks([0, Math.max(peak, 0.001)], 4);
      const kept: number[] = [];
      let lastY = Number.POSITIVE_INFINITY;
      let lastText = '';
      for (const tick of candidates) {
        const text = fractionAsPercent(tick, 0);
        const ty = y(tick);
        if (text === lastText || lastY - ty < AXIS_TEXT + 4) continue;
        kept.push(tick);
        lastY = ty;
        lastText = text;
      }
      return kept;
    })(),
    domain,
  };
}

export function DecayCurve({ profiles, horizonMs, height = 260, width: widthFallback = 680 }: DecayCurveProps) {
  const { ref: chartRef, width } = useChartWidth(widthFallback);
  const reduceMotion = useReducedMotion();
  const layout = useMemo(() => buildLayout(profiles, horizonMs, width, height), [profiles, horizonMs, width, height]);

  if (!layout) {
    return (
      <svg
        ref={chartRef}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        role="img"
        aria-label="No decay profiles configured"
      >
        <text x={width / 2} y={height / 2} textAnchor="middle" dominantBaseline="central" fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT}>
          no decay profiles
        </text>
      </svg>
    );
  }

  const { f, x, y, curves, xTicks, yTicks, domain } = layout;
  const live = curves.filter((curve) => curve.current !== null);
  /*
   * Residual-weight captions are printed only where they can be told apart.
   *
   * A symbol whose alt-data has all gone stale puts eight markers within a few
   * pixels of the baseline, every one captioned "0%", stacked on top of each
   * other. The marker still shows where each curve is and its `<title>` still
   * carries the exact figure; what is dropped is the repetition.
   */
  const captioned = new Set(
    thinLabels(
      live.map((curve) => (curve.current as { y: number }).y),
      AXIS_TEXT + 4,
    ).map((i) => live[i]?.stream),
  );

  return (
    <div className="relative">
      <motion.svg
        ref={chartRef}
        initial={reduceMotion ? CHART_SHOWN : CHART_STILL}
        whileInView={CHART_SHOWN}
        viewport={CHART_VIEWPORT}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        role="img"
        aria-label={`Alt-data decay profiles for ${curves.length} streams over ages from ${halfLife(
          domain[0],
        )} to ${halfLife(domain[1])}. ${curves.map((curve) => curve.hint).join('; ')}.`}
      >
        {/* ── 1. Residual-weight grid ──────────────────────────────────────── */}
        <g aria-hidden>
          {yTicks.map((tick) => {
            const ty = y(tick);
            if (ty < f.y0 - 0.5 || ty > f.y1 + 0.5) return null;
            return (
              <g key={`w-${tick}`}>
                <line
                  x1={f.x0}
                  x2={f.x1}
                  y1={ty}
                  y2={ty}
                  stroke={OBSIDIAN_EDGE}
                  strokeOpacity={0.45}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={f.x0 - 6}
                  y={ty}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={AXIS_TEXT}
                  fill={PARCHMENT_FAINT}
                  className="tabular"
                >
                  {fractionAsPercent(tick, 0)}
                </text>
              </g>
            );
          })}
        </g>

        {/* ── 2. Log age axis, labelled in natural units ───────────────────── */}
        <g aria-hidden>
          {xTicks.map((tick) => (
            <g key={`t-${tick}`}>
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
                x={x(tick)}
                y={f.y1 + 16}
                textAnchor="middle"
                fontSize={AXIS_TEXT}
                fill={PARCHMENT_FAINT}
                className="tabular"
              >
                {halfLife(tick)}
              </text>
            </g>
          ))}
          <text x={f.x0} y={height - 5} fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT}>
            age of signal (log)
          </text>
        </g>

        {/* ── 3. One path per stream, plus its half-life tick ──────────────── */}
        {curves.map((curve, index) => (
          <g key={curve.stream}>
            {curve.d ? (
              <motion.path
                d={curve.d}
                fill="none"
                stroke={curve.colour}
                strokeWidth={1.25}
                strokeLinecap="round"
                strokeLinejoin="round"
                variants={{ [CHART_STILL]: { pathLength: 0 }, [CHART_SHOWN]: { pathLength: 1 } }}
                transition={{
                  duration: reduceMotion ? 0 : 0.85,
                  ease: [0.16, 1, 0.3, 1],
                  delay: reduceMotion ? 0 : index * 0.06,
                }}
              >
                <title>{curve.hint}</title>
              </motion.path>
            ) : null}
            {curve.tick ? (
              <line
                x1={curve.tick.x}
                x2={curve.tick.x}
                y1={curve.tick.y - 3.5}
                y2={curve.tick.y + 3.5}
                stroke={curve.colour}
                strokeWidth={1}
                shapeRendering="crispEdges"
                aria-hidden
              />
            ) : null}
            <text
              x={curve.endLabel.x}
              y={curve.endLabel.y}
              dominantBaseline="middle"
              fontSize={AXIS_TEXT}
              fill={PARCHMENT_FAINT}
              aria-hidden
            >
              {curve.endLabel.text}
            </text>
            {Math.abs(curve.endLabel.y - curve.endLabel.anchorY) > 1 ? (
              <line
                x1={f.x1}
                x2={curve.endLabel.x - 2}
                y1={curve.endLabel.anchorY}
                y2={curve.endLabel.y}
                stroke={curve.colour}
                strokeOpacity={0.35}
                strokeWidth={1}
                aria-hidden
              />
            ) : null}
          </g>
        ))}

        {/* ── 4. Live events: where each stream's newest print actually sits ── */}
        {live.map((curve) => {
          const current = curve.current as { x: number; y: number; weight: number };
          return (
            <g key={`live-${curve.stream}`}>
              <line
                x1={current.x}
                x2={current.x}
                y1={f.y0}
                y2={f.y1}
                stroke={PARCHMENT_GHOST}
                strokeWidth={1}
                strokeDasharray="2 3"
                shapeRendering="crispEdges"
                aria-hidden
              />
              <motion.circle
                cx={current.x}
                cy={current.y}
                r={2.75}
                fill={curve.colour}
                variants={{ [CHART_STILL]: { opacity: 0 }, [CHART_SHOWN]: { opacity: 1 } }}
                transition={{ duration: reduceMotion ? 0 : 0.3, delay: reduceMotion ? 0 : 0.8 }}
              >
                <title>{`${curve.label} — residual weight ${fractionAsPercent(current.weight, 1)}`}</title>
              </motion.circle>
              {captioned.has(curve.stream) ? (
                <text
                  x={current.x}
                  y={current.y - 7}
                  textAnchor="middle"
                  fontSize={AXIS_TEXT}
                  fill={PARCHMENT_FAINT}
                  className="tabular"
                  aria-hidden
                >
                  {fractionAsPercent(current.weight, 0)}
                </text>
              ) : null}
            </g>
          );
        })}
      </motion.svg>

      {/* The curve is meaningless without its own definition; the operator panel
          is expected to state the memory function it is running. */}
      <p className="mt-2 text-[0.6875rem] leading-snug text-parchment-faint">
        Residual weight w = authority × 0.5<sup>(age − plateau)/half-life</sup>, flat through the plateau. Ticks mark
        the half-life, where weight is half of authority.
      </p>
    </div>
  );
}
