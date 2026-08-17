'use client';

/**
 * Compact driver-share bars for dense panels.
 *
 * This is the reduced form of the waterfall: where the waterfall spends 48px a row
 * to give a touch target for the drill-down, this spends 20px because it lives in
 * a sidebar column next to a dozen other blocks and is read, not interrogated.
 * No axis is drawn — as with `Meter`, each row is a single proportion, so a bar is
 * the honest encoding and an axis would be decoration.
 *
 * Signed rows are the only place the sign matters, and they follow the mandated
 * force-plot convention exactly: sage right of the centre line for a supporting
 * driver, burgundy left for an opposing one. Unsigned rows are magnitudes with no
 * direction (attention weights, variable-selection weights, agent shares), so
 * they run from the left in gold.
 */

import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { BAR_GROW_LEFT, BAR_GROW_RIGHT, MIN_ANIMATED_BAR_WIDTH, WATERFALL_STAGGER, linearScale } from '@/lib/ui/svg';
import { useChartWidth } from './useChartWidth';
import {
  BURGUNDY,
  GOLD,
  OBSIDIAN_EDGE,
  PARCHMENT,
  PARCHMENT_FAINT,
  SAGE,
  fractionAsPercent,
  signedFractionAsPercent,
  truncate,
} from '@/lib/ui/format';

export interface FeatureBarItem {
  key: string;
  label: string;
  /** A share or weight in [0, 1] — or [−1, 1] when `signed`. */
  value: number;
  /** Renders from the centre line with a directional colour. */
  signed?: boolean;
  /** Native `<title>` text, for the rows too dense to caption. */
  hint?: string;
}

export interface FeatureBarsProps {
  items: FeatureBarItem[];
  /** Scale maximum. Defaults to the largest magnitude present. */
  max?: number;
  onHover?: (key: string | null) => void;
  hoveredKey?: string | null;
  /** Overrides the viewBox height; rows stay at the mandated 20px pitch. */
  height?: number;
  /** Server-render fallback width; the rendered width is measured. */
  width?: number;
}

const ROW_PITCH = 20;
const BAR_HEIGHT = 8;
/** Server-render fallback; the rendered width is measured — see `useChartWidth`. */
const VIEW_WIDTH = 280;
const VALUE_COLUMN = 44;
const GUTTER = 8;
/** Roughly the advance width of the 9px mono face, for sizing the label column. */
const LABEL_CHAR_PX = 5.4;
const MIN_LABEL_COLUMN = 104;
const MAX_LABEL_COLUMN = 300;

/**
 * The label column takes a share of the width rather than a fixed 104px.
 *
 * Fixed, it truncated every driver to 17 characters — "Sector relative…" —
 * whatever the panel width, so the full-width instance on the symbol page spent
 * 1,100px on the bars and still could not name them.
 */
function labelColumnFor(width: number): number {
  return Math.round(Math.min(MAX_LABEL_COLUMN, Math.max(MIN_LABEL_COLUMN, width * 0.3)));
}

