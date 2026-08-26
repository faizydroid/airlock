/**
 * The kernel. The ONLY module permitted to hold or read raw records.
 *
 * Every number that reaches a tool response, the DOM, or a canvas comes out of `aggregate()`,
 * `adjustedGap()` or `profile()`. Nothing else may import `Employee` values. That boundary is
 * enforced by `boundary.test.ts`, which scans the source tree and fails the build, because a
 * chart component quietly importing raw rows is the most plausible way the invariant breaks
 * under time pressure.
 *
 * See docs/threat-model.md.
 */

import {
  DIMENSIONS,
  METRICS,
  type Dimension,
  type Employee,
  type Metric
} from '../data/schema.js';
import { generateEmployees } from '../data/generate.js';
import {
  BUDGET_CELLS,
  COUNT_EXACT_FLOOR,
  MAX_GROUP_BY_DEPTH,
  MIN_STRATA,
  N_NUMERIC_FLOOR,
  WITHDRAWN_STATS,
  bandCount,
  isAllowedStat,
  isNumericStat,
  outputPermitted,
  quantize,
  refuse,
  type CountBand,
  type Refusal,
  type Stat
} from './policy.js';

/* ------------------------------------------------------------------ *
 * Result shapes                                                      *
 * ------------------------------------------------------------------ */

export interface Cell {
  /** Dimension values identifying this cohort. Empty for a whole-population query. */
  group: Record<string, string>;
  /** Banded below COUNT_EXACT_FLOOR, exact above it. */
  count: CountBand;
  /** Quantized statistic. Absent when the cohort is below the numeric floor. */
  value?: number;
  /** Present instead of `value` when the cohort was too small to report on. */
  withheld?: true;
}

export interface AggregateOk {
  status: 'ok';
  stat: Stat;
  metric: Metric | null;
  groupBy: Dimension[];
  cells: Cell[];
  /** Charged units and what remains. Precision costs; coarse shape is free. */
  budget: { charged: number; remaining: number };
}

export type Disclosure = AggregateOk | Refusal;

export interface AdjustedGapCell {
  group: string;
  /** Percentage points, quantized. Null when no stratum was usable. */
  gapPct: number | null;
  /** How many strata contributed, as a band. Exact counts are not disclosed. */
  strataUsed: CountBand;
  withheld?: true;
}

export interface AdjustedGapOk {
  status: 'ok';
  metric: Metric;
  dimension: Dimension;
  reference: string;
  controlFor: Dimension[];
  note: string;
  results: AdjustedGapCell[];
  budget: { charged: number; remaining: number };
}

export interface AggregateSpec {
  stat: string;
  metric?: string | undefined;
  groupBy?: string[] | undefined;
  /**
   * A relaxed numeric floor, granted by an explicit human decision in the page.
   *
   * The agent cannot reach this. The tool layer never passes it; only the UI's approve handler
   * does, in response to a click. It is clamped to OVERRIDE_FLOOR_MIN regardless of what is
   * requested, so an override can relax the floor but never approach the count floor.
   */
  numericFloorOverride?: number | undefined;
  /** Ledger cross-reference for the human decision that granted the override. */
  overrideId?: string | undefined;
}

/**
 * The lowest numeric floor a human override can reach.
 *
 * Deliberately still well above K_COUNT_FLOOR. At n=5 the median is exactly one person's
 * salary; no human decision inside this app is allowed to authorise that, because the point of
 * the override is to trade a little precision for a documented reason, not to disable the
 * mechanism.
 */
export const OVERRIDE_FLOOR_MIN = 10;

export interface Profile {
  status: 'ok';
  rowCount: number;
  dimensions: Record<string, readonly string[]>;
  metrics: Record<string, string>;
  policy: {
    countFloor: number;
    numericFloor: number;
    maxGroupByDepth: number;
    exactCountFloor: number;
  };
  budget: { charged: number; remaining: number };
}

export interface LedgerEntry {
  seq: number;
  at: string;
  op: string;
  /** What was asked. Never what was returned. */
  spec: Record<string, unknown>;
  outcome: 'ok' | 'refused';
  code?: string;
  charged: number;
  remaining: number;
}

