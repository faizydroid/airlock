/**
 * Tool-definition hygiene.
 *
 * A tool description is not documentation, it is the interface. It is the only thing a model reads
 * before deciding what to call, so a description that is too long to survive Chrome's advisory
 * budget, or that loses a sentence in a tidy-up, is a functional regression rather than a cosmetic
 * one. These assertions exist because both failures actually happened.
 */
import { describe, it, expect } from 'vitest';
import { allToolDefs } from './tools.js';
import { checkBudgets, isValidName } from './webmcp.js';

describe('tool definitions', () => {
  it('every name is valid per the spec charset', () => {
    for (const def of allToolDefs) {
      expect(isValidName(def.name), `${def.name} is not a legal tool name`).toBe(true);
    }
  });

  it('every name is unique', () => {
    const names = allToolDefs.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * Chrome publishes advisory budgets — 30 chars for a name, 500 for a description, 150 for a
   * parameter description — and exceeding them risks agent-side guardrails truncating the very text
   * the model needs. `checkBudgets` reports violations; here they are a build failure.
   *
   * This was added after a description rewrite came within a dozen characters of the 500 limit.
   */
  it('stays inside Chrome\'s advisory character budgets', () => {
    const over = allToolDefs.flatMap((d) => checkBudgets(d));
    expect(
      over,
      over.map((w) => `${w.tool}.${w.field}: ${w.length} > ${w.limit}`).join('\n')
    ).toEqual([]);
  });

  /**
   * Regression guard for a real defect, not a style rule.
   *
   * `adjusted_pay_gap` returns one equal-weighted average across strata. A gap concentrated in a few
   * of them is arithmetically invisible in that number. A live model (claude-haiku-4-5, transcript in
   * artifacts/agent-session.md) read the earlier description, got 0.5% after controlling for level
   * and function, and recorded a finding that the gap was negligible — on a dataset carrying a
   * deliberate 7.5% penalty in Engineering and Sales at L5-L7.
   *
   * The description now states that blind spot and names the tool that covers it. That cross
   * reference is load-bearing: without it the tool invites exactly the wrong conclusion, so removing
   * it must fail a test rather than pass review.
   */
  it('adjusted_pay_gap warns that a stratum average hides concentration', () => {
    const def = allToolDefs.find((d) => d.name === 'adjusted_pay_gap');
    expect(def).toBeDefined();
    const text = def!.description.toLowerCase();

    expect(text, 'must warn the single figure is diluted').toMatch(/dilut|averages every stratum/);
    expect(text, 'must not let a small number read as proof of equity').toMatch(/not evidence|not proof/);
    expect(text, 'must name the tool that reveals concentration').toContain('summarize_metric');
  });

  it('summarize_metric points at two-dimension grouping for locating a gap', () => {
    const def = allToolDefs.find((d) => d.name === 'summarize_metric');
    expect(def).toBeDefined();
    expect(def!.description.toLowerCase()).toMatch(/two dimensions/);
  });

  /**
   * The disclosure surface is defined by the enums, not by the prose. If a statistic that the policy
   * withdrew ever reappears in the schema, a model would be invited to ask for it — and the refusal
   * would then be the only thing standing between the request and a disclosure.
   */
  it('no withdrawn statistic is offered in any schema', () => {
    const withdrawn = ['min', 'max', 'median', 'p25', 'p75', 'stddev', 'variance', 'sum'];
    for (const def of allToolDefs) {
      const schema = JSON.stringify(def.inputSchema ?? {}).toLowerCase();
      for (const stat of withdrawn) {
        expect(
          schema.includes(`"${stat}"`),
          `${def.name} offers the withdrawn statistic "${stat}"`
        ).toBe(false);
      }
    }
  });
});
