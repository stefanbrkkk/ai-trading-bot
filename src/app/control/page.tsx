/**
 * Control centre — the published risk limits, the data feeds, and your own risk
 * decision history.
 *
 * The limits here are **read-only, and that is the design**. A user-adjustable
 * fat-finger ceiling is not a pre-trade control; it is a suggestion, and Rule
 * 15c3-5 requires controls that cannot be circumvented by the person they
 * constrain. So the page publishes each threshold, its unit, and the regulatory
 * basis it derives from — and offers no way to change any of them.
 *
 * The risk decision history is scoped to the caller by the session, never by a
 * query parameter. A user is entitled to the complete record of every decision
 * taken on an order they submitted and to nothing about anyone else's.
 *
 * A pre-flight check is not in that record, and the copy on this page now says so.
 * `POST /api/orders/preflight` runs the identical engine with `commit: false` and
 * writes nothing at all, which is the right behaviour for a preview — but this
 * page told the reader that "a decision is recorded every time you run a
 * pre-flight check", so an account that had previewed two orders was shown an
 * empty history under a sentence promising two rows.
 */

'use client';

import { AsyncSlot, PageHeader, PageShell } from '@/components/PageState';
import {
  Badge,
  DataRow,
  Divider,
  Notice,
  Panel,
  PanelHeader,
  StatGrid,
  StatTile,
  TableShell,
  Td,
  Th,
} from '@/components/ui/primitives';
import { useApi, type HealthResponse, type MeResponse } from '@/lib/ui/api';
import { duration, integer, money, nyDateTime } from '@/lib/ui/format';

interface RiskLimit {
  code: string;
  label: string;
  value: number;
  unit: string;
  rationale: string;
  regulatoryBasis: string;
}

interface LimitsResponse {
  limits: RiskLimit[];
  killSwitchEngaged: boolean;
}

interface DecisionRecord {
  id: string;
  userId: string;
  symbol: string;
  orderId?: string | null;
  correlationId?: string | null;
  decision: {
    approved: boolean;
    evaluatedAt: number;
    elapsedMs: number;
    checks: { code: string | null; passed: boolean; message: string; check: string }[];
    rejection?: { code: string; message: string; check: string; observed: number | null; limit: number | null } | null;
  };
}

interface DecisionsResponse {
  decisions: DecisionRecord[];
  total: number;
  approved: number;
  rejected: number;
  rejectionsByCode: { code: string; count: number }[];
  limits: RiskLimit[];
}

/**
 * A label beside a sentence, kept on the same line as its label.
 *
 * The shared `DataRow` primitive is right for a scalar and wrong for this list.
 * It lays a row out as one wrapping flex line, so a value that will not fit
 * beside its label drops to a line of its own — a deliberate escape valve, and
 * the only thing standing between a 320px phone and a page-level horizontal
 * scroll when a long label meets a long value.
 *
 * The provider reasons are not scalars. `aiReason` is a full sentence — 137
 * characters on this deployment — so the valve fired on every render between
 * 1024 and 1440: "Inference" sat alone on one line with its sentence orphaned
 * beneath it, right-aligned against a ragged left edge that lined up with
 * nothing else on the page, immediately under a "Market data" row that had
 * stayed intact. Two rows of one list rendering as two different components is
 * exactly the sort of thing a reader reads as a fault in the data.
 *
 * A two-column grid removes the choice. `minmax(0, …)` floors both tracks at
 * zero instead of at min-content, which is what the flex version's wrap was
 * guarding against, so the sentence wraps inside its own column at every width
 * rather than moving out of it. `text-right` is kept so a wrapped reason lines
 * up on the same edge as a one-line one, as every other row in the product does.
 */
function ReasonRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="hairline grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] items-baseline gap-x-4 py-2">
      <dt className="text-[0.8125rem] text-parchment-dim">{label}</dt>
      <dd className="text-right text-[0.8125rem] leading-snug text-parchment">{value}</dd>
    </div>
  );
}

/** Formats a limit in the unit it declares. */
function formatLimit(value: number, unit: string): string {
  switch (unit) {
    case 'currency':
      return money(value, { whole: true });
    case 'percent':
      return `${value}%`;
    case 'count':
      return integer(value);
    case 'shares':
      return `${integer(value)} sh`;
    case 'days':
      return `${integer(value)} d`;
    case 'milliseconds':
      return duration(value);
    case 'per_second':
      return `${integer(value)}/s`;
    default:
      return String(value);
  }
}

