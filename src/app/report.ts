/**
 * The audit report artifact.
 *
 * An audit whose only output is a chat transcript is not an audit. This assembles a document
 * that carries the disclosure ledger with it, so a reader can see not just what was concluded
 * but every question that was asked and every question that was refused.
 *
 * That provenance is the point. Under a data-minimisation obligation, the defensible artifact is
 * not the finding — it is the record of exactly what was disclosed in order to reach it.
 */

import type { Store } from './store.js';
import {
  BUDGET_CELLS,
  COUNT_EXACT_FLOOR,
  K_COUNT_FLOOR,
  MAX_GROUP_BY_DEPTH,
  N_NUMERIC_FLOOR,
  ALLOWED_STATS
} from '../kernel/policy.js';

export interface ReportFinding {
  id: string;
  title: string;
  detail: string;
  severity: string;
  at: string;
  basedOn: Record<string, unknown> | null;
}

export interface Report {
  status: 'ok';
  generatedAt: string;
  dataset: { rowCount: number; source: string };
  policy: {
    countFloor: number;
    numericFloor: number;
    exactCountFloor: number;
    maxGroupByDepth: number;
    permittedStatistics: readonly string[];
    excludedStatistics: readonly string[];
  };
  disclosure: {
    /** Individual records released. Structurally zero; stated so the reader can check. */
    recordsReleased: number;
    budgetTotal: number;
    budgetRemaining: number;
    questionsAsked: number;
    questionsRefused: number;
    humanOverridesGranted: number;
    humanOverridesDenied: number;
  };
  findings: ReportFinding[];
  ledger: readonly unknown[];
  limitations: string[];
}

/** Named here as well as in the README so the artifact is self-contained. */
const LIMITATIONS = [
  'This is not differential privacy. There is no calibrated noise and no epsilon budget. '
    + 'The controls are suppression, clamping, quantization, count banding and a bounded '
    + 'disclosure budget.',
  'Background knowledge is not defended against. Someone who already knows four salaries in a '
    + 'cohort of five can derive the fifth from its mean. This is irreducible for any system '
    + 'that reports means, and is why the numeric floor is set well above the count floor.',
  'Marginal reconstruction is mitigated, not eliminated. Given enough overlapping aggregates, '
    + 'integer programming over a quantized value grid narrows individual values.',
  'The page\'s own memory is out of scope. Raw records live in this tab; an agent able to '
    + 'execute JavaScript here could read them. The tool interface is a policy boundary, not a '
    + 'sandbox.',
  'Nothing individual is rendered anywhere, so a screenshot yields only what a tool call would '
    + 'have yielded. That is an architectural choice rather than a claim that the pixel channel '
    + 'does not exist.'
];

const EXCLUDED_STATS = [
  'min', 'max', 'top-N', 'stddev', 'variance', 'sum', 'mode', 'range',
  'median', 'p25', 'p75'
];

/** Ledger operations that release information, and therefore count as questions asked. */
const DISCLOSING_OPS = new Set(['aggregate', 'adjusted_gap']);

/**
 * Neutralises agent-authored text before it enters the exported markdown.
 *
 * Findings are written by the agent and land in a document a human may forward as an audit
 * record. Unescaped, that text could forge a "## Full disclosure ledger" heading to contradict
 * the real one, or embed a remote image whose URL carries data to a third party — turning our own
 * artifact into the egress channel the whole design exists to prevent.
 *
 * This is why `record_finding` and `get_audit_report` carry `untrustedContentHint`.
 */
