'use client';

/**
 * Edge fades and keyboard access for horizontally scrolling regions.
 *
 * Two defects are being fixed here, and both only exist on narrow viewports:
 *
 *  1. A wide table or a nav strip clips silently. At 390px the primary nav shows
 *     four of its ten destinations and the screener shows six of its twenty-four
 *     columns, with nothing on screen to say the rest exist. Overlay scrollbars
 *     are invisible until you already know to swipe.
 *  2. A `div` with `overflow-x: auto` cannot be scrolled from the keyboard at all
 *     (WCAG 2.1.1). Tabbing through a table's row links does not help either:
 *     they all sit in the first column, so the horizontal offset never moves and
 *     the hidden columns are not merely undiscoverable, they are unreachable.
 *
 * This runs as an enhancement rather than as a prop on each of the twenty-odd
 * call sites: the regions are rendered by seven different pages, several of them
 * only after a fetch resolves, and the answer to "is anything actually out of
 * view" is a measurement, not something a caller can state. A caller that
 * declared `fade="right"` would be wrong at every width where the content fits.
 *
 * The fade is written as `data-fade` and re-measured on scroll, so it appears
 * only on an edge that has content behind it — never on a region that fits, and
 * never on the right edge once you have scrolled to the end. With JS disabled
 * nothing is stamped and the regions behave exactly as they did before.
 */

import { useEffect } from 'react';

/**
 * `.scroll-x` is the shared class for wide content; `data-scroll-x` opts in a
 * region that manages its own overflow classes (the nav, which is only a
 * scroller below `lg`).
 */
const SELECTOR = '.scroll-x, [data-scroll-x]';

/** Scroll offsets are fractional under browser zoom; 2px of slack avoids a fade that flickers at rest. */
const EDGE_SLACK_PX = 2;

export function ScrollAffordance() {
  useEffect(() => {
    /** Element → its listener/observer teardown. */
    const tracked = new Map<HTMLElement, () => void>();
    let frame = 0;

    const clear = (el: HTMLElement) => {
      delete el.dataset.fade;
      if (el.dataset.scrollXFocusable === 'true') {
        el.removeAttribute('tabindex');
        delete el.dataset.scrollXFocusable;
      }
    };

    const sync = (el: HTMLElement) => {
      // The nav is a scroller below `lg` and a static column above it, so whether
      // this element scrolls has to be re-read, not assumed from the selector.
      if (!/auto|scroll/.test(getComputedStyle(el).overflowX)) {
        clear(el);
        return;
      }
      const hidden = el.scrollWidth - el.clientWidth;
      if (hidden <= EDGE_SLACK_PX) {
        clear(el);
        return;
      }
      const atStart = el.scrollLeft <= EDGE_SLACK_PX;
      const atEnd = el.scrollLeft >= hidden - EDGE_SLACK_PX;
      el.dataset.fade = atStart ? 'right' : atEnd ? 'left' : 'both';

      /*
       * Focusable whenever it overflows, even when it contains links.
       *
       * The original guard skipped any region with a focusable descendant, on the
       * reasoning that tabbing through its children scrolls it. That holds
       * vertically and fails horizontally: the screener's 67 row links all sit in
       * the first column, so at 390px a keyboard user could press Tab 45 times
       * and never move `scrollLeft` off zero — 832px of columns unreachable.
       */
      if (!el.hasAttribute('tabindex')) {
        el.tabIndex = 0;
        el.dataset.scrollXFocusable = 'true';
      }
    };

    const attach = (el: HTMLElement) => {
      if (tracked.has(el)) return;
      const onScroll = () => sync(el);
      el.addEventListener('scroll', onScroll, { passive: true });
      // The region's own box governs how much is visible; its first child's box
      // governs how much there is. A table gaining rows changes only the latter.
      const resize = new ResizeObserver(() => sync(el));
      resize.observe(el);
      const content = el.firstElementChild;
      if (content !== null) resize.observe(content);
      tracked.set(el, () => {
        el.removeEventListener('scroll', onScroll);
        resize.disconnect();
      });
      sync(el);
    };

    const scan = () => {
      frame = 0;
      const live = new Set<HTMLElement>(document.querySelectorAll<HTMLElement>(SELECTOR));
      for (const el of live) attach(el);
      for (const [el, teardown] of tracked) {
        if (live.has(el)) continue;
        teardown();
        tracked.delete(el);
      }
    };

    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(scan);
    };

    scan();

    // Most of these regions mount after their page's fetch resolves, and route
    // changes swap the whole subtree. Watching `childList` is enough: `sync`
    // writes attributes, so an attribute observer here would re-enter itself.
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      mutations.disconnect();
      window.removeEventListener('resize', schedule);
      for (const [el, teardown] of tracked) {
        teardown();
        clear(el);
      }
      tracked.clear();
    };
  }, []);

  return null;
}
