/**
 * Seeded synthetic dataset generator.
 *
 * Generated at runtime rather than shipped as a fixture, for two honest reasons: the repo stays
 * small, and the planted gap stays tunable. It is NOT a defence against an agent reading the
 * repo — the generator is in the repo and is deterministic, so the generator *is* the fixture.
 * That claim appeared in an earlier draft and was wrong.
 *
 * Three properties matter for the demo to work:
 *
 *  1. Roughly 5,000 records. Small enough to be instant, large enough that "just paste it into
 *     the chat window" stops being a serious answer.
 *  2. Cohorts at group-by depth 2 mostly clear N_NUMERIC_FLOOR, so real analysis succeeds.
 *  3. Some cohorts genuinely fall below it, so refusals occur naturally rather than being
 *     staged. Uneven location headcounts do that work.
 */

import {
  ETHNICITY_BANDS,
  FUNCTIONS,
  GENDERS,
  LEVELS,
  LOCATIONS,
  TENURE_BANDS,
  type Employee,
  type EthnicityBand,
  type Fn,
  type Gender,
  type Level,
  type Location,
  type TenureBand
} from './schema.js';

/* ------------------------------------------------------------------ *
 * Deterministic PRNG                                                 *
 * ------------------------------------------------------------------ */

/** mulberry32. Small, fast, good enough for synthetic data, fully reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, so salaries are normally distributed within a band rather than uniform. */
function gaussian(r: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

/** Weighted pick. Weights need not sum to 1. */
function weighted<T>(r: () => number, xs: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r() * total;
  for (let i = 0; i < xs.length; i++) {
    x -= weights[i]!;
    if (x <= 0) return xs[i]!;
  }
  return xs[xs.length - 1]!;
}

/* ------------------------------------------------------------------ *
 * Compensation model                                                 *
 * ------------------------------------------------------------------ */

/** Band midpoints by level, in USD. Roughly a real tech-company ladder. */
const BAND_MIDPOINT: Record<Level, number> = {
  L1: 72_000,
  L2: 95_000,
  L3: 128_000,
  L4: 162_000,
  L5: 205_000,
  L6: 260_000,
  L7: 330_000
};

/** Within-band dispersion as a fraction of midpoint. Tighter at junior levels, as in practice. */
const BAND_SPREAD: Record<Level, number> = {
  L1: 0.08, L2: 0.09, L3: 0.10, L4: 0.11, L5: 0.13, L6: 0.15, L7: 0.18
};

/** Cost-of-labour multipliers. */
const LOCATION_FACTOR: Record<Location, number> = {
  London: 1.0,
  Berlin: 0.92,
  Austin: 1.04,
  Toronto: 0.88,
  Bangalore: 0.42,
  Remote: 0.95
};

/** Function premia. Engineering and Sales run hot; Support runs cold. */
const FN_FACTOR: Record<Fn, number> = {
  Engineering: 1.12,
  Product: 1.06,
  Design: 1.0,
  Sales: 1.08,
  Marketing: 0.97,
  Support: 0.86,
  Operations: 0.93
};

/** Tenure creep from merit cycles. */
const TENURE_FACTOR: Record<TenureBand, number> = {
  '<1y': 0.97, '1-3y': 1.0, '3-5y': 1.04, '5y+': 1.09
};

/**
 * The planted inequity, expressed as a multiplier on base salary.
 *
 * Deliberately NOT uniform. A flat company-wide gap would be findable in one query and would
 * make the audit trivial. Instead it is concentrated in Engineering and Sales — the two
 * highest-paying functions — and is larger at senior levels, which is the pattern real pay
 * studies find. The agent has to segment to see it, which is the whole point.
 *
 * A uniform unexplained gap of this size across a 5,000-person population would also be
 * implausibly large; concentrating it keeps the fixture defensible.
 */
function equityPenalty(gender: Gender, fn: Fn, level: Level): number {
  if (gender !== 'Female') return 1.0;
  const concentrated = fn === 'Engineering' || fn === 'Sales';
  if (!concentrated) return 0.995; // near-parity elsewhere: noise, not signal
  const senior = level === 'L5' || level === 'L6' || level === 'L7';
  return senior ? 0.925 : 0.965;
}

/* ------------------------------------------------------------------ *
 * Population shape                                                   *
 * ------------------------------------------------------------------ */

// Pyramid: most people in the middle, few at L7.
const LEVEL_WEIGHTS = [10, 16, 22, 20, 16, 10, 6];

// Engineering-heavy, as most tech companies are.
const FN_WEIGHTS = [30, 8, 6, 18, 10, 16, 12];

// Deliberately uneven. Bangalore and Berlin are large; Toronto is small. Small sites produce
// genuinely sub-floor cohorts at depth 2, so refusals arise from the data rather than staging.
const LOCATION_WEIGHTS = [22, 18, 16, 6, 26, 12];

const TENURE_WEIGHTS = [18, 34, 28, 20];

// Under-representation of women at senior levels is itself part of the story the audit finds.
const GENDER_WEIGHTS_JUNIOR = [46, 51, 3];
const GENDER_WEIGHTS_SENIOR = [31, 66, 3];

const ETHNICITY_WEIGHTS = [34, 24, 18, 16, 8];

export interface GenerateOptions {
  seed?: number;
  count?: number;
}

export function generateEmployees(opts: GenerateOptions = {}): Employee[] {
  const seed = opts.seed ?? 20260826;
  const count = opts.count ?? 5000;
  const r = rng(seed);

  const out: Employee[] = [];

  for (let id = 1; id <= count; id++) {
    const level = weighted(r, LEVELS, LEVEL_WEIGHTS) as Level;
    const fn = weighted(r, FUNCTIONS, FN_WEIGHTS) as Fn;
    const location = weighted(r, LOCATIONS, LOCATION_WEIGHTS) as Location;
    const tenureBand = weighted(r, TENURE_BANDS, TENURE_WEIGHTS) as TenureBand;

    const senior = level === 'L5' || level === 'L6' || level === 'L7';
    const gender = weighted(
      r,
      GENDERS,
      senior ? GENDER_WEIGHTS_SENIOR : GENDER_WEIGHTS_JUNIOR
    ) as Gender;

    const ethnicityBand = weighted(r, ETHNICITY_BANDS, ETHNICITY_WEIGHTS) as EthnicityBand;

    const midpoint =
      BAND_MIDPOINT[level] *
      LOCATION_FACTOR[location] *
      FN_FACTOR[fn] *
      TENURE_FACTOR[tenureBand] *
      equityPenalty(gender, fn, level);

    // Clamp to +/- 3 sigma so a single outlier cannot dominate a cohort mean.
    const z = Math.max(-3, Math.min(3, gaussian(r)));
    const baseSalary = Math.max(30_000, Math.round(midpoint * (1 + z * BAND_SPREAD[level])));

    // Bonus target rises with level; Sales carries a larger variable component.
    const bonusTarget =
      (0.05 + LEVELS.indexOf(level) * 0.02) * (fn === 'Sales' ? 1.9 : 1.0);
    const bonusPct = Math.max(0, Math.round((bonusTarget + gaussian(r) * 0.015) * 1000) / 1000);

    // Equity is heavily level-weighted and zero for many junior staff.
    const equityBase = level === 'L1' || level === 'L2' ? 0 : BAND_MIDPOINT[level] * 0.35;
    const equityValue = Math.max(
      0,
      Math.round((equityBase * (1 + gaussian(r) * 0.4)) / 100) * 100
    );

    out.push({
      id,
      level,
      fn,
      location,
      tenureBand,
      gender,
      ethnicityBand,
      baseSalary,
      bonusPct,
      equityValue
    });
  }

  return out;
}
