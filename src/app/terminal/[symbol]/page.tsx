/**
 * The attribution view for one symbol.
 *
 * This page is the platform's answer to the question that makes a quantitative
 * signal usable or useless: *why*. A conviction score with no derivation is an
 * opinion delivered by a machine, and an opinion delivered by a machine to a
 * specific person about a specific security is advice. A conviction score that
 * decomposes, exactly and reproducibly, into the contribution of each input is a
 * published computation. The difference is the entire regulatory position, and it is
 * also just better information.
 *
 * So every number here is traceable:
 *
 *   • The **waterfall** shows E[f(x)] → f(x), one bar per driver, in log-odds. The
 *     sum of the bars equals the model output exactly — TreeSHAP's local-accuracy
 *     property — and the residual is displayed rather than hidden, because a
 *     non-zero residual would mean the explanation does not account for the
 *     prediction and the reader deserves to know that.
 *   • The **force plot** is the same decomposition as a single displacement, which
 *     is the better read for relative magnitude. The two share a hover key so
 *     moving over a driver in one highlights it in the other and in the table.
 *   • Each driver carries the sentence the deterministic mapping matrix produced
 *     from its discretised state — not a generated paraphrase, so the same state
 *     always yields the same words.
 *
 * The raw SHAP float is never rendered. It signs and sizes the geometry; what the
 * user reads is the share and the narrative.
 */

'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { motion } from 'framer-motion';
import { useParams } from 'next/navigation';
import { AsyncSlot, PageHeader, PageShell } from '@/components/PageState';
import {
  AttentionStrip,
  ConvictionDial,
  DecayCurve,
  DepthLadder,
  FeatureBars,
  LatencyBar,
  PriceChart,
  SabrSmile,
  ShapForcePlot,
  ShapWaterfall,
  ZOscillator,
} from '@/components/charts';
import type { SignalLevels } from '@/components/charts';
import {
  DriverHoverProvider,
  HoverableRow,
  useHoveredDriver,
  useSetHoveredDriver,
} from '@/components/charts/DriverHover';
import type { AggregatedStream } from '@/lib/quant/decay';
import type { OrderBookSnapshot } from '@/lib/quant/orderflow';
import {
  Badge,
  Button,
  ButtonLink,
  DataRow,
  Divider,
  Meter,
  Notice,
  Panel,
  PanelHeader,
  StatGrid,
  StatTile,
  TableShell,
  Td,
  Th,
} from '@/components/ui/primitives';
import { useApi } from '@/lib/ui/api';
import {
  duration,
  fractionAsPercent,
  sessionHalfLife,
  integer,
  nyDateTime,
  percent,
  price,
  ratio,
  sigma,
  signedFractionAsPercent,
} from '@/lib/ui/format';
import type { FeatureGroup, RegimeLabel, SignalDirection } from '@/lib/domain/types';

type Domain = 'technical' | 'fundamental' | 'sentiment';

interface Contribution {
  featureId: string;
  featureDisplayName: string;
  featureValueRaw: number;
  contributionPercentage: number;
  impactDirection: 'positive' | 'negative';
  semanticTranslation: string;
  state: string;
  group: FeatureGroup;
  domain: Domain;
  unit: string;
}

interface WaterfallStep {
  label: string;
  shap: number;
  cumulative: number;
  cumulativeProbability: number;
  direction: 'positive' | 'negative';
}

interface AgentInference {
  name: string;
  architecture: 'tft' | 'bilstm' | 'lstm';
  timeframeMinutes: number;
  probability: number;
  expectedReturn: number;
  lower: number | null;
  upper: number | null;
  /**
   * Null for the LSTM and BiLSTM agents, present only for the TFT.
   *
   * Interpretable multi-head attention is a property of the Temporal Fusion
   * Transformer's architecture, not of recurrent networks — so the field is
   * genuinely absent rather than empty, and typing it as optional-undefined was
   * wrong: `undefined` is never what the API sends, so an `!== undefined` guard
   * passed on null and the render threw reading `.length`.
   */
  attention: number[] | null;
}

/**
 * `/chart/[symbol]`. Declared against the engine's `ChartSeries` shape; every field
 * is required because the engine always emits it — `smile` is nullable rather than
 * optional, which is the difference between "this name has no listed options" and
 * "this response is from an older build".
 */
interface ChartSeriesResponse {
  symbol: string;
  daily: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
  intraday: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
  hourly: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
  kalmanBand: { time: number; level: number; upper: number; lower: number }[];
  bollinger: { time: number; upper: number; middle: number; lower: number }[];
  ouBand: { upper: number; lower: number; mid: number };
  ouZ: { time: number; z: number }[];
  smile: {
    tau: number;
    forward: number;
    curve: { strike: number; logMoneyness: number; vol: number }[];
    quotes: { strike: number; vol: number }[];
    strike25Call: number;
    strike25Put: number;
    vol25Call: number;
    vol25Put: number;
    volAtm: number;
    riskReversal: number;
    rmse: number;
  } | null;
  vwap: number;
}

