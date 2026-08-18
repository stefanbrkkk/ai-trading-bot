'use client';

/**
 * Instantiates the terminal store exactly once per mount and distributes the
 * immutable reference through React Context.
 *
 * `useRef` rather than `useState` or a module constant: the store must be created
 * during the first render of *this* component instance and never re-created, and
 * it must never be shared between concurrent server requests. The XAI research
 * classifies a module-scope store as a critical anti-pattern for exactly that
 * reason, and notes that relying on the `'use client'` directive with client-side
 * globals is fragile across route navigations and prefetches.
 */

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { type TerminalState, type TerminalStore, createTerminalStore } from '@/store/terminalStore';

const TerminalContext = createContext<TerminalStore | null>(null);

export function TerminalProvider({
  children,
  initialState,
}: {
  children: ReactNode;
  initialState?: Partial<TerminalState>;
}) {
  const storeRef = useRef<TerminalStore | null>(null);
  if (storeRef.current === null) storeRef.current = createTerminalStore(initialState);
  return <TerminalContext.Provider value={storeRef.current}>{children}</TerminalContext.Provider>;
}

/**
 * Atomic selector hook. A component subscribing through this re-renders iff
 * `selector(prev) !== selector(next)` under strict equality, so pushing a new
 * driver array leaves the conviction-score node untouched.
 */
export function useTerminalStore<T>(selector: (state: TerminalState) => T): T {
  const store = useContext(TerminalContext);
  if (!store) throw new Error('Missing TerminalContext.Provider in the tree');
  return useStore(store, selector);
}

/** Direct store access for imperative writes outside the render cycle. */
export function useTerminalStoreApi(): TerminalStore {
  const store = useContext(TerminalContext);
  if (!store) throw new Error('Missing TerminalContext.Provider in the tree');
  return store;
}

/**
 * Publishes the symbol a route has in focus to the store.
 *
 * The footer's FOCUS field read `NONE` on `/terminal/AAPL` and `/order/NVDA` —
 * the two routes where a symbol demonstrably *is* in focus — because nothing in
 * the tree ever called `updateAsset`. The store was correct and unwired; this is
 * the wire.
 *
 * Written through an effect rather than during render because it is a write to
 * external state, and the store's own `updateAsset` returns the identical state
 * object when the symbol has not changed, so a re-render cannot loop through it.
 */
export function useActiveSymbol(symbol: string): void {
  const store = useTerminalStoreApi();
  useEffect(() => {
    store.getState().updateAsset(symbol);
  }, [store, symbol]);
}
