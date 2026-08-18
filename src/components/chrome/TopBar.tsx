'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { cx } from '@/components/ui/primitives';
import { nyTime } from '@/lib/ui/format';

/**
 * The terminal header: identity, market clock, session phase and the engine's own
 * health. Deliberately sterile — no marketing copy, no calls to action.
 */

interface HealthPayload {
  ok: boolean;
  marketPhase: string;
  marketOpen: boolean;
  now: number;
  provider: string;
  providerLive: boolean;
  aiProvider: string;
  aiLive: boolean;
  killSwitch: boolean;
  modelVersion: string | null;
  engineReady: boolean;
}

const PHASE_LABEL: Record<string, string> = {
  pre_market: 'Pre-market',
  opening_auction: 'Opening auction',
  morning: 'Morning session',
  midday: 'Midday session',
  closing_auction: 'Closing auction',
  after_hours: 'After hours',
  closed: 'Closed',
};

export function TopBar() {
  const [health, setHealth] = useState<HealthPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch('/api/health', { cache: 'no-store' });
        if (!response.ok) return;
        const payload = (await response.json()) as HealthPayload;
        if (!cancelled) setHealth(payload);
      } catch {
        // A failed health poll must not surface an error to the user; the strip
        // simply shows nothing rather than a scary banner.
      }
    };
    void load();
    // 60s: the header shows session state, not prices. Polling faster would burn
    // battery for no informational gain.
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <header className="sticky top-0 z-30 border-b border-obsidian-edge bg-vanta-deep/95 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-6 px-4 py-2.5 lg:px-6">
        <div className="flex items-baseline gap-3">
          {/* 63x17 painted; `tap-target` gives it a 44x44 hit region without
              moving the baseline it is aligned on. */}
          <Link
            href="/terminal"
            className="tap-target display text-[1.0625rem] leading-none tracking-tight text-parchment"
          >
            Aurelius
          </Link>
          <span className="hidden font-mono text-2xs uppercase tracking-institutional text-parchment-ghost sm:inline">
            Quantitative Signal Terminal
          </span>
        </div>

        <div className="flex items-center gap-4 lg:gap-6">
          {health?.killSwitch ? (
            <span className="border border-burgundy-bright/70 bg-burgundy/20 px-2 py-1 font-mono text-2xs uppercase tracking-institutional text-burgundy-bright">
              Routing halted
            </span>
          ) : null}

          <MarketState health={health} />

          <div className="hidden items-center gap-4 md:flex">
            <Indicator
              label="Data"
              value={health ? health.provider : '—'}
              live={health?.providerLive ?? false}
              title={
                health?.providerLive
                  ? 'A live market-data provider is serving.'
                  : 'The deterministic in-process simulator is serving. No API keys are configured.'
              }
            />
            <Indicator
              label="AI"
              value={health ? health.aiProvider : '—'}
              live={health?.aiLive ?? false}
              title={
                health?.aiLive
                  ? 'A live language-model provider is configured.'
                  : 'The deterministic narrative and query engines are serving. Add a provider key to switch to live inference.'
              }
            />
          </div>

          <span className="tabular text-xs text-parchment-dim" suppressHydrationWarning>
            {health ? nyTime(health.now) : '—'}
          </span>
        </div>
      </div>
    </header>
  );
}

function MarketState({ health }: { health: HealthPayload | null }) {
  const open = health?.marketOpen ?? false;
  const phase = health ? (PHASE_LABEL[health.marketPhase] ?? health.marketPhase) : '—';
  return (
    <div className="flex items-center gap-2" title={`Regular session ${open ? 'open' : 'closed'}`}>
      <span
        className={cx('inline-block h-1.5 w-1.5 rounded-full', open ? 'bg-sage-bright' : 'bg-parchment-ghost')}
        aria-hidden
      />
      <span className="font-mono text-2xs uppercase tracking-institutional text-parchment-dim">{phase}</span>
    </div>
  );
}

function Indicator({
  label,
  value,
  live,
  title,
}: {
  label: string;
  value: string;
  live: boolean;
  title: string;
}) {
  return (
    <div className="flex items-center gap-1.5" title={title}>
      <span className="eyebrow">{label}</span>
      <span className={cx('font-mono text-2xs uppercase tracking-institutional', live ? 'text-sage-bright' : 'text-parchment-faint')}>
        {value}
      </span>
    </div>
  );
}
