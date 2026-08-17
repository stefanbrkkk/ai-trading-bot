'use client';

/**
 * The SHAP force plot — the shape the conviction ring "unspools" into.
 *
 * Mandate: "Build the raw-SVG SHAP force plot on a single horizontal axis anchored
 * at expected_value, with features pushing against each other, sized from
 * contribution_percentage and signed by impact_direction; animate pathLength
 * 0 -> 1 for the progressive drawing effect."
 *
 * So there is exactly one axis, anchored at E[f(x)]. Every contribution is a
 * signed segment whose length is proportional to its pre-computed `share` —
 * positives pushing right of the anchor, negatives left, largest nearest the
 * anchor because the payload arrives sorted by descending |φ|. Each side is drawn
 * as one continuous `<path>` (ribbon outline followed by its interlocking chevron
 * seams as further subpaths, so a single `pathLength` tween draws the whole side
 * progressively) over per-segment chevron blocks that carry the fill and the
 * hover target.
 *
 * The outcome marker sits at the net displacement from the anchor —
 * anchor + (Σ positive share − Σ negative share) — which is the force plot's
 * statement that f(x) is E[f(x)] plus the balance of the forces shown.
 */

import { useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { WATERFALL_STAGGER, linePath, linearScale, type Point } from '@/lib/ui/svg';
import {
  BURGUNDY,
  BURGUNDY_BRIGHT,
  GOLD,
  OBSIDIAN_EDGE,
  PARCHMENT_FAINT,
  SAGE,
  SAGE_BRIGHT,
  fractionAsPercent,
  integer,
} from '@/lib/ui/format';
import { EmptyState } from '@/components/ui/primitives';
import {
  DriverTooltip,
  elementPoint,
  pointerPoint,
  tooltipAnchor,
  type HostPoint,
} from './DriverTooltip';

export interface ForceContribution {
  featureKey: string;
  label: string;
  /** Log-odds contribution. Never rendered — it only signs the segment. */
  shap: number;
  /** |φ| / Σ|φ| in [0, 1]. This is what sizes the segment. */
  share: number;
  direction: 'positive' | 'negative';
  narrative?: string;
  state?: string;
}

export interface ShapForcePlotProps {
  /**
   * E[f(x)] in log-odds. Accepted for payload parity and deliberately not
   * rendered: the compliance rule forbids putting a raw model float in front of
   * the user, so the anchor is labelled with `baseProbability` instead.
   */
  baseValue: number;
  baseProbability: number;
  finalProbability: number;
  contributions: ForceContribution[];
  onHover?: (featureKey: string | null) => void;
  hoveredKey?: string | null;
  width?: number;
}

const VIEW_HEIGHT = 132;
const AXIS_Y = 72;
/** Ribbon half-height. */
const RIBBON = 11;
/** Chevron seam depth — "a subtle arrow/chevron seam between segments". */
const NOTCH = 6;
const MARGIN_X = 30;

interface Segment {
  key: string;
  label: string;
  narrative: string;
  state?: string;
  share: number;
  direction: 'positive' | 'negative';
  /** Anchor-side edge. */
  nearX: number;
  /** Outward edge. */
  farX: number;
  nearNotch: number;
  farNotch: number;
}

/**
 * One chevron block. The near edge reproduces the previous segment's far edge
 * exactly, so consecutive blocks tile with no sliver of background showing
 * through the seam. `linePath` supplies the path string — no hand-written `d`.
 */
function chevronBlock(segment: Segment, top: number, bottom: number, mid: number): string {
  const sign = segment.farX >= segment.nearX ? 1 : -1;
  const nearShoulder = segment.nearX - sign * segment.nearNotch;
  const farShoulder = segment.farX - sign * segment.farNotch;
  const points: Point[] = [
    { x: nearShoulder, y: top },
    { x: farShoulder, y: top },
    { x: segment.farX, y: mid },
    { x: farShoulder, y: bottom },
    { x: nearShoulder, y: bottom },
  ];
  if (segment.nearNotch > 0) points.push({ x: segment.nearX, y: mid });
  return `${linePath(points)} Z`;
}

/** Ribbon outline plus every internal seam, as one continuous path string. */
function sideOutline(segments: Segment[], anchorX: number, top: number, bottom: number, mid: number): string {
  const last = segments[segments.length - 1];
  if (!last) return '';
  const sign = last.farX >= anchorX ? 1 : -1;
  const outline: Point[] = [
    { x: anchorX, y: top },
    { x: last.farX - sign * last.farNotch, y: top },
    { x: last.farX, y: mid },
    { x: last.farX - sign * last.farNotch, y: bottom },
    { x: anchorX, y: bottom },
  ];
  const parts = [`${linePath(outline)} Z`];
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seam = segments[i] as Segment;
    parts.push(
      linePath([
        { x: seam.farX - sign * seam.farNotch, y: top },
        { x: seam.farX, y: mid },
        { x: seam.farX - sign * seam.farNotch, y: bottom },
      ]),
    );
  }
  return parts.join(' ');
}

