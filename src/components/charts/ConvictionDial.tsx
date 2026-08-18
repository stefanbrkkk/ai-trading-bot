'use client';

/**
 * The conviction anchor and its "unspool" morph.
 *
 * Phase 1 of the mandated drill-down: a minimal circular SVG track around the
 * score, whose `pathLength` animates from 0 to score/100 on a decelerating
 * easeOut curve. Phase 2: clicking the card morphs that circle into the
 * horizontal base axis of the SHAP force plot, "creating a direct visual
 * through-line communicating that the macro score is literally composed of the
 * data being revealed".
 *
 * Framer Motion cannot tween the `d` attribute between two shapes with different
 * anchor counts, so Flubber supplies the mixer — `interpolate(ring, axis, {
 * maxSegmentLength: MORPH_MAX_SEGMENT_LENGTH })`, built once per mount and read
 * through `useTransform`. This comment used to quote the research's 0.1 for that
 * granularity, which has not been the shipped value for some time; the constant
 * in `lib/ui/svg` is 4 and records why, and a docstring naming the number that
 * was rejected for blocking the main thread for 12.5s is worse than no number.
 *
 * Geometry: r = 84, strokeWidth = 3. `circlePath` already begins at twelve
 * o'clock and runs clockwise, so the arc carries no rotation — an inherited
 * `rotate(-90)` (correct for a `<circle>` with a dash offset, which starts at
 * three) put the arc's head 90° away from the terminal tick that is supposed to
 * mark it. C = 2πr = 527.79.
 *
 * The morph is built lazily. Flubber's mixer is expensive enough that creating it
 * unconditionally cost 12.5s of blocked main thread on the five-dial publication
 * list, so `MorphingArc` — the only code that touches Flubber — mounts on the
 * first morph and not before. A dial that is never unspooled never loads it.
 *
 * Both entrances are gated on the dial's own visibility, the same contract
 * `reveal.ts` states for every chart in this directory. The dial was the one
 * chart that never got it, and it showed: on the publication list the fifth
 * dial sits 197px below the fold at 1440x900 and ran its whole 1.1s sweep and
 * count-up there, finishing before the reader had scrolled to it. It uses an
 * IntersectionObserver rather than `whileInView` because neither animation is a
 * variant — the arc is a `pathLength` motion value and the readout is written
 * straight to a text node — so there is no variant tree for Framer to propagate
 * a label down. The threshold is read from `CHART_VIEWPORT` so the dial and the
 * charts around it latch at the same fraction.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { motion, useMotionValue, useReducedMotion, useTransform, animate, type MotionValue } from 'framer-motion';
import { interpolate } from 'flubber';
import {
  CONVICTION_RADIUS,
  CONVICTION_STROKE,
  MORPH_MAX_SEGMENT_LENGTH,
  circlePath,
  horizontalPath,
} from '@/lib/ui/svg';
import { GOLD, GOLD_BRIGHT, OBSIDIAN_EDGE } from '@/lib/ui/format';
import { CHART_VIEWPORT } from './reveal';

const VIEW = 200;
const CENTRE = VIEW / 2;

/**
 * The fraction of the dial that has to be on screen before it draws itself in.
 *
 * Taken from the charts' shared viewport contract so the dial latches at the
 * same moment as the drawings beside it. `CHART_VIEWPORT.amount` is typed to
 * allow Framer's `'some'` and `'all'` keywords as well as a number, and an
 * IntersectionObserver threshold can only be a number, so the keywords fall back
 * to the quarter that `reveal.ts` describes in prose.
 */
const REVEAL_THRESHOLD = typeof CHART_VIEWPORT?.amount === 'number' ? CHART_VIEWPORT.amount : 0.25;

/**
 * True once the element has been at least `REVEAL_THRESHOLD` visible.
 *
 * One-shot, matching the `once: true` in the shared viewport contract: an
 * entrance replayed on every scroll-past is a nervous tic, not a flourish.
 *
 * It fails open. Where there is no IntersectionObserver — an old browser, a test
 * environment — the answer is `true` on the first effect, because a dial frozen
 * at zero is a wrong number on the screen of a product whose numbers are the
 * point. This gate decides *when* an animation runs, never whether the figure is
 * eventually correct.
 */
function useRevealed(ref: RefObject<Element | null>): boolean {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof IntersectionObserver === 'undefined') {
      setRevealed(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setRevealed(true);
        observer.disconnect();
      },
      { threshold: REVEAL_THRESHOLD },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return revealed;
}

