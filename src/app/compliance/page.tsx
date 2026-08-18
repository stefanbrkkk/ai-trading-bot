/**
 * Compliance — the disclosures, the terms, and the acceptance on record.
 *
 * Two sections here are unusual for a compliance page, and both exist because the
 * platform's regulatory position is a claim that should be checkable rather than
 * asserted.
 *
 * The **prohibited copy** list publishes the phrases the platform's own narrative
 * engine is forbidden from emitting, and the reason each is forbidden. That is an
 * odd thing to show a user until you consider the alternative: a reader has no way
 * to distinguish "this system is careful about advisory language" from "this system
 * says it is". Publishing the deny-list, and the fact that generated text is
 * filtered against it, makes the claim falsifiable.
 *
 * The **mandatory audit fields** list does the same for order provenance. It states
 * exactly what is recorded when an order is routed — including the click
 * coordinates — so a user knows what evidence exists about their own actions before
 * they take one, rather than discovering it in a subject-access request.
 */

'use client';

import { AsyncSlot, PageHeader, PageShell } from '@/components/PageState';
import { Badge, DataRow, Divider, Notice, Panel, PanelHeader, TableShell, Td, Th } from '@/components/ui/primitives';
import { useApi, type MeResponse } from '@/lib/ui/api';
import { duration, integer, nyDateTime } from '@/lib/ui/format';

interface DisclosureBundle {
  tosVersion: string;
  privacyVersion: string;
  riskDisclosuresVersion: string;
  blocks: { id: string; title: string; body: string }[];
  acceptanceLabel: string;
  tosClauses: { id: string; heading: string; body: string }[];
  liabilityCapMonths: number;
  prohibitedCopy: { phrase: string; reason: string }[];
  auditFields: { field: string; purpose: string }[];
  neutralFraming: string;
  privacyPolicy: { title: string; body: string }[];
}

interface ConsentRecord {
  currentVersions: { tos: string; privacy: string; riskDisclosures: string };
  accepted: boolean;
  acceptedAt: number | null;
  acceptedVersion: string | null;
  history: {
    id: string;
    acceptedAt: number;
    tosVersion: string;
    ipAddress: string;
    userAgent: string;
    clickX: number;
    clickY: number;
    scrollDurationMs: number;
  }[];
}

