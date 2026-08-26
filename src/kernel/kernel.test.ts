import { describe, it, expect, beforeEach } from 'vitest';
import { Kernel, type AggregateOk } from './kernel.js';
import { COUNT_EXACT_FLOOR, K_COUNT_FLOOR, N_NUMERIC_FLOOR } from './policy.js';
import { generateEmployees } from '../data/generate.js';

/**
 * The disclosure invariant, tested at the only boundary that can violate it.
 *
 * A failure here means an individual value can leave the kernel, which makes the product's
 * central claim false.
 */

let k: Kernel;

beforeEach(() => {
  k = new Kernel();
  k.loadSample();
});

function ok(d: unknown): AggregateOk {
  expect((d as { status: string }).status).toBe('ok');
  return d as AggregateOk;
}

describe('gating before any data is touched', () => {
  it('refuses everything until a dataset is loaded', () => {
    const fresh = new Kernel();
    expect(fresh.aggregate({ stat: 'mean', metric: 'baseSalary' })).toMatchObject({
      status: 'refused',
      code: 'NO_DATASET'
    });
    expect(fresh.profile()).toMatchObject({ status: 'refused', code: 'NO_DATASET' });
  });

  it.each(['min', 'max', 'stddev', 'sum', 'mode', 'top'])('refuses the %s statistic', (bad) => {
    expect(k.aggregate({ stat: bad, metric: 'baseSalary' })).toMatchObject({
      status: 'refused',
      code: 'STAT_NOT_PERMITTED'
    });
  });

  it('refuses group-by beyond the depth cap', () => {
    expect(
      k.aggregate({
        stat: 'mean',
        metric: 'baseSalary',
        groupBy: ['level', 'fn', 'location']
      })
    ).toMatchObject({ status: 'refused', code: 'GROUP_BY_TOO_DEEP' });
  });

  it('refuses unknown dimensions and metrics', () => {
    expect(
      k.aggregate({ stat: 'count', groupBy: ['salary_exact' as never] })
    ).toMatchObject({ code: 'UNKNOWN_DIMENSION' });
    expect(k.aggregate({ stat: 'mean', metric: 'ssn' })).toMatchObject({
      code: 'UNKNOWN_METRIC'
    });
  });
});

describe('the disclosure invariant', () => {
  it('never emits a numeric value for a cohort below the numeric floor', () => {
    // Exhaustive over every depth-2 grouping, every metric, every numeric stat.
    // One kernel with an effectively unlimited budget: regenerating the dataset per
    // combination would mean ~450k rows per test run for no additional coverage.
    const big = new Kernel(Number.MAX_SAFE_INTEGER);
    big.loadSample();

    const dims = ['level', 'fn', 'location', 'tenureBand', 'gender', 'ethnicityBand'] as const;
    const metrics = ['baseSalary', 'bonusPct', 'equityValue'] as const;
    const stats = ['mean'] as const;

    for (let i = 0; i < dims.length; i++) {
      for (let j = i + 1; j < dims.length; j++) {
        for (const metric of metrics) {
          for (const stat of stats) {
            const r = ok(big.aggregate({ stat, metric, groupBy: [dims[i]!, dims[j]!] }));
            for (const cell of r.cells) {
              // A cell either carries a value or is explicitly marked withheld. Never both,
              // never neither.
              expect(cell.value !== undefined).toBe(cell.withheld === undefined);

              // Where the count is exact, the floor can be checked directly.
              if (typeof cell.count === 'number' && cell.count < N_NUMERIC_FLOOR) {
                expect(cell.value).toBeUndefined();
              }
              // A cell banded '<5' or '5-9' is below the numeric floor by definition.
              if (cell.count === '<5' || cell.count === '5-9') {
                expect(cell.value, JSON.stringify(cell)).toBeUndefined();
              }
            }
          }
        }
      }
    }
  });

  it('quantizes every emitted value', () => {
    const r = ok(k.aggregate({ stat: 'mean', metric: 'baseSalary', groupBy: ['level'] }));
    for (const c of r.cells) {
      if (c.value !== undefined) expect(c.value % 500).toBe(0);
    }
    const r2 = ok(k.aggregate({ stat: 'mean', metric: 'bonusPct', groupBy: ['fn'] }));
    for (const c of r2.cells) {
      if (c.value !== undefined) {
        expect(Number.isInteger(Math.round(c.value * 100))).toBe(true);
        expect(c.value).toBeCloseTo(Math.round(c.value * 100) / 100, 10);
      }
    }
  });

  it('never emits an exact count below the exact floor', () => {
    const r = ok(k.aggregate({ stat: 'count', groupBy: ['level', 'location'] }));
    for (const c of r.cells) {
      if (typeof c.count === 'number') expect(c.count).toBeGreaterThanOrEqual(COUNT_EXACT_FLOOR);
    }
  });

  it('emits no field that could carry a record identifier', () => {
    const r = ok(k.aggregate({ stat: 'mean', metric: 'baseSalary', groupBy: ['level', 'gender'] }));
    const serialised = JSON.stringify(r);
    expect(serialised).not.toMatch(/"id"/);
    // Every dimension value in output must be a declared enum member, never a free string.
    for (const c of r.cells) {
      for (const v of Object.values(c.group)) expect(typeof v).toBe('string');
    }
  });
});

