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

/** Codes whose remedy is a command rather than a retry. */
const OPERATIONAL_CODES: Record<string, string> = {
  ENGINE_NOT_READY: 'The ensemble has not been trained in this deployment. Run `npm run seed` and reload.',
  MODEL_MISSING: 'No trained model file was found. Run `npm run seed` and reload.',
  STORE_NOT_READY: 'The feature store is empty. Run `npm run seed` and reload.',
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
        {/* The server's message, verbatim. */}
        <p>{error.message}</p>
        {operational ? <p className="mt-2 text-parchment-dim">{operational}</p> : null}
        {context ? <p className="mt-2 text-parchment-faint">{context}</p> : null}
      </Notice>
      {onRetry ? (
        <div className="mt-4">
          <Button variant="ghost" onClick={onRetry}>
            Try again
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
  if (state.error !== null && state.data === null) return <ErrorPanel error={state.error} onRetry={state.reload} />;
  if (state.data === null) return <LoadingPanel label={label} lines={lines} />;
  if (isEmpty?.(state.data) === true) {
    return (
      <Panel>
        <EmptyState title={emptyTitle ?? 'Nothing to show'} detail={emptyDetail} />
      </Panel>
    );
  }
  return <>{children(state.data)}</>;
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
