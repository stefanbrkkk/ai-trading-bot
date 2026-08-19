'use client';

/**
 * The primary instrument chart.
 *
 * Phase 1 §4 of the mandate asks this chart to make one argument visually, not in
 * prose: a fixed-σ Bollinger channel is a *lagging* description of volatility,
 * while the Kalman innovation band is an *adaptive* estimate of the latent price
 * level and its uncertainty. So both are drawn on the same axis — the Kalman band
 * as a filled region with its filtered level, the Bollinger channel as two bare
 * dashed rails — and the legend states the contrast rather than leaving the user
 * to infer it. The Bollinger band gets no fill on purpose: fill implies the
 * authoritative envelope, and that role belongs to the filter.
 *
 * Everything here is layout. Bars, bands, levels and VWAP all arrive
 * pre-computed; this component owns no statistics and fetches nothing. The single
 * piece of local state is the crosshair, which is per-pointer, never persisted and
 * never lifted — a cursor position is not application state.
 *
 * The static layers are drawn in one order for one reason: every rule first, then
 * the published level readouts last, each on an opaque plate. Anything drawn after
 * a label crosses it, and these five figures — the entry zone, the invalidation,
 * both targets and VWAP — are the numbers a reader acts on. The collisions that
 * forced it are listed on `levelLabelPlate`.
 */

import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { Bar } from '@/lib/domain/types';
import {
  bandPath,
  bandScale,
  downsample,
  extent,
  frame,
  linePath,
  linearScale,
  niceTicks,
  smoothPath,
  type BandScale,
  type ChartFrame,
  type Point,
  type Scale,
  spreadLabels,
} from '@/lib/ui/svg';
import {
  BURGUNDY,
  BURGUNDY_BRIGHT,
  CHAMPAGNE,
  CHARCOAL,
  GOLD,
  OBSIDIAN_EDGE,
  PARCHMENT,
  PARCHMENT_DIM,
  PARCHMENT_FAINT,
  SAGE,
  SAGE_BRIGHT,
  compact,
  nyDate,
  price,
} from '@/lib/ui/format';
import { EmptyState } from '@/components/ui/primitives';
import { useChartWidth } from './useChartWidth';
import { CHART_SHOWN, CHART_STILL, CHART_VIEWPORT } from './reveal';

/** Volume panel occupies 18% of the chart height. */
const VOLUME_SHARE = 0.18;
const PANEL_GAP = 12;
const GRID_TICKS = 5;
const DATE_LABELS = 6;
const AXIS_TEXT = 9;
const LEVEL_TEXT = 9;
/**
 * Minimum vertical distance between two level labels, handed to `spreadLabels`.
 *
 * Also the ceiling on a label plate's height: the plates are only guaranteed not
 * to overlap each other because every label is at least this far from its
 * neighbour, so a plate that grew past this gap would knock out the label above
 * it — the defect it exists to prevent, reintroduced by the fix. The two numbers
 * have to be read together, so they are defined together.
 */
const LEVEL_LABEL_GAP = LEVEL_TEXT + 3;
/**
 * Advance width of one glyph of the label face, and the padding around a plate.
 *
 * The labels are drawn in JetBrains Mono, whose every glyph — digits, capitals
 * and the en dash in the entry range alike — advances 0.6em, so 9px text is
 * 5.4px per character and the box is exact rather than measured. `useChartWidth`
 * gives this component a width but no text metrics, and a plate sized from a
 * `getBBox()` after paint would be a second layout pass for a rectangle whose
 * size is arithmetic.
 *
 * The padding is 3px rather than 0 so that a fallback face — `ui-monospace`,
 * Menlo — has somewhere to go: the widest label here is 19 characters, so an
 * advance 0.02em wider than JetBrains Mono's overruns by 3.4px, which the
 * padding all but absorbs. It is also small enough that the plate stops 3px
 * short of the plot's right edge, leaving the leader lane at `f.x1 - 2` clear.
 */
const LEVEL_CHAR_PX = LEVEL_TEXT * 0.6;
const LEVEL_PLATE_PAD_X = 3;
/** JetBrains Mono caps and digits stand 0.73em above the baseline. */
const LEVEL_CAP_PX = LEVEL_TEXT * 0.73;
/** Clearance above the cap line and below the baseline on a label plate. */
const LEVEL_PLATE_PAD_Y = 2.2;
/** Above this many bars the monotone cubic is invisible and just costs DOM. */
const SMOOTH_LIMIT = 120;

export interface KalmanBandPoint {
  time: number;
  level: number;
  upper: number;
  lower: number;
}

export interface BollingerPoint {
  time: number;
  upper: number;
  middle: number;
  lower: number;
}

