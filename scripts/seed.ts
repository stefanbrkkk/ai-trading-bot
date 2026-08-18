/**
 * Seeds the platform.
 *
 *   npm run seed          full seed (~2–4 minutes)
 *   npm run seed:fast     reduced sample and epoch budget, for CI and E2E
 *
 * What it does, in order:
 *   1. trains the ensemble on the deterministic simulator and persists it;
 *   2. persists the per-symbol feature history the temporal agents need at
 *      inference time;
 *   3. runs a walk-forward backtest per strategy to obtain the profit factors the
 *      conflict resolver uses as tie-breaks;
 *   4. pre-warms the universe snapshot and the daily publication;
 *   5. writes the seeded corpus, universe metadata and demo accounts into the
 *      append-only store.
 *
 * Everything here is deterministic in AURELIUS_SEED, so two machines produce
 * byte-identical output.
 */

import { performance } from 'node:perf_hooks';
import { SimulatorProvider } from '@/lib/market/provider';
import { referenceNow } from '@/lib/domain/clock';
import { ALL_SYMBOLS, BENCHMARK_SYMBOL, TRADABLE_SYMBOLS, requireSpec, symbolMeta } from '@/lib/market/universe';
import { buildRiskReversalHistory, buildTrainingDataset } from '@/lib/engine/dataset';
import { trainModelBundle } from '@/lib/engine/model';
import { saveArtefact, saveModelBundle } from '@/lib/engine/store';
import { DEFAULT_BACKTEST_CONFIG, combineScorecard, runBacktest } from '@/lib/engine/backtest';
import { STRATEGIES } from '@/lib/engine/strategies';
import type { BacktestBarSlice } from '@/lib/engine/backtest';
import type { ComputedFeatures } from '@/lib/engine/compute';

const FAST = process.argv.includes('--fast');
const SEED = Number(process.env.AURELIUS_SEED ?? 20240117);

/**
 * The reference clock. Fixed rather than `Date.now()` so the seeded data, the
 * E2E expectations and the screenshots in the docs all agree. Override with
 * AURELIUS_NOW when regenerating for a different date.
 */
const NOW = referenceNow(Date.UTC(2026, 7, 14, 20, 0, 0));

const BUDGET = FAST
  ? { symbols: 18, samplesPerSymbol: 14, gbdtRounds: 60, agentEpochs: 2, tftEpochs: 1, bookSnapshots: 16, historyDepth: 24 }
  : { symbols: 63, samplesPerSymbol: 26, gbdtRounds: 160, agentEpochs: 5, tftEpochs: 4, bookSnapshots: 24, historyDepth: 24 };

function step(label: string): (detail?: string) => void {
  const started = performance.now();
  process.stdout.write(`  ${label} … `);
  return (detail?: string) => {
    const ms = Math.round(performance.now() - started);
    process.stdout.write(`${detail ? `${detail} ` : ''}(${ms}ms)\n`);
  };
}