interface SignalResponse {
  assetIdentifier: string;
  timestamp: number;
  convictionScore: number;
  predictionProbability: number;
  direction: SignalDirection;
  horizonDays: number;
  referencePrice: number;
  expectedReturn: number;
  expectedReturnLow: number;
  expectedReturnHigh: number;
  /*
   * Imported rather than re-declared. The local declaration here read
   * `{ entryLow, entryHigh, … }` while the engine has always emitted
   * `entryZoneLow`/`entryZoneHigh`, so the entry-zone row rendered `price(undefined)`
   * — an em-dash — on every symbol page, and TypeScript could not see it because
   * the lie was in the type that described the response rather than in the code
   * reading it. One shared shape is what makes that mismatch a compile error.
   */
  levels: SignalLevels;
  regime: RegimeLabel;
  strategy: string | null;
  strategiesFired: string[];
  thesis: string;
  counterThesis: string;
  modelVersion: string;
  attributionResidual: number;
  /** Features the explanation attributes, before the driver list is capped. */
  attributedInputs: number;
  latency: { stages: { stage: string; ms: number }[]; totalMs: number; budgetMs: number; withinBudget: boolean };
  xaiBreakdown: Record<Domain, unknown[]>;
  contributions: Contribution[];
  waterfall: {
    baseValue: number;
    baseProbability: number;
    steps: WaterfallStep[];
    finalValue: number;
    finalProbability: number;
  };
  agents: AgentInference[];
  router: {
    action: string;
    /** Signed aggregate in [-1, 1]. Negative is short-side. */
    aggregateDirection: number;
    compositeProbability: number;
    /** Keyed by timeframe, not an array — the three agents are fixed. */
    weights: { w5m: number; w15m: number; w60m: number };
    regimeOverrideApplied: boolean;
    rationale: string;
    modelExposureFraction: number;
  };
  strategies: {
    id: string;
    name: string;
    fired: boolean;
    direction: SignalDirection;
    conviction: number;
    gates: { name: string; passed: boolean; detail: string }[];
    rationale: string;
  }[];
  artefacts: {
    price: number;
    previousClose: number;
    changePercent: number;
    atr: number;
    vwap: number;
    ou: {
      theta: number;
      mu: number;
      sigma: number;
      halfLife: number | null;
      equilibriumSigma: number;
      rSquared: number;
      meanReverting: boolean;
    };
    /**
     * The PCA-filtered order-flow signal. `pc1Loadings` is one loading per depth
     * level, in the same level order as `book` below, which is what lets the
     * ladder draw the two against each other.
     */
    mlofi: {
      intent: number;
      pc1Z: number;
      pc1ExplainedVariance: number;
      pc1Loadings: number[];
      levels: number[];
      queueImbalance: number;
      depthImbalance: number;
    };
    /*
     * The depth snapshot the MLOFI vector was computed from — the engine's own
     * shape, imported rather than re-declared for the same reason `levels` is.
     * Null when the publisher received no book; the ladder renders that itself.
     */
    book: OrderBookSnapshot | null;
    /** Calibrated smile parameters; null for a name with no listed options. */
    sabr: { alpha: number; beta: number; rho: number; nu: number; rmse: number; converged: boolean } | null;
    /** Decay-weighted alt-data aggregates, one per stream present for this name. */
    altStreams: AggregatedStream[];
  };
}

const DOMAIN_LABELS: Record<Domain, string> = {
  technical: 'Technical',
  fundamental: 'Fundamental',
  sentiment: 'Sentiment & flow',
};

const REGIME_LABELS: Record<RegimeLabel, string> = {
  trending_bull: 'Trending bull',
  trending_bear: 'Trending bear',
  mean_reverting: 'Mean reverting',
  high_volatility: 'High volatility',
  low_volatility_drift: 'Low-volatility drift',
  illiquid: 'Illiquid',
};

/**
 * The three fusion weights, in timeframe order.
 *
 * Declared as a fixed list because the ensemble is a fixed ensemble: the router's
 * weights arrive as a keyed record rather than an array precisely because there
 * are exactly three agents and their identity is part of the model, not data.
 */
const AGENT_WEIGHT_ROWS: readonly { key: 'w5m' | 'w15m' | 'w60m'; label: string }[] = [
  { key: 'w5m', label: '5m tactical (LSTM)' },
  { key: 'w15m', label: '15m contextual (BiLSTM)' },
  { key: 'w60m', label: '60m macro (TFT)' },
];

const ARCHITECTURE_LABELS: Record<AgentInference['architecture'], string> = {
  lstm: 'LSTM',
  bilstm: 'BiLSTM',
  tft: 'Temporal Fusion Transformer',
};

/*
 * Three thin subscribers.
 *
 * Only a component can read a context, and reading it *here* rather than in the
 * page is the whole point: a pointer move now re-renders one chart instead of
 * the route. Each takes the props its chart takes minus the two the context
 * supplies.
 */
type WithoutHover<T> = Omit<T, 'hoveredKey' | 'onHover'>;

function HoveredShapWaterfall(props: WithoutHover<ComponentProps<typeof ShapWaterfall>>) {
  return <ShapWaterfall {...props} hoveredKey={useHoveredDriver()} onHover={useSetHoveredDriver()} />;
}