export interface SignalLevels {
  entryZoneLow: number;
  entryZoneHigh: number;
  invalidation: number;
  target1: number;
  target2: number;
}

export interface PriceChartProps {
  bars: Bar[];
  kalmanBand?: KalmanBandPoint[];
  bollinger?: BollingerPoint[];
  levels?: SignalLevels;
  vwap?: number;
  /** viewBox width used for layout. The rendered size is the container's. */
  width?: number;
  height?: number;
  showVolume?: boolean;
  mode?: 'candles' | 'line';
}

interface Candle {
  x: number;
  w: number;
  centre: number;
  bodyY: number;
  bodyH: number;
  wickTop: number;
  wickBottom: number;
  colour: string;
}

interface VolumeBar {
  x: number;
  w: number;
  y: number;
  h: number;
  colour: string;
}

/**
 * A published level: a dashed rule at a price, with its figure beside it.
 *
 * `colour` draws the rule and `textColour` draws the label, because the two have
 * different contrast obligations. A 1px dashed line is a non-text graphic and
 * clears WCAG at 3:1; a 9px price label is body text and needs 4.5:1. Painting
 * both from one token put `INVALIDATION 148.83` on screen at 2.35:1 and the two
 * target prices at 3.40:1 — the invalidation price, unreadable, on the chart the
 * whole page is about. Every other chart here already draws text from the
 * `_BRIGHT` tokens; this was the one that did not.
 *
 * Those ratios are against the panel the chart sits on. The labels now sit on a
 * plate of their own instead — see `levelLabelPlate` — where each is a little
 * higher again.
 */
interface LevelMark {
  /** Where the line is drawn — the price. */
  y: number;
  /** Where the text is drawn, after de-collision. Set during layout. */
  labelY: number;
  label: string;
  colour: string;
  /** Label fill. Brighter than `colour`: text needs 4.5:1, a rule needs 3:1. */
  textColour: string;
  dash?: string;
}

interface Layout {
  f: ChartFrame;
  shown: Bar[];
  band: BandScale;
  centre: (index: number) => number;
  yPrice: Scale;
  priceY0: number;
  priceY1: number;
  volY0: number;
  volY1: number;
  showVolumePanel: boolean;
  gridTicks: number[];
  kalmanBandD: string;
  kalmanLevelD: string;
  bollingerUpperD: string;
  bollingerLowerD: string;
  candles: Candle[];
  volumes: VolumeBar[];
  priceLineD: string;
  dateLabels: { x: number; label: string; anchor: 'start' | 'middle' | 'end' }[];
  levelMarks: LevelMark[];
  entryZone: { y: number; height: number } | null;
  vwapY: number | null;
}

function isDrawable(bar: Bar | undefined): bar is Bar {
  return (
    !!bar &&
    Number.isFinite(bar.time) &&
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close)
  );
}

function traced(points: readonly Point[]): string {
  if (points.length === 0) return '';
  return points.length <= SMOOTH_LIMIT ? smoothPath(points) : linePath(points);
}