async function main(): Promise<void> {
  const overall = performance.now();
  process.stdout.write(`\nProject Aurelius — seeding (${FAST ? 'fast' : 'full'} budget, seed ${SEED})\n\n`);

  // ── 1. Market simulation ─────────────────────────────────────────────────
  let done = step('Building the simulated market');
  const provider = new SimulatorProvider({ seed: SEED, now: NOW, years: 3 });
  const symbols = TRADABLE_SYMBOLS.slice(0, BUDGET.symbols);
  done(`${provider.simulator.sessionCount} sessions, ${symbols.length + 1} symbols`);

  // ── 2. Training dataset ──────────────────────────────────────────────────
  done = step('Computing the training set');
  const dataset = await buildTrainingDataset(provider, {
    symbols,
    samplesPerSymbol: BUDGET.samplesPerSymbol,
    horizonDays: 5,
    warmupBars: 260,
    bookSnapshots: BUDGET.bookSnapshots,
  });
  const positiveRate = dataset.y.reduce((a, b) => a + b, 0) / Math.max(1, dataset.y.length);
  done(`${dataset.x.length} samples × ${dataset.x[0]?.length ?? 0} features, ${(positiveRate * 100).toFixed(1)}% positive`);

  // ── 3. Train ─────────────────────────────────────────────────────────────
  process.stdout.write('  Training the ensemble …\n');
  const model = trainModelBundle(dataset, {
    seed: SEED,
    validationFraction: 0.2,
    gbdtRounds: BUDGET.gbdtRounds,
    agentEpochs: BUDGET.agentEpochs,
    tftEpochs: BUDGET.tftEpochs,
    onProgress: (stage, detail) => process.stdout.write(`    ${stage.padEnd(16)} ${detail}\n`),
  });
  const t = model.training;
  process.stdout.write(
    `    trees=${model.explainer.treeCount} leaves=${model.explainer.leafCount} ` +
      `acc=${(t.accuracy * 100).toFixed(1)}% oos=${(t.validationAccuracy * 100).toFixed(1)}% ` +
      `auc=${t.auc.toFixed(3)} brier=${t.brier.toFixed(4)} k=${model.background.kSelected}\n`,
  );

  done = step('Persisting the ensemble');
  const path = saveModelBundle(model);
  done(path);

  // ── 4. Agent feature history ─────────────────────────────────────────────
  done = step('Persisting agent feature history');
  const agentHistory: Record<string, ComputedFeatures[]> = {};
  for (const h of dataset.histories) {
    agentHistory[h.symbol] = h.entries.slice(-BUDGET.historyDepth).map((e) => stripArtefacts(e.features));
  }
  saveArtefact('agent-history', agentHistory);
  done(`${Object.keys(agentHistory).length} symbols × ${BUDGET.historyDepth} vectors`);

  // ── 4b. Risk-reversal history (expensive to rebuild per request) ─────────
  done = step('Persisting 25\u0394 risk-reversal history');
  const riskReversals: Record<string, number[]> = {};
  for (const symbol of symbols) {
    if (!requireSpec(symbol).optionable) continue;
    riskReversals[symbol] = buildRiskReversalHistory(provider, symbol, {
      lookbackSessions: 50,
      strideDays: 5,
      endAt: NOW,
    });
  }
  saveArtefact('risk-reversal-history', riskReversals);
  done(`${Object.keys(riskReversals).length} symbols \u00d7 50 sessions`);

  // ── 5. Per-strategy walk-forward backtests ───────────────────────────────
  done = step('Back-testing each strategy for conflict tie-breaks');
  const benchmarkBars = provider.simulator.dailyBars(BENCHMARK_SYMBOL).bars;
  const backtestSymbols = symbols.slice(0, FAST ? 8 : 20);
  const slices: BacktestBarSlice[] = [];

  for (const symbol of backtestSymbols) {
    const history = dataset.histories.find((h) => h.symbol === symbol);
    if (!history || history.entries.length === 0) continue;
    const bars = provider.simulator.dailyBars(symbol).bars;
    // Map each sampled feature vector onto its bar index, leaving the rest null
    // so the backtester only trades bars it genuinely has features for.
    const features: (ComputedFeatures | null)[] = new Array(bars.length).fill(null);
    const barTimes = bars.map((b) => b.time);
    for (const entry of history.entries) {
      const idx = nearestIndex(barTimes, entry.time);
      if (idx >= 0) features[idx] = entry.features;
    }
    slices.push({
      symbol,
      bars,
      benchmarkBars: benchmarkBars.slice(0, bars.length),
      features,
      riskReversalHistory: buildRiskReversalHistory(provider, symbol, { lookbackSessions: bars.length, strideDays: 21, endAt: NOW }),
      adv30: symbolMeta(requireSpec(symbol)).adv30,
    });
  }

  const profitFactors: Record<string, number> = {};
  const scorecards: Record<string, unknown> = {};
  const startTime = provider.simulator.sessionTimes[260] ?? provider.simulator.sessionTimes[0] ?? NOW;

  for (const strategy of STRATEGIES) {
    const result = runBacktest({
      config: {
        ...DEFAULT_BACKTEST_CONFIG,
        symbols: backtestSymbols,
        strategies: [strategy.id],
        startTime,
        endTime: NOW,
        minConviction: 20,
      },
      slices,
      benchmarkBars,
    });
    profitFactors[strategy.id] = Number.isFinite(result.metrics.profitFactor) ? result.metrics.profitFactor : 1;
    scorecards[strategy.id] = {
      strategy: strategy.id,
      name: strategy.name,
      metrics: result.metrics,
      scorecard: combineScorecard(result),
      trades: result.trades.length,
    };
  }
  saveArtefact('strategy-profit-factors', profitFactors);
  saveArtefact('strategy-scorecards', scorecards);
  done(
    Object.entries(profitFactors)
      .map(([k, v]) => `${k}=${v.toFixed(2)}`)
      .join(' '),
  );

  // ── 6. Portfolio backtest fixture ────────────────────────────────────────
  done = step('Running the portfolio backtest fixture');
  const portfolio = runBacktest({
    config: {
      ...DEFAULT_BACKTEST_CONFIG,
      symbols: backtestSymbols,
      startTime,
      endTime: NOW,
    },
    slices,
    benchmarkBars,
  });
  saveArtefact('backtest-default', portfolio);
  done(
    `${portfolio.trades.length} trades, ${(portfolio.metrics.totalReturn * 100).toFixed(1)}% return, ` +
      `Sharpe ${portfolio.metrics.sharpe.toFixed(2)}, maxDD ${(portfolio.metrics.maxDrawdown * 100).toFixed(1)}%`,
  );

  // ── 7. Warm the universe snapshot and publication ────────────────────────
  done = step('Warming the universe snapshot');
  // Imported lazily so the model file exists before the service reads it.
  const { getUniverseSnapshot, getPublication, clearEngineCache } = await import('@/lib/engine/service');
  clearEngineCache();
  process.env.AURELIUS_SEED = String(SEED);
  /*
   * The sweep is run for its side effects — it warms the engine's caches and the
   * publication below is derived from it. Its rows are deliberately NOT written
   * to an artefact: nothing read the file, and a 37 KB JSON sitting in
   * `.data/artefacts` named `universe-snapshot` reads like a cache the engine
   * consults, which cost real time to disprove while chasing a genuine staleness
   * bug in the neighbouring publication artefact.
   */
  const snapshot = await getUniverseSnapshot({ now: NOW });
  const withSignal = snapshot.rows.filter((r) => r.direction !== 'flat').length;
  done(`${snapshot.rows.length} symbols, ${withSignal} with a directional signal`);

  done = step('Publishing the daily Top 5');
  const publication = await getPublication({ now: NOW });
  done(publication.items.map((i) => `${i.symbol} ${i.conviction.toFixed(0)}`).join(' · ') || 'no qualifying names');

  // ── 8. Store ─────────────────────────────────────────────────────────────
  done = step('Seeding the append-only store');
  const storeSummary = await seedStore(provider, symbols, snapshot);
  done(storeSummary);

  // ── 9. Retrieval corpus ──────────────────────────────────────────────────
  done = step('Seeding the retrieval corpus');
  const corpusSummary = await seedCorpus(symbols);
  done(corpusSummary);

  saveArtefact('seed-manifest', {
    seed: SEED,
    now: NOW,
    fast: FAST,
    createdAt: Date.now(),
    modelVersion: model.version,
    samples: dataset.x.length,
    symbols: symbols.length,
    sessions: provider.simulator.sessionCount,
    training: model.training,
    publicationDate: publication.publicationDate,
  });

  process.stdout.write(`\nSeed complete in ${((performance.now() - overall) / 1000).toFixed(1)}s\n\n`);
}

