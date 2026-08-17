/**
 * Watchlists.
 *
 * A watchlist is the one piece of genuinely user-specific state the platform holds
 * about market interest, and it is deliberately inert: it selects which published
 * rows a user sees, and nothing downstream reads it. No signal, ranking, narrative
 * or conviction score varies by watchlist membership.
 *
 * That is a compliance property, not an implementation shortcut. The publisher's
 * exemption depends on analysis being impersonal — identical for every subscriber —
 * so the moment a watchlist influenced what the model produced, the output would be
 * individualised and the exemption would not hold. Filtering a shared list is a
 * view; re-ranking it per user would be advice.
 */

import { z } from 'zod';
import { ApiError, handler, ok, parseBody, parseQuery } from '@/lib/api/respond';
import { currentUser } from '@/lib/auth/session';
import {
  addWatchlistItem,
  createWatchlist,
  deleteWatchlist,
  getWatchlist,
  getWatchlistByName,
  listWatchlistItems,
  listWatchlists,
  removeWatchlistItem,
  renameWatchlist,
  setWatchlistItems,
} from '@/lib/db';
import { getSpec } from '@/lib/market/universe';

export const dynamic = 'force-dynamic';

const MAX_WATCHLISTS = 20;
const MAX_ITEMS = 100;

/** Normalises and validates a symbol list against the tradable universe. */
function cleanSymbols(symbols: readonly string[]): { valid: string[]; rejected: string[] } {
  const valid: string[] = [];
  const rejected: string[] = [];
  for (const raw of symbols) {
    const symbol = raw.trim().toUpperCase();
    if (symbol.length === 0) continue;
    if (getSpec(symbol) === undefined) rejected.push(symbol);
    else if (!valid.includes(symbol)) valid.push(symbol);
  }
  return { valid: valid.slice(0, MAX_ITEMS), rejected };
}

async function requireUser(): Promise<{ id: string }> {
  const user = await currentUser();
  if (!user) throw new ApiError('UNAUTHENTICATED', 'Sign in to manage watchlists.', 401);
  return user;
}

/**
 * Loads a watchlist the caller owns.
 *
 * A watchlist belonging to someone else and a watchlist that does not exist both
 * return 404. Distinguishing them would confirm the existence of another user's
 * record to anyone who can guess an id.
 */
function ownedWatchlist(id: string, userId: string): ReturnType<typeof getWatchlist> {
  const list = getWatchlist(id);
  if (list === null || list.userId !== userId) {
    throw new ApiError('NOT_FOUND', 'No such watchlist.', 404);
  }
  return list;
}

export const GET = handler(async (request: Request) => {
  const user = await requireUser();
  const q = parseQuery(request, z.object({ id: z.string().max(120).optional() }));

  if (q.id !== undefined) {
    const list = ownedWatchlist(q.id, user.id);
    return ok({ watchlist: list, items: listWatchlistItems(q.id) });
  }

  const lists = listWatchlists(user.id);
  return ok({
    watchlists: lists.map((list) => ({ ...list, items: listWatchlistItems(list.id) })),
    limits: { maxWatchlists: MAX_WATCHLISTS, maxItems: MAX_ITEMS },
  });
});

const createSchema = z.object({
  name: z.string().min(1).max(60),
  symbols: z.array(z.string().min(1).max(12)).max(MAX_ITEMS).optional(),
});

export const POST = handler(async (request: Request) => {
  const user = await requireUser();
  const body = await parseBody(request, createSchema);
  const name = body.name.trim();

  if (listWatchlists(user.id).length >= MAX_WATCHLISTS) {
    throw new ApiError('LIMIT_REACHED', `A user may hold at most ${MAX_WATCHLISTS} watchlists.`, 409);
  }
  if (getWatchlistByName(user.id, name) !== null) {
    throw new ApiError('DUPLICATE_NAME', `A watchlist named "${name}" already exists.`, 409);
  }

  const { valid, rejected } = cleanSymbols(body.symbols ?? []);
  const list = createWatchlist({ userId: user.id, name });
  if (valid.length > 0) setWatchlistItems(list.id, valid);

  return ok(
    {
      watchlist: list,
      items: listWatchlistItems(list.id),
      ...(rejected.length > 0
        ? { notes: [`${rejected.join(', ')} ${rejected.length === 1 ? 'is' : 'are'} not in the tradable universe and ${rejected.length === 1 ? 'was' : 'were'} not added.`] }
        : {}),
    },
    { status: 201 },
  );
});

const patchSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(60).optional(),
  /** Replaces the membership wholesale. */
  symbols: z.array(z.string().min(1).max(12)).max(MAX_ITEMS).optional(),
  /** Incremental alternatives to `symbols`. */
  add: z.string().min(1).max(12).optional(),
  remove: z.string().min(1).max(12).optional(),
});

export const PATCH = handler(async (request: Request) => {
  const user = await requireUser();
  const body = await parseBody(request, patchSchema);
  ownedWatchlist(body.id, user.id);

  const notes: string[] = [];

  if (body.name !== undefined) {
    const name = body.name.trim();
    const existing = getWatchlistByName(user.id, name);
    if (existing !== null && existing.id !== body.id) {
      throw new ApiError('DUPLICATE_NAME', `A watchlist named "${name}" already exists.`, 409);
    }
    renameWatchlist(body.id, name);
  }

  if (body.symbols !== undefined) {
    const { valid, rejected } = cleanSymbols(body.symbols);
    setWatchlistItems(body.id, valid);
    if (rejected.length > 0) notes.push(`Ignored unknown symbols: ${rejected.join(', ')}.`);
  }

  if (body.add !== undefined) {
    const symbol = body.add.trim().toUpperCase();
    if (getSpec(symbol) === undefined) {
      throw new ApiError('UNKNOWN_SYMBOL', `${symbol} is not in the tradable universe.`, 404);
    }
    if (listWatchlistItems(body.id).length >= MAX_ITEMS) {
      throw new ApiError('LIMIT_REACHED', `A watchlist may hold at most ${MAX_ITEMS} symbols.`, 409);
    }
    addWatchlistItem({ watchlistId: body.id, symbol });
  }

  if (body.remove !== undefined) {
    removeWatchlistItem(body.id, body.remove.trim().toUpperCase());
  }

  const list = getWatchlist(body.id);
  return ok({ watchlist: list, items: listWatchlistItems(body.id), ...(notes.length > 0 ? { notes } : {}) });
});

export const DELETE = handler(async (request: Request) => {
  const user = await requireUser();
  const q = parseQuery(request, z.object({ id: z.string().min(1).max(120) }));
  ownedWatchlist(q.id, user.id);
  deleteWatchlist(q.id);
  return ok({ deleted: q.id });
});
