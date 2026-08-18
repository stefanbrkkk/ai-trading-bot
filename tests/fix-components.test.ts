/**
 * Presentation components: the panel saying the same thing as the panel beside it.
 *
 * Every case here is a defect that shipped in `src/components/`, and they group
 * by the claim each one restores:
 *
 *   1. one driver has one attribution share, whichever panel prints it;
 *   2. a histogram's caption counts the region it actually shaded;
 *   3. the readouts on that histogram sit clear of the bars they annotate;
 *   4. a live region announces a sentence;
 *   5. the conviction ring's mandated circumference is asserted by a test that
 *      exists, rather than by a docstring claiming one does.
 *
 * These run in vitest's `node` environment, which has no layout, so nothing here
 * measures a rendered element. Each case instead exercises the pure arithmetic
 * the component derives its drawing from — which is where all five defects were,
 * and is why the geometry is computed in exported functions rather than inline in
 * the JSX.
 */

import { describe, expect, it } from 'vitest';

import { resolveShares, type ShapWaterfallStep } from '@/components/charts/ShapWaterfall';
import { computeDistributionLayout } from '@/components/charts/ReturnDistribution';
import { announcementNoun } from '@/components/PageState';
import { CONVICTION_CIRCUMFERENCE, CONVICTION_RADIUS, CONVICTION_STROKE } from '@/lib/ui/svg';
import * as chartBarrel from '@/components/charts';

// ─────────────────────────────────────────────────────────────────────────────
//  1. Attribution shares
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MSFT, verbatim from `GET /api/signals/MSFT`.
 *
 * `shap` is the raw φ each waterfall step carries; `pct` is the same driver's
 * `contributionPercentage`, which is `|φ| / Σ|φ|` over the whole attribution and
 * is what the drivers table, the feature bars and the thesis all publish. The
 * ninth row is the engine's pooled remainder: its `shap` is the NET sum of the
 * 73 contributions outside the top eight, not their magnitude, which is the
 * detail that made the local denominator wrong.
 */
const MSFT_STEPS: { label: string; shap: number; pct?: number }[] = [
  { label: 'sector_rel_strength', shap: -0.1836233451522288, pct: 11.863839678151784 },
  { label: 'rel_strength_20d', shap: -0.1794047251957429, pct: 11.5912761281015 },
  { label: 'adv_ratio', shap: -0.10457040843721366, pct: 6.756257270824994 },
  { label: 'roc_20', shap: -0.08823046964811836, pct: 5.700539578807515 },
  { label: 'trend_slope_20', shap: -0.07630021915404801, pct: 4.929730294919878 },
  { label: 'ema_50_200_spread', shap: 0.048121776437463966, pct: 3.1091310323784556 },
  { label: 'inst_13f_score', shap: -0.04778177850107172, pct: 3.087163885418378 },
  { label: 'ou_half_life', shap: 0.04714503964579177, pct: 3.046024412168783 },
  { label: '73 other drivers', shap: -0.28752173316975693 },
];

function toSteps(rows: typeof MSFT_STEPS, withShares: boolean): ShapWaterfallStep[] {
  return rows.map((row) => ({
    label: row.label,
    shap: row.shap,
    cumulative: 0,
    cumulativeProbability: 0.5,
    direction: row.shap >= 0 ? ('positive' as const) : ('negative' as const),
    ...(withShares && row.pct !== undefined ? { share: row.pct / 100 } : {}),
  }));
}

