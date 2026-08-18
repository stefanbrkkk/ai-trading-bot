/**
 * The terminal store.
 *
 * This is a **vanilla Zustand store created by a factory**, not a module-scope
 * global. The XAI research is explicit that a module-scope store is a critical
 * anti-pattern in the App Router, and the reason is a security one rather than a
 * performance one:
 *
 *   "a globally instantiated Zustand store on a Next.js Node.js server is shared
 *    across all concurrent requests, so if User A and User B request the terminal
 *    simultaneously, User A's trading data might bleed into User B's session,
 *    resulting in catastrophic data integrity and security vulnerabilities."
 *
 * The factory is instantiated exactly once per mount via `useRef` inside
 * `TerminalProvider`, and consumed only through atomic selectors so a component
 * re-renders iff its own slice changes under strict `===` equality.
 *
 * ── What is actually wired ──────────────────────────────────────────────────
 *
 * One component subscribes: `chrome/StatusStrip`, through `selectActiveAsset`
 * and `selectRefreshMode`.
 *
 * `activeAsset` was unwritten for a long time — no route called `updateAsset`,
 * so the footer reported `FOCUS — NONE` on `/terminal/AAPL` and `/order/NVDA`,
 * the two routes where a symbol demonstrably is in focus. Both now publish it
 * through `useActiveSymbol` (`components/TerminalProvider`). `refreshMode` is
 * still `'long_run'` for the life of the app: `app/layout.tsx` mounts the
 * provider with no `initialState` and nothing offers the user a way to change
 * it, which is the honest state of a field that describes a polling cadence the
 * product does not currently let anyone vary.
 *
 * The read helpers nobody read were removed, so the exported selector list is
 * exactly what the tree subscribes to and this note cannot quietly become false
 * again.
 */

import { createStore } from 'zustand/vanilla';
import type { ScreenerFilter, Signal } from '@/lib/domain/types';

/** Which XAI domain tab is open on the signal detail view. */
export type XaiTab = 'technical' | 'fundamental' | 'sentiment';

/**
 * Refresh cadence. The feasibility research specifies two modes: `day_trading`
 * streams tick data and book updates, while `long_run` degrades to daily polling
 * to cut compute and avoid provider throttling.
 */
export type RefreshMode = 'day_trading' | 'long_run';

export interface TerminalState {
  // ── Selection ──────────────────────────────────────────────────────────
  activeAsset: string;
  convictionScore: number;
  signal: Signal | null;
  xaiTab: XaiTab;
  /** Feature key the user is hovering, so the chart and table highlight together. */
  hoveredDriver: string | null;
  /** Which driver's narrative tooltip is open. */
  openTooltip: string | null;

  // ── Screener ───────────────────────────────────────────────────────────
  screenerFilter: ScreenerFilter;
  watchlist: string[];

  // ── Session preferences ────────────────────────────────────────────────
  refreshMode: RefreshMode;
  /** Compact mode packs more rows per screen for a multi-monitor setup. */
  density: 'comfortable' | 'compact';

  // ── Order ticket ───────────────────────────────────────────────────────
  /**
   * The ticket's fields live here so a navigation does not lose typed input, but
   * they start null and are never populated by the engine. Phase 5 §1 requires
   * the user to physically type the quantity and to select the order type; a
   * pre-filled value would make the platform a participant in the decision.
   */
  ticket: {
    quantity: number | null;
    notional: number | null;
    limitPrice: number | null;
    stopPrice: number | null;
    orderType: '' | 'market' | 'limit' | 'stop' | 'stop_limit';
    side: 'buy' | 'sell';
    timeInForce: 'day' | 'gtc' | 'ioc' | 'fok';
    account: 'paper' | 'live';
  };

  // ── Actions ────────────────────────────────────────────────────────────
  updateAsset: (symbol: string) => void;
  setSignal: (signal: Signal | null) => void;
  setConvictionScore: (score: number) => void;
  setXaiTab: (tab: XaiTab) => void;
  setHoveredDriver: (featureKey: string | null) => void;
  setOpenTooltip: (featureKey: string | null) => void;
  setScreenerFilter: (patch: Partial<ScreenerFilter>) => void;
  resetScreenerFilter: () => void;
  toggleWatchlist: (symbol: string) => void;
  setRefreshMode: (mode: RefreshMode) => void;
  setDensity: (density: 'comfortable' | 'compact') => void;
  setTicketField: <K extends keyof TerminalState['ticket']>(
    field: K,
    value: TerminalState['ticket'][K],
  ) => void;
  resetTicket: () => void;
}

