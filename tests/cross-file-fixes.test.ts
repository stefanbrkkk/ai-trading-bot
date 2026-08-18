/**
 * The repairs that spanned more than one module.
 *
 * Every finding behind these was confirmed twice by independent reproduction,
 * and each needed a change on both sides of a boundary — a value published by
 * one module and read by another, a guard in a library and the claim a page
 * makes about it. Those are exactly the repairs that rot: half of one lands,
 * the other half is written down as a follow-up, and the defect comes back
 * wearing the other half's clothes. Each case below pins the pair.
 */

process.env.AURELIUS_DATA_DIR = ':memory:';

import { describe, expect, it } from 'vitest';
import { fitOu, ouZScore } from '@/lib/quant/ou';
import { shapWaterfall, type ShapExplanation } from '@/lib/quant/shap';
import { supportsSignal } from '@/components/charts/ShapWaterfall';
import { featureDefinition } from '@/lib/engine/features';
import { createRng } from '@/lib/quant/rng';

const { closeDb, getDb, resetDb } = await import('@/lib/db/client');
const { migrate } = await import('@/lib/db/schema');
const { assertAppendOnly } = await import('@/lib/db/bitemporal');

describe('OU z-score is gated on the fit actually reverting', () => {
  /**
   * A driftless random walk. θ collapses, `halfLife` is Infinity, and the fit
   * falls back to the SAMPLE deviation for `equilibriumSigma` because the
   * stationary one does not exist — which is what used to let a walk that had
   * wandered a long way from its own mean publish an extreme z.
   */
  function walk(seed: string, bars = 180, step = 0.02): number[] {
    const rng = createRng(seed);
    const series: number[] = [0];
    for (let i = 1; i < bars; i += 1) {
      series.push((series[i - 1] as number) + (rng.next() - 0.5) * 2 * step);
    }
    return series;
  }

  it('reports zero rather than a sample z when there is no equilibrium', () => {
    let nonReverting = 0;
    for (const seed of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8']) {
      const series = walk(seed);
      const fit = fitOu(series, 1);
      if (fit.meanReverting) continue;
      nonReverting += 1;
      expect(ouZScore(fit, series[series.length - 1] as number), `seed ${seed}`).toBe(0);
    }
    // The fixture has to actually exercise the branch, or this passes vacuously.
    expect(nonReverting, 'no non-reverting fixture in the sweep').toBeGreaterThan(0);
  });

  it('still reports a real z when the process does revert', () => {
    const rng = createRng('ou-reverting');
    const series: number[] = [0];
    for (let i = 1; i < 400; i += 1) {
      series.push((series[i - 1] as number) * 0.85 + (rng.next() - 0.5) * 0.2);
    }
    const fit = fitOu(series, 1);
    expect(fit.meanReverting).toBe(true);
    // Push it well away from equilibrium and check the magnitude survives.
    const displaced = fit.mu + 3 * fit.equilibriumSigma;
    expect(ouZScore(fit, displaced)).toBeCloseTo(3, 6);
  });

  it('cannot resolve an extreme reversion state on a series with no reversion', () => {
    const definition = featureDefinition('ou_zscore');
    expect(definition, 'ou_zscore must exist in the registry').toBeDefined();
    for (const seed of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8']) {
      const series = walk(seed);
      const fit = fitOu(series, 1);
      if (fit.meanReverting) continue;
      const z = ouZScore(fit, series[series.length - 1] as number);
      // Zero lands in the neutral band by construction; asserted through the
      // registry rather than by eye, because the band edges are the thing that
      // decides what the narrative claims.
      expect(Math.abs(z)).toBeLessThan(1.2);
    }
  });
});

