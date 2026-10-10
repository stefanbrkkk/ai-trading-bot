/**
 * Alpaca REST adapter.
 *
 * Selected only when both `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` are
 * present, because BUILD_CONTRACT requires API keys to be optional switches and
 * never preconditions: with an empty `.env` the platform routes to the paper
 * broker instead of failing.
 *
 * Endpoints, exactly as named in the compliance mandate's API contracts:
 *   POST   /v2/orders        — order submission, invoked only as the direct
 *                              consequence of a verified client-originated
 *                              request bearing a single-use intent token
 *   GET    /v2/account       — pre-trade buying power and margin
 *   GET    /v2/positions     — position book
 *   DELETE /v2/orders/{id}   — cancellation, used by the Global Kill Switch
 *
 * Nothing in this file throws. Audit field 6 is "the exact acknowledgment
 * receipt, error code, or order ID returned by the broker-dealer (e.g., 200 OK or
 * 503 Service Unavailable)", so the status and the parsed body are returned on
 * every path — including the flash-crash path where the answer is a 503 from a
 * market-wide liquidity halt. A thrown exception would erase precisely the
 * evidence the ledger exists to hold.
 */

import type { AccountSnapshot, OrderStatus, Position } from '@/lib/domain/types';
import {
  NO_HTTP_RESPONSE,
  type BrokerAdapter,
  type BrokerCallContext,
  type BrokerCancelAck,
  type BrokerDescriptor,
  type BrokerMode,
  type BrokerOrderAck,
  type BrokerOrderRequest,
  type BrokerResult,
} from '@/lib/broker/types';

export const ALPACA_KEY_ID_ENV = 'ALPACA_API_KEY_ID';
export const ALPACA_SECRET_ENV = 'ALPACA_API_SECRET_KEY';
export const ALPACA_BASE_URL_ENV = 'ALPACA_BASE_URL';

/** Alpaca's paper trading host — the default when no base URL is configured. */
export const ALPACA_PAPER_BASE_URL = 'https://paper-api.alpaca.markets';

/**
 * PLATFORM POLICY. Outbound timeout. The mandate's litigation stress case is "an
 * API timeout prevents a manually submitted Stop-Loss from reaching the broker in
 * time"; a bounded timeout means that case ends in a recorded, disclosed failure
 * the user is shown, rather than a request hanging until the runtime kills it and
 * the ledger records nothing.
 */
export const ALPACA_TIMEOUT_MS = 10_000;

export interface AlpacaCredentials {
  keyId: string;
  secretKey: string;
  baseUrl?: string;
}

/** Reads credentials from the environment; null when either key is absent. */
export function alpacaCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AlpacaCredentials | null {
  const keyId = env[ALPACA_KEY_ID_ENV];
  const secretKey = env[ALPACA_SECRET_ENV];
  if (keyId === undefined || keyId.length === 0) return null;
  if (secretKey === undefined || secretKey.length === 0) return null;
  const baseUrl = env[ALPACA_BASE_URL_ENV];
  return {
    keyId,
    secretKey,
    baseUrl: baseUrl !== undefined && baseUrl.length > 0 ? baseUrl : ALPACA_PAPER_BASE_URL,
  };
}

