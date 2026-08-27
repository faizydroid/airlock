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
 *
 * On styling: a canvas cannot inherit a class, so this is the one place a palette could drift out
 * of sync with the stylesheet. Rather than hardcode a second copy of the design tokens, the series
 * are declared as custom-property *names* and resolved at paint time from `:root`. The legend uses
 * the same names through `var()`. One source of truth, and changing a token in styles.css moves the
 * bars with it.
 */

import { useEffect, useRef } from 'react';
import type { AggregateOk, Cell } from '../kernel/kernel.js';

/**
 * Series palette, in assignment order.
 *
 * Black leads because the bars are the record, and because a single-series chart — the common case
 * — should read as ink on paper rather than as a colour choice. Red sits late: it means alarm
 * everywhere else in the interface, and spending it on the second series would blunt the only
 * signal that matters.
 */
const SERIES_TOKENS = ['--ink', '--violet', '--yellow', '--red', '--white', '--paper'] as const;

interface Props {
  result: AggregateOk;
}

function label(cell: Cell, dims: string[]): string {
  if (dims.length === 0) return 'All employees';
  return dims.map((d) => cell.group[d]).join(' · ');
}

/**
 * Resolves the design tokens the canvas needs. Falls back to literals only for the pathological
 * case where the stylesheet has not applied, so a missing token can never paint invisible bars.
 */
function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;

  return {
    ink: get('--ink', '#000000'),
    violet: get('--violet', '#c4b5fd'),
    grid: get('--texture', 'rgba(0,0,0,0.1)'),
    series: SERIES_TOKENS.map((t) =>
      get(
        t,
        // Order-matched fallbacks, used only if :root is unavailable.
        { '--ink': '#000000', '--violet': '#c4b5fd', '--yellow': '#ffd93d', '--red': '#ff6b6b', '--white': '#ffffff', '--paper': '#fffdf5' }[t]!
      )
    )
  };
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

    const t = readTokens();

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.parentElement?.clientWidth ?? 700;
    const cssH = 260;
    // Assigning width resets the context, including its transform, so the scale below is applied
    // to a clean state on every repaint.
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.height = `${cssH}px`;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, cssW, cssH);

    const pad = { top: 16, right: 12, bottom: 48, left: 64 };
    const plotW = cssW - pad.left - pad.right;
    const plotH = cssH - pad.top - pad.bottom;

    const values = result.cells.filter((c) => c.value !== undefined).map((c) => c.value!);
    const max = values.length ? Math.max(...values) : 1;
    const scale = (v: number) => plotH - (v / (max * 1.1)) * plotH;

    // Bold mono for every numeral, matching the stylesheet's "evidence voice".
    ctx.font = '700 10px ui-monospace, SFMono-Regular, Consolas, monospace';

    // Gridlines: the sanctioned low-alpha black the style permits for texture, at hairline weight
    // so they sit behind the bars rather than competing with them.
    ctx.strokeStyle = t.grid;
    ctx.lineWidth = 1;
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (max * 1.1 * i) / ticks;
      const y = Math.round(pad.top + scale(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
      ctx.fillStyle = t.ink;
      ctx.textAlign = 'right';
      ctx.fillText(compact(v), pad.left - 9, y + 3);
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
        const w = Math.max(2, barW - 2.5);

        if (value === undefined) {
          // Withheld cohorts are drawn as a low outlined stub rather than omitted. Visible absence
          // is the honest representation: an empty gap would read as "no data", which is a
          // different claim from "not disclosed". Violet matches the withheld cell in the table
          // below and the legend swatch, so the three agree without a caption.
          const h = 9;
          ctx.fillStyle = t.violet;
          ctx.fillRect(cx, pad.top + plotH - h, w, h);
          ctx.strokeStyle = t.ink;
          ctx.lineWidth = 2;
          ctx.strokeRect(cx + 1, pad.top + plotH - h + 1, w - 2, h - 2);
          continue;
        }

        const y = pad.top + scale(value);
        const h = plotH - scale(value);

        // Fill, then a hard black outline. The outline is the load-bearing detail: it is what makes
        // a white or yellow series legible on a white panel, and it is the chart's share of the
        // "every element has a border" rule. No drop shadow — grouped bars sit close enough that an
        // offset shadow would fall across the neighbouring bar.
        ctx.fillStyle = t.series[si % t.series.length]!;
        ctx.fillRect(cx, y, w, h);
        ctx.strokeStyle = t.ink;
        ctx.lineWidth = 2;
        ctx.strokeRect(cx + 1, y + 1, w - 2, Math.max(0, h - 1));
      }

      ctx.fillStyle = t.ink;
      ctx.textAlign = 'center';
      const cx = pad.left + groupW * xi + groupW / 2;
      ctx.fillText(truncate(String(x), Math.floor(groupW / 6)), cx, pad.top + plotH + 17);
    }

    // Axes drawn last and heavy, so the plot sits inside a visible structure rather than floating.
    ctx.strokeStyle = t.ink;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(pad.left - 1.5, pad.top);
    ctx.lineTo(pad.left - 1.5, pad.top + plotH + 1.5);
    ctx.lineTo(pad.left + plotW, pad.top + plotH + 1.5);
    ctx.stroke();

    // Axis captions.
    ctx.fillStyle = t.ink;
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
                <i style={{ background: `var(${SERIES_TOKENS[i % SERIES_TOKENS.length]})` }} />
                {s}
              </span>
            ))
          : null}
        {withheld > 0 ? (
          <span>
            <i style={{ background: 'var(--violet)' }} />
            {withheld} cohort{withheld === 1 ? '' : 's'} withheld — below the disclosure floor
          </span>
        ) : null}
      </div>
    </>
  );
}

function compact(v: number): string {
  // The axis origin is always exactly zero, and `0.00` there was just noise on every screenshot.
  if (v === 0) return '0';
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  if (v >= 1) return String(Math.round(v));
  return v.toFixed(2);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}

export { label };
