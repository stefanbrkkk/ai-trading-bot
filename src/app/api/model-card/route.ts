/**
 * The model card.
 *
 * Published because SEC "AI washing" enforcement makes an unsubstantiated
 * capability claim an anti-fraud exposure. The card states the architecture, the
 * training data, the measured out-of-sample performance and — importantly — the
 * limitations, so marketing can be checked against it.
 */

import { handler, ok, pendingSetup } from '@/lib/api/respond';
import { tryLoadModelBundle } from '@/lib/engine/store';
import { MODEL_FEATURE_KEYS, FEATURE_DEFINITIONS } from '@/lib/engine/features';
import { AGENT_FEATURE_KEYS } from '@/lib/engine/model';
import { AGENT_EDGE, AGGREGATE_NOISE_FLOOR, KELLY_FRACTION, MACRO_VOL_AMPLIFICATION, REGIME_OVERRIDE_THRESHOLD, TOXIC_FLOW_THRESHOLD } from '@/lib/engine/router';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const model = tryLoadModelBundle();
  if (!model) {
    return pendingSetup(
      'MODEL_NOT_TRAINED',
      'No trained ensemble is present in this deployment.',
    );
  }
  const card = model.card();
  return ok({
    card,
    featureCount: MODEL_FEATURE_KEYS.length,
    agentFeatureKeys: AGENT_FEATURE_KEYS,
    featureGroups: FEATURE_DEFINITIONS.map((f) => ({
      key: f.key,
      label: f.label,
      group: f.group,
      unit: f.unit,
      formula: f.formula,
      description: f.description,
      inModel: f.inModel,
      states: f.states.map((s) => ({ state: s.state, min: s.min, max: s.max, polarity: s.polarity })),
    })),
    fusion: {
      agentEdge: AGENT_EDGE,
      regimeOverrideThreshold: REGIME_OVERRIDE_THRESHOLD,
      toxicFlowThreshold: TOXIC_FLOW_THRESHOLD,
      macroVolAmplification: MACRO_VOL_AMPLIFICATION,
      aggregateNoiseFloor: AGGREGATE_NOISE_FLOOR,
      kellyFraction: KELLY_FRACTION,
    },
    /*
     * The reliability curve, lifted out of `card.training` into the exact shape
     * the calibration panel takes as props. It also travels inside the card,
     * where it belongs as a training metric, but the page should not have to
     * know which corner of the card a chart's data lives in.
     *
     * `curve` is empty for any bundle trained before the curve was recorded, and
     * `ece` is null on the same bundles. Both are published as measured: the
     * panel renders its own empty state instead of the platform inventing a
     * calibration it has not measured.
     */
    calibration: {
      curve: card.training.reliability,
      brier: card.training.brier,
      ece: card.training.ece,
      validationSamples: card.training.validationSamples,
    },
  });
});
