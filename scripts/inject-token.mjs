/**
 * Post-build step: inject origin trial tokens into dist/index.html and write dist/_headers.
 *
 * Runs after `vite build`. Tokens go in as <meta> tags immediately after <meta charset>, and as
 * repeated Origin-Trial response headers via Cloudflare Pages' _headers file. Two delivery
 * mechanisms because neither is guaranteed and both are free.
 *
 * The build succeeds with no tokens; the site then requires chrome://flags/#enable-webmcp-testing,
 * which is what the WebMCP Challenge instructs judges to enable anyway.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readTokens, reportTokens, metaTags, headersFile } from './lib/tokens.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const indexPath = path.join(dist, 'index.html');

if (!fs.existsSync(indexPath)) {
  console.error('dist/index.html not found — run `vite build` first');
  process.exit(1);
}

const { tokens, from } = readTokens(root);
let html = fs.readFileSync(indexPath, 'utf8');

// Charset must stay first in <head>; insert immediately after it.
const anchor = '<meta charset="utf-8">';
if (!html.includes(anchor)) {
  console.error(`expected ${anchor} in dist/index.html`);
  process.exit(1);
}

if (tokens.length) {
  html = html.replace(anchor, `${anchor}\n${metaTags(tokens)}`);
}

// Replace the placeholder comment either way, so the built output never ships a TODO.
html = html.replace(
  /<!-- ORIGIN_TRIAL_TOKENS:[^>]*-->\n?/,
  tokens.length ? '' : '<!-- no origin-trial token: Chrome flag required -->\n'
);

fs.writeFileSync(indexPath, html);
fs.writeFileSync(path.join(dist, '_headers'), headersFile(tokens));

reportTokens(tokens, from);
console.log(`\ninjected into dist/index.html and dist/_headers`);
