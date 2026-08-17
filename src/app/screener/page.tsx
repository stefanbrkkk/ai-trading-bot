/**
 * The universe screener.
 *
 * A filter over the published snapshot, and deliberately nothing more. The ranking
 * a user sees here is the same ranking every other user sees; narrowing it by
 * sector or conviction is a *view*, whereas re-ordering it per user would be
 * personalisation — and personalised ranking of securities is the line between
 * publishing analysis and giving advice.
 *
 * That is why sorting is offered but the default ordering is fixed and published,
 * why the filter state lives in the shared terminal store rather than on the
 * server, and why there is no "recommended for you" column. The user is choosing
 * what to look at, not asking the model to re-fit for them.
 */

'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AsyncSlot, PageHeader, PageShell } from '@/components/PageState';
import {
  Badge,
  Button,
  Field,
  INPUT_CLASS,
  Notice,
  Panel,
  PanelHeader,
  SELECT_CLASS,
  StatGrid,
  StatTile,
  TableShell,
  Td,
  Th,
} from '@/components/ui/primitives';
import { useApi } from '@/lib/ui/api';
import { compact, integer, percent, price, ratio, sigma, signedPercent } from '@/lib/ui/format';
import type { RegimeLabel, ScreenerRow, Sector, SignalDirection } from '@/lib/domain/types';

interface ScreenerResponse {
  rows: ScreenerRow[];
  total: number;
  matched: number;
  computedAt: number;
  provider: string;
  modelVersion: string;
  sectors: Sector[];
}

/**
 * Sort keys, matched to the server's enum.
 *
 * Sorting is applied server-side against the published snapshot so the ordering is
 * computed once from the same data for everyone. Sorting client-side would be
 * cheaper and would also mean two users with the same filter could see different
 * orderings if their payloads were fetched a moment apart.
 */
const SORT_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'conviction', label: 'Conviction' },
  { value: 'probability', label: 'Probability' },
  { value: 'changePercent', label: 'Session change' },
  { value: 'relativeVolume', label: 'Relative volume' },
  { value: 'rsi14', label: 'RSI (14)' },
  { value: 'ouZScore', label: 'OU z-score' },
  { value: 'mlofiIntent', label: 'MLOFI intent' },
  { value: 'riskReversal25', label: '25Δ risk reversal' },
  { value: 'altComposite', label: 'Alt-data composite' },
  { value: 'atrPercent', label: 'ATR %' },
  { value: 'marketCap', label: 'Market cap' },
  { value: 'adv30', label: '30-day ADV' },
  { value: 'symbol', label: 'Symbol' },
];

const REGIMES: readonly { value: RegimeLabel; label: string }[] = [
  { value: 'trending_bull', label: 'Trending bull' },
  { value: 'trending_bear', label: 'Trending bear' },
  { value: 'mean_reverting', label: 'Mean reverting' },
  { value: 'high_volatility', label: 'High volatility' },
  { value: 'low_volatility_drift', label: 'Low-vol drift' },
  { value: 'illiquid', label: 'Illiquid' },
];

function directionTone(direction: SignalDirection): 'sage' | 'burgundy' | 'ghost' {
  return direction === 'long' ? 'sage' : direction === 'short' ? 'burgundy' : 'ghost';
}

/**
 * Keeps the conviction filter inside the range the API accepts.
 *
 * An empty string is left alone — it means "no filter", not zero.
 */
function clampConviction(raw: string): string {
  if (raw.trim().length === 0) return '';
  const value = Number(raw);
  if (!Number.isFinite(value)) return '';
  return String(Math.max(0, Math.min(100, value)));
}

