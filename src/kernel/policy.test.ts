import { describe, it, expect } from 'vitest';
import {
  ALLOWED_STATS,
  BUDGET_CELLS,
  COUNT_EXACT_FLOOR,
  CURRENCY_QUANTUM,
  K_COUNT_FLOOR,
  MAX_GROUP_BY_DEPTH,
  NUMERIC_STATS,
  N_NUMERIC_FLOOR,
  WITHDRAWN_STATS,
  bandCount,
  isAllowedStat,
  isNumericStat,
  outputPermitted,
  quantize,
  quantizeCurrency,
  quantizePP,
  quantizeRatio,
  refuse,
  statPermittedAt,
  type RefusalCode
} from './policy.js';

/**
 * These are not unit tests in the ordinary sense. Each one pins a property that the product's
 * central claim depends on. A failure here means the claim is false, not that a function is
 * inconvenient.
 */

describe('statistics allow-list', () => {
  it('permits exactly count and mean', () => {
    expect([...ALLOWED_STATS]).toEqual(['count', 'mean']);
  });

  // Each of these was excluded for a specific published attack. Adding any one back re-opens it,
  // so the rejection is asserted by name.
  it.each(['min', 'max', 'stddev', 'variance', 'sum', 'mode', 'top', 'topN', 'range'])(
    'rejects %s',
    (bad) => {
      expect(isAllowedStat(bad)).toBe(false);
    }
  );

  /**
   * Order statistics were withdrawn after review demonstrated recovery of 53 exact salaries.
   *
   * The reason is structural rather than a matter of cohort size: an order statistic has an
   * influence support of one or two records however large the cohort, because with
   * index = (n-1)*q the result is a bare `sorted[i]` whenever that index is an integer. A cohort
   * floor cannot repair a statistic whose support does not grow with the cohort.
   *
   * These names are asserted individually so that reintroducing one is a deliberate act.
   */
  it.each([...WITHDRAWN_STATS])('rejects the withdrawn statistic %s', (bad) => {
    expect(isAllowedStat(bad)).toBe(false);
  });

  it('classifies every value-reading statistic as numeric', () => {
    expect(isNumericStat('mean')).toBe(true);
    expect(isNumericStat('count')).toBe(false);
  });

  it('keeps only statistics whose influence support grows with the cohort', () => {
    // mean gives every record weight 1/n. That is the property that makes a cohort floor
    // meaningful in the first place.
    for (const s of NUMERIC_STATS) expect(s).toBe('mean');
  });
});

describe('the post-computation output gate', () => {
  const many = Array.from({ length: 40 }, (_, i) => 50_000 + i * 500);

  it('permits a large, varied cohort', () => {
    expect(outputPermitted(many).ok).toBe(true);
  });

  it('refuses a cohort below the numeric floor', () => {
    expect(outputPermitted(many.slice(0, N_NUMERIC_FLOOR - 1)).ok).toBe(false);
  });

  /**
   * The second critical finding from review. `equityValue` is zero for every L1 and L2 employee,
   * so a mean of zero proved every member was zero — disclosing 1,305 exact values in one call.
   *
   * Excluding dispersion statistics does not protect against dispersion being zero.
   */
  it('refuses a zero-variance cohort however large', () => {
    expect(outputPermitted(Array(500).fill(0)).ok).toBe(false);
    expect(outputPermitted(Array(500).fill(120_000)).ok).toBe(false);
  });

  it('permits a cohort with a single dissenting value', () => {
    const nearly = Array(499).fill(0).concat([1]);
    expect(outputPermitted(nearly).ok).toBe(true);
  });

  it('inspects realised values rather than trusting the statistic name', () => {
    // The gate takes values, not a Stat. That is the whole point: safety is a property of the
    // output, not of the label on the request.
    expect(outputPermitted.length).toBe(1);
  });
});

describe('cohort size gates', () => {
  it('refuses every numeric statistic below the numeric floor', () => {
    for (let n = 0; n < N_NUMERIC_FLOOR; n++) {
      for (const s of NUMERIC_STATS) {
        expect(statPermittedAt(s, n), `${s} at n=${n}`).toBe(false);
      }
    }
  });

  it('permits numeric statistics at and above the numeric floor', () => {
    for (const s of NUMERIC_STATS) {
      expect(statPermittedAt(s, N_NUMERIC_FLOOR)).toBe(true);
    }
  });

  it('refuses counts below the k floor', () => {
    for (let n = 0; n < K_COUNT_FLOOR; n++) {
      expect(statPermittedAt('count', n), `count at n=${n}`).toBe(false);
    }
    expect(statPermittedAt('count', K_COUNT_FLOOR)).toBe(true);
  });

  // The numeric floor must sit well above the k floor. If they converge, order statistics
  // become individual values again: at n=5 the median is exactly the third salary.
  it('keeps the numeric floor far above the k floor', () => {
    expect(N_NUMERIC_FLOOR).toBeGreaterThanOrEqual(4 * K_COUNT_FLOOR);
  });
});