function HoveredShapForcePlot(props: WithoutHover<ComponentProps<typeof ShapForcePlot>>) {
  return <ShapForcePlot {...props} hoveredKey={useHoveredDriver()} onHover={useSetHoveredDriver()} />;
}

function HoveredFeatureBars(props: WithoutHover<ComponentProps<typeof FeatureBars>>) {
  return <FeatureBars {...props} hoveredKey={useHoveredDriver()} onHover={useSetHoveredDriver()} />;
}

/**
 * True once the browser has gone idle after first paint.
 *
 * The attribution toggle used to swap one chart for the other by unmounting.
 * Mounting the force plot cold costs a 216–267 ms frame — a fresh SVG tree, a
 * `ResizeObserver` measurement that forces a second render, and eleven Flubber
 * path interpolators built from scratch — so the first press of "Force" dropped
 * roughly sixteen frames on a control that should feel instant.
 *
 * Mounting both eagerly would move that cost onto the page load, which is the
 * one moment it is least affordable. Mounting the second one at idle puts it
 * where nothing is competing for the main thread: first paint is untouched, and
 * by the time a pointer reaches the toggle the swap is a className change.
 */
function useIdleMount(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    type IdleWindow = Window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const w = window as IdleWindow;
    if (typeof w.requestIdleCallback === 'function') {
      const handle = w.requestIdleCallback(() => setReady(true));
      return () => w.cancelIdleCallback?.(handle);
    }
    // Safari has no requestIdleCallback; a timeout past the entrance animations
    // is close enough, since the point is only "not during first paint".
    const timer = window.setTimeout(() => setReady(true), 600);
    return () => window.clearTimeout(timer);
  }, []);
  return ready;
}

/**
 * One of the two attribution views, held in the DOM whether or not it is shown.
 *
 * `h-0 overflow-hidden` rather than `hidden`: the chart measures itself off its
 * own `getBoundingClientRect`, and a `display: none` subtree measures zero, so
 * the pane would have to lay out from scratch on reveal — exactly the cost this
 * is avoiding. Zero height keeps the width real and clips the drawing instead.
 *
 * `inert` is what makes it honest: both charts put `tabIndex={0}` on every
 * driver, so a hidden-but-mounted pane would otherwise be eight invisible tab
 * stops. `aria-hidden` alone does not stop focus.
 */