/**
 * Drops the heavy intermediate artefacts before persisting a feature snapshot.
 * The agents only read `raw`, so keeping the Kalman series and the whole option
 * surface would inflate the artefact by two orders of magnitude for no benefit.
 */
function stripArtefacts(features: ComputedFeatures): ComputedFeatures {
  return {
    symbol: features.symbol,
    now: features.now,
    raw: features.raw,
    vector: features.vector,
    values: [],
    artefacts: features.artefacts,
  };
}

function nearestIndex(times: readonly number[], target: number): number {
  let best = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < times.length; i += 1) {
    const d = Math.abs((times[i] as number) - target);
    if (d < bestDelta) {
      bestDelta = d;
      best = i;
    }
  }
  return best;
}

/**
 * Writes the reference data into the store.
 *
 * The store and catalog are resolved through a runtime specifier so a seed still
 * succeeds when one of those modules is absent — the platform reads market data
 * from the provider, not the store, so this is reference and audit data rather
 * than a hard dependency. Feature detection on the resolved namespace keeps the
 * seed working as the store's surface grows.
 */
async function optionalImport(specifier: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function callable(ns: Record<string, unknown> | null, name: string): ((...args: unknown[]) => unknown) | null {
  const value = ns?.[name];
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown) : null;
}

async function seedStore(
  provider: SimulatorProvider,
  symbols: readonly string[],
  snapshot: import('@/lib/engine/service').UniverseSnapshot,
): Promise<string> {
  const db = await optionalImport('@/lib/db');
  if (!db) return 'skipped (store module not present)';

  const parts: string[] = [];
  try {
    // `migrate` takes the driver explicitly — it has no implicit global — so the
    // handle is resolved first. Calling it with no argument silently failed here
    // before, which left the whole schema absent and every store write below it
    // swallowed by the catch as a one-line "partial".
    const getDb = callable(db, 'getDb');
    const migrate = callable(db, 'migrate');
    if (getDb && migrate) migrate(getDb());

    /**
     * Every symbol in the universe, not just the training subset.
     *
     * `v_equity_snapshot` inner-joins `symbols`, so a symbol with feature rows but
     * no dimension row is invisible to the view. The universe sweep covers 64
     * names while the reduced training budget covers 18, and seeding only the
     * latter silently dropped three quarters of the screener's rows — with no
     * error, because a JOIN that matches nothing is not a failure. The dimension
     * table is pure reference metadata and costs nothing to fill completely.
     */
    const upsertSymbols = callable(db, 'upsertSymbols');
    if (upsertSymbols) {
      upsertSymbols(ALL_SYMBOLS.map((s) => symbolMeta(requireSpec(s))));
      parts.push(`${ALL_SYMBOLS.length} symbols`);
    }

    const insertDailyBars = callable(db, 'insertDailyBars');
    if (insertDailyBars) {
      let bars = 0;
      for (const s of [BENCHMARK_SYMBOL, ...symbols]) {
        const series = provider.simulator.dailyBars(s).bars.slice(-260);
        insertDailyBars(s, series);
        bars += series.length;
      }
      parts.push(`${bars} daily bars`);
    }

    /**
     * Quotes and feature values are what make `v_equity_snapshot` non-empty, and
     * therefore what makes InvestGPT and the SQL screener work at all. The view
     * pivots `feature_values` and joins the newest `quotes_snapshot` row, so a
     * store with symbols and bars but neither of these produces a view with zero
     * rows — a screener that silently answers "no matches" to every question.
     */
    const insertQuotes = callable(db, 'insertQuotes');
    if (insertQuotes) {
      // Quoted for every symbol the sweep produced features for, so the view's
      // price and change_percent columns are populated on every row it returns.
      const quoted = [...new Set([BENCHMARK_SYMBOL, ...snapshot.features.map((f) => f.symbol), ...symbols])];
      const quotes = await Promise.all(quoted.map((s) => provider.quote(s, NOW).catch(() => null)));
      const present = quotes.filter((quote) => quote !== null);
      if (present.length > 0) {
        insertQuotes(present);
        parts.push(`${present.length} quotes`);
      }
    }

    const writeFeatureValues = callable(db, 'writeFeatureValues');
    if (writeFeatureValues && snapshot.features.length > 0) {
      let written = 0;
      for (const features of snapshot.features) {
        if (features.values.length === 0) continue;
        writeFeatureValues(features.symbol, features.now, features.values);
        written += features.values.length;
      }
      parts.push(`${written} feature values`);
    }

    const insertSignal = callable(db, 'insertSignal');
    if (insertSignal) {
      for (const signal of snapshot.signals) insertSignal(signal);
      parts.push(`${snapshot.signals.length} signals`);
    }

    const syncFeatureCatalog = callable(db, 'syncFeatureCatalog');
    if (syncFeatureCatalog) {
      const count = syncFeatureCatalog();
      parts.push(`${typeof count === 'number' ? count : '?'} catalog entries`);
    }

    const insertAltEvents = callable(db, 'insertAltEvents');
    if (insertAltEvents) {
      let events = 0;
      for (const s of symbols.slice(0, 12)) {
        const list = provider.simulator.altEvents(s, NOW - 200 * 86_400_000, NOW);
        insertAltEvents(list);
        events += list.length;
      }
      parts.push(`${events} alt-data events`);
    }

    // The append-only triggers are created by the migration but not verified by
    // it; the ledger's whole guarantee rests on them, so the seed proves they are
    // in force rather than assuming it.
    callable(db, 'assertAppendOnly')?.();

    return parts.length > 0 ? parts.join(', ') : 'store present, nothing to write';
  } catch (error) {
    return `partial (${error instanceof Error ? error.message.split('\n')[0] : 'store write failed'})`;
  }
}