export default function ScreenerPage() {
  const [sector, setSector] = useState('');
  const [regime, setRegime] = useState('');
  const [direction, setDirection] = useState('');
  const [minConviction, setMinConviction] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('conviction');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  /**
   * The query string is the request identity, so it is what `useApi` keys on.
   * Built with `useMemo` rather than inline because an inline template literal is a
   * new string every render — which would make the effect's dependency change on
   * every keystroke and re-fetch continuously.
   */
  const path = useMemo(() => {
    const params = new URLSearchParams({ sortBy, sortDirection, limit: '200' });
    if (sector.length > 0) params.set('sectors', sector);
    if (regime.length > 0) params.set('regimes', regime);
    if (direction.length > 0) params.set('direction', direction);
    if (minConviction.length > 0) params.set('minConviction', minConviction);
    if (search.trim().length > 0) params.set('search', search.trim());
    return `/screener?${params.toString()}`;
  }, [sector, regime, direction, minConviction, search, sortBy, sortDirection]);

  const screener = useApi<ScreenerResponse>(path);

  function reset(): void {
    setSector('');
    setRegime('');
    setDirection('');
    setMinConviction('');
    setSearch('');
    setSortBy('conviction');
    setSortDirection('desc');
  }

  return (
    <PageShell wide>
      <PageHeader
        eyebrow="Full universe"
        title="Screener"
        lede="Every symbol in the published universe with the model features behind its score. Filtering narrows the shared list; it never re-ranks it for you."
        action={
          <Button variant="ghost" onClick={reset}>
            Reset filters
          </Button>
        }
      />

      <Panel className="mb-5">
        <PanelHeader eyebrow="Filters" title="Narrow the published list" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <Field label="Search">
            <input
              className={INPUT_CLASS}
              type="search"
              value={search}
              maxLength={80}
              placeholder="Symbol or name"
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          <Field label="Sector">
            <select className={SELECT_CLASS} value={sector} onChange={(e) => setSector(e.target.value)}>
              <option value="">All sectors</option>
              {(screener.data?.sectors ?? []).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Regime">
            <select className={SELECT_CLASS} value={regime} onChange={(e) => setRegime(e.target.value)}>
              <option value="">All regimes</option>
              {REGIMES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Direction">
            <select className={SELECT_CLASS} value={direction} onChange={(e) => setDirection(e.target.value)}>
              <option value="">Any</option>
              <option value="long">Long</option>
              <option value="short">Short</option>
              <option value="flat">Flat</option>
            </select>
          </Field>
          <Field label="Min conviction" hint="0–100">
            <input
              className={INPUT_CLASS}
              type="number"
              min={0}
              max={100}
              value={minConviction}
              /*
                Clamped on entry, because `min`/`max` on a number input are
                advisory: typing 999 sent `minConviction=999`, the API answered
                422, `useApi` kept the previous data, and the page went on showing
                a stale row set with a console error and nothing on screen to say
                the filter had not been applied.
              */
              onChange={(e) => setMinConviction(clampConviction(e.target.value))}
            />
          </Field>
          <Field label="Sort by">
            <select className={SELECT_CLASS} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Order">
            <select
              className={SELECT_CLASS}
              value={sortDirection}
              onChange={(e) => setSortDirection(e.target.value === 'asc' ? 'asc' : 'desc')}
            >
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
          </Field>
        </div>
      </Panel>

      <AsyncSlot
        state={screener}
        label="Sweeping the universe"
        lines={10}
        isEmpty={(data) => data.rows.length === 0}
        emptyTitle="No symbol matches these filters"
        emptyDetail="Widen a constraint. An empty result is the honest answer — the alternative would be relaxing your filter silently and showing you something you did not ask for."
      >
        {(data) => (
          <>
            <StatGrid className="mb-5" columns={4}>
              <StatTile label="Matched" value={integer(data.matched)} footnote={`of ${integer(data.total)} in the universe`} />
              <StatTile
                label="Directional"
                value={integer(data.rows.filter((r) => r.direction !== 'flat').length)}
                footnote="Long or short; the rest are flat"
              />
              <StatTile
                label="Median conviction"
                value={integer(median(data.rows.map((r) => r.conviction)))}
                footnote="Of the matched set"
              />
              <StatTile label="Model" value={data.modelVersion} size="sm" footnote={`Source: ${data.provider}`} />
            </StatGrid>

            <Panel padded={false}>
              {/*
                `TableShell` is itself a `.scroll-x`; the wrapper that used to sit
                here made a scroll container whose only child was another scroll
                container, so the outer one could never scroll and served only to
                double the measurement work.
              */}
              <TableShell>
                <thead>
                  <tr>
                    <Th>Symbol</Th>
                    <Th>Sector</Th>
                    <Th align="right">Price</Th>
                    <Th align="right">Change</Th>
                    <Th align="right">Conviction</Th>
                    <Th align="right">Prob.</Th>
                    <Th>Dir.</Th>
                    <Th align="right">Rel. vol</Th>
                    <Th align="right">RSI</Th>
                    <Th align="right">OU z</Th>
                    <Th align="right">MLOFI</Th>
                    <Th align="right">25Δ RR</Th>
                    <Th align="right">Alt</Th>
                    <Th align="right">ATR %</Th>
                    <Th align="right">Mkt cap</Th>
                    <Th>Leading driver</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.symbol} className="hover:bg-obsidian-light/50">
                      <Td>
                        <Link
                          href={`/terminal/${row.symbol}`}
                          className="font-mono text-parchment underline decoration-obsidian-edge hover:decoration-gold"
                        >
                          {row.symbol}
                        </Link>
                        <span className="ml-2 hidden text-2xs text-parchment-faint xl:inline">{row.name}</span>
                      </Td>
                      <Td>
                        <span className="text-2xs text-parchment-dim">{row.sector}</span>
                      </Td>
                      <Td align="right" numeric>
                        {price(row.price)}
                      </Td>
                      <Td align="right" numeric className={row.changePercent >= 0 ? 'text-sage-bright' : 'text-burgundy-bright'}>
                        {signedPercent(row.changePercent)}
                      </Td>
                      <Td align="right" numeric className="text-gold">
                        {integer(row.conviction)}
                      </Td>
                      <Td align="right" numeric>
                        {percent(row.probability * 100, 1)}
                      </Td>
                      <Td>
                        <Badge tone={directionTone(row.direction)}>{row.direction}</Badge>
                      </Td>
                      <Td align="right" numeric>
                        {ratio(row.relativeVolume, 2)}
                      </Td>
                      <Td align="right" numeric>
                        {integer(row.rsi14)}
                      </Td>
                      <Td align="right" numeric>
                        {sigma(row.ouZScore)}
                      </Td>
                      <Td align="right" numeric>
                        {sigma(row.mlofiIntent)}
                      </Td>
                      <Td align="right" numeric>
                        {ratio(row.riskReversal25, 2)}
                      </Td>
                      <Td align="right" numeric>
                        {ratio(row.altComposite, 2)}
                      </Td>
                      <Td align="right" numeric>
                        {percent(row.atrPercent, 1)}
                      </Td>
                      <Td align="right" numeric>
                        {compact(row.marketCap, 1)}
                      </Td>
                      <Td>
                        <span className="text-2xs text-parchment-faint">{row.topDriver}</span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            </Panel>

            <Notice tone="legal" className="mt-5">
              Every column is an impersonal computed statistic. No column, and no ordering of them, is a recommendation
              to buy or sell any security. Filtering does not change what the model computed.
            </Notice>
          </>
        )}
      </AsyncSlot>
    </PageShell>
  );
}

/**
 * Median of the matched conviction scores.
 *
 * This is the one arithmetic operation on this page, and it is a summary of a
 * client-side *selection* rather than a model quantity — the server cannot compute
 * it because the server does not know which rows survived the filter. Everything
 * the model produced arrives pre-computed.
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
}
