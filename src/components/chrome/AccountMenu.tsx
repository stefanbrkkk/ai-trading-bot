'use client';

/**
 * Who is signed in, and the way out.
 *
 * There was no way out. `signOut()` existed, `POST /api/auth/signout` existed and
 * worked, and nothing in the product referenced either — a grep for sign-out
 * across every `.tsx` returned zero hits, and an enumeration of every button and
 * anchor on every route while signed in found no control matching it. A session
 * cookie lasting fourteen days with no way to end it is not an inconvenience on a
 * platform that routes orders; it is the thing you reach for when you have just
 * used someone else's laptop.
 *
 * The control also answers a question the chrome could not: *who am I*. Every
 * page's behaviour depends on the session — the blotter, the order ticket, the
 * admin console — and the header showed the market clock and the data provider
 * while saying nothing about the account those pages were answering to.
 *
 * The popover is a plain disclosure, not an ARIA menu. It carried `role="menu"`
 * with three `role="menuitem"` children, and none of the keyboard model that
 * role promises: no arrow-key roving focus, no `tabindex` management, only
 * click-away and Escape. Announcing "menu" to a screen-reader user is a
 * commitment that arrow keys will move between the items, and they did not. The
 * markup was also malformed against the spec — `menu` owns `group`,
 * `menuitem`, `menuitemcheckbox` and `menuitemradio`, and this one had two
 * paragraphs as direct children with the items nested a level below inside a
 * layout `div`. Two links and a button reach the same three destinations by Tab,
 * natively, with no promise to break.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { buttonClass, cx } from '@/components/ui/primitives';
import { request, useApi, type MeResponse } from '@/lib/ui/api';

/**
 * Whether a navigation has landed somewhere the session has not been read yet.
 *
 * A named export rather than an inline `!==` because vitest runs this project in
 * a `node` environment with no DOM: the effect below cannot be mounted in a
 * test, but the rule it enforces can be, and that rule is the whole of the fix.
 * Fire on a change of route, and *only* on a change — the route the header
 * mounted on has already been fetched, and re-fetching it would double the
 * request on every cold load for nothing.
 */
export function sessionNeedsReread(readOn: string | null, pathname: string | null): boolean {
  return pathname !== null && readOn !== pathname;
}

