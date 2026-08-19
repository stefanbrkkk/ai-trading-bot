'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { cx } from '@/components/ui/primitives';
import { AccountMenu } from './AccountMenu';
import { nyTime } from '@/lib/ui/format';

/**
 * The terminal header: identity, market clock, session phase and the engine's own
 * health. Deliberately sterile — no marketing copy, no calls to action.
 *
 * Every field in the right-hand cluster reserves the width of its own longest
 * settled value, and the row reserves its own height, because this header was the
 * single largest source of layout shift in the product. `health` starts `null`,
 * so the phase, both provider indicators and the clock all render a 7px em-dash
 * and then grow to 44–111px when `/api/health` answers; the account menu appears
 * from a one-character placeholder into a 24px-tall bordered control at the same
 * moment. Measured with a buffered `layout-shift` observer on a cold context, the
 * cluster's left edge jumped 362px and the row grew 40px → 45px, taking the whole
 * document column down 5px with it: 0.198 of CLS from the chrome alone — twice
 * the 0.1 budget before a single piece of page content has moved. `TopBar`
 * returns its `<header>` unconditionally and the root layout that renders it has
 * no sibling, so that was every one of the sixteen routes, /login, /signup and
 * /onboarding included. The denominator here used to be three short: it left out
 * those three auth pages, which carry the same header as every other route and
 * are the three a new client sees first.
 *
 * The reservations are measured, not guessed, and every value set they cover is a
 * closed union — `ProviderName` in `lib/market/provider`, `ProviderId` in
 * `lib/ai/config`, `PHASE_LABEL` below — so a new member is the one thing that
 * can invalidate them. Widths at 10px mono with `tracking-institutional`:
 * "CLOSING AUCTION" 111, "DETERMINISTIC" 96.2, "SIMULATOR" 66.6, and the clock's
 * fixed `HH:MM ET` 56.3 at 12px tabular.
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
      {/* `h-11` rather than `py-2.5`: 44px is the height this row settles at once
          the account menu has rendered its real control, and a fixed height is
          what stops the settling from moving every page's first paragraph down
          five pixels. */}
      <div className="flex h-11 items-center justify-between gap-6 px-4 lg:px-6">
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

          {/* `lg`, not `md`. Turning this group on at 768 was exactly where the
              header ran out of room: the tagline arrives at `sm` and the two
              indicators at `md`, so at 768 the identity block (230px), the gap
              (24px) and the right cluster (482px) came to 736px against 736px of
              content width and both blocks wrapped. The header measured 54px
              instead of 45px from 768 through ~874 on every route. */}
          <div className="hidden items-center gap-4 lg:flex">
            <Indicator
              label="Data"
              value={health ? health.provider : '—'}
              /* SIMULATOR, the longest of the three `ProviderName`s, is 66.6px. */
              reserve="min-w-[4.25rem]"
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
              /* DETERMINISTIC, the longest of the four `ProviderId`s, is 96.2px. */
              reserve="min-w-[6.125rem]"
              live={health?.aiLive ?? false}
              title={
                health?.aiLive
                  ? 'A live language-model provider is configured.'
                  : 'The deterministic narrative and query engines are serving. Add a provider key to switch to live inference.'
              }
            />
          </div>

          {/* `nyTime` is a fixed-width `HH:MM ET` — 2-digit hour, 2-digit minute,
              tabular figures — so 3.625rem holds every value it can ever take.
              `inline-block` because a min-width on an inline box is ignored. */}
          <span
            className="tabular hidden min-w-[3.625rem] text-xs text-parchment-dim sm:inline-block"
            suppressHydrationWarning
          >
            {health ? nyTime(health.now) : '—'}
          </span>

          {/* Who is signed in, and the way out. There was no way out. */}
          <AccountMenu />
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
      {/* CLOSING AUCTION / OPENING AUCTION / MORNING SESSION all measure 111px,
          the widest any `PHASE_LABEL` gets. */}
      <span className="min-w-[7rem] font-mono text-2xs uppercase tracking-institutional text-parchment-dim">
        {phase}
      </span>
    </div>
  );
}

function Indicator({
  label,
  value,
  live,
  title,
  reserve,
}: {
  label: string;
  value: string;
  live: boolean;
  title: string;
  /**
   * Tailwind `min-w-*` holding the widest value this indicator can ever show.
   *
   * Passed in rather than derived, because the two indicators draw from two
   * different closed unions and reserving the wider of them for both would leave
   * 30px of permanent dead space beside the data provider. A literal at the call
   * site is also what keeps the class in Tailwind's scan.
   */
  reserve: string;
}) {
  return (
    <div className="flex items-center gap-1.5" title={title}>
      <span className="eyebrow">{label}</span>
      <span
        className={cx(
          'font-mono text-2xs uppercase tracking-institutional',
          reserve,
          live ? 'text-sage-bright' : 'text-parchment-faint',
        )}
      >
        {value}
      </span>
    </div>
  );
}
