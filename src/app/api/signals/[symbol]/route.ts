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
import { ApiError, handler, ok, parseQuery, pendingSetup } from '@/lib/api/respond';
import { getSignal } from '@/lib/engine/service';
import { resolveMarketProvider } from '@/lib/market/provider';
import { requireSpec } from '@/lib/market/universe';
import { MLOFI_LEVELS } from '@/lib/quant/orderflow';
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
    return pendingSetup('ENGINE_NOT_READY', error instanceof Error ? error.message : 'Engine unavailable.');
  }

  const { signal, features, router, strategies, explanation } = result;

  /*
   * The book the MLOFI vector was computed from.
   *
   * The pipeline consumes the depth sequence and publishes only what it derived
   * from it, so the snapshot itself has to be read back here. It is read at
   * `features.now` — the pipeline's own evaluation instant, which travels on the
   * computed features and survives the engine's per-bucket cache — and the depth
   * model every provider serves the book from is deterministic in that instant.
   * So this is the same snapshot the PCA was fitted over, not a fresher one that
   * would leave the published loadings describing a book nobody is looking at.
   *
   * A failed read degrades to no book rather than to a 500: the ladder is one
   * panel of an attribution page, and the decomposition above does not depend on
   * it.
   */
  const books = await resolveMarketProvider()
    .orderBook(symbol, features.now, MLOFI_LEVELS)
    .catch(() => []);
  const book = books[books.length - 1] ?? null;

  // Group the drivers into the three mandated domain arrays.
  const byDomain: Record<'technical' | 'fundamental' | 'sentiment', typeof signal.drivers> = {
    technical: [],
    fundamental: [],
    sentiment: [],
  };
  for (const driver of signal.drivers) {
    byDomain[domainForFeature(driver.featureKey, driver.group)].push(driver);
  }

  /*
   * The published share is the driver's own `share`, not a second one computed
   * here.
   *
   * Recomputing `|φ| / Σ|φ|` over `signal.drivers` used a different denominator
   * from the engine's — the engine's share is taken over the full attribution,
   * this sum only over the drivers that survived ranking — so the same row showed
   * "31.9%" in its SHARE cell and "a 19% headwind" in the sentence beside it, and
   * the thesis above quoted a third figure. One number, published once.
   */
  const contributions = signal.drivers.map((d) => ({
    featureId: d.featureKey,
    featureDisplayName: d.label,
    featureValueRaw: d.value,
    contributionPercentage: Math.max(0, Math.min(100, d.share * 100)),
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
    /*
     * The engine's own explanation, not a reconstruction of it.
     *
     * This used to be rebuilt from the twelve translated drivers with
     * `baseValue: 0` — a different object with the same shape. It began at
     * sigmoid(0) = 50% under a label reading "E[f(x)] over the K-Means
     * background", it ended at the sum of twelve values instead of at f(x), and
     * the gap between that end point and the published probability measured up
     * to 4.4 percentage points, directly beneath a footer certifying the
     * attribution exact to 3.3e-16. Passing the real explanation makes the chart
     * the thing the page says it is: `shapWaterfall` folds everything outside the
     * top eight into a labelled remainder, so the bars still sum to f(x).
     */
    waterfall: shapWaterfall(explanation, 8),
    /**
     * How many features the explanation actually attributes.
     *
     * The page used to head this panel "All {n} attributed inputs" from the
     * length of the translated driver list, which `translateExplanation` caps at
     * twelve — while the waterfall beside it showed "73 other drivers". Sending
     * the real total lets the page say "top 12 of 81" instead of calling twelve
     * of eighty-one "all".
     */
    attributedInputs: explanation.values.length,
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
      /*
       * The depth snapshot behind that vector, trimmed to the M levels the
       * ladder draws and to the two numbers it draws them from.
       *
       * Lean on purpose: the engine holds sixty snapshots of the book, and all
       * sixty are needed to difference the order-flow increments, but exactly one
       * is needed to show the reader the depth those increments came out of.
       * Null when no book was received, which the ladder renders as its own
       * empty state.
       */
      book:
        book === null
          ? null
          : {
              timestamp: book.timestamp,
              bids: book.bids.slice(0, MLOFI_LEVELS).map((l) => ({ price: l.price, size: l.size })),
              asks: book.asks.slice(0, MLOFI_LEVELS).map((l) => ({ price: l.price, size: l.size })),
            },
      micro: features.artefacts.micro,
      sabr: features.artefacts.sabr,
      skew: features.artefacts.skew,
      altStreams: features.artefacts.altStreams,
      altComposite: features.artefacts.altComposite,
    },
  });
});