/**
 * Returning the full cross-product is what closes the suppression-pattern channel. If sub-floor
 * cohorts were omitted, the returned key set would reveal which cohorts are small.
 */
describe('suppression reveals no pattern', () => {
  it('returns the full cross-product regardless of which cohorts are populated', () => {
    const r = ok(k.aggregate({ stat: 'count', groupBy: ['level', 'location'] }));
    expect(r.cells.length).toBe(7 * 6);
  });

  it('makes an empty cohort indistinguishable from a tiny one', () => {
    const small = new Kernel(1_000_000);
    small.loadSample({ count: 60 });
    const r = ok(small.aggregate({ stat: 'count', groupBy: ['level', 'location'] }));
    const bands = new Set(r.cells.map((c) => String(c.count)));
    // With 60 people over 42 cohorts, effectively all are sub-floor and must read identically.
    expect(bands.has('<5')).toBe(true);
    const zeroOrTiny = r.cells.filter((c) => c.count === '<5');
    expect(zeroOrTiny.length).toBeGreaterThan(30);
  });
});

describe('budget', () => {
  it('charges for precision and not for coarse bands', () => {
    const fresh = new Kernel();
    fresh.loadSample();
    const before = fresh.remaining;
    // A single whole-population count is one exact number.
    ok(fresh.aggregate({ stat: 'count' }));
    expect(fresh.remaining).toBeLessThan(before);
  });

  it('exhausts and then refuses', () => {
    const tiny = new Kernel(3);
    tiny.loadSample();
    let sawRefusal = false;
    for (let i = 0; i < 20; i++) {
      const r = tiny.aggregate({ stat: 'mean', metric: 'baseSalary', groupBy: ['level'] });
      if ((r as { code?: string }).code === 'BUDGET_EXHAUSTED') {
        sawRefusal = true;
        break;
      }
    }
    expect(sawRefusal).toBe(true);
    expect(tiny.remaining).toBe(0);
  });

  it('charges refusals, so refusal is not a free oracle', () => {
    const fresh = new Kernel();
    fresh.loadSample();
    const before = fresh.remaining;
    fresh.aggregate({ stat: 'stddev', metric: 'baseSalary' });
    expect(fresh.remaining).toBe(before - 1);
  });

  it('can be extended, and records that as a human action', () => {
    const tiny = new Kernel(1);
    tiny.loadSample();
    tiny.aggregate({ stat: 'count' });
    tiny.extendBudget(50);
    expect(tiny.remaining).toBeGreaterThan(0);
    expect(tiny.getLedger().some((e) => e.op === 'extend_budget')).toBe(true);
  });
});

describe('ledger', () => {
  it('records what was asked and never what was returned', () => {
    k.aggregate({ stat: 'mean', metric: 'baseSalary', groupBy: ['level'] });
    const entry = k.getLedger().at(-1)!;
    expect(entry.op).toBe('aggregate');
    expect(entry.spec).toMatchObject({ stat: 'mean', metric: 'baseSalary' });
    // No values, no cells, no counts anywhere in the entry.
    const s = JSON.stringify(entry);
    expect(s).not.toMatch(/"cells"/);
    expect(s).not.toMatch(/"value"/);
  });

  it('records refusals with their code', () => {
    k.aggregate({ stat: 'max', metric: 'baseSalary' });
    const entry = k.getLedger().at(-1)!;
    expect(entry.outcome).toBe('refused');
    expect(entry.code).toBe('STAT_NOT_PERMITTED');
  });

  it('is append-only and monotonic', () => {
    const before = k.getLedger().length;
    k.aggregate({ stat: 'count' });
    k.aggregate({ stat: 'count', groupBy: ['fn'] });
    const after = k.getLedger();
    expect(after.length).toBe(before + 2);
    for (let i = 1; i < after.length; i++) {
      expect(after[i]!.seq).toBeGreaterThan(after[i - 1]!.seq);
    }
  });
});

describe('the audit actually works', () => {
  it('surfaces the planted gap through permitted statistics only', () => {
    const big = new Kernel(1_000_000);
    big.loadSample();
    const r = ok(
      big.aggregate({ stat: 'mean', metric: 'baseSalary', groupBy: ['level', 'gender'] })
    );
    const at = (level: string, gender: string) =>
      r.cells.find((c) => c.group.level === level && c.group.gender === gender)?.value;

    // Senior levels must be reportable and must show a gap.
    for (const level of ['L5', 'L6']) {
      const f = at(level, 'Female');
      const m = at(level, 'Male');
      expect(f, `${level} female`).toBeDefined();
      expect(m, `${level} male`).toBeDefined();
      expect(f!).toBeLessThan(m!);
    }
  });

  it('agrees with the raw data within the quantization step', () => {
    const rows = generateEmployees();
    const big = new Kernel(1_000_000);
    big.loadSample();
    const r = ok(big.aggregate({ stat: 'mean', metric: 'baseSalary' }));
    const truth = rows.reduce((a, e) => a + e.baseSalary, 0) / rows.length;
    expect(Math.abs(r.cells[0]!.value! - truth)).toBeLessThanOrEqual(250);
  });
});

describe('policy floors are consistent with each other', () => {
  it('keeps the count floor below the numeric floor', () => {
    expect(K_COUNT_FLOOR).toBeLessThan(N_NUMERIC_FLOOR);
  });
});
