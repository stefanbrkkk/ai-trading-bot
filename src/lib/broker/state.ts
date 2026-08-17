/**
 * Durable state for the paper broker.
 *
 * `InMemoryBrokerState` is correct and is the right default for tests, but it is
 * the wrong thing to run an application on. The symptom is specific and was
 * observed: an order fills, the response reports `filled` with a price, and a
 * moment later the account shows no position and the original cash balance. The
 * fill was real; the bookkeeping lived in a module-scope `Map`, and the module was
 * re-evaluated — by a dev-server hot reload, a new serverless invocation, or a
 * process restart — between the fill and the next read. Nothing errored, which is
 * what made it dangerous: a sandbox that silently forgets trades teaches a user
 * that their strategy did something it did not do.
 *
 * The state therefore goes in the append-only ledger. That choice does more than
 * make it durable:
 *
 *   • The ledger is bitemporal, so the paper account acquires a full history for
 *     free. "What was my sandbox balance before that trade" becomes answerable by
 *     the same reconstruction endpoint that serves order forensics, rather than
 *     needing its own mechanism.
 *   • The append-only triggers mean a sandbox balance cannot be quietly rewritten.
 *     A paper account is where a user forms beliefs about a strategy, so its
 *     history deserves the same immutability as a real one.
 *
 * Reads are memoised per process because the paper broker calls `loadAccount`
 * on every quote refresh, and a reconstruction is a query plus a JSON parse. The
 * cache is write-through and keyed on the same identity as the ledger facet, so it
 * cannot serve a value the ledger disagrees with.
 */

import {
  history,
  reconstruct,
  writeSnapshot,
  type JsonValue,
} from '@/lib/db';
import type {
  BrokerStatePort,
  PaperAccountState,
  PaperOrderRecord,
  PaperPositionState,
} from '@/lib/broker/types';
import type { OrderSide, OrderStatus, OrderType, TimeInForce } from '@/lib/domain/types';

const BROKER_SPIFFE_ID = 'spiffe://aurelius.local/ns/trading/sa/paper-broker';

const ACCOUNT_KIND = 'paper_account';
const ACCOUNT_FACET = 'state';
const ORDER_KIND = 'paper_order';
const ORDER_FACET = 'record';
/** Per-user index of broker order ids, so `listOrders` needs no table scan. */
const INDEX_KIND = 'paper_order_index';
const INDEX_FACET = 'ids';

function accountId(account: 'paper' | 'live', userId: string): string {
  return `${account}:${userId}`;
}

/** Narrows a reconstructed facet to a plain object, or null. */
function asObject(value: JsonValue | null): Record<string, JsonValue> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null;
}

function num(source: Record<string, JsonValue>, key: string, fallback = 0): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(source: Record<string, JsonValue>, key: string, fallback = ''): string {
  const value = source[key];
  return typeof value === 'string' ? value : fallback;
}

