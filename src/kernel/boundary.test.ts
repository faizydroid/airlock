import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The kernel boundary, enforced mechanically.
 *
 * The disclosure invariant depends on raw records never leaving `src/kernel`. The most
 * plausible way that breaks is not a clever attack — it is a chart component importing
 * `generateEmployees` at 2am on day five because it needed "just the raw numbers for the
 * histogram". This test makes that a build failure.
 *
 * Note what is already enforced by the language rather than by this test: `Kernel.#rows` is a
 * true private field, so it is structurally inaccessible outside the class. No amount of
 * casting or property access reaches it. This test covers the remaining route, which is
 * bypassing the kernel entirely.
 */

const SRC = path.resolve(import.meta.dirname, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** Relative to src/, using forward slashes, e.g. "ui/App.tsx". */
function rel(file: string): string {
  return path.relative(SRC, file).split(path.sep).join('/');
}

const files = walk(SRC).map((f) => ({ rel: rel(f), text: fs.readFileSync(f, 'utf8') }));

/**
 * Modules allowed to produce, hold or describe raw records.
 *
 * Kept deliberately short. Adding an entry here is the moment to ask whether the module really
 * needs record access, because every addition widens the surface the invariant depends on.
 */
const RAW_ALLOWED = [
  // The kernel: holds the rows behind a private field.
  /^kernel\/kernel\.ts$/,
  // The generator: produces them.
  /^data\/generate\.ts$/,
  // The schema: the Employee type has to be declared somewhere. Types are erased at runtime,
  // and this module contains no data — only enum lists and a shape.
  /^data\/schema\.ts$/,
  // Tests may reach for raw data in order to verify the kernel agrees with the truth. The
  // adversarial suite in particular needs ground truth to check whether an attack succeeded.
  /\.test\.ts$/
];

function isRawAllowed(r: string): boolean {
  return RAW_ALLOWED.some((p) => p.test(r));
}

describe('kernel boundary', () => {
  it('finds source files to check', () => {
    // Guards against the walk silently returning nothing and the suite passing vacuously.
    expect(files.length).toBeGreaterThan(5);
  });

  it('only the kernel may import the record generator', () => {
    const offenders = files
      .filter((f) => !isRawAllowed(f.rel))
      .filter((f) => /from\s+['"][^'"]*data\/generate/.test(f.text))
      .map((f) => f.rel);

    expect(
      offenders,
      `these modules import the raw record generator but are outside the kernel:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('only the kernel may reference the Employee record type', () => {
    // Types are erased at runtime, so importing Employee cannot itself leak anything. It is
    // banned as a smell: a module that needs the shape of a record is a module handling
    // records, and that is exactly what must not exist outside the kernel.
    const offenders = files
      .filter((f) => !isRawAllowed(f.rel))
      .filter((f) => /\bEmployee\b/.test(f.text))
      .map((f) => f.rel);

    expect(
      offenders,
      `these modules reference the Employee record type outside the kernel:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('keeps the raw store in a true private field, not a convention', () => {
    const kernel = files.find((f) => f.rel === 'kernel/kernel.ts');
    expect(kernel).toBeDefined();
    // `#rows` is inaccessible outside the class by language semantics. A `private rows`
    // TypeScript modifier would be erased at runtime and reachable by casting.
    expect(kernel!.text).toMatch(/#rows/);
    expect(kernel!.text).not.toMatch(/private\s+rows\b/);
  });

  it('routes every disclosure through the kernel, so no module computes its own statistics', () => {
    // A module that sorts values and takes a percentile is producing a disclosure without
    // passing the policy. Charts must render pre-aggregated cells, never compute from values.
    const suspicious = files
      .filter((f) => !f.rel.startsWith('kernel/') && !f.rel.startsWith('data/'))
      .filter((f) => !f.rel.endsWith('.test.ts'))
      .filter((f) => /\bpercentile\s*\(|\.sort\s*\(\s*\(\s*a\s*,\s*b\s*\)\s*=>\s*a\s*-\s*b/.test(f.text))
      .map((f) => f.rel);

    expect(
      suspicious,
      `these modules appear to compute statistics outside the kernel:\n  ${suspicious.join('\n  ')}`
    ).toEqual([]);
  });
});
