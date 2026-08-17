'use client';

/**
 * The calibrated volatility smile.
 *
 * The mandate is explicit that the surface must be produced by SABR with Hagan's
 * asymptotic approximation and that cubic-spline interpolation across strikes is
 * forbidden, "because it can produce negative transition probabilities and
 * arbitrageable surfaces". A chart cannot show arbitrage-freedom directly, but it
 * can show the one thing that tells a trader whether the fit is trustworthy: the
 * *residual*. So the fitted curve is drawn as a continuous line and each OPRA
 * quote as a discrete 3×3 tick, and the vertical gap between tick and line is the
 * calibration error at that strike, readable without a table.
 *
 * The 25Δ strikes get gold markers and hairlines because RR₂₅ = σ(25Δ put) −
 * σ(25Δ call) is the only number this surface exists to produce; the ATM strike is
 * a champagne dashed rail because it is the reference the risk reversal is
 * measured against, not a signal of its own.
 *
 * The fill under the curve interpolates sage (low IV) → burgundy (high IV) via
 * `mixColour`, which is the ramp the research names for the surface. It is a
 * vertical gradient in user space, so the colour at any height *is* the IV level
 * at that height rather than a decorative wash.
 *
 * Everything arrives calibrated. This component owns no Hagan algebra, no root
 * finding and no delta inversion — only layout.
 */

import { useId, useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  areaPath,
  extent,
  frame,
  linearScale,
  mixColour,
  niceTicks,
  smoothPath,
  type ChartFrame,
  type Point,
  type Scale,
} from '@/lib/ui/svg';
import {
  BURGUNDY,
  CHAMPAGNE,
  GOLD,
  GOLD_BRIGHT,
  OBSIDIAN_EDGE,
  PARCHMENT_DIM,
  PARCHMENT_FAINT,
  SAGE,
  fractionAsPercent,
  price,
  ratio,
  volPoints,
} from '@/lib/ui/format';
import { EmptyState } from '@/components/ui/primitives';
import { useChartWidth } from './useChartWidth';

const AXIS_TEXT = 9;
const GRID_TICKS = 4;
/** Strike/log-moneyness tick pairs. Five reads without crowding at 680px. */
const X_TICKS = 5;
/** Mandated quote tick size — small enough that the residual, not the mark, reads. */
const QUOTE_TICK = 3;

export interface SmileCurvePoint {
  strike: number;
  logMoneyness: number;
  /** Implied vol as a decimal: 0.32 = 32%. */
  vol: number;
}

export interface SabrSmileProps {
  curve: SmileCurvePoint[];
  /** Raw OPRA quotes the fit was calibrated against. */
  marketQuotes?: { strike: number; vol: number }[];
  forward: number;
  strike25Call?: number;
  strike25Put?: number;
  vol25Call?: number;
  vol25Put?: number;
  volAtm?: number;
  /** RR₂₅ in **vol points** — the `rr25_30d` convention, i.e. already ×100. */
  riskReversal?: number;
  height?: number;
  width?: number;
}

interface DeltaMark {
  key: string;
  label: string;
  x: number;
  y: number;
  anchor: 'start' | 'end';
  /** Caption baseline, dropped to a second row when the two captions collide. */
  labelY: number;
}

interface Layout {
  f: ChartFrame;
  x: Scale;
  y: Scale;
  curveD: string;
  areaD: string;
  volDomain: [number, number];
  volTicks: number[];
  xTicks: SmileCurvePoint[];
  quotes: { x: number; y: number; strike: number; vol: number }[];
  deltaMarks: DeltaMark[];
  atmX: number | null;
  count: number;
}