export const DEFAULT_SCREENER_FILTER: ScreenerFilter = {
  sortBy: 'conviction',
  sortDirection: 'desc',
  limit: 64,
};

/** A blank ticket. Every field the user must supply is null or empty. */
export const EMPTY_TICKET: TerminalState['ticket'] = {
  quantity: null,
  notional: null,
  limitPrice: null,
  stopPrice: null,
  orderType: '',
  side: 'buy',
  timeInForce: 'day',
  account: 'paper',
};

export type TerminalStore = ReturnType<typeof createTerminalStore>;

export function createTerminalStore(initState: Partial<TerminalState> = {}) {
  return createStore<TerminalState>()((set) => ({
    activeAsset: initState.activeAsset ?? '',
    convictionScore: initState.convictionScore ?? 0,
    signal: initState.signal ?? null,
    xaiTab: initState.xaiTab ?? 'technical',
    hoveredDriver: initState.hoveredDriver ?? null,
    openTooltip: initState.openTooltip ?? null,
    screenerFilter: initState.screenerFilter ?? DEFAULT_SCREENER_FILTER,
    watchlist: initState.watchlist ?? [],
    refreshMode: initState.refreshMode ?? 'long_run',
    density: initState.density ?? 'comfortable',
    ticket: initState.ticket ?? EMPTY_TICKET,

    updateAsset: (symbol) =>
      set((state) =>
        state.activeAsset === symbol
          ? state
          : // Changing symbol must clear the ticket: carrying a typed quantity
            // across symbols would let a mis-click route size intended for
            // another instrument.
            { ...state, activeAsset: symbol, ticket: EMPTY_TICKET },
      ),
    setSignal: (signal) =>
      set((state) =>
        state.signal === signal
          ? state
          : { ...state, signal, convictionScore: signal?.conviction ?? state.convictionScore },
      ),
    setConvictionScore: (score) => set((state) => (state.convictionScore === score ? state : { ...state, convictionScore: score })),
    setXaiTab: (tab) => set((state) => (state.xaiTab === tab ? state : { ...state, xaiTab: tab })),
    setHoveredDriver: (featureKey) =>
      set((state) => (state.hoveredDriver === featureKey ? state : { ...state, hoveredDriver: featureKey })),
    setOpenTooltip: (featureKey) =>
      set((state) => (state.openTooltip === featureKey ? state : { ...state, openTooltip: featureKey })),
    setScreenerFilter: (patch) => set((state) => ({ ...state, screenerFilter: { ...state.screenerFilter, ...patch } })),
    resetScreenerFilter: () => set((state) => ({ ...state, screenerFilter: DEFAULT_SCREENER_FILTER })),
    toggleWatchlist: (symbol) =>
      set((state) => ({
        ...state,
        watchlist: state.watchlist.includes(symbol)
          ? state.watchlist.filter((s) => s !== symbol)
          : [...state.watchlist, symbol],
      })),
    setRefreshMode: (mode) => set((state) => (state.refreshMode === mode ? state : { ...state, refreshMode: mode })),
    setDensity: (density) => set((state) => (state.density === density ? state : { ...state, density })),
    setTicketField: (field, value) => set((state) => ({ ...state, ticket: { ...state.ticket, [field]: value } })),
    resetTicket: () => set((state) => ({ ...state, ticket: EMPTY_TICKET })),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Selectors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-built atomic selectors. Using these rather than inline arrow functions
 * matters: an inline selector returning a fresh object would defeat the `===`
 * equality gate and re-render on every store write, which is precisely the
 * layout thrashing the research warns about.
 *
 * Two, because two are subscribed to. There were thirteen, and the other eleven
 * — conviction, signal, direction, regime, the XAI tab, the hovered driver, the
 * open tooltip, the screener filter, the watchlist, density and the ticket — had
 * no subscriber anywhere in the tree. An exported read API that no component
 * reads is not a smaller version of a wired one; it makes an unwired store look
 * wired to the next person who greps it. Any of them is two lines to restore
 * beside the component that needs it.
 */
export const selectActiveAsset = (s: TerminalState): string => s.activeAsset;
export const selectRefreshMode = (s: TerminalState): RefreshMode => s.refreshMode;
