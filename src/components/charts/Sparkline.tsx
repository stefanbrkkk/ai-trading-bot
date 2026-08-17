'use client';

/**
 * The smallest chart in the system: a bare trend glyph for table rows, stat
 * tiles and the publication list.
 *
 * No axes, no ticks, no animation. The reference implementation sets the
 * precedent — `ConvictionRing` deliberately drops the count-up because "a 64px
 * ring in a dense list should read instantly, not animate". A watchlist renders
 * dozens of these at once; a draw-in on each one would turn a scan into a light
 * show, and the design mandate forbids anything that reads as a nudge.
 *
 * Sign is taken versus the *first* value rather than versus a zero line, because
 * the series this receives are levels (price, equity, conviction), not returns.
 */

import { extent, linePath, linearScale } from '@/lib/ui/svg';
import { BURGUNDY, GOLD, PARCHMENT_FAINT, PARCHMENT_GHOST, SAGE, ratio } from '@/lib/ui/format';

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  /** Draws a 1.5px dot at the terminal point. */
  showLast?: boolean;
  /** Dotted reference level — an entry price, a cost basis, or zero. */
  baseline?: number | null;
  tone?: 'auto' | 'gold' | 'dim';
}

export function Sparkline({
  values,
  width = 64,
  height = 18,
  showLast = false,
  baseline = null,
  tone = 'auto',
}: SparklineProps) {
  const series = Array.isArray(values) ? values : [];
  const finite = series.filter((v) => Number.isFinite(v));

  // A single point is not a trend, and a zero-point series has no domain at all.
  // Render nothing rather than an SVG with NaN coordinates in it.
  if (finite.length < 2) return null;

  const first = finite[0] as number;
  const last = finite[finite.length - 1] as number;
  // The terminal dot must sit on the last *drawn* sample, which is not the last
  // slot when the tail of the series is missing.
  let lastIndex = series.length - 1;
  while (lastIndex > 0 && !Number.isFinite(series[lastIndex])) lastIndex -= 1;
  const hasBaseline = baseline != null && Number.isFinite(baseline);

  // The baseline joins the domain so it can never be scaled off-canvas: an
  // invisible reference line is worse than none.
  const [lo, hi] = extent(hasBaseline ? [...finite, baseline as number] : finite, 0.12);

  const padY = 1.5;
  const padRight = showLast ? 2.5 : 0.75;
  const y = linearScale([lo, hi], [height - padY, padY]);
  const x = linearScale([0, Math.max(1, series.length - 1)], [0.75, width - padRight]);

  // Gaps stay gaps: non-finite samples keep their x slot and break the stroke,
  // rather than being compacted out and silently distorting the time axis.
  const path = linePath(series.map((v, i) => ({ x: x(i), y: Number.isFinite(v) ? y(v) : NaN })));
  if (path.length === 0) return null;

  const stroke =
    tone === 'gold'
      ? GOLD
      : tone === 'dim'
        ? PARCHMENT_FAINT
        : last > first
          ? SAGE
          : last < first
            ? BURGUNDY
            : PARCHMENT_FAINT;

  const direction = last > first ? 'up' : last < first ? 'down' : 'flat';

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="xMidYMid meet"
      // Not `w-full`: this is a fixed-size glyph inside a table cell, and
      // stretching it to the cell width would make an 18px trend line 200px
      // tall. It still shrinks to fit a narrow container.
      className="block h-auto max-w-full overflow-visible"
      role="img"
      aria-label={`Trend ${direction}, ${ratio(first, 2)} to ${ratio(last, 2)} over ${finite.length} points`}
    >
      {hasBaseline ? (
        <line
          x1={x.range[0]}
          x2={x.range[1]}
          y1={y(baseline as number)}
          y2={y(baseline as number)}
          stroke={PARCHMENT_GHOST}
          strokeWidth={1}
          strokeDasharray="1 2"
          shapeRendering="crispEdges"
          aria-hidden
        />
      ) : null}

      <path d={path} fill="none" stroke={stroke} strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" />

      {showLast ? (
        <circle cx={x(lastIndex)} cy={y(last)} r={1.5} fill={stroke} aria-hidden />
      ) : null}
    </svg>
  );
}
