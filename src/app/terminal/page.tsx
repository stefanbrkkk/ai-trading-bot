/**
 * The terminal — the daily published list.
 *
 * This is the surface the platform's regulatory posture rests on, so its shape is
 * dictated by that posture rather than by product instinct.
 *
 * The list is a **publication**: one ranking, identical for every subscriber,
 * generated on a fixed schedule. It is not personalised, not re-ranked, and it does
 * not respond to what the reader holds. That is what keeps it impersonal within the
 * publisher's exemption (Lowe v. SEC, 1985), and it is why there is no "for you"
 * anywhere on this page and no watchlist input that could reorder it.
 *
 * Every conviction score is a link to its own explanation rather than a
 * standalone number. A score with no visible derivation is an opinion; a score
 * that opens into its exact SHAP decomposition is a computation. The whole
 * interaction design here is in service of making the second reading the only
 * available one.
 */

'use client';

import Link from 'next/link';
import { AsyncSlot, PageHeader, PageShell } from '@/components/PageState';
import { ConvictionDial } from '@/components/charts';
import { Badge, DataRow, Notice, Panel, PanelHeader, StatGrid, StatTile } from '@/components/ui/primitives';
import { useApi, type HealthResponse } from '@/lib/ui/api';
import { fractionAsPercent, integer, nyDate, nyTime, price, signedFractionAsPercent } from '@/lib/ui/format';
import type { RegimeLabel, SignalDirection } from '@/lib/domain/types';

interface PublicationItem {
  rank: number;
  symbol: string;
  name: string;
  conviction: number;
  probability: number;
  direction: SignalDirection;
  regime: RegimeLabel;
  referencePrice: number;
  expectedReturn: number;
  strategy: string | null;
  signalId: string;
  topDriver: string;
}

interface Top5Response {
  publicationDate: string;
  publishedAt: number;
  items: PublicationItem[];
  notice: string;
  neutralityNotice: string;
  modelVersion: string;
  disclosures: { id: string; title: string }[];
}

const REGIME_LABELS: Record<RegimeLabel, string> = {
  trending_bull: 'Trending bull',
  trending_bear: 'Trending bear',
  mean_reverting: 'Mean reverting',
  high_volatility: 'High volatility',
  low_volatility_drift: 'Low-volatility drift',
  illiquid: 'Illiquid',
};

function directionTone(direction: SignalDirection): 'sage' | 'burgundy' | 'neutral' {
  return direction === 'long' ? 'sage' : direction === 'short' ? 'burgundy' : 'neutral';
}

/**
 * The published ranking as cards.
 *
 * Rank is rendered, and rendered prominently, because the ordering *is* the
 * publication — a reader who cannot see that this is position 3 of 5 might read the
 * card as a standalone call. The dial is the entry point to the explanation, so the
 * whole card is the link target rather than a "details" affordance tucked in a
 * corner.
 */
function PublicationCard({ item }: { item: PublicationItem }) {
  return (
    <Link
      href={`/terminal/${item.symbol}`}
      className="group block focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-gold"
      aria-label={`${item.symbol}, rank ${item.rank}, conviction ${integer(item.conviction)} of 100. Open the full attribution.`}
    >
      <Panel className="h-full transition-colors duration-200 group-hover:border-parchment-ghost">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono text-2xs text-parchment-faint">{String(item.rank).padStart(2, '0')}</span>
              <span className="display text-lg text-parchment">{item.symbol}</span>
            </div>
            <p className="mt-1 truncate text-[0.8125rem] text-parchment-dim" title={item.name}>
              {item.name}
            </p>
          </div>
          <Badge tone={directionTone(item.direction)}>{item.direction}</Badge>
        </div>

        <div className="mt-4 flex items-center gap-5">
          <ConvictionDial score={item.conviction} size={132} caption={item.direction} />
          <dl className="min-w-0 flex-1 space-y-1.5">
            <DataRow label="Probability" value={fractionAsPercent(item.probability)} />
            <DataRow label="Reference" value={price(item.referencePrice)} />
            <DataRow label="Expected" value={signedFractionAsPercent(item.expectedReturn)} />
            <DataRow label="Regime" value={REGIME_LABELS[item.regime]} />
          </dl>
        </div>

        <div className="mt-4 border-t border-obsidian-edge pt-3">
          <p className="eyebrow mb-1">Leading driver</p>
          <p className="text-[0.8125rem] leading-snug text-parchment-dim">{item.topDriver}</p>
        </div>
      </Panel>
    </Link>
  );
}