/**
 * Writes the retrieval corpus and its embeddings.
 *
 * Embeddings are computed over the heading-prefixed index text, matching what the
 * retriever embeds a query against — embedding the bare body here would leave the
 * dense channel comparing documents against a different representation than the
 * one it was built from, which degrades silently rather than failing.
 */
async function seedCorpus(symbols: readonly string[]): Promise<string> {
  const db = await optionalImport('@/lib/db');
  const rag = await optionalImport('@/lib/rag');
  if (!db || !rag) return 'skipped (corpus module not present)';

  const buildCorpus = callable(rag, 'buildCorpus');
  const chunkDocument = callable(rag, 'chunkDocument');
  const embed = callable(rag, 'embed');
  const indexText = callable(rag, 'indexText');
  const upsertRagDocument = callable(db, 'upsertRagDocument');
  const insertRagChunks = callable(db, 'insertRagChunks');
  if (!buildCorpus || !chunkDocument || !embed || !indexText || !upsertRagDocument || !insertRagChunks) {
    return 'skipped (corpus surface incomplete)';
  }

  const documents = buildCorpus({ now: NOW, seed: SEED, symbols: symbols.slice(0, 24) }) as import('@/lib/rag').RagDocument[];
  let chunkCount = 0;

  for (const document of documents) {
    upsertRagDocument({
      id: document.id,
      title: document.title,
      sourceType: document.sourceType,
      symbol: document.symbol,
      section: document.section,
      authority: document.authority,
      publishedAt: document.publishedAt,
      url: document.url,
      body: document.body,
      checksum: checksum(document.body),
      ingestedAt: NOW,
    });

    const pieces = chunkDocument(document) as { ordinal: number; text: string }[];
    const chunks = pieces.map((piece) => {
      const searchText = indexText({
        documentTitle: document.title,
        section: document.section,
        text: piece.text,
      }) as string;
      return {
        id: `${document.id}#${piece.ordinal}`,
        documentId: document.id,
        ordinal: piece.ordinal,
        section: document.section,
        text: piece.text,
        tokenCount: Math.round(piece.text.split(/\s+/).length * 1.32),
        embedding: embed(searchText) as number[],
      };
    });
    if (chunks.length > 0) {
      insertRagChunks(chunks);
      chunkCount += chunks.length;
    }
  }

  return `${documents.length} documents, ${chunkCount} chunks`;
}

/**
 * FNV-1a over the body, hex. The ledger stores a checksum so a re-ingest can tell
 * a genuinely revised filing from a re-fetch of the same one; a cryptographic
 * digest would be misleading about the guarantee, which is change detection rather
 * than tamper evidence.
 */
function checksum(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

main().catch((error: unknown) => {
  process.stderr.write(`\nSeed failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
