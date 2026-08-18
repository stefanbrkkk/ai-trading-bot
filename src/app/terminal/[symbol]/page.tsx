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
import { motion, useReducedMotion } from 'framer-motion';
import { useParams } from 'next/navigation';
import { useActiveSymbol } from '@/components/TerminalProvider';
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
  bps,
  duration,
  fixed,
  fractionAsPercent,
  sessionHalfLife,
  integer,
  money,
  nyDateTime,
  percent,
  price,
  ratio,
  sigma,
  signedFractionAsPercent,
} from '@/lib/ui/format';
import type { FeatureGroup, FeatureUnit, RegimeLabel, SignalDirection } from '@/lib/domain/types';

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
  /**
   * The registry's own unit, not a free string.
   *
   * It was typed `string`, which is why the VALUE column and the sentence beside
   * it could disagree in silence: `formatFeatureValue` below handled four of the
   * twelve members — plus a fifth case, `'days'`, that has never been one — and
   * dropped the other eight into a bare three-decimal ratio, none of which was a
   * compile error. Narrowing the type is what makes the next unit added to
   * `FeatureUnit` fail the build here.
   */
  unit: FeatureUnit;
  /**
   * The raw value formatted by the feature registry — the one authoritative
   * rendering of this number.
   *
   * `semanticTranslation` embeds the registry's string ("Liquidity score at
   * 89.4%"), so anything the VALUE cell formats for itself is a second opinion
   * about a number the reader can see twice in one row. It read `0.894` beside
   * `89.4%`, `0.193` beside `19.3%`, `−69.316` beside `−69.32 bp`.
   *
   * Optional only because the field is new: `/api/signals/[symbol]` has to
   * publish it (`formatRaw` in `lib/engine/compute` is the same call the
   * narrative already makes), and until it does the fallback below stands in.
   * Once it is always present this becomes required and the fallback goes.
   */
  featureValueFormatted?: string;
}

