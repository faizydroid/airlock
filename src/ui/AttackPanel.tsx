/**
 * Let the visitor attack it themselves.
 *
 * The product's central property is an absence — what did not get disclosed — and an absence is
 * close to invisible. Watching someone else's demo succeed proves very little; firing an attack
 * yourself and being refused proves a great deal.
 *
 * Every button here comes from `ATTACK_SPECS`, the same array the test suite iterates. So the
 * outcome shown next to each button is verified by a test rather than asserted by this component,
 * and each result links to the test identifier that proves it. That closes the loop between claim,
 * demonstration and evidence.
 */

import { useState } from 'react';
import { ATTACK_SPECS, classify, type AttackOutcome } from '../eval/attack-specs.js';
import { allToolDefs, syncRegistration } from '../tools/tools.js';
import { store } from '../app/store.js';

const byName = new Map(allToolDefs.map((t) => [t.name, t]));

interface Result {
  outcome: AttackOutcome | 'disclosed';
  // Explicitly nullable rather than optional: `exactOptionalPropertyTypes` distinguishes an absent
  // key from a present-but-undefined one, and these genuinely are "known to be nothing".
  code: string | undefined;
  detail: string | undefined;
}

export function AttackPanel({ loaded }: { loaded: boolean }) {
  const [results, setResults] = useState<Record<string, Result>>({});
  const [running, setRunning] = useState<string | null>(null);

  const fire = async (id: string) => {
    const spec = ATTACK_SPECS.find((s) => s.id === id);
    const def = spec && byName.get(spec.tool);
    if (!spec || !def) return;

    setRunning(id);
    try {
      // The real handler, through the real tool layer. Identical to what an agent would trigger,
      // which is why the ledger and the budget respond to these clicks.
      const output = await def.execute(spec.input, { signal: new AbortController().signal });
      const outcome = classify(output);
      const withheldCount =
        outcome === 'withheld'
          ? (output as { cells: { withheld?: true }[] }).cells.filter((c) => c.withheld).length
          : 0;

      setResults((r) => ({
        ...r,
        [id]: {
          outcome,
          code: (output as { code?: string }).code,
          detail:
            outcome === 'withheld'
              ? `${withheldCount} cohort${withheldCount === 1 ? '' : 's'} withheld`
              : (output as { reason?: string }).reason
        }
      }));
      syncRegistration();
    } finally {
      setRunning(null);
    }
  };

  const fireAll = async () => {
    for (const spec of ATTACK_SPECS) await fire(spec.id);
  };

  const fired = Object.keys(results).length;
  const held = Object.values(results).filter((r) => r.outcome !== 'disclosed').length;

  return (
    <section className="panel probe">
      <h2>
        <span className="num">07</span>
        Try to break it
        <span className="tag">
          {fired === 0
            ? `${ATTACK_SPECS.length} attacks from the test suite`
            : `${held} of ${fired} held`}
        </span>
      </h2>

      {/* Wrapped in a <p> so the reading measure can be constrained on the text without also
          constraining the patterned background, which would stop mid-panel. */}
      <div className="attack-intro">
        <p>
          Each button fires a real tool call. These are the same attacks the automated suite runs,
          so what you see here is what the tests assert — including two that succeeded against an
          earlier build and are named in the README.
        </p>
      </div>

      <div className="attack-list">
        {ATTACK_SPECS.map((spec) => {
          const r = results[spec.id];
          return (
            <div key={spec.id} className={`attack ${r ? `done ${r.outcome}` : ''}`}>
              <button
                onClick={() => void fire(spec.id)}
                disabled={!loaded || running !== null}
                title={spec.stakes}
              >
                {running === spec.id ? 'running…' : spec.label}
              </button>

              {r && (
                <div className="attack-result">
                  <span className={`verdict ${r.outcome}`}>
                    {r.outcome === 'refused'
                      ? 'refused'
                      : r.outcome === 'withheld'
                        ? 'withheld'
                        : 'DISCLOSED'}
                  </span>
                  {r.code && <code>{r.code}</code>}
                  <span className="attack-test">verified by test {spec.id}</span>
                  <p>{spec.stakes}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="attack-actions">
        <button onClick={() => void fireAll()} disabled={!loaded || running !== null}>
          Run all {ATTACK_SPECS.length}
        </button>
        <button onClick={() => setResults({})} disabled={fired === 0}>
          Clear
        </button>
      </div>

      {!loaded && (
        <div className="attack-note">
          <p>
            Load the dataset first — there is nothing to attack until there is something to protect.
          </p>
        </div>
      )}
    </section>
  );
}
