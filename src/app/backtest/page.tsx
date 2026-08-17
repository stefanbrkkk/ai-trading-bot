/**
 * Backtest — walk-forward simulation and the survival scorecard.
 *
 * The single most important thing on this page is that the scorecard is allowed to
 * fail, visibly, with the observed value next to the threshold it missed. A
 * back-test surface that only ever shows a passing result is marketing with a chart
 * attached; the number that matters to a reader deciding whether to trust a
 * strategy is the one it did *not* clear.
 *
 * The walk-forward folds are the second guard. A single in-sample result says
 * almost nothing — the interesting quantity is the efficiency ratio, out-of-sample
 * Sharpe over in-sample Sharpe, fold by fold. A strategy that fits beautifully and
 * degrades to nothing out of sample looks identical to a good one until you split
 * the sample, so the split is shown per fold rather than averaged into a headline.
 *
 * Strategies excluded from a daily-bar simulation are named in the warnings rather
 * than silently reported as zero trades. "No trades" and "could not be evaluated
 * here" are different findings, and conflating them would understate the strategy
 * count while looking like a complete result.
 */

'use client';

import { AsyncSlot, PageHeader, PageShell } from '@/components/PageState';
import { EquityCurve, MonthlyHeatmap, ReturnDistribution } from '@/components/charts';
import {
  Badge,
  DataRow,
  Divider,
  Notice,
  Panel,
  PanelHeader,
  StatGrid,
  StatTile,
  TableShell,
  Td,
  Th,
} from '@/components/ui/primitives';
import { useApi } from '@/lib/ui/api';
import {
  fractionAsPercent,
  integer,
  money,
  nyDate,
  percent,
  ratio,
  signedFractionAsPercent,
} from '@/lib/ui/format';

interface Metrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  averageWin: number;
  averageLoss: number;
  payoffRatio: number;
  totalReturn: number;
  cagr: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  maxDrawdown: number;
  maxDrawdownDurationDays: number;
  volatility: number;
  var95?: number;
  cvar95?: number;
  benchmarkReturn?: number;
  alpha?: number;
  beta?: number;
}

interface Fold {
  index: number;
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  inSampleSharpe: number;
  outOfSampleSharpe: number;
  outOfSampleReturn: number;
  trades: number;
  efficiency: number;
}

interface Trade {
  symbol: string;
  strategy: string;
  direction: string;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  quantity: number;
  netPnl: number;
  returnPercent?: number;
  exitReason?: string;
}

interface ScorecardRow {
  metric: string;
  observed: number;
  threshold: number;
  comparator: string;
  passed: boolean;
  rationale: string;
}

interface BacktestResponse {
  result: {
    id: string;
    createdAt: number;
    config: { symbols: string[]; startTime: number; endTime: number; initialCapital?: number; benchmarkSymbol?: string };
    metrics: Metrics;
    trades: Trade[];
    equityCurve: { time: number; equity: number; drawdown: number; benchmark: number; exposure: number }[];
    byStrategy: { strategy: string; trades: number; netPnl: number; winRate: number }[];
    monthlyReturns: { year: number; month: number; ret: number }[];
    folds: Fold[];
    warnings: string[];
  };
  scorecard: { rows: ScorecardRow[]; passed?: boolean; passedCount?: number };
  thresholds: Record<string, number>;
  cached: boolean;
}