interface WaterfallStep {
  label: string;
  shap: number;
  cumulative: number;
  cumulativeProbability: number;
  direction: 'positive' | 'negative';
  /**
   * |φ| / Σ|φ| over the whole attribution, published by the engine.
   *
   * The chart used to divide by the sum of the rows it was handed, which is a
   * subset, so one driver read 17% here, 12% in the force plot and 11.9% in the
   * table below. The denominator is now decided once, server-side.
   */
  share: number;
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
 * Collapsed to zero height rather than to `display: none`: the chart measures
 * itself off its own `getBoundingClientRect`, and a `display: none` subtree
 * measures zero, so the pane would have to lay out from scratch on reveal —
 * exactly the cost this is avoiding. Zero height keeps the width real and clips
 * the drawing instead.
 *
 * The height is *animated* to zero, over the same 180 ms as the fade, because a
 * class that flipped `h-0` on synchronously split one gesture into two unrelated
 * events. Sampled per frame across a press of Force, the pane went 508 px →
 * 132 px in a single frame — dragging the drivers heading below it 355 px up the
 * document and taking 355 px off the page's height — while the crossfade that
 * same press had started still had ~190 ms to run. Worse, the outgoing pane was
 * already clipped to nothing on the frame its opacity still read 1.000, so its
 * whole fade-out was drawn inside a zero-height box and never seen: 180 ms of
 * animation work, none of it visible. Easing both heights with one curve makes
 * the container's travel from 508 to 132 monotonic and puts the fade where it
 * can be watched.
 *
 * Overlapping the two panes in a single grid cell would hold the geometry
 * perfectly still, and it is the wrong trade here: the waterfall is roughly four
 * times the height of the force plot, so the cell would size to the waterfall
 * and the force view would carry ~376 px of empty panel beneath it — for good,
 * rather than for 180 ms.
 *
 * `initial={false}` so the pane `useIdleMount` brings in late appears in its
 * resting state instead of animating out of whatever the DOM happened to read.
 *
 * `inert` is what makes it honest: both charts put `tabIndex={0}` on every
 * driver, so a hidden-but-mounted pane would otherwise be eight invisible tab
 * stops. `aria-hidden` alone does not stop focus.
 *
 * `useReducedMotion` because Framer writes opacity and height straight to
 * `style` from JavaScript, where the blanket `prefers-reduced-motion` rule in
 * `globals.css` cannot reach them — it can only zero a CSS transition. Every
 * other motion component in the product asks; this one did not, and still
 * tweened through ten intermediate frames for a reader who had said no.
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
  // Before the `mounted` guard: a hook cannot live behind an early return.
  const reduceMotion = useReducedMotion();
  if (!mounted) return null;
  /*
   * `grid-template-rows: 0fr → 1fr`, not `height: 0 → auto`.
   *
   * Animating to `auto` means the runtime has to learn the natural height, and
   * it learns it by laying the collapsed subtree out synchronously at the moment
   * of the transition. For the force plot that is a 10-segment SVG whose layout
   * has never been computed, so the whole cost landed on the user's first press:
   * measured at 4x CPU throttle, 226 ms from click to painted frame on toggle
   * one against 49-60 ms on every toggle after it.
   *
   * A grid track interpolates between 0fr and 1fr without anyone naming a pixel
   * height, so there is no measurement pass and no first-press penalty. The
   * child carries `min-h-0` because a grid item's default `min-height: auto`
   * refuses to shrink below its content and would defeat the collapse entirely.
   * Where the browser will not animate the track it snaps instead, which is the
   * same thing reduced-motion asks for.
   */
  return (
    <div
      className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
      style={{ gridTemplateRows: active ? '1fr' : '0fr' }}
      aria-hidden={!active}
      inert={!active}
    >
      <motion.div
        className="min-h-0 overflow-hidden"
        initial={false}
        animate={{ opacity: active ? 1 : 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.18, ease: 'easeOut' }}
      >
        {children}
      </motion.div>
    </div>
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
  // `prewarmMorph` on the same idle signal that mounts the hidden pane: this
  // dial is the one in the product that certainly will morph, so building its
  // path interpolator early costs nobody anything and takes the whole of it off
  // the first press.
  return (
    <ConvictionDial
      {...props}
      morph={useContext(ViewContext) === 'force' ? 1 : 0}
      prewarmMorph={useIdleMount()}
    />
  );
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
  signalDirection,
}: {
  waterfall: SignalResponse['waterfall'];
  steps: ComponentProps<typeof ShapWaterfall>['steps'];
  forceContributions: ComponentProps<typeof ShapForcePlot>['contributions'];
  residual: number;
  /*
   * The published side, forwarded so both charts colour and label a driver by
   * whether it argues FOR the call rather than by the sign of phi. On a short
   * those are opposites, and the sentence beside the chart already resolves it
   * the signal-relative way.
   */
  signalDirection: SignalResponse['direction'];
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
            signalDirection={signalDirection}
          />
        </AttributionPane>
        <AttributionPane active={view === 'force'} mounted={idleReady || view === 'force'}>
          <HoveredShapForcePlot
            baseValue={waterfall.baseValue}
            baseProbability={waterfall.baseProbability}
            finalProbability={waterfall.finalProbability}
            contributions={forceContributions}
            signalDirection={signalDirection}
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
  /**
   * Clamped to the same 12 characters the order APIs already enforce.
   *
   * The route parameter is user-supplied and lands in the request path, so the
   * server's "X is not in the tradable universe." comes back with all of it
   * inside — and that message renders as one unbreakable word. 300 A's in the
   * URL made the document 3015px wide at a 1440px viewport, so the whole page
   * scrolled sideways and every panel on it ran 1575px past the right edge. The
   * published universe tops out at five characters, so nothing legitimate is
   * truncated; 12 is the bound `/api/orders/*` and `/api/intent` already refuse
   * to exceed, and matching it keeps one number in the product rather than two.
   */
  const symbol = (params.symbol ?? '').toUpperCase().slice(0, 12);
  // Publishes the symbol to the terminal store, so the footer's FOCUS field
  // names what this route is showing instead of reading NONE.
  useActiveSymbol(symbol);

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
                {/*
                  The rendered height is reserved, not the skeleton's.

                  The chart series resolves after the signal, and the six-line
                  skeleton is ~235px shorter than the chart that replaces it. On
                  a 1440x900 viewport that late growth pushed the attribution
                  panel below the fold *after* its in-view gate had already
                  fired, so the SHAP waterfall played its entrance where nobody
                  could see it and was simply finished by the time it was
                  scrolled to. Reserving the full height means resolving the
                  series moves nothing.
                */}
                <div className="min-h-[520px]">
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
                </div>
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
                        Named for what it measures, which is not what an earlier
                        version of this comment said it was.

                        `Signal.probability` is oriented to the published side —
                        the pipeline publishes `1 − p` on a short — so it is the
                        model's confidence in the call being shown, not a raw
                        P(beats benchmark) that happens to sit beside a badge
                        arguing the other way. It also can no longer be below
                        50% on a directional name: the tree holds a veto over the
                        router's side, and a disagreement publishes flat rather
                        than a SHORT under a 57% chance of going up.

                        The waterfall's f(x) directly below is the unoriented
                        number and will read as the complement on a short. That
                        is the decomposition of the model output, and it is
                        labelled as such.
                      */}
                      <DataRow
                        label="Confidence in this call"
                        value={fractionAsPercent(data.predictionProbability)}
                        hint="Calibrated probability that the published direction beats the benchmark over the horizon"
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
                    signalDirection={data.direction}
                  />

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

