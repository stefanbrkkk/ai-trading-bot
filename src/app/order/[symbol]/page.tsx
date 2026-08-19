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
import { useActiveSymbol } from '@/components/TerminalProvider';
import { Announce, PageHeader, PageShell } from '@/components/PageState';
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
import type { RiskLimitUnit } from '@/lib/risk/limits';

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
  limits: { code: string; label: string; value: number; unit: RiskLimitUnit; rationale: string }[];
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

/**
 * How long a price field may get.
 *
 * The quantity field has been capped at nine characters since it was written;
 * the two price fields were not capped at all, and an uncapped price is how a
 * mathematical symbol reached the mandated rejection copy. 305 digits in the
 * limit field against a nine-digit quantity overflowed the notional inside the
 * risk engine to `Infinity`, and `formatUsd` handed that to `toLocaleString`,
 * which renders it "∞" — so the page published "Order notional of $∞ exceeds the
 * per-order ceiling of $100,000.00.", three times, while the Notional tile in
 * the same view read "—" because `JSON.stringify` had turned the same Infinity
 * into null. Twenty-two digits was enough for the softer version of the same
 * fault: `toFixed` switches to exponential at 1e21, so the reference-price
 * sentence read "Notional priced at 1.1111111111111111e+21 (your limit)".
 *
 * Twelve digits times a nine-digit quantity is under 1e21, so neither the
 * overflow nor the exponential notation is reachable from this form any more.
 * The order was refused correctly in every one of those cases — this was always
 * display copy — but copy is the product here, and "$∞" is not a price.
 */
const PRICE_MAX_LENGTH = 12;

/**
 * Keeps a price field to digits and at most one decimal point.
 *
 * The filter was `replace(/[^\d.]/g, '')`, which happily accepted "1.2.3" —
 * `Number('1.2.3')` is NaN, `JSON.stringify` sends null, and the server answered
 * the well-formed "Enter a limit price." for a field the user could see they had
 * filled in. Dropping the second point at the keystroke keeps the field and the
 * value it stands for the same thing.
 */
function priceInput(value: string): string {
  const digitsAndPoints = value.replace(/[^\d.]/g, '');
  const first = digitsAndPoints.indexOf('.');
  if (first === -1) return digitsAndPoints;
  return digitsAndPoints.slice(0, first + 1) + digitsAndPoints.slice(first + 1).replace(/\./g, '');
}

