/**
 * The counterfactual, side by side with the outcome.
 *
 * `0 records disclosed` on its own is wallpaper: a number that never moves reads as decoration
 * rather than measurement. Put beside it what the ordinary path would have cost, and the zero
 * acquires scale — the reader can see the size of what did not happen.
 *
 * Both halves are derived. The upload figures come from measuring the loaded dataset; the released
 * count is incremented by the kernel each time a value actually leaves. Nothing here is a literal,
 * which matters to anyone who checks the source behind a headline number.
 */

import type { AppState } from '../app/store.js';

function bytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1000) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

function thousands(n: number): string {
  return n.toLocaleString();
}

export function Counters({ state }: { state: AppState }) {
  const { upload, valuesReleased, recordsDisclosed, loaded } = state;

  return (
    <div className="counters">
      <div className="counter-block would">
        <label>Uploading this file would have sent</label>
        {loaded ? (
          <div className="figures">
            <span>
              <b>{thousands(upload.rows)}</b> people
            </span>
            {/* This figure was the only one without a unit caption, which read as an unfinished
                cell once the numerals became display-scale and stacked. */}
            <span>
              <b>{bytes(upload.bytes)}</b> of JSON
            </span>
            {/* The tilde belongs inside the numeral, not beside it. At label size next to a 27px
                figure it read as a floating minus sign, which is a bad thing to imply about a
                token count. */}
            <span>
              <b>~{thousands(upload.approxTokens)}</b> tokens
            </span>
          </div>
        ) : (
          <div className="figures dim">no dataset loaded</div>
        )}
      </div>

      <div className="counter-arrow" aria-hidden="true">
        →
      </div>

      <div className="counter-block did">
        <label>Actually disclosed to the agent</label>
        <div className="figures">
          <span>
            <b className="ok">{thousands(recordsDisclosed)}</b> people
          </span>
          <span>
            <b>{thousands(valuesReleased)}</b> aggregate values
          </span>
        </div>
      </div>
    </div>
  );
}
