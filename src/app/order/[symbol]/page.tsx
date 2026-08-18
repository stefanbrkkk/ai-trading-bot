/**
 * The order ticket — the only surface in the platform that can reach a broker.
 *
 * Every unusual decision here follows from one rule: the platform must never
 * originate or influence an order. Concretely:
 *
 *   • **Every field starts blank.** Quantity is null, the order type is
 *     unselected. Pre-filling either would make the platform a participant in the
 *     decision — a suggested quantity is a position size, and computing a position
 *     size for a specific user is advice. The published model exposure fraction
 *     exists on the attribution page and is deliberately not readable from here.
 *
 *   • **Two clicks, and the first one authorises nothing.** Pre-flight evaluates
 *     the risk controls and shows the result; it reserves nothing and mints
 *     nothing. Routing requires a second, physical click on Execute, which is the
 *     click whose coordinates and millisecond are captured and sent.
 *
 *   • **The authorisation is minted from what is already typed.** The intent token
 *     is bound to this symbol, side, quantity and order type. It cannot authorise
 *     a different quantity, and it is single-use — so a double-submit under
 *     latency is refused rather than duplicated.
 *
 *   • **Rejection copy is the server's.** A risk rejection arrives with a code and
 *     a mandated message, and both are rendered verbatim. Composing friendlier
 *     wording client-side would replace compliance-relevant text with marketing.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader, PageShell } from '@/components/PageState';
import {
  Badge,
  Button,
  ButtonLink,
  DataRow,
  Divider,
  Field,
  INPUT_CLASS,
  Notice,
  Panel,
  PanelHeader,
  SELECT_CLASS,
  StatGrid,
  StatTile,
  cx,
} from '@/components/ui/primitives';
import { ApiRequestError, clickProvenance, request, useApi, type MeResponse } from '@/lib/ui/api';
import { duration, integer, money, price } from '@/lib/ui/format';
import { getSpec } from '@/lib/market/universe';

interface RiskCheck {
  code: string | null;
  passed: boolean;
  message: string;
  check: string;
  observed: number | null;
  limit: number | null;
}

interface Quote {
  symbol: string;
  timestamp: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  last: number;
  volume: number;
  previousClose: number;
}

interface PreflightResponse {
  allowed: boolean;
  checks: RiskCheck[];
  firstFailure: { code: string; message: string; check: string; observed: number | null; limit: number | null } | null;
  notionalUsd: number | null;
  notionalReferencePrice: number | null;
  quote: Quote | null;
  adv30: number;
  maxQuantityForAdv: number | null;
  buyingPower: number | null;
  equity: number | null;
  accountError: string | null;
  entitlement: { paper: boolean; live: boolean; reason: string };
  limits: { code: string; label: string; value: number; unit: string; rationale: string }[];
  sizingNotice: string;
}

interface RouteResponse {
  routed: boolean;
  orderId?: string;
  brokerOrderId?: string | null;
  status?: string;
  filledQuantity?: number;
  averageFillPrice?: number | null;
  brokerStatus?: number | null;
  latencyMs?: number;
  notionalUsd?: number | null;
  code?: string;
  message?: string;
  check?: string | null;
  timestamps?: {
    clientClick: number;
    serverReceived: number;
    riskCompleted: number;
    brokerDispatched: number;
    brokerAcknowledged: number | null;
  };
}

type OrderType = '' | 'market' | 'limit' | 'stop' | 'stop_limit';

export default function OrderTicketPage() {
  const params = useParams<{ symbol: string }>();
  const symbol = (params.symbol ?? '').toUpperCase();

  const me = useApi<MeResponse>('/auth/me');

  /**
   * Blank initial state, and it stays blank.
   *
   * `quantity` is a string rather than a number so an empty input is genuinely
   * empty. Using `0` as the empty value would put a number in the field the user
   * did not type, which is exactly what the blank-field mandate forbids.
   */
  const [quantity, setQuantity] = useState('');
  const [orderType, setOrderType] = useState<OrderType>('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [limitPrice, setLimitPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [timeInForce, setTimeInForce] = useState<'day' | 'gtc' | 'ioc' | 'fok'>('day');
  const [account, setAccount] = useState<'paper' | 'live'>('paper');

  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const [routed, setRouted] = useState<RouteResponse | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routing, setRouting] = useState(false);

  const parsedQuantity = /^\d+$/.test(quantity) ? Number(quantity) : null;
  const ready = parsedQuantity !== null && parsedQuantity > 0 && orderType !== '';

  /**
   * Any change to a parameter invalidates a completed pre-flight.
   *
   * Without this, a user could pre-flight 100 shares, change the field to 10,000,
   * and see a stale "approved" banner above the Execute button. The order would
   * still be rejected server-side, but the screen would have told them otherwise —
   * and a UI that contradicts the control it is reporting on is worse than one
   * that shows nothing.
   */
  useEffect(() => {
    setPreflight(null);
    setPreflightError(null);
    setRouted(null);
    setRouteError(null);
  }, [quantity, orderType, side, limitPrice, stopPrice, timeInForce, account]);

  const runPreflight = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
      if (!ready || checking) return;
      setChecking(true);
      setPreflightError(null);
      try {
        setPreflight(
          await request<PreflightResponse>('/orders/preflight', {
            method: 'POST',
            body: {
              symbol,
              side,
              quantity: parsedQuantity,
              orderType,
              limitPrice: limitPrice.length > 0 ? Number(limitPrice) : null,
              stopPrice: stopPrice.length > 0 ? Number(stopPrice) : null,
              timeInForce,
              account,
              click: clickProvenance(event.nativeEvent, 'preflight-button'),
            },
          }),
        );
      } catch (cause) {
        setPreflightError(cause instanceof ApiRequestError ? cause.message : 'The pre-flight check failed.');
      } finally {
        setChecking(false);
      }
    },
    [ready, checking, symbol, side, parsedQuantity, orderType, limitPrice, stopPrice, timeInForce, account],
  );

  /**
   * Mints the authorisation and routes, in that order, from one click.
   *
   * Both requests carry the *same* click provenance object, captured once from this
   * event. That is what makes the ledger's claim true: the token's mint timestamp
   * and the order's click timestamp are the same millisecond because they came from
   * the same physical gesture, rather than from two calls to `Date.now()`.
   */
  async function execute(event: React.MouseEvent<HTMLButtonElement>): Promise<void> {
    if (!ready || routing || preflight?.allowed !== true) return;
    setRouting(true);
    setRouteError(null);
    setRouted(null);

    const click = clickProvenance(event.nativeEvent, 'execute-button');

    try {
      const minted = await request<{ intentToken: string }>('/intent', {
        method: 'POST',
        body: {
          symbol,
          side,
          quantity: parsedQuantity,
          orderType,
          account,
          clickTsMs: click.clickedAt,
          click,
        },
      });

      setRouted(
        await request<RouteResponse>('/orders/submit', {
          method: 'POST',
          body: {
            symbol,
            side,
            quantity: parsedQuantity,
            orderType,
            limitPrice: limitPrice.length > 0 ? Number(limitPrice) : null,
            stopPrice: stopPrice.length > 0 ? Number(stopPrice) : null,
            timeInForce,
            account,
            intentToken: minted.intentToken,
            click,
          },
        }),
      );
    } catch (cause) {
      /**
       * A risk rejection is a 422 whose body *is* the answer, so it is surfaced as
       * a result rather than an error. Only a genuine failure — unauthenticated,
       * kill switch, network — becomes `routeError`.
       */
      if (cause instanceof ApiRequestError && cause.status === 422) {
        setRouted({ routed: false, code: cause.code, message: cause.message });
      } else {
        setRouteError(cause instanceof ApiRequestError ? cause.message : 'The order could not be transmitted.');
      }
    } finally {
      setRouting(false);
    }
  }

  const signedIn = me.data?.user !== null && me.data?.user !== undefined;
  const liveAllowed = me.data?.entitlement.live === true;

  /*
   * An unknown symbol gets a refusal, not a ticket.
   *
   * /order/ZZZZ rendered a complete, live order form — four selects, a quantity
   * field, pre-trade checks and Execute — for a security that does not exist. Every
   * request it could send would be rejected, but the page said nothing until the
   * user had filled it in and clicked, and /terminal/ZZZZ has always refused
   * outright. The universe is a published table, so the check is local and needs
   * no request.
   */
  if (getSpec(symbol) === undefined) {
    return (
      <PageShell>
        <PageHeader
          eyebrow={`${symbol} · order ticket`}
          title="Not a tradable symbol"
          lede={`${symbol} is not in the published universe, so no order ticket exists for it.`}
        />
        <Notice tone="warning" title="Unknown symbol">
          Aurelius publishes analysis for a fixed universe. Open the screener for the names it covers.
          <span className="mt-3 block">
            <ButtonLink href="/screener" variant="ghost" size="sm">
              Browse the universe
            </ButtonLink>
          </span>
        </Notice>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        eyebrow={`${symbol} · order ticket`}
        title="Route an order"
        lede="Quantity and order type start blank and stay blank until you set them. This platform does not compute a position size, suggest a quantity or pre-select an order type. Side, time in force and account carry conventional defaults you can see and change; nothing about them is derived from your account or from a model output."
        action={
          <ButtonLink href={`/terminal/${symbol}`} variant="ghost" size="sm">
            Back to attribution
          </ButtonLink>
        }
      />

      {!signedIn ? (
        <Notice tone="warning" title="Not signed in" className="mb-6">
          An order is routed against an account.{' '}
          <Link href="/login" className="text-gold underline decoration-gold/40">
            Sign in
          </Link>{' '}
          first.
        </Notice>
      ) : null}

      {/*
        The results column is reserved only once there is a result.
        Reserved unconditionally, a 1024px viewport gave the ticket 384px and left
        412px of the page blank next to it — every form control dropped from 451px
        to 163px for a one-pixel viewport gain, before the user had done anything.
        The aside appears when pre-flight produces something to put in it.
      */}
      <div
        className={cx(
          'grid grid-cols-1 gap-5',
          preflight !== null ? 'xl:grid-cols-[minmax(0,1fr)_minmax(0,360px)]' : 'xl:grid-cols-1',
        )}
      >
        <div className="space-y-5">
          <Panel>
            <PanelHeader eyebrow="Parameters" title="You specify every field" />

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Side" required>
                <select
                  className={SELECT_CLASS}
                  value={side}
                  onChange={(e) => setSide(e.target.value === 'sell' ? 'sell' : 'buy')}
                >
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                </select>
              </Field>

              <Field
                label="Order type"
                required
                hint="Deliberately unselected. The platform does not choose an order type for you."
              >
                <select
                  className={SELECT_CLASS}
                  value={orderType}
                  onChange={(e) => setOrderType(e.target.value as OrderType)}
                >
                  <option value="">Select an order type…</option>
                  <option value="market">Market</option>
                  <option value="limit">Limit</option>
                  <option value="stop">Stop</option>
                  <option value="stop_limit">Stop limit</option>
                </select>
              </Field>

              <Field label="Quantity (shares)" required hint="Whole shares. There is no suggested value.">
                <input
                  className={INPUT_CLASS}
                  type="text"
                  inputMode="numeric"
                  value={quantity}
                  placeholder=""
                  maxLength={9}
                  onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ''))}
                />
              </Field>

              <Field label="Time in force">
                <select
                  className={SELECT_CLASS}
                  value={timeInForce}
                  onChange={(e) => setTimeInForce(e.target.value as 'day' | 'gtc' | 'ioc' | 'fok')}
                >
                  <option value="day">Day</option>
                  <option value="gtc">Good till cancelled</option>
                  <option value="ioc">Immediate or cancel</option>
                  <option value="fok">Fill or kill</option>
                </select>
              </Field>

              {orderType === 'limit' || orderType === 'stop_limit' ? (
                <Field label="Limit price" required>
                  <input
                    className={INPUT_CLASS}
                    type="text"
                    inputMode="decimal"
                    value={limitPrice}
                    onChange={(e) => setLimitPrice(e.target.value.replace(/[^\d.]/g, ''))}
                  />
                </Field>
              ) : null}

              {orderType === 'stop' || orderType === 'stop_limit' ? (
                <Field label="Stop price" required>
                  <input
                    className={INPUT_CLASS}
                    type="text"
                    inputMode="decimal"
                    value={stopPrice}
                    onChange={(e) => setStopPrice(e.target.value.replace(/[^\d.]/g, ''))}
                  />
                </Field>
              ) : null}

              <Field
                label="Account"
                required
                hint={liveAllowed ? undefined : 'Live routing requires an active subscription and an explicit unlock.'}
              >
                <select
                  className={SELECT_CLASS}
                  value={account}
                  onChange={(e) => setAccount(e.target.value === 'live' ? 'live' : 'paper')}
                >
                  <option value="paper">Paper sandbox</option>
                  <option value="live" disabled={!liveAllowed}>
                    Live{liveAllowed ? '' : ' (not enabled)'}
                  </option>
                </select>
              </Field>
            </div>

            <Divider className="my-5" />

            <div className="flex flex-wrap items-center gap-3">
              <Button
                id="preflight-button"
                variant="default"
                size="lg"
                disabled={!ready || checking || !signedIn}
                onClick={runPreflight}
              >
                {checking ? 'Checking…' : 'Run pre-trade checks'}
              </Button>
              <Button
                id="execute-button"
                variant="primary"
                size="lg"
                disabled={preflight?.allowed !== true || routing || !signedIn}
                onClick={execute}
              >
                {routing ? 'Transmitting…' : 'Execute'}
              </Button>
              {!ready ? (
                <p className="text-[0.75rem] text-parchment-faint">
                  Enter a quantity and select an order type to enable the checks.
                </p>
              ) : preflight === null ? (
                <p className="text-[0.75rem] text-parchment-faint">
                  Run the pre-trade checks before Execute becomes available.
                </p>
              ) : null}
            </div>

            <p className="mt-4 text-[0.75rem] leading-relaxed text-parchment-faint">
              Pre-flight reserves nothing and authorises nothing. Execute captures the coordinates and millisecond of
              your click, mints a single-use authorisation bound to exactly these parameters, and transmits once.
            </p>
          </Panel>

          {preflightError !== null ? (
            <Notice tone="error" title="Pre-flight failed">
              {preflightError}
            </Notice>
          ) : null}

          {preflight !== null ? (
            <Panel>
              <PanelHeader
                eyebrow="Pre-trade controls"
                title={preflight.allowed ? 'All checks passed' : 'The order would be rejected'}
                action={<Badge tone={preflight.allowed ? 'sage' : 'burgundy'}>{preflight.allowed ? 'clear' : 'blocked'}</Badge>}
              />

              {preflight.firstFailure !== null ? (
                <Notice tone="error" title={preflight.firstFailure.code} className="mt-4">
                  {/* The mandated rejection copy, verbatim. */}
                  {preflight.firstFailure.message}
                </Notice>
              ) : null}

              <ul className="mt-4 space-y-2">
                {preflight.checks.map((check) => (
                  <li key={check.check} className="flex items-start gap-3">
                    <Badge tone={check.passed ? 'sage' : 'burgundy'}>{check.passed ? 'pass' : 'fail'}</Badge>
                    <div className="min-w-0">
                      <p className="font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
                        {check.check.replace(/_/g, ' ')}
                      </p>
                      <p className="text-[0.8125rem] leading-snug text-parchment-dim">{check.message}</p>
                    </div>
                  </li>
                ))}
              </ul>

              {preflight.accountError !== null ? (
                <Notice tone="warning" className="mt-4">
                  {preflight.accountError}
                </Notice>
              ) : null}
            </Panel>
          ) : null}

          {routeError !== null ? (
            <Notice tone="error" title="Transmission failed">
              {routeError}
            </Notice>
          ) : null}

          {routed !== null ? (
            <Panel>
              <PanelHeader
                eyebrow="Result"
                title={routed.routed ? 'Order transmitted' : 'Order not transmitted'}
                action={<Badge tone={routed.routed ? 'sage' : 'burgundy'}>{routed.routed ? 'routed' : routed.code}</Badge>}
              />

              {!routed.routed ? (
                <Notice tone="error" className="mt-4" title={routed.code}>
                  {/* Server copy, unmodified. */}
                  {routed.message}
                </Notice>
              ) : (
                <>
                  <dl className="mt-4 space-y-0.5">
                    <DataRow label="Order id" value={routed.orderId ?? '—'} />
                    <DataRow label="Broker order id" value={routed.brokerOrderId ?? '—'} />
                    <DataRow label="Status" value={routed.status ?? '—'} />
                    <DataRow label="Filled" value={integer(routed.filledQuantity ?? 0)} />
                    <DataRow
                      label="Average fill"
                      value={routed.averageFillPrice === null || routed.averageFillPrice === undefined ? '—' : price(routed.averageFillPrice)}
                    />
                    <DataRow
                      label="Notional"
                      value={routed.notionalUsd === null || routed.notionalUsd === undefined ? '—' : money(routed.notionalUsd)}
                    />
                  </dl>

                  {routed.timestamps !== undefined ? (
                    <>
                      <Divider className="my-4" />
                      <p className="eyebrow mb-2.5">Click → broker acknowledgement</p>
                      <dl className="space-y-0.5">
                        <DataRow
                          label="Click to server"
                          value={duration(routed.timestamps.serverReceived - routed.timestamps.clientClick)}
                        />
                        <DataRow
                          label="Risk evaluation"
                          value={duration(routed.timestamps.riskCompleted - routed.timestamps.serverReceived)}
                        />
                        <DataRow
                          label="Broker acknowledgement"
                          value={
                            routed.timestamps.brokerAcknowledged === null
                              ? 'no acknowledgement'
                              : duration(routed.timestamps.brokerAcknowledged - routed.timestamps.brokerDispatched)
                          }
                        />
                      </dl>
                    </>
                  ) : null}

                  <div className="mt-5">
                    <ButtonLink href="/portfolio" variant="ghost" size="sm">
                      View in the blotter
                    </ButtonLink>
                  </div>
                </>
              )}
            </Panel>
          ) : null}
        </div>

        {/* ── Market context ─────────────────────────────────────────── */}
        <div className="space-y-5">
          {preflight?.quote !== null && preflight?.quote !== undefined ? (
            <Panel>
              <PanelHeader eyebrow="Reference quote" title={preflight.quote.symbol} />
              <StatGrid className="mt-4" columns={2}>
                <StatTile label="Bid" value={price(preflight.quote.bid)} footnote={`${integer(preflight.quote.bidSize)} sh`} />
                <StatTile label="Ask" value={price(preflight.quote.ask)} footnote={`${integer(preflight.quote.askSize)} sh`} />
                <StatTile label="Last" value={price(preflight.quote.last)} />
                <StatTile
                  label="Notional"
                  value={preflight.notionalUsd === null ? '—' : money(preflight.notionalUsd, { whole: true })}
                  tone="gold"
                />
              </StatGrid>
              <Divider className="my-4" />
              {/*
                Top of book only, as tiles. A DepthLadder is deliberately not drawn
                here: pre-flight returns the NBBO, not the L10 book, and rendering a
                one-level ladder would present a single quote as market depth. The
                full ladder is on the attribution page, under "Order flow", drawn
                from the same depth snapshot the MLOFI vector was computed from.
              */}
              {/*
                The caption used to say the notional was computed against the NBBO
                when a priced order computes it against the user's own limit —
                12 x 289.50 displayed as $3,474 beside "Reference NBBO at 288.90",
                two figures that cannot both be right. It now names the price it
                actually used, and states that the ceiling is tested against the
                worse of that and the book.
              */}
              <p className="text-[0.75rem] leading-relaxed text-parchment-faint">
                Notional priced at {price(preflight.notionalReferencePrice ?? preflight.quote.last)}
                {preflight.notionalReferencePrice !== null &&
                preflight.notionalReferencePrice !== preflight.quote.last
                  ? ' (your limit)'
                  : ' (last trade)'}
                . NBBO {price(preflight.quote.bid)} / {price(preflight.quote.ask)}, spread{' '}
                {price(preflight.quote.ask - preflight.quote.bid)}. The fat-finger ceiling is tested against the
                worse of that price and the side of the book a marketable order would reach.
              </p>
            </Panel>
          ) : null}

          {preflight !== null ? (
            <Panel>
              <PanelHeader
                eyebrow="Published limits"
                title="What can stop this order"
                detail="Fixed, published thresholds. They apply identically to every account."
              />
              <dl className="mt-3 space-y-0.5">
                {preflight.limits.slice(0, 8).map((limit) => (
                  <DataRow
                    key={limit.code}
                    label={limit.label}
                    value={formatLimit(limit.value, limit.unit)}
                    hint={limit.rationale}
                  />
                ))}
              </dl>
              <Divider className="my-4" />
              <Notice tone="legal">{preflight.sizingNotice}</Notice>
            </Panel>
          ) : null}
        </div>
      </div>
    </PageShell>
  );
}

/** Renders a limit in its declared unit. */
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
      return `${integer(value)}d`;
    case 'milliseconds':
      return duration(value);
    default:
      return String(value);
  }
}
