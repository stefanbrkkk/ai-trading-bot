/**
 * The three trading surfaces: /terminal/[symbol], /order/[symbol] and /portfolio.
 *
 * Every case here is a defect that shipped on one of those three pages, and they
 * fall into two kinds.
 *
 * The first kind has an arithmetic outcome, and is checked against the thing the
 * page is supposed to agree with rather than against its own output. The driver
 * table's VALUE column is checked against the feature registry's own formatter —
 * the same function that produced the sentence sitting two columns to its right —
 * because the defect was that those two disagreed about what kind of quantity a
 * number was: `0.894` beside "(Liquidity score at 89.4%)" in one table row. The
 * price-field cap is checked by doing the multiplication the risk engine does and
 * asserting the product is finite and below the magnitude at which `toFixed`
 * switches to exponential notation, because "$∞" and "1e+308" were reaching the
 * mandated rejection copy.
 *
 * The second kind is a claim, and a claim is checked by reading it. A blotter
 * whose empty state promised that rejected orders are kept, above a populated
 * state saying they never exist, is not a bug in an expression — no computation
 * is wrong — so the assertion is on the sentence. The same goes for a pane whose
 * docstring described a snap that is now a transition. These are asserted against
 * the source deliberately: this codebase treats its prose as part of the product,
 * and a docstring describing removed behaviour is a defect with no other detector.
 *
 * The environment is `node`, so nothing here renders React. Where a page holds a
 * pure function worth exercising, the function is lifted out of the source and
 * evaluated against the real formatters rather than reimplemented — a
 * reimplementation would pass while the page itself was wrong, which is the
 * failure mode this whole suite exists to avoid.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FEATURE_DEFINITIONS, formatFeatureValue as registryFormat } from '@/lib/engine/features';
import { UNIVERSE } from '@/lib/market/universe';
import {
  bps,
  fixed,
  fractionAsPercent,
  integer,
  money,
  percent,
  price,
  ratio,
  sigma,
} from '@/lib/ui/format';
import type { FeatureUnit } from '@/lib/domain/types';

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

const TERMINAL = read('src/app/terminal/[symbol]/page.tsx');
const ORDER = read('src/app/order/[symbol]/page.tsx');
const PORTFOLIO = read('src/app/portfolio/page.tsx');

/**
 * Lifts a top-level function out of a page and makes it callable.
 *
 * The alternative — copying the body into the test — checks the copy. These
 * functions are small, pure and have no JSX in them, so the only thing standing
 * between the source and `new Function` is the type annotations, which are
 * removed by an exact replacement that has to match or the extraction fails
 * loudly rather than silently testing a stale shape.
 */
