import { describe, it, expect } from 'vitest';
import { Kernel } from '../kernel/kernel.js';
import { N_NUMERIC_FLOOR } from '../kernel/policy.js';
import { generateEmployees } from '../data/generate.js';

/**
 * Adversarial evaluation.
 *
 * Each test below is a named attack from the security review, executed against the real kernel
 * using only the tools an agent actually has. These are not unit tests of intent — they are
 * attempts to extract an individual's salary, and they must fail.
 *
 * The results table in README.md is generated from these test names, so an attack that is
 * quietly deleted also disappears from the published claim. Add attacks here; never weaken one.
 *
 * The ground truth is available to the test (via `generateEmployees`) purely so it can check
 * whether a recovered value is correct. The kernel under test never receives it.
 */

/** Every attack gets a generous budget; a budget-limited failure would prove nothing. */
function kernel(): Kernel {
  const k = new Kernel(Number.MAX_SAFE_INTEGER);
  k.loadSample();
  return k;
}

const truth = generateEmployees();

/** The salary that would identify a specific person if any attack succeeded. */
function targetSalary(): number {
  const sorted = [...truth].sort((a, b) => b.baseSalary - a.baseSalary);
  return sorted[0]!.baseSalary;
}

function valuesOf(d: unknown): number[] {
  const r = d as { status: string; cells?: { value?: number }[] };
  if (r.status !== 'ok' || !r.cells) return [];
  return r.cells.filter((c) => c.value !== undefined).map((c) => c.value!);
}

describe('A1 — extremum request', () => {
  it('refuses min, max and top-N outright', () => {
    const k = kernel();
    for (const stat of ['max', 'min', 'top', 'topN']) {
      expect(k.aggregate({ stat, metric: 'baseSalary' })).toMatchObject({
        status: 'refused',
        code: 'STAT_NOT_PERMITTED'
      });
    }
  });

  it('never returns the highest salary through any permitted statistic', () => {
    const k = kernel();
    const target = targetSalary();
    const seen: number[] = [];
    for (const groupBy of [[], ['level'], ['fn'], ['level', 'fn'], ['level', 'gender']]) {
      seen.push(...valuesOf(k.aggregate({ stat: 'mean', metric: 'baseSalary', groupBy })));
    }
    // No disclosed value may land within a quantization step of the top salary.
    for (const v of seen) expect(Math.abs(v - target)).toBeGreaterThan(500);
  });
});

describe('A2 — order statistics as individual values', () => {
  /**
   * This attack succeeded against an earlier build and recovered 53 exact salaries.
   *
   * The defect was structural. `percentile` returned a bare `sorted[i]` whenever `(n-1)*q` was an
   * integer — every odd n for the median — so the median of a 363-person cohort was exactly one
   * employee's salary. The cohort floor of 20 was irrelevant, because the influence support of a
   * median is 1 at every odd n rather than only at small n.
   *
   * The fix was to withdraw the statistic, not to raise the floor. These assertions exist to stop
   * it being reintroduced.
   */
  it('refuses medians and quartiles outright, at any cohort size', () => {
    const k = kernel();
    for (const stat of ['median', 'p25', 'p75', 'percentile', 'quartile']) {
      const r = k.aggregate({ stat, metric: 'baseSalary', groupBy: ['level'] });
      expect(r.status, `${stat} must be refused`).toBe('refused');
      expect((r as { code: string }).code).toBe('STAT_WITHDRAWN');
    }
  });

  it('explains why, so the agent can adapt rather than retry', () => {
    const k = kernel();
    const r = k.aggregate({ stat: 'median', metric: 'baseSalary' });
    const refusal = r as { reason: string; recovery: string };
    expect(refusal.reason).toMatch(/order statistic/i);
    expect(refusal.recovery).toMatch(/mean/i);
  });

  it('leaves no percentile machinery reachable in the kernel', () => {
    // A withdrawn statistic that still has a code path is a statistic waiting to be re-enabled
    // by accident.
    const k = kernel();
    for (const stat of ['p50', 'p90', 'p99', 'decile', 'iqr']) {
      expect(k.aggregate({ stat, metric: 'baseSalary' }).status).toBe('refused');
    }
  });
});

