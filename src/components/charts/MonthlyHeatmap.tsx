'use client';

/**
 * Year × month return grid.
 *
 * A monthly table of returns is the one view that exposes *when* a strategy made
 * its money, which the headline CAGR hides: twelve mediocre months and one
 * outlier print the same annual figure as a steady year, and only the grid tells
 * them apart. So the encoding is deliberately dumb — one rect per month, sign by
 * hue, magnitude by tint — and nothing is smoothed or interpolated.
 *
 * Tint is mixed against the charcoal ground with `mixColour` rather than applied
 * as `fillOpacity`, because opacity over a gradient plinth shifts hue as the
 * panel background changes, and a floor keeps a +0.1% month visible instead of
 * fading it into the surface.
 *
 * The annual column compounds; it does not sum. Summing monthly returns
 * overstates a positive year and understates a negative one, and a heatmap whose
 * total column disagrees with the backtest's own total return is worse than no
 * total column at all.
 */

import { useMemo } from 'react';
import { frame, mixColour, type ChartFrame } from '@/lib/ui/svg';
import {
  BURGUNDY,
  CHARCOAL,
  OBSIDIAN_EDGE,
  PARCHMENT,
  PARCHMENT_FAINT,
  SAGE,
  signedFractionAsPercent,
} from '@/lib/ui/format';
import { EmptyState } from '@/components/ui/primitives';
import { useChartWidth } from './useChartWidth';

const MONTH_INITIALS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'] as const;
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const ROW_PITCH = 26;
const HEADER_H = 16;
const YEAR_GUTTER = 46;
const TOTAL_COL = 58;
const TOTAL_GAP = 10;
const CELL_GAP = 1.5;
/** Mandated: below this cell width the inline label is dropped for a `<title>`. */
const LABEL_MIN_WIDTH = 34;
const CELL_TEXT = 9;
const AXIS_TEXT = 9;
/** Floor tint so a near-flat month is still a cell and not a hole in the grid. */
const MIN_TINT = 0.16;

export interface MonthlyReturn {
  year: number;
  /** 1–12, matching `BacktestResult.monthlyReturns`. */
  month: number;
  /** Decimal fraction, e.g. 0.0342. */
  ret: number;
}

export interface MonthlyHeatmapProps {
  returns: MonthlyReturn[];
  /** viewBox width used for layout; the rendered width is the container's. */
  width?: number;
  /** Defaults to one 26px row per year, which keeps cells legible. */
  height?: number;
}

interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  label: string | null;
  title: string;
}

interface TotalCell extends Cell {
  key: string;
}

interface Row {
  year: number;
  y: number;
  h: number;
}

interface Layout {
  f: ChartFrame;
  /** Resolved from the row count when the caller does not pass one. */
  height: number;
  rows: Row[];
  cells: Cell[];
  empties: { x: number; y: number; w: number; h: number; key: string }[];
  totals: TotalCell[];
  monthHeads: { x: number; label: string; key: string }[];
  totalHeadX: number;
  months: number;
  best: number;
  worst: number;
}

/** Below this a month rounds to "+0.0%" in the cell, so it is drawn as flat. */
const FLAT_RETURN = 0.00005;

function tint(value: number, magnitude: number): string {
  /*
   * A month that returned nothing is not a month that returned something
   * positive. `value >= 0` painted 22 of 41 cells sage on a strategy that lost
   * money over the period — every one of them reading "+0.0%" — which made a
   * losing backtest look like a mostly-green year. Flat months get the charcoal
   * ground instead, so the greens and reds in the grid are the months that
   * actually moved.
   */
  if (!(Math.abs(value) > FLAT_RETURN)) return CHARCOAL;
  const t = magnitude > 0 ? Math.min(1, Math.abs(value) / magnitude) : 0;
  return mixColour(CHARCOAL, value > 0 ? SAGE : BURGUNDY, MIN_TINT + (1 - MIN_TINT) * t);
}

