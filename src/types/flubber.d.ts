/**
 * Type shim for `flubber`, which ships without declarations.
 *
 * Only the surface the morph actually uses is declared. `interpolate` returns an
 * interpolator from a normalised progress value to an SVG path string, which is
 * exactly the signature Framer Motion's `useTransform` mixer expects.
 */
declare module 'flubber' {
  export interface FlubberOptions {
    /** Smaller values add more intermediate anchors, yielding a smoother morph. */
    maxSegmentLength?: number;
    /** Emit the result as an array of points rather than a path string. */
    string?: boolean;
    /** Single-shape simplification tolerance. */
    single?: boolean;
  }

  export function interpolate(
    fromShape: string | number[][],
    toShape: string | number[][],
    options?: FlubberOptions,
  ): (t: number) => string;

  export function separate(
    fromShape: string | number[][],
    toShapes: (string | number[][])[],
    options?: FlubberOptions,
  ): (t: number) => string;

  export function combine(
    fromShapes: (string | number[][])[],
    toShape: string | number[][],
    options?: FlubberOptions,
  ): (t: number) => string;

  export function toCircle(
    fromShape: string | number[][],
    cx: number,
    cy: number,
    r: number,
    options?: FlubberOptions,
  ): (t: number) => string;

  export function fromCircle(
    cx: number,
    cy: number,
    r: number,
    toShape: string | number[][],
    options?: FlubberOptions,
  ): (t: number) => string;
}