/* ------------------------------------------------------------------ *
 * Statistics                                                         *
 * ------------------------------------------------------------------ */

function computeStat(stat: Stat, values: number[]): number {
  if (stat === 'mean') return values.reduce((a, b) => a + b, 0) / values.length;
  // 'count' is handled before this point, and order statistics were withdrawn — see the note on
  // ALLOWED_STATS in policy.ts.
  throw new Error(`unreachable stat: ${stat}`);
}

/* ------------------------------------------------------------------ *
 * Kernel                                                             *
 * ------------------------------------------------------------------ */

export class Kernel {
  /** Raw records. Never escapes this class. */
  #rows: Employee[] | null = null;
  #charged = 0;
  #budget: number;
  #ledger: LedgerEntry[] = [];
  #seq = 0;

  constructor(budget = BUDGET_CELLS) {
    this.#budget = budget;
  }

  get loaded(): boolean {
    return this.#rows !== null;
  }

  get remaining(): number {
    return Math.max(0, this.#budget - this.#charged);
  }

  /**
   * The current total, which grows when a human extends it.
   *
   * Exposed because the UI previously computed "spent" against the imported BUDGET_CELLS
   * constant. After an extension the header rendered a negative figure and a negative progress
   * bar — reachable in two clicks from a button the toolbar advertises.
   */
  get budgetTotal(): number {
    return this.#budget;
  }

  loadSample(opts: { seed?: number; count?: number } = {}): Profile | Refusal {
    this.#rows = generateEmployees(opts);
    this.#record('load_sample', { ...opts }, 'ok', 0);
    return this.profile() as Profile;
  }

  /**
   * Schema and policy description. Deliberately contains no values, no example rows, and no
   * cohort sizes — profiling helpers that return sample values are a common accidental leak.
   */
  profile(): Profile | Refusal {
    if (!this.#rows) return this.#refuseAndRecord('profile', {}, 'NO_DATASET');
    const dimensions: Record<string, readonly string[]> = {};
    for (const [k, v] of Object.entries(DIMENSIONS)) dimensions[k] = v;
    const metrics: Record<string, string> = {};
    for (const [k, v] of Object.entries(METRICS)) metrics[k] = v.label;

    this.#record('profile', {}, 'ok', 0);
    return {
      status: 'ok',
      rowCount: this.#rows.length,
      dimensions,
      metrics,
      policy: {
        countFloor: 5,
        numericFloor: N_NUMERIC_FLOOR,
        maxGroupByDepth: MAX_GROUP_BY_DEPTH,
        exactCountFloor: COUNT_EXACT_FLOOR
      },
      budget: { charged: this.#charged, remaining: this.remaining }
    };
  }

  /**
   * The single analysis entry point.
   *
   * Returns the FULL cross-product of the requested grouping, including cohorts that are empty
   * or below the floor, each carrying only a band. This is deliberate: if sub-floor cohorts were
   * omitted, the set of returned keys would itself reveal which cohorts are small, and that
   * pattern can be walked to locate the cohorts where the remaining attacks are strongest.
   * Returning every key makes an empty cohort and a four-person cohort indistinguishable.
   */
  aggregate(spec: AggregateSpec): Disclosure {
    // The effective floor. Clamped so an override can only ever relax toward
    // OVERRIDE_FLOOR_MIN, never below it, and never above the standing floor.
    // Number.isFinite guards the NaN case. `n < NaN` is always false, so a non-finite override
    // would have disabled the floor entirely rather than relaxing it — cohorts of five would
    // have reported means.
    const requested = spec.numericFloorOverride;
    const floor =
      requested === undefined || !Number.isFinite(requested)
        ? N_NUMERIC_FLOOR
        : Math.min(N_NUMERIC_FLOOR, Math.max(OVERRIDE_FLOOR_MIN, requested));

    const asked = {
      stat: spec.stat,
      metric: spec.metric,
      groupBy: spec.groupBy,
      ...(floor !== N_NUMERIC_FLOOR ? { numericFloor: floor, overrideId: spec.overrideId } : {})
    };

    if (!this.#rows) return this.#refuseAndRecord('aggregate', asked, 'NO_DATASET');

    if ((WITHDRAWN_STATS as readonly string[]).includes(spec.stat)) {
      // Named separately from STAT_NOT_PERMITTED so the agent learns the reason rather than
      // merely that the name is unknown.
      return this.#refuseAndRecord('aggregate', asked, 'STAT_WITHDRAWN');
    }
    if (!isAllowedStat(spec.stat)) {
      return this.#refuseAndRecord('aggregate', asked, 'STAT_NOT_PERMITTED');
    }
    const stat: Stat = spec.stat;

    const groupBy = (spec.groupBy ?? []) as Dimension[];
    if (groupBy.length > MAX_GROUP_BY_DEPTH) {
      return this.#refuseAndRecord('aggregate', asked, 'GROUP_BY_TOO_DEEP');
    }
    for (const d of groupBy) {
      if (!(d in DIMENSIONS)) {
        return this.#refuseAndRecord('aggregate', asked, 'UNKNOWN_DIMENSION');
      }
    }

    let metric: Metric | null = null;
    if (isNumericStat(stat)) {
      if (!spec.metric || !(spec.metric in METRICS)) {
        return this.#refuseAndRecord('aggregate', asked, 'UNKNOWN_METRIC');
      }
      metric = spec.metric as Metric;
    }

    if (this.remaining <= 0) {
      return this.#refuseAndRecord('aggregate', asked, 'BUDGET_EXHAUSTED');
    }

    // Bucket the rows.
    const buckets = new Map<string, Employee[]>();
    for (const combo of crossProduct(groupBy)) {
      buckets.set(keyOf(combo), []);
    }
    for (const row of this.#rows) {
      const key = keyOf(Object.fromEntries(groupBy.map((d) => [d, String(row[d])])));
      const b = buckets.get(key);
      if (b) b.push(row);
    }

    const unit = metric ? METRICS[metric].unit : 'count';
    const cells: Cell[] = [];
    let charged = 0;

    for (const [key, rows] of buckets) {
      const group = parseKey(key, groupBy);
      const n = rows.length;
      const band = bandCount(n);

      // Precision costs budget; a coarse band does not.
      if (typeof band === 'number') charged += 1;

      if (!isNumericStat(stat)) {
        cells.push({ group, count: band });
        continue;
      }

      if (n < floor) {
        cells.push({ group, count: band, withheld: true });
        continue;
      }

      const values = rows.map((r) => r[metric!] as number);

      // The post-computation gate. Every check above inspected the request; this one inspects
      // the realised cohort. A zero-variance cohort discloses every member exactly, and no
      // amount of cohort size or statistic allow-listing prevents that.
      const verdict = outputPermitted(values);
      if (!verdict.ok) {
        cells.push({ group, count: band, withheld: true });
        continue;
      }

      cells.push({ group, count: band, value: quantize(computeStat(stat, values), unit) });
      charged += 1;
    }

    // The budget is a bound, not a trigger. Checking only that something remained before
    // computing allowed a single query to overrun by any margin: with 4 units left, one grouped
    // query could charge 84 and release 48 values.
    if (charged > this.remaining) {
      return this.#refuseAndRecord('aggregate', asked, 'BUDGET_INSUFFICIENT');
    }

    this.#charged += charged;
    this.#record('aggregate', asked, 'ok', charged);

    return {
      status: 'ok',
      stat,
      metric,
      groupBy,
      cells,
      budget: { charged, remaining: this.remaining }
    };
  }

  /**
   * Headcount-weighted within-stratum gap, adjusted for confounders.
   *
   * This exists because of a genuine tension between the disclosure policy and the analysis.
   * Isolating a pay gap requires comparing like with like — the same level, the same function —
   * which is three grouping dimensions, and MAX_GROUP_BY_DEPTH forbids that for good reason.
   * Meanwhile the two-dimensional views are actively misleading: a raw gap by function is
   * dominated by level composition, and a raw gap by level is diluted across functions.
   *
   * The resolution is to do the stratification inside the kernel and disclose the result rather
   * than the ingredients. This releases strictly LESS than the equivalent table would:
   *
   *   - one quantized percentage per group, not a cell per stratum
   *   - strata are only included when BOTH compared cohorts clear the numeric floor
   *   - coverage is reported as a band, so the number of usable strata is not exposed
   *   - no coefficients, no standard errors, no degrees of freedom, no per-stratum figures
   *
   * Regression diagnostics were deliberately not used. A coefficient is a linear functional whose
   * weights can concentrate on a single row, and degrees of freedom leak the exact n that count
   * banding exists to hide.
   */
  adjustedGap(spec: {
    metric: string;
    dimension: string;
    reference: string;
    controlFor?: string[] | undefined;
  }): Disclosure | AdjustedGapOk {
    const asked = {
      metric: spec.metric,
      dimension: spec.dimension,
      reference: spec.reference,
      controlFor: spec.controlFor
    };

    if (!this.#rows) return this.#refuseAndRecord('adjusted_gap', asked, 'NO_DATASET');
    if (!(spec.metric in METRICS)) {
      return this.#refuseAndRecord('adjusted_gap', asked, 'UNKNOWN_METRIC');
    }
    if (!(spec.dimension in DIMENSIONS)) {
      return this.#refuseAndRecord('adjusted_gap', asked, 'UNKNOWN_DIMENSION');
    }

    const controls = (spec.controlFor ?? []) as Dimension[];

    // Depth accounting must include the compared dimension itself. Counting only `controlFor`
    // let this tool build depth-3 cohorts — dimension plus two controls — and release a bare
    // ratio from a single one of them, at a depth `aggregate` forbids. That defeated the very
    // cap this tool exists to respect. See MIN_STRATA below for the second half of the fix.
    if (1 + controls.length > MAX_GROUP_BY_DEPTH + 1) {
      return this.#refuseAndRecord('adjusted_gap', asked, 'GROUP_BY_TOO_DEEP');
    }
    for (const d of controls) {
      if (!(d in DIMENSIONS)) {
        return this.#refuseAndRecord('adjusted_gap', asked, 'UNKNOWN_DIMENSION');
      }
    }
    if (this.remaining <= 0) {
      return this.#refuseAndRecord('adjusted_gap', asked, 'BUDGET_EXHAUSTED');
    }

    const dim = spec.dimension as Dimension;
    const metric = spec.metric as Metric;
    const groups = DIMENSIONS[dim];

    if (!groups.includes(spec.reference as never)) {
      return this.#refuseAndRecord('adjusted_gap', asked, 'UNKNOWN_DIMENSION');
    }

    // Stratum key over the control dimensions only.
    const stratumKey = (row: Employee) => controls.map((c) => String(row[c])).join(SEP);

    const strata = new Map<string, Employee[]>();
    for (const row of this.#rows) {
      const key = stratumKey(row);
      const bucket = strata.get(key);
      if (bucket) bucket.push(row);
      else strata.set(key, [row]);
    }

    const results: AdjustedGapCell[] = [];
    let charged = 0;

    for (const group of groups) {
      if (group === spec.reference) continue;

      let weighted = 0;
      let weight = 0;
      let included = 0;

      for (const rows of strata.values()) {
        const a = rows.filter((r) => String(r[dim]) === group);
        const b = rows.filter((r) => String(r[dim]) === spec.reference);

        // Both sides must independently clear the floor, and both must survive the output gate.
        // A stratum where one side is homogeneous would contribute a ratio that discloses its
        // members exactly.
        if (!outputPermitted(a.map((r) => r[metric] as number)).ok) continue;
        if (!outputPermitted(b.map((r) => r[metric] as number)).ok) continue;

        const meanA = a.reduce((s, r) => s + (r[metric] as number), 0) / a.length;
        const meanB = b.reduce((s, r) => s + (r[metric] as number), 0) / b.length;
        if (meanB === 0) continue;

        // Equal weight per stratum rather than headcount weight. Headcount weighting made the
        // released figure a linear equation over the exact cohort sizes, so sweeping `reference`
        // produced independent equations over the same unknown headcount vector — recovering
        // precisely the counts that banding exists to hide.
        weighted += 1 - meanA / meanB;
        weight += 1;
        included++;
      }

      // A stratified figure computed from one or two strata is not stratified: it is that
      // stratum's ratio, released at a forbidden depth. Requiring several strata is what makes
      // the output genuinely an aggregate of aggregates.
      if (included < MIN_STRATA) {
        results.push({ group, gapPct: null, withheld: true, strataUsed: bandCount(included) });
        // Withheld results are charged. Leaving them free made this an unbounded oracle on the
        // floor structure of depth-3 cohorts: 500 calls cost nothing and mapped it exactly.
        charged += 1;
        continue;
      }

      results.push({
        group,
        // Quantized to half a percentage point. Fine enough to be actionable, coarse enough that
        // differencing across framings gains little.
        gapPct: quantize((weighted / weight) * 100, 'pp'),
        strataUsed: bandCount(included)
      });
      charged += 1;
    }

    if (charged > this.remaining) {
      return this.#refuseAndRecord('adjusted_gap', asked, 'BUDGET_INSUFFICIENT');
    }

    this.#charged += charged;
    this.#record('adjusted_gap', asked, 'ok', charged);

    return {
      status: 'ok',
      metric,
      dimension: dim,
      reference: spec.reference,
      controlFor: controls,
      note:
        'Positive means the group earns less than the reference, after comparing only within '
        + 'strata where both cohorts are large enough to report on.',
      results,
      budget: { charged, remaining: this.remaining }
    };
  }

  /** Extending the budget is a human action, recorded like any other. */
  extendBudget(by: number): { status: 'ok'; remaining: number } {
    this.#budget += Math.max(0, by);
    this.#record('extend_budget', { by }, 'ok', 0);
    return { status: 'ok', remaining: this.remaining };
  }

  /**
   * The disclosure ledger.
   *
   * Returns a defensive copy. The previous version handed out the live internal array, so any
   * caller — including the report builder, which embeds it — could truncate or rewrite the audit
   * trail with `ledger.length = 0`. An append-only record that callers can mutate is not a record.
   */
  getLedger(): readonly LedgerEntry[] {
    return this.#ledger.map((e) => ({ ...e, spec: { ...e.spec } }));
  }

  /* ---------------------------------------------------------------- */

  #record(
    op: string,
    spec: Record<string, unknown>,
    outcome: 'ok' | 'refused',
    charged: number,
    code?: string
  ): void {
    this.#ledger.push({
      seq: ++this.#seq,
      at: new Date().toISOString(),
      op,
      spec,
      outcome,
      ...(code ? { code } : {}),
      charged,
      remaining: this.remaining
    });
  }

  #refuseAndRecord(
    op: string,
    spec: Record<string, unknown>,
    code: Parameters<typeof refuse>[0]
  ): Refusal {
    const r = refuse(code);
    // Refusals are charged, so that refusal cannot be used as a free oracle.
    this.#charged += 1;
    this.#record(op, spec, 'refused', 1, code);
    return r;
  }
}

/* ------------------------------------------------------------------ *
 * Grouping helpers                                                   *
 * ------------------------------------------------------------------ */

function crossProduct(dims: Dimension[]): Record<string, string>[] {
  let acc: Record<string, string>[] = [{}];
  for (const d of dims) {
    const next: Record<string, string>[] = [];
    for (const base of acc) {
      for (const v of DIMENSIONS[d]) next.push({ ...base, [d]: v });
    }
    acc = next;
  }
  return acc;
}

const SEP = '\u0000';

function keyOf(group: Record<string, string>): string {
  return Object.values(group).join(SEP);
}

function parseKey(key: string, dims: Dimension[]): Record<string, string> {
  if (dims.length === 0) return {};
  const parts = key.split(SEP);
  return Object.fromEntries(dims.map((d, i) => [d, parts[i] ?? '']));
}