export interface AlpacaBrokerOptions {
  credentials: AlpacaCredentials;
  clock?: () => number;
  timeoutMs?: number;
  /** Injected for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toStringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Maps Alpaca's order status vocabulary onto the domain's. */
export function mapAlpacaStatus(status: unknown): OrderStatus {
  switch (status) {
    case 'filled':
      return 'filled';
    case 'partially_filled':
      return 'partially_filled';
    case 'canceled':
    case 'expired':
    case 'done_for_day':
      return 'canceled';
    case 'rejected':
    case 'suspended':
      return 'broker_error';
    default:
      // 'new', 'accepted', 'pending_new', 'held', 'accepted_for_bidding', …
      return 'submitted';
  }
}

/** Alpaca uses `stop_limit` and `stop` verbatim, so only the wire casing differs. */
function orderTypeToWire(type: BrokerOrderRequest['type']): string {
  return type;
}

export class AlpacaBroker implements BrokerAdapter {
  readonly name = 'alpaca' as const;
  readonly mode: BrokerMode;

  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AlpacaBrokerOptions) {
    this.baseUrl = (options.credentials.baseUrl ?? ALPACA_PAPER_BASE_URL).replace(/\/+$/, '');
    // The host distinguishes the sandbox from the live venue. Reported rather
    // than assumed, because the mode is what gates the subscription check.
    // Derive mode from the endpoint host. Checking for a substring lets a
    // live host with a path such as `/paper-api` masquerade as paper while
    // requests still go to live credentials.
    let endpointHost = '';
    try {
      endpointHost = new URL(this.baseUrl).hostname.toLowerCase();
    } catch {
      endpointHost = '';
    }
    this.mode = endpointHost === 'paper-api.alpaca.markets' ? 'paper' : 'live';
    this.headers = {
      'APCA-API-KEY-ID': options.credentials.keyId,
      'APCA-API-SECRET-KEY': options.credentials.secretKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    this.clock = options.clock ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? ALPACA_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  describe(): BrokerDescriptor {
    return {
      name: this.name,
      mode: this.mode,
      endpoint: this.baseUrl,
      supportsCancel: true,
      supportsFractional: true,
    };
  }

  /**
   * Single HTTP round-trip.
   *
   * Returns the status and parsed body whatever happens. A non-JSON body is
   * preserved as `{ raw }` rather than discarded — an HTML error page from a proxy
   * is still the broker's answer, and the ledger has to be able to show it.
   */
  /** A paper request must never reach live credentials, even through a direct adapter call. */
  private accountMismatch<T>(account: 'paper' | 'live'): BrokerResult<T> | null {
    if (account === this.mode) return null;
    return {
      ok: false,
      status: 403,
      body: { code: 'account_mode_mismatch', message: 'The requested account does not match this broker endpoint.' },
      data: null,
      error: 'The requested account does not match this broker endpoint.',
      latencyMs: 0,
      requestPayload: null,
      rawRequest: null,
    };
  }

  private async call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    ctx: BrokerCallContext,
    payload: Record<string, unknown> | null,
  ): Promise<{
    status: number;
    body: Record<string, unknown> | null;
    parsed: unknown;
    error: string | null;
    latencyMs: number;
    rawRequest: string | null;
  }> {
    const start = this.clock();
    const rawRequest = payload === null ? null : JSON.stringify(payload);
    // The kill switch's signal and the timeout both have to be able to abort the
    // request; whichever fires first wins.
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal =
      ctx.signal === undefined ? timeout : AbortSignal.any([ctx.signal, timeout]);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers,
        body: rawRequest === null ? undefined : rawRequest,
        signal,
        cache: 'no-store',
      });
      const text = await response.text();
      let parsed: unknown = null;
      let body: Record<string, unknown> | null = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
          body = isRecord(parsed) ? parsed : { raw: text };
        } catch {
          body = { raw: text };
        }
      }
      return {
        status: response.status,
        body,
        parsed,
        error: null,
        latencyMs: this.clock() - start,
        rawRequest,
      };
    } catch (error) {
      // No HTTP response was received. Reported as NO_HTTP_RESPONSE rather than
      // as a synthesised 5xx, because inventing a status the broker never sent
      // would corrupt the audit record.
      return {
        status: NO_HTTP_RESPONSE,
        body: null,
        parsed: null,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        latencyMs: this.clock() - start,
        rawRequest,
      };
    }
  }

  async submitOrder(
    request: BrokerOrderRequest,
    ctx: BrokerCallContext,
  ): Promise<BrokerResult<BrokerOrderAck>> {
    const mismatch = this.accountMismatch<BrokerOrderAck>(request.account);
    if (mismatch !== null) return mismatch;
    // Parameters are transmitted exactly as the user supplied them. Quantities and
    // prices go out as strings, which is Alpaca's contract and also avoids the
    // float re-formatting that would make the stored payload differ from the wire.
    const payload: Record<string, unknown> = {
      symbol: request.symbol,
      qty: String(request.quantity),
      side: request.side,
      type: orderTypeToWire(request.type),
      time_in_force: request.timeInForce,
      client_order_id: request.clientOrderId,
    };
    if (request.limitPrice !== null) payload.limit_price = String(request.limitPrice);
    if (request.stopPrice !== null) payload.stop_price = String(request.stopPrice);

    const result = await this.call('POST', '/v2/orders', ctx, payload);
    const accepted = result.status >= 200 && result.status < 300 && isRecord(result.body);
    const data: BrokerOrderAck | null = accepted
      ? {
          brokerOrderId: toStringOr((result.body as Record<string, unknown>).id, request.clientOrderId),
          clientOrderId: toStringOr(
            (result.body as Record<string, unknown>).client_order_id,
            request.clientOrderId,
          ),
          status: mapAlpacaStatus((result.body as Record<string, unknown>).status),
          filledQuantity: toNumber((result.body as Record<string, unknown>).filled_qty, 0),
          averageFillPrice: (() => {
            const raw = (result.body as Record<string, unknown>).filled_avg_price;
            if (raw === null || raw === undefined) return null;
            const price = toNumber(raw, 0);
            return price > 0 ? price : null;
          })(),
          acknowledgedAt: ctx.dispatchedAt ?? this.clock(),
        }
      : null;

    return {
      ok: accepted,
      status: result.status,
      body: result.body,
      data,
      error: result.error,
      latencyMs: result.latencyMs,
      requestPayload: payload,
      rawRequest: result.rawRequest,
    };
  }

  async cancelOrder(
    brokerOrderId: string,
    ctx: BrokerCallContext,
  ): Promise<BrokerResult<BrokerCancelAck>> {
    const result = await this.call(
      'DELETE',
      `/v2/orders/${encodeURIComponent(brokerOrderId)}`,
      ctx,
      null,
    );
    // Alpaca answers a successful cancellation with 204 and an empty body.
    const accepted = result.status === 204 || (result.status >= 200 && result.status < 300);
    return {
      ok: accepted,
      status: result.status,
      body: result.body,
      data: accepted
        ? { brokerOrderId, status: 'canceled', canceledAt: ctx.dispatchedAt ?? this.clock() }
        : null,
      error: result.error,
      latencyMs: result.latencyMs,
      requestPayload: null,
      rawRequest: null,
    };
  }

  async getAccount(
    account: 'paper' | 'live',
    ctx: BrokerCallContext,
  ): Promise<BrokerResult<AccountSnapshot>> {
    const mismatch = this.accountMismatch<AccountSnapshot>(account);
    if (mismatch !== null) return mismatch;
    const accountResult = await this.call('GET', '/v2/account', ctx, null);
    if (!(accountResult.status >= 200 && accountResult.status < 300) || !isRecord(accountResult.body)) {
      return {
        ok: false,
        status: accountResult.status,
        body: accountResult.body,
        data: null,
        error: accountResult.error,
        latencyMs: accountResult.latencyMs,
        requestPayload: null,
        rawRequest: null,
      };
    }

    // Positions are fetched too, because `AccountSnapshot` carries them and the
    // risk engine's buying-power check needs the position book to tell a closing
    // sell (which consumes no capital) from a short.
    const positionsResult = await this.getPositions(account, ctx);
    const snapshot = mapAccountSnapshot(
      accountResult.body,
      positionsResult.data ?? [],
      account,
      ctx.dispatchedAt ?? this.clock(),
    );
    return {
      ok: true,
      status: accountResult.status,
      body: accountResult.body,
      data: snapshot,
      error: null,
      latencyMs: accountResult.latencyMs + positionsResult.latencyMs,
      requestPayload: null,
      rawRequest: null,
    };
  }

  async getPositions(
    account: 'paper' | 'live',
    ctx: BrokerCallContext,
  ): Promise<BrokerResult<Position[]>> {
    const mismatch = this.accountMismatch<Position[]>(account);
    if (mismatch !== null) return mismatch;
    const result = await this.call('GET', '/v2/positions', ctx, null);
    const success = result.status >= 200 && result.status < 300;
    const rows = Array.isArray(result.parsed) ? result.parsed : [];
    const positions = success
      ? rows.filter(isRecord).map((row) => mapPosition(row, account))
      : null;
    return {
      ok: success,
      status: result.status,
      // A JSON array is not a record, so the array is wrapped for the ledger while
      // the typed projection carries the rows.
      body: result.body ?? (success ? { positions: rows } : null),
      data: positions,
      error: result.error,
      latencyMs: result.latencyMs,
      requestPayload: null,
      rawRequest: null,
    };
  }
}

