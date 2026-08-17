/**
 * Admin — the kill switch and the forensic telemetry feed.
 *
 * The kill switch is a two-step control with a mandatory typed reason, and both
 * halves are deliberate. The reason is required because the switch is the most
 * consequential action on the platform — it halts routing for every user — and an
 * incident review that finds "engaged at 14:32" with no explanation has lost the
 * only context that mattered. The confirmation step exists because the control has
 * no undo that restores the orders it cancelled.
 *
 * The telemetry feed is admin-only for a substantive reason rather than a
 * conventional one: it contains click coordinates, IP addresses, user agents and raw
 * broker payloads for *every* user. Exactly the evidence a regulator would ask for,
 * and exactly the data no user should be able to read about another.
 *
 * The console reports who is reading it. An audit surface that is not itself
 * auditable is a gap.
 */

'use client';

import { useState } from 'react';
import { AsyncSlot, ErrorPanel, PageHeader, PageShell } from '@/components/PageState';
import { LatencyBar } from '@/components/charts';
import {
  Badge,
  Button,
  DataRow,
  Divider,
  Field,
  INPUT_CLASS,
  Notice,
  Panel,
  PanelHeader,
  StatGrid,
  StatTile,
  TableShell,
  Td,
  Th,
} from '@/components/ui/primitives';
import { ApiRequestError, clickProvenance, request, useApi, type MeResponse } from '@/lib/ui/api';
import { duration, integer, money, nyDateTime } from '@/lib/ui/format';

interface KillSwitchState {
  engaged: boolean;
  reason: string | null;
  engagedAt: number | null;
  engagedBy: string | null;
  history: {
    id: string;
    engaged: boolean;
    reason: string | null;
    actorId: string | null;
    /*
     * `recordedAt`, which is what the ledger and the API call it. This declared
     * `occurredAt`, so `nyDateTime(undefined)` returned an em-dash and every row
     * of the change history showed a state and a reason with no time against it.
     */
    recordedAt: number;
  }[];
  cancelAttempts?: { orderId: string; brokerOrderId: string | null; status: number | null; ok: boolean }[];
}

interface AuditEvent {
  id: string;
  occurredAt: number;
  eventType: string;
  userId: string | null;
  ipAddress: string;
  userAgent: string;
  clickX: number | null;
  clickY: number | null;
  resource: string | null;
  orderId: string | null;
  brokerStatus: number | null;
  spiffeId: string;
  correlationId: string | null;
}

interface TelemetryRecord {
  orderId: string;
  timestamps: {
    clientClick: number;
    serverReceived: number;
    riskCompleted: number;
    brokerDispatched: number;
    brokerAcknowledged: number | null;
  };
  spiffeId: string;
  ipAddress: string;
  userAgent: string;
  click: { clickX: number; clickY: number; viewportWidth: number; viewportHeight: number; targetId: string };
  brokerStatus: number | null;
  intervals: {
    clickToServerMs: number;
    riskMs: number;
    dispatchMs: number;
    brokerAckMs: number | null;
    totalMs: number | null;
  };
}

interface TelemetryResponse {
  events: AuditEvent[];
  eventTotal: number;
  telemetry: TelemetryRecord[];
  riskDecisions: { id: string; symbol: string; decision: { approved: boolean; rejection?: { code: string } | null } }[];
  rejectionsLastDay: { code: string; count: number }[];
  ledger: { snapshots: number; deltas: number };
  readBy: { userId: string; email: string };
}

interface EntitlementUser {
  id: string;
  email: string;
  displayName: string;
  role: 'trader' | 'admin';
  createdAt: number;
  subscriptionStatus: 'trialing' | 'active' | 'past_due' | 'canceled' | 'none';
  currentPeriodEnd: number | null;
  liveTradingUnlocked: boolean;
  liabilityCapUsd: number;
}

interface EntitlementResponse {
  priceUsdPerMonth: number;
  users: EntitlementUser[];
}

