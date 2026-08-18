'use client';

/**
 * Histogram of realised returns, with the tail marked.
 *
 * The bin count is chosen by Freedman–Diaconis (h = 2·IQR/∛n) rather than fixed,
 * because return series are fat-tailed and a fixed count misrepresents them in
 * both directions: too few bins bury the tail inside a wide central bar, too many
 * shatter the body into noise that looks like structure. FD scales the bin width
 * to the interquartile spread — the part of the distribution that is actually
 * dense — so the tail keeps its own bins. When the IQR is zero (a degenerate or
 * heavily truncated series) FD divides by nothing, so it falls back to Sturges,
 * and the caption states which rule was used: a histogram whose binning is
 * undisclosed is an argument, not a measurement.
 *
 * VaR and CVaR are drawn as the loss thresholds they are, with everything beyond
 * VaR shaded, because the number on its own invites the reading "the worst case is
 * −2.3%". The shaded region is the point: 5% of the observations are in there, and
 * CVaR is their average, not their limit.
 *
 * `mean` and `quantile` come from `@/lib/quant/stats`. They are the one exception
 * to "no maths in a chart": the props deliberately carry the raw series, so the
 * binning *is* this component's layout, and re-implementing a quantile locally
 * would fork a tested primitive.
 */

import { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { mean, quantile } from '@/lib/quant/stats';
import { frame, linearScale, niceTicks, thinLabels, type ChartFrame, type Scale } from '@/lib/ui/svg';
import {
  BURGUNDY,
  BURGUNDY_BRIGHT,
  GOLD,
  OBSIDIAN_EDGE,
  PARCHMENT_FAINT,
  SAGE,
  fractionAsPercent,
  integer,
  signedFractionAsPercent,
} from '@/lib/ui/format';
import { EmptyState } from '@/components/ui/primitives';
import { useChartWidth } from './useChartWidth';
import { CHART_SHOWN, CHART_STILL, CHART_VIEWPORT } from './reveal';

const AXIS_TEXT = 9;
const Y_TICKS = 4;
const X_TICKS = 6;
const BAR_GAP = 1;
/** Enough bins for a fat tail, few enough that each one still has samples. */
const MAX_BINS = 120;

type BinRule = 'freedman-diaconis' | 'sturges' | 'caller';

export interface ReturnDistributionProps {
  /** Decimal fractions — trade or daily returns. */
  returns: number[];
  /** 95% VaR. Either sign convention is accepted; it is read as a loss. */
  var95?: number;
  /** 95% conditional VaR (expected shortfall). */
  cvar95?: number;
  /** viewBox width used for layout; the rendered width is the container's. */
  width?: number;
  height?: number;
  /** Overrides Freedman–Diaconis. Use only when comparing two charts bin-for-bin. */
  bins?: number;
}

interface Bar {
  key: string;
  x: number;
  w: number;
  y: number;
  h: number;
  fill: string;
  title: string;
}

interface Marker {
  x: number;
  label: string;
  colour: string;
  anchor: 'start' | 'end';
  labelY: number;
  dash?: string;
}

interface Layout {
  f: ChartFrame;
  x: Scale;
  y: Scale;
  bars: Bar[];
  yTicks: number[];
  xTicks: number[];
  meanX: number;
  meanValue: number;
  markers: Marker[];
  tail: { x: number; w: number } | null;
  binWidth: number;
  binCount: number;
  rule: BinRule;
  observations: number;
  baseline: number;
}

function computeLayout(props: ReturnDistributionProps): Layout | null {
  const { returns, var95, cvar95, width = 560, height = 280, bins } = props;

  const finite = (Array.isArray(returns) ? returns : []).filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;

  const f = frame(width, height, { top: 16, right: 40, bottom: 28, left: 12 });
  if (f.innerWidth <= 0 || f.innerHeight <= 0) return null;

  let lo = Infinity;
  let hi = -Infinity;
  for (const v of finite) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // An all-equal series has no span at all. Padding it gives one honest bin
  // centred on the value instead of a zero-width rect and a NaN scale.
  if (!(hi - lo > 0)) {
    const pad = Math.max(Math.abs(lo) * 0.02, 1e-4);
    lo -= pad;
    hi += pad;
  }

  const iqr = quantile(finite, 0.75) - quantile(finite, 0.25);
  const fdWidth = iqr > 0 ? (2 * iqr) / Math.cbrt(finite.length) : 0;

  let rule: BinRule;
  let binCount: number;
  if (Number.isFinite(bins) && (bins as number) >= 1) {
    rule = 'caller';
    binCount = Math.min(MAX_BINS, Math.round(bins as number));
  } else if (fdWidth > 0) {
    rule = 'freedman-diaconis';
    binCount = Math.min(MAX_BINS, Math.max(1, Math.ceil((hi - lo) / fdWidth)));
  } else {
    // Sturges: ⌈log₂ n⌉ + 1. Assumes near-normality, which a return series is not,
    // but it is defined when the IQR is zero and FD is not.
    rule = 'sturges';
    binCount = Math.min(MAX_BINS, Math.max(1, Math.ceil(Math.log2(finite.length)) + 1));
  }

  const binWidth = (hi - lo) / binCount;
  const counts = new Array<number>(binCount).fill(0);
  for (const v of finite) {
    const index = Math.min(binCount - 1, Math.max(0, Math.floor((v - lo) / binWidth)));
    counts[index] = (counts[index] as number) + 1;
  }

  let maxCount = 0;
  for (const c of counts) maxCount = Math.max(maxCount, c);

  const x = linearScale([lo, hi], [f.x0, f.x1]);
  const y = linearScale([0, maxCount > 0 ? maxCount : 1], [f.y1, f.y0]);
  const baseline = f.y1;

  const bars: Bar[] = counts.map((count, i) => {
    const edgeLo = lo + i * binWidth;
    const edgeHi = edgeLo + binWidth;
    const left = x(edgeLo);
    const right = x(edgeHi);
    const top = y(count);
    // The sign of the bin's centre decides the hue: a bin straddling zero is
    // mostly one side or the other, and the midpoint is the honest tiebreak.
    const positive = edgeLo + binWidth / 2 >= 0;
    return {
      key: `bin-${i}`,
      x: left,
      w: Math.max(0.5, right - left - BAR_GAP),
      y: top,
      h: Math.max(0, baseline - top),
      fill: positive ? SAGE : BURGUNDY,
      title:
        `${signedFractionAsPercent(edgeLo, 2)} to ${signedFractionAsPercent(edgeHi, 2)}: ` +
        `${integer(count)} of ${integer(finite.length)}`,
    };
  });

  // VaR and CVaR are reported as a signed quantile by `engine/backtest` and as a
  // positive magnitude by some vendors. Both mean a loss, so both are read as the
  // left tail — the alternative is shading the profitable half of the chart.
  const asLoss = (value: number | undefined): number | null =>
    Number.isFinite(value) ? -Math.abs(value as number) : null;
  const varLevel = asLoss(var95);
  const cvarLevel = asLoss(cvar95);

  const markers: Marker[] = [];
  const clampX = (value: number): number => Math.max(f.x0, Math.min(f.x1, x(value)));
  if (varLevel !== null) {
    const px = clampX(varLevel);
    markers.push({
      x: px,
      label: `VaR95 ${signedFractionAsPercent(varLevel, 2)}`,
      colour: BURGUNDY_BRIGHT,
      anchor: px < f.x0 + 70 ? 'start' : 'end',
      labelY: f.y0 + 10,
      dash: '4 3',
    });
  }
  if (cvarLevel !== null) {
    const px = clampX(cvarLevel);
    markers.push({
      x: px,
      label: `CVaR95 ${signedFractionAsPercent(cvarLevel, 2)}`,
      colour: BURGUNDY_BRIGHT,
      anchor: px < f.x0 + 70 ? 'start' : 'end',
      // Stacked below the VaR label: the two thresholds are always close together
      // and a shared baseline would overprint them.
      labelY: f.y0 + 22,
      dash: '2 3',
    });
  }

  const meanValue = mean(finite);

  return {
    f,
    x,
    y,
    bars,
    yTicks: niceTicks([0, maxCount > 0 ? maxCount : 1], Y_TICKS),
    // Thinned by pixel gap: at 308px the ±5% steps sit 3px closer than their labels are wide.
    xTicks: (() => {
      const candidates = niceTicks([lo, hi], X_TICKS);
      const keep = new Set(thinLabels(candidates.map((t) => x(t)), 46));
      return candidates.filter((_, i) => keep.has(i));
    })(),
    meanX: clampX(meanValue),
    meanValue,
    markers,
    tail: varLevel === null ? null : { x: f.x0, w: Math.max(0, clampX(varLevel) - f.x0) },
    binWidth,
    binCount,
    rule,
    observations: finite.length,
    baseline,
  };
}

const RULE_CAPTION: Record<BinRule, string> = {
  'freedman-diaconis': 'Freedman–Diaconis, 2·IQR/∛n',
  sturges: 'Sturges fallback — the interquartile range is zero, so Freedman–Diaconis is undefined',
  caller: 'fixed bin count supplied by the caller',
};

export function ReturnDistribution({
  returns,
  var95,
  cvar95,
  width: widthFallback = 560,
  height = 280,
  bins,
}: ReturnDistributionProps) {
  const { ref: chartRef, width } = useChartWidth(widthFallback);
  const reduceMotion = useReducedMotion();
  const layout = useMemo(
    () => computeLayout({ returns, var95, cvar95, width, height, bins }),
    [returns, var95, cvar95, width, height, bins],
  );

  if (!layout) {
    return (
      <EmptyState
        title="No returns to distribute"
        detail="This selection produced no closed trades, so there is no distribution to describe."
      />
    );
  }

  const { f, x, y, bars, yTicks, xTicks, meanX, meanValue, markers, tail, binWidth, binCount, rule, observations, baseline } =
    layout;

  return (
    <div>
      <motion.svg
        ref={chartRef}
        initial={reduceMotion ? CHART_SHOWN : CHART_STILL}
        whileInView={CHART_SHOWN}
        viewport={CHART_VIEWPORT}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        role="img"
        aria-label={
          `Return distribution: ${integer(observations)} observations in ${integer(binCount)} bins of ` +
          `${fractionAsPercent(binWidth, 2)}. Mean ${signedFractionAsPercent(meanValue, 2)}.` +
          (markers.length > 0 ? ` ${markers.map((m) => m.label).join(', ')}.` : '')
        }
      >
        {/* ── 1. Count grid and right-hand axis ────────────────────────────── */}
        <g aria-hidden>
          {yTicks.map((tick) => (
            <g key={`y-${tick}`}>
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
              <text
                x={f.x1 + 6}
                y={y(tick)}
                dominantBaseline="middle"
                fontSize={AXIS_TEXT}
                fill={PARCHMENT_FAINT}
                className="tabular"
              >
                {integer(tick)}
              </text>
            </g>
          ))}
        </g>

        {/* ── 2. The tail beyond VaR, shaded behind the bars ───────────────── */}
        {tail && tail.w > 0 ? (
          <rect x={tail.x} y={f.y0} width={tail.w} height={Math.max(0, baseline - f.y0)} fill={BURGUNDY} fillOpacity={0.12} aria-hidden />
        ) : null}

        {/* ── 3. Bars, growing from the baseline ───────────────────────────── */}
        {bars.map((bar, i) => (
          <g key={bar.key}>
            <title>{bar.title}</title>
            <motion.rect
              x={bar.x}
              width={bar.w}
              y={bar.y}
              height={bar.h}
              fill={bar.fill}
              fillOpacity={0.78}
              /*
                `attrY`, not `y`.
                Framer Motion treats `y` as a CSS transform, so animating it while
                the element also carries a static `y` attribute *adds* the two: the
                bars rendered at `bar.y + bar.y`, which put six of ten of them past
                the bottom of a 280-unit viewBox and left the two survivors hanging
                below the axis. `attrY` drives the SVG attribute itself, so the
                static value is the one that moves and the server-rendered position
                is already correct.
              */
              variants={{
                [CHART_STILL]: { attrY: baseline, height: 0 },
                [CHART_SHOWN]: { attrY: bar.y, height: bar.h },
              }}
              transition={{
                duration: reduceMotion ? 0 : 0.45,
                // Sweeping left to right reads as the distribution filling in
                // rather than as bars competing for attention.
                delay: reduceMotion ? 0 : Math.min(0.4, i * 0.012),
                ease: [0.16, 1, 0.3, 1],
              }}
            />
          </g>
        ))}

        {/* ── 4. Mean — the only gold mark, so it reads as the centre ───────── */}
        <g aria-hidden>
          <line x1={meanX} x2={meanX} y1={f.y0} y2={baseline} stroke={GOLD} strokeWidth={1} shapeRendering="crispEdges" />
          <text
            x={meanX + (meanX > f.x1 - 70 ? -4 : 4)}
            y={f.y0 + (markers.length > 1 ? 34 : markers.length === 1 ? 22 : 10)}
            textAnchor={meanX > f.x1 - 70 ? 'end' : 'start'}
            fontSize={AXIS_TEXT}
            fill={GOLD}
            className="tabular"
          >
            MEAN {signedFractionAsPercent(meanValue, 2)}
          </text>
        </g>

        {/* ── 5. VaR / CVaR thresholds ─────────────────────────────────────── */}
        <g aria-hidden>
          {markers.map((marker) => (
            <g key={marker.label}>
              <line
                x1={marker.x}
                x2={marker.x}
                y1={f.y0}
                y2={baseline}
                stroke={marker.colour}
                strokeWidth={1}
                strokeDasharray={marker.dash}
                shapeRendering="crispEdges"
              />
              <text
                x={marker.x + (marker.anchor === 'end' ? -4 : 4)}
                y={marker.labelY}
                textAnchor={marker.anchor}
                fontSize={AXIS_TEXT}
                fill={marker.colour}
                className="tabular"
              >
                {marker.label}
              </text>
            </g>
          ))}
        </g>

        {/* ── 6. Zero and the return axis ──────────────────────────────────── */}
        <g aria-hidden>
          <line
            x1={f.x0}
            x2={f.x1}
            y1={baseline}
            y2={baseline}
            stroke={OBSIDIAN_EDGE}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          {xTicks.map((tick) => {
            const px = x(tick);
            if (px < f.x0 - 0.5 || px > f.x1 + 0.5) return null;
            return (
              <text
                key={`x-${tick}`}
                x={px}
                y={baseline + 14}
                textAnchor="middle"
                fontSize={AXIS_TEXT}
                fill={PARCHMENT_FAINT}
                className="tabular"
              >
                {signedFractionAsPercent(tick, 1)}
              </text>
            );
          })}
        </g>
      </motion.svg>

      <p className="mt-2.5 text-[0.6875rem] leading-relaxed text-parchment-faint">
        {integer(binCount)} bins of {fractionAsPercent(binWidth, 2)} ({RULE_CAPTION[rule]}) over{' '}
        {integer(observations)} observations.
        {tail ? ' The shaded region is the 5% of observations beyond VaR95; CVaR95 is their average, not their limit.' : ''}
      </p>
    </div>
  );
}
