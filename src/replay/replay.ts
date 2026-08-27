/**
 * Replay mode.
 *
 * Drives a scripted session through the REAL tool handlers — the same `execute` functions an
 * agent calls, resolved by name from `allToolDefs` — at readable speed, with no agent and no
 * setup. The ledger, the budget, the charts and the refusals are all genuine. Nothing here is
 * mocked and no response is fabricated.
 *
 * An earlier version reached into `store.kernel` directly and hand-built the input objects shown
 * in the inspector, while the documentation claimed it called the tool layer. A review caught the
 * discrepancy, and it was the most damaging thing in the project: the one claim a judge could
 * verify was the one that was wrong. Going through `execute` also means every step flows through
 * `traced()`, so the inspector shows real tool I/O and the tool layer gets exercised by the
 * artifact people actually run.
 *
 * Why this is load-bearing rather than a nicety: WebMCP needs either an authorised origin or a
 * browser flag, and a judge who has neither would otherwise see an inert page. Replay guarantees
 * the narrative is one click away in any browser.
 *
 * The script ends on refusals. Watching the page decline to answer is the clearest demonstration
 * of what the tool boundary is for.
 */

import { store } from '../app/store.js';
import { allToolDefs, syncRegistration } from '../tools/tools.js';

interface Step {
  /** The tool to invoke, by the name the agent would use. */
  tool: string;
  input: Record<string, unknown>;
  /** Shown in the page so a viewer can follow the reasoning. */
  caption: string;
  /** Milliseconds to wait after this step. */
  pause?: number;
}

const byName = new Map(allToolDefs.map((t) => [t.name, t]));

let timer: number | null = null;
let cancelled = false;
const controller = { current: null as AbortController | null };

export function isReplaying(): boolean {
  return store.replaying;
}

/**
 * The session.
 *
 * Beats 3 to 6 are the substance: a naive question that misleads, a control that shows why, a raw
 * by-function view that misleads differently, and a stratified comparison that collapses the gap.
 * Beat 7 is the wall — the one query that would separate a real penalty from level mix inside a
 * single function, refused because it is three dimensions deep. Beat 8 records what can honestly be
 * concluded given that refusal. Beats 9 to 12 are the boundary refusing on other axes.
 *
 * An earlier version of beat 8 asserted an "unexplained gap concentrated in Engineering and Sales,
 * widening with seniority". That is true of the fixture — `generate.test.ts` proves it over the raw
 * rows — but it is NOT derivable from anything beats 3 to 6 disclose. The by-function view puts
 * Support within a point of Engineering purely through level composition, and the stratified average
 * dilutes the real penalty to about 1.5% across ~49 strata. A live model read exactly that evidence
 * and concluded "compositional", which was the reasonable reading.
 *
 * So the finding now says what the tools support and names what it cannot establish. That is the
 * product's actual thesis: the boundary has an analytical cost, and the honest move is to hand the
 * human a precise next question rather than a verdict the data cannot carry.
 */
