/**
 * The clickwrap gate.
 *
 * A clickwrap is only enforceable if the user was given a genuine opportunity to
 * read what they agreed to, so this page instruments that opportunity rather than
 * asserting it. Three signals are captured and sent with the acceptance:
 *
 *   • **scrolledToBottom** — the disclosure pane's own scroll position reached its
 *     end. Measured on the scrolling element, not inferred from a click, because
 *     the claim being recorded is "the text was scrolled through".
 *   • **scrollDurationMs** — how long elapsed between first paint of the pane and
 *     the acceptance. A sub-second acceptance is evidence *against* meaningful
 *     assent, and recording it honestly is more useful than blocking on it.
 *   • **click provenance** — the coordinates, viewport and `isTrusted` flag of the
 *     physical click on the accept control.
 *
 * The server re-checks all of it. That matters more than the client-side gate: the
 * checkbox and the disabled button are courtesy, and a request that fabricates
 * `scrolledToBottom` is rejected by the endpoint rather than trusted. The client
 * gate exists so an honest user is not confused; the server gate exists so a
 * dishonest one is not admitted.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AsyncSlot, PageHeader, PageShell } from '@/components/PageState';
import { Badge, Button, Divider, Notice, Panel, PanelHeader } from '@/components/ui/primitives';
import { ApiRequestError, clickProvenance, request, useApi, type MeResponse } from '@/lib/ui/api';
interface DisclosureBlock {
  id: string;
  title: string;
  body: string;
}

interface TosClause {
  id: string;
  heading: string;
  body: string;
}

interface DisclosureBundle {
  tosVersion: string;
  privacyVersion: string;
  riskDisclosuresVersion: string;
  blocks: DisclosureBlock[];
  acceptanceLabel: string;
  tosClauses: TosClause[];
  liabilityCapMonths: number;
  privacyPolicy: { title: string; body: string }[];
}

/** Below this, an acceptance is recorded but flagged as implausibly fast. */
const IMPLAUSIBLE_READ_MS = 4000;

