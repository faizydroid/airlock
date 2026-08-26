/**
 * The dataset schema.
 *
 * Note what is absent: there are no free-text columns. A real compensation export would carry job
 * titles and performance notes; this schema has no field for either, so they cannot enter memory
 * at all. They are a prompt-injection vector, and rare term co-occurrence within a small cohort
 * is an identifying fingerprint. See docs/threat-model.md.
 *
 * The absence is structural rather than the result of filtering. There is no import path in this
 * build — the dataset is generated — so nothing is "stripped on load"; the columns simply do not
 * exist. If an import path is added later, dropping those columns during parsing becomes a
 * requirement rather than a property.
 *
 * Every dimension is a coarse enum. That is what makes the tool vocabulary bounded: the agent
 * selects from a fixed set rather than composing predicates.
 */

export const LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'] as const;
export type Level = (typeof LEVELS)[number];

export const FUNCTIONS = [
  'Engineering',
  'Product',
  'Design',
  'Sales',
  'Marketing',
  'Support',
  'Operations'
] as const;
export type Fn = (typeof FUNCTIONS)[number];

export const LOCATIONS = [
  'London',
  'Berlin',
  'Austin',
  'Toronto',
  'Bangalore',
  'Remote'
] as const;
export type Location = (typeof LOCATIONS)[number];

export const TENURE_BANDS = ['<1y', '1-3y', '3-5y', '5y+'] as const;
export type TenureBand = (typeof TENURE_BANDS)[number];

export const GENDERS = ['Female', 'Male', 'Other/undisclosed'] as const;
export type Gender = (typeof GENDERS)[number];

/**
 * Coarse bands rather than granular categories. Under GDPR these are special-category data
 * (Art. 9), so confirming membership in a small cohort is itself a disclosure, before any
 * salary is involved. Coarseness reduces the number of near-unique intersections.
 */
export const ETHNICITY_BANDS = ['Group A', 'Group B', 'Group C', 'Group D', 'Undisclosed'] as const;
export type EthnicityBand = (typeof ETHNICITY_BANDS)[number];

/** Groupable dimensions, and the complete permitted set. */
export const DIMENSIONS = {
  level: LEVELS,
  fn: FUNCTIONS,
  location: LOCATIONS,
  tenureBand: TENURE_BANDS,
  gender: GENDERS,
  ethnicityBand: ETHNICITY_BANDS
} as const;

export type Dimension = keyof typeof DIMENSIONS;
export const DIMENSION_NAMES = Object.keys(DIMENSIONS) as Dimension[];

/** Measurable metrics, and their units for quantization. */
export const METRICS = {
  baseSalary: { unit: 'currency', label: 'Base salary (USD)' },
  bonusPct: { unit: 'ratio', label: 'Bonus as a fraction of base' },
  equityValue: { unit: 'currency', label: 'Annual equity value (USD)' }
} as const;

export type Metric = keyof typeof METRICS;
export const METRIC_NAMES = Object.keys(METRICS) as Metric[];

/**
 * A single record. Never leaves the kernel, never reaches the DOM, never reaches a tool
 * response. The `id` is opaque and exists only so the generator is reproducible.
 */
export interface Employee {
  id: number;
  level: Level;
  fn: Fn;
  location: Location;
  tenureBand: TenureBand;
  gender: Gender;
  ethnicityBand: EthnicityBand;
  baseSalary: number;
  bonusPct: number;
  equityValue: number;
}