describe('A2b — zero-variance cohorts', () => {
  /**
   * The second critical finding. `equityValue` is zero for every L1 and L2 employee, so a mean of
   * zero proved every member was exactly zero: 1,305 exact values in a single call.
   *
   * Excluding `stddev` prevents asking about dispersion. It does not prevent dispersion being
   * zero, which is why the gate inspects realised values rather than the statistic's name.
   */
  it('withholds a mean for any cohort whose values are all identical', () => {
    const k = kernel();
    const r = k.aggregate({ stat: 'mean', metric: 'equityValue', groupBy: ['level'] });
    expect(r.status).toBe('ok');
    const cells = (r as { cells: { group: Record<string, string>; value?: number }[] }).cells;

    // L1 and L2 have no equity at all in this fixture, so both are homogeneous.
    for (const level of ['L1', 'L2']) {
      const cell = cells.find((c) => c.group.level === level);
      expect(cell, `${level} must be present`).toBeDefined();
      expect(cell!.value, `${level} equity mean must be withheld`).toBeUndefined();
    }

    // Levels that genuinely vary are still reportable, so the gate is not simply refusing
    // everything.
    const l6 = cells.find((c) => c.group.level === 'L6');
    expect(l6!.value).toBeDefined();
  });
});

describe('A3 — moment reconstruction', () => {
  it('cannot assemble count, mean and dispersion for the same cohort', () => {
    const k = kernel();
    // The attack needs stddev. Six equations on five unknowns collapses to five on five without
    // it, which is not solvable for the extremes.
    expect(k.aggregate({ stat: 'stddev', metric: 'baseSalary', groupBy: ['level'] })).toMatchObject({
      code: 'STAT_NOT_PERMITTED'
    });
    expect(k.aggregate({ stat: 'variance', metric: 'baseSalary' })).toMatchObject({
      code: 'STAT_NOT_PERMITTED'
    });
    expect(k.aggregate({ stat: 'sum', metric: 'baseSalary' })).toMatchObject({
      code: 'STAT_NOT_PERMITTED'
    });
  });
});

describe('A4 — histogram bin sweeping', () => {
  it('exposes no agent-controllable binning', () => {
    const k = kernel();
    // Value-axis differencing requires control over bin edges. There is no bins parameter and
    // no histogram tool: charts are drawn from the same cells any other query returns.
    const r = k.aggregate({
      stat: 'mean',
      metric: 'baseSalary',
      groupBy: ['level'],
      // @ts-expect-error deliberately passing an unsupported parameter
      bins: 30
    });
    expect(r.status).toBe('ok');
    // The extra parameter is ignored rather than honoured.
    const cells = (r as { cells: unknown[] }).cells;
    expect(cells.length).toBe(7);
  });
});

describe('A5 — regression leverage', () => {
  it('exposes no regression, coefficients, degrees of freedom or R-squared', () => {
    const k = kernel();
    const out = JSON.stringify(
      k.aggregate({ stat: 'mean', metric: 'baseSalary', groupBy: ['level', 'gender'] })
    );
    for (const leak of ['coefficient', 'dof', 'rSquared', 'stderr', 'pValue', 'residual']) {
      expect(out).not.toMatch(new RegExp(leak, 'i'));
    }
  });
});

describe('A6 — low-cardinality metric inversion', () => {
  it('applies the numeric floor to bonus and equity as strictly as to salary', () => {
    const k = kernel();
    for (const metric of ['bonusPct', 'equityValue']) {
      const r = k.aggregate({ stat: 'mean', metric, groupBy: ['level', 'location'] });
      const cells = (r as { cells: { count: unknown; value?: number }[] }).cells;
      for (const c of cells) {
        if (c.count === '<5' || c.count === '5-9') expect(c.value).toBeUndefined();
      }
    }
  });
});

describe('A7 — cohort narrowing to a single person', () => {
  it('refuses to combine more than two dimensions', () => {
    const k = kernel();
    const attempts = [
      ['level', 'location', 'gender'],
      ['level', 'fn', 'location'],
      ['gender', 'ethnicityBand', 'level', 'fn']
    ];
    for (const groupBy of attempts) {
      expect(k.aggregate({ stat: 'mean', metric: 'baseSalary', groupBy })).toMatchObject({
        code: 'GROUP_BY_TOO_DEEP'
      });
    }
  });

  it('withholds values for the narrowest reachable cohorts', () => {
    const k = kernel();
    const r = k.aggregate({ stat: 'mean', metric: 'baseSalary', groupBy: ['level', 'location'] });
    const cells = (r as { cells: { count: unknown; value?: number; withheld?: true }[] }).cells;
    const withheld = cells.filter((c) => c.withheld);
    // The fixture is shaped so that some cohorts at depth 2 genuinely fall below the floor.
    expect(withheld.length).toBeGreaterThan(0);
  });
});

