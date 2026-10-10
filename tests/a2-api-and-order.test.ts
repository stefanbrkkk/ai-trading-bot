/**
 * Three defects on the order-and-API seam: a doubled artefact read on
 * `POST /api/backtest/run`, a fill receipt that priced the trade at the user's
 * limit instead of at the fill, and a limits formatter switching on a unit
 * string that had been renamed out from under it.
 *
 * Two of the three have an arithmetic outcome, and both are checked against
 * something other than their own output. The receipt is checked against the
 * paper broker's cash ledger — the account is debited, the debit is measured,
 * and the string the panel publishes has to be that debit — because the whole
 * defect was a figure that disagreed with what the trade actually cost, and a
 * test asserting the panel's own multiplication would have passed while the
 * panel was wrong. The formatter is checked against `RISK_LIMIT_DESCRIPTORS` and
 * against the `RiskLimitUnit` union parsed out of the module that declares it,
 * so a unit renamed a second time fails here rather than rendering unitless.
 *
 * The third is a claim about a call that is made once, which no computation can
 * observe from outside the handler — importing the route would pull in the
 * session, the ledger and 115 MB of feature history — so it is checked by
 * reading the source, the way this suite checks every other claim that has no
 * other detector. The type argument the deleted read asserted is checked at the
 * type level instead: `ComputedFeatures` has a `now`, has never had a `time`,
 * and if that ever changes the assertion below stops compiling.
 *
 * The environment is `node`, so nothing here renders React. The two pure
 * functions on the order ticket and the control centre are lifted out of the
 * page source and evaluated against the real formatters, rather than copied into
 * the test where a reimplementation would pass while the page itself was wrong.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PaperBroker } from '@/lib/broker/paper';
import { RISK_LIMIT_DESCRIPTORS } from '@/lib/risk/limits';
import { notionalReferencePrice, orderNotionalUsd } from '@/lib/risk/engine';
import { duration, integer, money } from '@/lib/ui/format';
import type { ComputedFeatures } from '@/lib/engine/compute';
import type { Quote } from '@/lib/domain/types';
import type { RiskLimitUnit } from '@/lib/risk/limits';

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

/**
 * The source with its prose removed.
 *
 * The counts below are counts of *calls*, and this file's own explanation of the
 * defect quotes the call it is explaining. Counting the raw text would make the
 * comment describing the duplicate read look like a duplicate read.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const BACKTEST_ROUTE = read('src/app/api/backtest/run/route.ts');
const ORDER = read('src/app/order/[symbol]/page.tsx');
const CONTROL = read('src/app/control/page.tsx');
const LIMITS = read('src/lib/risk/limits.ts');

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
//  POST /api/backtest/run reads the feature history once
// ─────────────────────────────────────────────────────────────────────────────

describe('the backtest recompute loads the agent history once', () => {
  /*
   * Measured on the seeded artefact — 115,688,529 bytes — a read plus parse is
   * ~1.4 s of blocking CPU and ~250 MB of allocation, against ~0.2 s for the
   * whole rest of the handler: the simulator, the nearest-bar snap, the
   * risk-reversal history and the backtest itself. Doing it twice and dropping
   * one copy cost roughly seven times what the endpoint computes.
   */
  it('names the artefact exactly once', () => {
    const code = codeOnly(BACKTEST_ROUTE);
    expect((code.match(/'agent-history'/g) ?? []).length).toBe(1);
    expect((code.match(/loadArtefact</g) ?? []).length).toBe(2);
    // The other load is the GET arm's seeded fixture, which is a 110 KB file.
    expect(code).toContain("loadArtefact<BacktestResult>('backtest-default')");
  });

  it('binds that one load and reads it, with no discarded twin', () => {
    // `void history;` is precisely the idiom that silences the unused-variable
    // rule, which is why neither tsc nor eslint ever mentioned the dead read.
    expect(codeOnly(BACKTEST_ROUTE)).not.toMatch(/^\s*void\s/m);
    expect(BACKTEST_ROUTE).toContain(
      "const featureSnapshots = loadArtefact<Record<string, ComputedFeatures[]>>('agent-history');",
    );
    expect(BACKTEST_ROUTE).toContain('featureSnapshots[symbol]');
  });

  it('no longer asserts a shape the artefact does not have', () => {
    // The deleted read was typed `{ time: number; raw: Record<string, number> }[]`.
    // The stored entries are `ComputedFeatures`, which is keyed by `now` — and
    // the snap loop below it has always read `snapshot.now`.
    expect(codeOnly(BACKTEST_ROUTE)).not.toMatch(/loadArtefact<[^;]*\btime:/);
    expect(BACKTEST_ROUTE).toContain('snapshot.now');

    type HasNow = 'now' extends keyof ComputedFeatures ? true : false;
    type HasTime = 'time' extends keyof ComputedFeatures ? true : false;
    const hasNow: HasNow = true;
    const hasTime: HasTime = false;
    expect(hasNow).toBe(true);
    expect(hasTime).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  The fill receipt publishes what the fill cost
// ─────────────────────────────────────────────────────────────────────────────

interface Receipt {
  label: string;
  value: string;
  caption: string;
}

const fillReceiptNotional = lift<
  (filledQuantity: number, averageFillPrice: number | null, orderNotionalUsd: number | null) => Receipt
>(
  ORDER,
  `function fillReceiptNotional(
  filledQuantity: number,
  averageFillPrice: number | null,
  orderNotionalUsd: number | null,
): { label: string; value: string; caption: string } {`,
  'function fillReceiptNotional(filledQuantity, averageFillPrice, orderNotionalUsd) {',
  { money },
);

/** 11:00 in New York on a Tuesday — inside the regular session, so orders fill. */
const DISPATCH_AT = Date.parse('2026-08-18T15:00:00Z');

async function routeOne(clientOrderId: string, limitPrice: number, quantity: number) {
  // Receipt tests need a marketable limit, independent of the simulator's
  // generated price trajectory. The full simulator is exercised elsewhere.
  const quote: Quote = {
    symbol: 'AAPL', timestamp: DISPATCH_AT, bid: 140, ask: 141,
    bidSize: 10000, askSize: 10000, last: 140.5, lastSize: 100,
    volume: 1000000, previousClose: 140,
  };
  const broker = new PaperBroker({ quotes: () => quote, clock: () => DISPATCH_AT });
  const ctx = { correlationId: `corr-${clientOrderId}`, userId: 'user-receipt', dispatchedAt: DISPATCH_AT };
  const before = await broker.getAccount('paper', ctx);
  const result = await broker.submitOrder(
    {
      clientOrderId,
      symbol: 'AAPL',
      side: 'buy',
      type: 'limit',
      quantity,
      limitPrice,
      stopPrice: null,
      timeInForce: 'day',
      account: 'paper',
    },
    ctx,
  );
  const after = await broker.getAccount('paper', ctx);

  const ack = result.data;
  const cashBefore = before.data?.cash;
  const cashAfter = after.data?.cash;
  expect(result.ok && ack !== null, `broker refused ${clientOrderId}: ${result.error ?? result.status}`).toBe(true);
  if (ack === null || cashBefore === undefined || cashAfter === undefined) {
    throw new Error('the paper broker returned no account or no acknowledgement');
  }

  // What `POST /api/orders/submit` returns as `notionalUsd`: the order priced at
  // the pre-trade reference, which for a limit order is the typed limit verbatim.
  const intent = { quantity, notional: null, type: 'limit' as const, limitPrice, stopPrice: null };
  const reference = notionalReferencePrice(intent, quote);
  expect(reference).toBe(limitPrice);

  return {
    ack,
    debited: cashBefore - cashAfter,
    orderNotionalUsd: reference === null ? null : orderNotionalUsd(intent, reference),
  };
}

describe('the RESULT panel agrees with the cash it moved', () => {
  it('publishes the executed notional, which is what the account was debited', async () => {
    const { ack, debited, orderNotionalUsd: pretrade } = await routeOne('receipt-marketable', 148, 50);

    expect(ack.status).toBe('filled');
    expect(ack.filledQuantity).toBe(50);

    const receipt = fillReceiptNotional(ack.filledQuantity, ack.averageFillPrice, pretrade);
    expect(receipt.label).toBe('Notional filled');
    // Checked against the ledger, not against the panel's own arithmetic.
    expect(receipt.value).toBe(money(debited));

    /*
     * And the figure the row used to carry is not that number. A buy limit set
     * well above the offer is the widest case the collar admits — measured here
     * the receipt read the limit-priced notional while the account paid the
     * fill, a gap of several hundred dollars two rows under a correct "Average
     * fill". The assertion is on the disagreement rather than on a fixed dollar
     * amount, because the seeded quote moves with the instant.
     */
    expect(pretrade).not.toBeNull();
    expect(money(pretrade as number)).not.toBe(receipt.value);
    expect((pretrade as number) - debited).toBeGreaterThan(0);
  });

  it('keeps the two figures apart on a limit that fills at the touch', async () => {
    const { ack, debited, orderNotionalUsd: pretrade } = await routeOne('receipt-marginal', 142, 50);
    const receipt = fillReceiptNotional(ack.filledQuantity, ack.averageFillPrice, pretrade);
    expect(receipt.value).toBe(money(debited));
    expect(receipt.caption).toContain('the amount the cash balance moved by');
  });

  it('falls back to the order notional only while nothing has filled', () => {
    const resting = fillReceiptNotional(0, null, 7400);
    expect(resting.label).toBe('Order notional');
    expect(resting.value).toBe(money(7400));
    expect(resting.caption).toContain('Nothing has filled');
    // An out-of-hours order rests with no fill price at all; the row must not
    // multiply by a null and publish $0.00.
    expect(fillReceiptNotional(0, null, null).value).toBe('—');
    expect(fillReceiptNotional(50, null, 7400).label).toBe('Order notional');
  });

  it('prices a partial fill at the part that filled', () => {
    const partial = fillReceiptNotional(20, 141.26, 7400);
    expect(partial.label).toBe('Notional filled');
    expect(partial.value).toBe(money(20 * 141.26));
  });

  it('renders one notional row, and names which of the two it is', () => {
    expect(ORDER).toContain('<DataRow label={receipt.label} value={receipt.value} />');
    expect(ORDER).toContain('{receipt.caption}');
    // The unqualified row is what put $7,400.00 under a 141.26 average fill.
    // The reference-quote tile keeps its own "Notional" label: that one is
    // pre-trade by definition, and the caption beneath it says so.
    const receiptRows = ORDER.slice(
      ORDER.indexOf('<dl className="mt-4 space-y-0.5">'),
      ORDER.indexOf('</dl>', ORDER.indexOf('<dl className="mt-4 space-y-0.5">')),
    );
    expect(receiptRows).toContain('label="Average fill"');
    expect(receiptRows).not.toContain('label="Notional"');
    expect(ORDER).not.toContain('money(routed.notionalUsd)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Published limits render in the unit they declare
// ─────────────────────────────────────────────────────────────────────────────

/** The union members, read from the module that declares them. */
const DECLARED_UNITS: RiskLimitUnit[] = (() => {
  const start = LIMITS.indexOf('export type RiskLimitUnit =');
  expect(start, 'RiskLimitUnit declaration not found').toBeGreaterThan(-1);
  const declaration = LIMITS.slice(start, LIMITS.indexOf(';', start));
  return [...declaration.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as RiskLimitUnit);
})();

const orderFormatLimit = lift<(value: number, unit: RiskLimitUnit) => string>(
  ORDER,
  'function formatLimit(value: number, unit: RiskLimitUnit): string {',
  'function formatLimit(value, unit) {',
  { duration, integer, money },
);

const controlFormatLimit = lift<(value: number, unit: RiskLimitUnit) => string>(
  CONTROL,
  'function formatLimit(value: number, unit: RiskLimitUnit): string {',
  'function formatLimit(value, unit) {',
  { duration, integer, money },
);

/** The `switch (unit)` block alone, which is the part the two pages share. */
function switchBody(source: string): string {
  const start = source.indexOf('function formatLimit(');
  const open = source.indexOf('switch (unit) {', start);
  const end = source.indexOf('\n}\n', open);
  expect(open, 'switch not found').toBeGreaterThan(start);
  return source.slice(open, end);
}

describe('formatLimit covers the units the descriptors actually publish', () => {
  it('declares the union the descriptors use, and no phantom member', () => {
    expect(DECLARED_UNITS).toContain('messages_per_second');
    expect(DECLARED_UNITS).not.toContain('per_second');
    // The dead branch is gone from the page that carried it.
    expect(CONTROL).not.toContain("case 'per_second':");
  });

  it('has an arm for every declared unit on both pages, and no catch-all', () => {
    for (const page of [ORDER, CONTROL]) {
      const body = switchBody(page);
      for (const unit of DECLARED_UNITS) {
        expect(body, `missing arm for ${unit}`).toContain(`case '${unit}':`);
      }
      // With `unit` typed as the union and nothing to fall through to, a renamed
      // unit is a compile error instead of an unlabelled number in a gold column.
      expect(body).not.toContain('default:');
    }
    expect(ORDER).not.toContain('unit: string');
    expect(CONTROL).not.toContain('unit: string;');
  });

  it('renders the rate limit with its unit rather than as a bare count', () => {
    const rate = RISK_LIMIT_DESCRIPTORS.find((d) => d.code === 'ORDER_MESSAGE_RATE');
    expect(rate?.unit).toBe('messages_per_second');
    expect(controlFormatLimit(rate?.value ?? 0, 'messages_per_second')).toBe(`${integer(rate?.value ?? 0)}/s`);
    expect(controlFormatLimit(5, 'messages_per_second')).toBe('5/s');
    expect(controlFormatLimit(5, 'messages_per_second')).not.toBe('5');
  });

  it('leaves a status code unsuffixed, because it is a label and not a quantity', () => {
    const killSwitch = RISK_LIMIT_DESCRIPTORS.find((d) => d.code === 'KILL_SWITCH_STATUS');
    expect(killSwitch?.unit).toBe('http_status');
    expect(controlFormatLimit(killSwitch?.value ?? 0, 'http_status')).toBe(String(killSwitch?.value));
  });

  it('renders every published descriptor identically on both surfaces', () => {
    // The ticket shows the first eight and the control centre shows all twelve,
    // but ADV_LOOKBACK read "30d" on one and "30 d" on the other — one number in
    // two shapes, from two hand-written copies of one formatter.
    expect(switchBody(ORDER)).toBe(switchBody(CONTROL));
    for (const descriptor of RISK_LIMIT_DESCRIPTORS) {
      const rendered = controlFormatLimit(descriptor.value, descriptor.unit);
      expect(orderFormatLimit(descriptor.value, descriptor.unit), descriptor.code).toBe(rendered);
      expect(rendered.length, descriptor.code).toBeGreaterThan(0);
    }
  });
});
