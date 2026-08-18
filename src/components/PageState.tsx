/**
 * The three states every data page has.
 *
 * Loading, failed and empty are rendered here once rather than in fifteen pages,
 * and the failure case is the reason this component exists in its own file: a
 * request that fails must show the server's *own* message. Several of those
 * messages are mandated copy — a risk rejection, a subscription gate, an
 * unseeded engine — and a page that substituted a friendly "something went
 * wrong" would replace a compliance-relevant string with marketing.
 *
 * The distinction between "not ready" and "broken" is also made here. An
 * unseeded engine and a missing model are operational states with a known
 * remedy, so they carry the remedy; anything else is reported as-is without
 * being dressed up.
 */

'use client';

import type { ReactNode } from 'react';
import { Button, EmptyState, Notice, Panel, Skeleton } from '@/components/ui/primitives';
import type { ApiRequestError } from '@/lib/ui/api';

/**
 * Codes whose remedy is a command rather than a retry.
 *
 * Every entry is emitted by a route. `MODEL_MISSING` and `STORE_NOT_READY` used
 * to sit here as well, and nothing has ever raised either — a copy of this map
 * that is wider than the set of real codes reads as coverage while providing
 * none, and hides the fact that a genuinely unhandled code falls through to the
 * raw message.
 */
const OPERATIONAL_CODES: Record<string, string> = {
  // src/app/api/{signals,chart,screener,attribution}/… via `pendingSetup`
  ENGINE_NOT_READY: 'The ensemble has not been trained in this deployment. Run npm run seed, then check again.',
  // src/app/api/model-card/route.ts
  MODEL_NOT_TRAINED: 'No trained ensemble is present in this deployment. Run npm run seed, then check again.',
  // src/app/api/backtest/run/route.ts
  NO_BACKTEST_FIXTURE: 'No seeded backtest is present. Run npm run seed, then check again.',
  ENGINE_NOT_SEEDED: 'Feature history has not been seeded in this deployment. Run npm run seed, then check again.',
};

export function LoadingPanel({ label, lines = 4 }: { label?: string; lines?: number }) {
  return (
    <Panel>
      {label ? (
        <p className="mb-3 font-mono text-2xs uppercase tracking-institutional text-parchment-faint">{label}</p>
      ) : null}
      <Skeleton lines={lines} />
      <span className="sr-only" role="status">
        Loading
      </span>
    </Panel>
  );
}

export function ErrorPanel({
  error,
  onRetry,
  context,
}: {
  error: ApiRequestError;
  onRetry?: () => void;
  context?: string;
}) {
  const operational = OPERATIONAL_CODES[error.code];
  return (
    <Panel>
      <Notice tone={operational ? 'warning' : 'error'} title={operational ? 'Not ready' : `Error · ${error.code}`}>
        {/*
          One sentence for a state we recognise, the server's own for anything
          else. Printing both put the same instruction on screen twice, under a
          page banner that had already said it once — four times in total on the
          first screen a fresh deployment shows.
        */}
        <p>{operational ?? error.message}</p>
        {context ? <p className="mt-2 text-parchment-faint">{context}</p> : null}
      </Notice>
      {onRetry ? (
        <div className="mt-4">
          {/* "Try again" is wrong for a setup state — nothing changes until the
              operator runs the command — but re-fetching is exactly what they
              want once they have. */}
          <Button variant="ghost" onClick={onRetry}>
            {operational ? 'Check again' : 'Try again'}
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

/**
 * Renders the right thing for an async slot.
 *
 * `empty` is checked *after* loading and error so a page cannot show "no results"
 * while a request is still in flight — which reads as an answer rather than as a
 * pending state, and is the single most common way a data UI lies to its user.
 */
export function AsyncSlot<T>({
  state,
  children,
  label,
  lines,
  isEmpty,
  emptyTitle,
  emptyDetail,
}: {
  state: { data: T | null; error: ApiRequestError | null; loading: boolean; reload: () => void };
  children: (data: T) => ReactNode;
  label?: string;
  lines?: number;
  isEmpty?: (data: T) => boolean;
  emptyTitle?: string;
  emptyDetail?: ReactNode;
}) {
  if (state.loading && state.data === null) return <LoadingPanel label={label} lines={lines} />;
  if (state.error !== null && state.data === null) {
    return (
      <>
        <Announce>{`${label ?? 'Content'} failed to load: ${state.error.message}`}</Announce>
        <ErrorPanel error={state.error} onRetry={state.reload} />
      </>
    );
  }
  if (state.data === null) return <LoadingPanel label={label} lines={lines} />;
  if (isEmpty?.(state.data) === true) {
    return (
      <>
        <Announce>{`${label ?? 'Content'}: nothing to show.`}</Announce>
        <Panel>
          <EmptyState title={emptyTitle ?? 'Nothing to show'} detail={emptyDetail} />
        </Panel>
      </>
    );
  }
  /*
   * Loaded data with a failed refresh is shown, and labelled as stale.
   *
   * The error branch above only fires when there is nothing to show. Once data
   * has arrived, a later failure — a poll, a manual `reload()` — leaves
   * `state.error` set and `state.data` populated, and this used to fall straight
   * through to `children`, rendering the last good payload as though it were
   * current with no indication anything had gone wrong. `lib/ui/api` is explicit
   * about why that is the dangerous case: "a stale conviction score rendered as
   * current is a materially misleading number."
   *
   * Blanking the panel would be worse — the figures were true when they arrived,
   * and a reader mid-analysis should not lose them to one dropped request. So
   * the data stays and the notice says what it is.
   */
  return (
    <>
      <Announce>
        {state.error === null
          ? `${label ?? 'Content'} loaded.`
          : `${label ?? 'Content'} could not be refreshed. Showing the last values received.`}
      </Announce>
      {state.error === null ? null : (
        <Notice tone="warning" className="mb-5">
          These figures could not be refreshed ({state.error.message}) and are the last values received. Nothing
          below reflects anything more recent.{' '}
          <button type="button" onClick={state.reload} className="underline underline-offset-2 hover:text-parchment">
            Try again
          </button>
          .
        </Notice>
      )}
      {children(state.data)}
    </>
  );
}

/**
 * A polite live region.
 *
 * Every async surface in the product replaced a skeleton with a result silently:
 * a screen-reader user who ran the pre-trade checks, asked InvestGPT a question
 * or loaded a symbol got no announcement that anything had happened, because
 * there was no live region anywhere in the app. `AsyncSlot` wraps almost all of
 * them, so announcing here covers the product in one place.
 *
 * `polite` rather than `assertive`: these are results the user asked for, not
 * interruptions.
 */
export function Announce({ children }: { children: ReactNode }) {
  return (
    <span className="sr-only" role="status" aria-live="polite">
      {children}
    </span>
  );
}

/** A page-level heading block. */
export function PageHeader({
  eyebrow,
  title,
  lede,
  action,
}: {
  eyebrow: string;
  title: string;
  lede?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="font-mono text-2xs uppercase tracking-institutional text-gold/80">{eyebrow}</p>
        <h1 className="display mt-1.5 text-2xl text-parchment sm:text-[1.75rem]">{title}</h1>
        {lede ? <p className="mt-2.5 max-w-2xl text-sm leading-relaxed text-parchment-dim">{lede}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

/** Standard page frame: consistent gutters and max width across every route. */
export function PageShell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={`mx-auto w-full px-5 py-8 sm:px-8 ${wide ? 'max-w-[1680px]' : 'max-w-[1320px]'}`}>{children}</div>
  );
}
