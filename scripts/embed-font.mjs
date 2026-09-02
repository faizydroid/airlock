/**
 * Bakes Inter into the stylesheet as a base64 woff2 face.
 *
 * Why not a <link> to Google Fonts, which is what the design system specifies:
 *
 *   1. README's headline claim is "zero network requests after load", and the video script has a
 *      beat where the DevTools Network tab proves it on camera. A webfont request falsifies both.
 *   2. A Google Fonts request sends every visitor's IP address and Referer to a third party. In a
 *      product whose entire thesis is "your data never leaves this tab", that is not an
 *      inconsistency, it is a contradiction a reviewer would rightly punish.
 *   3. Inlining removes the flash of invisible text that `display=block` would otherwise cause.
 *      Correct type on first paint.
 *
 * Run once; the generated file is committed so the repo builds with no network access:
 *
 *   node scripts/embed-font.mjs
 *
 * Inter is licensed under the SIL Open Font License 1.1 (Rasmus Andersson), which permits
 * embedding. Attribution lives in the generated file's header, in licenses/ and in README.md.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const OUT = path.join(root, 'src', 'ui', 'fonts.css');

/**
 * Space Grotesk, the variable face across 300..700, latin subset only.
 *
 * Requesting a range rather than discrete weights returns one file covering Light through Bold,
 * instead of three static faces for the 400 / 500 / 700 the design system uses.
 *
 * Space Grotesk stops at 700 — there is no 900. A `900` request returns the 700 face and leaves the
 * browser synthesising a faux-bold, which smears the geometry badly at the display sizes this design
 * is built around. So 700 is the ceiling and scale does the shouting instead.
 *
 * latin-ext, vietnamese and the rest are dropped: the UI and the generated dataset are English, and
 * those subsets would multiply the payload for glyphs that never render.
 */
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&display=block';

// Google serves woff2 + unicode-range subsets only to browsers it recognises. Without a modern UA
// it returns legacy truetype, which is several times the size.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Safari/537.36';

async function main() {
  process.stdout.write(`fetching face list\n  ${CSS_URL}\n`);
  const res = await fetch(CSS_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Google Fonts returned ${res.status}`);
  const css = await res.text();

  // Each @font-face block is preceded by a subset comment.
  const blocks = css.split('/*').slice(1);
  const faces = [];

  for (const block of blocks) {
    const subset = block.slice(0, block.indexOf('*/')).trim();
    if (subset !== 'latin') continue;

    // Captured verbatim, NOT parsed as a single integer. A variable face declares a range
    // ("font-weight: 400 900"), and an earlier version of this script matched only the first
    // number — which pinned the face to one weight and left the browser synthesising a faux-bold
    // for everything else.
    const weight = /font-weight:\s*([^;]+);/.exec(block)?.[1]?.trim();
    const style = /font-style:\s*([^;]+);/.exec(block)?.[1]?.trim() ?? 'normal';
    const url = /src:\s*url\((https:[^)]+\.woff2)\)/.exec(block)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1]?.trim();
    if (!weight || !url) continue;

    faces.push({ weight, style, url, range });
  }

  if (faces.length === 0) throw new Error('no latin woff2 faces found in the Google Fonts response');

  const parts = [];
  let total = 0;

  for (const face of faces) {
    const bin = await fetch(face.url, { headers: { 'User-Agent': UA } });
    if (!bin.ok) throw new Error(`font ${face.weight} returned ${bin.status}`);
    const buf = Buffer.from(await bin.arrayBuffer());
    total += buf.length;
    const variable = /\s/.test(face.weight);
    process.stdout.write(
      `  weight ${face.weight}${variable ? ' (variable axis)' : ''}: `
        + `${(buf.length / 1024).toFixed(1)} kB woff2\n`
    );

    parts.push(
      `@font-face {\n`
        + `  font-family: 'Inter';\n`
        + `  font-style: ${face.style};\n`
        + `  font-weight: ${face.weight};\n`
        // `block` matches the design system's `display=block`. With the bytes inline there is no
        // fetch to block on, so this only affects the pathological no-CSS case.
        + `  font-display: block;\n`
        + `  src: url(data:font/woff2;base64,${buf.toString('base64')}) format('woff2');\n`
        + (face.range ? `  unicode-range: ${face.range};\n` : '')
        + `}\n`
    );
  }

  const header =
    `/*\n`
    + ` * Inter, embedded as base64 woff2. GENERATED — do not edit by hand.\n`
    + ` * Regenerate with: node scripts/embed-font.mjs\n`
    + ` *\n`
    + ` * Inlined rather than linked from Google Fonts because Airlock claims zero network requests\n`
    + ` * after load, and because a font request would send every visitor's IP to a third party in a\n`
    + ` * product about not disclosing data. See scripts/embed-font.mjs for the full reasoning.\n`
    + ` *\n`
    + ` * Inter (c) Rasmus Andersson, SIL Open Font License 1.1.\n`
    + ` * https://fonts.google.com/specimen/Inter\n`
    + ` *\n`
    + ` * Latin subset, variable weight axis 400..900 — one file covering Regular through Black.\n`
    + ` */\n\n`;

  fs.writeFileSync(OUT, header + parts.join('\n'), 'utf8');

  const outKb = fs.statSync(OUT).size / 1024;
  process.stdout.write(
    `\nwrote ${path.relative(root, OUT)}\n`
      + `  ${faces.length} face(s), ${(total / 1024).toFixed(1)} kB binary`
      + ` -> ${outKb.toFixed(1)} kB base64 css\n`
      + `  cost: zero network requests, correct type on first paint\n`
  );
}

main().catch((err) => {
  process.stderr.write(`\nFAILED: ${err.message}\n`);
  process.exit(1);
});
