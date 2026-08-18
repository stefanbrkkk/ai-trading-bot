'use client';

/**
 * The Phase 4 "Semantic Revelation" overlay.
 *
 * The XAI mandate is unambiguous about what this component may and may not show:
 * "Displaying raw floats (e.g., Feature_RSI_14: 0.043) violates the core tenets
 * of a premium user experience and fails the objective of explainability."
 * Accordingly this component takes NO shap value — the prop simply does not
 * exist, so no call site can leak one. What it shows is the sentence produced by
 * the deterministic Human-Translation Engine, the contribution share as an
 * integer percent (the research renders `contribution_percentage: 35.2` as
 * "35%"), and the discretised feature state as an audit label.
 *
 * Styling is the mandated glassmorphism treatment — dark charcoal at 92% with a
 * subtle 1px border and a backdrop blur — which lives in `globals.css` as
 * `.glass` so the blur stack is defined once.
 */

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Badge } from '@/components/ui/primitives';
import { GOLD, integer } from '@/lib/ui/format';

/** Fixed width so the edge-flip decision can be made before the box is painted. */
export const TOOLTIP_WIDTH = 268;

/** Distance from the anchor point to the nearest edge of the box. */
const TOOLTIP_OFFSET = 12;

/** Below this the box stops being readable, so it scrolls with the chart instead. */
const MIN_TOOLTIP_WIDTH = 180;

export interface DriverTooltipProps {
  /** Feature display name, already resolved server-side. */
  label: string;
  /** Hydrated Human-Translation Engine sentence. Never a raw metric. */
  narrative: string;
  /** |φ| / Σ|φ| in [0, 1]. Rendered as an integer percent. */
  share: number;
  /** Discretised state, e.g. `STATE_OVERSOLD`. */
  state?: string;
  /** Anchor position in pixels, relative to the chart's positioned host. */
  x: number;
  y: number;
  /** `right` flips the box to the left of the anchor, for near-edge drivers. */
  anchor?: 'left' | 'right';
  /**
   * Width of the chart the tooltip is drawn over. The box is clamped inside it,
   * and narrowed when the host is narrower than the box.
   */
  hostWidth?: number;
  visible: boolean;
}

export function DriverTooltip({
  label,
  narrative,
  share,
  state,
  x,
  y,
  anchor = 'left',
  hostWidth = 0,
  visible,
}: DriverTooltipProps) {
  const reduceMotion = useReducedMotion();

  // A non-finite coordinate would be written into the style attribute verbatim
  // and the E2E suite asserts zero console errors, so it is clamped to 0 here.
  const left = Number.isFinite(x) ? x : 0;
  const top = Number.isFinite(y) ? y : 0;
  const pct = Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 0;

  /*
   * Clamped inside the host, and narrowed when the host is narrower than the box.
   *
   * The box was a fixed 268px positioned by its anchor alone. On a phone the
   * chart's scrollport is 238–348px, so tapping any driver put 106–161px of the
   * box off-screen — 40 to 60% of it — on the panel whose entire job is
   * explaining the number above it. Clamping needs the host's width, which the
   * pointer helpers already measure.
   */
  const room = hostWidth > 0 ? hostWidth : TOOLTIP_WIDTH + 2 * TOOLTIP_OFFSET;
  const boxWidth = Math.max(MIN_TOOLTIP_WIDTH, Math.min(TOOLTIP_WIDTH, room - 2 * TOOLTIP_OFFSET));
  const preferredLeft = anchor === 'right' ? left - TOOLTIP_OFFSET - boxWidth : left + TOOLTIP_OFFSET;
  const maxLeft = Math.max(TOOLTIP_OFFSET, room - boxWidth - TOOLTIP_OFFSET);
  const placedLeft = Math.max(TOOLTIP_OFFSET, Math.min(preferredLeft, maxLeft));

  return (
    /*
     * Moved with a transform, not with `left`/`top`.
     *
     * Offset properties are layout, so every pointer move re-laid out the box and
     * Chrome counted each one as an unexpected shift: a 24-step hover sweep
     * accumulated 0.171 of CLS, every entry attributed to this element, none of
     * them flagged `hadRecentInput` because a mousemove does not set it. A
     * transform runs on the compositor and emits nothing.
     */
    <div
      className="pointer-events-none absolute left-0 top-0 z-30 will-change-transform"
      style={{ transform: `translate3d(${placedLeft}px, ${top}px, 0)` }}
      aria-hidden
    >
      <div className="-translate-y-1/2">
        <AnimatePresence>
          {visible ? (
            <motion.div
              role="tooltip"
              className="glass px-3.5 py-3"
              style={{ width: boxWidth }}
              // Fade + rise, 160ms — long enough to read as physical, short
              // enough not to lag a pointer moving between adjacent bars.
              initial={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 4 }}
              transition={{ duration: reduceMotion ? 0 : 0.16, ease: [0.16, 1, 0.3, 1] }}
            >
              <p className="eyebrow mb-2 truncate">{label}</p>

              {narrative ? (
                <p className="text-[0.8125rem] leading-relaxed text-parchment">{narrative}</p>
              ) : null}

              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="tabular text-2xs" style={{ color: GOLD }}>
                  {integer(pct * 100)}% of attribution
                </span>
                {state ? (
                  <Badge tone="ghost" className="border-obsidian-edge text-parchment-faint">
                    {state}
                  </Badge>
                ) : null}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Positioning helpers shared by the SHAP charts
// ─────────────────────────────────────────────────────────────────────────────

export interface HostPoint {
  x: number;
  y: number;
  hostWidth: number;
}

const ORIGIN: HostPoint = { x: 0, y: 0, hostWidth: 0 };

/**
 * Pointer position relative to the chart's positioned host.
 *
 * The charts scale with their container (`viewBox` + `w-full`), so viewBox units
 * cannot be used to place an HTML overlay. Measuring the live client rect is
 * exact at any scale and needs no resize observer.
 */
export function pointerPoint(
  event: { clientX: number; clientY: number },
  host: HTMLElement | null,
): HostPoint {
  if (!host) return ORIGIN;
  const box = host.getBoundingClientRect();
  return { x: event.clientX - box.left, y: event.clientY - box.top, hostWidth: box.width };
}

/** Centre of a focused SVG element — the keyboard equivalent of `pointerPoint`. */
export function elementPoint(element: Element | null, host: HTMLElement | null): HostPoint {
  if (!element || !host) return ORIGIN;
  const box = host.getBoundingClientRect();
  const target = element.getBoundingClientRect();
  return {
    x: target.left + target.width / 2 - box.left,
    y: target.top + target.height / 2 - box.top,
    hostWidth: box.width,
  };
}

/** Flips the box inward when the anchor is too close to the right edge. */
export function tooltipAnchor(x: number, hostWidth: number): 'left' | 'right' {
  if (!Number.isFinite(x) || !Number.isFinite(hostWidth) || hostWidth <= 0) return 'left';
  return x > hostWidth - (TOOLTIP_WIDTH + TOOLTIP_OFFSET * 2) ? 'right' : 'left';
}
