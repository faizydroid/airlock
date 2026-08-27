import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { store, type OverrideRequest } from '../app/store.js';
import { buildReport, reportToMarkdown } from '../app/report.js';
import { registry, syncRegistration, allToolDefs } from '../tools/tools.js';
import { isSupported } from '../tools/webmcp.js';
import { BUDGET_CELLS, N_NUMERIC_FLOOR } from '../kernel/policy.js';
import { Chart, label } from './Chart.js';
import { Counters } from './Counters.js';
import { AttackPanel } from './AttackPanel.js';
import { startReplay, isReplaying, stopReplay } from '../replay/replay.js';
import type { LedgerEntry } from '../kernel/kernel.js';

function useStore() {
  return useSyncExternalStore(
    useCallback((cb: () => void) => store.subscribe(cb), []),
    () => store.snapshot()
  );
}

export function App() {
  const s = useStore();
  const supported = useMemo(() => isSupported(), []);
  const previousTools = useRef<string[]>([]);
  const autostarted = useRef(false);

  useEffect(() => {
    syncRegistration();
  }, []);

  /**
   * Deep links, so a shared URL is the demo rather than an invitation to press something.
   *
   *   ?replay=1  starts the audit immediately
   *   ?attack=1  loads the dataset and scrolls to the attack panel
   *
   * The highest-friction step in a first visit is a person deciding whether to click. Removing that
   * decision is worth more than any feature, especially for a reader who has a queue of other
   * things to look at.
   */
  useEffect(() => {
    if (autostarted.current) return;
    autostarted.current = true;

    const params = new URLSearchParams(window.location.search);
    if (params.has('replay')) {
      startReplay();
      return;
    }
    if (params.has('attack')) {
      store.loadDataset();
      syncRegistration();
      requestAnimationFrame(() => {
        document.getElementById('attack')?.scrollIntoView({ behavior: 'smooth' });
      });
    }
  }, []);

  const toolNames = registry.registeredNames;
  const newlyAdded = toolNames.filter((n) => !previousTools.current.includes(n));
  useEffect(() => {
    previousTools.current = toolNames;
  }, [toolNames]);

  // Read from the kernel, not the imported constant: extendBudget raises the total, and
  // computing against a fixed 400 rendered a negative bar after one click.
  const spent = Math.max(0, s.budgetTotal - s.budget.remaining);
  const pending = s.overrides.filter((o) => o.status === 'pending');

  const exportReport = () => {
    const md = reportToMarkdown(buildReport(store));
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `airlock-audit-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="app">
      <header className="bar">
        {/* An h1, not a div. The page had six h2s and no top-level heading, so anyone navigating by
            heading landed straight in the middle of the document with no root to orient against. */}
        <h1 className="brand">
          Airlock
          <span>your agent analyses data it never sees</span>
        </h1>

        <div className="meter">
          <label>
            disclosure budget · {spent} of {s.budgetTotal} spent
          </label>
          <div className="track">
            <div
              className="fill"
              style={{ width: `${Math.min(100, (spent / Math.max(1, s.budgetTotal)) * 100)}%` }}
            />
          </div>
        </div>

      </header>

      <Counters state={s} />

      {s.replayCaption && (
        <div className="notice" role="status">
          {s.replayCaption}
        </div>
      )}

      {!supported && (
        <div className="notice">
          <strong>WebMCP is not available in this browser.</strong> The interface below works, and
          the <em>Replay the audit</em> button shows the full agent session. To drive it with a
          live agent, open this page in Chrome 149+ with{' '}
          <code>chrome://flags/#enable-webmcp-testing</code> enabled. See the README for the
          tested-environment matrix.
        </div>
      )}

      <div className="toolbar">
        <button
          className="primary"
          onClick={() => {
            store.loadDataset();
            syncRegistration();
          }}
          disabled={s.loaded}
        >
          {s.loaded ? `Dataset loaded · ${s.rowCount.toLocaleString()} records` : 'Load sample dataset'}
        </button>
        <button
          onClick={() => (isReplaying() ? stopReplay() : startReplay())}
          title="Plays a recorded agent session through this interface. No agent or setup required."
        >
          {s.replaying ? 'Stop replay' : 'Replay the audit'}
        </button>
        <button onClick={exportReport} disabled={s.findings.length === 0}>
          Export audit report
        </button>
        <button
          onClick={() => {
            store.kernel.extendBudget(200);
            store.notify();
          }}
          disabled={!s.loaded}
          title="Extending the budget is a human action and is recorded in the ledger."
        >
          Extend budget
        </button>
        <button
          className="danger"
          onClick={() => {
            store.reset();
            syncRegistration();
          }}
        >
          Reset
        </button>
      </div>

      <main>
        <div className="col">
          <section className="panel">
            <h2>
              <span className="num">01</span>
              What you see
              <span className="tag">
                aggregates only · nothing individual is rendered
              </span>
            </h2>
            {s.lastAggregate ? (
              <>
                <Chart result={s.lastAggregate} />
                <CellTable result={s.lastAggregate} />
              </>
            ) : (
              <div className="empty">
                No analysis yet. Load the dataset, then ask your agent to audit it — or press{' '}
                <em>Replay the audit</em> to watch a recorded session.
              </div>
            )}
          </section>

          <section className="panel">
            <h2>
              <span className="num">02</span>
              Findings
              <span className="tag">{s.findings.length} recorded</span>
            </h2>
            {s.findings.length === 0 ? (
              <div className="empty">The agent has not recorded any findings yet.</div>
            ) : (
              <div className="body tight">
                {s.findings.map((f) => (
                  <div className="card" key={f.id}>
                    <h3>
                      {f.title} <span className={`sev ${f.severity}`}>{f.severity}</span>
                    </h3>
                    <p>{f.detail}</p>
                    {f.basedOn && (
                      <div className="provenance">
                        drawn from <code>{JSON.stringify(f.basedOn)}</code>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="col">
          <section className="panel">
            <h2>
              <span className="num">03</span>
              What the agent received
              <span className="tag">verbatim tool return</span>
            </h2>
            {s.lastToolReturn ? (
              <pre className="json">
                {s.lastToolReturn.tool}
                {'\n\n'}
                {JSON.stringify(s.lastToolReturn.output, null, 2).slice(0, 4000)}
              </pre>
            ) : (
              <div className="empty">No tool has been called yet.</div>
            )}
          </section>

          {pending.length > 0 && (
            <section className="panel decide">
              <h2>
                <span className="num">04</span>
                Your decision required
                <span className="tag">{pending.length} pending</span>
              </h2>
              <div className="body tight">
                {pending.map((o) => (
                  <OverrideCard key={o.id} req={o} />
                ))}
              </div>
            </section>
          )}

          <section className="panel record">
            <h2>
              <span className="num">05</span>
              Disclosure ledger
              <span className="tag">append-only</span>
            </h2>
            {s.ledger.length === 0 ? (
              <div className="empty">Nothing disclosed yet.</div>
            ) : (
              <div className="ledger">
                {[...s.ledger].reverse().map((e) => (
                  <LedgerRow key={e.seq} entry={e} />
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <h2>
              <span className="num">06</span>
              Tools exposed to the agent
              <span className="tag">
                {toolNames.length} of {allToolDefs.length} registered
              </span>
            </h2>
            <div className="tools">
              {allToolDefs.map((t) => {
                const on = toolNames.includes(t.name);
                return (
                  <code
                    key={t.name}
                    // Unregistered tools are hatched rather than faded. Opacity is the wrong
                    // mechanism twice over: the design system forbids it, and a 35% alpha is
                    // invisible to assistive technology — which is why the state now also appears
                    // in the title, where it can actually be read.
                    className={[
                      on ? '' : 'off',
                      on && newlyAdded.includes(t.name) ? 'new' : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    title={`${on ? 'registered' : 'not yet registered'} — ${t.description}`}
                  >
                    {t.name}
                  </code>
                );
              })}
            </div>
          </section>
        </div>

        {/*
          Full width, spanning both grid columns.
          Held in a 7/4 column this panel ran ~1,500px tall against a ~900px right column, leaving
          roughly 1,200px of dead white beside it — which reads as a layout failure rather than as
          the active negative space the style intends. Spanning the grid balances the two columns
          and gives the result text a proper measure. It also lands the page's closing argument as
          its own full-bleed section rather than as the last item in a sidebar.
        */}
        <div className="span-both" id="attack">
          <AttackPanel loaded={s.loaded} />
        </div>
      </main>
    </div>
  );
}

function OverrideCard({ req }: { req: OverrideRequest }) {
  return (
    <div className="card pending">
      <h3>Analyse cohorts as small as 10?</h3>
      <p>
        The agent is asking to report <code>{req.spec.stat}</code> of{' '}
        <code>{req.spec.metric}</code>
        {req.spec.groupBy.length ? (
          <>
            {' '}
            grouped by <code>{req.spec.groupBy.join(' × ')}</code>
          </>
        ) : null}{' '}
        at a floor of 10 people instead of {N_NUMERIC_FLOOR}.
      </p>
      <div className="quote">{req.justification}</div>
      <p className="consequence">
        Approving discloses more about small cohorts. It applies to this one analysis and is
        recorded in the ledger with the reason above.
      </p>
      <div className="actions">
        <button
          className="primary"
          onClick={() => {
            store.resolveOverride(req.id, 'approved');
            syncRegistration();
          }}
        >
          Approve once
        </button>
        <button
          onClick={() => {
            store.resolveOverride(req.id, 'denied');
            syncRegistration();
          }}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const what =
    entry.op === 'aggregate'
      ? [
          entry.spec.stat,
          entry.spec.metric,
          Array.isArray(entry.spec.groupBy) && entry.spec.groupBy.length
            ? `by ${(entry.spec.groupBy as string[]).join('×')}`
            : null
        ]
          .filter(Boolean)
          .join(' ')
      : entry.op.replace(/_/g, ' ');

  return (
    <div className={`row ${entry.outcome}`}>
      <span className="seq">#{entry.seq}</span>
      <span className="what" title={JSON.stringify(entry.spec)}>
        {what}
        {entry.code ? <span className="code"> · {entry.code}</span> : null}
      </span>
      <span className="verdict">{entry.outcome === 'ok' ? 'disclosed' : 'refused'}</span>
      <span className="cost">{entry.charged ? `-${entry.charged}` : '—'}</span>
    </div>
  );
}

/**
 * The numbers behind the chart.
 *
 * Shows exactly what the kernel released: a banded or exact headcount, and either a quantized
 * value or an explicit "withheld". Withheld cohorts are listed rather than hidden — a reader
 * should be able to see that a cohort exists and was not reported on, which is a different
 * statement from the cohort not existing.
 */
function CellTable({ result }: { result: NonNullable<ReturnType<typeof store.snapshot>['lastAggregate']> }) {
  const rows = result.cells.slice(0, 60);
  return (
    <div className="body tight cell-scroll">
      <table className="cells">
        <thead>
          <tr>
            <th>cohort</th>
            <th>headcount</th>
            <th className="num">
              {result.stat}
              {result.metric ? ` · ${result.metric}` : ''}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr key={i}>
              <td>{label(c, result.groupBy)}</td>
              <td>{String(c.count)}</td>
              {c.value === undefined ? (
                <td className="num withheld">withheld</td>
              ) : (
                <td className="num">{formatValue(c.value, result.metric)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {result.cells.length > rows.length && (
        <div className="provenance more">
          {result.cells.length - rows.length} further cohorts not shown here; all are in the
          exported report.
        </div>
      )}
    </div>
  );
}

function formatValue(v: number, metric: string | null): string {
  if (metric === 'bonusPct') return v.toFixed(2);
  return `$${v.toLocaleString()}`;
}