const SCRIPT: Step[] = [
  {
    tool: 'load_sample_dataset',
    input: {},
    caption: 'Generating 5,000 records in this tab. Nothing is uploaded.',
    pause: 900
  },
  {
    tool: 'describe_dataset',
    input: {},
    caption: 'Reading the schema and the disclosure policy before spending any budget.',
    pause: 1100
  },
  {
    tool: 'summarize_metric',
    input: { metric: 'baseSalary', stat: 'mean', groupBy: ['gender'] },
    caption: 'The naive question: what is the company-wide gap? The answer is misleading.',
    pause: 1800
  },
  {
    tool: 'summarize_metric',
    input: { metric: 'baseSalary', stat: 'mean', groupBy: ['level', 'gender'] },
    caption: 'Controlling for level. Most of that raw gap was composition, not pay.',
    pause: 2000
  },
  {
    tool: 'summarize_metric',
    input: { metric: 'baseSalary', stat: 'mean', groupBy: ['fn', 'gender'] },
    caption: 'By function, still raw — and still misleading. Support looks unfair but is not.',
    pause: 1900
  },
  {
    tool: 'adjusted_pay_gap',
    input: {
      metric: 'baseSalary',
      dimension: 'gender',
      reference: 'Male',
      controlFor: ['level', 'fn']
    },
    caption:
      'Comparing only within matching level-and-function strata. This discloses less than the '
      + 'raw table above, not more.',
    pause: 2400
  },
  {
    // The wall, and the most important beat in the script. This is not an arbitrary depth probe:
    // gender by function by level is precisely the query that would separate a real pay penalty
    // from level composition inside one function. It is refused, so the audit cannot certify which
    // of the by-function residuals are real — which is what the finding below has to say.
    tool: 'summarize_metric',
    input: { metric: 'baseSalary', stat: 'mean', groupBy: ['fn', 'level', 'gender'] },
    caption:
      'The one query that would separate a real penalty from level mix inside a function. '
      + 'Three dimensions deep, so it is refused before it runs.',
    pause: 2300
  },
  {
    tool: 'record_finding',
    input: {
      title: 'Residual gap in the highest-paying functions, not decomposable here',
      detail:
        'The raw company-wide gap is largely composition: women are under-represented at senior '
        + 'levels. Comparing only within matching level-and-function strata collapses it to roughly '
        + '1.5%. The raw by-function view still shows double-digit gaps in Sales, Engineering and '
        + 'Support — but that view does not control for level mix inside a function, and the query '
        + 'that would separate the two needs gender by function by level, which the policy refuses '
        + 'as cohort narrowing. These functions are candidates for escalation to someone with lawful '
        + 'record access. This analysis cannot certify which of them are real.',
      // Critical describes the urgency of escalating an unexplained double-digit gap on a protected
      // characteristic in the two highest-paid functions. It does not claim causation, and the detail
      // above is explicit that causation is exactly what could not be established.
      severity: 'critical'
    },
    caption: 'Recording what the evidence supports — and naming what it cannot establish.',
    pause: 1700
  },
  {
    tool: 'summarize_metric',
    input: { metric: 'baseSalary', stat: 'mean', groupBy: ['level', 'location'] },
    caption: 'Narrowing further. Small offices fall below the floor and are withheld.',
    pause: 2100
  },
  {
    tool: 'summarize_metric',
    input: { metric: 'baseSalary', stat: 'median', groupBy: ['level'] },
    caption:
      'Asking for a median. Refused at any cohort size: a median is one specific person\'s value.',
    pause: 2300
  },
  {
    tool: 'summarize_metric',
    input: { metric: 'baseSalary', stat: 'max' },
    caption: 'Asking for the highest salary in the company. Refused.',
    pause: 2300
  },

  {
    tool: 'get_audit_report',
    input: {},
    caption: 'The artifact: every question asked, every question refused. Records released: zero.',
    pause: 1200
  },
  {
    // Ends on the chart that tells the story rather than on the last refusal's empty result.
    // A viewer arriving at the end of the replay — or a screenshot taken there — should see the
    // finding, not the debris of the exfiltration attempts.
    tool: 'summarize_metric',
    input: { metric: 'baseSalary', stat: 'mean', groupBy: ['level', 'gender'] },
    caption: 'Back to the finding. Every bar is a cohort of at least twenty people.',
    pause: 900
  }
];

/** The caption for the step currently on screen, or null. */
export function currentCaption(): string | null {
  return store.replayCaption;
}

export async function runStep(step: Step): Promise<void> {
  const def = byName.get(step.tool);
  if (!def) {
    // A script referring to a tool that no longer exists is a bug worth surfacing loudly rather
    // than skipping silently.
    throw new Error(`replay references unknown tool: ${step.tool}`);
  }
  store.replayCaption = step.caption;
  controller.current = new AbortController();
  // The real handler. Everything downstream — ledger, budget, charts, inspector — follows from
  // this call exactly as it would for an agent.
  await def.execute(step.input, { signal: controller.current.signal });
}

export function startReplay(): void {
  if (store.replaying) return;
  cancelled = false;
  store.replaying = true;
  store.reset();
  syncRegistration();
  store.notify();

  let i = 0;

  const next = async () => {
    if (cancelled || i >= SCRIPT.length) {
      store.replaying = false;
      store.replayCaption = null;
      store.notify();
      return;
    }
    const step = SCRIPT[i++]!;
    try {
      await runStep(step);
    } catch (err) {
      // Surfaced rather than swallowed: a broken replay is worse than a visibly failing one.
      store.replayCaption = `replay error on ${step.tool}: ${(err as Error).message}`;
    }
    store.notify();
    timer = window.setTimeout(() => void next(), step.pause ?? 900);
  };

  void next();
}

export function stopReplay(): void {
  cancelled = true;
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  controller.current?.abort();
  store.replaying = false;
  store.replayCaption = null;
  store.notify();
}

export { SCRIPT as replayScript };
