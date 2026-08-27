/**
 * The nine tools Airlock exposes to an agent.
 *
 * Design constraints, each traceable to a specific finding in docs/threat-model.md:
 *
 *   - Every parameter is an enum or a bounded string. There is no free-form query, no filter
 *     expression, no SQL. The agent selects from a fixed vocabulary rather than composing
 *     predicates.
 *   - Refusals are RETURNED, never thrown. The platform discards a rejected promise's reason.
 *   - No tool can set the numeric floor. Only a human click can, via the override flow.
 *   - Descriptions are written to be read by a model: what the tool does and when to use it,
 *     in positive terms, within Chrome's 500-character advisory budget.
 *
 * Registration is state-gated across three transitions, so `toolchange` carries real meaning:
 *
 *   no dataset   -> load_sample_dataset, describe_dataset
 *   loaded       -> + count_cohorts, summarize_metric, record_finding, get_audit_report,
 *                     request_threshold_override
 *   override open-> + check_override_request
 */

import { DIMENSION_NAMES, METRIC_NAMES } from '../data/schema.js';
import { ALLOWED_STATS, N_NUMERIC_FLOOR } from '../kernel/policy.js';
import { store } from '../app/store.js';
import { buildReport } from '../app/report.js';
import { ToolRegistry, type ToolDef } from './webmcp.js';

const registry = new ToolRegistry();
export { registry };

/** Wraps a handler so every call lands in the inspector panel, whatever it returned. */
function traced(name: string, fn: (input: Record<string, unknown>) => unknown) {
  return async (input: Record<string, unknown>) => {
    const output = fn(input);
    store.recordToolReturn(name, input, output);
    syncRegistration();
    return output;
  };
}

/* ------------------------------------------------------------------ *
 * Group: always available                                            *
 * ------------------------------------------------------------------ */

const baseTools: ToolDef[] = [
  {
    name: 'load_sample_dataset',
    description:
      'Loads a synthetic 5,000-employee compensation dataset into the page for analysis. '
      + 'The data stays in this browser tab and is never uploaded. Call this first; every '
      + 'analysis tool becomes available once it succeeds.',
    inputSchema: {
      type: 'object',
      properties: {
        seed: {
          type: 'number',
          description: 'Optional. Fixes the generated dataset so results are reproducible.'
        }
      }
    },
    annotations: { readOnlyHint: false },
    execute: traced('load_sample_dataset', (input) => {
      const seed = typeof input.seed === 'number' ? input.seed : undefined;
      return store.loadDataset(seed === undefined ? {} : { seed });
    })
  },
  {
    name: 'describe_dataset',
    description:
      'Returns the dataset schema: which dimensions can be grouped by, which metrics can be '
      + 'measured, and the disclosure policy in force. Contains no employee data and no cohort '
      + 'sizes. Use it to plan an analysis before spending disclosure budget.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: traced('describe_dataset', () => store.kernel.profile())
  }
];

/* ------------------------------------------------------------------ *
 * Group: available once a dataset is loaded                          *
 * ------------------------------------------------------------------ */