function computeLayout(props: MonthlyHeatmapProps): Layout | null {
  const { returns, width = 760 } = props;

  const clean = (Array.isArray(returns) ? returns : []).filter(
    (r) =>
      !!r &&
      Number.isFinite(r.year) &&
      Number.isFinite(r.month) &&
      Number.isFinite(r.ret) &&
      r.month >= 1 &&
      r.month <= 12,
  );
  if (clean.length === 0) return null;

  // Last write wins on a duplicated (year, month) — the alternative is drawing two
  // rects in the same cell, where the loser is invisible but still in the DOM.
  const byYear = new Map<number, Map<number, number>>();
  for (const r of clean) {
    const year = Math.round(r.year);
    const existing = byYear.get(year) ?? new Map<number, number>();
    existing.set(Math.round(r.month), r.ret);
    byYear.set(year, existing);
  }
  const years = Array.from(byYear.keys()).sort((a, b) => a - b);

  const height = props.height ?? HEADER_H + 6 + years.length * ROW_PITCH + 4;
  const f = frame(width, height, { top: HEADER_H + 6, right: 4, bottom: 4, left: YEAR_GUTTER });
  const gridWidth = f.innerWidth - TOTAL_COL - TOTAL_GAP;
  const cellW = gridWidth / 12;
  const rowH = f.innerHeight / years.length;
  if (cellW <= CELL_GAP || rowH <= CELL_GAP) return null;

  let magnitude = 0;
  for (const r of clean) magnitude = Math.max(magnitude, Math.abs(r.ret));

  const showLabels = cellW >= LABEL_MIN_WIDTH;
  const rows: Row[] = [];
  const cells: Cell[] = [];
  const empties: Layout['empties'] = [];
  const totals: TotalCell[] = [];
  let annualMagnitude = 0;
  const annuals: { year: number; value: number }[] = [];

  for (const year of years) {
    const months = byYear.get(year) as Map<number, number>;
    let compounded = 1;
    for (const value of months.values()) compounded *= 1 + value;
    const annual = compounded - 1;
    annuals.push({ year, value: annual });
    annualMagnitude = Math.max(annualMagnitude, Math.abs(annual));
  }

  years.forEach((year, rowIndex) => {
    const months = byYear.get(year) as Map<number, number>;
    const y = f.y0 + rowIndex * rowH + CELL_GAP / 2;
    const h = rowH - CELL_GAP;
    rows.push({ year, y, h: rowH });

    for (let m = 1; m <= 12; m += 1) {
      const x = f.x0 + (m - 1) * cellW + CELL_GAP / 2;
      const w = cellW - CELL_GAP;
      const value = months.get(m);
      if (value === undefined) {
        // An outlined slot reads as "no observation"; a filled one would read as
        // a flat month, which is a different and false claim.
        empties.push({ x, y, w, h, key: `${year}-${m}` });
        continue;
      }
      cells.push({
        x,
        y,
        w,
        h,
        fill: tint(value, magnitude),
        label: showLabels ? signedFractionAsPercent(value, 1) : null,
        title: `${MONTH_NAMES[m - 1]} ${year}: ${signedFractionAsPercent(value, 2)}`,
      });
    }
  });

  const totalX = f.x0 + gridWidth + TOTAL_GAP;
  annuals.forEach((annual, rowIndex) => {
    const y = f.y0 + rowIndex * rowH + CELL_GAP / 2;
    totals.push({
      key: `total-${annual.year}`,
      x: totalX,
      y,
      w: TOTAL_COL,
      h: rowH - CELL_GAP,
      fill: tint(annual.value, annualMagnitude),
      label: signedFractionAsPercent(annual.value, 1),
      title: `${annual.year} compounded: ${signedFractionAsPercent(annual.value, 2)}`,
    });
  });

  let best = -Infinity;
  let worst = Infinity;
  for (const r of clean) {
    if (r.ret > best) best = r.ret;
    if (r.ret < worst) worst = r.ret;
  }

  return {
    f,
    height,
    rows,
    cells,
    empties,
    totals,
    monthHeads: MONTH_INITIALS.map((initial, i) => ({
      x: f.x0 + i * cellW + cellW / 2,
      label: initial,
      key: `head-${i}`,
    })),
    totalHeadX: totalX + TOTAL_COL / 2,
    months: clean.length,
    best,
    worst,
  };
}