function lift<T>(source: string, signature: string, plain: string, deps: Record<string, unknown>): T {
  const start = source.indexOf(signature);
  expect(start, `signature not found: ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}\n', start);
  expect(end, 'function end not found').toBeGreaterThan(start);
  const body = source.slice(start, end + 2).replace(signature, plain);
  expect(body.startsWith(plain), 'signature substitution failed').toBe(true);
  const name = plain.slice('function '.length, plain.indexOf('('));
  const factory = new Function(...Object.keys(deps), `${body}\nreturn ${name};`);
  return factory(...Object.values(deps)) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
//  #19 — one number, formatted once
// ─────────────────────────────────────────────────────────────────────────────

const pageFormatFeatureValue = lift<(value: number, unit: FeatureUnit) => string>(
  TERMINAL,
  'function formatFeatureValue(value: number, unit: FeatureUnit): string {',
  'function formatFeatureValue(value, unit) {',
  { bps, fixed, fractionAsPercent, integer, money, percent, price, ratio, sigma },
);

/** Everything about a formatted value except the digits: the unit it claims. */
function unitShape(formatted: string): string {
  return formatted.replace(/[\d.,+−-]/g, '');
}

/**
 * The precision each arm of the page's fallback assumes, for the units where the
 * registry does not use one precision throughout. Where a unit's features all
 * share a precision the two are byte-identical; where they do not, the fallback
 * can round a digit differently and the *published* string is what the page
 * renders. This table is what lets the test say which is which instead of
 * asserting a weaker property everywhere.
 */
const FALLBACK_PRECISION: Partial<Record<FeatureUnit, number>> = {
  percent: 2,
  bps: 2,
  volpoints: 2,
  zscore: 2,
  signed_unit: 3,
  bars: 1,
  index_0_100: 1,
  count: 0,
  ratio: 3,
};

const SAMPLES = [1.234567, -2.71828, 0.8912345, 42.5];

describe('the driver table renders one opinion of a feature value', () => {
  /*
   * The row renders `featureValueFormatted` — the registry's own string, which
   * is also the string embedded in the sentence beside it — and only falls back
   * to formatting the raw float when the payload does not carry it.
   */
  it('prefers the published string over formatting the raw float', () => {
    expect(TERMINAL).toContain('featureValueFormatted?: string;');
    expect(TERMINAL).toContain(
      '{c.featureValueFormatted ?? formatFeatureValue(c.featureValueRaw, c.unit)}',
    );
  });

  it('types the unit as the registry union rather than as a bare string', () => {
    // `unit: string` is what let seven of the twelve units fall into `ratio()`
    // without a compile error.
    expect(TERMINAL).toContain('unit: FeatureUnit;');
    expect(TERMINAL).not.toContain('unit: string;');
  });

  it('has an arm for every unit in the registry and no catch-all', () => {
    const start = TERMINAL.indexOf('function formatFeatureValue(');
    const fn = TERMINAL.slice(start, TERMINAL.indexOf('\n}\n', start));
    const arms = new Set([...fn.matchAll(/case '(\w+)':/g)].map((m) => m[1] as string));
    for (const definition of FEATURE_DEFINITIONS) {
      expect(arms, `no arm for unit '${definition.unit}'`).toContain(definition.unit);
    }
    // A `default` arm is what silently absorbed the missing units; without one,
    // the declared `string` return type makes the next new unit a build failure.
    expect(fn).not.toContain('default:');
    // `days` has never been a member of `FeatureUnit`.
    expect(arms.has('days')).toBe(false);
  });

  it('never disagrees with the registry about what kind of quantity a value is', () => {
    const mismatches: string[] = [];
    for (const definition of FEATURE_DEFINITIONS) {
      for (const value of SAMPLES) {
        const published = registryFormat(definition, value);
        const fallback = pageFormatFeatureValue(value, definition.unit);
        if (unitShape(published) !== unitShape(fallback)) {
          mismatches.push(`${definition.key} (${definition.unit}): ${published} vs ${fallback}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('renders a probability as a percentage, exactly as the sentence does', () => {
    // The headline case: `liquidity_score` read `0.894` in the VALUE column and
    // "(Liquidity score at 89.4%)" in the INTERPRETATION column of one row. The
    // registry's probability arm ignores precision, so this is exact for every
    // probability feature at every value.
    const probabilities = FEATURE_DEFINITIONS.filter((d) => d.unit === 'probability');
    expect(probabilities.length).toBeGreaterThan(0);
    for (const definition of probabilities) {
      for (const value of [0.894, 0.193, 0.5, 0.0001]) {
        expect(pageFormatFeatureValue(value, 'probability')).toBe(registryFormat(definition, value));
      }
    }
    expect(pageFormatFeatureValue(0.894, 'probability')).toBe('89.4%');
  });

  it('matches the registry byte for byte wherever the precision is not in doubt', () => {
    let compared = 0;
    for (const definition of FEATURE_DEFINITIONS) {
      if (FALLBACK_PRECISION[definition.unit] !== definition.precision) continue;
      for (const value of SAMPLES) {
        expect(
          pageFormatFeatureValue(value, definition.unit),
          `${definition.key} (${definition.unit}, precision ${definition.precision})`,
        ).toBe(registryFormat(definition, value));
        compared += 1;
      }
    }
    // Guards the guard: a typo in the table above would otherwise skip everything.
    expect(compared).toBeGreaterThan(100);
  });

  it('refuses a non-finite value rather than printing one', () => {
    expect(pageFormatFeatureValue(Number.NaN, 'ratio')).toBe('—');
    expect(pageFormatFeatureValue(Number.POSITIVE_INFINITY, 'percent')).toBe('—');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  #7 — the left column of /terminal/[symbol]
// ─────────────────────────────────────────────────────────────────────────────

describe('the attribution grid has nothing tall enough to hollow it out', () => {
  it('keeps the drivers table out of the two-column grid', () => {
    const gridStart = TERMINAL.indexOf('xl:grid-cols-[320px_minmax(0,1fr)]');
    expect(gridStart).toBeGreaterThan(-1);
    const driversStart = TERMINAL.indexOf('Every contribution, in plain English');
    const agentsStart = TERMINAL.indexOf('── Agents and router ──');
    // The drivers panel now sits below the grid, which the agents section
    // already did — the grid closes before either of them.
    expect(driversStart).toBeGreaterThan(gridStart);
    expect(driversStart).toBeLessThan(agentsStart);
    const grid = TERMINAL.slice(gridStart, driversStart);
    expect(grid).toContain('Counter-thesis');
    expect(grid).not.toContain('<Th>Interpretation</Th>');
  });

  it('does not describe the panel as 838px wide any more', () => {
    // The 560px table floor is still right and its reason still holds; the
    // sentence that measured the old column does not.
    expect(TERMINAL).toContain('minWidth={560}');
    expect(TERMINAL).not.toContain('At 1440 the panel is 838px wide');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  #37 and #109 — the attribution crossfade
// ─────────────────────────────────────────────────────────────────────────────

describe('the waterfall/force toggle is one movement, and an optional one', () => {
  const start = TERMINAL.indexOf('function AttributionPane(');
  const pane = TERMINAL.slice(start, TERMINAL.indexOf('\n}\n', start));

  it('animates the pane box instead of snapping it to zero height', () => {
    expect(pane).toContain("height: active ? 'auto' : 0");
    // `h-0` flipped synchronously with the state: 508px to 132px in one frame,
    // while the 180ms crossfade it belongs to was still running.
    expect(pane).not.toContain('h-0');
  });

  it('honours prefers-reduced-motion, which CSS cannot do for a JS-written style', () => {
    expect(TERMINAL).toContain("import { motion, useReducedMotion } from 'framer-motion';");
    expect(pane).toContain('const reduceMotion = useReducedMotion();');
    expect(pane).toContain('duration: reduceMotion ? 0 : 0.18');
    // The hook has to run before the `mounted` early return.
    expect(pane.indexOf('useReducedMotion()')).toBeLessThan(pane.indexOf('if (!mounted) return null;'));
  });

  it('still keeps the hidden pane out of the tab order', () => {
    // Both charts put tabIndex={0} on every driver; aria-hidden alone does not
    // stop focus reaching them.
    expect(pane).toContain('aria-hidden={!active}');
    expect(pane).toContain('inert={!active}');
  });

  it('no longer documents the snap it used to perform', () => {
    expect(TERMINAL).not.toContain('`h-0 overflow-hidden` rather than `hidden`');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  #113 — a symbol from the URL cannot widen the page
// ─────────────────────────────────────────────────────────────────────────────

describe('the symbol taken from the route is bounded', () => {
  it('clamps to twelve characters on both symbol pages', () => {
    const clamp = "const symbol = (params.symbol ?? '').toUpperCase().slice(0, 12);";
    expect(TERMINAL).toContain(clamp);
    expect(ORDER).toContain(clamp);
  });

  it('clamps at a length no published symbol reaches', () => {
    // The clamp is only honest if it cannot truncate a real ticker: the whole
    // universe has to fit inside it, with room to spare.
    const longest = Math.max(...UNIVERSE.map((spec) => spec.symbol.length));
    expect(longest).toBeLessThanOrEqual(12);
    expect(UNIVERSE.length).toBeGreaterThan(60);
  });

  it('uses the same bound the order APIs enforce', () => {
    for (const route of [
      'src/app/api/orders/preflight/route.ts',
      'src/app/api/orders/submit/route.ts',
      'src/app/api/intent/route.ts',
    ]) {
      expect(read(route), route).toContain('symbol: z.string().min(1).max(12)');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  #39 and #40 — the order ticket's two buttons and their outcomes
// ─────────────────────────────────────────────────────────────────────────────

describe('the order buttons keep focus and announce what happened', () => {
  it('passes in-flight state to busy, never to disabled', () => {
    expect(ORDER).toContain('busy={checking}');
    expect(ORDER).toContain('disabled={!ready || !signedIn}');
    expect(ORDER).toContain('busy={routing}');
    expect(ORDER).toContain("disabled={preflight?.allowed !== true || !signedIn}");
    // `disabled` on the focused element hands focus to <body>; the Button
    // primitive exists to make that unnecessary. The handlers keep their own
    // re-entrancy guards on the same flags — that is not what threw focus away.
    const disabledProps = [...ORDER.matchAll(/disabled=\{([^}]*)\}/g)].map((m) => m[1] as string);
    expect(disabledProps.length).toBeGreaterThan(0);
    for (const expression of disabledProps) {
      expect(expression, 'in-flight state in a disabled prop').not.toMatch(/\b(checking|routing)\b/);
    }
  });

  it('leaves disabled in place for the genuinely unavailable cases', () => {
    // A control nobody is focused on, because the form is incomplete or there is
    // no session, is still `disabled` — and the E2E suite asserts exactly that.
    expect(ORDER).toContain('disabled={!ready || !signedIn}');
    expect(ORDER).toContain('!signedIn');
  });

  it('announces both outcomes of pre-flight and of routing', () => {
    expect(ORDER).toContain("import { Announce, PageHeader, PageShell } from '@/components/PageState';");
    expect(ORDER).toContain('Pre-trade checks passed. Execute is now available.');
    expect(ORDER).toContain('Order transmitted. Order id ${routed.orderId ?? \'unavailable\'}.');
    expect((ORDER.match(/<Announce>/g) ?? []).length).toBe(2);
  });

  it('announces politely, which is what the shared component does', () => {
    // The only live region this page had was the error Notice's role="alert".
    expect(read('src/components/PageState.tsx')).toContain(
      '<span className="sr-only" role="status" aria-live="polite">',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  #88 — a price field that cannot produce "$∞"
// ─────────────────────────────────────────────────────────────────────────────

const priceInput = lift<(value: string) => string>(
  ORDER,
  'function priceInput(value: string): string {',
  'function priceInput(value) {',
  {},
);

function constantFromSource(source: string, name: string): number {
  const match = new RegExp(`const ${name} = (\\d+);`).exec(source);
  expect(match, `${name} not found`).not.toBeNull();
  return Number((match as RegExpExecArray)[1]);
}

describe('the price fields cannot push a symbol into the rejection copy', () => {
  const priceMax = constantFromSource(ORDER, 'PRICE_MAX_LENGTH');
  const quantityMax = 9; // the quantity field's own maxLength, unchanged

  it('caps both price inputs, as the quantity input has always been capped', () => {
    expect(ORDER).toContain('maxLength={9}');
    expect((ORDER.match(/maxLength=\{PRICE_MAX_LENGTH\}/g) ?? []).length).toBe(2);
  });

  it('bounds the notional below the magnitude at which money stops being money', () => {
    const worstPrice = Number('9'.repeat(priceMax));
    const worstQuantity = Number('9'.repeat(quantityMax));
    const notional = worstPrice * worstQuantity;

    expect(Number.isFinite(notional)).toBe(true);
    // 1e21 is where `toFixed` switches to exponential notation, which is how
    // "Notional priced at 1.1111111111111111e+21 (your limit)" reached the page.
    expect(notional).toBeLessThan(1e21);

    for (const rendered of [money(notional), money(notional, { whole: true }), price(worstPrice)]) {
      expect(rendered).not.toContain('∞');
      expect(rendered).not.toContain('e+');
      expect(rendered).not.toContain('NaN');
    }
    // And the formatter refuses outright if a non-finite value ever reaches it
    // from somewhere this page does not control.
    expect(money(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('keeps at most one decimal point, so a typed price is a number', () => {
    // `replace(/[^\d.]/g, '')` accepted "1.2.3"; Number("1.2.3") is NaN, which
    // JSON sends as null, which the server answers "Enter a limit price." to.
    expect(priceInput('1.2.3')).toBe('1.23');
    expect(Number.isFinite(Number(priceInput('1.2.3')))).toBe(true);
    expect(priceInput('142.50')).toBe('142.50');
    expect(priceInput('1..2')).toBe('1.2');
    expect(priceInput('.5')).toBe('.5');
    expect(priceInput('12a3.4b5')).toBe('123.45');
    expect(priceInput('')).toBe('');
    expect(priceInput('...')).toBe('.');
  });

  it('never turns a typed price into a different number', () => {
    // The filter may only remove characters; it must not reorder or insert.
    for (const typed of ['0', '7', '99.99', '0.0001', '123456789012']) {
      expect(priceInput(typed)).toBe(typed);
      expect(Number(priceInput(typed))).toBe(Number(typed));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  #46 — the blotter says one thing about a refused order
// ─────────────────────────────────────────────────────────────────────────────

describe('the blotter describes what it actually holds', () => {
  it('no longer promises that rejected orders are kept in it', () => {
    expect(PORTFOLIO).not.toContain('Rejected orders are kept');
    expect(PORTFOLIO).not.toContain('Rejected orders are shown with the risk code that stopped them');
  });

  it('says the same thing empty as it does populated', () => {
    const refusal = 'never becomes one — /control lists every rejection with the limit that stopped it.';
    expect(PORTFOLIO).toContain(`An order refused by the pre-trade controls ${refusal}"`);
    expect(PORTFOLIO).toContain(`A refused order ${refusal}"`);
    // The populated subtitle shipped with a doubled full stop.
    expect(PORTFOLIO).not.toContain('stopped it.."');
  });

  it('is true: the submit route answers before it ever writes an order row', () => {
    const submit = read('src/app/api/orders/submit/route.ts');
    const rejection = submit.indexOf('if (!decision.approved) {');
    const insert = submit.indexOf('insertOrder(');
    expect(rejection).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(-1);
    // The rejection branch returns 422 above the only insert on the file.
    expect(rejection).toBeLessThan(insert);
    expect(submit.slice(rejection, insert)).toContain('status: 422');
  });

  it('still points the reader at the surface that does hold rejections', () => {
    expect(PORTFOLIO).toContain('href="/control"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  #66 — a failed request is not an empty portfolio
// ─────────────────────────────────────────────────────────────────────────────

describe('the joint-downside panel survives its own request failing', () => {
  it('goes through the same async slot as every other panel on the page', () => {
    expect(PORTFOLIO).toContain('<AsyncSlot state={tail} label="Joint downside" lines={4}>');
    // The blanket guard returned null for a failed request as readily as for a
    // pending one, so a 500 deleted the panel with nothing said.
    expect(PORTFOLIO).not.toContain('if (tail.loading || tail.data === null) return null;');
  });

  it('gets an error panel, a retry and an announcement from that slot', () => {
    const pageState = read('src/components/PageState.tsx');
    const start = pageState.indexOf('export function AsyncSlot');
    const slot = pageState.slice(start, pageState.indexOf('\n}\n', start));
    expect(slot).toContain('state.error !== null && state.data === null');
    expect(slot).toContain('<ErrorPanel error={state.error} onRetry={state.reload} />');
    expect(slot).toContain('<Announce>');
    // And the stale-refresh notice, which matters for a 60-second poll over a
    // tail dependence that must not be read as current when it is not.
    expect(slot).toContain('could not be refreshed');
  });
});
