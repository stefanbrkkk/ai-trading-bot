/**
 * Constants that a chart and an engine rule must agree on exactly.
 *
 * `engine/service.ts` states the guarantee outright: "the oscillator the terminal
 * draws and the threshold the strategy fires on are the same numbers". They were
 * the same *value* declared twice — `Z_ENTRY_THRESHOLD` in `lib/ui/svg.ts` and
 * `ouEntryZ` in `engine/strategies.ts` — with nothing linking them, so retuning
 * the strategy would have left the drawn band behind silently.
 *
 * The obvious fix, importing `STRATEGY_PARAMS` into `svg.ts`, pulls 1,173 lines
 * of engine and its `indicators`/`stats` dependencies into every client bundle
 * that renders a chart, which is nearly all of them. So the numbers live here
 * instead: no imports, no runtime weight, and one definition each.
 */

/** Ornstein-Uhlenbeck reversion band. Entry at ±2σ, exit inside ±0.5σ. */
export const OU_ENTRY_Z = 2.0;
export const OU_EXIT_Z = 0.5;