const analysisTools: ToolDef[] = [
  {
    name: 'count_cohorts',
    description:
      'Returns headcount for every cohort in a grouping. Counts are reported as bands such as '
      + '"5-9" or "10-24" below 50 people, and exactly above that. Use it to find out which '
      + 'cohorts are large enough to analyse before asking for salary figures.',
    inputSchema: {
      type: 'object',
      properties: {
        groupBy: {
          type: 'array',
          items: { type: 'string', enum: DIMENSION_NAMES },
          description: 'One or two dimensions to group by. Omit for a whole-company total.'
        }
      }
    },
    annotations: { readOnlyHint: true },
    execute: traced('count_cohorts', (input) =>
      store.kernel.aggregate({
        stat: 'count',
        groupBy: Array.isArray(input.groupBy) ? (input.groupBy as string[]) : []
      })
    )
  },
  {
    name: 'summarize_metric',
    description:
      'Reports a statistic for a metric across every cohort in a grouping, and renders it as a '
      + 'chart the person at the keyboard can see. Cohorts smaller than '
      + `${N_NUMERIC_FLOOR} people are marked withheld rather than reported. Group by gender or `
      + 'ethnicity alongside level or function to examine pay equity. Grouping by two dimensions at '
      + 'once is how you locate where a gap concentrates, which a single adjusted average hides.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          enum: METRIC_NAMES,
          description: 'Which figure to measure.'
        },
        stat: {
          type: 'string',
          enum: ALLOWED_STATS.filter((s) => s !== 'count'),
          description: 'Which statistic. Extremes and dispersion are not available.'
        },
        groupBy: {
          type: 'array',
          items: { type: 'string', enum: DIMENSION_NAMES },
          description: 'One or two dimensions to group by. Omit for a whole-company figure.'
        }
      },
      required: ['metric', 'stat']
    },
    annotations: { readOnlyHint: true },
    execute: traced('summarize_metric', (input) =>
      store.kernel.aggregate({
        stat: String(input.stat),
        metric: String(input.metric),
        groupBy: Array.isArray(input.groupBy) ? (input.groupBy as string[]) : []
      })
    )
  },
  {
    name: 'adjusted_pay_gap',
    /**
     * The warning in the second half of this description is not decoration.
     *
     * A real model (claude-haiku-4-5, via `scripts/agent-session.mjs`) audited the dataset with the
     * previous wording, controlled for level and function, got 0.5%, and recorded a finding saying
     * the gap was negligible. The dataset has a deliberate 7.5% penalty concentrated in Engineering
     * and Sales at L5-L7; 0.5% is the noise floor the generator plants everywhere else. The model
     * was not careless — it was reading a single equal-weighted average across ~49 strata, in which
     * a gap living in ~6 of them is arithmetically invisible.
     *
     * The tool could not express "the gap inside Engineering", and nothing told the model to go
     * looking. Adding a `within` filter would open a cohort-narrowing surface (attack A7) and
     * returning per-stratum figures would leak n, so the fix is the honest one: the tool states its
     * own blind spot and names the tool that covers it.
     */
    description:
      'Reports the pay gap for each group against a reference group, comparing only within '
      + 'matching strata so composition cannot distort it. Returns one percentage per group; '
      + 'positive means that group earns less. This averages every stratum equally, so a gap '
      + 'concentrated in a few functions or levels is diluted here and can look negligible. A small '
      + 'number is not evidence of equity: also call summarize_metric grouped by this dimension '
      + 'alongside fn or level to find where a gap actually sits.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: METRIC_NAMES, description: 'Which figure to compare.' },
        dimension: {
          type: 'string',
          enum: DIMENSION_NAMES,
          description: 'The dimension whose groups are compared, for example gender.'
        },
        reference: {
          type: 'string',
          description: 'The group everything is compared against, for example Male.'
        },
        controlFor: {
          type: 'array',
          items: { type: 'string', enum: DIMENSION_NAMES },
          description: 'One or two dimensions to hold constant, for example level and fn.'
        }
      },
      required: ['metric', 'dimension', 'reference']
    },
    annotations: { readOnlyHint: true },
    execute: traced('adjusted_pay_gap', (input) =>
      store.kernel.adjustedGap({
        metric: String(input.metric),
        dimension: String(input.dimension),
        reference: String(input.reference),
        controlFor: Array.isArray(input.controlFor) ? (input.controlFor as string[]) : []
      })
    )
  },
  {
    name: 'record_finding',
    description:
      'Adds a finding to the audit report shown in the page. Use it to record a conclusion once '
      + 'the analysis supports it, so the person at the keyboard can review, keep or discard it. '
      + 'The exported report carries the full disclosure ledger alongside every finding.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short headline, under 100 characters.' },
        detail: { type: 'string', description: 'What the analysis showed and which cohorts.' },
        severity: {
          type: 'string',
          enum: ['info', 'concern', 'critical'],
          description: 'How much attention this warrants.'
        }
      },
      required: ['title', 'detail', 'severity']
    },
    // The agent authors this text. It is displayed to a human and included in an export, so it
    // is untrusted content as far as any downstream consumer is concerned.
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: traced('record_finding', (input) => {
      const severity = String(input.severity);
      const f = store.addFinding({
        title: String(input.title).slice(0, 120),
        detail: String(input.detail).slice(0, 800),
        severity:
          severity === 'critical' || severity === 'concern' ? severity : 'info',
        basedOn: store.lastAggregate
          ? {
              stat: store.lastAggregate.stat,
              metric: store.lastAggregate.metric,
              groupBy: store.lastAggregate.groupBy
            }
          : null
      });
      return { status: 'ok', finding_id: f.id, findings_total: store.findings.length };
    })
  },
  {
    name: 'get_audit_report',
    description:
      'Returns the audit report assembled so far: every finding, the disclosure ledger, and the '
      + 'budget spent. The ledger is the provenance record, listing every question asked and '
      + 'every question refused.',
    inputSchema: { type: 'object', properties: {} },
    // Contains agent-authored finding text.
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: traced('get_audit_report', () => buildReport(store))
  },
  {
    name: 'request_threshold_override',
    description:
      'Asks the person at the keyboard to permit one analysis at a lower cohort-size threshold, '
      + `currently ${N_NUMERIC_FLOOR}. Returns immediately with a request id and does not block. `
      + 'The decision is theirs and is recorded. Poll check_override_request with the id once '
      + 'they have responded.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: METRIC_NAMES, description: 'Metric to analyse.' },
        stat: {
          type: 'string',
          enum: ALLOWED_STATS.filter((s) => s !== 'count'),
          description: 'Statistic to report.'
        },
        groupBy: {
          type: 'array',
          items: { type: 'string', enum: DIMENSION_NAMES },
          description: 'One or two dimensions to group by.'
        },
        justification: {
          type: 'string',
          description: 'Why the smaller cohorts matter. Shown to the person deciding.'
        }
      },
      required: ['metric', 'stat', 'justification']
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: traced('request_threshold_override', (input) => {
      const req = store.openOverride(
        {
          metric: String(input.metric),
          stat: String(input.stat),
          groupBy: Array.isArray(input.groupBy) ? (input.groupBy as string[]) : []
        },
        String(input.justification).slice(0, 400)
      );
      return {
        status: 'pending_human_approval',
        request_id: req.id,
        next_step:
          `Call check_override_request with request_id "${req.id}" after the person at the `
          + 'keyboard responds in the page.'
      };
    })
  }
];

