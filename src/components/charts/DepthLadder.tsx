'use client';

/**
 * The limit order book as a mirrored depth ladder.
 *
 * MASTER §2.2 / Phase 1 §3: "While retail traders look at Level 1 Bid/Ask sizes,
 * Aurelius constructs a Multi-Level Order Flow Imbalance vector across M depth
 * levels of the limit order book." This component is the visual half of that
 * claim — it shows the whole visible book at once, and it shows *why* the deeper
 * levels count for less.
 *
 * The mandated opacity ramp (1.0 at level 1, −0.08 per level, floored at 0.2) is
 * not decoration: it encodes the diluted price impact of resting liquidity far
 * from the touch. A 10,000-share bid five ticks down does not support the price
 * the way 10,000 shares at the touch do, so it is not drawn as though it does.
 *
 * When PC1 loadings are supplied they are drawn as a signed gold bar per level,
 * which is how the user reads which depth levels are actually driving the
 * order-flow signal rather than taking the scalar on faith.
 */

import { motion, useReducedMotion } from 'framer-motion';
import { BAR_GROW_LEFT, LADDER_OPACITY_DECAY, LADDER_ROW_PITCH, MIN_ANIMATED_BAR_WIDTH } from '@/lib/ui/svg';
import {
  BURGUNDY,
  GOLD,
  OBSIDIAN_EDGE,
  PARCHMENT,
  PARCHMENT_DIM,
  PARCHMENT_FAINT,
  SAGE,
  bps,
  compact,
  price,
} from '@/lib/ui/format';
// `spreadBps` is imported rather than reimplemented: the bp convention (spread
// over mid, not over bid) must match the number the engine publishes elsewhere.
import { MLOFI_LEVELS, spreadBps, type BookLevel, type OrderBookSnapshot } from '@/lib/quant/orderflow';
import { EmptyState } from '@/components/ui/primitives';
import { useChartWidth } from './useChartWidth';
import { CHART_SHOWN, CHART_STILL, CHART_VIEWPORT } from './reveal';

/** Width of the centre price column — two 8-character tabular prices at 10px. */
const CENTRE_WIDTH = 132;
/** Right-hand gutter for the PC1 loading bars, present only when supplied. */
const LOADING_WIDTH = 60;
const LOADING_GAP = 10;
/** Header holds the column labels and the spread readout. */
const HEADER_HEIGHT = 36;
/** Bar height inside the mandated 24px row pitch, leaving a 6px channel. */
const BAR_HEIGHT = LADDER_ROW_PITCH - 6;
const AXIS_TEXT = 9;
const PRICE_TEXT = 10;

export interface DepthLadderProps {
  /**
   * The depth snapshot to draw.
   *
   * Nullable because the caller's is: a publisher that has received no book for
   * this symbol has nothing to hand over, and the component already answers that
   * with its own empty state rather than a blank frame. The body has always
   * guarded with `book?.bids`, so this widens the declaration to what the
   * implementation already does instead of forcing every caller to synthesise an
   * empty book to satisfy the type.
   */
  book: OrderBookSnapshot | null;
  /** Depth levels M to draw. Defaults to the platform-wide MLOFI_LEVELS. */
  levels?: number;
  /** Target viewBox height. The 24px row pitch is never compressed to fit it. */
  height?: number;
  /** PC1 loading per depth level, from `computeMlofiSignal`. */
  mlofiLoadings?: number[];
  /** viewBox width used for layout. The rendered size is the container's. */
  width?: number;
}

/**
 * A bar that grows from `origin`, leftward when mirrored.
 *
 * Only `width` is animated. Framer Motion maps a `motion.rect`'s `x` onto a CSS
 * `translateX` rather than onto the SVG geometry attribute, so animating `x`
 * would displace the bar on top of the position it was already laid out at.
 * Mirroring the group instead leaves exactly one animated value and exact
 * geometry.
 */
function DepthBar({
  origin,
  mirrored,
  y,
  length,
  height,
  fill,
  fillOpacity,
  animated,
}: {
  origin: number;
  mirrored?: boolean;
  y: number;
  length: number;
  height: number;
  fill: string;
  fillOpacity: number;
  animated: boolean;
}) {
  return (
    <g transform={mirrored ? `translate(${origin},0) scale(-1,1)` : `translate(${origin},0)`}>
      <motion.rect
        x={0}
        y={y}
        width={Math.max(0, length)}
        height={height}
        fill={fill}
        fillOpacity={fillOpacity}
        style={BAR_GROW_LEFT}
        variants={{
          [CHART_STILL]: { scaleX: animated && length >= MIN_ANIMATED_BAR_WIDTH ? 0 : 1 },
          [CHART_SHOWN]: { scaleX: 1 },
        }}
        // One uniform tween, no per-level stagger: the book updates continuously,
        // and a staggered delay would re-fire on every snapshot and leave the
        // ladder permanently shimmering instead of readable.
        transition={
          animated && length >= MIN_ANIMATED_BAR_WIDTH ? { duration: 0.38, ease: [0.16, 1, 0.3, 1] } : { duration: 0 }
        }
      />
    </g>
  );
}