export function AccountMenu() {
  // Polled on the same cadence as the rest of the chrome so signing in or out in
  // *another* tab is reflected here without a navigation in this one. The poll is
  // not what covers a sign-in in *this* tab — the route-change re-read below is.
  const me = useApi<MeResponse>('/auth/me', { pollMs: 60_000 });
  const { reload } = me;
  const pathname = usePathname();
  const readOn = useRef<string | null>(pathname);

  /*
   * The session is re-read on every navigation, not only on the poll.
   *
   * This control is mounted by the one root layout, which has no sibling and no
   * conditional, so it survives every client-side navigation in the product —
   * including the ones that change who the session belongs to. `AuthForm`
   * follows a successful sign-in with `router.push` and then `router.refresh()`,
   * and a refresh refetches the server payload without unmounting a client
   * component: `useApi` fires from an effect keyed on its path, the path here is
   * the constant '/auth/me', and nothing else was calling `reload()`. So the
   * header went on rendering the answer it got while the visitor was still
   * anonymous.
   *
   * Measured against a running build: sign up, accept the clickwrap, land on
   * /terminal at t+1.0s, and the header still read "Sign in" at t+56s while
   * `/api/auth/me` fetched from that same page returned the full user. It
   * flipped at t+61s. For that whole window the only account control in the
   * chrome told a client who had just read a clickwrap end to end that they were
   * signed out, and offered them /login — with Sign out unreachable throughout,
   * because it lives inside a popover only the signed-in control opens.
   *
   * The poll cannot close that window, because its period runs from the mount
   * rather than from the sign-in: the stale interval is 0–60s, and it sits near
   * the full minute on the ordinary returning-user path, where the browser
   * autofills and the form is submitted within seconds of the layout mounting.
   * `pathname` is the one signal available inside the header that moves at the
   * instant a sign-in or a terms acceptance completes, because both of them
   * navigate. Signing out needs nothing here — it leaves by
   * `window.location.assign`, which remounts the whole shell — and `reload()`
   * keeps the last payload on screen while the next one is in flight, so a
   * navigation never drops the control back to its placeholder.
   */
  useEffect(() => {
    if (!sessionNeedsReread(readOn.current, pathname)) return;
    readOn.current = pathname;
    reload();
  }, [pathname, reload]);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  // Click-away and Escape. Without both, a popover on a sticky header is a trap
  // on touch, where there is no other way to dismiss it.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (hostRef.current?.contains(event.target as Node) === true) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const user = me.data?.user ?? null;

  if (me.loading && me.data === null) {
    /*
     * A placeholder the size of the control it stands in for.
     *
     * This used to be a bare one-character span, so the settled state appeared
     * out of a 7px box: a 24px-tall bordered control roughly 105px wide, which
     * grew the header row from 40px to 45px and pushed every page's content down
     * five pixels. That single swap was the largest contributor to a CLS the
     * header was running on all sixteen routes: the root layout renders this
     * control on every one of them, so there is no route the shift did not land
     * on. This count used to be three short, leaving out /login, /signup and
     * /onboarding, which is where a new client meets this placeholder first.
     *
     * All three states share the same 6.5rem floor and 10rem ceiling — this
     * placeholder, the signed-out link and the signed-in trigger — because
     * reserving the box of one of them shifts the other two. Measured with the
     * session request held open, reserving nothing here left 66.4px of the
     * cluster's travel in place after the rest of the header had been pinned;
     * the "Sign in" ghost button is 73.8px unreserved and 104px with the floor,
     * which is where the signed-in control already sits. A display name long
     * enough to pass 6.5rem still grows the control, up to the 10rem it has
     * always truncated at.
     */
    return (
      <span
        aria-hidden
        className={cx(
          'flex min-w-[6.5rem] max-w-[10rem] items-center border border-transparent px-2 py-1',
          'font-mono text-2xs uppercase tracking-institutional text-parchment-ghost',
        )}
      >
        …
      </span>
    );
  }

  if (user === null) {
    return (
      <Link href="/login" className={buttonClass('ghost', 'sm', 'tap-target min-w-[6.5rem] max-w-[10rem]')}>
        Sign in
      </Link>
    );
  }

  const label = user.displayName?.trim() || user.email;

  async function signOut(): Promise<void> {
    setBusy(true);
    try {
      await request('/auth/signout', { method: 'POST' });
    } catch {
      // A failed revocation still clears the cookie server-side in every case the
      // endpoint can reach; a hard navigation re-reads the session either way.
    }
    // A full load rather than a router push: every page holds session-derived
    // state in a client store, and a soft navigation would leave the previous
    // account's positions on screen under an anonymous session.
    window.location.assign('/login');
  }

  return (
    <div ref={hostRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className={cx(
          'tap-target flex min-w-[6.5rem] max-w-[10rem] items-center gap-1.5 border border-obsidian-edge px-2 py-1',
          'font-mono text-2xs uppercase tracking-institutional text-parchment-dim',
          'transition-colors hover:border-parchment-ghost hover:text-parchment',
        )}
      >
        <span className="truncate">{label}</span>
        <span aria-hidden className="text-parchment-ghost">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open ? (
        <div className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-60 border border-obsidian-edge bg-vanta-deep p-3 shadow-plinth">
          <p className="truncate text-[0.8125rem] text-parchment" title={user.email}>
            {user.email}
          </p>
          <p className="mt-0.5 font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
            {user.role}
          </p>
          <div className="mt-3 flex flex-col gap-1.5">
            <Link
              href="/portfolio"
              onClick={close}
              className="border border-transparent px-2 py-1.5 text-[0.8125rem] text-parchment-dim transition-colors hover:border-obsidian-edge hover:text-parchment"
            >
              Portfolio
            </Link>
            <Link
              href="/compliance"
              onClick={close}
              className="border border-transparent px-2 py-1.5 text-[0.8125rem] text-parchment-dim transition-colors hover:border-obsidian-edge hover:text-parchment"
            >
              Terms and disclosures
            </Link>
            <button
              type="button"
              id="sign-out"
              disabled={busy}
              onClick={() => void signOut()}
              className={buttonClass('danger', 'sm', 'mt-1 w-full justify-center')}
            >
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