              {/* ── Driver table ──────────────────────────────────────── */}
              {/*
                Below the grid rather than inside it, and at the shell's full
                width.

                This table was what made the grid's right-hand column 1999px tall
                at 1440 while the rail on its left ran out of content at 1013px —
                986px of empty black, 49% of the row, and 57% of it at 1280. The
                rail is a fixed 320px of dial, published levels and a legal
                notice, and there is nothing honest to add to it, so the tall
                thing moves rather than the short one growing. With the table
                gone, the attribution panel and the counter-thesis under it come
                out close to the rail's height and the void closes; the table
                gains about 340px of width on the way out, which the
                interpretation sentences spend far better than the void did.
              */}
              <Panel padded={false} className="mt-5">
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
                  clipping it. Inside the 838px column this panel used to sit in,
                  `minWidth: 900` pushed the table 62px past it — 222px at 1280 —
                  so every interpretation sentence ran off the right edge
                  mid-word, behind a horizontal scrollbar, on the page whose
                  entire purpose is reading those sentences. The panel now spans
                  the shell, which is where those sentences wanted to be all
                  along; 560 is what keeps the sentence column legible on a phone
                  and gets out of the way above it.
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
                          {c.featureValueFormatted ?? formatFeatureValue(c.featureValueRaw, c.unit)}
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

              {/* ── Agents and router ──────────────────────────────────── */}
              {/*
                `items-start`, deliberately, and only on the grids that pair two
                panels of genuinely different length.

                Equal-height cards are the right default and are relied on
                elsewhere (see `src/app/terminal/page.tsx`, which says so). Here
                the two panels are a fixed three-row summary beside a list that
                grows with the data, so stretching left 31–39% of one card as
                empty ground with a border drawn around it — which reads as
                content that failed to load rather than as a card that is simply
                shorter.
              */}
              <div className="mt-5 grid items-start gap-5 lg:grid-cols-2">
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
 * Formats a feature value in its own unit — the fallback, not the authority.
 *
 * `Contribution.featureValueFormatted` is the authority: the string the feature
 * registry itself produced, which is the same string already embedded in the
 * interpretation sentence in this row. This function runs only for a payload
 * that predates that field, and it is written this way so the two can no longer
 * disagree about *what kind of quantity* a number is.
 *
 * They did. Typed `unit: string` with a `default` arm, it recognised four of the
 * twelve units and dropped the other eight into a bare three-decimal ratio — so
 * `bps`, `probability`, `index_0_100`, `bars`, `shares`, `volpoints`,
 * `signed_unit` and `count` all rendered as plain decimals. A probability
 * rendered `0.894` in the VALUE column beside "(Liquidity score at 89.4%)" in
 * the sentence next to it, basis points rendered `−69.316` beside "−69.32 bp",
 * and an explained-variance share rendered `0.193` beside "19.3%". It also
 * carried a `'days'` case for a unit `FeatureUnit` has never had. Taking
 * `FeatureUnit` and dropping the `default` arm is what turns the next unit added
 * to the registry into a compile error here instead of another silent `ratio()`.
 *
 * The unit is still what selects the arm, and it comes from the registry rather
 * than being inferred from the magnitude: an RSI of 0.42 and a ratio of 0.42 are
 * different claims, and guessing from the number would render one of them wrong.
 *
 * The arms mirror `formatFeatureValue` in `lib/engine/features`, with one
 * residual difference: that function reads each feature's own `precision`, which
 * this payload does not carry, so a unit whose features do not share a precision
 * can still round a digit differently. That is why the published string wins
 * wherever it exists, and why this should be deleted once the route always
 * sends it.
 */
function formatFeatureValue(value: number, unit: FeatureUnit): string {
  if (!Number.isFinite(value)) return '—';
  switch (unit) {
    case 'percent':
      return percent(value, 2);
    case 'bps':
      return bps(value, 2);
    case 'volpoints':
      // No leading '+': the registry prints a sign only when it is negative.
      return `${fixed(value, 2)} vp`;
    case 'probability':
      // A probability is published as a percentage, never as its own decimal.
      return fractionAsPercent(value, 1);
    case 'zscore':
      return sigma(value);
    case 'signed_unit':
      return `${value >= 0 ? '+' : ''}${fixed(value, 3)}`;
    case 'bars':
      return `${fixed(value, 1)} bars`;
    case 'currency':
      // `money`, not `price`: the registry's currency arm carries the '$'.
      return money(value);
    case 'shares':
      return integer(value);
    case 'index_0_100':
      return fixed(value, 1);
    case 'count':
      return fixed(value, 0);
    case 'ratio':
      return ratio(value);
  }
}
