/**
 * The full XAI payload for one symbol.
 *
 * Everything the client needs is pre-computed here: contributions are sorted by
 * descending |SHAP|, `contributionPercentage` is normalised server-side, and each
 * driver arrives with its hydrated narrative. The research is explicit that the
 * React runtime must perform zero mathematical aggregation — so this response is
 * shaped for direct rendering, not for client-side transformation.
 */

import { z } from 'zod';
import { ApiError, handler, ok, parseQuery } from '@/lib/api/respond';
import { getSignal } from '@/lib/engine/service';
import { requireSpec } from '@/lib/market/universe';
import { shapWaterfall } from '@/lib/quant/shap';
import { domainForFeature } from '@/lib/engine/narrative';
import { featureDefinition } from '@/lib/engine/features';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ horizon: z.coerce.number().int().min(1).max(30).optional() });

export const GET = handler(async (request: Request, context: { params: Promise<{ symbol: string }> }) => {
  const { symbol: raw } = await context.params;
  const symbol = raw.toUpperCase();
  const { horizon } = parseQuery(request, querySchema);

  try {
    requireSpec(symbol);
  } catch {
    throw new ApiError('UNKNOWN_SYMBOL', `${symbol} is not in the tradable universe.`, 404);
  }

  let result;
  try {
    result = await getSignal(symbol, horizon === undefined ? {} : { horizonDays: horizon });
  } catch (error) {
    throw new ApiError('ENGINE_NOT_READY', error instanceof Error ? error.message : 'Engine unavailable.', 503);
  }

  const { signal, features, router, strategies } = result;

  // Group the drivers into the three mandated domain arrays.
  const byDomain: Record<'technical' | 'fundamental' | 'sentiment', typeof signal.drivers> = {
    technical: [],
    fundamental: [],
    sentiment: [],
  };
  for (const driver of signal.drivers) {
    byDomain[domainForFeature(driver.featureKey, driver.group)].push(driver);
  }

  const total = signal.drivers.reduce((a, d) => a + Math.abs(d.shap), 0);
  const contributions = signal.drivers.map((d) => ({
    featureId: d.featureKey,
    featureDisplayName: d.label,
    featureValueRaw: d.value,
    contributionPercentage: total === 0 ? 0 : (Math.abs(d.shap) / total) * 100,
    impactDirection: d.direction,
    semanticTranslation: d.narrative,
    state: d.state,
    group: d.group,
    domain: domainForFeature(d.featureKey, d.group),
    unit: featureDefinition(d.featureKey)?.unit ?? 'ratio',
  }));

  return ok({
    assetIdentifier: signal.symbol,
    timestamp: signal.generatedAt,
    convictionScore: signal.conviction,
    predictionProbability: signal.probability,
    direction: signal.direction,
    horizonDays: signal.horizonDays,
    referencePrice: signal.referencePrice,
    expectedReturn: signal.expectedReturn,
    expectedReturnLow: signal.expectedReturnLow,
    expectedReturnHigh: signal.expectedReturnHigh,
    levels: signal.levels,
    regime: signal.regime,
    strategy: signal.strategy,
    strategiesFired: signal.strategiesFired,
    thesis: signal.thesis,
    counterThesis: signal.counterThesis,
    modelVersion: signal.modelVersion,
    attributionResidual: signal.attributionResidual,
    latency: signal.latency,
    xaiBreakdown: byDomain,
    contributions,
    waterfall: shapWaterfall(
      {
        values: signal.drivers.map((d) => d.shap),
        baseValue: 0,
        rawPrediction: signal.drivers.reduce((a, d) => a + d.shap, 0),
        probability: signal.probability,
        featureNames: signal.drivers.map((d) => d.label),
        featureValues: signal.drivers.map((d) => d.value),
      },
      8,
    ),
    agents: signal.agents,
    router: {
      action: router.action,
      aggregateDirection: router.aggregateDirection,
      compositeProbability: router.compositeProbability,
      weights: router.weights,
      regimeOverrideApplied: router.regimeOverrideApplied,
      rationale: router.rationale,
      /**
       * The Kelly exposure fraction. Published as an impersonal model statistic
       * only: it is computed from the aggregate signal alone, never from an
       * account, and the order ticket does not read it.
       */
      modelExposureFraction: router.optimalSize,
    },
    strategies: strategies.map((s) => ({
      id: s.id,
      name: s.name,
      fired: s.fired,
      direction: s.direction,
      conviction: s.conviction,
      gates: s.gates,
      rationale: s.rationale,
      levels: s.levels,
    })),
    features: signal.features,
    artefacts: {
      price: features.artefacts.price,
      previousClose: features.artefacts.previousClose,
      changePercent: features.artefacts.changePercent,
      atr: features.artefacts.atr,
      vwap: features.artefacts.vwapValue,
      ou: {
        theta: features.artefacts.ou.theta,
        mu: features.artefacts.ou.mu,
        sigma: features.artefacts.ou.sigma,
        halfLife: Number.isFinite(features.artefacts.ou.halfLife) ? features.artefacts.ou.halfLife : null,
        equilibriumSigma: features.artefacts.ou.equilibriumSigma,
        rSquared: features.artefacts.ou.rSquared,
        meanReverting: features.artefacts.ou.meanReverting,
        band: features.artefacts.ouBand,
      },
      kalman: features.artefacts.kalman,
      mlofi: {
        intent: features.artefacts.mlofi.intent,
        pc1Z: features.artefacts.mlofi.pc1Z,
        pc1ExplainedVariance: features.artefacts.mlofi.pc1ExplainedVariance,
        pc1Loadings: features.artefacts.mlofi.pc1Loadings,
        levels: features.artefacts.mlofi.levels,
        queueImbalance: features.artefacts.mlofi.queueImbalance,
        depthImbalance: features.artefacts.mlofi.depthImbalance,
      },
      micro: features.artefacts.micro,
      sabr: features.artefacts.sabr,
      skew: features.artefacts.skew,
      altStreams: features.artefacts.altStreams,
      altComposite: features.artefacts.altComposite,
    },
  });
});
