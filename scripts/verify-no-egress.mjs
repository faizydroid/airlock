/**
 * Gates the deploy on the product's central architectural claim.
 *
 * Airlock asserts that data cannot leave the tab. The strongest evidence is that the shipped
 * bundle contains no network primitives at all, so a reviewer can confirm it with one grep rather
 * than trusting a README. This script makes that claim a build failure if it ever stops being
 * true — for instance because a dependency was added that phones home, or because a well-meaning
 * change reintroduced Vite's module-preload polyfill.
 *
 * Run after `vite build`, before deploying.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const assets = path.join(root, 'dist', 'assets');

if (!fs.existsSync(assets)) {
  console.error('dist/assets not found — run `vite build` first');
  process.exit(1);
}

/**
 * Network primitives. Each would be a way for the page to transmit data off-device.
 *
 * `import(` is included because a dynamic import can pull code from an arbitrary URL at runtime,
 * which is egress with extra steps.
 */
const FORBIDDEN = [
  ['fetch(', /\bfetch\s*\(/g],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/g],
  ['WebSocket', /\bWebSocket\b/g],
  ['RTCPeerConnection', /\bRTCPeerConnection\b/g],
  ['sendBeacon', /\bsendBeacon\b/g],
  ['EventSource', /\bEventSource\b/g],
  ['dynamic import()', /\bimport\s*\(/g],
  ['Worker(', /\bnew\s+(Shared)?Worker\s*\(/g]
];

const files = fs
  .readdirSync(assets)
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join(assets, f));

let failed = false;
let totalBytes = 0;

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  totalBytes += text.length;
  const name = path.relative(root, file);

  for (const [label, re] of FORBIDDEN) {
    const matches = text.match(re);
    if (matches) {
      failed = true;
      const i = text.search(re);
      console.error(`\n${name}: found ${matches.length}x "${label}"`);
      console.error(`  context: ...${text.slice(Math.max(0, i - 90), i + 90)}...`);
    }
  }
}

console.log(
  `\nchecked ${files.length} bundle(s), ${(totalBytes / 1024).toFixed(1)} kB`
);

if (failed) {
  console.error(
    '\nFAIL: the bundle contains a network primitive.\n'
      + 'Airlock claims data cannot leave the tab. Either remove the primitive or, if it is\n'
      + 'genuinely benign, narrow the claim in README.md and docs/threat-model.md to match.\n'
  );
  process.exit(1);
}

console.log('PASS: no network primitives in the shipped bundle.\n');