function drawableLevels(side: BookLevel[] | undefined, count: number): (BookLevel | null)[] {
  const source = Array.isArray(side) ? side : [];
  return Array.from({ length: count }, (_, i) => {
    const level = source[i];
    if (!level || !Number.isFinite(level.price) || !Number.isFinite(level.size) || level.size < 0) return null;
    return level;
  });
}

export function DepthLadder({ book, levels, height, mlofiLoadings, width: widthFallback = 560 }: DepthLadderProps) {
  const { ref: chartRef, width } = useChartWidth(widthFallback);
  const reduceMotion = useReducedMotion();

  const rawBids = Array.isArray(book?.bids) ? book.bids : [];
  const rawAsks = Array.isArray(book?.asks) ? book.asks : [];
  const loadings = Array.isArray(mlofiLoadings) ? mlofiLoadings : [];
  const requested = levels != null && Number.isFinite(levels) && levels > 0 ? Math.floor(levels) : MLOFI_LEVELS;
  const count = Math.max(0, Math.min(requested, Math.max(rawBids.length, rawAsks.length)));

  if (count === 0) {
    return (
      <EmptyState
        title="Order book unavailable"
        detail="No depth snapshot has been received for this symbol. The MLOFI signal is suppressed until the book repopulates."
      />
    );
  }

  const bids = drawableLevels(rawBids, count);
  const asks = drawableLevels(rawAsks, count);

  const hasLoadings = loadings.some((v) => Number.isFinite(v));
  const loadingGutter = hasLoadings ? LOADING_WIDTH + LOADING_GAP : 0;
  const halfWidth = Math.max(24, (width - CENTRE_WIDTH - loadingGutter) / 2);
  const centreLeft = halfWidth;
  const centreRight = halfWidth + CENTRE_WIDTH;
  const loadingX0 = centreRight + halfWidth + LOADING_GAP;
  const loadingZero = loadingX0 + LOADING_WIDTH / 2;

  const intrinsicHeight = HEADER_HEIGHT + count * LADDER_ROW_PITCH + 4;
  // The 24px pitch is mandated, and it is also what keeps ten levels legible at a
  // glance, so a smaller `height` prop extends the viewBox rather than compressing
  // the rows into an unreadable stack.
  const viewHeight = height != null && Number.isFinite(height) ? Math.max(height, intrinsicHeight) : intrinsicHeight;

  // Both sides share one denominator: a bid bar and an ask bar of equal length
  // must mean equal size, otherwise the mirror is a lie.
  let maxSize = 0;
  for (const level of [...bids, ...asks]) if (level && level.size > maxSize) maxSize = level.size;

  let maxLoading = 0;
  if (hasLoadings) {
    for (const v of loadings) if (Number.isFinite(v)) maxLoading = Math.max(maxLoading, Math.abs(v));
  }

  const barLength = (size: number): number => (maxSize <= 0 ? 0 : (size / maxSize) * halfWidth);
  const rowY = (m: number): number => HEADER_HEIGHT + m * LADDER_ROW_PITCH;
  // Rounded so the attribute reads as 0.68 rather than 0.6799999999999999.
  const rowOpacity = (m: number): number => Math.round(Math.max(0.2, 1 - m * LADDER_OPACITY_DECAY) * 100) / 100;

  const bothSides = rawBids.length > 0 && rawAsks.length > 0;
  const spread = bothSides && book ? spreadBps(book) : NaN;
  const animated = !reduceMotion;

  return (
    <motion.svg
      ref={chartRef}
      initial={reduceMotion ? CHART_SHOWN : CHART_STILL}
      whileInView={CHART_SHOWN}
      viewport={CHART_VIEWPORT}
      viewBox={`0 0 ${width} ${viewHeight}`}
      width={width}
      height={viewHeight}
      preserveAspectRatio="xMidYMid meet"
      className="h-auto w-full"
      role="img"
      aria-label={
        `Order book depth ladder, ${count} levels each side` +
        (Number.isFinite(spread) ? `, spread ${bps(spread)}` : '') +
        (hasLoadings ? ', with first principal component loadings per level' : '')
      }
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <text x={2} y={13} fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT} className="tabular">
        BID SIZE
      </text>
      <text x={centreRight + halfWidth} y={13} textAnchor="end" fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT} className="tabular">
        ASK SIZE
      </text>
      <text x={centreLeft + CENTRE_WIDTH / 2} y={13} textAnchor="middle" fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT} className="tabular">
        {Number.isFinite(spread) ? `SPREAD ${bps(spread)}` : 'SPREAD —'}
      </text>
      {hasLoadings ? (
        <text x={loadingZero} y={13} textAnchor="middle" fontSize={AXIS_TEXT} fill={GOLD} fillOpacity={0.75} className="tabular">
          PC1
        </text>
      ) : null}
      <line
        x1={0}
        x2={width}
        y1={HEADER_HEIGHT - 8}
        y2={HEADER_HEIGHT - 8}
        stroke={OBSIDIAN_EDGE}
        strokeOpacity={0.45}
        strokeWidth={1}
        shapeRendering="crispEdges"
        aria-hidden
      />

      {/* Touch line: the only price boundary that matters for execution. */}
      <line
        x1={centreLeft + CENTRE_WIDTH / 2}
        x2={centreLeft + CENTRE_WIDTH / 2}
        y1={HEADER_HEIGHT - 4}
        y2={rowY(count)}
        stroke={OBSIDIAN_EDGE}
        strokeOpacity={0.45}
        strokeWidth={1}
        shapeRendering="crispEdges"
        aria-hidden
      />

      {hasLoadings ? (
        <line
          x1={loadingZero}
          x2={loadingZero}
          y1={HEADER_HEIGHT - 4}
          y2={rowY(count)}
          stroke={OBSIDIAN_EDGE}
          strokeOpacity={0.45}
          strokeWidth={1}
          shapeRendering="crispEdges"
          aria-hidden
        />
      ) : null}

      {/* ── Levels ─────────────────────────────────────────────────────────── */}
      {Array.from({ length: count }, (_, m) => {
        const bid = bids[m] ?? null;
        const ask = asks[m] ?? null;
        const y = rowY(m);
        const opacity = rowOpacity(m);
        const bidLength = bid ? barLength(bid.size) : 0;
        const askLength = ask ? barLength(ask.size) : 0;
        const loading = hasLoadings ? loadings[m] : undefined;
        const loadingLength =
          loading != null && Number.isFinite(loading) && maxLoading > 0
            ? (Math.abs(loading) / maxLoading) * (LOADING_WIDTH / 2)
            : 0;

        return (
          <g key={m}>
            {bid ? (
              <DepthBar
                origin={centreLeft}
                mirrored
                y={y}
                length={bidLength}
                height={BAR_HEIGHT}
                fill={SAGE}
                fillOpacity={opacity}
                animated={animated}
              />
            ) : null}
            {ask ? (
              <DepthBar
                origin={centreRight}
                y={y}
                length={askLength}
                height={BAR_HEIGHT}
                fill={BURGUNDY}
                fillOpacity={opacity}
                animated={animated}
              />
            ) : null}

            {/* Sizes sit in fixed outer columns so they stay a readable tabular
                stack instead of tracking the ragged ends of the bars. */}
            {bid ? (
              <text x={2} y={y + BAR_HEIGHT - 5} fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT} className="tabular">
                {compact(bid.size)}
              </text>
            ) : null}
            {ask ? (
              <text
                x={centreRight + halfWidth}
                y={y + BAR_HEIGHT - 5}
                textAnchor="end"
                fontSize={AXIS_TEXT}
                fill={PARCHMENT_FAINT}
                className="tabular"
              >
                {compact(ask.size)}
              </text>
            ) : null}

            {/* Centre price column: bid left of the touch line, ask right. */}
            <text
              x={centreLeft + CENTRE_WIDTH / 2 - 7}
              y={y + BAR_HEIGHT - 5}
              textAnchor="end"
              fontSize={PRICE_TEXT}
              fill={m === 0 ? PARCHMENT : PARCHMENT_DIM}
              className="tabular"
            >
              {bid ? price(bid.price) : '—'}
            </text>
            <text
              x={centreLeft + CENTRE_WIDTH / 2 + 7}
              y={y + BAR_HEIGHT - 5}
              fontSize={PRICE_TEXT}
              fill={m === 0 ? PARCHMENT : PARCHMENT_DIM}
              className="tabular"
            >
              {ask ? price(ask.price) : '—'}
            </text>

            {/* PC1 loadings are signed, and the sign of a principal component is
                arbitrary — so both directions are gold. Only the magnitude, i.e.
                how much this depth level drives the signal, is meaningful. */}
            {loadingLength > 0 && loading != null ? (
              <DepthBar
                origin={loadingZero}
                mirrored={loading < 0}
                y={y + BAR_HEIGHT / 2 - 2}
                length={loadingLength}
                height={4}
                fill={GOLD}
                fillOpacity={0.85}
                animated={animated}
              />
            ) : null}
          </g>
        );
      })}
    </motion.svg>
  );
}
