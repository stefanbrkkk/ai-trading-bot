import type { ReactNode } from 'react';

/**
 * Shared surface and typography primitives.
 *
 * These exist so the "Old Money" treatment is applied in one place: obsidian
 * plinths with wide blurred shadows, small-caps monospaced eyebrows above every
 * data block, and gold reserved for conviction and primary interaction only.
 */

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Surfaces
// ─────────────────────────────────────────────────────────────────────────────

export function Panel({
  children,
  className,
  flat,
  gilt,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  flat?: boolean;
  gilt?: boolean;
  padded?: boolean;
}) {
  return (
    <section
      className={cx(
        flat ? 'plinth-flat' : 'plinth',
        gilt && 'gilt-edge',
        padded && 'p-5',
        'relative',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function PanelHeader({
  eyebrow,
  title,
  detail,
  action,
  className,
}: {
  eyebrow?: string;
  title?: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx('flex items-start justify-between gap-6', className)}>
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow mb-2">{eyebrow}</p> : null}
        {title ? <h2 className="display text-lg text-parchment leading-tight">{title}</h2> : null}
        {detail ? <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-parchment-dim">{detail}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('eyebrow', className)}>{children}</p>;
}

export function Divider({ className }: { className?: string }) {
  return <div className={cx('h-px w-full bg-obsidian-edge/60', className)} />;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Data display
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The core numeric tile. Label above, figure below, optional delta and footnote.
 * The figure is always tabular so a column of tiles aligns on the decimal.
 */
export function StatTile({
  label,
  value,
  unit,
  delta,
  footnote,
  tone = 'neutral',
  size = 'md',
  className,
  title,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  delta?: ReactNode;
  footnote?: ReactNode;
  tone?: 'neutral' | 'gold' | 'sage' | 'burgundy' | 'dim';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  title?: string;
}) {
  const toneClass = {
    neutral: 'text-parchment',
    gold: 'text-gold',
    sage: 'text-sage-bright',
    burgundy: 'text-burgundy-bright',
    dim: 'text-parchment-dim',
  }[tone];
  const sizeClass = { sm: 'text-base', md: 'text-xl', lg: 'text-3xl' }[size];

  return (
    <div className={cx('min-w-0', className)} title={title}>
      <p className="eyebrow mb-1.5 truncate">{label}</p>
      <p className={cx('tabular leading-none', sizeClass, toneClass)}>
        {value}
        {unit ? <span className="ml-1 text-[0.6875rem] text-parchment-faint">{unit}</span> : null}
      </p>
      {delta ? <p className="tabular mt-1.5 text-[0.6875rem]">{delta}</p> : null}
      {footnote ? <p className="mt-1.5 text-[0.6875rem] leading-snug text-parchment-faint">{footnote}</p> : null}
    </div>
  );
}

export function StatGrid({
  children,
  columns = 4,
  className,
}: {
  children: ReactNode;
  columns?: 2 | 3 | 4 | 5 | 6;
  className?: string;
}) {
  const cols = {
    2: 'grid-cols-2',
    3: 'grid-cols-2 sm:grid-cols-3',
    4: 'grid-cols-2 sm:grid-cols-4',
    5: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5',
    6: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6',
  }[columns];
  return <div className={cx('grid gap-x-6 gap-y-5', cols, className)}>{children}</div>;
}

export function Badge({
  children,
  tone = 'neutral',
  className,
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'gold' | 'sage' | 'burgundy' | 'ghost';
  className?: string;
  title?: string;
}) {
  const toneClass = {
    neutral: 'border-obsidian-edge text-parchment-dim',
    gold: 'border-gold/45 text-gold bg-gold/[0.07]',
    sage: 'border-sage/50 text-sage-bright bg-sage/[0.1]',
    burgundy: 'border-burgundy/50 text-burgundy-bright bg-burgundy/[0.1]',
    ghost: 'border-transparent text-parchment-ghost',
  }[tone];
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1.5 border px-2 py-[3px] font-mono text-2xs uppercase tracking-institutional',
        toneClass,
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A labelled key/value row, for dense specification lists. */
export function DataRow({
  label,
  value,
  hint,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cx('hairline flex items-baseline justify-between gap-4 py-2', className)} title={hint}>
      <span className="min-w-0 text-[0.8125rem] text-parchment-dim">{label}</span>
      <span className="tabular shrink-0 text-[0.8125rem] text-parchment">{value}</span>
    </div>
  );
}

/**
 * A horizontal meter. Used for driver shares, agent weights and gate progress.
 * Deliberately not a chart: it is a single proportion, so a bar is the honest
 * encoding and needs no axis.
 */
export function Meter({
  value,
  tone = 'gold',
  height = 3,
  className,
  label,
}: {
  /** 0…1 */
  value: number;
  tone?: 'gold' | 'sage' | 'burgundy' | 'dim';
  height?: number;
  className?: string;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100;
  const bg = { gold: 'bg-gold', sage: 'bg-sage-bright', burgundy: 'bg-burgundy-bright', dim: 'bg-parchment-ghost' }[tone];
  return (
    <div
      className={cx('w-full bg-obsidian-light', className)}
      style={{ height }}
      role="meter"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? 'proportion'}
    >
      <div className={cx('h-full', bg)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Signed meter: fills right from centre for positive, left for negative. This is
 * the encoding used for order-flow intent and for the compact driver bars.
 */
export function SignedMeter({
  value,
  height = 3,
  className,
  label,
}: {
  /** −1…1 */
  value: number;
  height?: number;
  className?: string;
  label?: string;
}) {
  const v = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
  const pct = Math.abs(v) * 50;
  return (
    <div
      className={cx('relative w-full bg-obsidian-light', className)}
      style={{ height }}
      role="meter"
      aria-valuenow={Math.round(v * 100)}
      aria-valuemin={-100}
      aria-valuemax={100}
      aria-label={label ?? 'signed proportion'}
    >
      <div className="absolute inset-y-0 left-1/2 w-px bg-obsidian-edge" />
      <div
        className={cx('absolute inset-y-0', v >= 0 ? 'bg-sage-bright' : 'bg-burgundy-bright')}
        style={v >= 0 ? { left: '50%', width: `${pct}%` } : { right: '50%', width: `${pct}%` }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Messaging
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The notice block. `tone="legal"` renders the mandated conspicuous treatment for
 * risk disclosures: capitalised, bold, stark, no marketing language.
 */
export function Notice({
  children,
  tone = 'info',
  title,
  className,
}: {
  children: ReactNode;
  tone?: 'info' | 'warning' | 'error' | 'legal' | 'neutral';
  title?: string;
  className?: string;
}) {
  const toneClass = {
    info: 'border-l-gold/60 bg-gold/[0.045] text-parchment-dim',
    warning: 'border-l-gold bg-gold/[0.07] text-parchment',
    error: 'border-l-burgundy-bright bg-burgundy/[0.09] text-parchment',
    legal: 'border-l-parchment-faint bg-vanta-deep text-parchment',
    neutral: 'border-l-obsidian-edge bg-vanta-deep text-parchment-dim',
  }[tone];
  return (
    <div
      className={cx('border border-obsidian-edge border-l-2 px-4 py-3 text-[0.8125rem] leading-relaxed', toneClass, className)}
      role={tone === 'error' ? 'alert' : undefined}
    >
      {title ? (
        <p className={cx('mb-1.5 font-mono text-2xs uppercase tracking-institutional', tone === 'error' ? 'text-burgundy-bright' : 'text-parchment-faint')}>
          {title}
        </p>
      ) : null}
      <div className={tone === 'legal' ? 'font-semibold uppercase leading-relaxed tracking-wide' : undefined}>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  action,
  className,
}: {
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col items-center justify-center gap-3 px-6 py-14 text-center', className)}>
      <p className="display text-base text-parchment-dim">{title}</p>
      {detail ? <p className="max-w-md text-[0.8125rem] leading-relaxed text-parchment-faint">{detail}</p> : null}
      {action}
    </div>
  );
}

/** Skeleton block for Suspense fallbacks. No shimmer — a shimmer is a nudge. */
export function Skeleton({ className, lines = 1 }: { className?: string; lines?: number }) {
  return (
    <div className={cx('space-y-2', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-3 w-full bg-obsidian-light/70" style={{ width: `${100 - i * 7}%` }} />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tables
// ─────────────────────────────────────────────────────────────────────────────

export function TableShell({
  children,
  className,
  minWidth = 900,
}: {
  children: ReactNode;
  className?: string;
  minWidth?: number;
}) {
  return (
    <div className={cx('scroll-x', className)}>
      <table className="w-full border-collapse text-[0.8125rem]" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  align = 'left',
  className,
  title,
  onClick,
  sorted,
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  title?: string;
  onClick?: () => void;
  sorted?: 'asc' | 'desc' | null;
}) {
  const alignClass = { left: 'text-left', right: 'text-right', center: 'text-center' }[align];
  return (
    <th
      scope="col"
      title={title}
      className={cx(
        'sticky top-0 z-10 border-b border-obsidian-edge bg-charcoal px-3 py-2.5 font-mono text-2xs font-normal uppercase tracking-institutional text-parchment-faint',
        alignClass,
        onClick && 'cursor-pointer select-none hover:text-parchment-dim',
        className,
      )}
      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
      onClick={onClick}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sorted ? <span className="text-gold">{sorted === 'asc' ? '↑' : '↓'}</span> : null}
      </span>
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  className,
  numeric,
  title,
  colSpan,
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  numeric?: boolean;
  title?: string;
  colSpan?: number;
}) {
  const alignClass = { left: 'text-left', right: 'text-right', center: 'text-center' }[align];
  return (
    <td
      colSpan={colSpan}
      title={title}
      className={cx('border-b border-obsidian-edge/50 px-3 py-2 align-middle', alignClass, numeric && 'tabular', className)}
    >
      {children}
    </td>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Controls
// ─────────────────────────────────────────────────────────────────────────────

export function Button({
  children,
  variant = 'default',
  size = 'md',
  className,
  ...rest
}: {
  children: ReactNode;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & { className?: string }) {
  const variantClass = {
    default: 'border-obsidian-edge bg-obsidian text-parchment hover:border-parchment-ghost hover:bg-obsidian-light',
    primary: 'border-gold/60 bg-gold/[0.09] text-gold hover:bg-gold/[0.16] hover:border-gold',
    danger: 'border-burgundy/60 bg-burgundy/[0.1] text-burgundy-bright hover:bg-burgundy/[0.18]',
    ghost: 'border-transparent text-parchment-dim hover:text-parchment hover:border-obsidian-edge',
  }[variant];
  const sizeClass = { sm: 'px-2.5 py-1 text-2xs', md: 'px-3.5 py-1.5 text-xs', lg: 'px-5 py-2.5 text-[0.8125rem]' }[size];
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-2 border font-mono uppercase tracking-institutional transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-obsidian-edge disabled:hover:bg-transparent',
        variantClass,
        sizeClass,
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  required,
  error,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  required?: boolean;
  error?: string | null;
  className?: string;
}) {
  return (
    <label className={cx('block', className)}>
      <span className="eyebrow mb-1.5 flex items-center gap-1.5">
        {label}
        {required ? <span className="text-gold">•</span> : null}
      </span>
      {children}
      {error ? <span className="mt-1.5 block text-[0.6875rem] text-burgundy-bright">{error}</span> : null}
      {hint && !error ? <span className="mt-1.5 block text-[0.6875rem] leading-snug text-parchment-faint">{hint}</span> : null}
    </label>
  );
}

export const INPUT_CLASS =
  'w-full border border-obsidian-edge bg-vanta-deep px-3 py-2 font-mono text-[0.8125rem] text-parchment placeholder:text-parchment-ghost';

export const SELECT_CLASS = `${INPUT_CLASS} appearance-none bg-[length:10px] bg-[right_0.75rem_center] bg-no-repeat pr-8`;