export function FeatureBars({ items, max, onHover, hoveredKey, height, width: widthFallback = VIEW_WIDTH }: FeatureBarsProps) {
  const { ref: chartRef, width } = useChartWidth(widthFallback);
  const reduceMotion = useReducedMotion();
  const [localKey, setLocalKey] = useState<string | null>(null);

  const layout = useMemo(() => {
    const rows = items.filter((item) => Number.isFinite(item.value));
    let peak = 0;
    for (const row of rows) peak = Math.max(peak, Math.abs(row.value));
    // A supplied max of 0, an all-zero list, or a single all-equal datum would
    // otherwise divide by zero and write NaN into a width attribute.
    const ceiling = Number.isFinite(max) && (max as number) > 0 ? (max as number) : peak > 0 ? peak : 1;
    const labelColumn = labelColumnFor(width);
    const trackX0 = labelColumn + GUTTER;
    const trackWidth = Math.max(1, width - trackX0 - VALUE_COLUMN - GUTTER);
    return {
      rows,
      labelColumn,
      trackX0,
      trackWidth,
      centreX: trackX0 + trackWidth / 2,
      /** Full-track scale for unsigned rows. */
      full: linearScale([0, ceiling], [0, trackWidth]),
      /** Half-track scale for signed rows, measured out from the centre line. */
      half: linearScale([0, ceiling], [0, trackWidth / 2]),
    };
  }, [items, max, width]);

  const { rows, labelColumn, trackX0, trackWidth, centreX } = layout;
  const viewHeight = Math.max(ROW_PITCH, height ?? rows.length * ROW_PITCH);

  if (rows.length === 0) {
    // Quiet empty frame rather than an `EmptyState` block: this component sits
    // inside a fixed panel slot and must not change the panel's height.
    return (
      <svg
        ref={chartRef}
        viewBox={`0 0 ${width} ${Math.max(ROW_PITCH * 2, height ?? ROW_PITCH * 2)}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        role="img"
        aria-label="No driver shares available"
      >
        <text
          x={width / 2}
          y={ROW_PITCH}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={9}
          fill={PARCHMENT_FAINT}
        >
          no drivers
        </text>
      </svg>
    );
  }

  const activeKey = hoveredKey ?? localKey;
  const hasSigned = rows.some((row) => row.signed);

  return (
    <svg
      ref={chartRef}
      viewBox={`0 0 ${width} ${viewHeight}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-auto w-full"
      /*
       * `group`, not `img`.
       *
       * `role="img"` prunes the whole subtree from the accessibility tree, so
       * the focusable, individually-labelled drivers inside this chart were
       * built and then hidden: a screen-reader user could tab onto them and
       * hear nothing. `role="group"` keeps the container's own name and lets
       * its interactive children be announced.
       */
      role="group"
      aria-label={`${rows.length} driver shares`}
      onMouseLeave={() => {
        setLocalKey(null);
        onHover?.(null);
      }}
    >
      {/* Centre line, only when something is actually measured from it. */}
      {hasSigned ? (
        <line
          x1={centreX}
          x2={centreX}
          y1={0}
          y2={rows.length * ROW_PITCH}
          stroke={OBSIDIAN_EDGE}
          strokeWidth={1}
          strokeOpacity={0.45}
          aria-hidden
        />
      ) : null}

      {rows.map((row, index) => {
        const y = index * ROW_PITCH;
        const active = activeKey === row.key;
        const dimmed = activeKey !== null && !active;
        const signed = row.signed === true;
        const positive = row.value >= 0;

        const barWidth = signed
          ? layout.half(Math.abs(row.value))
          : layout.full(Math.max(0, row.value));
        const clamped = Math.max(0, Math.min(signed ? trackWidth / 2 : trackWidth, barWidth));
        const barX = signed ? (positive ? centreX : centreX - clamped) : trackX0;
        const fill = signed ? (positive ? SAGE : BURGUNDY) : GOLD;

        return (
          <g
            key={`${row.key}-${index}`}
            role="button"
            tabIndex={0}
            aria-label={`${row.label}: ${
              signed ? signedFractionAsPercent(row.value, 0) : fractionAsPercent(row.value, 0)
            }${row.hint ? `. ${row.hint}` : ''}`}
            className="cursor-default outline-none transition-opacity duration-150"
            opacity={dimmed ? 0.45 : 1}
            onMouseEnter={() => {
              setLocalKey(row.key);
              onHover?.(row.key);
            }}
            onFocus={() => {
              setLocalKey(row.key);
              onHover?.(row.key);
            }}
            onBlur={() => {
              setLocalKey(null);
              onHover?.(null);
            }}
            onKeyDown={(event) => {
              /*
                A `role="button"` has to answer Enter and Space. Handling only
                Escape meant Space fell through to its default and scrolled the
                page 875px instead of selecting the driver under the cursor.
              */
              if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                event.preventDefault();
                setLocalKey(row.key);
                onHover?.(row.key);
                return;
              }
              if (event.key === 'Escape') {
                setLocalKey(null);
                onHover?.(null);
              }
            }}
          >
            {row.hint ? <title>{row.hint}</title> : null}

            <rect x={0} y={y} width={width} height={ROW_PITCH} fill="transparent" />

            <text
              x={labelColumn}
              y={y + ROW_PITCH / 2}
              textAnchor="end"
              dominantBaseline="central"
              fontSize={9}
              fill={active ? PARCHMENT : PARCHMENT_FAINT}
            >
              {truncate(row.label, Math.max(12, Math.floor(labelColumn / LABEL_CHAR_PX)))}
            </text>

            {/* Empty track, so a small share still reads as small rather than absent. */}
            <rect
              x={trackX0}
              y={y + (ROW_PITCH - BAR_HEIGHT) / 2}
              width={trackWidth}
              height={BAR_HEIGHT}
              fill={OBSIDIAN_EDGE}
              fillOpacity={0.35}
              aria-hidden
            />

            {/* Positioned by a plain `<g>` rather than by an `x` attribute:
                Framer Motion claims `x` on a motion component as a CSS transform
                even when it is passed as a static prop, so an `x` here would be
                added to the group's translation and offset every bar twice. The
                growth is `scaleX` on top of this translation. */}
            <g transform={`translate(${barX} 0)`}>
            <motion.rect
              y={y + (ROW_PITCH - BAR_HEIGHT) / 2}
              width={clamped}
              height={BAR_HEIGHT}
              fill={fill}
              /* A signed bar grows outwards from the centre line, an unsigned one
                 from the track's left edge. See BAR_GROW_LEFT. */
              style={signed && !positive ? BAR_GROW_RIGHT : BAR_GROW_LEFT}
              initial={reduceMotion || clamped < MIN_ANIMATED_BAR_WIDTH ? false : { scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={
                reduceMotion || clamped < MIN_ANIMATED_BAR_WIDTH
                  ? { duration: 0 }
                  : { duration: 0.45, ease: [0.16, 1, 0.3, 1], delay: index * WATERFALL_STAGGER }
              }
            />
            </g>

            <text
              x={width - 4}
              y={y + ROW_PITCH / 2}
              textAnchor="end"
              dominantBaseline="central"
              fontSize={9}
              fill={active ? PARCHMENT : PARCHMENT_FAINT}
              className="tabular"
            >
              {signed ? signedFractionAsPercent(row.value, 0) : fractionAsPercent(row.value, 0)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
