/**
 * Portfolio — account state, positions and the order blotter.
 *
 * The notice at the top of this page is the point of it. Aurelius reads the account
 * for two purposes only: the pre-trade margin check required by Rule 15c3-5, and
 * displaying it back to the user here. It does not feed the account into signal
 * generation, does not size a position from it, and does not adjust a conviction
 * score because of what is held.
 *
 * That constraint is what keeps the analysis impersonal, and it is invisible unless
 * stated — a user looking at their positions next to a conviction score would
 * reasonably assume the one informed the other. So the separation is declared where
 * the two appear together, rather than only in the terms.
 *
 * Rejected orders are shown with the risk code that stopped them. A rejection is the
 * only trace an unrouted order leaves, and "why was I stopped" is the question this
 * blotter exists to answer.
 */

'use client';

import Link from 'next/link';
import { AsyncSlot, PageHeader, PageShell } from '@/components/PageState';
import {
  Badge,
  Button,
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
import { useApi, type MeResponse } from '@/lib/ui/api';
import { integer, money, nyDateTime, price, signedFractionAsPercent } from '@/lib/ui/format';
import type { OrderStatus } from '@/lib/domain/types';

interface Position {
  symbol: string;
  quantity: number;
  averageEntry: number;
  marketPrice: number;
  marketValue: number;
  unrealisedPnl: number;
  unrealisedPnlPercent: number;
  realisedPnl: number;
  openedAt: number;
  account: 'paper' | 'live';
}

interface AccountResponse {
  account: {
    account: 'paper' | 'live';
    cash: number;
    equity: number;
    buyingPower: number;
    grossExposure: number;
    netExposure: number;
    maintenanceMargin: number;
    dayPnl: number;
    totalPnl: number;
    positions: Position[];
    updatedAt: number;
  } | null;
  broker: { name: string; mode: string; endpoint: string; supportsCancel: boolean; supportsFractional: boolean };
  brokerStatus: number | null;
  available: boolean;
  error: string | null;
  entitlement: { paper: boolean; live: boolean; reason: string; status: string; priceUsdPerMonth: number };
}

interface RiskCheck {
  code: string | null;
  passed: boolean;
  message: string;
  check: string;
}

interface OrderRow {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  quantity: number;
  limitPrice: number | null;
  stopPrice: number | null;
  timeInForce: string;
  account: 'paper' | 'live';
  status: OrderStatus;
  filledQuantity: number;
  averageFillPrice: number | null;
  createdAt: number;
  updatedAt: number;
  brokerStatus: number | null;
  brokerOrderId: string | null;
  riskDecision: { approved: boolean; checks: RiskCheck[]; rejection?: { code: string; message: string } | null } | null;
}

interface OrdersResponse {
  orders: OrderRow[];
  count: number;
}

/** Terminal statuses read differently from working ones, so they are toned apart. */
const STATUS_TONE: Record<string, 'sage' | 'burgundy' | 'gold' | 'neutral' | 'ghost'> = {
  filled: 'sage',
  partially_filled: 'gold',
  submitted: 'gold',
  pending_risk: 'neutral',
  rejected_risk: 'burgundy',
  broker_error: 'burgundy',
  cancelled: 'ghost',
  expired: 'ghost',
};

export default function PortfolioPage() {
  const me = useApi<MeResponse>('/auth/me');
  const signedIn = me.data?.user !== null && me.data?.user !== undefined;

  /**
   * Both requests are deferred until a session is known to exist.
   *
   * Firing them anonymously is not merely wasteful — the browser logs a console
   * error for every 401 response, so an unauthenticated visit to this page
   * produced two console errors on a page that was working exactly as designed.
   * A sign-in prompt is both the correct UX and the quiet one.
   */
  const account = useApi<AccountResponse>(signedIn ? '/account' : null, { pollMs: 30_000 });
  const orders = useApi<OrdersResponse>(signedIn ? '/orders' : null, { pollMs: 30_000 });

  if (me.loading) {
    return (
      <PageShell wide>
        <PageHeader eyebrow="Account" title="Portfolio" />
        <Panel>
          <p className="text-[0.8125rem] text-parchment-faint" role="status">
            Checking your session…
          </p>
        </Panel>
      </PageShell>
    );
  }

  if (!signedIn) {
    return (
      <PageShell wide>
        <PageHeader
          eyebrow="Account"
          title="Portfolio"
          lede="Positions, orders and account state, read from the broker."
        />
        <Notice tone="warning" title="Not signed in">
          A portfolio belongs to an account.{' '}
          <Link href="/login" className="text-gold underline decoration-gold/40">
            Sign in
          </Link>{' '}
          to see positions, the order blotter and the risk decision behind each order.
        </Notice>
      </PageShell>
    );
  }

  return (
    <PageShell wide>
      <PageHeader
        eyebrow="Account"
        title="Portfolio"
        lede="Positions, orders and account state, read from the broker. Shown here and used for the pre-trade margin check — and for nothing else."
        action={
          account.data ? (
            <Badge tone={account.data.account?.account === 'live' ? 'burgundy' : 'neutral'}>
              {account.data.account?.account ?? 'no account'} · {account.data.broker.name}
            </Badge>
          ) : null
        }
      />

      <Notice tone="legal" className="mb-6">
        Aurelius does not read your holdings, balances or buying power for the purpose of generating analysis. No signal,
        conviction score, level or narrative on this platform varies with what you own. Position sizing is yours alone to
        determine.
      </Notice>

      {account.data?.available === false ? (
        <Notice tone="error" title="Broker unavailable" className="mb-5">
          {account.data.error ?? 'The broker did not return an account snapshot.'} The pre-trade margin check cannot
          pass while this is true, so no order will route.
        </Notice>
      ) : null}

      <AsyncSlot state={account} label="Loading the account" lines={6}>
        {(data) =>
          data.account === null ? (
            <Panel>
              <PanelHeader eyebrow="Account" title="No account snapshot" detail={data.error ?? undefined} />
            </Panel>
          ) : (
            <>
              <StatGrid className="mb-5" columns={6}>
                <StatTile label="Equity" value={money(data.account.equity, { whole: true })} tone="gold" />
                <StatTile label="Cash" value={money(data.account.cash, { whole: true })} />
                <StatTile
                  label="Buying power"
                  value={money(data.account.buyingPower, { whole: true })}
                  footnote="As reported by the broker"
                />
                <StatTile
                  label="Gross exposure"
                  value={money(data.account.grossExposure, { whole: true })}
                  footnote={`Net ${money(data.account.netExposure, { whole: true })}`}
                />
                <StatTile
                  label="Day P&L"
                  value={money(data.account.dayPnl)}
                  tone={data.account.dayPnl >= 0 ? 'sage' : 'burgundy'}
                />
                <StatTile
                  label="Total P&L"
                  value={money(data.account.totalPnl)}
                  tone={data.account.totalPnl >= 0 ? 'sage' : 'burgundy'}
                />
              </StatGrid>

              {!data.entitlement.live ? (
                <Notice tone="info" title="Live routing not enabled" className="mb-5">
                  {data.entitlement.reason}
                </Notice>
              ) : null}

              {/* ── Positions ─────────────────────────────────────────── */}
              <Panel padded={false} className="mb-5">
                <div className="p-5 pb-0">
                  <PanelHeader
                    eyebrow="Positions"
                    title={`${integer(data.account.positions.length)} open`}
                    detail={
                      data.account.positions.length === 0
                        ? 'No open position. Orders routed from the ticket appear here once filled.'
                        : undefined
                    }
                  />
                </div>
                {data.account.positions.length > 0 ? (
                  <div className="scroll-x mt-4">
                    <TableShell>
                      <thead>
                        <tr>
                          <Th>Symbol</Th>
                          <Th align="right">Quantity</Th>
                          <Th align="right">Avg entry</Th>
                          <Th align="right">Mark</Th>
                          <Th align="right">Market value</Th>
                          <Th align="right">Unrealised</Th>
                          <Th align="right">Return</Th>
                          <Th>Opened</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.account.positions.map((position) => (
                          <tr key={position.symbol}>
                            <Td>
                              <Link
                                href={`/terminal/${position.symbol}`}
                                className="font-mono text-parchment underline decoration-obsidian-edge hover:decoration-gold"
                              >
                                {position.symbol}
                              </Link>
                            </Td>
                            <Td align="right" numeric>
                              {integer(position.quantity)}
                            </Td>
                            <Td align="right" numeric>
                              {price(position.averageEntry)}
                            </Td>
                            <Td align="right" numeric>
                              {price(position.marketPrice)}
                            </Td>
                            <Td align="right" numeric>
                              {money(position.marketValue, { whole: true })}
                            </Td>
                            <Td
                              align="right"
                              numeric
                              className={position.unrealisedPnl >= 0 ? 'text-sage-bright' : 'text-burgundy-bright'}
                            >
                              {money(position.unrealisedPnl)}
                            </Td>
                            <Td
                              align="right"
                              numeric
                              className={position.unrealisedPnlPercent >= 0 ? 'text-sage-bright' : 'text-burgundy-bright'}
                            >
                              {signedFractionAsPercent(position.unrealisedPnlPercent)}
                            </Td>
                            <Td>
                              <span className="font-mono text-2xs text-parchment-faint">
                                {nyDateTime(position.openedAt)}
                              </span>
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </TableShell>
                  </div>
                ) : (
                  <div className="p-5" />
                )}
              </Panel>

              <Panel className="mb-5">
                <PanelHeader eyebrow="Broker" title="Route in force" />
                <dl className="mt-3 space-y-0.5">
                  <DataRow label="Adapter" value={data.broker.name} />
                  <DataRow label="Mode" value={data.broker.mode} />
                  <DataRow label="Endpoint" value={data.broker.endpoint} />
                  <DataRow label="Supports cancel" value={data.broker.supportsCancel ? 'yes' : 'no'} />
                  <DataRow label="Supports fractional" value={data.broker.supportsFractional ? 'yes' : 'no'} />
                  <DataRow label="Snapshot at" value={nyDateTime(data.account.updatedAt)} />
                  <DataRow label="Maintenance margin" value={money(data.account.maintenanceMargin, { whole: true })} />
                </dl>
                <Divider className="my-4" />
                <p className="text-[0.75rem] leading-relaxed text-parchment-faint">
                  Routes are described by capability only. No route is characterised as preferred, fastest or
                  best-priced — doing so would assume a duty of best execution this platform does not hold.
                </p>
              </Panel>
            </>
          )
        }
      </AsyncSlot>

      {/* ── Blotter ─────────────────────────────────────────────────── */}
      <AsyncSlot
        state={orders}
        label="Loading the blotter"
        lines={5}
        isEmpty={(data) => data.orders.length === 0}
        emptyTitle="No orders yet"
        emptyDetail="Every order you route appears here with its risk decision, broker status and fill. Rejected orders are kept — a rejection is the only trace an unrouted order leaves."
      >
        {(data) => (
          <Panel padded={false}>
            <div className="p-5 pb-0">
              <PanelHeader
                eyebrow="Blotter"
                title={`${integer(data.count)} order${data.count === 1 ? '' : 's'}`}
                detail="Including rejections, with the control that stopped them."
              />
            </div>
            <div className="scroll-x mt-4">
              <TableShell>
                <thead>
                  <tr>
                    <Th>Submitted</Th>
                    <Th>Symbol</Th>
                    <Th>Side</Th>
                    <Th>Type</Th>
                    <Th align="right">Qty</Th>
                    <Th align="right">Filled</Th>
                    <Th align="right">Avg fill</Th>
                    <Th>Status</Th>
                    <Th>Account</Th>
                    <Th>Risk outcome</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.orders.map((order) => {
                    const rejection = order.riskDecision?.rejection ?? null;
                    return (
                      <tr key={order.id}>
                        <Td>
                          <span className="font-mono text-2xs text-parchment-faint">{nyDateTime(order.createdAt)}</span>
                        </Td>
                        <Td>
                          <Link
                            href={`/terminal/${order.symbol}`}
                            className="font-mono text-parchment underline decoration-obsidian-edge hover:decoration-gold"
                          >
                            {order.symbol}
                          </Link>
                        </Td>
                        <Td>
                          <Badge tone={order.side === 'buy' ? 'sage' : 'burgundy'}>{order.side}</Badge>
                        </Td>
                        <Td>
                          <span className="text-2xs text-parchment-dim">{order.type.replace(/_/g, ' ')}</span>
                        </Td>
                        <Td align="right" numeric>
                          {integer(order.quantity)}
                        </Td>
                        <Td align="right" numeric>
                          {integer(order.filledQuantity)}
                        </Td>
                        <Td align="right" numeric>
                          {order.averageFillPrice === null ? '—' : price(order.averageFillPrice)}
                        </Td>
                        <Td>
                          <Badge tone={STATUS_TONE[order.status] ?? 'neutral'}>{order.status.replace(/_/g, ' ')}</Badge>
                        </Td>
                        <Td>
                          <span className="text-2xs text-parchment-dim">{order.account}</span>
                        </Td>
                        <Td>
                          {rejection !== null ? (
                            <span className="text-2xs leading-snug text-burgundy-bright" title={rejection.message}>
                              {rejection.code}
                            </span>
                          ) : order.riskDecision?.approved === true ? (
                            <span className="text-2xs text-sage-bright">approved</span>
                          ) : (
                            <span className="text-2xs text-parchment-faint">—</span>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </TableShell>
            </div>
            <div className="p-5 pt-4">
              <Link href="/control">
                <Button variant="ghost" size="sm">
                  Risk limits and decision history
                </Button>
              </Link>
            </div>
          </Panel>
        )}
      </AsyncSlot>

      <p className="mt-6 text-[0.75rem] leading-relaxed text-parchment-faint">
        Unrealised P&amp;L is marked at the broker&rsquo;s reported price and is not a realised result. Fractional
        percentages are computed against average entry.
      </p>
    </PageShell>
  );
}