export default function OrderTicketPage() {
  const params = useParams<{ symbol: string }>();
  /**
   * Clamped to the same 12 characters the order APIs already enforce.
   *
   * `/api/orders/preflight`, `/api/orders/submit` and `/api/intent` all bound the
   * symbol at `z.string().min(1).max(12)`, and the unknown-symbol refusal below
   * echoes this value into an eyebrow and a lede. Unclamped, 300 characters in
   * the URL rendered as one unbreakable word 2959px long: the document measured
   * 3187px at a 1440px viewport and the entire page scrolled sideways, `max-w-2xl`
   * on the lede notwithstanding — a run with no spaces in it has no break
   * opportunity to take. The published universe tops out at five characters, so
   * nothing legitimate is truncated, and the client now refuses at the same
   * length the server does rather than at a second one.
   */
  const symbol = (params.symbol ?? '').toUpperCase().slice(0, 12);
  // Publishes the symbol to the terminal store, so the footer's FOCUS field
  // names what this route is showing instead of reading NONE.
  useActiveSymbol(symbol);

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
  /**
   * The idempotency key this ticket will route under.
   *
   * IDEMPOTENCY is one of the pre-trade controls the ticket displays, and it read
   * PASS on every order while being unable to fire: the route minted a fresh
   * random key per request when the caller sent none, and a fresh random key
   * cannot collide with anything. The control was armed with a value guaranteed
   * to pass.
   *
   * Minted here instead, once per authorising pre-flight, and cleared by the same
   * effect that invalidates the pre-flight when any ticket field changes. So a
   * second click on an unchanged, already-routed ticket — the double-submit this
   * control exists to catch — carries the key the first click used and is
   * refused DUPLICATE_ORDER, while a genuinely different order carries a new one.
   */
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
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
    setIdempotencyKey(null);
  }, [quantity, orderType, side, limitPrice, stopPrice, timeInForce, account]);

  const runPreflight = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
      if (!ready || checking) return;
      setChecking(true);
      setPreflightError(null);
      // A new authorisation, so a new key. `crypto.randomUUID` is available in
      // every browser this product supports and in the E2E runtime.
      setIdempotencyKey(`ord_${crypto.randomUUID()}`);
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
            ...(idempotencyKey === null ? {} : { idempotencyKey }),
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
  // Read only by the RESULT panel below, which renders only once `routed` is
  // set; computed here so the label, the figure and the sentence explaining
  // them all come out of one call and cannot drift apart.
  const receipt = fillReceiptNotional(
    routed?.filledQuantity ?? 0,
    routed?.averageFillPrice ?? null,
    routed?.notionalUsd ?? null,
  );

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
                    maxLength={PRICE_MAX_LENGTH}
                    onChange={(e) => setLimitPrice(priceInput(e.target.value))}
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
                    maxLength={PRICE_MAX_LENGTH}
                    onChange={(e) => setStopPrice(priceInput(e.target.value))}
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

            {/*
              In-flight is `busy`, never `disabled`.

              Both buttons used to fold the request flag into `disabled`, which is
              the exact case the Button primitive documents and exists to prevent:
              `disabled` on the element that currently has focus hands focus to
              `<body>`. Measured on both — focus the button, press Enter, and
              `document.activeElement` was BODY from 30 ms right through to the
              end of the request and past it, because React clears the attribute
              15 ms after the blur and nothing puts focus back. A keyboard user
              lost their place in the middle of routing an order, and a screen
              reader stopped narrating the control it was on. `busy` keeps the
              element focusable, marks it `aria-disabled`/`aria-busy`, swallows
              the activation and dims it identically, so focus survives the round
              trip. `disabled` stays for the genuinely unavailable cases — an
              incomplete form, no session, no pre-flight — where nobody is focused
              on the control at the moment it flips.
            */}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                id="preflight-button"
                variant="default"
                size="lg"
                busy={checking}
                disabled={!ready || !signedIn}
                onClick={runPreflight}
              >
                {checking ? 'Checking…' : 'Run pre-trade checks'}
              </Button>
              <Button
                id="execute-button"
                variant="primary"
                size="lg"
                busy={routing}
                disabled={preflight?.allowed !== true || !signedIn}
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

              {/*
                The outcome, out loud.

                A rejection announces itself — `Notice tone="error"` carries
                `role="alert"`, and it is the only live region this page had. A
                pass announced nothing at all: the panel simply appeared, with
                focus still where the click left it, so the one result a reader
                waited for was the one the platform said nothing about. Announcing
                the heading rather than the whole panel keeps the alert's mandated
                copy the thing that carries the reason.
              */}
              <Announce>
                {preflight.allowed
                  ? 'Pre-trade checks passed. Execute is now available.'
                  : 'The order would be rejected. See the pre-trade controls for the check that stopped it.'}
              </Announce>

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

              {/*
                The one outcome in the product that must never be silent. A
                transmitted order has reached a broker, and until this the page
                reported that by changing a heading nothing was announcing and
                nothing was focused on. The order id goes into the announcement
                because it is the only handle the reader has on what was just
                sent.
              */}
              <Announce>
                {routed.routed
                  ? `Order transmitted. Order id ${routed.orderId ?? 'unavailable'}.`
                  : 'Order not transmitted.'}
              </Announce>

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
                    <DataRow label={receipt.label} value={receipt.value} />
                  </dl>

                  <p className="mt-3 text-[0.75rem] leading-relaxed text-parchment-faint">{receipt.caption}</p>

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

