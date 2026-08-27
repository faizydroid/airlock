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
 * Black leads because the bars are the record, and because a single-series chart — the common case —
 * should read as ink on paper rather than as a colour choice. Swiss Red takes the second series so
 * that a two-series comparison, which is what a pay-gap chart is, lands as black against red.
 * Everything after that is a grey ramp.
 *
 * These are the `--data-*` tokens rather than the chrome palette, because six cohorts have to be
 * distinguishable and the style supplies exactly two usable hues. A grey ramp for series encoding is
 * ordinary information design; using those greys anywhere in the interface chrome would not be.
 */
const SERIES_TOKENS = [
  '--data-1',
  '--data-2',
  '--data-3',
  '--data-4',
  '--data-5',
  '--data-6'
] as const;

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
const SERIES_FALLBACK: Record<string, string> = {
  '--data-1': '#000000',
  '--data-2': '#ff3000',
  '--data-3': '#6e6e6e',
  '--data-4': '#ababab',
  '--data-5': '#d6d6d6',
  '--data-6': '#ffffff'
};

function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;

  return {
    ink: get('--ink', '#000000'),
    muted: get('--muted', '#f2f2f2'),
    series: SERIES_TOKENS.map((t) => get(t, SERIES_FALLBACK[t]!))
  };
}

/**
 * A 45-degree hatch, matching the CSS `repeating-linear-gradient` used for every other suppressed
 * surface in the interface — the withheld table cell, the withheld verdict, the unregistered tool
 * chip, the disabled button.
 *
 * Withheld cohorts are marked by texture rather than by colour on purpose: the accent is reserved
 * for the two states that must stop a reader, and a suppressed cohort is not one of them.
 */
function hatchPattern(ctx: CanvasRenderingContext2D, ink: string): CanvasPattern | string {
  const tile = document.createElement('canvas');
  tile.width = 6;
  tile.height = 6;
  const g = tile.getContext('2d');
  if (!g) return ink;
  g.strokeStyle = ink;
  g.lineWidth = 1;
  // Two strokes so the diagonal continues across tile boundaries without a visible seam.
  g.beginPath();
  g.moveTo(-1, 5);
  g.lineTo(5, -1);
  g.moveTo(2, 8);
  g.lineTo(8, 2);
  g.stroke();
  return ctx.createPattern(tile, 'repeat') ?? ink;
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
    const hatch = hatchPattern(ctx, t.ink);

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

    // Inter, matching the interface. Uppercase tracking is applied by hand below where it matters,
    // since canvas has no letter-spacing before Chrome 99+ and this must not depend on it.
    ctx.font = '700 10px Inter, system-ui, sans-serif';

    // Gridlines at hairline weight, so they describe the scale without competing with the bars.
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
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
      ctx.fillText(compact(v), pad.left - 10, y + 3.5);
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
          // Withheld cohorts are drawn as a hatched stub rather than omitted. Visible absence is the
          // honest representation: an empty gap would read as "no data", which is a different claim
          // from "not disclosed". The hatch is the same 45-degree texture every other suppressed
          // surface uses, so the chart, the table and the legend agree without needing a caption.
          const h = 14;
          ctx.fillStyle = t.muted;
          ctx.fillRect(cx, pad.top + plotH - h, w, h);
          ctx.fillStyle = hatch;
          ctx.fillRect(cx, pad.top + plotH - h, w, h);
          ctx.strokeStyle = t.ink;
          ctx.lineWidth = 1;
          ctx.strokeRect(cx + 0.5, pad.top + plotH - h + 0.5, w - 1, h - 1);
          continue;
        }

        const y = pad.top + scale(value);
        const h = plotH - scale(value);

        // Fill, then a hairline black rule. The rule is load-bearing: it is what makes the light end
        // of the grey ramp legible on white, and it is the chart's share of "structure is visible".
        // One pixel rather than two — this style is precise, not heavy.
        ctx.fillStyle = t.series[si % t.series.length]!;
        ctx.fillRect(cx, y, w, h);
        ctx.strokeStyle = t.ink;
        ctx.lineWidth = 1;
        ctx.strokeRect(cx + 0.5, y + 0.5, w - 1, Math.max(0, h - 0.5));
      }

      ctx.fillStyle = t.ink;
      ctx.textAlign = 'center';
      const cx = pad.left + groupW * xi + groupW / 2;
      ctx.fillText(truncate(String(x), Math.floor(groupW / 6)), cx, pad.top + plotH + 17);
    }

    // Axes drawn last at 2px, so the plot sits inside a visible structure rather than floating.
    // Matches the 2px border weight the stylesheet uses for panels.
    ctx.strokeStyle = t.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pad.left - 1, pad.top);
    ctx.lineTo(pad.left - 1, pad.top + plotH + 1);
    ctx.lineTo(pad.left + plotW, pad.top + plotH + 1);
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
            {/* Class rather than an inline token, so the swatch's hatch is defined in one place
                alongside every other suppressed surface. */}
            <i className="hatched" />
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