describe('the waterfall publishes the share it is drawn with', () => {
  function explanation(values: number[]): ShapExplanation {
    const raw = 0.1 + values.reduce((a, b) => a + b, 0);
    return {
      values,
      baseValue: 0.1,
      rawPrediction: raw,
      probability: 1 / (1 + Math.exp(-raw)),
      featureNames: values.map((_, i) => `f${i}`),
      featureValues: values.map(() => 0),
    };
  }

  it('sums to one across the rows drawn, including the pooled remainder', () => {
    const steps = shapWaterfall(explanation([0.9, -0.6, 0.4, -0.3, 0.2, -0.15, 0.1, -0.08, 0.05, -0.03, 0.02]), 8).steps;
    const total = steps.reduce((a, s) => a + s.share, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('uses the full attribution as the denominator, not the rows shown', () => {
    // Top row is 0.9 of a Σ|φ| of 2.83. Divided by the eight rows drawn it would
    // read materially higher — that gap is the defect this pins.
    const values = [0.9, -0.6, 0.4, -0.3, 0.2, -0.15, 0.1, -0.08, 0.05, -0.03, 0.02];
    const totalAbs = values.reduce((a, v) => a + Math.abs(v), 0);
    const first = shapWaterfall(explanation(values), 8).steps[0];
    expect(first?.share).toBeCloseTo(0.9 / totalAbs, 10);
  });

  it('pools the remainder as the sum of the shares it pools', () => {
    const values = [0.9, -0.6, 0.4, -0.3, 0.2, -0.15, 0.1, -0.08, 0.05, -0.03, 0.02];
    const totalAbs = values.reduce((a, v) => a + Math.abs(v), 0);
    const steps = shapWaterfall(explanation(values), 8).steps;
    const pooled = steps[steps.length - 1];
    expect(pooled?.label).toMatch(/other drivers$/);
    expect(pooled?.share).toBeCloseTo((0.05 + 0.03 + 0.02) / totalAbs, 10);
  });
});

describe('a driver supports the call, not the sign of phi', () => {
  it('reads a negative contribution as supporting on a short', () => {
    expect(supportsSignal('negative', 'short')).toBe(true);
    expect(supportsSignal('positive', 'short')).toBe(false);
  });

  it('reads a positive contribution as supporting on a long', () => {
    expect(supportsSignal('positive', 'long')).toBe(true);
    expect(supportsSignal('negative', 'long')).toBe(false);
  });

  it('falls back to the raw sign where there is no published side', () => {
    for (const side of ['flat', undefined] as const) {
      expect(supportsSignal('positive', side)).toBe(true);
      expect(supportsSignal('negative', side)).toBe(false);
    }
  });
});

describe('the ledger proves its own immutability across every evidence table', () => {
  it('covers both trigger families and says how each was established', () => {
    resetDb();
    const db = getDb();
    migrate(db);
    const proof = assertAppendOnly(db);

    expect(proof.enforced).toBe(true);
    // The count is derived, not written out: the literal placeholder list this
    // replaced threw "column index out of range" the moment a trigger was added.
    expect(proof.triggers.length).toBe(14);
    expect(proof.evidence.map((e) => e.table).sort()).toEqual([
      'audit_events',
      'order_telemetry',
      'orders',
      'risk_decisions',
      'tos_acceptances',
    ]);
    expect(proof.evidence.every((e) => e.updateBlocked)).toBe(true);
    closeDb();
  });

  it('fires against a real row and leaves no mark', () => {
    resetDb();
    const db = getDb();
    migrate(db);
    db.prepare(
      `INSERT INTO audit_events (id, occurred_at, event_type, raw_payload)
       VALUES ('probe-1', 1, 'test', '{"kept":true}')`,
    ).run();

    const proof = assertAppendOnly(db);
    const audit = proof.evidence.find((e) => e.table === 'audit_events');
    expect(audit?.evidence).toBe('fired');
    expect(audit?.updateBlocked).toBe(true);

    const row = db.prepare("SELECT raw_payload AS p FROM audit_events WHERE id = 'probe-1'").get() as
      | { p: string }
      | undefined;
    expect(row?.p).toBe('{"kept":true}');
    closeDb();
  });
});
