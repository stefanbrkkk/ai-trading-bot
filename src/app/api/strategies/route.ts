/**
 * The strategy catalogue, with each strategy's provenance.
 *
 * `provenance` and `reconstructed` are published deliberately: three of these
 * strategies are reverse-engineered replications of a competitor's documented
 * scans, and some of their numeric gates were reconstructed where the source
 * material had them stripped. Presenting a reconstructed parameter as a verified
 * one would be a misrepresentation, so the flag travels with the definition.
 */

import { handler, ok } from '@/lib/api/respond';
import { STRATEGY_PARAMS, strategyCatalogue } from '@/lib/engine/strategies';
import { COMBINE_THRESHOLDS, MAX_ENTRIES_PER_SYMBOL_PER_DAY } from '@/lib/engine/backtest';
import { loadArtefact } from '@/lib/engine/store';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const scorecards = loadArtefact<Record<string, unknown>>('strategy-scorecards') ?? {};
  const profitFactors = loadArtefact<Record<string, number>>('strategy-profit-factors') ?? {};
  return ok({
    strategies: strategyCatalogue().map((s) => ({
      ...s,
      profitFactor: profitFactors[s.id] ?? null,
      scorecard: scorecards[s.id] ?? null,
    })),
    parameters: STRATEGY_PARAMS,
    combineThresholds: COMBINE_THRESHOLDS,
    maxEntriesPerSymbolPerDay: MAX_ENTRIES_PER_SYMBOL_PER_DAY,
  });
});