export function ShapForcePlot({
  baseProbability,
  finalProbability,
  contributions,
  onHover,
  hoveredKey,
  width = 760,
}: ShapForcePlotProps) {
  const reduceMotion = useReducedMotion();
  const host = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ key: string; point: HostPoint } | null>(null);

  const layout = useMemo(() => {
    const items = contributions.filter((c) => Number.isFinite(c.share) && c.share > 0);
    let total = 0;
    let negTotal = 0;
    let posTotal = 0;
    for (const item of items) {
      total += item.share;
      if (item.direction === 'positive') posTotal += item.share;
      else negTotal += item.share;
    }

    const viewWidth = Math.max(240, width);
    const plotSpan = Math.max(1, viewWidth - MARGIN_X * 2);
    const blank = {
      segments: [] as Segment[],
      positives: [] as Segment[],
      negatives: [] as Segment[],
      viewWidth,
      anchorX: MARGIN_X,
      outcomeX: MARGIN_X,
      empty: true,
    };
    if (items.length === 0 || total <= 0) return blank;

    // A single scale for both sides, so a 10% driver is the same length whichever
    // way it pushes.
    const pixels = linearScale([0, total], [0, plotSpan]);
    const anchorX = MARGIN_X + pixels(negTotal);
    const outcomeX = MARGIN_X + pixels(posTotal);

    const build = (side: ForceContribution[], sign: 1 | -1): Segment[] => {
      const lengths = side.map((c) => pixels(c.share));
      // Seam depth at boundary i is bounded by both adjoining segments so a thin
      // driver cannot produce a chevron longer than itself.
      const seams = lengths.map((len, i) => {
        const next = i + 1 < lengths.length ? (lengths[i + 1] as number) : len;
        return Math.min(NOTCH, len / 2, next / 2);
      });
      let cursor = anchorX;
      return side.map((c, i) => {
        const len = lengths[i] as number;
        const nearX = cursor;
        const farX = cursor + sign * len;
        cursor = farX;
        return {
          key: c.featureKey,
          label: c.label,
          narrative: c.narrative ?? '',
          state: c.state,
          share: c.share,
          direction: c.direction,
          nearX,
          farX,
          nearNotch: i === 0 ? 0 : (seams[i - 1] as number),
          farNotch: seams[i] as number,
        };
      });
    };

    const positives = build(items.filter((c) => c.direction === 'positive'), 1);
    const negatives = build(items.filter((c) => c.direction !== 'positive'), -1);

    return {
      segments: [...positives, ...negatives],
      positives,
      negatives,
      viewWidth,
      anchorX,
      outcomeX,
      empty: false,
    };
  }, [contributions, width]);

  if (layout.empty) {
    return (
      <EmptyState
        title="No forces to plot"
        detail="Every feature contribution for this signal is zero, so the prediction sits on its expected value."
      />
    );
  }

  const { viewWidth, anchorX, outcomeX, positives, negatives } = layout;
  const top = AXIS_Y - RIBBON;
  const bottom = AXIS_Y + RIBBON;
  const activeKey = hoveredKey ?? hover?.key ?? null;

  const enter = (key: string, point: HostPoint): void => {
    setHover({ key, point });
    onHover?.(key);
  };
  const leave = (): void => {
    setHover(null);
    onHover?.(null);
  };

  const hoveredSegment = hover ? layout.segments.find((s) => s.key === hover.key) : undefined;
  const tip = hover && hoveredSegment ? { segment: hoveredSegment, point: hover.point } : null;
  const basePct = fractionAsPercent(baseProbability, 1);
  const finalPct = fractionAsPercent(finalProbability, 1);

  const renderSide = (segments: Segment[], sign: 1 | -1) => {
    if (segments.length === 0) return null;
    const fill = sign === 1 ? SAGE : BURGUNDY;
    const stroke = sign === 1 ? SAGE_BRIGHT : BURGUNDY_BRIGHT;
    return (
      <g>
        {segments.map((segment, index) => {
          const active = activeKey === segment.key;
          const dimmed = activeKey !== null && !active;
          const hitX = Math.min(segment.nearX, segment.farX);
          return (
            <g
              key={`${segment.key}-${index}`}
              role="button"
              tabIndex={0}
              aria-label={`${segment.label}: ${integer(segment.share * 100)} percent of attribution, ${
                segment.direction === 'positive' ? 'supporting' : 'opposing'
              }${segment.narrative ? `. ${segment.narrative}` : ''}`}
              className="cursor-default outline-none transition-opacity duration-150"
              opacity={dimmed ? 0.45 : 1}
              onMouseEnter={(event) => enter(segment.key, pointerPoint(event, host.current))}
              onMouseMove={(event) => setHover({ key: segment.key, point: pointerPoint(event, host.current) })}
              onMouseLeave={leave}
              onFocus={(event) => enter(segment.key, elementPoint(event.currentTarget, host.current))}
              onBlur={leave}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  leave();
                  return;
                }
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  enter(segment.key, elementPoint(event.currentTarget, host.current));
                }
              }}
            >
              {/* The animate target is constant so the staggered entrance never
                  re-runs on hover; selection is carried by the stroke and by the
                  group's CSS opacity transition, which respond immediately. */}
              <motion.path
                d={chevronBlock(segment, top, bottom, AXIS_Y)}
                fill={fill}
                stroke={active ? stroke : 'none'}
                strokeWidth={active ? 1.5 : 0}
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 0.85 }}
                transition={
                  reduceMotion ? { duration: 0 } : { duration: 0.4, delay: index * WATERFALL_STAGGER }
                }
              />
              {/* Widened, invisible hit area — a 2px driver still needs a target. */}
              <rect
                x={hitX}
                y={top - 8}
                width={Math.max(2, Math.abs(segment.farX - segment.nearX))}
                height={RIBBON * 2 + 16}
                fill="transparent"
              />
            </g>
          );
        })}

        {/* The mandated progressive draw: one continuous path per side. */}
        <motion.path
          d={sideOutline(segments, anchorX, top, bottom, AXIS_Y)}
          fill="none"
          stroke={stroke}
          strokeWidth={1}
          strokeOpacity={0.7}
          strokeLinejoin="round"
          initial={reduceMotion ? { pathLength: 1 } : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: reduceMotion ? 0 : 0.9, ease: [0.16, 1, 0.3, 1] }}
          aria-hidden
        />
      </g>
    );
  };

  return (
    <div ref={host} className="relative">
      <svg
        viewBox={`0 0 ${viewWidth} ${VIEW_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        role="img"
        aria-label={`SHAP force plot: ${layout.segments.length} drivers pushing a ${basePct} expected probability to ${finalPct}`}
      >
        {/* The single horizontal axis. */}
        <line
          x1={MARGIN_X}
          x2={viewWidth - MARGIN_X}
          y1={AXIS_Y}
          y2={AXIS_Y}
          stroke={OBSIDIAN_EDGE}
          strokeWidth={1}
          strokeOpacity={0.45}
          aria-hidden
        />

        {/* E[f(x)] anchor. */}
        <line
          x1={anchorX}
          x2={anchorX}
          y1={AXIS_Y - RIBBON - 14}
          y2={AXIS_Y + RIBBON + 6}
          stroke={GOLD}
          strokeWidth={1}
          strokeOpacity={0.55}
          strokeDasharray="2 3"
        />
        <text x={anchorX} y={18} textAnchor="middle" fontSize={9} fill={PARCHMENT_FAINT}>
          E[f(x)]
        </text>
        <text x={anchorX} y={31} textAnchor="middle" fontSize={10} fill={GOLD} className="tabular">
          {basePct}
        </text>

        {renderSide(negatives, -1)}
        {renderSide(positives, 1)}

        {/* Outcome terminus. */}
        <line
          x1={outcomeX}
          x2={outcomeX}
          y1={AXIS_Y - RIBBON - 4}
          y2={AXIS_Y + RIBBON + 12}
          stroke={GOLD}
          strokeWidth={1}
        />
        <circle cx={outcomeX} cy={AXIS_Y + RIBBON + 12} r={2.5} fill={GOLD} />
        <text x={outcomeX} y={AXIS_Y + RIBBON + 30} textAnchor="middle" fontSize={11} fill={GOLD} className="tabular">
          {finalPct}
        </text>
        <text x={outcomeX} y={AXIS_Y + RIBBON + 42} textAnchor="middle" fontSize={9} fill={PARCHMENT_FAINT}>
          f(x)
        </text>

        {/* Side captions, so the sign of each side reads without a legend. */}
        <text x={MARGIN_X} y={VIEW_HEIGHT - 4} textAnchor="start" fontSize={9} fill={PARCHMENT_FAINT}>
          opposing
        </text>
        <text x={viewWidth - MARGIN_X} y={VIEW_HEIGHT - 4} textAnchor="end" fontSize={9} fill={PARCHMENT_FAINT}>
          supporting
        </text>
      </svg>

      {tip ? (
        <DriverTooltip
          label={tip.segment.label}
          narrative={tip.segment.narrative}
          share={tip.segment.share}
          state={tip.segment.state}
          x={tip.point.x}
          y={tip.point.y}
          anchor={tooltipAnchor(tip.point.x, tip.point.hostWidth)}
          visible
        />
      ) : null}
    </div>
  );
}