/** The opaque rectangle painted under a level label, in viewBox units. */
export interface LabelPlate {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The plate that knocks a level label out of everything drawn beneath it.
 *
 * `spreadLabels` separates the labels from each *other*, and that was read as
 * having solved collision. It had not: the rules stayed where the prices put
 * them while the text moved, so every label was pushed onto some neighbouring
 * horizontal, and the labels were painted straight onto the plot with nothing
 * behind them. On AAPL's published levels, at every width — the geometry is
 * width-independent, since the height is fixed and the viewBox scales uniformly:
 *
 *   T1 131.83            struck by its own sage rule 2.5px above the baseline,
 *                        38% of the way up the digits
 *   T2 124.16            its own rule across the cap line, a grid rule at the feet
 *   ENTRY 140.60–142.80  the champagne VWAP rule at the baseline and the gold
 *                        entry band through the lower half of the glyphs
 *   VWAP 140.85          the burgundy INVALIDATION rule through the upper fifth
 *   INVALIDATION 148.28  clear of every rule, printed over red candle bodies
 *
 * These are the five numbers a reader acts on. So each is given a plate in the
 * panel surface colour before its glyphs are drawn, and the whole label block is
 * painted after every rule (see the render below) so that no rule can land on
 * top of one either.
 *
 * `anchor` mirrors the `text-anchor` of the label it backs — the level readouts
 * end at the right edge of the plot, VWAP starts at the left — and `baseline` is
 * the text's own `y`. The box is sized from the mono advance rather than
 * measured; see `LEVEL_CHAR_PX`.
 */
export function levelLabelPlate(
  label: string,
  x: number,
  baseline: number,
  anchor: 'start' | 'end',
): LabelPlate {
  const text = label.length * LEVEL_CHAR_PX;
  return {
    x: (anchor === 'end' ? x - text : x) - LEVEL_PLATE_PAD_X,
    y: baseline - LEVEL_CAP_PX - LEVEL_PLATE_PAD_Y,
    width: text + 2 * LEVEL_PLATE_PAD_X,
    height: LEVEL_CAP_PX + 2 * LEVEL_PLATE_PAD_Y,
  };
}

function computeLayout(props: PriceChartProps): Layout | null {
  const {
    bars,
    kalmanBand,
    bollinger,
    levels,
    vwap,
    width = 920,
    height = 380,
    showVolume = true,
    mode = 'candles',
  } = props;

  const clean = (Array.isArray(bars) ? bars : []).filter(isDrawable);
  if (clean.length === 0) return null;

  const f = frame(width, height, { top: 14, right: 54, bottom: 22, left: 10 });
  if (f.innerWidth <= 0 || f.innerHeight <= 0) return null;

  // At most two points per pixel: past that, LTTB is drawing detail no display can
  // resolve while inflating the DOM. Downsampling on (index, close) keeps the
  // selected *bars* rather than synthesising new ones, so the candles stay real.
  const maxPoints = Math.max(3, Math.round(f.innerWidth * 2));
  const shown =
    clean.length <= maxPoints
      ? clean
      : downsample(
          clean.map((bar, i) => ({ x: i, y: bar.close })),
          maxPoints,
        )
          .map((p) => clean[p.x])
          .filter(isDrawable);
  if (shown.length === 0) return null;

  const showVolumePanel = showVolume && f.innerHeight * VOLUME_SHARE > 8;
  const volumeH = showVolumePanel ? f.innerHeight * VOLUME_SHARE : 0;
  const priceY0 = f.y0;
  const priceY1 = Math.max(priceY0 + 1, f.y1 - (showVolumePanel ? volumeH + PANEL_GAP : 0));
  const volY0 = f.y1 - volumeH;
  const volY1 = f.y1;

  const band = bandScale(shown.length, [f.x0, f.x1], 0.28);
  const centre = (index: number): number => band(index) + band.bandwidth / 2;

  // Overlays are matched to bars by timestamp, not by position: after
  // downsampling the two series no longer share an index, and a positional join
  // would silently shear the band away from the price it describes.
  const indexByTime = new Map<number, number>();
  shown.forEach((bar, i) => indexByTime.set(bar.time, i));

  const kalman = (Array.isArray(kalmanBand) ? kalmanBand : []).filter((p) => indexByTime.has(p.time));
  const bolls = (Array.isArray(bollinger) ? bollinger : []).filter((p) => indexByTime.has(p.time));

  const domainValues: number[] = [];
  for (const bar of shown) domainValues.push(bar.high, bar.low);
  for (const p of kalman) domainValues.push(p.upper, p.lower);
  for (const p of bolls) domainValues.push(p.upper, p.lower);
  if (levels) {
    domainValues.push(levels.entryZoneLow, levels.entryZoneHigh, levels.invalidation, levels.target1, levels.target2);
  }
  if (Number.isFinite(vwap)) domainValues.push(vwap as number);

  const yPrice = linearScale(extent(domainValues, 0.06), [priceY1, priceY0]);

  const project = <T,>(rows: T[], pick: (row: T) => number, key: (row: T) => number): Point[] => {
    const out: Point[] = [];
    for (const row of rows) {
      const index = indexByTime.get(key(row));
      const value = pick(row);
      if (index === undefined || !Number.isFinite(value)) continue;
      out.push({ x: centre(index), y: yPrice(value) });
    }
    return out;
  };

  const kUpper = project(kalman, (p) => p.upper, (p) => p.time);
  const kLower = project(kalman, (p) => p.lower, (p) => p.time);
  const kLevel = project(kalman, (p) => p.level, (p) => p.time);
  const smooth = kUpper.length <= SMOOTH_LIMIT;

  const candles: Candle[] = [];
  if (mode === 'candles') {
    for (let i = 0; i < shown.length; i += 1) {
      const bar = shown[i] as Bar;
      const openY = yPrice(bar.open);
      const closeY = yPrice(bar.close);
      const top = Math.min(openY, closeY);
      candles.push({
        x: band(i),
        w: band.bandwidth,
        centre: centre(i),
        bodyY: top,
        // A doji has zero body height; 1px keeps it visible instead of vanishing.
        bodyH: Math.max(1, Math.abs(closeY - openY)),
        wickTop: yPrice(bar.high),
        wickBottom: yPrice(bar.low),
        colour: bar.close >= bar.open ? SAGE : BURGUNDY,
      });
    }
  }

  const volumes: VolumeBar[] = [];
  if (showVolumePanel) {
    let maxVolume = 0;
    for (const bar of shown) if (Number.isFinite(bar.volume)) maxVolume = Math.max(maxVolume, bar.volume);
    const yVolume = linearScale([0, maxVolume > 0 ? maxVolume : 1], [volY1, volY0]);
    for (let i = 0; i < shown.length; i += 1) {
      const bar = shown[i] as Bar;
      const volume = Number.isFinite(bar.volume) ? Math.max(0, bar.volume) : 0;
      const top = yVolume(volume);
      volumes.push({
        x: band(i),
        w: band.bandwidth,
        y: top,
        h: Math.max(0, volY1 - top),
        colour: bar.close >= bar.open ? SAGE : BURGUNDY,
      });
    }
  }

  /*
   * The number of date labels is bounded by the width, not fixed.
   *
   * A constant five labels means five "Mar 13, 2026" strings — about 70px each —
   * on a 308px mobile chart, so consecutive dates overlapped by up to 44px. One
   * label per ~90px keeps them apart at every width and still gives the desktop
   * chart its full set.
   */
  const labelCount = Math.max(2, Math.min(DATE_LABELS, shown.length, Math.floor(f.innerWidth / 90)));
  const step = labelCount <= 1 ? 0 : (shown.length - 1) / (labelCount - 1);
  const seen = new Set<number>();
  const dateLabels: Layout['dateLabels'] = [];
  for (let k = 0; k < labelCount; k += 1) {
    const index = Math.round(k * step);
    if (seen.has(index)) continue;
    seen.add(index);
    const bar = shown[index] as Bar;
    dateLabels.push({
      x: centre(index),
      label: nyDate(bar.time),
      anchor: index === 0 ? 'start' : index === shown.length - 1 ? 'end' : 'middle',
    });
  }

  const levelMarks: LevelMark[] = [];
  let entryZone: Layout['entryZone'] = null;
  if (levels) {
    if (Number.isFinite(levels.invalidation)) {
      levelMarks.push({ y: yPrice(levels.invalidation), labelY: yPrice(levels.invalidation), label: `INVALIDATION ${price(levels.invalidation)}`, colour: BURGUNDY, textColour: BURGUNDY_BRIGHT, dash: '5 4' });
    }
    if (Number.isFinite(levels.target1)) {
      levelMarks.push({ y: yPrice(levels.target1), labelY: yPrice(levels.target1), label: `T1 ${price(levels.target1)}`, colour: SAGE, textColour: SAGE_BRIGHT, dash: '5 4' });
    }
    if (Number.isFinite(levels.target2)) {
      levelMarks.push({ y: yPrice(levels.target2), labelY: yPrice(levels.target2), label: `T2 ${price(levels.target2)}`, colour: SAGE, textColour: SAGE_BRIGHT, dash: '5 4' });
    }
    if (Number.isFinite(levels.entryZoneLow) && Number.isFinite(levels.entryZoneHigh)) {
      const a = yPrice(levels.entryZoneHigh);
      const b = yPrice(levels.entryZoneLow);
      const top = Math.min(a, b);
      entryZone = { y: top, height: Math.max(1, Math.abs(b - a)) };
      levelMarks.push({
        y: top,
        labelY: top,
        label: `ENTRY ${price(Math.min(levels.entryZoneLow, levels.entryZoneHigh))}–${price(Math.max(levels.entryZoneLow, levels.entryZoneHigh))}`,
        colour: GOLD,
        // Gold measures 8.76:1 on the plate the labels are drawn on; it is the
        // reference the `_BRIGHT` tokens exist to reach, not an exception to it.
        textColour: GOLD,
      });
    }
  }

  /*
   * Label positions are separated from line positions.
   *
   * The four level lines are wherever the prices put them, and on a name whose
   * entry zone sits just above its invalidation they were three pixels apart —
   * so "INVALIDATION 136.29" and "ENTRY 141.52–143.60" printed straight through
   * each other, 103px of overlap on a 1298px chart. The lines stay exactly where
   * the prices are; only the text is pushed apart, and each label keeps a leader
   * to the line it belongs to.
   *
   * Which is also why the labels need plates. Moving the text off its own line
   * moves it onto somebody else's — a neighbouring level, the VWAP rule, a grid
   * line — so label-from-label separation is only half of the problem and
   * `levelLabelPlate` is the other half.
   */
  const labelYs = spreadLabels(
    levelMarks.map((mark) => mark.y),
    LEVEL_LABEL_GAP,
    priceY0 + LEVEL_TEXT,
    priceY1,
  );
  levelMarks.forEach((mark, i) => {
    mark.labelY = labelYs[i] as number;
  });

  return {
    f,
    shown,
    band,
    centre,
    yPrice,
    priceY0,
    priceY1,
    volY0,
    volY1,
    showVolumePanel,
    gridTicks: niceTicks(yPrice.domain, GRID_TICKS),
    kalmanBandD: kUpper.length > 1 && kLower.length > 1 ? bandPath(kUpper, kLower, smooth) : '',
    kalmanLevelD: traced(kLevel),
    bollingerUpperD: linePath(project(bolls, (p) => p.upper, (p) => p.time)),
    bollingerLowerD: linePath(project(bolls, (p) => p.lower, (p) => p.time)),
    candles,
    volumes,
    priceLineD: mode === 'line' ? traced(shown.map((bar, i) => ({ x: centre(i), y: yPrice(bar.close) }))) : '',
    dateLabels,
    levelMarks,
    entryZone,
    vwapY: Number.isFinite(vwap) ? yPrice(vwap as number) : null,
  };
}

interface Cursor {
  index: number;
  y: number;
}

export function PriceChart(props: PriceChartProps) {
  const { bars, kalmanBand, bollinger, levels, showVolume, width: widthFallback = 920, height = 380, vwap, mode = 'candles' } = props;
  const { ref: chartRef, width } = useChartWidth(widthFallback);
  const reduceMotion = useReducedMotion();
  const [cursor, setCursor] = useState<Cursor | null>(null);

  // Keyed on the individual props rather than the props object, whose identity
  // changes on every parent render and would defeat the memo entirely.
  const layout = useMemo(
    () => computeLayout({ bars, kalmanBand, bollinger, levels, vwap, width, height, showVolume, mode }),
    [bars, kalmanBand, bollinger, levels, vwap, width, height, showVolume, mode],
  );

  if (!layout) {
    return (
      <EmptyState
        title="No price history"
        detail="This symbol has no drawable bars for the selected timeframe. Nothing is inferred from an empty series."
      />
    );
  }

  const {
    f,
    shown,
    band,
    centre,
    yPrice,
    priceY0,
    priceY1,
    volY0,
    volY1,
    showVolumePanel,
    gridTicks,
    kalmanBandD,
    kalmanLevelD,
    bollingerUpperD,
    bollingerLowerD,
    candles,
    volumes,
    priceLineD,
    dateLabels,
    levelMarks,
    entryZone,
    vwapY,
  } = layout;

  const firstBar = shown[0] as Bar;
  const lastBar = shown[shown.length - 1] as Bar;

  const hasKalman = kalmanBandD.length > 0 || kalmanLevelD.length > 0;
  const hasBollinger = bollingerUpperD.length > 0 || bollingerLowerD.length > 0;

  const clampIndex = (index: number): number => Math.max(0, Math.min(shown.length - 1, index));

  const moveCursor = (clientX: number, clientY: number, element: SVGRectElement): void => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || band.step <= 0) return;
    // The SVG is scaled by the container, so client pixels have to be mapped back
    // through the viewBox before they mean anything in chart space.
    const viewX = f.x0 + ((clientX - rect.left) / rect.width) * f.innerWidth;
    const viewY = priceY0 + ((clientY - rect.top) / rect.height) * (f.y1 - priceY0);
    const index = clampIndex(Math.floor((viewX - f.x0) / band.step));
    if (!Number.isFinite(index)) return;
    setCursor({ index, y: Math.max(priceY0, Math.min(priceY1, viewY)) });
  };

  const stepCursor = (delta: number): void => {
    setCursor((current) => {
      const index = clampIndex((current?.index ?? shown.length - 1) + delta);
      const bar = shown[index] as Bar;
      return { index, y: yPrice(bar.close) };
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<SVGRectElement>): void => {
    const jump = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowLeft') stepCursor(-jump);
    else if (event.key === 'ArrowRight') stepCursor(jump);
    else if (event.key === 'Home') stepCursor(-shown.length);
    else if (event.key === 'End') stepCursor(shown.length);
    else if (event.key === 'Escape') setCursor(null);
    else return;
    event.preventDefault();
  };

  const hoveredBar = cursor && cursor.index < shown.length ? (shown[cursor.index] as Bar) : null;
  const cursorX = cursor ? centre(clampIndex(cursor.index)) : 0;
  // The readout sits opposite the pointer so it never covers the bar being read.
  const readoutOnRight = cursorX < (f.x0 + f.x1) / 2;

  // VWAP is a published level like the other four, so its rule and its readout
  // join the two-pass draw below rather than being one self-contained group.
  const vwapShown = vwapY !== null && vwapY >= priceY0 && vwapY <= priceY1;
  const vwapBaseline = (vwapY ?? 0) - 3;
  const vwapLabel = vwapShown ? `VWAP ${price(vwap as number)}` : '';
  const vwapPlate = levelLabelPlate(vwapLabel, f.x0 + 2, vwapBaseline, 'start');
  const drawnMarks = levelMarks.filter((mark) => mark.y >= priceY0 - 0.5 && mark.y <= priceY1 + 0.5);

  return (
    <div className="relative">
      {/* The legend carries the Phase 1 §4 argument; it is chrome, so it is HTML. */}
      {hasKalman || hasBollinger || vwapY !== null ? (
        <div className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[0.6875rem] leading-none text-parchment-faint">
          {hasKalman ? (
            <span className="inline-flex items-center gap-1.5">
              <svg width={16} height={8} viewBox="0 0 16 8" aria-hidden className="shrink-0">
                <rect x={0} y={0} width={16} height={8} fill={GOLD} fillOpacity={0.07} />
                <line x1={0} x2={16} y1={4} y2={4} stroke={GOLD} strokeOpacity={0.35} strokeWidth={1} />
              </svg>
              Kalman innovation band — adaptive, re-estimated each bar
            </span>
          ) : null}
          {hasBollinger ? (
            <span className="inline-flex items-center gap-1.5">
              <svg width={16} height={8} viewBox="0 0 16 8" aria-hidden className="shrink-0">
                <line x1={0} x2={16} y1={1.5} y2={1.5} stroke={PARCHMENT_FAINT} strokeWidth={1} strokeDasharray="3 3" />
                <line x1={0} x2={16} y1={6.5} y2={6.5} stroke={PARCHMENT_FAINT} strokeWidth={1} strokeDasharray="3 3" />
              </svg>
              Bollinger channel — fixed σ, lags the regime it measures
            </span>
          ) : null}
          {vwapY !== null ? (
            <span className="inline-flex items-center gap-1.5">
              <svg width={16} height={8} viewBox="0 0 16 8" aria-hidden className="shrink-0">
                <line x1={0} x2={16} y1={4} y2={4} stroke={CHAMPAGNE} strokeWidth={1} strokeDasharray="1 3" />
              </svg>
              VWAP
            </span>
          ) : null}
        </div>
      ) : null}

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
        aria-label={`${mode === 'line' ? 'Price line' : 'Candlestick'} chart, ${shown.length} bars from ${nyDate(firstBar.time)} to ${nyDate(lastBar.time)}, last close ${price(lastBar.close)}`}
      >
        {/* ── 1. Grid and right-hand price axis ────────────────────────────── */}
        <g aria-hidden>
          {gridTicks.map((tick) => {
            const y = yPrice(tick);
            if (y < priceY0 - 0.5 || y > priceY1 + 0.5) return null;
            return (
              <g key={`grid-${tick}`}>
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
                <text x={f.x1 + 6} y={y} dominantBaseline="middle" fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT} className="tabular">
                  {price(tick)}
                </text>
              </g>
            );
          })}
        </g>

        {/* ── 2. Kalman innovation band ────────────────────────────────────── */}
        {kalmanBandD ? (
          <motion.path
            d={kalmanBandD}
            fill={GOLD}
            fillOpacity={0.07}
            stroke="none"
            variants={{ [CHART_STILL]: { opacity: 0 }, [CHART_SHOWN]: { opacity: 1 } }}
            transition={{ duration: reduceMotion ? 0 : 0.6, ease: [0.16, 1, 0.3, 1] }}
            aria-hidden
          />
        ) : null}
        {kalmanLevelD ? (
          <motion.path
            d={kalmanLevelD}
            fill="none"
            stroke={GOLD}
            strokeOpacity={0.35}
            strokeWidth={1}
            variants={{ [CHART_STILL]: { pathLength: 0 }, [CHART_SHOWN]: { pathLength: 1 } }}
            transition={{ duration: reduceMotion ? 0 : 0.9, ease: [0.16, 1, 0.3, 1] }}
            aria-hidden
          />
        ) : null}

        {/* ── 3. Bollinger rails: two dashed lines, no fill (see file header) ─ */}
        {bollingerUpperD ? (
          <path
            d={bollingerUpperD}
            fill="none"
            stroke={PARCHMENT_FAINT}
            strokeOpacity={0.7}
            strokeWidth={1}
            strokeDasharray="3 3"
            aria-hidden
          />
        ) : null}
        {bollingerLowerD ? (
          <path
            d={bollingerLowerD}
            fill="none"
            stroke={PARCHMENT_FAINT}
            strokeOpacity={0.7}
            strokeWidth={1}
            strokeDasharray="3 3"
            aria-hidden
          />
        ) : null}

        {/* ── 4. Price: candles or a single close line ─────────────────────── */}
        {mode === 'candles' ? (
          <g aria-hidden>
            {candles.map((candle, i) => (
              <g key={`candle-${i}`}>
                <line
                  x1={candle.centre}
                  x2={candle.centre}
                  y1={candle.wickTop}
                  y2={candle.wickBottom}
                  stroke={candle.colour}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <rect x={candle.x} y={candle.bodyY} width={candle.w} height={candle.bodyH} fill={candle.colour} />
              </g>
            ))}
          </g>
        ) : (
          <motion.path
            d={priceLineD}
            fill="none"
            stroke={PARCHMENT}
            strokeWidth={1.25}
            strokeLinejoin="round"
            variants={{ [CHART_STILL]: { pathLength: 0 }, [CHART_SHOWN]: { pathLength: 1 } }}
            transition={{ duration: reduceMotion ? 0 : 0.9, ease: [0.16, 1, 0.3, 1] }}
            aria-hidden
          />
        )}

        {/* ── 5. Signal level rules, and the VWAP rule ─────────────────────── */}
        {entryZone ? (
          <rect x={f.x0} y={entryZone.y} width={f.innerWidth} height={entryZone.height} fill={GOLD} fillOpacity={0.1} aria-hidden />
        ) : null}
        <g aria-hidden>
          {drawnMarks.map((mark) => (
            <g key={mark.label}>
              {mark.dash ? (
                <line
                  x1={f.x0}
                  x2={f.x1}
                  y1={mark.y}
                  y2={mark.y}
                  stroke={mark.colour}
                  strokeWidth={1}
                  strokeDasharray={mark.dash}
                  shapeRendering="crispEdges"
                />
              ) : null}
              {Math.abs(mark.labelY - mark.y) > 1 ? (
                /*
                 * The label was moved off its line, so a leader says which line
                 * it names. It runs down the lane between the plate's right edge
                 * and the plot's, so the label pass below cannot bury it.
                 */
                <line
                  x1={f.x1 - 2}
                  x2={f.x1 - 2}
                  y1={mark.y}
                  y2={mark.labelY - 3}
                  stroke={mark.colour}
                  strokeWidth={1}
                  strokeOpacity={0.5}
                />
              ) : null}
            </g>
          ))}
          {vwapShown ? (
            <line
              x1={f.x0}
              x2={f.x1}
              y1={vwapY as number}
              y2={vwapY as number}
              stroke={CHAMPAGNE}
              strokeOpacity={0.8}
              strokeWidth={1}
              strokeDasharray="1 3"
              shapeRendering="crispEdges"
            />
          ) : null}
        </g>

        {/*
          ── 6. The level readouts ───────────────────────────────────────────

          Last of the static layers, and each on its own opaque plate, so that
          neither a rule drawn earlier nor a candle behind it can cross a
          published price. Splitting the labels out of their marks is what makes
          the paint order right: drawn inside the mark groups above, every rule
          after the first was painted over the label before it — the VWAP dashes
          across ENTRY, the burgundy invalidation rule across VWAP — and no
          amount of plating fixes something drawn on top. `levelLabelPlate`
          carries the measured collisions.

          The labels sit inside the right edge of the plot rather than beyond it:
          the right margin already belongs to the price axis, and overlapping the
          two would make both unreadable. VWAP keeps the left edge, which is the
          one place a fifth label can go without joining that column.

          The plate is `CHARCOAL`, the plinth's lower gradient stop. By the level
          block the gradient has run most of the way there — #181818, which is
          what the ratios in `LevelMark` were measured against — so the plate is
          four 8-bit levels darker than what surrounds it, and reads as a faint
          chip rather than a seam. It raises every label's contrast slightly
          rather than lowering it: burgundy-bright 5.16:1 to 5.35:1, sage-bright
          6.20 to 6.44, gold 8.44 to 8.76, champagne 14.61 to 15.16.
        */}
        <g aria-hidden>
          {drawnMarks.map((mark) => {
            const baseline = mark.labelY - 3;
            const plate = levelLabelPlate(mark.label, f.x1 - 6, baseline, 'end');
            return (
              <g key={mark.label}>
                <rect x={plate.x} y={plate.y} width={plate.width} height={plate.height} fill={CHARCOAL} />
                <text
                  x={f.x1 - 6}
                  y={baseline}
                  textAnchor="end"
                  fontSize={LEVEL_TEXT}
                  fill={mark.textColour}
                  className="tabular"
                >
                  {mark.label}
                </text>
              </g>
            );
          })}
          {vwapShown ? (
            <>
              <rect
                x={vwapPlate.x}
                y={vwapPlate.y}
                width={vwapPlate.width}
                height={vwapPlate.height}
                fill={CHARCOAL}
              />
              <text
                x={f.x0 + 2}
                y={vwapBaseline}
                fontSize={LEVEL_TEXT}
                fill={CHAMPAGNE}
                fillOpacity={0.8}
                className="tabular"
              >
                {vwapLabel}
              </text>
            </>
          ) : null}
        </g>

        {/* ── 7. Volume panel ──────────────────────────────────────────────── */}
        {showVolumePanel ? (
          <g aria-hidden>
            <line
              x1={f.x0}
              x2={f.x1}
              y1={volY1}
              y2={volY1}
              stroke={OBSIDIAN_EDGE}
              strokeOpacity={0.45}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            {volumes.map((bar, i) => (
              <rect key={`vol-${i}`} x={bar.x} y={bar.y} width={bar.w} height={bar.h} fill={bar.colour} fillOpacity={0.5} />
            ))}
            <text x={f.x0 + 2} y={volY0 - 3} fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT} className="tabular">
              VOLUME
            </text>
          </g>
        ) : null}

        {/* ── X axis ───────────────────────────────────────────────────────── */}
        <g aria-hidden>
          {dateLabels.map((label) => (
            <text
              key={`${label.label}-${label.x}`}
              x={label.x}
              y={f.y1 + 13}
              textAnchor={label.anchor}
              fontSize={AXIS_TEXT}
              fill={PARCHMENT_FAINT}
              className="tabular"
            >
              {label.label}
            </text>
          ))}
        </g>

        {/* ── Crosshair ────────────────────────────────────────────────────── */}
        {cursor && hoveredBar ? (
          <g aria-hidden>
            <line
              x1={cursorX}
              x2={cursorX}
              y1={priceY0}
              y2={f.y1}
              stroke={PARCHMENT_DIM}
              strokeOpacity={0.5}
              strokeWidth={1}
              strokeDasharray="2 3"
              shapeRendering="crispEdges"
            />
            <line
              x1={f.x0}
              x2={f.x1}
              y1={cursor.y}
              y2={cursor.y}
              stroke={PARCHMENT_DIM}
              strokeOpacity={0.5}
              strokeWidth={1}
              strokeDasharray="2 3"
              shapeRendering="crispEdges"
            />
            <circle cx={cursorX} cy={yPrice(hoveredBar.close)} r={2} fill={PARCHMENT} />
            <text x={f.x1 + 6} y={cursor.y} dominantBaseline="middle" fontSize={AXIS_TEXT} fill={PARCHMENT} className="tabular">
              {price(yPrice.invert(cursor.y))}
            </text>
          </g>
        ) : null}

        {/* Pointer/keyboard target. Focus reveals the crosshair, which is itself
            the focus indicator; Escape and blur dismiss it. */}
        <rect
          x={f.x0}
          y={priceY0}
          width={f.innerWidth}
          height={Math.max(1, f.y1 - priceY0)}
          fill="transparent"
          className="cursor-crosshair"
          tabIndex={0}
          role="slider"
          aria-label="Bar inspector. Arrow keys step through bars, Escape dismisses."
          aria-valuemin={0}
          aria-valuemax={shown.length - 1}
          aria-valuenow={cursor ? clampIndex(cursor.index) : 0}
          aria-valuetext={
            hoveredBar
              ? `${nyDate(hoveredBar.time)}: open ${price(hoveredBar.open)}, high ${price(hoveredBar.high)}, low ${price(hoveredBar.low)}, close ${price(hoveredBar.close)}, volume ${compact(hoveredBar.volume)}`
              : undefined
          }
          onPointerMove={(event) => moveCursor(event.clientX, event.clientY, event.currentTarget)}
          onPointerDown={(event) => moveCursor(event.clientX, event.clientY, event.currentTarget)}
          onPointerLeave={() => setCursor(null)}
          onFocus={() => stepCursor(0)}
          onBlur={() => setCursor(null)}
          onKeyDown={onKeyDown}
        />
      </motion.svg>

      {cursor && hoveredBar ? (
        <div
          className={`glass pointer-events-none absolute top-1 z-10 min-w-[9.5rem] px-3 py-2 ${readoutOnRight ? 'right-1' : 'left-1'}`}
          // The same content reaches assistive tech through the inspector's
          // aria-valuetext; announcing it twice is noise.
          aria-hidden
        >
          <p className="eyebrow mb-1.5">{nyDate(hoveredBar.time)}</p>
          <dl className="space-y-0.5 text-[0.6875rem] leading-tight">
            {(
              [
                ['O', price(hoveredBar.open)],
                ['H', price(hoveredBar.high)],
                ['L', price(hoveredBar.low)],
                ['C', price(hoveredBar.close)],
                ['V', compact(hoveredBar.volume)],
              ] as const
            ).map(([key, value]) => (
              <div key={key} className="flex items-baseline justify-between gap-3">
                <dt className="text-parchment-faint">{key}</dt>
                <dd className="tabular text-parchment">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
