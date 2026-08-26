/**
 * Aggregate-only chart.
 *
 * Renders to a canvas from already-disclosed cells. It receives no records and cannot compute a
 * statistic — the values arriving here have already passed the disclosure policy and been
 * quantized.
 *
 * Chart types deliberately excluded:
 *   - box plots, which render outliers as individual dots and are the canonical
 *     individual-disclosing chart
 *   - violin plots, which are density estimates over individual points
 *
 * Both appeared in an early draft's list of "aggregate-by-construction" charts, which was wrong.
 * Bars over pre-aggregated cohorts cannot encode an individual, and neither can a screenshot of
 * one.
 *
 * No chart library, deliberately: libraries attach raw arrays to DOM nodes (`__data__`), emit
 * tooltips and write numeric `aria-label`s, all of which are disclosure channels that would then
 * need auditing. Hand-drawn to canvas has none of that surface.
 */

import { useEffect, useRef } from 'react';
import type { AggregateOk, Cell } from '../kernel/kernel.js';

const SERIES_COLOURS = ['#58a6ff', '#f0883e', '#3fb950', '#bc8cff', '#d29922', '#f85149'];

interface Props {
  result: AggregateOk;
}

function label(cell: Cell, dims: string[]): string {
  if (dims.length === 0) return 'All employees';
  return dims.map((d) => cell.group[d]).join(' · ');
}

export function Chart({ result }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  // The first dimension becomes the x axis; a second becomes the series within each group.
  const [xDim, seriesDim] = result.groupBy;
  const xs = xDim ? [...new Set(result.cells.map((c) => c.group[xDim]!))] : ['All'];
  const series = seriesDim ? [...new Set(result.cells.map((c) => c.group[seriesDim]!))] : [''];

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.parentElement?.clientWidth ?? 700;
    const cssH = 260;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.height = `${cssH}px`;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, cssW, cssH);

    const pad = { top: 16, right: 12, bottom: 46, left: 62 };
    const plotW = cssW - pad.left - pad.right;
    const plotH = cssH - pad.top - pad.bottom;

    const values = result.cells.filter((c) => c.value !== undefined).map((c) => c.value!);
    const max = values.length ? Math.max(...values) : 1;
    const scale = (v: number) => plotH - (v / (max * 1.1)) * plotH;

    // Axes and gridlines.
    ctx.strokeStyle = '#232a37';
    ctx.fillStyle = '#7b8798';
    ctx.font = '10px ui-monospace, monospace';
    ctx.lineWidth = 1;

    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (max * 1.1 * i) / ticks;
      const y = pad.top + scale(v);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(compact(v), pad.left - 7, y + 3);
    }

    // Bars.
    const groupW = plotW / xs.length;
    const barW = Math.max(3, (groupW * 0.72) / series.length);

    for (let xi = 0; xi < xs.length; xi++) {
      const x = xs[xi]!;

      for (let si = 0; si < series.length; si++) {
        const s = series[si]!;
        const cell = result.cells.find(
          (c) => (!xDim || c.group[xDim] === x) && (!seriesDim || c.group[seriesDim] === s)
        );
        const cx = pad.left + groupW * xi + groupW * 0.14 + si * barW;
        const value = cell?.value;

        if (value === undefined) {
          // Withheld cohorts are drawn as a low stub rather than omitted. Visible absence is the
          // honest representation: an empty gap would read as "no data", which is a different
          // claim from "not disclosed".
          ctx.fillStyle = '#1f2632';
          ctx.fillRect(cx, pad.top + plotH - 5, barW - 1.5, 5);
          continue;
        }

        ctx.fillStyle = SERIES_COLOURS[si % SERIES_COLOURS.length]!;
        const y = pad.top + scale(value);
        ctx.fillRect(cx, y, barW - 1.5, plotH - scale(value));
      }

      ctx.fillStyle = '#7b8798';
      ctx.textAlign = 'center';
      const cx = pad.left + groupW * xi + groupW / 2;
      ctx.fillText(truncate(String(x), Math.floor(groupW / 6)), cx, pad.top + plotH + 15);
    }

    // Axis captions.
    ctx.fillStyle = '#4d5768';
    ctx.textAlign = 'left';
    ctx.fillText(xDim ?? 'whole company', pad.left, cssH - 8);
    ctx.textAlign = 'right';
    ctx.fillText(
      `${result.stat}${result.metric ? ' · ' + result.metric : ''}`,
      pad.left + plotW,
      cssH - 8
    );
  }, [result, xs, series, xDim, seriesDim]);

  const withheld = result.cells.filter((c) => c.withheld).length;

  return (
    <>
      <canvas
        ref={ref}
        role="img"
        aria-label={
          `Bar chart of ${result.stat}`
          + `${result.metric ? ' of ' + result.metric : ''}`
          + `${xDim ? ' by ' + xDim : ' for the whole company'}`
          + `${seriesDim ? ' and ' + seriesDim : ''}.`
          + ` ${result.cells.length - withheld} cohorts reported, ${withheld} withheld as too small.`
          + ' Values are aggregates only; no individual figures are shown.'
        }
      />
      <div className="chart-legend">
        {seriesDim
          ? series.map((s, i) => (
              <span key={s}>
                <i style={{ background: SERIES_COLOURS[i % SERIES_COLOURS.length] }} />
                {s}
              </span>
            ))
          : null}
        {withheld > 0 ? (
          <span>
            <i style={{ background: '#1f2632' }} />
            {withheld} cohort{withheld === 1 ? '' : 's'} withheld — below the disclosure floor
          </span>
        ) : null}
      </div>
    </>
  );
}

function compact(v: number): string {
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  if (v >= 1) return String(Math.round(v));
  return v.toFixed(2);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}

export { label };
