/**
 * Chart series for one symbol.
 *
 * Separate from `/api/signals/[symbol]` because the two have different shapes and
 * different costs. A signal payload is small and read on every page; a chart
 * payload is hundreds of bars plus three overlay series, and the terminal fetches
 * it once per symbol change. Splitting them keeps the common path light.
 *
 * The overlays are computed by the engine, not the client. The Kalman innovation
 * band, the Bollinger contrast band and the OU equilibrium band are all statistical
 * objects with parameters, and recomputing them in the browser would make the chart
 * a second, divergent implementation of the model — the drawn band and the band the
 * signal was derived from would agree only by coincidence.
 */

import { z } from 'zod';
import { ApiError, handler, ok, parseQuery, pendingSetup } from '@/lib/api/respond';
import { getChartSeries } from '@/lib/engine/service';
import { getSpec } from '@/lib/market/universe';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  horizonDays: z.coerce.number().int().min(1).max(30).optional(),
});

export const GET = handler(async (request: Request, context: { params: Promise<{ symbol: string }> }) => {
  const { symbol: raw } = await context.params;
  const symbol = raw.toUpperCase();

  if (getSpec(symbol) === undefined) {
    throw new ApiError('UNKNOWN_SYMBOL', `${symbol} is not in the published universe.`, 404);
  }

  const q = parseQuery(request, querySchema);

  let series;
  try {
    series = await getChartSeries(symbol, q.horizonDays === undefined ? {} : { horizonDays: q.horizonDays });
  } catch (error) {
    // An untrained engine is an operational state with a specific remedy, not an
    // internal error, and not an outage either: 200 carrying the instruction.
    return pendingSetup('ENGINE_NOT_READY', error instanceof Error ? error.message : 'The engine is unavailable.');
  }

  return ok({
    ...series,
    counts: {
      daily: series.daily.length,
      intraday: series.intraday.length,
      hourly: series.hourly.length,
      kalmanBand: series.kalmanBand.length,
      bollinger: series.bollinger.length,
    },
  });
});