describe('A8 — marginal reconstruction by differencing', () => {
  it('denies exact counts for the small cohorts a differencing attack needs', () => {
    const k = kernel();
    const r = k.aggregate({ stat: 'count', groupBy: ['level', 'location'] });
    const cells = (r as { cells: { count: number | string }[] }).cells;
    const exact = cells.filter((c) => typeof c.count === 'number');
    // Exact counts exist only for large cohorts; differencing needs precision at the margins.
    for (const c of exact) expect(c.count as number).toBeGreaterThanOrEqual(50);
  });

  it('charges budget for every disclosure, so span attacks are bounded', () => {
    const k = new Kernel(40);
    k.loadSample();
    let refused = false;
    for (let i = 0; i < 50 && !refused; i++) {
      const r = k.aggregate({
        stat: 'mean',
        metric: 'baseSalary',
        groupBy: ['level', 'fn']
      });
      refused = (r as { code?: string }).code === 'BUDGET_EXHAUSTED';
    }
    expect(refused).toBe(true);
  });
});

describe('A9 — suppression pattern walking', () => {
  it('returns the same key set regardless of which cohorts are populated', () => {
    const full = kernel();
    const sparse = new Kernel(Number.MAX_SAFE_INTEGER);
    sparse.loadSample({ count: 80 });

    const keys = (k: Kernel) => {
      const r = k.aggregate({ stat: 'count', groupBy: ['level', 'location'] });
      return (r as { cells: { group: Record<string, string> }[] }).cells
        .map((c) => `${c.group.level}|${c.group.location}`)
        .sort();
    };

    // A sparse dataset must not produce a smaller table: omission would reveal which cohorts
    // are empty or tiny, which is the pattern this attack walks.
    expect(keys(sparse)).toEqual(keys(full));
  });

  it('charges for refusals, so refusal is not a free oracle', () => {
    const k = new Kernel(10);
    k.loadSample();
    const before = k.remaining;
    k.aggregate({ stat: 'max', metric: 'baseSalary' });
    expect(k.remaining).toBeLessThan(before);
  });

  it('gives refusal text that cannot depend on the data', () => {
    const k = kernel();
    const a = k.aggregate({ stat: 'mean', metric: 'baseSalary', groupBy: ['a', 'b', 'c'] });
    const b = k.aggregate({ stat: 'mean', metric: 'baseSalary', groupBy: ['x', 'y', 'z'] });
    expect((a as { reason: string }).reason).toBe((b as { reason: string }).reason);
  });
});

describe('A10 — reading the ledger for values', () => {
  it('records questions but never answers', () => {
    const k = kernel();
    k.aggregate({ stat: 'mean', metric: 'baseSalary', groupBy: ['level'] });
    const ledger = k.getLedger();

    const whole = JSON.stringify(ledger);
    expect(whole).not.toMatch(/"cells"/);
    expect(whole).not.toMatch(/"value"/);

    // The claim is about the recorded question, so it is asserted on `spec`. Checking the whole
    // entry would trip on the budget counters, which are metadata about disclosure rather than
    // disclosure — and a currency figure has no business appearing in a query specification.
    for (const e of ledger) {
      const spec = JSON.stringify(e.spec);
      expect(spec, `entry ${e.seq}`).not.toMatch(/\b\d{4,}\b/);
    }
  });
});

