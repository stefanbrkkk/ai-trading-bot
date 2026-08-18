'use client';

/**
 * The shared "which driver is the pointer on" state, held outside the page.
 *
 * It used to be `useState` in the attribution page, which meant every pointer
 * enter re-rendered the whole route: nine charts, a 12-row table, four stat
 * grids and the panels around them, on every mousemove between adjacent bars.
 * Measured with a 3-second pointer sweep at 4x CPU throttling, the force plot ran
 * at 8–10 fps with 16 long tasks and 100% task saturation of the window, against
 * a same-session control of 181 frames at a 16.7 ms median.
 *
 * Context inverts that. The provider owns the state, so `children` — which is a
 * stable element the page created once — is not re-rendered when it changes; only
 * the components that actually read the value are. Read and write are separate
 * contexts so a component that only sets the value (a table row, a chart's
 * pointer handlers) never subscribes to it.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

const HoveredContext = createContext<string | null>(null);
const SetHoveredContext = createContext<(key: string | null) => void>(() => {});

export function DriverHoverProvider({ children }: { children: ReactNode }) {
  const [hovered, setHovered] = useState<string | null>(null);
  // Stable identity, so a consumer that only writes never re-renders.
  const set = useCallback((key: string | null) => setHovered(key), []);
  const value = useMemo(() => set, [set]);
  return (
    <SetHoveredContext.Provider value={value}>
      <HoveredContext.Provider value={hovered}>{children}</HoveredContext.Provider>
    </SetHoveredContext.Provider>
  );
}

/** Subscribes to the hovered key. Only call this where the value is rendered. */
export function useHoveredDriver(): string | null {
  return useContext(HoveredContext);
}

/** The setter alone. Calling this does not subscribe to changes. */
export function useSetHoveredDriver(): (key: string | null) => void {
  return useContext(SetHoveredContext);
}

/**
 * A table row that highlights while its driver is hovered.
 *
 * A component rather than inline JSX because only a component can subscribe to
 * the context — and subscribing per row means one row re-renders on a hover
 * change instead of the page.
 */
export function HoverableRow({
  featureKey,
  children,
}: {
  featureKey: string;
  children: ReactNode;
}) {
  const hovered = useHoveredDriver();
  const setHovered = useSetHoveredDriver();
  return (
    <tr
      onMouseEnter={() => setHovered(featureKey)}
      onMouseLeave={() => setHovered(null)}
      className={hovered === featureKey ? 'bg-obsidian-light/60' : undefined}
    >
      {children}
    </tr>
  );
}
