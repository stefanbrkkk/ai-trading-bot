'use client';

import { useTerminalStore } from '@/components/TerminalProvider';
import { selectActiveAsset, selectRefreshMode } from '@/store/terminalStore';
import { cx } from '@/components/ui/primitives';

/**
 * The footer strip. Reports what the engine is doing, in the sterile register of
 * a Bloomberg status line — never a nudge, never a countdown.
 *
 * Each field reads a single primitive from the store through its own atomic
 * selector, so a driver-array update elsewhere does not re-render this strip.
 */
export function StatusStrip() {
  const activeAsset = useTerminalStore(selectActiveAsset);
  const refreshMode = useTerminalStore(selectRefreshMode);

  return (
    <footer className="sticky bottom-0 z-20 border-t border-obsidian-edge bg-vanta-deep/95 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-4 px-4 py-1.5 lg:px-6">
        {/*
          The three fields wrap rather than scroll. At 390px they are 24px wider
          than the viewport, and a status line that clips its last field —
          "execution: manual o…" — misreports the one field that matters most.
          Wrapping costs a second row on the narrowest phones; `main` already
          reserves `pb-16`, so nothing is obscured either way.
        */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-0.5">
          <Field label="Focus" value={activeAsset || 'none'} />
          <Field
            label="Cadence"
            value={refreshMode === 'day_trading' ? 'intraday' : 'end of day'}
            tone={refreshMode === 'day_trading' ? 'gold' : 'dim'}
          />
          <Field label="Execution" value="manual only" tone="sage" />
        </div>
        <p className="hidden shrink-0 font-mono text-2xs uppercase tracking-institutional text-parchment-ghost lg:block">
          Impersonal computation · no auto-execution · every order requires your click
        </p>
      </div>
    </footer>
  );
}

function Field({
  label,
  value,
  tone = 'dim',
}: {
  label: string;
  value: string;
  tone?: 'dim' | 'gold' | 'sage';
}) {
  const toneClass = { dim: 'text-parchment-faint', gold: 'text-gold', sage: 'text-sage-bright' }[tone];
  return (
    <span className="flex shrink-0 items-baseline gap-1.5">
      <span className="eyebrow">{label}</span>
      <span className={cx('font-mono text-2xs uppercase tracking-institutional', toneClass)}>{value}</span>
    </span>
  );
}