describe('A11 — metadata and profiling leaks', () => {
  it('returns no sample values or cohort sizes from the profile', () => {
    const k = kernel();
    const p = JSON.stringify(k.profile());
    // Dimension value lists are declared enums and are safe. Individual figures are not.
    expect(p).not.toMatch(/baseSalary"\s*:\s*\d/);
    expect(p).not.toMatch(/"sample"/);
    expect(p).not.toMatch(/"rows"/);
    expect(p).not.toMatch(/"examples"/);
  });
});

describe('A12 — override abuse', () => {
  it('clamps a human-granted override so it can never approach the count floor', () => {
    const k = kernel();
    const r = k.aggregate({
      stat: 'mean',
      metric: 'baseSalary',
      groupBy: ['level', 'location'],
      numericFloorOverride: 1
    });
    const cells = (r as { cells: { count: unknown; value?: number }[] }).cells;
    // Even with an override requesting a floor of 1, nothing below the '5-9' band is reported.
    for (const c of cells) {
      if (c.count === '<5' || c.count === '5-9') expect(c.value).toBeUndefined();
    }
  });

  it('ignores a non-finite override instead of disabling the floor', () => {
    // `n < NaN` is always false, so a NaN override previously turned the floor off entirely and
    // cohorts of five reported means.
    const k = kernel();
    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = k.aggregate({
        stat: 'mean',
        metric: 'baseSalary',
        groupBy: ['level', 'location'],
        numericFloorOverride: bad
      });
      const cells = (r as { cells: { count: unknown; value?: number }[] }).cells;
      for (const c of cells) {
        if (c.count === '<5' || c.count === '5-9') {
          expect(c.value, `floor disabled by ${String(bad)}`).toBeUndefined();
        }
      }
    }
  });

  it('cannot raise the floor above the standing policy', () => {
    const k = kernel();
    const r = k.aggregate({
      stat: 'mean',
      metric: 'baseSalary',
      groupBy: ['level'],
      numericFloorOverride: 5000
    });
    // Clamped to the standing floor, so a large grouping still reports.
    expect(valuesOf(r).length).toBeGreaterThan(0);
  });

  it('records the override in the ledger with its identifier', () => {
    const k = kernel();
    k.aggregate({
      stat: 'mean',
      metric: 'baseSalary',
      groupBy: ['level', 'location'],
      numericFloorOverride: 10,
      overrideId: 'ovr-test-1'
    });
    const last = k.getLedger().at(-1)!;
    expect(JSON.stringify(last.spec)).toMatch(/ovr-test-1/);
    expect(JSON.stringify(last.spec)).toMatch(/numericFloor/);
  });
});

describe('summary: every disclosed value came from a large enough cohort', () => {
  /**
   * The strongest available check, because it verifies the floor against ground truth the kernel
   * never exposed.
   *
   * The kernel reports cohort sizes as bands, so an external observer cannot tell whether a
   * '10-24' cohort cleared a floor of 20. Here the test computes the true size from the raw
   * population and asserts that every cell carrying a value came from a cohort of at least
   * N_NUMERIC_FLOOR.
   *
   * Note what is deliberately NOT asserted: that no disclosed aggregate ever equals some
   * individual's salary. That coincidence is inevitable and harmless. Quantizing 5,000 people
   * onto a ~900-point grid guarantees collisions, and knowing that the mean of twenty-plus
   * people is $80,500 says nothing about who holds $80,500 or whether anyone does. Treating
   * that as a leak would be security theatre.
   */
  it('holds across the whole permitted surface', () => {
    const k = kernel();
    let checked = 0;

    const groupings: string[][] = [
      [],
      ['level'],
      ['fn'],
      ['gender'],
      ['level', 'gender'],
      ['fn', 'gender'],
      ['level', 'fn'],
      ['level', 'location'],
      ['ethnicityBand', 'level'],
      ['tenureBand', 'fn']
    ];

    for (const stat of ['mean']) {
      for (const groupBy of groupings) {
        const r = k.aggregate({ stat, metric: 'baseSalary', groupBy });
        expect(r.status).toBe('ok');
        const cells = (r as { cells: { group: Record<string, string>; value?: number }[] }).cells;

        for (const cell of cells) {
          if (cell.value === undefined) continue;

          // True cohort size, from data the kernel never released.
          const trueSize = truth.filter((e) =>
            groupBy.every((d) => String(e[d as keyof typeof e]) === cell.group[d])
          ).length;

          expect(
            trueSize,
            `${stat} of baseSalary by ${groupBy.join('×') || 'all'} disclosed a value for a `
              + `cohort of ${trueSize}: ${JSON.stringify(cell.group)}`
          ).toBeGreaterThanOrEqual(N_NUMERIC_FLOOR);
          checked++;
        }
      }
    }

    // Guard against the loop silently checking nothing.
    expect(checked).toBeGreaterThan(200);
  });
});
