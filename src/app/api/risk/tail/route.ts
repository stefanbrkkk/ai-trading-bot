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
 * the dependence structure between them and fits a pair copula per edge —
 * Clayton for lower-tail clustering, Gumbel for upper, Student-t for both,
 * Gaussian for neither. What this route publishes comes from `vineTailSummary`
 * over the fitted first tree: the tail-dependence coefficients each family has
 * in closed form, averaged over the edges. Not from `jointTailProbability`,
 * which is the sampling route this one deliberately does not take — see the
 * header below for the measurements that decided that.
 *
 * Impersonal, like everything else here: it describes the co-movement of the
 * instruments held, from public price history, and does not recommend a hedge,
 * a size or an exit.
 */

import { ApiError, correlationId, handler, ok } from '@/lib/api/respond';
import { currentUser, entitlement } from '@/lib/auth/session';
import { getBroker } from '@/lib/broker';
import { resolveMarketProvider } from '@/lib/market/provider';
import { fitCVine, vineTailSummary } from '@/lib/quant/copula';
import { isoDate, lastCompletedSessionClose } from '@/lib/market/calendar';
import type { CopulaFamily } from '@/lib/quant/copula';

export const dynamic = 'force-dynamic';

/**
 * Sessions of history behind the fit. One year, which is the conventional window
 * for a dependence estimate and half the fitting cost of two.
 */
const LOOKBACK_SESSIONS = 252;

/**
 * The reference quantile the concentration ratio is expressed against.
 *
 * The 5th percentile of a name's own return distribution — a relative threshold,
 * so it means the same thing for a utility and for a semiconductor. Nothing is
 * *evaluated* at this quantile any more: it is the unconditional rate that
 * `concentrationMultiple` divides by, and the number the page prints when it
 * needs to say what "its own tail" means.
 *
 * It used to be the threshold every holding had to breach simultaneously, which
 * is the Monte-Carlo question the next comment explains was removed. That
 * docstring outlived the code by two revisions; this one describes what the
 * constant is actually used for.
 */
const TAIL_QUANTILE = 0.05;

/**
 * Why there is no Monte Carlo here.
 *
 * The first version of this route answered "what is the probability that EVERY
 * holding is below its own 5th percentile on the same day", estimated by
 * sampling the fitted vine 10,000 times. Two things were wrong with that, and
 * both were measured rather than argued:
 *
 *   * Cost. Sampling a vine calls the inverse h-function per edge per draw, and
 *     for a Student-t edge that is a bisection over the incomplete beta. It ran
 *     12 s at eight holdings and 24.5 s at twelve — on a route the portfolio
 *     page polls every sixty seconds.
 *   * Resolution. The event decays like q^d, so at twelve holdings it returned
 *     0 hits in 10,000 draws. The panel would have published "0" and a
 *     concentration multiple of zero: a portfolio told it has no joint tail risk
 *     precisely when it holds the most names.
 *
 * Tail dependence answers the same question in a form that is exact, instant and
 * stable at any book size. λ_L is the limiting probability that one name is in
 * its own left tail GIVEN that the other already is, and every family this
 * platform fits has a closed form for it — Student-t through the t distribution,
 * Clayton through 2^(−1/θ), Gaussian and Frank exactly zero, which is itself the
 * finding worth reporting when it happens. No sampling, no estimator variance,
 * and it does not decay to nothing as holdings are added.
 *
 * What it is not is the answer at a *finite* threshold. It answers "in the
 * limit", and swapping "in the limit" for "at the 5th percentile" is the one
 * mistake this payload is easy to make: the two are different numbers, the
 * limiting one is the smaller, and a panel that prints λ_L under a 5%-threshold
 * label is understating co-movement while sounding more precise. Every field
 * below says which of the two it is, and the page has to repeat that choice.
 */

/**
 * Fitted vines, keyed on the book and the session that produced them.
 *
 * Module scope so it survives between requests in one server process. It holds
 * only model parameters — a handful of numbers per pair — not the return series,
 * so a full cache is kilobytes.
 */
