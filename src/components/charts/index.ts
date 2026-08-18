/**
 * Chart library barrel.
 *
 * Every chart in this directory is a `'use client'` presentation component: raw
 * SVG, plain serialisable props, no data fetching and no statistics of its own.
 * Panels and pages import from here so there is one published surface for the
 * visual vocabulary.
 *
 * Kept explicit (rather than `export *`) to match the other subsystem barrels:
 * the list below *is* the public API, so a reviewer can see exactly which charts
 * and which prop contracts the rest of the application is able to reach. Note
 * that this module deliberately carries no `'use client'` directive of its own —
 * each chart declares its own boundary, so a server component may import a type
 * from here without pulling the runtime across.
 */

// Attention — per-timeframe attention weights as a horizontal strip.
export { AttentionStrip } from './AttentionStrip';
export type { AttentionStripProps } from './AttentionStrip';

// Calibration — reliability curve with Brier score and expected calibration error.
export { CalibrationPlot } from './CalibrationPlot';
export type { CalibrationBin, CalibrationPlotProps } from './CalibrationPlot';

// Conviction — the dial, its compact ring variant and the shared geometry.
export { CONVICTION_GEOMETRY, ConvictionDial, ConvictionRing } from './ConvictionDial';
export type { ConvictionDialProps } from './ConvictionDial';

// Decay — signal half-life profiles against a horizon.
export { DecayCurve } from './DecayCurve';
export type { DecayCurveProps, DecayProfileInput } from './DecayCurve';

// Depth — order-book ladder with MLOFI loadings.
export { DepthLadder } from './DepthLadder';
export type { DepthLadderProps } from './DepthLadder';

// Driver tooltip — the shared hover surface for the attribution charts, plus the
// anchoring helpers the SHAP charts use to place it inside their host element.
export { DriverTooltip, TOOLTIP_WIDTH, elementPoint, pointerPoint, tooltipAnchor } from './DriverTooltip';
export type { DriverTooltipProps, HostPoint } from './DriverTooltip';

// Equity — cumulative equity with drawdown shading.
export { EquityCurve } from './EquityCurve';
export type { EquityCurvePoint, EquityCurveProps } from './EquityCurve';

// Feature bars — ranked feature magnitudes with hover coordination.
export { FeatureBars } from './FeatureBars';
export type { FeatureBarItem, FeatureBarsProps } from './FeatureBars';

// Latency — stage breakdown against the budget.
export { LatencyBar } from './LatencyBar';
export type { LatencyBarProps, LatencyStage } from './LatencyBar';

// Monthly heatmap — calendar grid of monthly returns.
export { MonthlyHeatmap } from './MonthlyHeatmap';
export type { MonthlyHeatmapProps, MonthlyReturn } from './MonthlyHeatmap';

// Price — candles/line with Kalman bands, Bollinger bands and signal levels.
export { PriceChart } from './PriceChart';
export type { BollingerPoint, KalmanBandPoint, PriceChartProps, SignalLevels } from './PriceChart';

// Return distribution — histogram of realised returns.
export { ReturnDistribution } from './ReturnDistribution';
export type { ReturnDistributionProps } from './ReturnDistribution';

// SABR — implied-volatility smile across strikes.
export { SabrSmile } from './SabrSmile';
export type { SabrSmileProps, SmileCurvePoint } from './SabrSmile';

// SHAP — force plot and waterfall attribution views.
export { ShapForcePlot } from './ShapForcePlot';
export type { ForceContribution, ShapForcePlotProps } from './ShapForcePlot';
export { ShapWaterfall } from './ShapWaterfall';
export type { ShapWaterfallProps, ShapWaterfallStep } from './ShapWaterfall';

// Z-oscillator — z-score against the entry/exit thresholds.
export { ZOscillator } from './ZOscillator';
export type { ZOscillatorPoint, ZOscillatorProps } from './ZOscillator';
