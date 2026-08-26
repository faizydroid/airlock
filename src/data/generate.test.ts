import { describe, it, expect } from 'vitest';
import { generateEmployees } from './generate.js';
import { FUNCTIONS, LEVELS, LOCATIONS, type Dimension, type Employee } from './schema.js';
import { N_NUMERIC_FLOOR } from '../kernel/policy.js';

const all = generateEmployees();

function cohortSizes(dims: Dimension[]): number[] {
  const m = new Map<string, number>();
  for (const e of all) {
    const key = dims.map((d) => String(e[d as keyof Employee])).join('|');
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return [...m.values()];
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

describe('determinism', () => {
  it('produces identical output for the same seed', () => {
    const a = generateEmployees({ seed: 42, count: 200 });
    const b = generateEmployees({ seed: 42, count: 200 });
    expect(a).toEqual(b);
  });

  it('produces different output for a different seed', () => {
    const a = generateEmployees({ seed: 1, count: 200 });
    const b = generateEmployees({ seed: 2, count: 200 });
    expect(a).not.toEqual(b);
  });
});

describe('shape', () => {
  it('generates the requested count', () => {
    expect(all.length).toBe(5000);
    expect(generateEmployees({ count: 37 }).length).toBe(37);
  });

  it('emits no free-text fields', () => {
    // Free-text columns are a prompt-injection vector and a fingerprinting risk. They must
    // never exist, not merely be filtered later.
    const keys = Object.keys(all[0]!);
    expect(keys).toEqual([
      'id', 'level', 'fn', 'location', 'tenureBand',
      'gender', 'ethnicityBand', 'baseSalary', 'bonusPct', 'equityValue'
    ]);
  });

  it('produces plausible salaries with no absurd outliers', () => {
    const sal = all.map((e) => e.baseSalary);
    expect(Math.min(...sal)).toBeGreaterThan(25_000);
    expect(Math.max(...sal)).toBeLessThan(700_000);
  });

  it('pays more at higher levels', () => {
    const byLevel = LEVELS.map((l) =>
      mean(all.filter((e) => e.level === l).map((e) => e.baseSalary))
    );
    for (let i = 1; i < byLevel.length; i++) {
      expect(byLevel[i]!).toBeGreaterThan(byLevel[i - 1]!);
    }
  });
});

/**
 * These two tests are the reason the fixture is sized and shaped the way it is. Both demo
 * beats depend on them: useful analysis has to succeed, and refusals have to arise from the
 * data rather than being staged.
 */
describe('cohort sizing against the policy floors', () => {
  it('lets most depth-2 cohorts clear the numeric floor, so real analysis succeeds', () => {
    for (const dims of [
      ['level', 'fn'],
      ['level', 'gender'],
      ['fn', 'gender'],
      ['level', 'tenureBand'],
      ['fn', 'location']
    ] as Dimension[][]) {
      const sizes = cohortSizes(dims);
      const clearing = sizes.filter((n) => n >= N_NUMERIC_FLOOR).length / sizes.length;
      expect(clearing, dims.join('+')).toBeGreaterThan(0.6);
    }
  });

  it('leaves some cohorts genuinely below the floor, so refusals are real', () => {
    // Uneven location headcounts do this work. Toronto is deliberately small.
    const sizes = cohortSizes(['level', 'location']);
    const belowFloor = sizes.filter((n) => n < N_NUMERIC_FLOOR).length;
    expect(belowFloor).toBeGreaterThan(0);
  });
});

/**
 * The D2 go/no-go from the delivery review: if the planted gap is not recoverable by the
 * analysis the tools actually expose, the demo has no payoff and the fixture must be retuned.
 */
describe('the planted inequity is discoverable', () => {
  const femaleMean = (rows: Employee[]) =>
    mean(rows.filter((e) => e.gender === 'Female').map((e) => e.baseSalary));
  const maleMean = (rows: Employee[]) =>
    mean(rows.filter((e) => e.gender === 'Male').map((e) => e.baseSalary));

  it('shows a clear gap in the affected functions at senior levels', () => {
    const senior = all.filter(
      (e) =>
        (e.fn === 'Engineering' || e.fn === 'Sales') &&
        (e.level === 'L5' || e.level === 'L6' || e.level === 'L7')
    );
    const gap = 1 - femaleMean(senior) / maleMean(senior);
    // Planted at 7.5%; sampling noise moves it a little either way.
    expect(gap).toBeGreaterThan(0.04);
    expect(gap).toBeLessThan(0.12);
  });

  /**
   * Level-controlled gap: compare within each level, then weight by headcount.
   *
   * Pooling across levels does NOT measure a pay penalty, because the fixture deliberately
   * under-represents women at senior levels. That composition effect produces a large raw gap
   * even where pay is at parity — Simpson's paradox — which is precisely the trap the audit
   * has to navigate.
   */
  const adjustedGap = (rows: Employee[]) => {
    let num = 0;
    let den = 0;
    for (const level of LEVELS) {
      const at = rows.filter((e) => e.level === level);
      const f = at.filter((e) => e.gender === 'Female');
      const m = at.filter((e) => e.gender === 'Male');
      if (f.length < N_NUMERIC_FLOOR || m.length < N_NUMERIC_FLOOR) continue;
      const g = 1 - mean(f.map((e) => e.baseSalary)) / mean(m.map((e) => e.baseSalary));
      num += g * at.length;
      den += at.length;
    }
    return den === 0 ? 0 : num / den;
  };

  it('stays near parity in the unaffected functions once level is controlled for', () => {
    const other = all.filter((e) => e.fn !== 'Engineering' && e.fn !== 'Sales');
    expect(Math.abs(adjustedGap(other))).toBeLessThan(0.035);
  });

  it('shows a large unadjusted gap even where pay is at parity, so one query misleads', () => {
    // This is the analytical trap, asserted so it cannot regress away. An agent that fails to
    // control for level reports a gap in functions that are actually fair.
    const other = all.filter((e) => e.fn !== 'Engineering' && e.fn !== 'Sales');
    const unadjusted = Math.abs(1 - femaleMean(other) / maleMean(other));
    const adjusted = Math.abs(adjustedGap(other));
    expect(unadjusted).toBeGreaterThan(0.04);
    expect(unadjusted).toBeGreaterThan(adjusted * 2);
  });

  it('survives level control in the affected functions, so the real finding is robust', () => {
    const affected = all.filter((e) => e.fn === 'Engineering' || e.fn === 'Sales');
    expect(adjustedGap(affected)).toBeGreaterThan(0.03);
  });

  it('is partly masked at company level, so a single query is not enough', () => {
    // The unadjusted company-wide gap is a mix of the real penalty and level/function
    // composition. It must be visible enough to be worth investigating but not so stark that
    // the agent never needs to segment.
    const gap = 1 - femaleMean(all) / maleMean(all);
    expect(gap).toBeGreaterThan(0.01);
    expect(gap).toBeLessThan(0.25);
  });
});
