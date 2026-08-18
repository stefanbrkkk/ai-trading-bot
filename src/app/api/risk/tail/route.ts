/**
 * Joint downside risk across the account's open positions.
 *
 * Every other risk number this platform publishes is marginal — this symbol's
 * volatility, that symbol's drawdown — and a portfolio does not fail one symbol
 * at a time. What ruins a book is everything falling together, and the
 * correlation matrix that most tools stop at cannot see it: linear correlation
 * is a single number for the whole distribution, and equities are far more
 * dependent in the left tail than the correlation implies. Two names with ρ =
 * 0.4 through a normal year can still go down together nine times out of ten in
 * a crash, and ρ will not tell you which pair does that.
 *
 * A C-vine copula does. It separates each holding's own return distribution from
 * the dependence structure between them, fits a pair copula per edge — Clayton
 * for lower-tail clustering, Gumbel for upper, Student-t for both, Gaussian for
 * neither — and reports the joint probability directly. `quant/copula` has
 * carried the whole construction since the beginning, and its
 * `jointTailProbability` docstring has always said it is "the market downturn
 * co-movement number the risk panel reports". This is that panel.
 *
 * Impersonal, like everything else here: it describes the co-movement of the
 * instruments held, from public price history, and does not recommend a hedge,
 * a size or an exit.
 */

import { ApiError, correlationId, handler, ok } from '@/lib/api/respond';
import { currentUser, entitlement } from '@/lib/auth/session';
import { getBroker } from '@/lib/broker';
import { resolveMarketProvider } from '@/lib/market/provider';
import { fitCVine, jointTailProbability, vineTailSummary } from '@/lib/quant/copula';
import { createRng } from '@/lib/quant/rng';
import type { CopulaFamily } from '@/lib/quant/copula';

export const dynamic = 'force-dynamic';

/** Sessions of history behind the fit. Two years of dependence, ~504 bars. */
const LOOKBACK_SESSIONS = 504;

/**
 * Quantile each holding must breach simultaneously.
 *
 * The 5th percentile of a name's own return distribution, so the question is
 * "every position having one of its own worst days at once" rather than a fixed
 * percentage that means something different for a utility and a semiconductor.
 */
const TAIL_QUANTILE = 0.05;

/**
 * Monte-Carlo draws behind the joint probability.
 *
 * The estimate's standard error at p ≈ 0.01 is √(p(1−p)/n) ≈ 0.001 at 10,000
 * draws — a tenth of the quantity being reported, which is the accuracy the
 * figure is quoted to. The sampler is seeded, so the number is reproducible.
 */
const DRAWS = 10_000;

/** The independence benchmark: what the same probability would be with no dependence. */
function independenceBaseline(holdings: number): number {
  return TAIL_QUANTILE ** holdings;
}

export const GET = handler(async (request: Request) => {
  const user = await currentUser();
  if (!user) throw new ApiError('UNAUTHENTICATED', 'Sign in to view portfolio risk.', 401);

  const url = new URL(request.url);
  const account = url.searchParams.get('account') === 'live' ? 'live' : 'paper';
  const gate = entitlement(user);
  if (account === 'live' && !gate.live) throw new ApiError('SUBSCRIPTION_REQUIRED', gate.reason, 402);

  const correlation = correlationId();
  const now = Date.now();
  const broker = getBroker();
  const result = await broker.getPositions(account, {
    correlationId: correlation,
    userId: user.id,
    dispatchedAt: now,
  });

  const symbols = [...new Set((result.data ?? []).map((p) => p.symbol.toUpperCase()))].sort();

  /*
   * A vine needs at least two margins to have any dependence to describe. One
   * holding is not a degenerate case to paper over — it is a portfolio with no
   * co-movement — so it is reported as such rather than as a zero.
   */
  if (symbols.length < 2) {
    return ok(
      {
        available: false,
        reason:
          symbols.length === 0
            ? 'No open positions. Joint downside risk describes how holdings move together, so it needs a book to describe.'
            : 'One open position. Co-movement needs at least two holdings; this symbol’s own risk is on its attribution page.',
        symbols,
        holdings: symbols.length,
      },
      { correlation },
    );
  }

  const provider = resolveMarketProvider();
  const series = await Promise.all(
    symbols.map((s) => provider.dailyBars(s, { limit: LOOKBACK_SESSIONS + 1, endAt: now })),
  );

  /*
   * Log returns, aligned to the shortest history in the book.
   *
   * A recently listed name simply shortens the window for everyone — fitting one
   * margin on two years and another on three months would let the shorter one's
   * regime dominate its own pair copulas.
   */
  const columns: number[][] = [];
  const usable: string[] = [];
  for (let i = 0; i < symbols.length; i += 1) {
    const bars = series[i] ?? [];
    const returns: number[] = [];
    for (let b = 1; b < bars.length; b += 1) {
      const previous = bars[b - 1]?.close;
      const close = bars[b]?.close;
      if (previous === undefined || close === undefined || previous <= 0 || close <= 0) continue;
      returns.push(Math.log(close / previous));
    }
    if (returns.length >= 60) {
      columns.push(returns);
      usable.push(symbols[i] as string);
    }
  }

  if (columns.length < 2) {
    return ok(
      {
        available: false,
        reason:
          'Not enough shared price history across these holdings to fit a dependence structure. Sixty common sessions are the minimum.',
        symbols,
        holdings: symbols.length,
      },
      { correlation },
    );
  }

  const shortest = Math.min(...columns.map((c) => c.length));
  const aligned = columns.map((c) => c.slice(c.length - shortest));

  const model = fitCVine(aligned, { labels: usable });
  // Seeded on the book itself, so the same holdings reproduce the same estimate.
  const rng = createRng(`tail:${usable.join(',')}:${shortest}`);
  const joint = jointTailProbability(model, TAIL_QUANTILE, DRAWS, () => rng.next());
  const tails = vineTailSummary(model);
  const baseline = independenceBaseline(usable.length);

  /** The tree-1 edges, which are the pairwise dependences a reader can act on. */
  const pairs = model.edges
    .filter((e) => e.tree === 1)
    .map((e) => ({
      a: model.labels[e.a] ?? `x${e.a}`,
      b: model.labels[e.b] ?? `x${e.b}`,
      family: e.copula.family as CopulaFamily,
      tau: e.copula.tau,
      lowerTail: e.copula.tailDependence.lower,
      upperTail: e.copula.tailDependence.upper,
    }))
    .sort((x, y) => y.lowerTail - x.lowerTail || Math.abs(y.tau) - Math.abs(x.tau));

  return ok(
    {
      available: true,
      reason: null,
      symbols: usable,
      holdings: usable.length,
      sessions: shortest,
      quantile: TAIL_QUANTILE,
      draws: DRAWS,
      /** P(every holding below its own 5th percentile on the same day). */
      jointTailProbability: joint,
      /** The same probability if the holdings were independent. */
      independenceBaseline: baseline,
      /**
       * How many times more likely the fitted dependence makes a joint tail than
       * independence would. This is the number the panel leads with: it is the
       * cost of concentration, stated as a multiple.
       */
      concentrationMultiple: baseline > 0 ? joint / baseline : 0,
      averageLowerTailDependence: tails.lower,
      averageUpperTailDependence: tails.upper,
      logLikelihood: model.logLikelihood,
      aic: model.aic,
      pairs,
      notice:
        'An impersonal computation over public price history. It describes how these instruments have moved together; it is not a hedging recommendation, a position size, or a forecast.',
    },
    { correlation },
  );
});
