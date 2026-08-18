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
 * The blotter lists the orders that routed, each with the risk decision that let it
 * through. An order the pre-trade controls refused never becomes a row here at all:
 * `/api/orders/submit` writes the decision and the audit event and answers 422 well
 * before it reaches `insertOrder`, so a refusal exists in the decision history and
 * nowhere else. "Why was I stopped" is therefore answered by /control, which the
 * blotter links to at its foot — and this file used to say the opposite, promising
 * in its empty state that rejected orders were kept here, directly contradicting the
 * subtitle the same panel showed once it had rows.
 */

'use client';

import Link from 'next/link';
import { AsyncSlot, PageHeader, PageShell } from '@/components/PageState';
import {
  Badge,
  ButtonLink,
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
  signTone,
} from '@/components/ui/primitives';
import { useApi, type MeResponse } from '@/lib/ui/api';
import {
  fractionAsPercent,
  integer,
  money,
  nyDateTime,
  price,
  ratio,
  signedFractionAsPercent,
} from '@/lib/ui/format';
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

interface TailPair {
  a: string;
  b: string;
  family: string;
  tau: number;
  lowerTail: number;
  upperTail: number;
}

interface TailRiskResponse {
  available: boolean;
  reason: string | null;
  symbols: string[];
  holdings: number;
  sessions?: number;
  quantile?: number;
  concentrationMultiple?: number;
  expectedCoMovers?: number;
  lowerTailDependence?: number;
  upperTailDependence?: number;
  logLikelihood?: number;
  aic?: number;
  pairs?: TailPair[];
  notice?: string;
}

/** Pair-copula families, spelled the way the literature does. */
const COPULA_LABELS: Record<string, string> = {
  independence: 'Independence',
  gaussian: 'Gaussian',
  student: 'Student-t',
  clayton: 'Clayton',
  gumbel: 'Gumbel',
  frank: 'Frank',
};

/**
 * What each family says about the tails, in one clause.
 *
 * A family name on its own is jargon. The reason a reader cares which one was
 * selected is that the families disagree about exactly the thing a correlation
 * cannot express — whether the pair clusters in the left tail, the right, both
 * or neither — so the selection is stated as that, not as a label.
 */
const COPULA_MEANING: Record<string, string> = {
  independence: 'no dependence beyond chance',
  gaussian: 'dependent in the middle, independent in both tails',
  student: 'clusters in both tails — crashes and rallies together',
  clayton: 'clusters in the lower tail — falls together, rises apart',
  gumbel: 'clusters in the upper tail — rises together, falls apart',
  frank: 'symmetric dependence, no tail clustering',
};

/**
 * Joint downside risk across the open book.
 *
 * Every other risk figure on this platform is marginal — one symbol's
 * volatility, one symbol's drawdown — and a portfolio does not fail one symbol
 * at a time. This is the only panel that answers "what happens if they all go
 * at once", and it answers it with a C-vine copula rather than a correlation
 * matrix, because linear correlation is a single number for the whole
 * distribution and equities are far more dependent in the left tail than it
 * implies.
 */
function TailRiskPanel({ account }: { account: 'paper' | 'live' }) {
  const tail = useApi<TailRiskResponse>(`/risk/tail?account=${account}`, { pollMs: 60_000 });

  /*
   * Through `AsyncSlot`, like every other panel on this page.
   *
   * The guard here used to be a bare `if (tail.loading || tail.data === null)
   * return null`, and `useApi` leaves `data` at null when a request fails — so a
   * 500 from `/risk/tail` deleted the panel outright. Nothing said so: no error,
   * no empty state, no retry, no live-region announcement, just a page that
   * silently no longer mentions joint downside, on the one surface that answers
   * "what happens if they all go at once". A reader cannot tell a portfolio with
   * no measurable co-movement from a measurement that failed, and the first
   * reading is the reassuring one.
   *
   * `AsyncSlot` is the page's existing answer to all of that — skeleton, error
   * panel with a retry, an announcement for each, and the stale-data notice when
   * a 60-second poll fails on top of figures already on screen, which matters
   * here because a tail dependence that is quietly an hour old is exactly the
   * kind of number that should not be read as current.
   */
  return (
    <div className="mb-5">
      <AsyncSlot state={tail} label="Joint downside" lines={4}>
        {(data) => <TailRisk data={data} />}
      </AsyncSlot>
    </div>
  );
}