function sanitize(text: string): string {
  return text
    // Neutralise headings and blockquotes at line starts, so injected structure cannot
    // impersonate a section of the report.
    .replace(/^[ \t]*(#{1,6}|>)/gm, (m) => `\\${m.trim()}`)
    // Strip image and link syntax outright. A finding has no legitimate need for either, and an
    // image URL is a beacon.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Defuse fenced code blocks, which could otherwise swallow the rest of the document.
    .replace(/```/g, '`\u200b``')
    // Bare URLs become inert text.
    .replace(/\b(https?|data|javascript):/gi, '$1\u200b:')
    .trim();
}

export function buildReport(store: Store): Report {
  const profile = store.kernel.loaded ? store.kernel.profile() : null;
  const ledger = store.kernel.getLedger();

  return {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    dataset: {
      rowCount: profile && profile.status === 'ok' ? profile.rowCount : 0,
      source: 'Synthetic, generated in-browser from a fixed seed. No real personal data.'
    },
    policy: {
      countFloor: K_COUNT_FLOOR,
      numericFloor: N_NUMERIC_FLOOR,
      exactCountFloor: COUNT_EXACT_FLOOR,
      maxGroupByDepth: MAX_GROUP_BY_DEPTH,
      permittedStatistics: ALLOWED_STATS,
      excludedStatistics: EXCLUDED_STATS
    },
    disclosure: {
      recordsReleased: 0,
      budgetTotal: BUDGET_CELLS,
      budgetRemaining: store.kernel.remaining,
      // Counts every disclosing operation, not just `aggregate`. Filtering on a single op name
      // silently excluded adjusted_gap, so five stratified queries reported as zero questions
      // asked — an audit artifact that under-reports its own disclosures is worse than none.
      questionsAsked: ledger.filter((e) => DISCLOSING_OPS.has(e.op)).length,
      questionsRefused: ledger.filter((e) => e.outcome === 'refused').length,
      humanOverridesGranted: store.overrides.filter((o) => o.status === 'approved').length,
      humanOverridesDenied: store.overrides.filter((o) => o.status === 'denied').length
    },
    findings: store.findings.map((f) => ({
      id: f.id,
      title: f.title,
      detail: f.detail,
      severity: f.severity,
      at: f.at,
      basedOn: f.basedOn
    })),
    ledger,
    limitations: LIMITATIONS
  };
}

/** Human-readable export. Markdown rather than PDF: no dependency, and it diffs. */
export function reportToMarkdown(r: Report): string {
  const lines: string[] = [];

  lines.push('# Pay equity audit');
  lines.push('');
  lines.push(`Generated ${r.generatedAt}`);
  lines.push('');
  lines.push(
    `Dataset: ${r.dataset.rowCount.toLocaleString()} records. ${r.dataset.source}`
  );
  lines.push('');

  lines.push('## Disclosure record');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Individual records released to the agent | **${r.disclosure.recordsReleased}** |`);
  lines.push(`| Questions asked | ${r.disclosure.questionsAsked} |`);
  lines.push(`| Questions refused by policy | ${r.disclosure.questionsRefused} |`);
  lines.push(`| Human overrides granted | ${r.disclosure.humanOverridesGranted} |`);
  lines.push(`| Human overrides denied | ${r.disclosure.humanOverridesDenied} |`);
  lines.push(
    `| Disclosure budget | ${r.disclosure.budgetTotal - r.disclosure.budgetRemaining}`
      + ` of ${r.disclosure.budgetTotal} spent |`
  );
  lines.push('');

  lines.push('## Policy in force');
  lines.push('');
  lines.push(`- Cohorts below ${r.policy.countFloor} people are not reported on at all.`);
  lines.push(
    `- Any statistic reading a salary requires at least ${r.policy.numericFloor} people.`
  );
  lines.push(`- Exact headcounts are disclosed only at ${r.policy.exactCountFloor} or above.`);
  lines.push(`- At most ${r.policy.maxGroupByDepth} dimensions may be combined.`);
  lines.push(`- Permitted statistics: ${r.policy.permittedStatistics.join(', ')}.`);
  lines.push(`- Excluded: ${r.policy.excludedStatistics.join(', ')}.`);
  lines.push('');

  lines.push('## Findings');
  lines.push('');
  if (r.findings.length === 0) {
    lines.push('_No findings recorded._');
  } else {
    for (const f of r.findings) {
      // Agent-authored text. Sanitised, because this document is an audit record and its
      // structure must not be forgeable by its subject.
      lines.push(`### ${sanitize(f.title)}`);
      lines.push('');
      lines.push(`**${f.severity}** — ${f.at}`);
      lines.push('');
      lines.push(sanitize(f.detail));
      if (f.basedOn) {
        lines.push('');
        lines.push(`Provenance: \`${JSON.stringify(f.basedOn)}\``);
      }
      lines.push('');
    }
  }

  lines.push('## Limitations');
  lines.push('');
  for (const l of r.limitations) lines.push(`- ${l}`);
  lines.push('');

  lines.push('## Full disclosure ledger');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(r.ledger, null, 2));
  lines.push('```');

  return lines.join('\n');
}
