import { describe, it, expect, beforeEach } from 'vitest';
import { store } from '../app/store.js';
import { buildReport, reportToMarkdown } from '../app/report.js';

/**
 * Smoke test for the demonstration narrative.
 *
 * The replay script is what a judge sees if they cannot enable the Chrome flag, and it is the
 * spine of the video. If any beat stops working the demo silently loses its point, so the beats
 * are asserted here rather than discovered while recording.
 *
 * This exercises the same store and kernel calls the replay steps make, without the timers.
 */

beforeEach(() => {
  store.reset();
});

function summarize(stat: string, metric: string, groupBy: string[]) {
  const out = store.kernel.aggregate({ stat, metric, groupBy });
  store.recordToolReturn('summarize_metric', { stat, metric, groupBy }, out);
  return out;
}

function valuesOf(d: unknown): number[] {
  const r = d as { status: string; cells?: { value?: number }[] };
  if (r.status !== 'ok' || !r.cells) return [];
  return r.cells.filter((c) => c.value !== undefined).map((c) => c.value!);
}

describe('the demonstration narrative', () => {
  it('beat 1: loading discloses nothing and enables analysis', () => {
    const profile = store.loadDataset();
    expect(profile.status).toBe('ok');
    expect(store.kernel.loaded).toBe(true);
    // The profile is schema only. No figures.
    expect(JSON.stringify(profile)).not.toMatch(/baseSalary"\s*:\s*\d/);
  });

  it('beat 2: the naive company-wide question is answerable but misleading', () => {
    store.loadDataset();
    const r = summarize('mean', 'baseSalary', ['gender']);
    const vals = valuesOf(r);
    expect(vals.length).toBeGreaterThanOrEqual(2);

    // There must be a visible raw gap, otherwise the setup has no hook.
    const spread = Math.max(...vals) - Math.min(...vals);
    expect(spread).toBeGreaterThan(3000);
  });

  it('beat 3: controlling for level narrows the gap, which is the first real insight', () => {
    store.loadDataset();

    const raw = valuesOf(summarize('mean', 'baseSalary', ['gender']));
    const rawGap = 1 - Math.min(...raw) / Math.max(...raw);

    const byLevel = summarize('mean', 'baseSalary', ['level', 'gender']);
    const cells = (byLevel as { cells: { group: Record<string, string>; value?: number }[] }).cells;

    // Weighted within-level gap.
    let num = 0;
    let den = 0;
    for (const level of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']) {
      const f = cells.find((c) => c.group.level === level && c.group.gender === 'Female')?.value;
      const m = cells.find((c) => c.group.level === level && c.group.gender === 'Male')?.value;
      if (f === undefined || m === undefined) continue;
      num += 1 - f / m;
      den += 1;
    }
    const adjusted = den ? num / den : 0;

    // The whole hook of the demo: the raw figure substantially overstates the real gap.
    expect(rawGap).toBeGreaterThan(adjusted * 1.5);
  });

  it('beat 4: the raw view by function is still misleading', () => {
    // This is the trap, asserted so it cannot regress away. Support is planted at parity, yet a
    // raw comparison shows a substantial gap purely from level composition. An agent that stops
    // here reports something false.
    store.loadDataset();
    const r = summarize('mean', 'baseSalary', ['fn', 'gender']);
    const cells = (r as { cells: { group: Record<string, string>; value?: number }[] }).cells;

    const rawGap = (fn: string) => {
      const f = cells.find((c) => c.group.fn === fn && c.group.gender === 'Female')?.value;
      const m = cells.find((c) => c.group.fn === fn && c.group.gender === 'Male')?.value;
      return f !== undefined && m !== undefined ? 1 - f / m : null;
    };

    const support = rawGap('Support');
    expect(support, 'Support must be reportable').not.toBeNull();
    expect(support!, 'the raw gap in a parity function must look alarming').toBeGreaterThan(0.05);
  });

  it('beat 5: the adjusted gap isolates the real signal', () => {
    store.loadDataset();
    const out = store.kernel.adjustedGap({
      metric: 'baseSalary',
      dimension: 'gender',
      reference: 'Male',
      controlFor: ['level', 'fn']
    });
    expect(out.status).toBe('ok');

    const results = (out as { results: { group: string; gapPct: number | null }[] }).results;
    const female = results.find((r) => r.group === 'Female');
    expect(female, 'Female must be reportable after adjustment').toBeDefined();
    expect(female!.gapPct).not.toBeNull();

    // The planted penalty is 7.5% in two functions and ~0.5% elsewhere. Weighted across all
    // strata the adjusted figure should land clearly above noise but well below the raw gap.
    expect(female!.gapPct!).toBeGreaterThan(1.0);
    expect(female!.gapPct!).toBeLessThan(8.0);
  });

  it('beat 5b: adjustment discloses less than the equivalent raw table', () => {
    store.loadDataset();

    const adjusted = store.kernel.adjustedGap({
      metric: 'baseSalary',
      dimension: 'gender',
      reference: 'Male',
      controlFor: ['level', 'fn']
    });
    const adjustedCells = (adjusted as { results: unknown[] }).results.length;

    const raw = store.kernel.aggregate({
      stat: 'mean',
      metric: 'baseSalary',
      groupBy: ['level', 'gender']
    });
    const rawCells = (raw as { cells: unknown[] }).cells.length;

    // Two numbers instead of fourteen. The stratification happens inside the kernel, so the
    // ingredients are never released.
    expect(adjustedCells).toBeLessThan(rawCells);
  });

  it('the adjusted gap exposes no coefficients, standard errors or degrees of freedom', () => {
    store.loadDataset();
    const out = JSON.stringify(
      store.kernel.adjustedGap({
        metric: 'baseSalary',
        dimension: 'gender',
        reference: 'Male',
        controlFor: ['level', 'fn']
      })
    );
    for (const leak of ['coefficient', 'stderr', 'dof', 'rSquared', 'pValue', 'residual']) {
      expect(out, `leaked ${leak}`).not.toMatch(new RegExp(leak, 'i'));
    }
    // No raw cohort size under any of its usual names. Matched as JSON keys so that substrings
    // of legitimate field names such as "dimension" do not trip the check.
    for (const key of ['n', 'count', 'size', 'headcount', 'strataCount']) {
      expect(out, `leaked key ${key}`).not.toMatch(new RegExp(`"${key}"\\s*:\\s*\\d`));
    }
  });

  it('beat 5: a finding lands in the human report with provenance', () => {
    store.loadDataset();
    summarize('mean', 'baseSalary', ['fn', 'gender']);
    store.addFinding({
      title: 'Gap concentrated in Engineering and Sales',
      detail: 'Persists after controlling for level.',
      severity: 'critical',
      basedOn: { stat: 'mean', metric: 'baseSalary', groupBy: ['fn', 'gender'] }
    });

    const report = buildReport(store);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.basedOn).not.toBeNull();
    expect(report.disclosure.recordsReleased).toBe(0);
  });

  it('beat 6: narrowing into small cohorts produces visible withholding', () => {
    store.loadDataset();
    const r = summarize('mean', 'baseSalary', ['level', 'location']);
    const cells = (r as { cells: { withheld?: true }[] }).cells;
    // The refusal beat depends on this being non-empty with the shipped fixture.
    expect(cells.filter((c) => c.withheld).length).toBeGreaterThan(0);
  });

  it('beat 7: the exfiltration attempt is refused with a readable reason', () => {
    store.loadDataset();
    const r = store.kernel.aggregate({ stat: 'max', metric: 'baseSalary' });
    expect(r.status).toBe('refused');
    const refusal = r as { reason: string; recovery: string };
    // The agent must be able to explain the refusal to the user, which is why refusals are
    // returned rather than thrown.
    expect(refusal.reason.length).toBeGreaterThan(20);
    expect(refusal.recovery.length).toBeGreaterThan(20);
  });

  it('beat 8: over-narrow grouping is refused before it runs', () => {
    store.loadDataset();
    const r = store.kernel.aggregate({
      stat: 'mean',
      metric: 'baseSalary',
      groupBy: ['level', 'location', 'gender']
    });
    expect((r as { code: string }).code).toBe('GROUP_BY_TOO_DEEP');
  });

  it('closes with a counter that never moved', () => {
    store.loadDataset();
    summarize('mean', 'baseSalary', ['level', 'gender']);
    summarize('mean', 'baseSalary', ['fn', 'gender']);
    store.kernel.aggregate({ stat: 'max', metric: 'baseSalary' });

    const snap = store.snapshot();
    expect(snap.recordsDisclosed).toBe(0);

    const md = reportToMarkdown(buildReport(store));
    expect(md).toMatch(/Individual records released to the agent \| \*\*0\*\*/);
    expect(md).toMatch(/Questions refused by policy \| [1-9]/);
  });
});