export interface ConvictionDialProps {
  /** 0–100. */
  score: number;
  /** Ring label under the figure. */
  caption?: string;
  /** 0 = circle, 1 = unspooled horizontal axis. Drives the Flubber morph. */
  morph?: number;
  /** Rendered size in px. */
  size?: number;
  /** Hides the numeric readout when the score is displayed elsewhere. */
  hideValue?: boolean;
}

export function ConvictionDial({
  score,
  caption,
  morph = 0,
  size = 200,
  hideValue = false,
}: ConvictionDialProps) {
  const reduceMotion = useReducedMotion();
  const clamped = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
  const svgRef = useRef<SVGSVGElement | null>(null);
  const revealed = useRevealed(svgRef);

  // `pathLength` is animated rather than strokeDashoffset so the arc draws along
  // its own geometry and keeps working after the morph changes that geometry.
  const progress = useMotionValue(reduceMotion ? clamped / 100 : 0);
  useEffect(() => {
    if (reduceMotion) {
      progress.set(clamped / 100);
      return;
    }
    // Held on the empty track until the dial is actually on screen.
    if (!revealed) {
      progress.set(0);
      return;
    }
    const controls = animate(progress, clamped / 100, { duration: 1.1, ease: [0.16, 1, 0.3, 1] });
    return () => controls.stop();
  }, [clamped, progress, reduceMotion, revealed]);

  const tickRotation = useTransform(progress, (p) => `rotate(${p * 360} ${CENTRE} ${CENTRE})`);

  const displayed = useMotionValue(reduceMotion ? clamped : 0);
  const valueRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    // With no readout rendered there is no node to write to, so the tween would
    // schedule ~66 frames whose every result is discarded.
    if (hideValue) return;
    if (reduceMotion) {
      if (valueRef.current) valueRef.current.textContent = clamped.toFixed(0);
      return;
    }
    // Same gate as the arc: the count-up and the sweep are one gesture, and a
    // readout that had already counted to 30 above an empty track would be the
    // worse half of the bug this fixes.
    if (!revealed) {
      if (valueRef.current) valueRef.current.textContent = '0';
      return;
    }
    const controls = animate(displayed, clamped, {
      duration: 1.1,
      ease: [0.16, 1, 0.3, 1],
      // Writing to the DOM node directly keeps the count-up off the React render
      // path entirely — no reconciliation for 60 frames of a number ticking.
      onUpdate: (v) => {
        if (valueRef.current) valueRef.current.textContent = v.toFixed(0);
      },
    });
    return () => controls.stop();
  }, [clamped, displayed, hideValue, reduceMotion, revealed]);

  const { ringPath, axisPath } = useMemo(
    () => ({
      ringPath: circlePath(CENTRE, CENTRE, CONVICTION_RADIUS),
      axisPath: horizontalPath(6, VIEW - 6, CENTRE),
    }),
    [],
  );

  const morphValue = useMotionValue(morph);
  useEffect(() => {
    if (reduceMotion) {
      morphValue.set(morph);
      return;
    }
    const controls = animate(morphValue, morph, { duration: 0.75, ease: [0.16, 1, 0.3, 1] });
    return () => controls.stop();
  }, [morph, morphValue, reduceMotion]);

  /*
   * Once a dial has morphed it keeps the Flubber path for the rest of its life —
   * it has to, to animate back — but a dial that is only ever a ring never mounts
   * it and never pays for it.
   */
  const [everMorphed, setEverMorphed] = useState(morph > 0);
  useEffect(() => {
    if (morph > 0) setEverMorphed(true);
  }, [morph]);
  const captionOpacity = useTransform(morphValue, [0, 0.35], [1, 0]);
  /*
   * Lifts the figure clear of the axis the ring unspools into. In px of the
   * rendered box rather than a percentage, because the dial is drawn at 132px in
   * a card and 220px on the symbol page and the axis is at the vertical centre of
   * both.
   */
  const readoutLift = useTransform(morphValue, [0, 1], [0, -size * 0.22]);

  return (
    <div className="relative select-none" style={{ width: size, height: size }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        width={size}
        height={size}
        role="img"
        aria-label={`Conviction score ${clamped.toFixed(0)} out of 100`}
        className="overflow-visible"
      >
        {everMorphed ? (
          <MorphingArc
            morphValue={morphValue}
            ringPath={ringPath}
            axisPath={axisPath}
            progress={progress}
          />
        ) : (
          <>
            {/* Static track. */}
            <path
              d={ringPath}
              fill="none"
              stroke={OBSIDIAN_EDGE}
              strokeWidth={CONVICTION_STROKE}
              strokeLinecap="round"
            />
            {/* Animated progress arc, gold. */}
            <motion.path
              d={ringPath}
              fill="none"
              stroke={GOLD}
              strokeWidth={CONVICTION_STROKE}
              strokeLinecap="round"
              style={{ pathLength: progress }}
              pathLength={1}
            />
          </>
        )}
        {/*
          Terminal tick at the arc's head, so the exact stopping point reads —
          and it has to be at the arc's head *while it is drawing*, not at the
          place the arc will eventually reach. Painted from the static final
          angle it sat 170px around an empty track at the first frame and the two
          only met after 1.1s, which reads as a bug rather than as a sweep.
          Driving the rotation from the same motion value the arc's `pathLength`
          uses makes the dot ride the head by construction.
        */}
        <motion.circle
          cx={CENTRE}
          cy={CENTRE - CONVICTION_RADIUS}
          r={2.5}
          fill={GOLD_BRIGHT}
          style={{ opacity: captionOpacity }}
          transform={tickRotation}
        />
      </svg>

      {/*
        The figure survives the morph; only the ring's caption fades.
        Fading the whole readout left the panel headed "Composite score"
        containing a 220px empty area and an unlabelled bar — the score erased
        from the panel named after it. The number rises clear of the unspooled
        axis instead, so both readings are available at once.
      */}
      {!hideValue ? (
        <motion.div
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
          style={{ y: readoutLift }}
        >
          {/*
            `tabular` because the figure is being rewritten sixty times a second.
            With proportional digits the box moved 17px sideways and swung 35px
            wide during a 600ms count-up — "1" measures 17px and "20" measures
            52px — so the number visibly shuffled while it counted.
          */}
          <span className="tabular display text-5xl leading-none text-gold" aria-hidden>
            <span ref={valueRef}>{reduceMotion ? clamped.toFixed(0) : '0'}</span>
          </span>
          {caption ? (
            <motion.span className="eyebrow mt-2.5" style={{ opacity: captionOpacity }}>
              {caption}
            </motion.span>
          ) : null}
        </motion.div>
      ) : null}
    </div>
  );
}