export default function AdminPage() {
  const me = useApi<MeResponse>('/auth/me');
  const isAdmin = me.data?.user?.role === 'admin';

  const kill = useApi<KillSwitchState>(isAdmin ? '/admin/kill-switch' : null, { pollMs: 20_000 });
  const telemetry = useApi<TelemetryResponse>(isAdmin ? '/audit/telemetry?limit=100' : null, { pollMs: 30_000 });
  const entitlements = useApi<EntitlementResponse>(isAdmin ? '/admin/entitlement' : null);

  const [entitlementBusy, setEntitlementBusy] = useState<string | null>(null);
  const [entitlementError, setEntitlementError] = useState<string | null>(null);

  async function entitle(
    email: string,
    action: 'activate_subscription' | 'cancel_subscription' | 'set_live_unlock' | 'set_role',
    extra: { unlocked?: boolean; role?: 'trader' | 'admin'; months?: number } = {},
  ): Promise<void> {
    setEntitlementBusy(`${email}:${action}`);
    setEntitlementError(null);
    try {
      await request('/admin/entitlement', { method: 'POST', body: { email, action, ...extra } });
      entitlements.reload();
    } catch (error) {
      setEntitlementError(error instanceof ApiRequestError ? error.message : 'The change could not be applied.');
    } finally {
      setEntitlementBusy(null);
    }
  }

  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<KillSwitchState | null>(null);

  async function toggle(event: React.MouseEvent<HTMLButtonElement>): Promise<void> {
    if (kill.data === null || busy) return;
    const engaging = !kill.data.engaged;
    if (engaging && reason.trim().length < 8) return;

    setBusy(true);
    setActionError(null);
    try {
      setLastResult(
        await request<KillSwitchState>('/admin/kill-switch', {
          method: 'POST',
          body: {
            active: engaging,
            reason: reason.trim(),
            click: clickProvenance(event.nativeEvent, 'kill-switch-toggle'),
          },
        }),
      );
      setReason('');
      setConfirming(false);
      kill.reload();
    } catch (cause) {
      setActionError(cause instanceof ApiRequestError ? cause.message : 'The kill switch could not be changed.');
    } finally {
      setBusy(false);
    }
  }

  if (me.loading) {
    return (
      <PageShell>
        <PageHeader eyebrow="Operations" title="Admin" />
        <Panel>
          <p className="text-[0.8125rem] text-parchment-faint" role="status">
            Checking your role…
          </p>
        </Panel>
      </PageShell>
    );
  }

  if (!isAdmin) {
    return (
      <PageShell>
        <PageHeader
          eyebrow="Operations"
          title="Admin"
          lede="The kill switch and the forensic telemetry feed. Restricted to administrators."
        />
        <Notice tone="warning" title="Not authorised">
          This console exposes click coordinates, IP addresses and raw broker payloads for every user on the platform.
          It is restricted to accounts with the administrator role, and the restriction is enforced server-side on every
          request rather than by hiding this page.
        </Notice>
      </PageShell>
    );
  }

  const engaged = kill.data?.engaged === true;
  /** Time of the most recent change, in whichever direction it went. */
  const lastChangeAt = kill.data?.history?.[0]?.recordedAt ?? kill.data?.engagedAt ?? null;

  return (
    <PageShell wide>
      <PageHeader
        eyebrow="Operations"
        title="Admin"
        lede="Platform-wide routing control and the complete forensic record. Every action taken here is itself recorded."
        action={
          telemetry.data ? (
            <div className="text-right font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
              <p>read by</p>
              <p className="mt-1 text-parchment-dim">{telemetry.data.readBy.email}</p>
            </div>
          ) : null
        }
      />

      {/* ── Kill switch ──────────────────────────────────────────────── */}
      <Panel className="mb-5">
        <PanelHeader
          eyebrow="Kill switch"
          title={engaged ? 'Order routing is halted' : 'Order routing is enabled'}
          detail={
            engaged
              ? 'While engaged, every incoming order request is answered with HTTP 503. Analysis continues to publish.'
              : 'Engaging this halts routing for every user on the platform and attempts to cancel every working order.'
          }
          action={<Badge tone={engaged ? 'burgundy' : 'sage'}>{engaged ? 'engaged' : 'released'}</Badge>}
        />

        {kill.data !== null ? (
          <dl className="mt-4 space-y-0.5">
            <DataRow label="State" value={engaged ? 'engaged' : 'released'} />
            <DataRow label="Reason" value={kill.data.reason ?? '—'} />
            {/*
              `engagedAt` is null whenever the switch is released, so this row read
              "—" in exactly the state the platform spends most of its time in —
              next to a reason and an actor that were both populated. The latest
              history entry carries the time of the change that produced the
              current state, whichever direction it went.
            */}
            <DataRow
              label="Changed at"
              value={lastChangeAt === null ? '—' : nyDateTime(lastChangeAt)}
            />
            <DataRow label="Changed by" value={kill.data.engagedBy ?? '—'} />
          </dl>
        ) : null}

        <Divider className="my-5" />

        <Field
          label={engaged ? 'Reason for releasing' : 'Reason for engaging'}
          required={!engaged}
          hint="Recorded verbatim in the append-only ledger. An incident review with a timestamp and no reason has lost the only context that mattered."
        >
          <input
            className={INPUT_CLASS}
            type="text"
            value={reason}
            maxLength={280}
            onChange={(e) => setReason(e.target.value)}
            placeholder={engaged ? 'Venue connectivity restored, spreads normal' : 'Broker returning 5xx on every submission'}
          />
        </Field>

        {actionError !== null ? (
          <Notice tone="error" className="mt-4">
            {actionError}
          </Notice>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {!confirming ? (
            <Button
              variant={engaged ? 'default' : 'danger'}
              size="lg"
              disabled={!engaged && reason.trim().length < 8}
              busy={busy}
              onClick={() => setConfirming(true)}
            >
              {engaged ? 'Release the kill switch' : 'Engage the kill switch'}
            </Button>
          ) : (
            <>
              <Button
                id="kill-switch-toggle"
                variant={engaged ? 'default' : 'danger'}
                size="lg"
                busy={busy}
                onClick={toggle}
              >
                {busy ? 'Applying…' : engaged ? 'Confirm release' : 'Confirm halt'}
              </Button>
              <Button variant="ghost" size="lg" onClick={() => setConfirming(false)} busy={busy}>
                Cancel
              </Button>
              <p className="text-[0.75rem] text-parchment-faint">
                {engaged
                  ? 'Routing resumes immediately for every user.'
                  : 'This cancels every working order. Cancellations that fail are recorded, not retried silently.'}
              </p>
            </>
          )}
          {!engaged && reason.trim().length < 8 && !confirming ? (
            <p className="text-[0.75rem] text-parchment-faint">A reason of at least eight characters is required.</p>
          ) : null}
        </div>

        {lastResult?.cancelAttempts !== undefined && lastResult.cancelAttempts.length > 0 ? (
          <Notice tone="warning" title="Cancellation attempts" className="mt-5">
            <ul className="space-y-1">
              {lastResult.cancelAttempts.map((attempt) => (
                <li key={attempt.orderId} className="font-mono text-2xs">
                  {attempt.orderId} → {attempt.ok ? 'cancelled' : `failed (${attempt.status ?? 'no status'})`}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}

        {kill.data !== null && kill.data.history.length > 0 ? (
          <>
            <Divider className="my-5" />
            <p className="eyebrow mb-2.5">Change history</p>
            <ul className="space-y-2">
              {kill.data.history.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline gap-2 text-[0.75rem]">
                  <Badge tone={entry.engaged ? 'burgundy' : 'sage'}>{entry.engaged ? 'engaged' : 'released'}</Badge>
                  <span className="font-mono text-2xs text-parchment-faint">{nyDateTime(entry.recordedAt)}</span>
                  <span className="text-parchment-dim">{entry.reason ?? '—'}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Panel>

      {kill.error !== null ? <ErrorPanel error={kill.error} onRetry={kill.reload} /> : null}

      {/* ── Telemetry ────────────────────────────────────────────────── */}
      <AsyncSlot state={telemetry} label="Loading the forensic record" lines={10}>
        {(data) => (
          <>
            <StatGrid className="mb-5" columns={5}>
              <StatTile label="Audit events" value={integer(data.eventTotal)} footnote="Append-only, all time" />
              <StatTile label="Ledger snapshots" value={integer(data.ledger.snapshots)} />
              <StatTile label="Ledger deltas" value={integer(data.ledger.deltas)} />
              <StatTile
                label="Rejections (24h)"
                value={integer(data.rejectionsLastDay.reduce((a, r) => a + r.count, 0))}
                tone={data.rejectionsLastDay.length > 0 ? 'burgundy' : 'neutral'}
                footnote={data.rejectionsLastDay[0]?.code ?? 'None'}
              />
              <StatTile label="Routed orders" value={integer(data.telemetry.length)} footnote="With full telemetry" />
            </StatGrid>

            {data.telemetry.length > 0 ? (
              <Panel className="mb-5" padded={false}>
                <div className="p-5 pb-0">
                  <PanelHeader
                    eyebrow="Order telemetry"
                    title="Click → risk → broker, per order"
                    detail="The six mandatory audit fields plus the full timestamp chain. An interval is null rather than zero where a stage never completed — a broker that never acknowledged has no acknowledgement latency."
                  />
                </div>
                <TableShell className="mt-4">
                  <thead>
                    <tr>
                      <Th>Order</Th>
                      <Th>Clicked</Th>
                      <Th align="right">Click→server</Th>
                      <Th align="right">Risk</Th>
                      <Th align="right">Broker ACK</Th>
                      <Th align="right">Total</Th>
                      <Th align="right">Click x,y</Th>
                      <Th>Target</Th>
                      <Th align="right">HTTP</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.telemetry.map((record) => (
                      <tr key={record.orderId}>
                        <Td>
                          <span className="font-mono text-2xs text-parchment-dim">
                            {record.orderId.slice(0, 12)}…
                          </span>
                        </Td>
                        <Td>
                          <span className="font-mono text-2xs text-parchment-faint">
                            {nyDateTime(record.timestamps.clientClick)}
                          </span>
                        </Td>
                        <Td align="right" numeric>
                          {duration(record.intervals.clickToServerMs)}
                        </Td>
                        <Td align="right" numeric>
                          {duration(record.intervals.riskMs)}
                        </Td>
                        <Td align="right" numeric>
                          {record.intervals.brokerAckMs === null ? '—' : duration(record.intervals.brokerAckMs)}
                        </Td>
                        <Td align="right" numeric>
                          {record.intervals.totalMs === null ? '—' : duration(record.intervals.totalMs)}
                        </Td>
                        <Td align="right" numeric>
                          {record.click.clickX}, {record.click.clickY}
                        </Td>
                        <Td>
                          <span className="font-mono text-2xs text-parchment-ghost">{record.click.targetId}</span>
                        </Td>
                        <Td align="right" numeric>
                          {record.brokerStatus ?? '—'}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </TableShell>

                {data.telemetry[0] !== undefined ? (
                  <div className="border-t border-obsidian-edge p-5">
                    <p className="eyebrow mb-3">Most recent order, stage by stage</p>
                    <div className="scroll-x">
                      <LatencyBar
                        stages={[
                          { stage: 'click → server', ms: data.telemetry[0].intervals.clickToServerMs },
                          { stage: 'risk', ms: data.telemetry[0].intervals.riskMs },
                          { stage: 'dispatch', ms: data.telemetry[0].intervals.dispatchMs },
                          { stage: 'broker ack', ms: data.telemetry[0].intervals.brokerAckMs ?? 0 },
                        ]}
                        totalMs={data.telemetry[0].intervals.totalMs ?? 0}
                        budgetMs={1000}
                        withinBudget={(data.telemetry[0].intervals.totalMs ?? 0) <= 1000}
                      />
                    </div>
                  </div>
                ) : null}
              </Panel>
            ) : null}

            <Panel padded={false}>
              <div className="p-5 pb-0">
                <PanelHeader
                  eyebrow="Audit events"
                  title={`${integer(data.events.length)} most recent`}
                  detail="Every mutating action and every generated query, with the service identity that performed it."
                />
              </div>
              <TableShell className="mt-4">
                <thead>
                  <tr>
                    <Th>Occurred</Th>
                    <Th>Event</Th>
                    <Th>Resource</Th>
                    <Th>User</Th>
                    <Th>IP</Th>
                    <Th align="right">Click</Th>
                    <Th>Service identity</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((event) => (
                    <tr key={event.id}>
                      <Td>
                        <span className="font-mono text-2xs text-parchment-faint">{nyDateTime(event.occurredAt)}</span>
                      </Td>
                      <Td>
                        <span className="text-2xs text-parchment-dim">{event.eventType.replace(/_/g, ' ')}</span>
                      </Td>
                      <Td>
                        <span className="font-mono text-2xs text-parchment-dim">{event.resource ?? '—'}</span>
                      </Td>
                      <Td>
                        <span className="font-mono text-2xs text-parchment-ghost">
                          {event.userId === null ? 'anonymous' : `${event.userId.slice(0, 8)}…`}
                        </span>
                      </Td>
                      <Td>
                        <span className="font-mono text-2xs text-parchment-ghost">{event.ipAddress}</span>
                      </Td>
                      <Td align="right" numeric>
                        {event.clickX === null ? '—' : `${event.clickX}, ${event.clickY}`}
                      </Td>
                      <Td>
                        <span className="font-mono text-2xs text-parchment-ghost">
                          {event.spiffeId.replace('spiffe://aurelius.local/ns/', '')}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            </Panel>

            {/* ── Entitlements ─────────────────────────────────────── */}
            <Panel className="mt-5" padded={false}>
              <div className="p-5 pb-0">
                <PanelHeader
                  eyebrow="Entitlements"
                  title="Subscription, role and live routing"
                  detail="Live routing needs two keys: an active subscription and an explicit unlock. Activating a subscription never unlocks routing on its own, and cancelling revokes it immediately. Every change here is written to the audit trail with your account against it."
                />
              </div>
              {entitlementError !== null ? (
                <div className="px-5 pt-4">
                  <Notice tone="error">{entitlementError}</Notice>
                </div>
              ) : null}
              <AsyncSlot state={entitlements} label="Loading accounts" lines={4}>
                {(data) => (
                  <TableShell className="mt-4" minWidth={980}>
                    <thead>
                      <tr>
                        <Th>Account</Th>
                        <Th>Role</Th>
                        <Th>Subscription</Th>
                        <Th align="right">Liability cap</Th>
                        <Th>Live routing</Th>
                        <Th align="right">Actions</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.users.map((user) => (
                        <tr key={user.id}>
                          <Td>
                            <span className="text-parchment">{user.email}</span>
                            <span className="ml-2 text-parchment-faint">{user.displayName}</span>
                          </Td>
                          <Td>
                            <Badge tone={user.role === 'admin' ? 'gold' : 'neutral'}>{user.role}</Badge>
                          </Td>
                          <Td>
                            <Badge tone={user.subscriptionStatus === 'active' ? 'sage' : 'neutral'}>
                              {user.subscriptionStatus}
                            </Badge>
                          </Td>
                          <Td align="right" numeric>
                            {money(user.liabilityCapUsd)}
                          </Td>
                          <Td>
                            <Badge tone={user.liveTradingUnlocked ? 'burgundy' : 'neutral'}>
                              {user.liveTradingUnlocked ? 'unlocked' : 'locked'}
                            </Badge>
                          </Td>
                          <Td align="right">
                            <span className="flex flex-wrap justify-end gap-1.5">
                              {user.subscriptionStatus === 'active' ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  busy={entitlementBusy !== null}
                                  onClick={() => void entitle(user.email, 'cancel_subscription')}
                                >
                                  Cancel
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  busy={entitlementBusy !== null}
                                  onClick={() => void entitle(user.email, 'activate_subscription', { months: 1 })}
                                >
                                  Activate {money(data.priceUsdPerMonth)}/mo
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant={user.liveTradingUnlocked ? 'primary' : 'ghost'}
                                busy={entitlementBusy !== null}
                                disabled={user.subscriptionStatus !== 'active'}
                                title={
                                  user.subscriptionStatus === 'active'
                                    ? undefined
                                    : 'An active subscription is required before live routing can be unlocked.'
                                }
                                onClick={() =>
                                  void entitle(user.email, 'set_live_unlock', { unlocked: !user.liveTradingUnlocked })
                                }
                              >
                                {user.liveTradingUnlocked ? 'Lock live' : 'Unlock live'}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                busy={entitlementBusy !== null}
                                onClick={() =>
                                  void entitle(user.email, 'set_role', {
                                    role: user.role === 'admin' ? 'trader' : 'admin',
                                  })
                                }
                              >
                                {user.role === 'admin' ? 'Demote' : 'Promote'}
                              </Button>
                            </span>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </TableShell>
                )}
              </AsyncSlot>
            </Panel>

            <Notice tone="legal" className="mt-5">
              This record contains personal data about every user of the platform. Access is logged. It exists to satisfy
              the audit obligations described in the Terms and is not to be used for any other purpose.
            </Notice>
          </>
        )}
      </AsyncSlot>
    </PageShell>
  );
}
