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
 */

import { createStore } from 'zustand/vanilla';
import type { RegimeLabel, ScreenerFilter, Signal, SignalDirection } from '@/lib/domain/types';

/** Which XAI domain tab is open on the signal detail view. */
export type XaiTab = 'technical' | 'fundamental' | 'sentiment';

/** Force plot ↔ waterfall morph state. 0 = force plot, 1 = waterfall. */
export type MorphState = number;

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
  /** True once the conviction card has been expanded into the XAI view. */
  drilledDown: boolean;
  xaiTab: XaiTab;
  morph: MorphState;
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
  setDrilledDown: (value: boolean) => void;
  setXaiTab: (tab: XaiTab) => void;
  setMorph: (value: MorphState) => void;
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
    drilledDown: initState.drilledDown ?? false,
    xaiTab: initState.xaiTab ?? 'technical',
    morph: initState.morph ?? 0,
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
            { ...state, activeAsset: symbol, drilledDown: false, morph: 0, ticket: EMPTY_TICKET },
      ),
    setSignal: (signal) =>
      set((state) =>
        state.signal === signal
          ? state
          : { ...state, signal, convictionScore: signal?.conviction ?? state.convictionScore },
      ),
    setConvictionScore: (score) => set((state) => (state.convictionScore === score ? state : { ...state, convictionScore: score })),
    setDrilledDown: (value) => set((state) => (state.drilledDown === value ? state : { ...state, drilledDown: value })),
    setXaiTab: (tab) => set((state) => (state.xaiTab === tab ? state : { ...state, xaiTab: tab })),
    setMorph: (value) => set((state) => (state.morph === value ? state : { ...state, morph: value })),
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
 */
export const selectActiveAsset = (s: TerminalState): string => s.activeAsset;
export const selectConviction = (s: TerminalState): number => s.convictionScore;
export const selectSignal = (s: TerminalState): Signal | null => s.signal;
export const selectDirection = (s: TerminalState): SignalDirection => s.signal?.direction ?? 'flat';
export const selectRegime = (s: TerminalState): RegimeLabel | null => s.signal?.regime ?? null;
export const selectDrilledDown = (s: TerminalState): boolean => s.drilledDown;
export const selectXaiTab = (s: TerminalState): XaiTab => s.xaiTab;
export const selectMorph = (s: TerminalState): number => s.morph;
export const selectHoveredDriver = (s: TerminalState): string | null => s.hoveredDriver;
export const selectOpenTooltip = (s: TerminalState): string | null => s.openTooltip;
export const selectScreenerFilter = (s: TerminalState): ScreenerFilter => s.screenerFilter;
export const selectWatchlist = (s: TerminalState): string[] => s.watchlist;
export const selectRefreshMode = (s: TerminalState): RefreshMode => s.refreshMode;
export const selectDensity = (s: TerminalState): 'comfortable' | 'compact' => s.density;
export const selectTicket = (s: TerminalState): TerminalState['ticket'] => s.ticket;