/**
 * The Flubber-backed arc. Split out so the mixer is constructed on mount, and the
 * module's only `interpolate` call sits behind a component that a page which never
 * morphs never renders.
 */
function MorphingArc({
  morphValue,
  ringPath,
  axisPath,
  progress,
}: {
  morphValue: MotionValue<number>;
  ringPath: string;
  axisPath: string;
  progress: MotionValue<number>;
}) {
  /*
   * The interpolator itself is memoised, not the factory that makes one.
   *
   * This used to memoise `(a, b) => interpolate(a, b, …)` and hand that to
   * `useTransform` as a `mixer`, which memoises nothing that matters: the range
   * overload of `useTransform` calls motion-dom's `interpolate` on every render,
   * and that eagerly invokes the mixer factory to build its mixers. So Flubber
   * re-sampled the ring on every render of this component. Measured at 4x CPU
   * throttle on /terminal/AAPL, one Waterfall/Force press cost exactly 132
   * `getPointAtLength` calls — ceil(2π·84 / 4), the whole ring — for 80-109 ms,
   * about two thirds of a 127-165 ms blocked frame, on every single press.
   *
   * Building the interpolator once and reading it through the function overload
   * moves that cost to mount, where the lazy `MorphingArc` boundary above
   * already keeps it off pages that never morph. The explicit clamp replaces the
   * clamping the range overload was doing for us (`isClamp` defaults true).
   */
  const mix = useMemo(
    () => interpolate(ringPath, axisPath, { maxSegmentLength: MORPH_MAX_SEGMENT_LENGTH }),
    [ringPath, axisPath],
  );
  const morphedPath = useTransform(morphValue, (v: number) => mix(Math.max(0, Math.min(1, v))));
  return (
    <>
      <motion.path
        d={morphedPath}
        fill="none"
        stroke={OBSIDIAN_EDGE}
        strokeWidth={CONVICTION_STROKE}
        strokeLinecap="round"
      />
      <motion.path
        d={morphedPath}
        fill="none"
        stroke={GOLD}
        strokeWidth={CONVICTION_STROKE}
        strokeLinecap="round"
        style={{ pathLength: progress }}
        pathLength={1}
      />
    </>
  );
}