export default function CompliancePage() {
  const bundle = useApi<DisclosureBundle>('/compliance/disclosures');
  const me = useApi<MeResponse>('/auth/me');
  // 401 when anonymous, which is not an error condition for this page — the
  // disclosures are public and only the acceptance record needs a session.
  const consent = useApi<ConsentRecord>(me.data?.user ? '/compliance/consent' : null);

  return (
    <PageShell>
      <PageHeader
        eyebrow="Legal"
        title="Compliance"
        lede="The disclosures, the terms, what is recorded about your actions, and the language this platform forbids itself from using."
      />

      <AsyncSlot state={bundle} label="Loading the disclosures" lines={10}>
        {(data) => (
          <>
            <Panel className="mb-5">
              <PanelHeader
                eyebrow="Versions in force"
                title="What is current"
                action={
                  <div className="flex flex-wrap gap-2">
                    <Badge>Terms {data.tosVersion}</Badge>
                    <Badge>Risk {data.riskDisclosuresVersion}</Badge>
                    <Badge>Privacy {data.privacyVersion}</Badge>
                  </div>
                }
              />
              {consent.data !== null ? (
                <dl className="mt-4 space-y-0.5">
                  <DataRow
                    label="Acceptance on record"
                    value={consent.data.accepted ? 'yes' : 'no'}
                  />
                  <DataRow
                    label="Accepted at"
                    value={consent.data.acceptedAt === null ? '—' : nyDateTime(consent.data.acceptedAt)}
                  />
                  <DataRow label="Accepted version" value={consent.data.acceptedVersion ?? '—'} />
                  <DataRow label="Recorded acceptances" value={integer(consent.data.history.length)} />
                </dl>
              ) : (
                <p className="mt-3 text-[0.8125rem] text-parchment-faint">
                  Sign in to see your own acceptance record. The disclosures below are public.
                </p>
              )}
            </Panel>

            {/* ── Risk disclosures ─────────────────────────────────── */}
            <Panel className="mb-5">
              <PanelHeader eyebrow="Risk disclosures" title="Required, and rendered verbatim" />
              <div className="mt-4 space-y-5">
                {data.blocks.map((block) => (
                  <div key={block.id}>
                    <p className="font-mono text-2xs uppercase tracking-institutional text-gold/80">{block.title}</p>
                    <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-parchment-dim">{block.body}</p>
                  </div>
                ))}
              </div>
            </Panel>

            {/* ── Terms ────────────────────────────────────────────── */}
            <Panel className="mb-5">
              <PanelHeader
                eyebrow="Terms of service"
                title="The agreement"
                detail={`Liability is capped at the fees paid in the ${data.liabilityCapMonths} months preceding a claim.`}
              />
              <div className="mt-4 space-y-5">
                {data.tosClauses.map((clause) => (
                  <div key={clause.id}>
                    <p className="font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
                      {clause.heading}
                    </p>
                    <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-parchment-dim">{clause.body}</p>
                  </div>
                ))}
              </div>
              <Divider className="my-5" />
              <Notice tone="legal">{data.acceptanceLabel}</Notice>
            </Panel>

            {/* ── Prohibited copy ──────────────────────────────────── */}
            <Panel className="mb-5" padded={false}>
              <div className="p-5 pb-0">
                <PanelHeader
                  eyebrow="Prohibited language"
                  title="What this platform will not say"
                  detail="Published so the claim is checkable rather than asserted. Generated text is filtered against this list, and a sentence containing one of these phrases is removed with the removal reported in the response."
                />
              </div>
              <TableShell className="mt-4">
                <thead>
                  <tr>
                    <Th>Phrase</Th>
                    <Th>Why it is prohibited</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.prohibitedCopy.map((entry) => (
                    <tr key={entry.phrase}>
                      <Td>
                        <code className="font-mono text-2xs text-burgundy-bright">{entry.phrase}</code>
                      </Td>
                      <Td>
                        <span className="text-2xs leading-snug text-parchment-dim">{entry.reason}</span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
              <div className="border-t border-obsidian-edge p-5">
                <p className="eyebrow mb-2">Neutral framing template</p>
                <p className="text-[0.8125rem] leading-relaxed text-parchment-dim">{data.neutralFraming}</p>
              </div>
            </Panel>

            {/* ── Audit fields ─────────────────────────────────────── */}
            <Panel className="mb-5" padded={false}>
              <div className="p-5 pb-0">
                <PanelHeader
                  eyebrow="Order provenance"
                  title="What is recorded when you route an order"
                  detail="Listed before you route anything, rather than disclosed on request. Every field below is written to an append-only ledger that cannot be edited or deleted."
                />
              </div>
              <TableShell className="mt-4">
                <thead>
                  <tr>
                    <Th>Field</Th>
                    <Th>Why it is recorded</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.auditFields.map((field) => (
                    <tr key={field.field}>
                      <Td>
                        <code className="font-mono text-2xs text-parchment">{field.field}</code>
                      </Td>
                      <Td>
                        <span className="text-2xs leading-snug text-parchment-dim">{field.purpose}</span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            </Panel>

            {/* ── Privacy ──────────────────────────────────────────── */}
            <Panel className="mb-5">
              <PanelHeader eyebrow="Privacy" title="What is collected, and what is not" />
              <div className="mt-4 space-y-5">
                {data.privacyPolicy.map((section) => (
                  <div key={section.title}>
                    <p className="font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
                      {section.title}
                    </p>
                    <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-parchment-dim">{section.body}</p>
                  </div>
                ))}
              </div>
            </Panel>

            {/* ── Acceptance history ───────────────────────────────── */}
            {consent.data !== null && consent.data.history.length > 0 ? (
              <Panel padded={false}>
                <div className="p-5 pb-0">
                  <PanelHeader
                    eyebrow="Your acceptance history"
                    title={`${integer(consent.data.history.length)} recorded`}
                    detail="Append-only. Re-accepting adds an entry rather than replacing one, so the record shows what you agreed to and when."
                  />
                </div>
                <TableShell className="mt-4">
                  <thead>
                    <tr>
                      <Th>Accepted at</Th>
                      <Th>Version</Th>
                      <Th align="right">Read time</Th>
                      <Th align="right">Click</Th>
                      <Th>IP</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {consent.data.history.map((entry) => (
                      <tr key={entry.id}>
                        <Td>
                          <span className="font-mono text-2xs text-parchment-dim">{nyDateTime(entry.acceptedAt)}</span>
                        </Td>
                        <Td>
                          <span className="font-mono text-2xs text-parchment-faint">{entry.tosVersion}</span>
                        </Td>
                        <Td align="right" numeric>
                          {duration(entry.scrollDurationMs)}
                        </Td>
                        <Td align="right" numeric>
                          {entry.clickX}, {entry.clickY}
                        </Td>
                        <Td>
                          <span className="font-mono text-2xs text-parchment-ghost">{entry.ipAddress}</span>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </TableShell>
              </Panel>
            ) : null}
          </>
        )}
      </AsyncSlot>
    </PageShell>
  );
}
