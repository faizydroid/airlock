import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { store, type OverrideRequest } from '../app/store.js';
import { buildReport, reportToMarkdown } from '../app/report.js';
import { registry, syncRegistration, allToolDefs } from '../tools/tools.js';
import { isSupported } from '../tools/webmcp.js';
import { BUDGET_CELLS, N_NUMERIC_FLOOR } from '../kernel/policy.js';
import { Chart, label } from './Chart.js';
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

  useEffect(() => {
    syncRegistration();
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
        <div className="brand">
          Airlock
          <span>your agent analyses a file it never sees</span>
        </div>

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

        <div
          className="counter"
          title="Structurally zero: no code path can place a record in a tool response or in the DOM."
        >
          <b>{s.recordsDisclosed}</b>
          <i>individual records disclosed — structurally zero, not counted</i>
        </div>
      </header>

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
            <section className="panel">
              <h2>
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

          <section className="panel">
            <h2>
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
                    className={on && newlyAdded.includes(t.name) ? 'new' : ''}
                    style={on ? undefined : { opacity: 0.35 }}
                    title={t.description}
                  >
                    {t.name}
                  </code>
                );
              })}
            </div>
          </section>
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
      <p style={{ color: '#7b8798' }}>
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
    <div className="body tight" style={{ maxHeight: 260, overflow: 'auto' }}>
      <table className="cells">
        <thead>
          <tr>
            <th>cohort</th>
            <th>headcount</th>
            <th style={{ textAlign: 'right' }}>
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
        <div className="provenance" style={{ padding: '7px 9px' }}>
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
