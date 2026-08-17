/**
 * Transparency — the model card, the feature registry and the fusion parameters.
 *
 * The section that matters most is `limitations`, and it is placed above the
 * accuracy figures rather than beneath them. A model card that leads with AUC and
 * buries its caveats is optimised for the reader who stops after the first number,
 * which is the reader most likely to be misled. Leading with what the model cannot
 * do makes the metrics interpretable instead of impressive.
 *
 * The out-of-sample figure is shown next to the in-sample one, always, with the gap
 * between them visible. A single accuracy number is uninterpretable — 81% in-sample
 * and 61% out-of-sample is a specific, useful finding about overfitting, while "81%
 * accurate" is a claim that invites a conclusion the data does not support.
 */

'use client';

import { useState } from 'react';
import { AsyncSlot, PageHeader, PageShell } from '@/components/PageState';
import { FeatureBars } from '@/components/charts';
import {
  Badge,
  Button,
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
import { duration, fractionAsPercent, integer, nyDateTime, percent, ratio } from '@/lib/ui/format';
import type { FeatureGroup } from '@/lib/domain/types';
import { AGENT_DISCRIMINATION_FLOOR } from '@/lib/engine/model';

interface AgentSpec {
  name: string;
  timeframeMinutes: number;
  sequenceLength: number;
  inputSize: number;
  hiddenSize: number;
  architecture: 'lstm' | 'bilstm' | 'tft';
}

interface ModelCardResponse {
  card: {
    version: string;
    createdAt: number;
    seed: number;
    objective: string;
    trees: number;
    leaves: number;
    maxDepth: number;
    featureCount: number;
    expectedValue: number;
    backgroundRows: number;
    backgroundK: number;
    shapEngine: string;
    agents: AgentSpec[];
    training: {
      samples: number;
      validationSamples: number;
      positiveRate: number;
      gbdtTrainLoss: number;
      gbdtValidLoss: number;
      accuracy: number;
      validationAccuracy: number;
      auc: number;
      brier: number;
      discrimination?: { lstm: number; bilstm: number; tft: number };
      lstmValidLoss: number;
      bilstmValidLoss: number;
      tftValidLoss: number;
      elapsedMs: number;
    };
    topFeatures: { feature: string; gain: number; splits: number; share: number }[];
    globalShap: { feature: string; meanAbsShap: number; share: number }[];
    limitations: string[];
  };
  featureCount: number;
  agentFeatureKeys: string[];
  fusion: {
    agentEdge: Record<string, number>;
    regimeOverrideThreshold: number;
    toxicFlowThreshold: number;
    macroVolAmplification: number;
    aggregateNoiseFloor: number;
    kellyFraction: number;
  };
}

interface FeatureState {
  state: string;
  min: number;
  max: number;
  polarity: string;
}

interface FeatureDefinitionView {
  key: string;
  label: string;
  shortLabel: string;
  group: FeatureGroup;
  domain: string;
  unit: string;
  description: string;
  formula: string;
  sqlColumn: string;
  aliases: string[];
  inModel: boolean;
  states: FeatureState[];
}

interface FeaturesResponse {
  count: number;
  modelFeatureCount: number;
  groups: { key: FeatureGroup; label: string; domain: string }[];
  features: FeatureDefinitionView[];
  mappingMatrix: { key: string; template: string; semanticKey: string }[];
}

const ARCHITECTURE_LABELS: Record<AgentSpec['architecture'], string> = {
  lstm: 'LSTM',
  bilstm: 'Bidirectional LSTM',
  tft: 'Temporal Fusion Transformer',
};

export default function TransparencyPage() {
  const model = useApi<ModelCardResponse>('/model-card');
  const features = useApi<FeaturesResponse>('/features');
  const [group, setGroup] = useState<string>('');
  const [modelOnly, setModelOnly] = useState(false);

  return (
    <PageShell wide>
      <PageHeader
        eyebrow="Model card"
        title="Transparency"
        lede="What the ensemble is, how it was fitted, what it measures, and what it cannot tell you. Every parameter that shapes a published signal is listed here."
      />

      <AsyncSlot state={model} label="Loading the model card" lines={8}>
        {(data) => {
          const t = data.card.training;
          const overfitGap = t.accuracy - t.validationAccuracy;

          return (
            <>
              {/* Limitations first, deliberately. */}
              <Panel className="mb-5">
                <PanelHeader
                  eyebrow="Limitations"
                  title="Read this before the metrics"
                  detail="Placed above the accuracy figures because a reader who stops at the first number is the reader most likely to be misled by it."
                />
                <ul className="mt-4 space-y-2.5">
                  {data.card.limitations.map((limitation, i) => (
                    <li key={i} className="flex gap-3 text-[0.8125rem] leading-relaxed text-parchment-dim">
                      <span className="mt-0.5 shrink-0 font-mono text-2xs text-gold">{String(i + 1).padStart(2, '0')}</span>
                      <span>{limitation}</span>
                    </li>
                  ))}
                </ul>
              </Panel>

              <StatGrid className="mb-5" columns={6}>
                <StatTile
                  label="In-sample accuracy"
                  value={fractionAsPercent(t.accuracy)}
                  footnote={`${integer(t.samples)} training samples`}
                />
                <StatTile
                  label="Out-of-sample"
                  value={fractionAsPercent(t.validationAccuracy)}
                  tone={t.validationAccuracy >= 0.55 ? 'gold' : 'burgundy'}
                  footnote={`${integer(t.validationSamples)} held out`}
                />
                <StatTile
                  label="Overfit gap"
                  value={fractionAsPercent(overfitGap)}
                  tone={overfitGap <= 0.15 ? 'sage' : 'burgundy'}
                  footnote="In-sample minus out-of-sample"
                />
                <StatTile
                  label="AUC"
                  value={ratio(t.auc, 3)}
                  tone={t.auc >= 0.6 ? 'sage' : 'burgundy'}
                  footnote="0.5 is a coin flip"
                />
                <StatTile
                  label="Brier score"
                  value={ratio(t.brier, 4)}
                  footnote="Lower is better; 0.25 is uninformative"
                />
                <StatTile
                  label="Base rate"
                  value={fractionAsPercent(t.positiveRate)}
                  footnote="Positive class in training"
                />
              </StatGrid>

              {overfitGap > 0.15 ? (
                <Notice tone="warning" title="Overfitting" className="mb-5">
                  The in-sample and out-of-sample accuracies differ by{' '}
                  {fractionAsPercent(overfitGap)}. Treat the in-sample figure as a description of the training set and
                  the out-of-sample figure as the honest estimate of generalisation. Both are reported so the gap is
                  visible rather than averaged away.
                </Notice>
              ) : null}

              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                <Panel>
                  <PanelHeader eyebrow="Ensemble" title="Gradient-boosted decision trees" detail={data.card.objective} />
                  <dl className="mt-3 space-y-0.5">
                    <DataRow label="Version" value={data.card.version} />
                    <DataRow label="Fitted at" value={nyDateTime(data.card.createdAt)} />
                    <DataRow label="Seed" value={integer(data.card.seed)} hint="Every result on this platform is reproducible from it" />
                    <DataRow label="Trees" value={integer(data.card.trees)} />
                    <DataRow label="Leaves" value={integer(data.card.leaves)} />
                    <DataRow label="Max depth" value={integer(data.card.maxDepth)} />
                    <DataRow label="Features" value={integer(data.card.featureCount)} />
                    <DataRow label="Training loss" value={ratio(t.gbdtTrainLoss, 4)} />
                    <DataRow label="Validation loss" value={ratio(t.gbdtValidLoss, 4)} />
                    <DataRow label="Fit time" value={duration(t.elapsedMs)} />
                  </dl>
                </Panel>

                <Panel>
                  <PanelHeader
                    eyebrow="Attribution engine"
                    title="Exact TreeSHAP"
                    detail={data.card.shapEngine}
                  />
                  <dl className="mt-3 space-y-0.5">
                    <DataRow
                      label="E[f(x)]"
                      value={ratio(data.card.expectedValue, 4)}
                      hint="The base value every waterfall starts from, in log-odds"
                    />
                    <DataRow
                      label="Background rows"
                      value={integer(data.card.backgroundRows)}
                      hint="Summarised training distribution"
                    />
                    <DataRow
                      label="Background clusters"
                      value={integer(data.card.backgroundK)}
                      hint="K selected by the within-cluster sum-of-squares elbow"
                    />
                  </dl>
                  <Divider className="my-4" />
                  <p className="text-[0.75rem] leading-relaxed text-parchment-faint">
                    Attributions are exact rather than sampled, so they satisfy local accuracy: the contributions sum to
                    the model output. Each signal page displays its own residual, which is the arithmetic proof rather
                    than a claim about it.
                  </p>
                </Panel>
              </div>

              <Panel className="mt-5">
                <PanelHeader
                  eyebrow="Temporal agents"
                  title="Three architectures, three timeframes"
                  detail="Each is fitted and validated independently; their validation losses are not comparable to the ensemble's."
                />
                <TableShell className="mt-4">
                  <thead>
                    <tr>
                      <Th>Agent</Th>
                      <Th>Architecture</Th>
                      <Th align="right">Timeframe</Th>
                      <Th align="right">Sequence</Th>
                      <Th align="right">Inputs</Th>
                      <Th align="right">Hidden</Th>
                      <Th align="right">Valid loss</Th>
                      <Th align="right" title="Standard deviation of the agent's probability across the validation split. Near zero means the agent returns the same number whatever it is shown.">
                        Spread
                      </Th>
                      <Th align="right">Edge</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.card.agents.map((agent) => {
                      const loss =
                        agent.architecture === 'lstm'
                          ? t.lstmValidLoss
                          : agent.architecture === 'bilstm'
                            ? t.bilstmValidLoss
                            : t.tftValidLoss;
                      const edge = data.fusion.agentEdge[`${agent.timeframeMinutes}m`];
                      const spread = t.discrimination?.[agent.architecture] ?? 0;
                      return (
                        <tr key={agent.name}>
                          <Td>{agent.name}</Td>
                          <Td>
                            <Badge tone="ghost">{ARCHITECTURE_LABELS[agent.architecture]}</Badge>
                          </Td>
                          <Td align="right" numeric>
                            {integer(agent.timeframeMinutes)}m
                          </Td>
                          <Td align="right" numeric>
                            {integer(agent.sequenceLength)}
                          </Td>
                          <Td align="right" numeric>
                            {integer(agent.inputSize)}
                          </Td>
                          <Td align="right" numeric>
                            {integer(agent.hiddenSize)}
                          </Td>
                          <Td align="right" numeric>
                            {ratio(loss, 4)}
                          </Td>
                          {/*
                            Published because an agent that has collapsed to a
                            constant still reports an ordinary loss — a fixed
                            prediction on a balanced set is unremarkable by that
                            measure — and only the spread shows it. An agent below
                            the floor is given no weight by the router, so the
                            reader can see which agents are actually voting.
                          */}
                          <Td align="right" numeric>
                            <span className={spread < AGENT_DISCRIMINATION_FLOOR ? 'text-burgundy-bright' : undefined}>
                              {ratio(spread, 4)}
                            </span>
                          </Td>
                          <Td align="right" numeric>
                            {edge === undefined ? '—' : ratio(edge, 3)}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </TableShell>
              </Panel>

              <Panel className="mt-5">
                <PanelHeader
                  eyebrow="Fusion parameters"
                  title="How the agents are combined"
                  detail="Fixed, published constants. They do not vary by user, by symbol or by session."
                />
                <StatGrid className="mt-4" columns={5}>
                  <StatTile
                    label="Regime override"
                    value={ratio(data.fusion.regimeOverrideThreshold, 2)}
                    footnote="Confidence above which the regime label overrides the aggregate"
                  />
                  <StatTile
                    label="Toxic flow abort"
                    value={ratio(data.fusion.toxicFlowThreshold, 2)}
                    footnote="VPIN above which no signal is published"
                  />
                  <StatTile
                    label="Macro amplification"
                    value={ratio(data.fusion.macroVolAmplification, 2)}
                    footnote="Weight shift toward the hourly agent in high volatility"
                  />
                  <StatTile
                    label="Noise floor"
                    value={ratio(data.fusion.aggregateNoiseFloor, 2)}
                    footnote="Aggregate below this is treated as no signal"
                  />
                  <StatTile
                    label="Kelly fraction"
                    value={ratio(data.fusion.kellyFraction, 2)}
                    footnote="Half-Kelly, published as a model statistic only"
                  />
                </StatGrid>
              </Panel>

              <div className="mt-5 grid gap-5 lg:grid-cols-2">
                <Panel>
                  <PanelHeader
                    eyebrow="Split gain"
                    title="Which features the trees actually use"
                    detail="Total gain across every split, normalised. This is a property of the fitted structure, not of any one prediction."
                  />
                  <div className="scroll-x mt-4">
                    <FeatureBars
                      items={data.card.topFeatures.slice(0, 14).map((f) => ({
                        key: f.feature,
                        label: f.feature,
                        value: f.share,
                        hint: `${integer(f.splits)} splits, gain ${ratio(f.gain, 2)}`,
                      }))}
                    />
                  </div>
                </Panel>

                <Panel>
                  <PanelHeader
                    eyebrow="Global attribution"
                    title="Mean |SHAP| across the background"
                    detail="Averaged attribution magnitude — how much each feature moves predictions in general, as distinct from how often it is split on."
                  />
                  <div className="scroll-x mt-4">
                    <FeatureBars
                      items={data.card.globalShap.slice(0, 14).map((f) => ({
                        key: f.feature,
                        label: f.feature,
                        value: f.share,
                        hint: `mean |φ| ${ratio(f.meanAbsShap, 4)}`,
                      }))}
                    />
                  </div>
                </Panel>
              </div>
            </>
          );
        }}
      </AsyncSlot>

      {/* ── Feature registry ─────────────────────────────────────────── */}
      <AsyncSlot state={features} label="Loading the feature registry" lines={8}>
        {(data) => {
          const shown = data.features.filter(
            (f) => (group === '' || f.group === group) && (!modelOnly || f.inModel),
          );
          return (
            <Panel className="mt-5" padded={false}>
              <div className="p-5 pb-0">
                <PanelHeader
                  eyebrow="Feature registry"
                  title={`${integer(shown.length)} of ${integer(data.count)} features`}
                  detail={`${integer(data.modelFeatureCount)} are consumed by the ensemble; the rest are published for inspection and are queryable.`}
                  action={
                    <div className="flex flex-wrap gap-1.5">
                      {/*
                        Offered only when it would change the list. Every feature
                        in the registry is currently consumed by the ensemble, so
                        the control was rendering a button that produced a
                        byte-identical table — a filter that silently does nothing
                        reads as a broken control, not as an informative one.
                      */}
                      {data.modelFeatureCount < data.count ? (
                        <Button
                          size="sm"
                          variant={modelOnly ? 'primary' : 'ghost'}
                          onClick={() => setModelOnly((v) => !v)}
                          aria-pressed={modelOnly}
                        >
                          In model only
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant={group === '' ? 'primary' : 'ghost'}
                        onClick={() => setGroup('')}
                        // Styled as pressed when no group filter is set; the
                        // group chips below it all say so, this one did not.
                        aria-pressed={group === ''}
                      >
                        All groups
                      </Button>
                    </div>
                  }
                />
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {data.groups.map((g) => (
                    <button
                      key={g.key}
                      type="button"
                      onClick={() => setGroup(group === g.key ? '' : g.key)}
                      aria-pressed={group === g.key}
                      className={`border px-2 py-[3px] font-mono text-2xs uppercase tracking-institutional transition-colors ${
                        group === g.key
                          ? 'border-gold/60 bg-gold/[0.09] text-gold'
                          : 'border-obsidian-edge text-parchment-dim hover:border-parchment-ghost'
                      }`}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
              </div>

              <TableShell className="mt-4">
                <thead>
                  <tr>
                    <Th>Feature</Th>
                    <Th>Group</Th>
                    <Th>Unit</Th>
                    <Th>Formula</Th>
                    <Th>Description</Th>
                    <Th align="center">In model</Th>
                    <Th align="right">States</Th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((feature) => (
                    <tr key={feature.key}>
                      <Td>
                        <span className="text-parchment">{feature.label}</span>
                        <span className="ml-2 font-mono text-2xs text-parchment-ghost">{feature.sqlColumn}</span>
                      </Td>
                      <Td>
                        <span className="text-2xs text-parchment-dim">{feature.group.replace(/_/g, ' ')}</span>
                      </Td>
                      <Td>
                        <span className="text-2xs text-parchment-faint">{feature.unit}</span>
                      </Td>
                      <Td>
                        <code className="font-mono text-2xs text-parchment-dim">{feature.formula}</code>
                      </Td>
                      <Td>
                        <span className="text-2xs leading-snug text-parchment-faint">{feature.description}</span>
                      </Td>
                      <Td align="center">
                        {feature.inModel ? <Badge tone="sage">yes</Badge> : <Badge tone="ghost">no</Badge>}
                      </Td>
                      <Td align="right" numeric>
                        {integer(feature.states.length)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>

              <div className="border-t border-obsidian-edge p-5">
                <PanelHeader
                  eyebrow="Narrative templates"
                  title="How a state becomes a sentence"
                  detail="Every driver sentence on this platform comes from this fixed matrix, so the same discretised state always yields the same wording. Nothing is generated per request."
                />
                <ul className="mt-4 space-y-2.5">
                  {data.mappingMatrix.map((entry) => (
                    <li key={entry.key}>
                      {/*
                        The key is a pipe-delimited machine identifier
                        (`insider_form4_score|positive|STATE_INSIDER_ACCUMULATION`)
                        with no space to wrap at, so without `break-words` it runs
                        past the panel and takes the page's horizontal scroll with
                        it — 14px of body overflow on a 390px viewport.
                      */}
                      <p className="break-words font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
                        {entry.key}
                      </p>
                      <p className="mt-1 text-[0.8125rem] leading-relaxed text-parchment-dim">{entry.template}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </Panel>
          );
        }}
      </AsyncSlot>

      <Panel className="mt-5">
        <PanelHeader eyebrow="Reproducibility" title="Why every figure here is checkable" />
        <p className="mt-3 text-[0.8125rem] leading-relaxed text-parchment-dim">
          The market simulator, the training split, the K-Means background summary and the narrative engine are all
          deterministic in a single seed. Two machines running the same seed produce byte-identical signals, which is
          what makes a published attribution auditable months later rather than merely plausible at the time.
        </p>
        <div className="mt-4">
          <Meter value={1} tone="gold" />
        </div>
      </Panel>

      <p className="mt-6 font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
        {percent(100, 0)} of published figures derive from the parameters on this page
      </p>
    </PageShell>
  );
}