/** Projects an Alpaca position row onto the domain type. */
export function mapPosition(row: Record<string, unknown>, account: 'paper' | 'live'): Position {
  const quantity = toNumber(row.qty, 0);
  const averageEntry = toNumber(row.avg_entry_price, 0);
  const marketPrice = toNumber(row.current_price, averageEntry);
  const marketValue = toNumber(row.market_value, quantity * marketPrice);
  const unrealisedPnl = toNumber(row.unrealized_pl, quantity * (marketPrice - averageEntry));
  const denominator = Math.abs(quantity * averageEntry);
  return {
    symbol: toStringOr(row.symbol, ''),
    quantity,
    averageEntry,
    marketPrice,
    marketValue,
    unrealisedPnl,
    unrealisedPnlPercent: toNumber(
      row.unrealized_plpc,
      denominator > 0 ? unrealisedPnl / denominator : 0,
    ),
    // Alpaca reports intraday realised P&L per position only on the activities
    // endpoint, so the snapshot carries zero rather than a fabricated figure.
    realisedPnl: 0,
    openedAt: 0,
    account,
  };
}

/** Projects an Alpaca account payload onto the domain snapshot. */
export function mapAccountSnapshot(
  body: Record<string, unknown>,
  positions: Position[],
  account: 'paper' | 'live',
  atMs: number,
): AccountSnapshot {
  const cash = toNumber(body.cash, 0);
  const equity = toNumber(body.equity, cash);
  const lastEquity = toNumber(body.last_equity, equity);
  const long = toNumber(body.long_market_value, 0);
  const short = toNumber(body.short_market_value, 0);
  return {
    account,
    cash,
    equity,
    // `daytrading_buying_power` is the binding intraday figure for a margin
    // account; the smaller of the two is used so the pre-trade check never
    // approves against capital the broker would refuse.
    buyingPower: Math.min(
      toNumber(body.buying_power, cash),
      toNumber(body.daytrading_buying_power, toNumber(body.buying_power, cash)),
    ),
    grossExposure: Math.abs(long) + Math.abs(short),
    netExposure: long + short,
    maintenanceMargin: toNumber(body.maintenance_margin, 0),
    dayPnl: equity - lastEquity,
    totalPnl: positions.reduce((acc, p) => acc + p.unrealisedPnl, 0),
    positions,
    updatedAt: atMs,
  };
}
