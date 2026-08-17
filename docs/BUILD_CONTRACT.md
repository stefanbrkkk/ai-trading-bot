# Project Aurelius — internal build contract

Read this before writing any module. It is the shared contract that keeps the
subsystems consistent.

## Hard rules

1. **TypeScript strict.** `tsconfig.json` sets `strict`, `noUnusedLocals`,
   `noUnusedParameters`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.
   `@typescript-eslint/no-explicit-any` is an **error** — never use `any`. Use
   `unknown` plus a narrowing guard.
2. **No new dependencies.** The installed set is exactly: `next@15.5.23`,
   `react@19.2`, `zustand@5`, `framer-motion@12`, `flubber@0.4.2`, `zod@3.25`,
   `node-sql-parser@5.4`, and dev-only `vitest@3.2`, `@playwright/test`,
   `tailwindcss@3.4`, `eslint`. Node built-ins are fine (`node:crypto`,
   `node:sqlite`, `node:fs`). Nothing else may be added.
3. **Zero required configuration.** Every subsystem must work with a completely
   empty `.env`. API keys are optional switches, never preconditions. When a key
   is absent, fall back to a deterministic in-process implementation — never
   throw, never return a stub that breaks the UI.
4. **Determinism.** No `Math.random()`, no unseeded time-dependence in anything
   that produces model output. Use `createRng` from `@/lib/quant/rng`.
5. **`no-console`** is an error except `console.warn` / `console.error` /
   `console.info`. Server code should stay silent on the happy path — the E2E
   suite asserts zero console errors.
6. **Import alias** is `@/*` → `src/*`.
7. Comments explain *why*, and cite the research mandate they implement. Do not
   narrate what the code obviously does.

## Existing modules you may import (do not modify them)

### `@/lib/quant/*`
- `rng` — `createRng(seed)` → `Rng` with `next/int/normal/gaussian/exponential/studentT/bernoulli/pick/shuffle/fork`.
- `stats` — `EPS, clamp, sum, mean, variance, stdev, covariance, correlation, spearman, rank, skewness, kurtosis, quantile, median, mad, zscore, normPdf, normCdf, erf, normInv, studentTCdf, lnGamma, incompleteBeta, rollingMean, rollingStdev, diff, logReturns, pctReturns, ols, adfStatistic, hurstExponent`.
- `linalg` — `Matrix, Vector, zeros, identity, diag, transpose, matMul, matVec, matAdd, matSub, matScale, inverse, ridgeInverse, cholesky, solve, symmetricEigen, covarianceMatrix, ridgeRegression, dot, norm, outer`.
- `ou` — `fitOu(series, dt) → OuFit {theta, mu, sigma, halfLife, equilibriumSigma, persistence, rSquared, meanReverting}`, `ouZScore, ouBands, ouExpectation, ouVariance, ouReversionProbability, ouTimeToReversion, simulateOu, rollingOuFit`.
- `kalman` — `KalmanFilter`, `kalmanInnovationBands(prices, opts) → InnovationBandPoint[]`, `dynamicHedgeRatio`.
- `blackscholes` — `blackScholes(BsInputs) → Greeks`, `bsPrice, bsDelta, impliedVolatility, strikeForDelta`.
- `sabr` — `sabrImpliedVol, sabrAtmVol, calibrateSabr, riskReversal25, sabrSmileCurve, nelderMead, SabrParams, DEFAULT_BETA`.
- `pca` — `fitPca, pcaTransform, pcaFirstScore, pcaInverse, componentsForVariance`.
- `orderflow` — `OrderBookSnapshot, BookLevel, MLOFI_LEVELS, bestBid, bestAsk, midPrice, microPrice, spread, spreadBps, queueImbalance, depthImbalance, ofiIncrement, mlofiVector, mlofiMatrix, computeMlofiSignal, microstructureMetrics, vpin, depthWeights`.
- `ecdf` — `fitEcdf, ecdf, ecdfTransform, ecdfInverse, pseudoObservations, gaussianRankTransform, StreamingEcdf, robustScale`.
- `copula` — `CopulaFamily, PairCopula, copulaCdf, copulaDensity, hFunction, hInverse, tailDependence, kendallTau, thetaFromTau, selectPairCopula, fitCVine, cVineLogDensity, sampleCVine, jointTailProbability, vineTailSummary, bivariateNormalCdf, studentTInv`.
- `decay` — `AltDataStream, DecayProfile, DECAY_PROFILES, MINUTE_MS, HOUR_MS, DAY_MS, decayRate, exponentialDecay, smoothedDecay, decayWeight, effectiveWeight, aggregateStream, aggregateAllStreams, compositeAltScore, impliedHalfLife`.
- `indicators` — `Bar, sma, ema, rma, wma, hma, rsi, macd, stochastic, williamsR, roc, cci, mfi, trueRange, atr, atrPercent, bollinger, keltner, donchian, squeezePercentile, realisedVolatility, garmanKlassVolatility, rogersSatchellVolatility, adx, aroon, supertrend, obv, vwap, relativeVolume, averageDailyVolume, accumulationDistribution, chaikinMoneyFlow, gapPercent, distanceFromHigh, distanceFromLow, consecutiveCloses, closeLocation, trendSlope, rollingBeta, last, at, crossedAbove, crossedBelow, barsSince, resample, closes, highs, lows, opens, volumes, typicalPrices`.
- `gbdt` — `GbdtModel, DecisionTree, TreeNode, trainGbdt, predictTree, predictRaw, predictProbability, predictBatch, featureImportance, sigmoid, logit`.
- `shap` — `ShapExplanation, treeShap, FastTreeShapExplainer, linearTimeApproxShap, ensembleBaseValue, treeExpectedValue, rankContributions, shapWaterfall, localAccuracyError, globalShapImportance, counterfactual`.
- `kmeans` — `kMeans, selectKByElbow, buildShapBackground`.
- `autograd`, `nn` — the autodiff engine and `LstmAgent / BiLstmAgent / TftAgent`.

