import Link from 'next/link';
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
  as: Heading = 'h2',
}: {
  eyebrow?: string;
  title?: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  className?: string;
  /**
   * Heading level. `h2` everywhere except the two pages that have no
   * `PageHeader` — /login and /signup opened at `h2` with no `h1` above it, which
   * is a broken outline on the first two pages anyone sees.
   */
  as?: 'h1' | 'h2';
}) {
  return (
    /*
     * Stacked below `sm`, side by side above it.
     *
     * As a row at every width the action had to be `shrink-0` — a badge row or a
     * timestamp block is unreadable squeezed — and `shrink-0` means it keeps its
     * max-content width even when the panel is 350px wide. Three version badges
     * then measured 433px and pushed the whole page into horizontal scroll.
     * Stacking hands the action the full panel width on a phone, which is both
     * where it fits and where it reads better.
     */
    <header className={cx('flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6', className)}>
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow mb-2">{eyebrow}</p> : null}
        {title ? <Heading className="display text-lg text-parchment leading-tight">{title}</Heading> : null}
        {detail ? <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-parchment-dim">{detail}</p> : null}
      </div>
      {action ? <div className="min-w-0 sm:shrink-0">{action}</div> : null}
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
      {/*
        Wraps on a phone, truncates from `sm` up.

        Truncation keeps a row of tiles on one line where there is room for it,
        and `title` recovers the rest — on a pointer device. On a phone there is
        no hover and no room: at 375px "Local-accuracy residual" needed 170px in a
        107px tile and rendered as "Local-accuracy resid…", unrecoverable.

        Two lines are reserved below `sm` so a wrapped label does not push its own
        figure below its neighbour's — the grid stretches every cell to the row's
        height, which keeps the tiles the same size but not their contents in the
        same place. The longest label in the product is 23 characters and wraps to
        two lines at 375px, never three.
      */}
      <p className="eyebrow mb-1.5 min-h-[2em] leading-none sm:min-h-0 sm:truncate" title={label}>
        {label}
      </p>
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
    // Five and six across only from `xl`. At `lg` the content area is 764px, so
    // six tiles shared 107px each and "In-sample accuracy" rendered as
    // "IN-SAMPLE ACC…" on the model card's headline row.
    5: 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-5',
    6: 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-6',
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

/**
 * Tone for a signed figure. Zero is neutral.
 *
 * `value >= 0 ? 'sage' : 'burgundy'` painted a flat P&L, a zero rejection count
 * and an empty position book in the same green as a genuine gain, so a page with
 * nothing in it read as a page where everything had gone well. Absence is not a
 * positive result, and the palette should not claim it is.
 */
export function signTone(value: number): 'sage' | 'burgundy' | 'neutral' {
  if (!Number.isFinite(value) || value === 0) return 'neutral';
  return value > 0 ? 'sage' : 'burgundy';
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
    /*
     * Neither span may be allowed to shrink below its own min-content width.
     *
     * `min-w-0` on the label and `shrink-0` on the value is the combination that
     * looks reasonable and is wrong: a long value refuses to give up any width, so
     * flexbox takes it all from the label, squeezes it past its intrinsic minimum,
     * and the label's text spills out of its box and lands on top of the value.
     * Leaving both at the flex default (`min-width: auto`) floors each at
     * min-content, so a long value wraps within its own column instead — hence
     * `text-right`, which keeps a wrapped value aligned to the same edge as a
     * single-line one.
     */
    <div
      className={cx('hairline flex flex-wrap items-baseline justify-between gap-x-4 py-2', className)}
      title={hint}
    >
      {/*
        `<dt>`/`<dd>`, because every caller renders these inside a `<dl>`.
        As two `<span>`s the twenty description lists in the product contained no
        `dt` and no `dd` at all, so a screen reader read "Probability61.0%" as one
        undifferentiated run instead of a term and its definition. A `<div>`
        wrapper is valid inside `<dl>` precisely so a row can be styled as a unit.
      */}
      <dt className="text-[0.8125rem] text-parchment-dim">{label}</dt>
      {/*
        `flex-wrap` is the escape valve. Neither element shrinks past min-content,
        so on a 320px phone a long label beside a long value could still add up to
        more than the card — 13px of page-level horizontal scroll on /terminal.
        Wrapping drops the value to its own line instead, still right-aligned.
      */}
      <dd className="tabular ml-auto text-right text-[0.8125rem] text-parchment">{value}</dd>
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
    /*
     * The table is as tall as its content and the page is the only vertical
     * scroller.
     *
     * A `max-height` was tried here, to give `Th`'s `sticky top-0` a scrollport to
     * pin against — `overflow-x: auto` computes `overflow-y` to `auto`, so this box
     * is a scrollport in both axes and a sticky header inside it pins to the box
     * rather than to the viewport. It worked, and it was worse: the screener became
     * a 888px pane holding 3,801px of rows, so 52 of 67 names were behind an inner
     * scrollbar that nothing on the page announced. Losing a header on a long scroll
     * is a smaller cost than losing three quarters of the rows, so the cap is gone
     * and `Th` no longer claims to stick.
     */
    /*
     * The floor is released below `sm`.
     *
     * 900px is right for a numeric grid on a laptop and wrong for a phone: at
     * 320px the scrollport is 278px, so a prose column like /control's rationale
     * cell began 97px to the *right* of the visible edge and reading one sentence
     * took a 600px sideways swipe. Below `sm` the table lays out to the width it
     * has and wraps; from `sm` up the floor returns and the region scrolls, with
     * the edge fade and keyboard access `ScrollAffordance` gives it.
     */
    <div className={cx('scroll-x', className)}>
      <table
        className="w-full border-collapse text-[0.8125rem]"
        style={{ ['--table-min-width' as string]: `${minWidth}px` }}
      >
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
        'border-b border-obsidian-edge bg-charcoal px-3 py-2.5 font-mono text-2xs font-normal uppercase tracking-institutional text-parchment-faint',
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

/** Shared visual treatment, so a link styled as a button is identical to one. */
export function buttonClass(
  variant: 'default' | 'primary' | 'danger' | 'ghost' = 'default',
  size: 'sm' | 'md' | 'lg' = 'md',
  className?: string,
): string {
  const variantClass = {
    default: 'border-obsidian-edge bg-obsidian text-parchment hover:border-parchment-ghost hover:bg-obsidian-light',
    primary: 'border-gold/60 bg-gold/[0.09] text-gold hover:bg-gold/[0.16] hover:border-gold',
    danger: 'border-burgundy/60 bg-burgundy/[0.1] text-burgundy-bright hover:bg-burgundy/[0.18]',
    ghost: 'border-transparent text-parchment-dim hover:text-parchment hover:border-obsidian-edge',
  }[variant];
  const sizeClass = { sm: 'px-2.5 py-1 text-2xs', md: 'px-3.5 py-1.5 text-xs', lg: 'px-5 py-2.5 text-[0.8125rem]' }[size];
  return cx(
    'inline-flex items-center justify-center gap-2 border font-mono uppercase tracking-institutional transition-colors duration-150',
    'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-obsidian-edge disabled:hover:bg-transparent',
    variantClass,
    sizeClass,
    className,
  );
}

export function Button({
  children,
  variant = 'default',
  size = 'md',
  className,
  busy,
  onClick,
  ...rest
}: {
  children: ReactNode;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  /**
   * In flight, as distinct from `disabled`.
   *
   * Setting `disabled` on the focused button is what a submit handler naturally
   * does, and it throws focus to `<body>`: the keyboard user loses their place
   * mid-form and a screen reader stops narrating the thing it was just on. This
   * keeps the element focusable and inert instead — `aria-disabled` for the
   * announcement, the same dimmed treatment, and activation swallowed — so
   * focus survives the round trip and lands back on a live button when the
   * request returns.
   *
   * `disabled` stays the right prop for a control that is unavailable because
   * the form is incomplete: nobody is focused on it at the moment it flips.
   */
  busy?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & { className?: string }) {
  const inert = busy === true;
  return (
    <button
      type="button"
      {...rest}
      aria-disabled={inert || rest.disabled === true ? true : undefined}
      aria-busy={inert ? true : undefined}
      onClick={
        inert
          ? (event) => {
              // Also cancels an implicit submit raised by Enter in a text field,
              // which is the double-submit this guard exists to stop.
              event.preventDefault();
            }
          : onClick
      }
      /*
       * `pointer-events-none` so the hover treatment does not fire on a control
       * that will not act. It does not remove the element from the tab order and
       * does not stop a keyboard activation, which is why the click guard above
       * is still needed.
       */
      className={buttonClass(variant, size, cx(inert && 'pointer-events-none opacity-40', className))}
    >
      {children}
    </button>
  );
}

/**
 * A link that looks like a button.
 *
 * Ten call sites wrote `<Link><Button>…</Button></Link>`, which is two nested
 * interactive elements for one destination: two tab stops, the accessible name
 * announced twice, and invalid HTML — `<button>` is not permitted inside `<a>`.
 * Safari and VoiceOver disagree about which of the two is activated. Sharing
 * `buttonClass` keeps the two visually identical, so the fix costs nothing on
 * screen.
 */
export function ButtonLink({
  href,
  children,
  variant = 'default',
  size = 'md',
  className,
  ...rest
}: {
  href: string;
  children: ReactNode;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'href'> & { className?: string }) {
  return (
    <Link href={href} {...rest} className={buttonClass(variant, size, className)}>
      {children}
    </Link>
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
    /*
     * The `<label>` wraps the control and nothing else that carries text.
     *
     * A control inside a `<label>` takes its accessible name from the label's
     * whole subtree, so with the hint inside it the quantity input announced as
     * "Quantity (shares) • Whole shares. There is no suggested value." — the
     * marker read aloud as "bullet", and a paragraph of guidance became part of
     * the field's name rather than its description. Hint and error are siblings
     * of the label now, and the marker is a visually-hidden "(required)".
     */
    <div className={cx('block', className)}>
      <label className="block">
        <span className="eyebrow mb-1.5 flex items-center gap-1.5">
          {label}
          {required ? (
            <>
              <span className="text-gold" aria-hidden="true">
                •
              </span>
              <span className="sr-only">(required)</span>
            </>
          ) : null}
        </span>
        {children}
      </label>
      {error ? (
        <span role="alert" className="mt-1.5 block text-[0.6875rem] text-burgundy-bright">
          {error}
        </span>
      ) : null}
      {hint && !error ? <span className="mt-1.5 block text-[0.6875rem] leading-snug text-parchment-faint">{hint}</span> : null}
    </div>
  );
}

/*
 * 16px on a phone, 13px from `sm` up.
 *
 * iOS Safari zooms the whole page when a control smaller than 16px takes focus,
 * and the viewport meta deliberately does not set `maximum-scale` — suppressing
 * the zoom that way also suppresses a user's own pinch, which is a worse trade.
 * Every one of the nineteen text inputs and selects in the product measured
 * 13px/37.5px, so every form on every phone jumped on the first tap. The height
 * goes up with it: 44px is the touch floor, and a 37.5px control is under it.
 */
export const INPUT_CLASS =
  'w-full border border-obsidian-edge bg-vanta-deep px-3 py-2.5 font-mono text-base text-parchment placeholder:text-parchment-ghost min-h-[44px] sm:min-h-0 sm:py-2 sm:text-[0.8125rem]';

/**
 * `appearance: none` removes the native dropdown indicator, so `globals.css`
 * draws the chevron for every `select` — see the rule there. This class reserves
 * the gutter it sits in.
 */
export const SELECT_CLASS = `${INPUT_CLASS} appearance-none pr-8`;