export function MonthlyHeatmap({ returns, width: widthFallback = 760, height }: MonthlyHeatmapProps) {
  const { ref: chartRef, width } = useChartWidth(widthFallback);
  const layout = useMemo(() => computeLayout({ returns, width, height }), [returns, width, height]);

  if (!layout) {
    return (
      <EmptyState
        title="No monthly returns"
        detail="This run covers less than a calendar month, so there is no grid to draw."
      />
    );
  }

  const { f, cells, empties, totals, rows, monthHeads, totalHeadX, months, best, worst, height: viewHeight } = layout;
  const firstYear = (rows[0] as Row).year;
  const lastYear = (rows[rows.length - 1] as Row).year;

  return (
    <div>
      <svg
        ref={chartRef}
        viewBox={`0 0 ${width} ${viewHeight}`}
        width={width}
        height={viewHeight}
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        role="img"
        aria-label={
          `Monthly return heatmap, ${months} months across ${firstYear} to ${lastYear}. ` +
          `Best month ${signedFractionAsPercent(best, 2)}, worst month ${signedFractionAsPercent(worst, 2)}. ` +
          'The right-hand column is each year compounded.'
        }
      >
        {/* ── Column heads ─────────────────────────────────────────────────── */}
        <g aria-hidden>
          {monthHeads.map((head) => (
            <text
              key={head.key}
              x={head.x}
              y={f.y0 - 6}
              textAnchor="middle"
              fontSize={AXIS_TEXT}
              fill={PARCHMENT_FAINT}
              className="tabular"
            >
              {head.label}
            </text>
          ))}
          <text
            x={totalHeadX}
            y={f.y0 - 6}
            textAnchor="middle"
            fontSize={AXIS_TEXT}
            fill={PARCHMENT_FAINT}
            className="tabular"
          >
            YEAR
          </text>
        </g>

        {/* ── Row heads ────────────────────────────────────────────────────── */}
        <g aria-hidden>
          {rows.map((row) => (
            <text
              key={`year-${row.year}`}
              x={f.x0 - 8}
              y={row.y + row.h / 2}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={AXIS_TEXT}
              fill={PARCHMENT_FAINT}
              className="tabular"
            >
              {row.year}
            </text>
          ))}
        </g>

        {/* ── Months with no observation ───────────────────────────────────── */}
        <g aria-hidden>
          {empties.map((cell) => (
            <rect
              key={cell.key}
              x={cell.x}
              y={cell.y}
              width={cell.w}
              height={cell.h}
              fill="none"
              stroke={OBSIDIAN_EDGE}
              strokeOpacity={0.45}
              strokeWidth={1}
            />
          ))}
        </g>

        {/* ── The grid itself. `<title>` carries the exact figure for the cells
               too narrow to caption, which is the mandated fallback. ───────── */}
        {cells.map((cell) => (
          <g key={cell.title}>
            <title>{cell.title}</title>
            <rect x={cell.x} y={cell.y} width={cell.w} height={cell.h} fill={cell.fill} />
            {cell.label ? (
              <text
                x={cell.x + cell.w / 2}
                y={cell.y + cell.h / 2}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={CELL_TEXT}
                fill={PARCHMENT}
                fillOpacity={0.9}
                className="tabular"
                aria-hidden
              >
                {cell.label}
              </text>
            ) : null}
          </g>
        ))}

        {/* ── Compounded annual column, separated by a gap so it never reads as
               a thirteenth month. ─────────────────────────────────────────── */}
        {totals.map((cell) => (
          <g key={cell.key}>
            <title>{cell.title}</title>
            <rect
              x={cell.x}
              y={cell.y}
              width={cell.w}
              height={cell.h}
              fill={cell.fill}
              stroke={OBSIDIAN_EDGE}
              strokeOpacity={0.6}
              strokeWidth={1}
            />
            <text
              x={cell.x + cell.w / 2}
              y={cell.y + cell.h / 2}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={CELL_TEXT}
              fill={PARCHMENT}
              className="tabular"
              aria-hidden
            >
              {cell.label}
            </text>
          </g>
        ))}
      </svg>

      <p className="mt-2.5 text-[0.6875rem] leading-relaxed text-parchment-faint">
        The YEAR column compounds each row — Π(1 + r) − 1 — it is not the sum of the months. Tint is scaled to the
        largest absolute month in the grid; cells narrower than {LABEL_MIN_WIDTH}px drop their label, so hover a cell to
        read the exact figure. An outlined cell means no observation, not a flat month.
      </p>
    </div>
  );
}
