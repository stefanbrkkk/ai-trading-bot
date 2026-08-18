'use client';

/**
 * The Temporal Fusion Transformer's interpretability output.
 *
 * The TFT is in the stack precisely because it publishes *why* it looked where it
 * looked: interpretable multi-head attention over the input sequence, and variable
 * selection weights over the inputs. Both are the model's own explanation of its
 * forecast, so both are rendered — attention as a heat row (which timesteps the
 * macro agent actually attended to) and variable selection as a ranked bar list
 * (which inputs it let through the gate).
 *
 * Each strip states its normalisation in its caption. A heat strip with no stated
 * scale is not an explanation: the reader cannot tell a 0.9 cell from a 0.09 cell
 * when both are "gold, fairly bright", and opacity is not self-labelling. So the
 * captions name the softmax and the peak the opacity is divided by, and the argmax
 * cell is outlined and labelled outright — the single most-attended timestep is the
 * one fact a reader takes away from this row.
 *
 * The bars reuse `FeatureBars` rather than re-drawing them. Its unsigned mode is
 * already the mandated grammar for "attention weights, variable-selection weights,
 * agent shares", and a second, near-identical bar implementation would be a second
 * thing to keep in visual sync.
 */

import { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { bandScale } from '@/lib/ui/svg';
import {
  GOLD,
  GOLD_BRIGHT,
  OBSIDIAN_EDGE,
  PARCHMENT_DIM,
  PARCHMENT_FAINT,
  fractionAsPercent,
  truncate,
} from '@/lib/ui/format';
import { EmptyState } from '@/components/ui/primitives';
import { FeatureBars, type FeatureBarItem } from '@/components/charts/FeatureBars';
import { useChartWidth } from './useChartWidth';
import { CHART_SHOWN, CHART_STILL, CHART_VIEWPORT } from './reveal';

const AXIS_TEXT = 9;
/** Server-render fallback; the rendered width is measured — see `useChartWidth`. */
const VIEW_WIDTH = 520;
/** Rows above and below the cells: argmax caption, then the sequence ends. */
const TOP_LABEL_ROW = 12;
const BOTTOM_LABEL_ROW = 13;
const LABEL_CHARS = 16;

export interface AttentionStripProps {
  /** Attention weights, oldest → newest. Softmax output, so they sum to 1. */
  attention: number[];
  /** Variable-selection weights, also a softmax over the input set. */
  variableWeights?: { key: string; label: string; weight: number }[];
  /** Optional timestep captions, aligned to `attention`. */
  sequenceLabels?: string[];
  /** viewBox height of the heat strip. */
  height?: number;
  /** Server-render fallback width; the rendered width is measured. */
  width?: number;
}

interface Cell {
  index: number;
  x: number;
  width: number;
  weight: number;
  /** weight ÷ peak weight — the quantity opacity encodes. */
  share: number;
  label: string;
}

interface StripLayout {
  cells: Cell[];
  argmax: Cell | null;
  peak: number;
  cellY: number;
  cellHeight: number;
  viewHeight: number;
}

function buildStrip(
  attention: readonly number[],
  sequenceLabels: readonly string[] | undefined,
  height: number,
): StripLayout | null {
  const weights = (Array.isArray(attention) ? attention : []).map((w) => (Number.isFinite(w) ? w : 0));
  if (weights.length === 0) return null;

  const viewHeight = Math.max(TOP_LABEL_ROW + 14 + BOTTOM_LABEL_ROW, height);
  const cellY = TOP_LABEL_ROW;
  const cellHeight = Math.max(8, viewHeight - TOP_LABEL_ROW - BOTTOM_LABEL_ROW);

  const band = bandScale(weights.length, [0, VIEW_WIDTH], weights.length > 60 ? 0.04 : 0.12);

  // An all-zero or all-equal attention vector is a real state — a freshly
  // initialised head, or a sequence the model found uninformative — and dividing by
  // its peak would write NaN into every opacity.
  let peak = 0;
  for (const w of weights) peak = Math.max(peak, w);
  const divisor = peak > 0 ? peak : 1;

  let argmaxIndex = 0;
  for (let i = 1; i < weights.length; i += 1) {
    if ((weights[i] as number) > (weights[argmaxIndex] as number)) argmaxIndex = i;
  }

  const cells: Cell[] = weights.map((weight, index) => ({
    index,
    x: band(index),
    width: band.bandwidth,
    weight,
    share: weight / divisor,
    // Absent captions fall back to the model's own indexing: t−0 is the newest step.
    label: sequenceLabels?.[index] ?? `t−${weights.length - 1 - index}`,
  }));

  return {
    cells,
    argmax: peak > 0 ? (cells[argmaxIndex] as Cell) : null,
    peak,
    cellY,
    cellHeight,
    viewHeight,
  };
}

export function AttentionStrip({
  attention,
  variableWeights,
  sequenceLabels,
  height = 52,
  width: widthFallback = VIEW_WIDTH,
}: AttentionStripProps) {
  const { ref: chartRef, width: VIEW_WIDTH_LOCAL } = useChartWidth(widthFallback);
  const reduceMotion = useReducedMotion();
  const strip = useMemo(() => buildStrip(attention, sequenceLabels, height), [attention, sequenceLabels, height]);

  const bars = useMemo<FeatureBarItem[]>(() => {
    const rows = (Array.isArray(variableWeights) ? variableWeights : []).filter(
      (row) => row && Number.isFinite(row.weight),
    );
    // Ranked, because a variable-selection vector is read as an ordering. The input
    // order is the feature-matrix order, which carries no meaning for the reader.
    return rows
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .map((row) => ({
        key: row.key,
        label: row.label,
        value: row.weight,
        hint: `${row.label}: ${fractionAsPercent(row.weight, 1)} of the variable-selection weight`,
      }));
  }, [variableWeights]);

  if (!strip && bars.length === 0) {
    return (
      <EmptyState
        title="No interpretability output"
        detail="This inference published no attention or variable-selection weights — the agent on watch is not a TFT."
      />
    );
  }

  return (
    <div className="space-y-4">
      {strip ? (
        <div>
          <motion.svg
            ref={chartRef}
            initial={reduceMotion ? CHART_SHOWN : CHART_STILL}
            whileInView={CHART_SHOWN}
            viewport={CHART_VIEWPORT}
            viewBox={`0 0 ${VIEW_WIDTH_LOCAL} ${strip.viewHeight}`}
            preserveAspectRatio="xMidYMid meet"
            className="h-auto w-full"
            role="img"
            aria-label={`Attention over ${strip.cells.length} input timesteps, oldest first.${
              strip.argmax
                ? ` Peak attention ${fractionAsPercent(strip.argmax.weight, 1)} at ${strip.argmax.label}.`
                : ' Attention is flat across the sequence.'
            }`}
          >
            {strip.cells.map((cell) => (
              <g key={`cell-${cell.index}`}>
                {/* Empty track under every cell, so a near-zero weight reads as a
                    step the model ignored rather than as a gap in the sequence. */}
                <rect
                  x={cell.x}
                  y={strip.cellY}
                  width={cell.width}
                  height={strip.cellHeight}
                  fill={OBSIDIAN_EDGE}
                  fillOpacity={0.35}
                  aria-hidden
                />
                <motion.rect
                  x={cell.x}
                  y={strip.cellY}
                  width={cell.width}
                  height={strip.cellHeight}
                  fill={GOLD}
                  variants={{ [CHART_STILL]: { opacity: 0 }, [CHART_SHOWN]: { opacity: cell.share } }}
                  transition={{
                    duration: reduceMotion ? 0 : 0.4,
                    ease: [0.16, 1, 0.3, 1],
                    delay: reduceMotion ? 0 : Math.min(0.5, cell.index * 0.012),
                  }}
                >
                  <title>{`${cell.label}: ${fractionAsPercent(cell.weight, 2)} attention`}</title>
                </motion.rect>
              </g>
            ))}

            {/* The argmax, outlined and named. */}
            {strip.argmax ? (
              <g>
                <rect
                  x={strip.argmax.x - 0.5}
                  y={strip.cellY - 0.5}
                  width={strip.argmax.width + 1}
                  height={strip.cellHeight + 1}
                  fill="none"
                  stroke={GOLD_BRIGHT}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={Math.max(0, Math.min(VIEW_WIDTH_LOCAL, strip.argmax.x + strip.argmax.width / 2))}
                  y={strip.cellY - 4}
                  textAnchor={
                    strip.argmax.x < 40 ? 'start' : strip.argmax.x > VIEW_WIDTH_LOCAL - 40 ? 'end' : 'middle'
                  }
                  fontSize={AXIS_TEXT}
                  fill={PARCHMENT_DIM}
                  className="tabular"
                  aria-hidden
                >
                  {`${truncate(strip.argmax.label, LABEL_CHARS)} ${fractionAsPercent(strip.argmax.weight, 0)}`}
                </text>
              </g>
            ) : null}

            {/* Sequence ends. Direction has to be stated: a heat row has no arrow. */}
            <g aria-hidden>
              <text x={0} y={strip.viewHeight - 3} fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT}>
                {`oldest · ${truncate((strip.cells[0] as Cell).label, LABEL_CHARS)}`}
              </text>
              <text
                x={VIEW_WIDTH_LOCAL}
                y={strip.viewHeight - 3}
                textAnchor="end"
                fontSize={AXIS_TEXT}
                fill={PARCHMENT_FAINT}
              >
                {`${truncate((strip.cells[strip.cells.length - 1] as Cell).label, LABEL_CHARS)} · newest`}
              </text>
            </g>
          </motion.svg>

          <p className="mt-1.5 text-[0.6875rem] leading-snug text-parchment-faint">
            Attention over {strip.cells.length} input timesteps — softmax weights, sum to 1. Cell opacity is weight ÷
            peak weight ({fractionAsPercent(strip.peak, 1)}).
          </p>
        </div>
      ) : null}

      {bars.length > 0 ? (
        <div>
          <FeatureBars items={bars} />
          <p className="mt-1.5 text-[0.6875rem] leading-snug text-parchment-faint">
            Variable selection over {bars.length} inputs — softmax weights, sum to 1. Bars are shares of that total,
            ranked.
          </p>
        </div>
      ) : null}
    </div>
  );
}