/**
 * The notional the fill receipt publishes, and the sentence that names it.
 *
 * This row rendered `routed.notionalUsd` under a bare "Notional" label, two rows
 * beneath the average fill price it contradicted. That figure is the *pre-trade*
 * notional: `POST /api/orders/submit` prices it at `notionalReferencePrice`,
 * which for a priced order is the user's own limit verbatim — deliberately, and
 * correctly, because someone who typed 148.00 is owed a ceiling tested at
 * 148.00. It is the wrong number to put on a receipt. Measured against the paper
 * broker at 11:00 New York with AAPL 141.21 / 141.23: BUY 50 limit 148.00 fills
 * 50 at 141.26 and takes $7,063.00 out of the account, while this row read
 * $7,400.00 — 4.8% over, directly under an "Average fill" of 141.26 that was
 * right. The collar is tiered at 20% under $25, so on a cheap name the same row
 * can be a fifth out.
 *
 * The ticket has already resolved this exact ambiguity once, for the
 * reference-quote tile in the market-context column, and the resolution was to
 * name the price the figure was computed at rather than to drop the figure. So a
 * filled order now publishes what the fill cost — filled quantity at the average
 * fill price, the number the cash balance moved by — and an order that has not
 * filled keeps the pre-trade notional, which is the only figure that exists yet,
 * labelled as such. Both arms carry a caption saying which of the two the reader
 * is looking at. The risk engine and the daily quota are untouched: they go on
 * measuring every ceiling at the conservative pre-trade price.
 */
function fillReceiptNotional(
  filledQuantity: number,
  averageFillPrice: number | null,
  orderNotionalUsd: number | null,
): { label: string; value: string; caption: string } {
  if (filledQuantity > 0 && averageFillPrice !== null && Number.isFinite(averageFillPrice)) {
    return {
      label: 'Notional filled',
      value: money(filledQuantity * averageFillPrice),
      caption:
        'Notional filled is the filled quantity at the average fill price above — the amount the cash balance moved by. The pre-trade figure, priced at your own limit or stop, or at the last trade for a market order, is the one in the reference-quote panel, and the two differ whenever the order did not fill at that price.',
    };
  }
  return {
    label: 'Order notional',
    value: orderNotionalUsd === null ? '—' : money(orderNotionalUsd),
    caption:
      'Nothing has filled, so this is the order priced at the reference price the ticket quoted — your own limit or stop, or the last trade for a market order. It is not an amount the account has been charged.',
  };
}

/**
 * Renders a limit in its declared unit.
 *
 * Kept arm for arm — and character for character — with the copy on /control.
 * `/api/orders/preflight` and `/api/risk/limits` both return
 * `RISK_LIMIT_DESCRIPTORS` verbatim, so the eight rows this panel renders are
 * eight of the twelve that page renders, out of one array. The two copies had
 * drifted twice regardless. `messages_per_second` matched no case in either, so
 * ORDER_MESSAGE_RATE fell through a `default: return String(value)` and printed
 * as a bare "5" on both surfaces; and ADV_LOOKBACK read "30d" here against
 * "30 d" there — one published number in two shapes, for no reason but two
 * hand-written copies of one formatter.
 *
 * `unit` is the descriptor union rather than `string` now, and there is no
 * catch-all, so a unit that is renamed or added upstream stops the compile
 * instead of quietly rendering unitless. The duplication itself remains: these
 * two switches are still two copies, and the honest repair is one formatter in
 * `@/lib/ui/format` that both import.
 */
function formatLimit(value: number, unit: RiskLimitUnit): string {
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
    case 'messages_per_second':
      return `${integer(value)}/s`;
    case 'http_status':
      // A status code is a label, not a quantity: it takes no unit suffix, and
      // no thousands separator either.
      return String(value);
  }
}