export default function ControlPage() {
  const limits = useApi<LimitsResponse>('/risk/limits');
  const health = useApi<HealthResponse>('/health', { pollMs: 30_000 });
  const me = useApi<MeResponse>('/auth/me');
  const decisions = useApi<DecisionsResponse>(me.data?.user ? '/risk/decisions?limit=100' : null);

  return (
    <PageShell wide>
      <PageHeader
        eyebrow="Controls and feeds"
        title="Control centre"
        lede="The pre-trade limits in force, the data and inference providers serving this deployment, and the complete record of every risk decision taken on an order you submitted."
      />

      {limits.data?.killSwitchEngaged === true ? (
        <Notice tone="error" title="Order routing halted" className="mb-6">
          The platform-wide kill switch is engaged. Analysis continues to publish; no order can be submitted by any
          user until it is released.
        </Notice>
      ) : null}

      {/* ── Feeds ────────────────────────────────────────────────────── */}
      <AsyncSlot state={health} label="Reading the deployment state" lines={5}>
        {(data) => (
          <>
            <StatGrid className="mb-5" columns={5}>
              <StatTile
                label="Market data"
                value={data.provider}
                size="sm"
                tone={data.providerLive ? 'sage' : 'neutral'}
                footnote={data.providerLive ? 'Live feed' : 'Deterministic simulator'}
              />
              <StatTile
                label="Inference"
                value={data.aiProvider}
                size="sm"
                tone={data.aiLive ? 'sage' : 'neutral'}
                footnote={data.aiLive ? 'Live provider' : 'Deterministic engines'}
              />
              <StatTile label="Persistence" value={data.dbMode} size="sm" footnote="Append-only ledger" />
              <StatTile
                label="Engine"
                value={data.engineReady ? 'ready' : 'not ready'}
                size="sm"
                tone={data.engineReady ? 'sage' : 'burgundy'}
                footnote={data.modelVersion}
              />
              {/* The phase is only worth a footnote when it says more than the
                  value already does — outside session hours both read "closed". */}
              <StatTile
                label="Session"
                value={data.marketOpen ? 'open' : 'closed'}
                size="sm"
                footnote={
                  data.marketPhase.replace(/_/g, ' ') === (data.marketOpen ? 'open' : 'closed')
                    ? 'New York regular session'
                    : data.marketPhase.replace(/_/g, ' ')
                }
              />
            </StatGrid>

            <Panel className="mb-5">
              <PanelHeader
                eyebrow="Provider status"
                title="What is actually serving"
                detail="A half-configured provider is reported as degraded rather than silently substituted — a silent downgrade is indistinguishable from a working configuration."
              />
              <dl className="mt-3 space-y-0.5">
                <ReasonRow label="Market data" value={data.providerReason} />
                <ReasonRow label="Inference" value={data.aiReason} />
                {data.engineReason !== null ? <ReasonRow label="Engine" value={data.engineReason} /> : null}
                {data.modelReason !== null ? <ReasonRow label="Model" value={data.modelReason} /> : null}
                {data.degradedFeeds.length > 0 ? (
                  <ReasonRow label="Degraded feeds" value={data.degradedFeeds.join(', ')} />
                ) : null}
              </dl>
            </Panel>
          </>
        )}
      </AsyncSlot>

      {/* ── Limits ───────────────────────────────────────────────────── */}
      <AsyncSlot state={limits} label="Loading the risk limits" lines={8}>
        {(data) => (
          <Panel className="mb-5" padded={false}>
            <div className="p-5 pb-0">
              <PanelHeader
                eyebrow="Pre-trade controls"
                title={`${integer(data.limits.length)} limits in force`}
                detail="Read-only by design. A limit the constrained party can raise is not a control, so none of these is adjustable — by you or by support."
                action={<Badge tone="neutral">read-only</Badge>}
              />
            </div>
            <TableShell className="mt-4">
              <thead>
                <tr>
                  <Th>Limit</Th>
                  <Th align="right">Threshold</Th>
                  <Th>Why it exists</Th>
                  <Th>Regulatory basis</Th>
                </tr>
              </thead>
              <tbody>
                {data.limits.map((limit) => (
                  <tr key={limit.code}>
                    <Td>
                      <span className="text-parchment">{limit.label}</span>
                      <span className="ml-2 font-mono text-2xs text-parchment-ghost">{limit.code}</span>
                    </Td>
                    <Td align="right" numeric className="text-gold">
                      {formatLimit(limit.value, limit.unit)}
                    </Td>
                    <Td>
                      <span className="text-2xs leading-snug text-parchment-dim">{limit.rationale}</span>
                    </Td>
                    <Td>
                      <span className="text-2xs leading-snug text-parchment-faint">{limit.regulatoryBasis}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </Panel>
        )}
      </AsyncSlot>

      {/* ── Decision history ─────────────────────────────────────────── */}
      {me.data?.user === null || me.data?.user === undefined ? (
        <Notice tone="info" title="Sign in for your decision history">
          Every risk decision taken on an order you submit is recorded, including the ones that rejected it. A pre-flight
          check is a preview that reserves nothing and writes nothing, so it does not appear. The record is scoped to
          your own account.
        </Notice>
      ) : (
        <AsyncSlot
          state={decisions}
          label="Loading your decision history"
          lines={5}
          isEmpty={(data) => data.decisions.length === 0}
          emptyTitle="No risk decisions yet"
          emptyDetail="A decision is recorded every time you submit an order — approvals and rejections alike. A pre-flight check is a preview that reserves nothing and writes nothing, so running one leaves this empty."
        >
          {(data) => (
            <>
              <StatGrid className="mb-5" columns={4}>
                <StatTile label="Decisions" value={integer(data.total)} />
                <StatTile label="Approved" value={integer(data.approved)} tone="sage" />
                <StatTile label="Rejected" value={integer(data.rejected)} tone={data.rejected > 0 ? 'burgundy' : 'neutral'} />
                <StatTile
                  label="Most common rejection"
                  value={data.rejectionsByCode[0]?.code ?? '—'}
                  size="sm"
                  footnote={
                    data.rejectionsByCode[0] === undefined
                      ? 'Nothing rejected'
                      : `${integer(data.rejectionsByCode[0].count)} ${data.rejectionsByCode[0].count === 1 ? 'occurrence' : 'occurrences'}`
                  }
                />
              </StatGrid>

              <Panel padded={false}>
                <div className="p-5 pb-0">
                  <PanelHeader
                    eyebrow="Your risk decisions"
                    title="Every submitted order, approved and rejected"
                    detail="A rejected order leaves no other trace, so this is the record of why you were stopped."
                  />
                </div>
                <TableShell className="mt-4">
                  <thead>
                    <tr>
                      <Th>Evaluated</Th>
                      <Th>Symbol</Th>
                      <Th align="center">Outcome</Th>
                      <Th>Code</Th>
                      <Th>Message</Th>
                      <Th align="right">Elapsed</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.decisions.map((record) => (
                      <tr key={record.id}>
                        <Td>
                          <span className="font-mono text-2xs text-parchment-faint">
                            {nyDateTime(record.decision.evaluatedAt)}
                          </span>
                        </Td>
                        <Td>
                          <span className="font-mono text-parchment">{record.symbol}</span>
                        </Td>
                        <Td align="center">
                          <Badge tone={record.decision.approved ? 'sage' : 'burgundy'}>
                            {record.decision.approved ? 'approved' : 'rejected'}
                          </Badge>
                        </Td>
                        <Td>
                          <span className="font-mono text-2xs text-parchment-dim">
                            {record.decision.rejection?.code ?? '—'}
                          </span>
                        </Td>
                        <Td>
                          <span className="text-2xs leading-snug text-parchment-dim">
                            {record.decision.rejection?.message ?? 'All pre-trade controls passed.'}
                          </span>
                        </Td>
                        <Td align="right" numeric>
                          {duration(record.decision.elapsedMs)}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </TableShell>
              </Panel>

              {data.rejectionsByCode.length > 0 ? (
                <Panel className="mt-5">
                  <PanelHeader eyebrow="Rejections by control" title="Which limits stopped you" />
                  <dl className="mt-3 space-y-0.5">
                    {data.rejectionsByCode.map((entry) => {
                      const limit = data.limits.find((l) => l.code === entry.code);
                      return (
                        <DataRow
                          key={entry.code}
                          label={limit?.label ?? entry.code}
                          value={integer(entry.count)}
                          hint={limit?.rationale}
                        />
                      );
                    })}
                  </dl>
                  <Divider className="my-4" />
                  <p className="text-[0.75rem] leading-relaxed text-parchment-faint">
                    A rejection is not an error. Each of these controls exists to stop a specific category of mistake
                    before it reaches a venue, and the threshold that fired is published above.
                  </p>
                </Panel>
              ) : null}
            </>
          )}
        </AsyncSlot>
      )}
    </PageShell>
  );
}