function buildLayout(props: Required<Pick<SabrSmileProps, 'width' | 'height'>> & SabrSmileProps): Layout | null {
  const {
    curve,
    marketQuotes,
    forward,
    strike25Call,
    strike25Put,
    vol25Call,
    vol25Put,
    volAtm,
    width,
    height,
  } = props;

  const fitted = (Array.isArray(curve) ? curve : [])
    .filter((p) => p && Number.isFinite(p.strike) && Number.isFinite(p.vol))
    .slice()
    .sort((a, b) => a.strike - b.strike);
  if (fitted.length === 0) return null;

  const quoteList = (Array.isArray(marketQuotes) ? marketQuotes : []).filter(
    (q) => q && Number.isFinite(q.strike) && Number.isFinite(q.vol),
  );

  const f = frame(width, height, { top: 20, right: 54, bottom: 40, left: 10 });

  // Markers and quotes join the domain so a 25Δ strike outside the plotted curve
  // can never be scaled off-canvas — an invisible reference line is worse than
  // none (the precedent `Sparkline` sets for its baseline).
  const strikes = [
    ...fitted.map((p) => p.strike),
    ...quoteList.map((q) => q.strike),
    ...[forward, strike25Call, strike25Put].filter((v): v is number => Number.isFinite(v as number)),
  ];
  const vols = [
    ...fitted.map((p) => p.vol),
    ...quoteList.map((q) => q.vol),
    ...[volAtm, vol25Call, vol25Put].filter((v): v is number => Number.isFinite(v as number)),
  ];

  const x = linearScale(extent(strikes, 0.04), [f.x0, f.x1]);
  const volDomain = extent(vols, 0.12);
  const y = linearScale(volDomain, [f.y1, f.y0]);

  const points: Point[] = fitted.map((p) => ({ x: x(p.strike), y: y(p.vol) }));

  const step = Math.max(1, Math.floor((fitted.length - 1) / Math.max(1, X_TICKS - 1)));
  const xTicks: SmileCurvePoint[] = [];
  for (let i = 0; i < fitted.length; i += step) xTicks.push(fitted[i] as SmileCurvePoint);
  const lastTick = fitted[fitted.length - 1] as SmileCurvePoint;
  if (xTicks[xTicks.length - 1] !== lastTick) xTicks.push(lastTick);

  const deltaMarks: DeltaMark[] = [];
  if (Number.isFinite(strike25Put) && Number.isFinite(vol25Put)) {
    deltaMarks.push({
      key: 'put',
      label: `25Δ put ${fractionAsPercent(vol25Put as number, 1)}`,
      x: x(strike25Put as number),
      y: y(vol25Put as number),
      anchor: 'start',
      labelY: 0,
    });
  }
  if (Number.isFinite(strike25Call) && Number.isFinite(vol25Call)) {
    deltaMarks.push({
      key: 'call',
      label: `25Δ call ${fractionAsPercent(vol25Call as number, 1)}`,
      x: x(strike25Call as number),
      y: y(vol25Call as number),
      anchor: 'end',
      labelY: 0,
    });
  }

  /*
   * The two delta captions share one line across the top of the plot, the put
   * reading rightwards from its strike and the call leftwards from its. On a
   * narrow panel — 391px in the symbol page's right column — the strikes are
   * close enough that the two runs of text meet, and the result renders as
   * "25Δ call 22[5Δ]put 24.9%". When they would collide the call caption drops to
   * a second row, which is the only way to keep both readable without shortening
   * either.
   */
  const captionWidth = (text: string): number => text.length * AXIS_TEXT * 0.62;
  const put = deltaMarks.find((m) => m.key === 'put');
  const call = deltaMarks.find((m) => m.key === 'call');
  const collide =
    put !== undefined &&
    call !== undefined &&
    put.x + 6 + captionWidth(put.label) > call.x - 6 - captionWidth(call.label);
  for (const mark of deltaMarks) {
    mark.labelY = f.y0 + 9 + (collide && mark.key === 'call' ? AXIS_TEXT + 3 : 0);
  }

  return {
    f,
    x,
    y,
    curveD: smoothPath(points),
    areaD: areaPath(points, f.y1, true),
    volDomain,
    volTicks: niceTicks(volDomain, GRID_TICKS),
    xTicks,
    quotes: quoteList.map((q) => ({ x: x(q.strike), y: y(q.vol), strike: q.strike, vol: q.vol })),
    deltaMarks,
    atmX: Number.isFinite(forward) ? x(forward) : null,
    count: fitted.length,
  };
}