describe('count banding', () => {
  it('never discloses an exact count below the exact floor', () => {
    for (let n = 0; n < COUNT_EXACT_FLOOR; n++) {
      expect(typeof bandCount(n), `n=${n}`).toBe('string');
    }
  });

  it('discloses exact counts at and above the exact floor', () => {
    for (const n of [COUNT_EXACT_FLOOR, 51, 137, 5000]) {
      expect(bandCount(n)).toBe(n);
    }
  });

  it('maps to the documented bands', () => {
    expect(bandCount(0)).toBe('<5');
    expect(bandCount(4)).toBe('<5');
    expect(bandCount(5)).toBe('5-9');
    expect(bandCount(9)).toBe('5-9');
    expect(bandCount(10)).toBe('10-24');
    expect(bandCount(24)).toBe('10-24');
    expect(bandCount(25)).toBe('25-49');
    expect(bandCount(49)).toBe('25-49');
  });

  it('is monotonic: a larger cohort never reports a smaller band', () => {
    const order = ['<5', '5-9', '10-24', '25-49'];
    const rank = (b: ReturnType<typeof bandCount>) =>
      typeof b === 'number' ? order.length : order.indexOf(b);
    for (let n = 1; n < 200; n++) {
      expect(rank(bandCount(n))).toBeGreaterThanOrEqual(rank(bandCount(n - 1)));
    }
  });
});

describe('quantization', () => {
  it('rounds currency to the quantum', () => {
    for (const v of [0, 1, 249, 250, 251, 74_321, 199_999, 412_345.67]) {
      expect(quantizeCurrency(v) % CURRENCY_QUANTUM).toBe(0);
    }
  });

  it('rounds ratios to two decimal places', () => {
    expect(quantizeRatio(0.123456)).toBe(0.12);
    expect(quantizeRatio(1.005)).toBeCloseTo(1.0, 10);
    expect(quantizeRatio(0.877)).toBe(0.88);
  });

  it('rounds percentage points to the half point', () => {
    // Expressed as an integrality check rather than a modulo: negative inputs make `% 1`
    // return -0, which Object.is distinguishes from 0 and which is irrelevant to the property.
    for (const v of [0, 0.2, 0.3, 1.1, 4.74, 12.26, -3.4, -0.1]) {
      expect(Number.isInteger(quantizePP(v) * 2), `v=${v}`).toBe(true);
    }
  });

  it('leaves no unquantized value reachable through the dispatcher', () => {
    expect(quantize(74_321, 'currency') % CURRENCY_QUANTUM).toBe(0);
    expect(quantize(0.123456, 'ratio')).toBe(0.12);
    expect(Number.isInteger(quantize(4.74, 'pp') * 2)).toBe(true);
    expect(Number.isInteger(quantize(12.7, 'count'))).toBe(true);
  });
});

describe('refusals', () => {
  const codes: RefusalCode[] = [
    'INSUFFICIENT_SUPPORT',
    'STAT_NOT_PERMITTED',
    'GROUP_BY_TOO_DEEP',
    'UNKNOWN_DIMENSION',
    'UNKNOWN_METRIC',
    'BUDGET_EXHAUSTED',
    'NO_DATASET'
  ];

  it('returns a refusal value rather than throwing', () => {
    // The platform discards a rejected promise's reason: the caller gets a generic
    // UnknownError and the message is lost. A refusal the agent cannot read is useless.
    for (const c of codes) {
      expect(() => refuse(c)).not.toThrow();
      expect(refuse(c).status).toBe('refused');
    }
  });

  it('carries a reason and a recovery hint for every code', () => {
    for (const c of codes) {
      const r = refuse(c);
      expect(r.reason.length, c).toBeGreaterThan(10);
      expect(r.recovery.length, c).toBeGreaterThan(10);
    }
  });

  // A refusal that quotes the cohort size publishes the very number banding hides, and turns
  // each refusal into an oracle that can be walked to find the smallest cohorts.
  it('is a pure function of the code, so text cannot depend on data', () => {
    expect(refuse.length).toBe(1);
    for (const c of codes) {
      expect(refuse(c)).toEqual(refuse(c));
    }
  });

  it('never mentions a cohort size', () => {
    for (const c of codes) {
      const text = refuse(c).reason + ' ' + refuse(c).recovery;
      // Only policy constants may appear as digits, never observed counts.
      const digits = text.match(/\d+/g) ?? [];
      const allowed = new Set([String(MAX_GROUP_BY_DEPTH), '25', '75']);
      for (const d of digits) expect(allowed.has(d), `${c} leaked "${d}"`).toBe(true);
    }
  });

  it('stays within the agent-facing character budget', () => {
    // Chrome advises 1.5K per tool output. A refusal is the smallest possible response and
    // should be nowhere near it.
    for (const c of codes) {
      expect(JSON.stringify(refuse(c)).length, c).toBeLessThan(400);
    }
  });
});

describe('structural limits', () => {
  it('caps group-by depth', () => {
    expect(MAX_GROUP_BY_DEPTH).toBeLessThanOrEqual(2);
  });

  // The budget is denominated in released cells, not tool calls. Counting calls is the wrong
  // unit: one grouped query returns a whole table, so a call budget bounds almost nothing.
  it('keeps the cell budget well below the row count of the fixture', () => {
    expect(BUDGET_CELLS).toBeLessThan(5000);
  });
});