### `@/lib/market/*`
- `calendar` — `MINUTE, HOUR, DAY, SESSION_OPEN_MINUTES, SESSION_LENGTH_MINUTES, toNewYork, fromNewYork, isoDate, isTradingDay, sessionOpen, sessionClose, sessionMinutes, isMarketOpen, minutesSinceOpen, nextSessionOpen, previousTradingDay, tradingDaysBetween, tradingDayCount, formatNyTime, sessionPhase`.
- `universe` — `UNIVERSE, UniverseSpec, BENCHMARK_SYMBOL ('SPY'), getSpec, requireSpec, symbolMeta, ALL_SYMBOLS, TRADABLE_SYMBOLS, SECTORS, symbolsInSector`.
- `simulator` — `MarketSimulator, createDefaultSimulator, SimRegime, DailySeries, strikeIncrement`.

### `@/lib/domain/types`
All shared domain types. Read the file before inventing a type.

### `@/lib/engine/*`
- `features` — `FEATURE_DEFINITIONS, FeatureDefinition, FeatureState, MODEL_FEATURE_KEYS, MODEL_FEATURE_COUNT, featureDefinition, requireFeature, featuresInGroup, FEATURE_GROUPS, FEATURE_GROUP_LABELS, resolveState, formatFeatureValue`.
- `compute` — `computeFeatures(ComputeInput) → ComputedFeatures`, `applyCrossSectionalNormalisation, formatRaw, percentileOf`.
- `narrative` — the deterministic Human-Translation Engine, `PROHIBITED_PHRASES`, `findProhibitedCopy`, `assertCompliantCopy`, `NEUTRALITY_NOTICE`, `composePublicationNotice`.
- `router` — `routeSignals`, `continuousKelly`, `HierarchicalStateClock`, `macroRegimeDistribution`, and the verbatim constants `AGENT_EDGE / REGIME_OVERRIDE_THRESHOLD / TOXIC_FLOW_THRESHOLD / CONVICTION_SUPPRESSION / MACRO_VOL_AMPLIFICATION / AGGREGATE_NOISE_FLOOR / KELLY_FRACTION`.
- `disruptor` — `Sequence, RingBuffer, SequenceBarrier, BatchEventProcessor, minimumSequence`.

## Design tokens (Tailwind classes already configured)

`vanta` `#0A0A0A` · `vanta-deep` `#050505` · `vanta-raised` `#0F0F10` ·
`obsidian` `#1C1C1C` · `obsidian-light` `#232324` · `obsidian-edge` `#343435` ·
`gold` `#D4AF37` · `gold-bright` `#E8C860` · `gold-dim` `#8E7526` ·
`sage` `#5F7161` (positive SHAP) · `burgundy` `#8C3A3A` (negative SHAP) ·
`parchment` `#EDE8DC` / `parchment-dim` / `parchment-faint` / `parchment-ghost`.
Fonts: `font-mono` (JetBrains Mono, tabular), `font-display` (Playfair Display),
`font-sans` (Inter). Shadows: `shadow-plinth`, `shadow-inset`, `shadow-gilt`.

Neon red/green is banned. Chart libraries are banned — raw SVG only.

## Compliance invariants (never violate)

- No auto-execution. No scheduler, cron, or event listener may call an order
  route. Every order requires a fresh, single-use, single-security intent token
  minted at the millisecond of a physical user click.
- No algorithmic position sizing tied to a user. The Kelly fraction is published
  as an impersonal statistic and must never pre-fill an order field.
- Order form defaults: quantity `null`, order type unselected, limit price empty.
- Risk limits: max notional per order **$100,000**; max **5%** of 30-day ADV;
  limit-price tolerance vs NBBO; pre-trade margin check; **5 order messages per
  second per user**; global kill switch returning **HTTP 503**.
- Audit: six mandatory fields per interaction (user id + session token,
  millisecond timestamp, IP + User-Agent, click X/Y, raw outbound JSON, broker
  HTTP status + body). Append-only bitemporal ledger; no UPDATE, no DELETE.
- No gamification: no badges, streaks, leaderboards, confetti, or urgency
  notifications.