/* ------------------------------------------------------------------ *
 * Group: available only while a request is open                      *
 * ------------------------------------------------------------------ */

const overrideTools: ToolDef[] = [
  {
    name: 'check_override_request',
    description:
      'Reports whether a threshold override was approved or denied, and returns the analysis if '
      + 'it was approved. Registered only while a request is outstanding.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: {
          type: 'string',
          description: 'The id returned by request_threshold_override.'
        }
      },
      required: ['request_id']
    },
    annotations: { readOnlyHint: true },
    execute: traced('check_override_request', (input) => {
      const req = store.findOverride(String(input.request_id));
      if (!req) {
        return {
          status: 'unknown_request',
          reason: 'No override request with that id.',
          recovery: 'Call request_threshold_override first.'
        };
      }
      if (req.status === 'pending') {
        return { status: 'pending', reason: 'Awaiting a decision in the page.' };
      }
      if (req.status === 'denied') {
        return {
          status: 'denied',
          reason: 'The person at the keyboard declined this override.',
          recovery: 'Analyse a broader cohort instead.'
        };
      }
      if (req.status === 'expired') {
        return {
          status: 'expired',
          reason: 'The request timed out without a decision.',
          recovery: 'Analyse a broader cohort, or file a new request if it still matters.'
        };
      }
      return { status: 'approved', result: req.result };
    })
  }
];

/* ------------------------------------------------------------------ *
 * State-driven registration                                          *
 * ------------------------------------------------------------------ */

const ANALYSIS_NAMES = analysisTools.map((t) => t.name);
const OVERRIDE_NAMES = overrideTools.map((t) => t.name);

let syncing = false;

/**
 * Brings registration in line with application state.
 *
 * Called after every tool invocation and on every UI action, so the agent's available tools
 * always describe what is currently possible. Each transition fires `toolchange`.
 */
let pendingSync = false;

/**
 * Brings registration in line with application state.
 *
 * Called after every tool invocation and on every UI action, so the agent's available tools always
 * describe what is currently possible. Each transition fires `toolchange`.
 *
 * The re-entrancy handling matters more than it looks. An earlier version returned immediately if a
 * sync was already running, which silently dropped the concurrent request — and because `traced()`
 * calls this after every tool return, a `request_threshold_override` landing mid-sync could fail to
 * register `check_override_request`, the one tool the human-approval flow depends on. Now a request
 * arriving during a sync sets a flag and runs afterwards, so the final state is always correct.
 */
export function syncRegistration(): void {
  if (syncing) {
    pendingSync = true;
    return;
  }
  syncing = true;

  void (async () => {
    try {
      do {
        pendingSync = false;

        await registry.ensure('base', baseTools);

        if (store.kernel.loaded) await registry.ensure('analysis', analysisTools);
        else registry.withdraw('analysis', ANALYSIS_NAMES);

        // Expire first, so a stale request cannot keep the polling tool registered indefinitely.
        store.expireStaleOverrides();
        const anyPending = store.overrides.some((o) => o.status === 'pending');
        if (anyPending) await registry.ensure('override', overrideTools);
        else registry.withdraw('override', OVERRIDE_NAMES);
        // Loop again if state changed while we were awaiting, rather than dropping the request.
      } while (pendingSync);
    } finally {
      syncing = false;
      store.notify();
    }
  })();
}

export const allToolDefs = [...baseTools, ...analysisTools, ...overrideTools];
