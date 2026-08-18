'use client';

/**
 * Locks a chart's viewBox width to the width it is actually rendered at.
 *
 * Every chart here is an SVG with a fixed `viewBox` and `w-full`, so the browser
 * scales the whole drawing — text included — by `rendered / viewBox`. That is
 * correct for the geometry and wrong for the type. Measured before this hook:
 *
 *     390px viewport, all 13 charts on one page:  labels 3.0px – 9.9px
 *     1600px viewport, symbol page:               LatencyBar 4.6px, FeatureBars 41.7px
 *
 * — in a design whose body text is 13px. The same declared 11px axis label was a
 * headline in the wide panel and invisible in the narrow one, purely as a function
 * of which column the chart landed in.
 *
 * Laying out at the measured width makes the scale exactly 1, so a declared 11px
 * label is 11px in every panel at every viewport. The `width` prop each chart
 * already accepts becomes the server-render fallback: the first client render uses
 * the identical number, so hydration matches, and the measurement lands on the
 * effect immediately after.
 *
 * The ref goes on the `<svg>` rather than on a wrapper, which keeps the DOM and the
 * components' layout untouched. There is no feedback loop: the rendered width comes
 * from the container through `w-full`, so a new viewBox changes the drawing's
 * height and never its width.
 *
 * `MIN_CHART_WIDTH` is the one concession. Below it the denser charts' labels would
 * collide, so a narrower host goes back to scaling down — at a 320px viewport that
 * is a scale of about 0.88, which costs a little legibility rather than producing a
 * broken drawing.
 */

import { useEffect, useRef, useState } from 'react';

/**
 * Narrowest width the charts are laid out for. Below this they scale down again.
 *
 * It was 320, and no phone ever reaches it: the chart host measures 238px inside
 * a 320px viewport and 308px inside a 390px one, so `Math.max(320, measured)`
 * pinned the viewBox above the host and the browser scaled the whole drawing
 * down — 0.744 at 320px, which turns a declared 9px label into 6.7px. Every
 * chart on every phone was rendering its axis text below the size it was
 * designed at, on the page where the numbers are the product.
 *
 * At 240 the viewBox equals the host from 240px up, so the scale is exactly 1
 * and a 9px label is 9px. `tests`/the chart-text sweep check that no label pair
 * collides at the narrow end.
 */
export const MIN_CHART_WIDTH = 240;

export function useChartWidth(fallback: number): {
  ref: React.RefObject<SVGSVGElement | null>;
  width: number;
} {
  const ref = useRef<SVGSVGElement | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const read = (): void => {
      const next = Math.round(node.getBoundingClientRect().width);
      // A chart inside a closed panel measures 0; keeping the last good width means
      // it does not have to be laid out from scratch when the panel opens.
      if (next > 0) setMeasured((current) => (current === next ? current : next));
    };
    const observer = new ResizeObserver(read);
    observer.observe(node);
    read();
    return () => observer.disconnect();
  }, []);

  return { ref, width: Math.max(MIN_CHART_WIDTH, measured ?? fallback) };
}