/** The panel body, once the copula fit has actually arrived. */
function TailRisk({ data }: { data: TailRiskResponse }) {
  if (!data.available) {
    return (
      <Panel>
        <PanelHeader
          eyebrow="Joint downside"
          title="Co-movement"
          detail="How the holdings behave when they fall together, rather than one at a time."
        />
        <p className="mt-3 text-[0.8125rem] leading-relaxed text-parchment-faint">{data.reason}</p>
      </Panel>
    );
  }

  const multiple = data.concentrationMultiple ?? 0;
  const lambda = data.lowerTailDependence ?? 0;
  const coMovers = data.expectedCoMovers ?? 0;
  const quantilePct = fractionAsPercent(data.quantile ?? 0.05, 0);
  const others = Math.max(0, data.holdings - 1);

  return (
    <Panel>
      <PanelHeader
        eyebrow="Joint downside"
        title="What happens when one of them breaks"
        detail={`The first tree of a C-vine, fitted to ${integer(data.sessions ?? 0)} sessions of log returns across ${integer(
          data.holdings,
        )} holdings: the ${integer(Math.max(0, data.holdings - 1))} pairwise dependences between the most-connected position and every other. A copula separates each position's own return distribution from the dependence between them, so the figures below are co-movement alone — not volatility wearing a different name.`}
      />

      <StatGrid columns={3} className="mt-4">
        <StatTile
          label="Concentration multiple"
          value={`${ratio(multiple, multiple >= 10 ? 1 : 2)}×`}
          tone={multiple >= 5 ? 'burgundy' : multiple >= 2 ? 'gold' : 'sage'}
          footnote="Against chance, which is 1.0×"
        />
        {/*
          Named for the quantity, not for a probability it is not.

          This tile read "P(a peer is also below its own 5%)", which claims a
          conditional probability measured at a finite 5% threshold. λ_L is not
          that: it is the LIMIT of that probability as the threshold goes to
          zero — how tightly two names cling together in the extreme tail, which
          is a different and strictly worse-case number than the one at 5%.
          Publishing the limit under the finite label overstated a book's 5%-day
          risk and understated what happens further out.
        */}
        <StatTile
          label="Lower-tail dependence"
          value={fractionAsPercent(lambda, 1)}
          footnote="λ_L — the limiting co-crash probability, exact from the fitted copulas"
        />
        <StatTile
          label="Expected co-movers"
          value={`${ratio(coMovers, 2)} of ${integer(others)}`}
          footnote="Other holdings joining a name on its worst days"
        />
      </StatGrid>

      <Divider className="my-4" />

      <p className="text-[0.75rem] leading-relaxed text-parchment-dim">
        On any given day a holding is below its own {quantilePct} threshold {quantilePct} of the time — that is what
        the threshold means, and if these names were independent that would still be true of each of them when another
        one broke. It is not. As the threshold is pushed further into the tail, the chance that a peer is down there
        too converges on <span className="tabular text-parchment">{fractionAsPercent(lambda, 1)}</span> rather than
        falling away to nothing: <span className="tabular text-gold">{ratio(multiple, multiple >= 10 ? 1 : 2)}×</span>{' '}
        the {quantilePct} a coin flip would give. That excess is the cost of holding names that break together, and a
        correlation matrix cannot show it — correlation is one number for the whole distribution, while this is a
        property of the left tail specifically.
      </p>

      {data.pairs && data.pairs.length > 0 ? (
        <>
          <p className="eyebrow mt-5 mb-2">Selected pair copulas</p>
          <TableShell minWidth={520}>
            <thead>
              <tr>
                {/*
                  Words, not Greek letters. `Th` renders `uppercase`, which turns
                  τ into Τ — visually a Latin T — and λ‾ into Λ¯. Case is not
                  decoration on a mathematical symbol: Λ is a different quantity
                  from λ. The symbols are named in the footnote below, where they
                  survive intact.
                */}
                <Th>Pair</Th>
                <Th>Family</Th>
                <Th align="right">Kendall tau</Th>
                <Th align="right">Lower tail</Th>
                <Th>What it means</Th>
              </tr>
            </thead>
            <tbody>
              {data.pairs.map((pair) => (
                <tr key={`${pair.a}-${pair.b}`}>
                  <Td>
                    <span className="font-mono text-parchment">
                      {pair.a} ~ {pair.b}
                    </span>
                  </Td>
                  <Td>{COPULA_LABELS[pair.family] ?? pair.family}</Td>
                  <Td align="right" numeric>
                    {ratio(pair.tau, 2)}
                  </Td>
                  <Td align="right" numeric className={pair.lowerTail > 0.2 ? 'text-burgundy-bright' : undefined}>
                    {ratio(pair.lowerTail, 2)}
                  </Td>
                  <Td>
                    <span className="text-parchment-dim">{COPULA_MEANING[pair.family] ?? '—'}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
          <p className="mt-3 text-[0.75rem] leading-relaxed text-parchment-faint">
            Kendall&rsquo;s <span className="text-parchment">τ</span> is rank correlation; lower-tail dependence{' '}
            <span className="text-parchment">λ</span>
            <sub>L</sub> is the limiting probability that one name is in its own left tail given that the other
            already is, and it has a closed form for every family here — Gaussian and Frank are exactly zero, which
            is itself worth knowing when it happens. Each family was selected by AIC against the pair&rsquo;s own
            pseudo-observations, not assumed. First-tree log-likelihood {ratio(data.logLikelihood ?? 0, 1)}, AIC{' '}
            {ratio(data.aic ?? 0, 1)}.
          </p>
        </>
      ) : null}

      <Notice tone="legal" className="mt-4">
        {data.notice}
      </Notice>
    </Panel>
  );
}

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
          /*
            The account kind and the adapter name are the same word under the paper
            broker, and "paper · paper" told the reader nothing twice. Only the
            second half is printed when they agree.
          */
          account.data ? (
            <Badge tone={account.data.account?.account === 'live' ? 'burgundy' : 'neutral'}>
              {account.data.account?.account && account.data.account.account !== account.data.broker.name
                ? `${account.data.account.account} · ${account.data.broker.name}`
                : (account.data.account?.account ?? account.data.broker.name ?? 'no account')}
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
                  tone={signTone(data.account.dayPnl)}
                />
                <StatTile
                  label="Total P&L"
                  value={money(data.account.totalPnl)}
                  tone={signTone(data.account.totalPnl)}
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
                    /* "0 open" was the whole heading, which says nothing when
                       read out of context in a heading list. */
                    title={`${integer(data.account.positions.length)} open ${
                      data.account.positions.length === 1 ? 'position' : 'positions'
                    }`}
                    detail={
                      data.account.positions.length === 0
                        ? 'No open position. Orders routed from the ticket appear here once filled.'
                        : undefined
                    }
                  />
                </div>
                {data.account.positions.length > 0 ? (
                  <TableShell className="mt-4">
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
                ) : (
                  <div className="p-5" />
                )}
              </Panel>

              {/* ── Joint downside ────────────────────────────────────── */}
              <TailRiskPanel account={data.account.account === 'live' ? 'live' : 'paper'} />

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
        emptyDetail="Every order that routes appears here with its risk decision, broker status and fill. An order refused by the pre-trade controls never becomes one — /control lists every rejection with the limit that stopped it."
      >
        {(data) => (
          <Panel padded={false}>
            <div className="p-5 pb-0">
              <PanelHeader
                eyebrow="Blotter"
                title={`${integer(data.count)} order${data.count === 1 ? '' : 's'}`}
                detail="Routed orders and their risk decision. A refused order never becomes one — /control lists every rejection with the limit that stopped it."
              />
            </div>
            <TableShell className="mt-4">
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
            <div className="p-5 pt-4">
              <ButtonLink href="/control" variant="ghost" size="sm">
                Risk limits and decision history
              </ButtonLink>
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