export default function BacktestPage() {
  const backtest = useApi<BacktestResponse>('/backtest/run');

  return (
    <PageShell wide>
      <PageHeader
        eyebrow="Walk-forward simulation"
        title="Backtest"
        lede="A portfolio simulation over the seeded history, with the survival scorecard and the per-fold degradation. Thresholds that were missed are shown alongside what was observed."
      />

      <Notice tone="legal" className="mb-6">
        Back-tested results are hypothetical, carry the benefit of hindsight, and do not represent actual trading. They
        do not indicate future results. Simulated performance omits factors that affect real trading, including the
        market impact of the orders themselves.
      </Notice>

      <AsyncSlot state={backtest} label="Loading the simulation" lines={10}>
        {(data) => {
          const m = data.result.metrics;
          const failed = data.scorecard.rows.filter((row) => !row.passed);
          const tradeReturns = data.result.trades
            .map((t) => t.returnPercent ?? null)
            .filter((r): r is number => r !== null)
            .map((r) => r / 100);

          return (
            <>
              {data.result.warnings.length > 0 ? (
                <Notice tone="warning" title="Coverage" className="mb-5">
                  <ul className="space-y-1">
                    {data.result.warnings.map((warning, i) => (
                      <li key={i}>{warning}</li>
                    ))}
                  </ul>
                </Notice>
              ) : null}

              <StatGrid className="mb-5" columns={6}>
                <StatTile
                  label="Total return"
                  value={signedFractionAsPercent(m.totalReturn)}
                  tone={m.totalReturn >= 0 ? 'sage' : 'burgundy'}
                  footnote={`CAGR ${signedFractionAsPercent(m.cagr)}`}
                />
                <StatTile
                  label="Sharpe"
                  value={ratio(m.sharpe, 2)}
                  tone={m.sharpe >= 1 ? 'sage' : m.sharpe >= 0 ? 'neutral' : 'burgundy'}
                  footnote={`Sortino ${ratio(m.sortino, 2)}`}
                />
                <StatTile
                  label="Max drawdown"
                  value={fractionAsPercent(m.maxDrawdown)}
                  tone={m.maxDrawdown <= 0.15 ? 'sage' : 'burgundy'}
                  footnote={`${integer(m.maxDrawdownDurationDays)} days to recover`}
                />
                <StatTile
                  label="Profit factor"
                  value={Number.isFinite(m.profitFactor) ? ratio(m.profitFactor, 2) : '∞'}
                  tone={m.profitFactor >= 2 ? 'sage' : 'burgundy'}
                  footnote={`Payoff ${ratio(m.payoffRatio, 2)}`}
                />
                <StatTile
                  label="Win rate"
                  value={fractionAsPercent(m.winRate)}
                  footnote={`${integer(m.wins)}W / ${integer(m.losses)}L`}
                />
                <StatTile
                  label="Expectancy"
                  value={money(m.expectancy)}
                  tone={m.expectancy >= 0 ? 'sage' : 'burgundy'}
                  footnote="Per trade, net of costs"
                />
              </StatGrid>

              {/* ── Scorecard ─────────────────────────────────────────── */}
              <Panel className="mb-5" padded={false}>
                <div className="p-5 pb-0">
                  <PanelHeader
                    eyebrow="Survival scorecard"
                    title={
                      failed.length === 0
                        ? 'Every threshold cleared'
                        : `${integer(failed.length)} of ${integer(data.scorecard.rows.length)} thresholds missed`
                    }
                    detail="Fixed, published thresholds. A miss is displayed with the observed value next to it — a scorecard that only ever passes tells the reader nothing."
                    action={
                      <Badge tone={failed.length === 0 ? 'sage' : 'burgundy'}>
                        {failed.length === 0 ? 'passed' : 'failed'}
                      </Badge>
                    }
                  />
                </div>
                <div className="scroll-x mt-4">
                  <TableShell>
                    <thead>
                      <tr>
                        <Th>Metric</Th>
                        <Th align="right">Observed</Th>
                        <Th align="center">Test</Th>
                        <Th align="right">Threshold</Th>
                        <Th align="center">Result</Th>
                        <Th>Why this threshold</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.scorecard.rows.map((row) => (
                        <tr key={row.metric}>
                          <Td>{row.metric}</Td>
                          <Td align="right" numeric className={row.passed ? 'text-sage-bright' : 'text-burgundy-bright'}>
                            {formatScorecardValue(row.metric, row.observed)}
                          </Td>
                          <Td align="center">
                            <span className="font-mono text-2xs text-parchment-faint">{row.comparator}</span>
                          </Td>
                          <Td align="right" numeric>
                            {formatScorecardValue(row.metric, row.threshold)}
                          </Td>
                          <Td align="center">
                            <Badge tone={row.passed ? 'sage' : 'burgundy'}>{row.passed ? 'pass' : 'fail'}</Badge>
                          </Td>
                          <Td>
                            <span className="text-2xs leading-snug text-parchment-faint">{row.rationale}</span>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </TableShell>
                </div>
              </Panel>

              {/* ── Equity and distribution ───────────────────────────── */}
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
                <Panel>
                  <PanelHeader
                    eyebrow="Equity"
                    title="Curve, drawdown and benchmark"
                    detail={`${nyDate(data.result.config.startTime)} — ${nyDate(data.result.config.endTime)} across ${integer(data.result.config.symbols.length)} symbols.`}
                  />
                  <div className="scroll-x mt-4">
                    <EquityCurve points={data.result.equityCurve} />
                  </div>
                </Panel>

                <Panel>
                  <PanelHeader
                    eyebrow="Trade returns"
                    title="Distribution"
                    detail="Bin width by Freedman–Diaconis, so the shape is not an artefact of a chosen bin count."
                  />
                  <div className="scroll-x mt-4">
                    <ReturnDistribution
                      returns={tradeReturns}
                      {...(m.var95 === undefined ? {} : { var95: m.var95 })}
                      {...(m.cvar95 === undefined ? {} : { cvar95: m.cvar95 })}
                    />
                  </div>
                  <Divider className="my-4" />
                  <dl className="space-y-0.5">
                    <DataRow label="Volatility (ann.)" value={fractionAsPercent(m.volatility)} />
                    <DataRow label="Calmar" value={ratio(m.calmar, 2)} />
                    <DataRow label="Average win" value={money(m.averageWin)} />
                    <DataRow label="Average loss" value={money(m.averageLoss)} />
                    {m.beta !== undefined ? <DataRow label="Beta to benchmark" value={ratio(m.beta, 2)} /> : null}
                    {m.alpha !== undefined ? <DataRow label="Alpha" value={signedFractionAsPercent(m.alpha)} /> : null}
                  </dl>
                </Panel>
              </div>

              {/* ── Monthly heatmap ──────────────────────────────────── */}
              <Panel className="mt-5">
                <PanelHeader
                  eyebrow="Monthly returns"
                  title="Consistency, month by month"
                  detail="A headline return can be produced by one exceptional month. The grid shows whether it was."
                />
                <div className="scroll-x mt-4">
                  <MonthlyHeatmap returns={data.result.monthlyReturns} />
                </div>
              </Panel>

              {/* ── Walk-forward folds ───────────────────────────────── */}
              <Panel className="mt-5" padded={false}>
                <div className="p-5 pb-0">
                  <PanelHeader
                    eyebrow="Walk-forward"
                    title={`${integer(data.result.folds.length)} folds`}
                    detail="Efficiency is out-of-sample Sharpe over in-sample Sharpe. A strategy that fits well and degrades to nothing out of sample is indistinguishable from a good one until the sample is split."
                  />
                </div>
                <div className="scroll-x mt-4">
                  <TableShell>
                    <thead>
                      <tr>
                        <Th align="right">Fold</Th>
                        <Th>Train</Th>
                        <Th>Test</Th>
                        <Th align="right">IS Sharpe</Th>
                        <Th align="right">OOS Sharpe</Th>
                        <Th align="right">OOS return</Th>
                        <Th align="right">Trades</Th>
                        <Th align="right">Efficiency</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.result.folds.map((fold) => (
                        <tr key={fold.index}>
                          <Td align="right" numeric>
                            {integer(fold.index + 1)}
                          </Td>
                          <Td>
                            <span className="font-mono text-2xs text-parchment-faint">
                              {nyDate(fold.trainStart)} → {nyDate(fold.trainEnd)}
                            </span>
                          </Td>
                          <Td>
                            <span className="font-mono text-2xs text-parchment-faint">
                              {nyDate(fold.testStart)} → {nyDate(fold.testEnd)}
                            </span>
                          </Td>
                          <Td align="right" numeric>
                            {ratio(fold.inSampleSharpe, 2)}
                          </Td>
                          <Td
                            align="right"
                            numeric
                            className={fold.outOfSampleSharpe >= 0 ? 'text-sage-bright' : 'text-burgundy-bright'}
                          >
                            {ratio(fold.outOfSampleSharpe, 2)}
                          </Td>
                          <Td align="right" numeric>
                            {signedFractionAsPercent(fold.outOfSampleReturn)}
                          </Td>
                          <Td align="right" numeric>
                            {integer(fold.trades)}
                          </Td>
                          <Td
                            align="right"
                            numeric
                            className={fold.efficiency >= 0.5 ? 'text-sage-bright' : 'text-burgundy-bright'}
                          >
                            {Number.isFinite(fold.efficiency) ? ratio(fold.efficiency, 2) : '—'}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </TableShell>
                </div>
              </Panel>

              {/* ── Per strategy ─────────────────────────────────────── */}
              <Panel className="mt-5" padded={false}>
                <div className="p-5 pb-0">
                  <PanelHeader eyebrow="By strategy" title="Where the trades came from" />
                </div>
                <div className="scroll-x mt-4">
                  <TableShell>
                    <thead>
                      <tr>
                        <Th>Strategy</Th>
                        <Th align="right">Trades</Th>
                        <Th align="right">Win rate</Th>
                        <Th align="right">Net P&amp;L</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.result.byStrategy.map((row) => (
                        <tr key={row.strategy}>
                          <Td>{row.strategy.replace(/_/g, ' ')}</Td>
                          <Td align="right" numeric>
                            {integer(row.trades)}
                          </Td>
                          <Td align="right" numeric>
                            {fractionAsPercent(row.winRate)}
                          </Td>
                          <Td align="right" numeric className={row.netPnl >= 0 ? 'text-sage-bright' : 'text-burgundy-bright'}>
                            {money(row.netPnl)}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </TableShell>
                </div>
              </Panel>

              <p className="mt-6 font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
                Run {data.result.id} · {integer(data.result.trades.length)} trades ·{' '}
                {data.cached ? 'seeded fixture' : 'computed on request'}
              </p>
            </>
          );
        }}
      </AsyncSlot>
    </PageShell>
  );
}

/**
 * Formats a scorecard value in the unit its metric is measured in.
 *
 * Driven by the metric name because the scorecard mixes fractions (win rate,
 * drawdown) with pure ratios (profit factor, Sharpe) in one table. Rendering a
 * profit factor of 2 as "200%" or a win rate of 0.6 as "0.60" would each be wrong
 * in a way that changes how the row reads against its threshold.
 */
function formatScorecardValue(metric: string, value: number): string {
  if (!Number.isFinite(value)) return '∞';
  const name = metric.toLowerCase();
  if (name.includes('rate') || name.includes('drawdown') || name.includes('return')) {
    return percent(value * 100, 1);
  }
  return ratio(value, 2);
}