describe('one driver, one attribution share', () => {
  it('prints the share the engine published, not a denominator of its own', () => {
    const shares = resolveShares(toSteps(MSFT_STEPS, true));
    for (const [i, row] of MSFT_STEPS.entries()) {
      if (row.pct === undefined) continue;
      expect(shares[i]).toBeCloseTo(row.pct / 100, 12);
    }
    // The number the reader sees. `integer(share * 100)` in the value column and
    // in every row's aria-label; 11.9% in the drivers table below; "12% of total
    // attribution" in the thesis above.
    expect(Math.round((shares[0] as number) * 100)).toBe(12);
  });

  it('gives the pooled remainder the share of the drivers it stands for', () => {
    const shares = resolveShares(toSteps(MSFT_STEPS, true));

    // Derived independently of the component: Σ|φ| over the whole attribution is
    // recoverable from any one row, since `pct` is that row's |φ| as a fraction
    // of it. The tail's share is then the part of that total the named rows do
    // not account for.
    const first = MSFT_STEPS[0] as { shap: number; pct: number };
    const totalAbs = Math.abs(first.shap) / (first.pct / 100);
    const namedAbs = MSFT_STEPS.filter((r) => r.pct !== undefined).reduce((a, r) => a + Math.abs(r.shap), 0);
    const tailShare = (totalAbs - namedAbs) / totalAbs;

    expect(shares[8]).toBeCloseTo(tailShare, 12);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it('is the defect it replaces: the drawn-row denominator inflates every named row', () => {
    const shares = resolveShares(toSteps(MSFT_STEPS, false));
    const drawnAbs = MSFT_STEPS.reduce((a, r) => a + Math.abs(r.shap), 0);

    // With nothing published the rule degenerates to the old |φ| / Σ|φ| over the
    // rows drawn, which is retained as the fallback for a caller that has no
    // shares to give.
    expect(shares[0]).toBeCloseTo(Math.abs((MSFT_STEPS[0] as { shap: number }).shap) / drawnAbs, 12);

    // And that is the bug: 17% in this chart against 11.9% in the table directly
    // below it, for the same driver, on the same screen. The gap is uniform —
    // the pooled row's net sum understates the tail's magnitude, so the whole
    // denominator is short by the same factor for every named row.
    expect(Math.round((shares[0] as number) * 100)).toBe(17);
    const published = resolveShares(toSteps(MSFT_STEPS, true));
    const inflation = (shares[0] as number) / (published[0] as number);
    for (const [i, row] of MSFT_STEPS.entries()) {
      if (row.pct === undefined) continue;
      expect((shares[i] as number) / (published[i] as number)).toBeCloseTo(inflation, 10);
    }
    expect(inflation).toBeGreaterThan(1.4);
  });

  it('never prints a negative share when a caller over-publishes', () => {
    const shares = resolveShares([
      { label: 'a', shap: 1, cumulative: 0, cumulativeProbability: 0.5, direction: 'positive', share: 0.8 },
      { label: 'b', shap: -1, cumulative: 0, cumulativeProbability: 0.5, direction: 'negative', share: 0.7 },
      { label: 'rest', shap: -0.2, cumulative: 0, cumulativeProbability: 0.5, direction: 'negative' },
    ]);
    expect(shares[2]).toBe(0);
    for (const share of shares) expect(share).toBeGreaterThanOrEqual(0);
  });

  it('reserves nothing for a row that is never drawn', () => {
    // A non-finite φ is filtered out before the layout measures anything, so a
    // NaN row cannot quietly take a slice of the total away from the bars.
    const finite = resolveShares([
      { label: 'a', shap: 3, cumulative: 0, cumulativeProbability: 0.5, direction: 'positive' },
      { label: 'b', shap: -1, cumulative: 0, cumulativeProbability: 0.5, direction: 'negative' },
    ]);
    expect(finite).toEqual([0.75, 0.25]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2 & 3. The return distribution's caption and its readouts
// ─────────────────────────────────────────────────────────────────────────────

/** 31 trade returns, the shape /backtest plots: fat left tail, mode just above zero. */
const TRADE_RETURNS = [
  -0.1644, -0.1102, -0.0925, -0.0731, -0.0688, -0.0642, -0.0611, -0.0567, -0.0489, -0.0402, -0.0361,
  -0.0298, -0.0271, -0.0244, -0.0198, -0.0143, -0.0102, -0.0071, -0.0035, -0.0012, 0.0009, 0.0031,
  0.0064, 0.0098, 0.0142, 0.0211, 0.0288, 0.0367, 0.0512, 0.0741, 0.1043,
];

describe('the distribution caption counts what the shading covers', () => {
  it('reports the observations at or below VaR95, whatever series VaR95 came from', () => {
    // The reproduced defect: /backtest passed the daily-equity VaR95 (−0.25%)
    // while plotting trade returns, so a band captioned "the 5% of observations
    // beyond VaR95" held 12 of 31 of them. The caller has been corrected; the
    // caption no longer asserts a proportion it cannot verify.
    const layout = computeDistributionLayout({ returns: TRADE_RETURNS, var95: -0.0025063, cvar95: -0.0083 });
    expect(layout).not.toBeNull();
    const tail = (layout as { tail: { count: number } | null }).tail;
    const counted = TRADE_RETURNS.filter((r) => r <= -0.0025063).length;
    expect(tail?.count).toBe(counted);
    expect(counted).toBe(19);
  });

  it('agrees with the shading when the threshold is the plotted series own quantile', () => {
    const layout = computeDistributionLayout({ returns: TRADE_RETURNS, var95: -0.1102, cvar95: -0.1373 });
    const tail = (layout as { tail: { count: number } | null }).tail;
    expect(tail?.count).toBe(2);
  });

  it('reads either sign convention as the same loss threshold', () => {
    const signed = computeDistributionLayout({ returns: TRADE_RETURNS, var95: -0.1102 });
    const magnitude = computeDistributionLayout({ returns: TRADE_RETURNS, var95: 0.1102 });
    const of = (l: unknown): number | undefined => (l as { tail: { count: number } | null }).tail?.count;
    expect(of(signed)).toBe(of(magnitude));
  });
});

describe('the distribution readouts sit clear of the bars', () => {
  const descender = 3;

  it('puts every readout above the plot frame, not inside it', () => {
    const layout = computeDistributionLayout({
      returns: TRADE_RETURNS,
      var95: -0.1102,
      cvar95: -0.1373,
      width: 1138,
      height: 280,
    });
    expect(layout).not.toBeNull();
    const l = layout as NonNullable<ReturnType<typeof computeDistributionLayout>>;

    expect(l.markers).toHaveLength(2);
    for (const marker of l.markers) expect(marker.labelY + descender).toBeLessThanOrEqual(l.f.y0);
    expect(l.meanLabelY + descender).toBeLessThanOrEqual(l.f.y0);

    // Which is the property that matters: no readout can land on a bar, however
    // tall the tallest one is. The VaR95 and CVaR95 labels used to print inside
    // it in a lighter shade of the same red.
    const tallest = Math.min(...l.bars.map((bar) => bar.y));
    for (const marker of l.markers) expect(marker.labelY).toBeLessThan(tallest);
    expect(l.meanLabelY).toBeLessThan(tallest);
  });

  it('stacks the readouts on distinct lines, in the reserved strip', () => {
    const l = computeDistributionLayout({
      returns: TRADE_RETURNS,
      var95: -0.1102,
      cvar95: -0.1373,
    }) as NonNullable<ReturnType<typeof computeDistributionLayout>>;
    const lines = [...l.markers.map((m) => m.labelY), l.meanLabelY];
    expect(new Set(lines).size).toBe(lines.length);
    // Nothing is pushed off the top of the viewBox by the stacking.
    for (const y of lines) expect(y).toBeGreaterThan(0);
  });

  it('reserves only the lines it draws', () => {
    const both = computeDistributionLayout({ returns: TRADE_RETURNS, var95: -0.1102, cvar95: -0.1373 });
    const one = computeDistributionLayout({ returns: TRADE_RETURNS, var95: -0.1102 });
    const none = computeDistributionLayout({ returns: TRADE_RETURNS });
    const top = (l: unknown): number => (l as { f: { y0: number } }).f.y0;

    expect(top(both)).toBeGreaterThan(top(one));
    expect(top(one)).toBeGreaterThan(top(none));
    // A chart with no thresholds gives its bars the room the strip would have
    // taken, rather than carrying two empty lines for readouts it never draws.
    expect((none as { markers: unknown[] }).markers).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. Live-region announcements
// ─────────────────────────────────────────────────────────────────────────────

describe('an async slot announces a sentence', () => {
  /** Every `AsyncSlot` label in the product, read out of the call sites. */
  const LABELS: [string, string][] = [
    ['Loading the publication', 'The publication'],
    ['Loading AAPL', 'AAPL'],
    ['Loading series', 'Series'],
    ['Sweeping the universe', 'The universe'],
    ['Loading the simulation', 'The simulation'],
    ['Loading the model card', 'The model card'],
    ['Loading the feature registry', 'The feature registry'],
    ['Loading the account', 'The account'],
    ['Loading the blotter', 'The blotter'],
    ['Reading the deployment state', 'The deployment state'],
    ['Loading the risk limits', 'The risk limits'],
    ['Loading your decision history', 'Your decision history'],
    ['Loading the disclosures', 'The disclosures'],
    ['Loading the forensic record', 'The forensic record'],
    ['Loading accounts', 'Accounts'],
    ['Joint downside', 'Joint downside'],
  ];

  it('turns every loading caption in the product into its subject', () => {
    for (const [label, expected] of LABELS) expect(announcementNoun(label)).toBe(expected);
  });

  it('no longer announces the caption verbatim', () => {
    // "Loading the account loaded." was read out of the live region on
    // /portfolio; every one of the sixteen slots announced its own variant.
    for (const [label] of LABELS) {
      const sentence = `${announcementNoun(label)} loaded.`;
      expect(sentence).not.toMatch(/^Loading /);
      expect(sentence).not.toMatch(/^Sweeping /);
      expect(sentence).not.toMatch(/^Reading /);
    }
  });

  it('keeps a symbol’s own casing', () => {
    expect(announcementNoun('Loading MSFT')).toBe('MSFT');
  });

  it('falls back rather than announcing nothing', () => {
    expect(announcementNoun(undefined)).toBe('Content');
    expect(announcementNoun('   ')).toBe('Content');
    // A caption that is only a participle has no noun in it to recover.
    expect(announcementNoun('Loading')).toBe('Loading');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  5. The conviction ring's mandated geometry
// ─────────────────────────────────────────────────────────────────────────────

describe('the conviction dial geometry', () => {
  it('carries the mandated circumference', () => {
    // `CONVICTION_GEOMETRY` used to be exported from the chart barrel under the
    // comment "Exported so the unit tests can assert the mandated circumference".
    // No test imported it, and nothing else in the repository did either. The
    // constants it re-exported are the real ones, and this is the assertion the
    // comment promised.
    expect(CONVICTION_RADIUS).toBe(84);
    expect(CONVICTION_STROKE).toBe(3);
    expect(CONVICTION_CIRCUMFERENCE).toBeCloseTo(2 * Math.PI * CONVICTION_RADIUS, 12);
    expect(CONVICTION_CIRCUMFERENCE).toBeCloseTo(527.7876, 4);
  });

  it('no longer publishes a ring and a geometry object nothing renders', () => {
    const published = Object.keys(chartBarrel);
    expect(published).toContain('ConvictionDial');
    expect(published).not.toContain('ConvictionRing');
    expect(published).not.toContain('CONVICTION_GEOMETRY');
  });
});