export default function OnboardingPage() {
  const router = useRouter();
  const bundle = useApi<DisclosureBundle>('/compliance/disclosures');
  const me = useApi<MeResponse>('/auth/me');

  const paneRef = useRef<HTMLDivElement | null>(null);
  const openedAt = useRef<number>(Date.now());

  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  /**
   * Detects the end of the scroll.
   *
   * The 4px slack absorbs sub-pixel layout rounding — without it, a pane whose
   * content height is a fraction of a pixel taller than its scroll extent can
   * never satisfy the condition, and the user is locked out of a control they did
   * everything to earn.
   */
  const handleScroll = useCallback(() => {
    const pane = paneRef.current;
    if (pane === null) return;
    if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 4) setScrolledToBottom(true);
  }, []);

  /**
   * A pane shorter than its container has nothing to scroll.
   *
   * On a tall viewport the whole disclosure set can be visible at once, in which
   * case no scroll event ever fires and the gate would never open. The text has
   * been seen, so the condition is satisfied — checked after paint, and re-checked
   * when the content arrives.
   */
  useEffect(() => {
    const pane = paneRef.current;
    if (pane === null) return;
    if (pane.scrollHeight <= pane.clientHeight + 4) setScrolledToBottom(true);
  }, [bundle.data]);

  async function accept(event: React.MouseEvent<HTMLButtonElement>): Promise<void> {
    const data = bundle.data;
    if (data === null || pending) return;
    setPending(true);
    setError(null);

    try {
      await request('/compliance/consent', {
        method: 'POST',
        body: {
          tosVersion: data.tosVersion,
          privacyVersion: data.privacyVersion,
          riskDisclosuresVersion: data.riskDisclosuresVersion,
          scrolledToBottom,
          checkboxChecked: checked,
          scrollDurationMs: Math.max(0, Date.now() - openedAt.current),
          click: clickProvenance(event.nativeEvent, 'accept-terms'),
        },
      });
      router.push('/terminal');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : 'The acceptance could not be recorded.');
      setPending(false);
    }
  }

  const elapsed = Date.now() - openedAt.current;
  const alreadyAccepted = me.data?.user?.tosAcceptedAt !== null && me.data?.user?.tosAcceptedAt !== undefined;

  return (
    <PageShell>
      <PageHeader
        eyebrow="Required before any order"
        title="Terms, risk disclosures and privacy"
        lede="Read the whole document. Scrolling the pane to its end unlocks the checkbox below, and ticking it unlocks the accept control; the acceptance is recorded with the timestamps and click coordinates of your agreement."
      />

      {me.data?.user === null || me.data?.user === undefined ? (
        <Notice tone="warning" className="mb-6" title="Not signed in">
          An acceptance is recorded against an account. Sign in or create one first — the disclosures below are readable
          either way.
        </Notice>
      ) : null}

      {alreadyAccepted ? (
        <Notice tone="info" className="mb-6" title="Already accepted">
          This account has an acceptance on record. Re-accepting is harmless and appends a new entry to the audit trail
          rather than replacing the old one.
        </Notice>
      ) : null}

      <AsyncSlot state={bundle} label="Loading the disclosures" lines={10}>
        {(data) => (
          <>
            <Panel padded={false}>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-obsidian-edge p-5">
                <PanelHeader eyebrow="Version" title="The document you are accepting" className="mb-0" />
                <div className="flex flex-wrap gap-2">
                  <Badge>Terms {data.tosVersion}</Badge>
                  <Badge>Risk {data.riskDisclosuresVersion}</Badge>
                  <Badge>Privacy {data.privacyVersion}</Badge>
                </div>
              </div>

              {/*
                The scroll container is the instrumented element. `tabIndex` makes it
                keyboard-scrollable, which is not decoration: a keyboard user who
                cannot scroll the pane cannot reach the end of it, and would be
                permanently locked out of the accept control.
              */}
              <div
                ref={paneRef}
                onScroll={handleScroll}
                tabIndex={0}
                role="region"
                aria-label="Terms, risk disclosures and privacy policy"
                className="max-h-[52vh] overflow-y-auto px-5 py-5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold"
              >
                <h2 className="display text-base text-parchment">Risk disclosures</h2>
                <div className="mt-3 space-y-4">
                  {data.blocks.map((block) => (
                    <div key={block.id}>
                      <p className="font-mono text-2xs uppercase tracking-institutional text-gold/80">{block.title}</p>
                      <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-parchment-dim">{block.body}</p>
                    </div>
                  ))}
                </div>

                <Divider className="my-6" />

                <h2 className="display text-base text-parchment">Terms of service</h2>
                <div className="mt-3 space-y-4">
                  {data.tosClauses.map((clause) => (
                    <div key={clause.id}>
                      <p className="font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
                        {clause.heading}
                      </p>
                      <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-parchment-dim">{clause.body}</p>
                    </div>
                  ))}
                </div>

                <Divider className="my-6" />

                <h2 className="display text-base text-parchment">Privacy policy</h2>
                <div className="mt-3 space-y-4">
                  {data.privacyPolicy.map((section) => (
                    <div key={section.title}>
                      <p className="font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
                        {section.title}
                      </p>
                      <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-parchment-dim">{section.body}</p>
                    </div>
                  ))}
                </div>

                <p className="mt-8 border-t border-obsidian-edge pt-4 font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
                  End of document
                </p>
              </div>

              <div className="border-t border-obsidian-edge p-5">
                {!scrolledToBottom ? (
                  <Notice tone="info" className="mb-4">
                    Scroll the pane above to its end to unlock the accept control.
                  </Notice>
                ) : null}

                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!scrolledToBottom}
                    onChange={(e) => setChecked(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[#D4AF37] disabled:opacity-40"
                  />
                  {/* The mandated acceptance sentence, rendered verbatim. */}
                  <span className="text-[0.8125rem] font-semibold uppercase leading-relaxed tracking-wide text-parchment">
                    {data.acceptanceLabel}
                  </span>
                </label>

                {error !== null ? (
                  <Notice tone="error" className="mt-4">
                    {error}
                  </Notice>
                ) : null}

                {checked && elapsed < IMPLAUSIBLE_READ_MS ? (
                  <Notice tone="warning" className="mt-4">
                    This page has been open for under four seconds. Your acceptance will be recorded with that duration.
                  </Notice>
                ) : null}

                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <Button
                    variant="primary"
                    size="lg"
                    id="accept-terms"
                    disabled={!scrolledToBottom || !checked}
                    busy={pending}
                    onClick={accept}
                  >
                    {pending ? 'Recording…' : 'Accept and continue'}
                  </Button>
                  <p className="text-[0.75rem] text-parchment-faint">
                    Liability is capped at the fees you paid in the {data.liabilityCapMonths} months before a claim.
                  </p>
                </div>
              </div>
            </Panel>

            <Notice tone="legal" className="mt-6">
              Accepting these terms does not enable live order routing. Live routing additionally requires an active
              subscription and an explicit unlock on your account.
            </Notice>
          </>
        )}
      </AsyncSlot>
    </PageShell>
  );
}
