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
 * anchor counts, so Flubber supplies the mixer — `interpolate(a, b, {
 * maxSegmentLength: 0.1 })` inside `useTransform`, exactly as the research
 * specifies.
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
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useMotionValue, useReducedMotion, useTransform, animate, type MotionValue } from 'framer-motion';
import { interpolate } from 'flubber';
import {
  CONVICTION_CIRCUMFERENCE,
  CONVICTION_RADIUS,
  CONVICTION_STROKE,
  MORPH_MAX_SEGMENT_LENGTH,
  circlePath,
  horizontalPath,
} from '@/lib/ui/svg';
import { GOLD, GOLD_BRIGHT, OBSIDIAN_EDGE } from '@/lib/ui/format';

const VIEW = 200;
const CENTRE = VIEW / 2;

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

  // `pathLength` is animated rather than strokeDashoffset so the arc draws along
  // its own geometry and keeps working after the morph changes that geometry.
  const progress = useMotionValue(reduceMotion ? clamped / 100 : 0);
  useEffect(() => {
    if (reduceMotion) {
      progress.set(clamped / 100);
      return;
    }
    const controls = animate(progress, clamped / 100, { duration: 1.1, ease: [0.16, 1, 0.3, 1] });
    return () => controls.stop();
  }, [clamped, progress, reduceMotion]);

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
  }, [clamped, displayed, hideValue, reduceMotion]);

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

  return (
    <div className="relative select-none" style={{ width: size, height: size }}>
      <svg
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
        {/* Terminal tick at the arc's head, so the exact stopping point reads. */}
        <motion.circle
          cx={CENTRE}
          cy={CENTRE - CONVICTION_RADIUS}
          r={2.5}
          fill={GOLD_BRIGHT}
          style={{ opacity: captionOpacity }}
          transform={`rotate(${(clamped / 100) * 360} ${CENTRE} ${CENTRE})`}
        />
      </svg>

      {!hideValue ? (
        <motion.div
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
          style={{ opacity: captionOpacity }}
        >
          <span className="display text-5xl leading-none text-gold" aria-hidden>
            <span ref={valueRef}>{reduceMotion ? clamped.toFixed(0) : '0'}</span>
          </span>
          {caption ? <span className="eyebrow mt-2.5">{caption}</span> : null}
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
  const mixer = useMemo(
    () => (a: string, b: string) => interpolate(a, b, { maxSegmentLength: MORPH_MAX_SEGMENT_LENGTH }),
    [],
  );
  const morphedPath = useTransform(morphValue, [0, 1], [ringPath, axisPath], { mixer });
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

/**
 * Compact ring for table rows and the publication list. No morph, no count-up —
 * a 64px ring in a dense list should read instantly, not animate.
 */
export function ConvictionRing({ score, size = 34 }: { score: number; size?: number }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
  const r = 14;
  const circumference = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 36 36" width={size} height={size} role="img" aria-label={`Conviction ${clamped.toFixed(0)}`}>
      <circle cx={18} cy={18} r={r} fill="none" stroke={OBSIDIAN_EDGE} strokeWidth={2} />
      <circle
        cx={18}
        cy={18}
        r={r}
        fill="none"
        stroke={GOLD}
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped / 100)}
        transform="rotate(-90 18 18)"
      />
      <text
        x={18}
        y={18}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={10}
        fill={GOLD}
        className="tabular"
      >
        {clamped.toFixed(0)}
      </text>
    </svg>
  );
}

/** Exported so the unit tests can assert the mandated circumference. */
export const CONVICTION_GEOMETRY = {
  radius: CONVICTION_RADIUS,
  strokeWidth: CONVICTION_STROKE,
  circumference: CONVICTION_CIRCUMFERENCE,
};