function AttributionPane({
  active,
  mounted,
  children,
}: {
  active: boolean;
  mounted: boolean;
  children: ReactNode;
}) {
  if (!mounted) return null;
  return (
    <motion.div
      className={active ? undefined : 'h-0 overflow-hidden'}
      aria-hidden={!active}
      inert={!active}
      animate={{ opacity: active ? 1 : 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Which decomposition the attribution panel is showing.
 *
 * In a context rather than in the page for the same reason the hover key is: the
 * conviction dial's morph is driven by this toggle too, and holding the state at
 * the route meant one press re-rendered nine charts, a twelve-row table and four
 * stat grids to change two of them. Measured at 4x CPU throttle that was a
 * 328-523 ms gap between the click and the next painted frame — on a control
 * whose whole job is to feel like flipping a switch.
 */
const ViewContext = createContext<AttributionView>('waterfall');
const SetViewContext = createContext<(view: AttributionView) => void>(() => {});

type AttributionView = 'waterfall' | 'force';

function AttributionViewProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<AttributionView>('waterfall');
  const set = useCallback((next: AttributionView) => setView(next), []);
  return (
    <SetViewContext.Provider value={set}>
      <ViewContext.Provider value={view}>{children}</ViewContext.Provider>
    </SetViewContext.Provider>
  );
}

/** Both pieces of interaction state this page shares between its panels. */
function SymbolPageState({ children }: { children: ReactNode }) {
  return (
    <DriverHoverProvider>
      <AttributionViewProvider>{children}</AttributionViewProvider>
    </DriverHoverProvider>
  );
}

/** The dial unspools into an axis when the force plot is showing. */
function MorphingConvictionDial(props: WithoutMorph<ComponentProps<typeof ConvictionDial>>) {
  return <ConvictionDial {...props} morph={useContext(ViewContext) === 'force' ? 1 : 0} />;
}

type WithoutMorph<T> = Omit<T, 'morph'>;

/**
 * The whole attribution panel, including the toggle that drives it.
 *
 * A component rather than inline JSX so the toggle's state change stops at this
 * panel's boundary instead of re-rendering the route around it.
 */
function AttributionPanel({
  waterfall,
  steps,
  forceContributions,
  residual,
}: {
  waterfall: SignalResponse['waterfall'];
  steps: ComponentProps<typeof ShapWaterfall>['steps'];
  forceContributions: ComponentProps<typeof ShapForcePlot>['contributions'];
  residual: number;
}) {
  const view = useContext(ViewContext);
  const setView = useContext(SetViewContext);
  const idleReady = useIdleMount();

  return (
    <Panel>
      <PanelHeader
        eyebrow="Attribution"
        title={view === 'waterfall' ? 'Additive decomposition' : 'Net displacement'}
        detail={
          view === 'waterfall'
            ? 'Exact TreeSHAP. The bars sum to the model output; the residual below reports the arithmetic.'
            : 'The same decomposition as one displacement from the base rate. Segment length is share of total attribution.'
        }
        action={
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant={view === 'waterfall' ? 'primary' : 'ghost'}
              onClick={() => setView('waterfall')}
              aria-pressed={view === 'waterfall'}
            >
              Waterfall
            </Button>
            <Button
              size="sm"
              variant={view === 'force' ? 'primary' : 'ghost'}
              onClick={() => setView('force')}
              aria-pressed={view === 'force'}
            >
              Force
            </Button>
          </div>
        }
      />
      <div className="scroll-x mt-4">
        <AttributionPane active={view === 'waterfall'} mounted={idleReady || view === 'waterfall'}>
          <HoveredShapWaterfall
            baseValue={waterfall.baseValue}
            finalValue={waterfall.finalValue}
            baseProbability={waterfall.baseProbability}
            finalProbability={waterfall.finalProbability}
            steps={steps}
          />
        </AttributionPane>
        <AttributionPane active={view === 'force'} mounted={idleReady || view === 'force'}>
          <HoveredShapForcePlot
            baseValue={waterfall.baseValue}
            baseProbability={waterfall.baseProbability}
            finalProbability={waterfall.finalProbability}
            contributions={forceContributions}
          />
        </AttributionPane>
      </div>
      <Divider className="my-4" />
      <StatGrid columns={3}>
        <StatTile
          label="Base rate"
          value={fractionAsPercent(waterfall.baseProbability)}
          footnote="E[f(x)] over the K-Means background"
        />
        <StatTile
          label="Model output"
          value={fractionAsPercent(waterfall.finalProbability)}
          tone="gold"
          footnote="f(x) after every contribution"
        />
        <StatTile
          label="Local-accuracy residual"
          value={residual.toExponential(2)}
          tone={Math.abs(residual) < 1e-9 ? 'sage' : 'burgundy'}
          footnote={
            Math.abs(residual) < 1e-9
              ? 'Exact to floating-point precision'
              : 'Non-zero: the explanation does not fully account for the prediction'
          }
        />
      </StatGrid>
    </Panel>
  );
}

export default function SymbolPage() {
  const params = useParams<{ symbol: string }>();
  const symbol = (params.symbol ?? '').toUpperCase();

  const signal = useApi<SignalResponse>(symbol.length > 0 ? `/signals/${symbol}` : null);
  /**
   * The series are a separate request on purpose: 180 bars plus five overlay
   * series is an order of magnitude more payload than the signal, and the
   * attribution below renders without it. Fetching them together would make the
   * whole page wait for the part of it that is heaviest.
   */
  const series = useApi<ChartSeriesResponse>(symbol.length > 0 ? `/chart/${symbol}` : null);


  return (
    <PageShell wide>
      <AsyncSlot state={signal} label={`Loading ${symbol}`} lines={8}>
        {(data) => {
          const contributions = [...data.contributions].sort(
            (a, b) => b.contributionPercentage - a.contributionPercentage,
          );
          const steps = data.waterfall.steps.map((step) => {
            const match = contributions.find((c) => c.featureDisplayName === step.label);
            return {
              ...step,
              ...(match === undefined
                ? {}
                : {
                    featureKey: match.featureId,
                    narrative: match.semanticTranslation,
                    state: match.state,
                  }),
            };
          });
          const forceContributions = contributions.slice(0, 10).map((c) => ({
            featureKey: c.featureId,
            label: c.featureDisplayName,
            shap: c.impactDirection === 'positive' ? c.contributionPercentage : -c.contributionPercentage,
            share: c.contributionPercentage / 100,
            direction: c.impactDirection,
            narrative: c.semanticTranslation,
            state: c.state,
          }));

          /*
           * The hover state lives in this provider, not in the page.
           *
           * `children` below is an element this render already created, so a
           * pointer move re-renders only the three charts and the one table row
           * that read the context — not the nine charts, twelve-row table and
           * four stat grids that used to re-render on every mousemove.
           */
          return (
            <SymbolPageState>
              <PageHeader
                eyebrow={`${data.assetIdentifier} · ${REGIME_LABELS[data.regime]}`}
                title={`${data.assetIdentifier} attribution`}
                lede={data.thesis}
                action={
                  <div className="flex flex-col items-end gap-2">
                    <Badge tone={data.direction === 'long' ? 'sage' : data.direction === 'short' ? 'burgundy' : 'neutral'}>
                      {data.direction}
                    </Badge>
                    <ButtonLink href={`/order/${data.assetIdentifier}`} variant="primary" size="sm">
                      Open order ticket
                    </ButtonLink>
                  </div>
                }
              />

              {/* ── Price, with the bands the signal was derived from ─── */}
              <Panel className="mb-5">
                <PanelHeader
                  eyebrow="Price"
                  title="180 sessions, with the model's own bands"
                  detail="The Kalman innovation band and the Bollinger band are computed by the engine, not the browser, so the band drawn here is the band the signal was derived from rather than a second estimate that happens to look similar."
                  action={
                    series.data ? (
                      <div className="text-right font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
                        <p>{integer(series.data.daily.length)} sessions</p>
                        <p className="mt-1">VWAP {price(series.data.vwap)}</p>
                      </div>
                    ) : null
                  }
                />
                <AsyncSlot state={series} label="Loading series" lines={6}>
                  {(chart) => (
                    <div className="mt-4">
                      <PriceChart
                        bars={chart.daily}
                        kalmanBand={chart.kalmanBand}
                        bollinger={chart.bollinger}
                        levels={data.levels}
                        vwap={chart.vwap}
                        showVolume
                      />
                    </div>
                  )}
                </AsyncSlot>
              </Panel>

              <div className="grid grid-cols-1 gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
                {/* ── Conviction and levels ─────────────────────────────── */}
                <div className="space-y-5">
                  <Panel>
                    <PanelHeader eyebrow="Conviction" title="Composite score" />
                    <div className="mt-4 flex justify-center">
                      {/*
                        Switching to the force plot unspools the ring into a
                        horizontal axis — the mandated through-line saying that the
                        composite score *is* the row of contributions below it.
                        Driven by the same state as the toggle, so the two can
                        never disagree about which view is showing.
                      */}
                      <MorphingConvictionDial
                        score={data.convictionScore}
                        size={220}
                        caption={`${data.horizonDays}-day horizon`}
                      />
                    </div>
                    <dl className="mt-5 space-y-0.5">
                      {/*
                        Named for what it measures. It is the tree ensemble's
                        P(this name beats the benchmark over the horizon) — not
                        the probability that the published direction is right.
                        The router is authoritative on direction and can, and
                        does, publish SHORT against a probability above 50%; a
                        bare "Probability" beside that reads as a contradiction.
                      */}
                      <DataRow
                        label="P(beats benchmark)"
                        value={fractionAsPercent(data.predictionProbability)}
                        hint="Tree-ensemble probability of outperforming, before the router decides direction"
                      />
                      <DataRow label="Expected return" value={signedFractionAsPercent(data.expectedReturn)} />
                      <DataRow
                        label="Return interval"
                        value={`${signedFractionAsPercent(data.expectedReturnLow)} — ${signedFractionAsPercent(data.expectedReturnHigh)}`}
                        hint="Quantile head, not a confidence interval"
                      />
                      <DataRow label="Reference price" value={price(data.referencePrice)} />
                      <DataRow label="Generated" value={nyDateTime(data.timestamp)} />
                    </dl>
                  </Panel>

                  <Panel>
                    <PanelHeader
                      eyebrow="Published levels"
                      title="Impersonal reference levels"
                      detail="Computed from volatility and structure alone. No level accounts for your account, holdings or risk tolerance."
                    />
                    <dl className="mt-3 space-y-0.5">
                      <DataRow
                        label="Entry zone"
                        value={`${price(data.levels.entryZoneLow)} — ${price(data.levels.entryZoneHigh)}`}
                      />
                      <DataRow label="Invalidation" value={price(data.levels.invalidation)} />
                      <DataRow label="Target 1" value={price(data.levels.target1)} />
                      <DataRow label="Target 2" value={price(data.levels.target2)} />
                    </dl>
                    <Notice tone="legal" className="mt-4">
                      These are published statistics, not instructions. Position size is yours alone to determine; this
                      platform never computes one from your account.
                    </Notice>
                  </Panel>
                </div>

                {/* ── Attribution ──────────────────────────────────────── */}
                <div className="space-y-5">
                  <AttributionPanel
                    waterfall={data.waterfall}
                    steps={steps}
                    forceContributions={forceContributions}
                    residual={data.attributionResidual}
                  />

                  {/* ── Driver table ───────────────────────────────────── */}
                  <Panel padded={false}>
                    <div className="p-5 pb-0">
                      <PanelHeader
                        eyebrow="Drivers"
                        title="Every contribution, in plain English"
                        detail="Each sentence is produced by a fixed mapping from the feature's discretised state, so the same state always yields the same wording."
                      />
                    </div>
                    {/*
                      A lower floor than the shared default, because this table has
                      five columns rather than twenty-four and the default was
                      clipping it. At 1440 the panel is 838px wide and `minWidth:
                      900` pushed the table 62px past it — 222px at 1280 — so every
                      interpretation sentence ran off the right edge mid-word,
                      behind a horizontal scrollbar, on the page whose entire
                      purpose is reading those sentences. 560 keeps the sentence
                      column legible on a phone and gets out of the way above it.
                    */}
                    <TableShell className="mt-4" minWidth={560}>
                      <thead>
                        <tr>
                          <Th>Feature</Th>
                          <Th align="right">Value</Th>
                          <Th align="right">Share</Th>
                          <Th>Impact</Th>
                          <Th>Interpretation</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {contributions.map((c) => (
                          <HoverableRow key={c.featureId} featureKey={c.featureId}>
                            <Td>
                              <span className="text-parchment">{c.featureDisplayName}</span>
                              <span className="ml-2 font-mono text-2xs text-parchment-faint">
                                {DOMAIN_LABELS[c.domain]}
                              </span>
                            </Td>
                            <Td align="right" numeric>
                              {formatFeatureValue(c.featureValueRaw, c.unit)}
                            </Td>
                            <Td align="right" numeric>
                              {percent(c.contributionPercentage, 1)}
                            </Td>
                            <Td>
                              <Meter
                                value={c.contributionPercentage / 100}
                                tone={c.impactDirection === 'positive' ? 'sage' : 'burgundy'}
                              />
                            </Td>
                            <Td>
                              <span className="text-parchment-dim">{c.semanticTranslation}</span>
                            </Td>
                          </HoverableRow>
                        ))}
                      </tbody>
                    </TableShell>
                  </Panel>

                  {/* ── Counter-thesis ─────────────────────────────────── */}
                  <Panel>
                    <PanelHeader
                      eyebrow="Counter-thesis"
                      title="What would invalidate this"
                      detail="Published alongside every signal, not on request. A thesis presented without its refutation is advocacy."
                    />
                    <p className="mt-3 text-sm leading-relaxed text-parchment-dim">{data.counterThesis}</p>
                  </Panel>
                </div>
              </div>

              {/* ── Agents and router ──────────────────────────────────── */}
              <div className="mt-5 grid gap-5 lg:grid-cols-2">
                <Panel>
                  <PanelHeader
                    eyebrow="Multi-timeframe agents"
                    title="Independent inferences"
                    detail="Three architectures on three timeframes. Each is trained and evaluated separately; the router below resolves their disagreement."
                  />
                  <div className="mt-4 space-y-4">
                    {data.agents.map((agent) => (
                      <div key={agent.name} className="border-t border-obsidian-edge pt-3 first:border-t-0 first:pt-0">
                        <div className="flex items-baseline justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[0.8125rem] text-parchment">{agent.name}</p>
                            <p className="font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
                              {ARCHITECTURE_LABELS[agent.architecture]} · {agent.timeframeMinutes}m
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="tabular text-base text-parchment">{fractionAsPercent(agent.probability)}</p>
                            <p className="tabular text-2xs text-parchment-faint">
                              {signedFractionAsPercent(agent.expectedReturn)}
                              {agent.lower !== null && agent.upper !== null
                                ? ` (${signedFractionAsPercent(agent.lower)} — ${signedFractionAsPercent(agent.upper)})`
                                : ''}
                            </p>
                          </div>
                        </div>
                        {agent.attention !== null && agent.attention.length > 0 ? (
                          <div className="mt-2.5">
                            <AttentionStrip attention={agent.attention} />
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </Panel>

                <Panel>
                  <PanelHeader
                    eyebrow="Conflict resolution"
                    title="How the disagreement was resolved"
                    detail={data.router.rationale}
                  />
                  <dl className="mt-3 space-y-0.5">
                    <DataRow label="Action" value={data.router.action} />
                    <DataRow
                      label="Aggregate direction"
                      value={sigma(data.router.aggregateDirection)}
                      hint="Signed weighted agreement across the three agents, in [-1, 1]. Negative is short-side."
                    />
                    <DataRow label="Composite probability" value={fractionAsPercent(data.router.compositeProbability)} />
                    <DataRow
                      label="Regime override"
                      value={data.router.regimeOverrideApplied ? 'Applied' : 'Not applied'}
                    />
                    <DataRow
                      label="Model exposure fraction"
                      value={ratio(data.router.modelExposureFraction)}
                      hint="Half-Kelly on the aggregate signal. An impersonal statistic — it is not read by the order ticket and is not a position size."
                    />
                  </dl>
                  <Divider className="my-4" />
                  <p className="eyebrow mb-2.5">Agent weights</p>
                  <div className="space-y-2.5">
                    {AGENT_WEIGHT_ROWS.map((row) => (
                      <div key={row.key}>
                        <div className="mb-1 flex items-baseline justify-between text-2xs">
                          <span className="text-parchment-dim">{row.label}</span>
                          <span className="tabular text-parchment-faint">
                            {percent(data.router.weights[row.key] * 100, 1)}
                          </span>
                        </div>
                        <Meter value={data.router.weights[row.key]} tone="gold" />
                      </div>
                    ))}
                  </div>
                  <Notice tone="legal" className="mt-4">
                    The exposure fraction above is published as a model statistic for every reader of this page. It is
                    not a recommendation and is never applied to your account.
                  </Notice>
                </Panel>
              </div>

              {/* ── Strategies, statistics and latency ─────────────────── */}
              {/* Two-up at lg, three-up only once there is room for three 320px charts.
                  At lg the content area is 764px, so three panels were 241px and every
                  chart inside downscaled to 62% — 8px axis labels beside 12px ones
                  elsewhere on the same page. */}
              <div className="mt-5 grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
                <Panel className="lg:col-span-2">
                  <PanelHeader
                    eyebrow="Strategy gates"
                    title="Which strategies fired, and which did not"
                    detail="A strategy that did not fire is shown with the gate that stopped it. Suppressing the misses would make the hit rate look like a property of the model rather than of the filter."
                  />
                  <div className="mt-4 space-y-3">
                    {data.strategies.map((s) => (
                      <div key={s.id} className="border-t border-obsidian-edge pt-3 first:border-t-0 first:pt-0">
                        <div className="flex items-baseline justify-between gap-3">
                          <p className="text-[0.8125rem] text-parchment">{s.name}</p>
                          <Badge tone={s.fired ? 'gold' : 'ghost'}>{s.fired ? 'fired' : 'no signal'}</Badge>
                        </div>
                        <p className="mt-1 text-[0.75rem] leading-snug text-parchment-faint">{s.rationale}</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {s.gates.map((g) => (
                            <Badge key={g.name} tone={g.passed ? 'sage' : 'neutral'} title={g.detail}>
                              {g.name}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </Panel>

                <div className="space-y-5">
                  <Panel>
                    <PanelHeader eyebrow="Mean reversion" title="Ornstein–Uhlenbeck fit" />
                    <dl className="mt-3 space-y-0.5">
                      <DataRow label="θ (reversion rate)" value={ratio(data.artefacts.ou.theta)} />
                      <DataRow label="μ (equilibrium)" value={price(Math.exp(data.artefacts.ou.mu))} />
                      <DataRow
                        label="Half-life"
                        value={
                          data.artefacts.ou.halfLife === null
                            ? 'not reverting'
                            : sessionHalfLife(data.artefacts.ou.halfLife)
                        }
                      />
                      <DataRow label="σ (diffusion)" value={ratio(data.artefacts.ou.sigma)} />
                      <DataRow label="Equilibrium σ" value={sigma(data.artefacts.ou.equilibriumSigma)} />
                      <DataRow
                        label="R²"
                        value={ratio(data.artefacts.ou.rSquared)}
                        hint="Fit of the AR(1) in levels. This is NOT a measure of how reliable the reversion is — a pure random walk scores above 0.99 here, because regressing a level on its own lag explains almost all of its variance. The half-life above carries the information."
                      />
                    </dl>
                    {!data.artefacts.ou.meanReverting ? (
                      <Notice tone="warning" className="mt-3">
                        The fitted process is not mean-reverting over this sample, so the half-life and equilibrium band
                        carry no information. They are shown because suppressing them would hide the diagnosis.
                      </Notice>
                    ) : null}
                    {/*
                      The oscillator is the spread standardised by the same fitted σ
                      as the table above, so the ±2σ lines it draws are the exact
                      thresholds the mean-reversion strategy fires on.
                    */}
                    {series.data && series.data.ouZ.length > 1 ? (
                      <div className="mt-4">
                        <ZOscillator
                          values={series.data.ouZ}
                          label="OU spread vs benchmark"
                          currentLabel="Z_OU"
                        />
                      </div>
                    ) : null}
                  </Panel>

                  {/*
                    The book, beside the vector that was read off it.

                    The ladder carries the PC1 loadings in its own right-hand
                    gutter, so which depth levels drive the scalars beneath it is
                    visible rather than taken on faith. That is the whole reason
                    the two are in one panel: published apart, the intent reading
                    would be a number with no book behind it.
                  */}
                  <Panel>
                    <PanelHeader
                      eyebrow="Order flow"
                      title="The book the MLOFI vector was read from"
                      detail="The depth snapshot the vector was computed from, ten levels a side — not a later quote of the same symbol. Opacity falls with depth because price impact does: size resting five ticks from the touch does not support the price the way size at the touch does, so it is not drawn as though it does. The gold bars are the PC1 loadings; only their magnitude is meaningful, since a principal component's sign is arbitrary."
                    />
                    <div className="mt-4">
                      <DepthLadder book={data.artefacts.book} mlofiLoadings={data.artefacts.mlofi.pc1Loadings} />
                    </div>
                    <dl className="mt-3 space-y-0.5">
                      <DataRow
                        label="Execution intent"
                        value={ratio(data.artefacts.mlofi.intent)}
                        hint="tanh of the PC1 z-score, in [-1, 1]. Positive is net buying pressure: the eigenvector's arbitrary sign is oriented against the depth-weighted order-flow imbalance so the reading always points the same way."
                      />
                      <DataRow
                        label="PC1 z-score"
                        value={sigma(data.artefacts.mlofi.pc1Z)}
                        hint="Net projection onto the first component as a t-statistic, measured against a neutral book rather than against the window's own mean."
                      />
                      <DataRow
                        label="PC1 explained variance"
                        value={fractionAsPercent(data.artefacts.mlofi.pc1ExplainedVariance)}
                        hint="Share of the order-flow matrix's variance the first component accounts for. A low share means the depth levels are not moving together, so the single scalar carries correspondingly less of the book."
                      />
                      <DataRow label="Queue imbalance" value={ratio(data.artefacts.mlofi.queueImbalance)} />
                      <DataRow label="Depth imbalance" value={ratio(data.artefacts.mlofi.depthImbalance)} />
                    </dl>
                  </Panel>

                  {/*
                    Options panel. Rendered only for a name with a converged fit:
                    an empty smile axis on a non-optionable symbol would imply the
                    surface exists and is flat.
                  */}
                  {series.data?.smile ? (
                    <Panel>
                      <PanelHeader
                        eyebrow="Volatility surface"
                        title={`SABR smile, ${integer(series.data.smile.tau * 365)}-day tenor`}
                        detail="Hagan (2002) lognormal expansion, fitted by Nelder–Mead against the listed call surface. The dots are the quotes it was calibrated to."
                      />
                      <div className="mt-4">
                        <SabrSmile
                          curve={series.data.smile.curve}
                          marketQuotes={series.data.smile.quotes}
                          forward={series.data.smile.forward}
                          strike25Call={series.data.smile.strike25Call}
                          strike25Put={series.data.smile.strike25Put}
                          vol25Call={series.data.smile.vol25Call}
                          vol25Put={series.data.smile.vol25Put}
                          volAtm={series.data.smile.volAtm}
                          riskReversal={series.data.smile.riskReversal}
                        />
                      </div>
                      <dl className="mt-3 space-y-0.5">
                        <DataRow label="α (level)" value={ratio(data.artefacts.sabr?.alpha ?? 0, 4)} />
                        <DataRow label="ρ (spot/vol correlation)" value={ratio(data.artefacts.sabr?.rho ?? 0, 3)} />
                        <DataRow label="ν (vol of vol)" value={ratio(data.artefacts.sabr?.nu ?? 0, 3)} />
                        <DataRow
                          label="Fit RMSE"
                          value={ratio(series.data.smile.rmse, 5)}
                          hint="Root mean squared vol error against the quotes the fit was calibrated to."
                        />
                      </dl>
                    </Panel>
                  ) : null}

                  {/*
                    Alt-data decay. The half-lives are the platform's published
                    profiles, and the marker on each curve is where this symbol's
                    most recent event currently sits — so the panel shows both the
                    rule and its present effect.
                  */}
                  {data.artefacts.altStreams.length > 0 ? (
                    <Panel>
                      <PanelHeader
                        eyebrow="Alt data"
                        title="How fast each stream stops counting"
                        detail="Every alt-data stream is weighted by an exponential decay with a published half-life. A Form 4 still carries weight two months on; Reddit chatter is spent within the hour."
                      />
                      <div className="mt-4">
                        <DecayCurve
                          profiles={data.artefacts.altStreams.map((stream) => ({
                            stream: stream.stream,
                            label: stream.label,
                            halfLifeMs: stream.halfLifeMs,
                            plateauMs: stream.plateauMs,
                            shape: stream.shape,
                            authority: stream.authority,
                            ...(Number.isFinite(stream.freshnessMs) ? { currentAgeMs: stream.freshnessMs } : {}),
                          }))}
                        />
                      </div>
                    </Panel>
                  ) : null}

                  <Panel>
                    <PanelHeader
                      eyebrow="Latency"
                      title="Pipeline budget"
                      detail={`${duration(data.latency.totalMs)} of a ${duration(data.latency.budgetMs)} budget.`}
                    />
                    <div className="mt-3">
                      <LatencyBar
                        stages={data.latency.stages}
                        totalMs={data.latency.totalMs}
                        budgetMs={data.latency.budgetMs}
                        withinBudget={data.latency.withinBudget}
                      />
                    </div>
                    {!data.latency.withinBudget ? (
                      <Notice tone="warning" className="mt-3">
                        The pipeline exceeded its latency budget for this symbol.
                      </Notice>
                    ) : null}
                  </Panel>
                </div>
              </div>

              {/* ── Full feature vector ────────────────────────────────── */}
              <Panel className="mt-5">
                <PanelHeader
                  eyebrow="Feature vector"
                  title={
                    data.attributedInputs > contributions.length
                      ? `Top ${integer(contributions.length)} of ${integer(data.attributedInputs)} attributed inputs`
                      : `All ${integer(contributions.length)} attributed inputs`
                  }
                  detail="Signed share of total attribution: a bar's length is the driver's percentage of Σ|φ|, and its side is whether it pushed the model's probability up or down. Same quantity as the SHARE column above, drawn."
                />
                <div className="scroll-x mt-4">
                  <HoveredFeatureBars
                    items={contributions.map((c) => ({
                      key: c.featureId,
                      label: c.featureDisplayName,
                      // Signed so the centre line separates the drivers pushing the
                      // prediction up from those pushing it down; the magnitude is
                      // the share either way.
                      value:
                        (c.impactDirection === 'positive' ? 1 : -1) * (c.contributionPercentage / 100),
                      signed: true,
                      hint: c.semanticTranslation,
                    }))}
                  />
                </div>
              </Panel>

              <p className="mt-6 font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
                Model {data.modelVersion} · attribution exact to {Math.abs(data.attributionResidual).toExponential(1)} ·
                impersonal computation, not investment advice
              </p>
            </SymbolPageState>
          );
        }}
      </AsyncSlot>
    </PageShell>
  );
}

/**
 * Formats a feature value in its own unit.
 *
 * The unit comes from the registry rather than being inferred from the magnitude:
 * an RSI of 0.42 and a ratio of 0.42 are different claims, and guessing from the
 * number would render one of them wrong.
 */
function formatFeatureValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return '—';
  switch (unit) {
    case 'percent':
      return percent(value, 2);
    case 'zscore':
      return sigma(value);
    case 'currency':
      return price(value);
    case 'ratio':
      return ratio(value);
    case 'days':
      return `${ratio(value)}d`;
    default:
      return ratio(value);
  }
}