function numOrNull(source: Record<string, JsonValue>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Rehydrates an account.
 *
 * Every field is read defensively rather than by cast. A facet written by an
 * earlier version of this file is still in the ledger — that is the point of an
 * append-only store — so a missing field must degrade to a sane default instead of
 * producing `undefined` cash and a NaN equity that propagates into a risk check.
 */
function accountFromJson(raw: Record<string, JsonValue>): PaperAccountState {
  const rawPositions = raw.positions;
  const positions: PaperPositionState[] = Array.isArray(rawPositions)
    ? rawPositions.flatMap((entry) => {
        const position = asObject(entry);
        if (position === null) return [];
        return [
          {
            symbol: str(position, 'symbol'),
            quantity: num(position, 'quantity'),
            averageEntry: num(position, 'averageEntry'),
            realisedPnl: num(position, 'realisedPnl'),
            openedAt: num(position, 'openedAt'),
          },
        ];
      })
    : [];

  return {
    account: str(raw, 'account') === 'live' ? 'live' : 'paper',
    cash: num(raw, 'cash'),
    realisedPnl: num(raw, 'realisedPnl'),
    positions,
    dayKey: str(raw, 'dayKey'),
    dayStartEquity: num(raw, 'dayStartEquity'),
  };
}

function orderFromJson(raw: Record<string, JsonValue>): PaperOrderRecord {
  return {
    brokerOrderId: str(raw, 'brokerOrderId'),
    clientOrderId: str(raw, 'clientOrderId'),
    account: str(raw, 'account') === 'live' ? 'live' : 'paper',
    userId: str(raw, 'userId'),
    symbol: str(raw, 'symbol'),
    side: str(raw, 'side', 'buy') as OrderSide,
    type: str(raw, 'type', 'market') as OrderType,
    quantity: num(raw, 'quantity'),
    filledQuantity: num(raw, 'filledQuantity'),
    averageFillPrice: numOrNull(raw, 'averageFillPrice'),
    limitPrice: numOrNull(raw, 'limitPrice'),
    stopPrice: numOrNull(raw, 'stopPrice'),
    timeInForce: str(raw, 'timeInForce', 'day') as TimeInForce,
    status: str(raw, 'status', 'pending_risk') as OrderStatus,
    submittedAt: num(raw, 'submittedAt'),
    updatedAt: num(raw, 'updatedAt'),
    slippageBps: num(raw, 'slippageBps'),
  };
}

/** Structural clone through JSON, which is also the ledger's storage form. */
function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export class LedgerBrokerState implements BrokerStatePort {
  private readonly accounts = new Map<string, PaperAccountState>();
  private readonly orders = new Map<string, PaperOrderRecord>();
  private readonly indexes = new Map<string, string[]>();

  loadAccount(account: 'paper' | 'live', userId: string): PaperAccountState | null {
    const key = accountId(account, userId);
    const cached = this.accounts.get(key);
    if (cached !== undefined) return this.cloneAccount(cached);

    const state = reconstruct({ entityKind: ACCOUNT_KIND, entityId: key, facet: ACCOUNT_FACET }).state;
    const raw = asObject(state);
    if (raw === null) return null;

    const hydrated = accountFromJson(raw);
    this.accounts.set(key, hydrated);
    return this.cloneAccount(hydrated);
  }

  saveAccount(userId: string, state: PaperAccountState): void {
    const key = accountId(state.account, userId);
    this.accounts.set(key, this.cloneAccount(state));
    writeSnapshot({
      entityKind: ACCOUNT_KIND,
      entityId: key,
      facet: ACCOUNT_FACET,
      state: toJson(state),
      spiffeId: BROKER_SPIFFE_ID,
    });
  }

  putOrder(record: PaperOrderRecord): void {
    this.orders.set(record.brokerOrderId, { ...record });
    writeSnapshot({
      entityKind: ORDER_KIND,
      entityId: record.brokerOrderId,
      facet: ORDER_FACET,
      state: toJson(record),
      spiffeId: BROKER_SPIFFE_ID,
    });

    // The index is only appended to on first sight, so a status update (a
    // cancellation, a partial becoming a fill) does not duplicate the id.
    const indexKey = accountId(record.account, record.userId);
    const ids = this.loadIndex(indexKey);
    if (!ids.includes(record.brokerOrderId)) {
      const next = [...ids, record.brokerOrderId];
      this.indexes.set(indexKey, next);
      writeSnapshot({
        entityKind: INDEX_KIND,
        entityId: indexKey,
        facet: INDEX_FACET,
        state: next,
        spiffeId: BROKER_SPIFFE_ID,
      });
    }
  }

  getOrder(brokerOrderId: string): PaperOrderRecord | null {
    const cached = this.orders.get(brokerOrderId);
    if (cached !== undefined) return { ...cached };

    const raw = asObject(
      reconstruct({ entityKind: ORDER_KIND, entityId: brokerOrderId, facet: ORDER_FACET }).state,
    );
    if (raw === null) return null;

    const hydrated = orderFromJson(raw);
    this.orders.set(brokerOrderId, hydrated);
    return { ...hydrated };
  }

  listOrders(account: 'paper' | 'live', userId: string): PaperOrderRecord[] {
    const ids = this.loadIndex(accountId(account, userId));
    return ids
      .map((id) => this.getOrder(id))
      .filter((record): record is PaperOrderRecord => record !== null)
      .sort((a, b) => b.submittedAt - a.submittedAt || a.brokerOrderId.localeCompare(b.brokerOrderId));
  }

  /** Every recorded state of an account, oldest first — the sandbox's audit trail. */
  accountHistory(account: 'paper' | 'live', userId: string, limit = 200): { validFrom: number; recordedAt: number }[] {
    return history({ entityKind: ACCOUNT_KIND, entityId: accountId(account, userId), facet: ACCOUNT_FACET, limit })
      .map((entry) => ({ validFrom: entry.validFrom, recordedAt: entry.recordedAt }))
      .sort((a, b) => a.validFrom - b.validFrom);
  }

  /** Drops the read cache. Used after a reset, and by the tests. */
  clearCache(): void {
    this.accounts.clear();
    this.orders.clear();
    this.indexes.clear();
  }

  private loadIndex(key: string): string[] {
    const cached = this.indexes.get(key);
    if (cached !== undefined) return cached;

    const state = reconstruct({ entityKind: INDEX_KIND, entityId: key, facet: INDEX_FACET }).state;
    const ids = Array.isArray(state) ? state.filter((id): id is string => typeof id === 'string') : [];
    this.indexes.set(key, ids);
    return ids;
  }

  /** Positions are copied out so a caller mutating them cannot corrupt the cache. */
  private cloneAccount(state: PaperAccountState): PaperAccountState {
    return { ...state, positions: state.positions.map((position) => ({ ...position })) };
  }
}

/**
 * The process-wide durable state.
 *
 * One instance, so the read cache is shared. It is created lazily rather than at
 * module load because constructing it must not touch the database — a module that
 * opens the ledger on import would make every page that transitively imports the
 * broker depend on a migrated database, including the ones that do not use it.
 */
let ledgerState: LedgerBrokerState | null = null;

export function brokerState(): LedgerBrokerState {
  if (ledgerState === null) ledgerState = new LedgerBrokerState();
  return ledgerState;
}

/** Test hook: forget the instance and its cache. */
export function resetBrokerState(): void {
  ledgerState = null;
}