export default function TerminalPage() {
  // Polled rather than streamed: the publication changes once per session, and a
  // socket for a value that moves daily is machinery without a purpose. The
  // interval exists so a terminal left open overnight picks up the new list.
  const publication = useApi<Top5Response>('/signals/top5', { pollMs: 120_000 });
  const health = useApi<HealthResponse>('/health', { pollMs: 60_000 });

  return (
    <PageShell wide>
      <PageHeader
        eyebrow="Daily publication"
        title="Signal terminal"
        lede="One ranking, published on a fixed schedule and identical for every subscriber. Open any name for its exact attribution — every conviction score decomposes into the features that produced it."
        action={
          publication.data ? (
            <div className="text-right font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
              <p>{nyDate(publication.data.publishedAt)}</p>
              <p className="mt-1 text-parchment-dim">{nyTime(publication.data.publishedAt)}</p>
              <p className="mt-1">{publication.data.modelVersion}</p>
            </div>
          ) : null
        }
      />

      {/*
        The kill switch is surfaced at the top of the terminal, not buried in the
        admin console: while it is engaged no order can be routed, and a user
        reading a signal is entitled to know that before they try to act on it.
      */}
      {health.data?.killSwitch === true ? (
        <Notice tone="error" title="Order routing halted" className="mb-6">
          {health.data.killSwitchReason ??
            'Order routing is halted platform-wide. Analysis continues to publish; no order can be submitted.'}
        </Notice>
      ) : null}

      {/*
        Only when the publication itself resolved. The banner is here to warn that
        the engine is down while a list is still on screen; once the slot below is
        rendering its own "not ready" panel the two say the same thing twice, one
        above the other, which is what the first screen of a fresh deployment
        showed.
      */}
      {health.data?.engineReady === false && publication.error === null ? (
        <Notice tone="warning" title="Engine not ready" className="mb-6">
          {health.data.engineReason ?? 'The ensemble is unavailable.'} Run <code>npm run seed</code> to train and
          persist it.
        </Notice>
      ) : null}

      <AsyncSlot
        state={publication}
        label="Loading the publication"
        lines={6}
        isEmpty={(data) => data.items.length === 0}
        emptyTitle="No name qualified today"
        emptyDetail="The conviction threshold was not met by any symbol in the universe. An empty publication is a result, not a failure — the alternative would be publishing the highest of a set of weak signals as though it were strong."
      >
        {(data) => (
          <>
            <Notice tone="legal" className="mb-6">
              {data.notice}
            </Notice>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-3">
              {data.items.map((item) => (
                <PublicationCard key={item.signalId} item={item} />
              ))}
            </div>

            <Panel className="mt-6">
              <PanelHeader
                eyebrow="Publication integrity"
                title="What this list is, and what it is not"
                detail="Read this before acting on anything above."
              />
              <p className="mt-3 text-[0.8125rem] leading-relaxed text-parchment-dim">{data.neutralityNotice}</p>
              <StatGrid className="mt-5">
                <StatTile label="Names published" value={integer(data.items.length)} footnote="Fixed cap, not a target" />
                <StatTile label="Session" value={data.publicationDate} footnote="New York calendar date" />
                <StatTile label="Model version" value={data.modelVersion} footnote="Immutable; see Transparency" size="sm" />
                <StatTile
                  label="Data source"
                  value={health.data?.provider ?? '—'}
                  footnote={health.data?.providerLive === true ? 'Live feed' : 'Deterministic simulator'}
                />
              </StatGrid>
            </Panel>
          </>
        )}
      </AsyncSlot>
    </PageShell>
  );
}