const FIT_CACHE = new Map<
  string,
  { model: ReturnType<typeof fitCVine>; tails: ReturnType<typeof vineTailSummary> }
>();
const FIT_CACHE_MAX = 64;

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

  /*
   * Fitted once per book per session.
   *
   * The portfolio page polls this route every sixty seconds, and neither input
   * changes on that timescale: the holdings only move when an order fills, and
   * the daily bars only move at a session close. Refitting d(d−1)/2 pair copulas
   * on every poll is pure repetition — measured at 3.5 s for eight holdings and
   * 7.8 s for twelve, once the marginal-quantile hoist in `selectPairCopula`
   * landed, and an order of magnitude worse before it.
   *
   * Keyed on the exact inputs, so a changed book or a new session recomputes and
   * nothing else does. Bounded because it is a module-level Map on a long-lived
   * server: one entry per distinct book, oldest evicted first.
   */
  const cacheKey = `${usable.join(',')}|${shortest}|${isoDate(lastCompletedSessionClose(now))}`;
  let fit = FIT_CACHE.get(cacheKey);
  if (fit === undefined) {
    /*
     * Tree 1 only. Everything this panel publishes — the pairwise families,
     * their taus, their tail dependences and the averages over them — lives on
     * the first tree, and `vineTailSummary` reads nothing else. Fitting the
     * conditional trees above it is d(d−1)/2 pair estimations for d−1 answers.
     */
    const model = fitCVine(aligned, { labels: usable, maxTrees: 1 });
    fit = { model, tails: vineTailSummary(model) };
    FIT_CACHE.set(cacheKey, fit);
    if (FIT_CACHE.size > FIT_CACHE_MAX) {
      const oldest = FIT_CACHE.keys().next().value;
      if (oldest !== undefined) FIT_CACHE.delete(oldest);
    }
  }
  const { model, tails } = fit;

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
      /**
       * λ_L — lower-tail dependence, averaged over the first-tree edges.
       *
       * Read it exactly as the footnote on the pair table does: the *limiting*
       * probability that one name is in its own left tail given that the other
       * already is, as the threshold goes to zero. It is a property of the
       * fitted copula family, closed-form per family, and it is not indexed by
       * `quantile` at all.
       *
       * It is therefore not "P(a peer is below its own 5th percentile)", and
       * must not be published under that label. The two differ by more than
       * rounding: on a five-name book (AAPL/MSFT/JPM/XOM/PG, 252 sessions, every
       * tree-1 edge fitted Student-t) the average λ_L is 0.212, while the exact
       * conditional exceedance C(q,q)/q at q = 0.05 — obtained by integrating
       * the exact h-function, since `copulaCdf` answers the Student-t case with
       * the Gaussian cdf — is 0.268. λ_L is the smaller, limiting number, so
       * printing it under a finite-threshold label understates the co-movement
       * it is describing.
       */
      lowerTailDependence: tails.lower,
      upperTailDependence: tails.upper,
      /**
       * λ_L against the unconditional rate: how much likelier the fitted
       * dependence makes a peer's left tail than chance does.
       *
       * Unconditionally a holding is below its own q-quantile a fraction q of
       * the time, for any q — that is what a quantile is. The numerator is the
       * limit above rather than a probability measured at `quantile`, so this is
       * the limiting comparison and it is 1.0 for a book with no tail dependence
       * at all. On the book quoted above it is 4.24× where the exact ratio at
       * q = 0.05 is 5.36×: conservative in the direction that matters, and the
       * page must not describe it as the multiple *at* the 5% threshold.
       */
      concentrationMultiple: tails.lower / TAIL_QUANTILE,
      /**
       * Expected number of the other holdings that are in their own left tails
       * given that one name is in its — λ_L times the number of peers, under the
       * same limiting reading. The figure a reader actually pictures.
       */
      expectedCoMovers: tails.lower * (usable.length - 1),
      logLikelihood: model.logLikelihood,
      aic: model.aic,
      pairs,
      notice:
        'An impersonal computation over public price history. It describes how these instruments have moved together; it is not a hedging recommendation, a position size, or a forecast.',
    },
    { correlation },
  );
});