describe('the human override flow', () => {
  it('returns immediately, then resolves on a human decision', () => {
    store.loadDataset();

    const req = store.openOverride(
      { metric: 'baseSalary', stat: 'mean', groupBy: ['level', 'location'] },
      'Small offices may be where the gap is worst.'
    );
    expect(req.status).toBe('pending');
    // Crucially, nothing blocked: the request exists and the caller already has its id.
    expect(req.id).toBeTruthy();

    const resolved = store.resolveOverride(req.id, 'approved');
    expect(resolved!.status).toBe('approved');
    expect(resolved!.result).toBeDefined();
    expect(resolved!.result!.status).toBe('ok');
  });

  it('denial is recorded and discloses nothing', () => {
    store.loadDataset();
    const req = store.openOverride(
      { metric: 'baseSalary', stat: 'mean', groupBy: ['level', 'location'] },
      'please'
    );
    const resolved = store.resolveOverride(req.id, 'denied');
    expect(resolved!.status).toBe('denied');
    expect(resolved!.result).toBeUndefined();
  });

  it('an approved override still cannot reach the count floor', () => {
    store.loadDataset();
    const req = store.openOverride(
      { metric: 'baseSalary', stat: 'mean', groupBy: ['level', 'location'] },
      'justification'
    );
    const resolved = store.resolveOverride(req.id, 'approved');
    const cells = (resolved!.result as { cells: { count: unknown; value?: number }[] }).cells;
    for (const c of cells) {
      if (c.count === '<5' || c.count === '5-9') expect(c.value).toBeUndefined();
    }
  });

  it('resolving twice is a no-op, so a decision cannot be replayed', () => {
    store.loadDataset();
    const req = store.openOverride(
      { metric: 'baseSalary', stat: 'mean', groupBy: ['level'] },
      'x'
    );
    expect(store.resolveOverride(req.id, 'denied')).not.toBeNull();
    expect(store.resolveOverride(req.id, 'approved')).toBeNull();
    expect(store.findOverride(req.id)!.status).toBe('denied');
  });
});

describe('snapshot caching', () => {
  it('returns a stable reference until state changes', () => {
    // useSyncExternalStore compares by reference; an unstable snapshot is an infinite render loop.
    const a = store.snapshot();
    const b = store.snapshot();
    expect(a).toBe(b);

    store.loadDataset();
    expect(store.snapshot()).not.toBe(a);
  });

  it('does not append to the ledger when read', () => {
    store.loadDataset();
    const before = store.kernel.getLedger().length;
    for (let i = 0; i < 25; i++) store.snapshot();
    expect(store.kernel.getLedger().length).toBe(before);
  });
});