export function SabrSmile({
  curve,
  marketQuotes,
  forward,
  strike25Call,
  strike25Put,
  vol25Call,
  vol25Put,
  volAtm,
  riskReversal,
  height = 300,
  width: widthFallback = 680,
}: SabrSmileProps) {
  const { ref: chartRef, width } = useChartWidth(widthFallback);
  const reduceMotion = useReducedMotion();
  const gradientId = useId();
  const layout = useMemo(
    () =>
      buildLayout({
        curve,
        marketQuotes,
        forward,
        strike25Call,
        strike25Put,
        vol25Call,
        vol25Put,
        volAtm,
        width,
        height,
      }),
    [curve, marketQuotes, forward, strike25Call, strike25Put, vol25Call, vol25Put, volAtm, width, height],
  );

  if (!layout) {
    return (
      <EmptyState
        title="No calibrated smile"
        detail="The SABR fit produced no drawable strikes for this expiry. Nothing is interpolated across an empty chain."
      />
    );
  }

  const { f, x, y, curveD, areaD, volDomain, volTicks, xTicks, quotes, deltaMarks, atmX, count } = layout;

  const hasRr = Number.isFinite(riskReversal);
  const rr = riskReversal as number;
  // Sign convention: RR₂₅ = σ(25Δ call) − σ(25Δ put), so a negative print means
  // the downside wing is richer. The research reads that as hedging demand, and
  // the sign is useless to a reader who has to remember which way round it goes.
  const rrReading = !hasRr
    ? ''
    : rr < -0.05
      ? 'puts bid over calls'
      : rr > 0.05
        ? 'calls bid over puts'
        : 'wings symmetric';

  // Five stops is enough for a monotone two-hue ramp to read as continuous.
  const stops = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="relative">
      <div className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[0.6875rem] leading-none text-parchment-faint">
        <span className="inline-flex items-center gap-1.5">
          <svg width={16} height={8} viewBox="0 0 16 8" aria-hidden className="shrink-0">
            <path d="M0 6 C5 6 6 2 16 2" fill="none" stroke={GOLD} strokeWidth={1.25} />
          </svg>
          SABR fit — arbitrage-free by construction, no spline
        </span>
        {quotes.length > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <svg width={16} height={8} viewBox="0 0 16 8" aria-hidden className="shrink-0">
              <rect x={2} y={2.5} width={QUOTE_TICK} height={QUOTE_TICK} fill={CHAMPAGNE} />
              <rect x={7} y={4} width={QUOTE_TICK} height={QUOTE_TICK} fill={CHAMPAGNE} />
              <rect x={12} y={1} width={QUOTE_TICK} height={QUOTE_TICK} fill={CHAMPAGNE} />
            </svg>
            Market quotes — the gap to the line is the calibration residual
          </span>
        ) : null}
      </div>

      <svg
        ref={chartRef}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        role="img"
        aria-label={`Calibrated volatility smile across ${count} strikes${
          Number.isFinite(forward) ? `, forward ${price(forward)}` : ''
        }${Number.isFinite(volAtm) ? `, at-the-money implied volatility ${fractionAsPercent(volAtm as number, 1)}` : ''}${
          Number.isFinite(vol25Put) ? `, 25 delta put ${fractionAsPercent(vol25Put as number, 1)}` : ''
        }${Number.isFinite(vol25Call) ? `, 25 delta call ${fractionAsPercent(vol25Call as number, 1)}` : ''}${
          hasRr ? `, risk reversal ${volPoints(rr)}, ${rrReading}` : ''
        }. ${quotes.length} market quotes overlaid.`}
      >
        <defs>
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1={0}
            x2={0}
            y1={y(volDomain[1])}
            y2={y(volDomain[0])}
          >
            {stops.map((t) => (
              <stop
                key={t}
                offset={`${t * 100}%`}
                // t = 0 is the top of the plot, i.e. the highest IV in view.
                stopColor={mixColour(BURGUNDY, SAGE, t)}
                stopOpacity={0.16}
              />
            ))}
          </linearGradient>
        </defs>

        {/* ── 1. IV grid and right-hand vol axis ───────────────────────────── */}
        <g aria-hidden>
          {volTicks.map((tick) => {
            const ty = y(tick);
            if (ty < f.y0 - 0.5 || ty > f.y1 + 0.5) return null;
            return (
              <g key={`vol-${tick}`}>
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
                  x={f.x1 + 6}
                  y={ty}
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

        {/* ── 2. Fill under the fit, coloured by IV level ──────────────────── */}
        {areaD ? (
          <motion.path
            d={areaD}
            fill={`url(#${gradientId})`}
            stroke="none"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: reduceMotion ? 0 : 0.6, ease: [0.16, 1, 0.3, 1] }}
            aria-hidden
          />
        ) : null}

        {/* ── 3. ATM rail and the 25Δ hairlines ───────────────────────────── */}
        <g aria-hidden>
          {atmX !== null ? (
            <>
              <line
                x1={atmX}
                x2={atmX}
                y1={f.y0}
                y2={f.y1}
                stroke={CHAMPAGNE}
                strokeOpacity={0.5}
                strokeWidth={1}
                strokeDasharray="3 3"
                shapeRendering="crispEdges"
              />
              <text x={atmX} y={f.y0 - 8} textAnchor="middle" fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT} className="tabular">
                ATM {price(forward)}
              </text>
            </>
          ) : null}
          {deltaMarks.map((mark) => (
            <line
              key={`hair-${mark.key}`}
              x1={mark.x}
              x2={mark.x}
              y1={f.y0}
              y2={f.y1}
              stroke={GOLD}
              strokeOpacity={0.35}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          ))}
        </g>

        {/* ── 4. The fitted smile ──────────────────────────────────────────── */}
        {curveD ? (
          <motion.path
            d={curveD}
            fill="none"
            stroke={GOLD}
            strokeWidth={1.5}
            strokeLinecap="round"
            initial={reduceMotion ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: reduceMotion ? 0 : 0.9, ease: [0.16, 1, 0.3, 1] }}
          />
        ) : null}

        {/* ── 5. Market quotes, as ticks so residuals stay legible ─────────── */}
        <motion.g
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduceMotion ? 0 : 0.4, delay: reduceMotion ? 0 : 0.5 }}
        >
          {quotes.map((quote, index) => (
            <rect
              key={`quote-${index}`}
              x={quote.x - QUOTE_TICK / 2}
              y={quote.y - QUOTE_TICK / 2}
              width={QUOTE_TICK}
              height={QUOTE_TICK}
              fill={CHAMPAGNE}
            >
              <title>{`Strike ${price(quote.strike)} — market IV ${fractionAsPercent(quote.vol, 2)}`}</title>
            </rect>
          ))}
        </motion.g>

        {/* ── 6. 25Δ markers and their labels ─────────────────────────────── */}
        <g>
          {deltaMarks.map((mark) => (
            <g key={mark.key}>
              <circle cx={mark.x} cy={mark.y} r={3.25} fill={GOLD_BRIGHT}>
                <title>{mark.label}</title>
              </circle>
              <text
                x={mark.anchor === 'start' ? mark.x + 6 : mark.x - 6}
                y={mark.labelY}
                textAnchor={mark.anchor}
                fontSize={AXIS_TEXT}
                fill={PARCHMENT_DIM}
                className="tabular"
              >
                {mark.label}
              </text>
            </g>
          ))}
        </g>

        {/* ── 7. Risk reversal, stated with its interpretation ─────────────── */}
        {hasRr ? (
          <g aria-hidden>
            {/* 13px apart: at 11px the two 9px line boxes met and the reading
                printed into the figure above it on a narrow panel. */}
            <text x={f.x0 + 4} y={f.y1 - 18} fontSize={AXIS_TEXT} fill={CHAMPAGNE} className="tabular">
              RR₂₅ {volPoints(rr)}
            </text>
            <text x={f.x0 + 4} y={f.y1 - 5} fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT}>
              {rrReading}
            </text>
          </g>
        ) : null}

        {/* ── 8. Strike axis, with log-moneyness underneath. Strikes are what a
                trader types into a ticket; log-moneyness is what the model fits. ─ */}
        <g aria-hidden>
          <line
            x1={f.x0}
            x2={f.x1}
            y1={f.y1}
            y2={f.y1}
            stroke={OBSIDIAN_EDGE}
            strokeOpacity={0.45}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          {xTicks.map((tick) => (
            <g key={`strike-${tick.strike}`}>
              <text
                x={x(tick.strike)}
                y={f.y1 + 13}
                textAnchor="middle"
                fontSize={AXIS_TEXT}
                fill={PARCHMENT_FAINT}
                className="tabular"
              >
                {price(tick.strike)}
              </text>
              <text
                x={x(tick.strike)}
                y={f.y1 + 26}
                textAnchor="middle"
                fontSize={AXIS_TEXT}
                fill={PARCHMENT_FAINT}
                className="tabular"
              >
                {Number.isFinite(tick.logMoneyness) ? ratio(tick.logMoneyness, 2) : '—'}
              </text>
            </g>
          ))}
          <text x={f.x1 + 6} y={f.y1 + 13} fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT}>
            strike
          </text>
          <text x={f.x1 + 6} y={f.y1 + 26} fontSize={AXIS_TEXT} fill={PARCHMENT_FAINT}>
            log k
          </text>
        </g>
      </svg>
    </div>
  );
}
