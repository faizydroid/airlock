/**
 * Builds the deployable probe site into ./site
 *
 * Injects the Chrome origin-trial token as a <meta> tag. A meta tag is used rather than the
 * Origin-Trial response header because it travels with the file, so the same artifact can be
 * tested on Cloudflare Pages, ChatGPT Sites, or a cloudflared tunnel without reconfiguring
 * the host. Meta-tag tokens enable the feature for the document only, which is all we need:
 * tools are registered from an inline script in the document itself.
 *
 * Token source, in priority order:
 *   1. ORIGIN_TRIAL_TOKEN environment variable
 *   2. ./origin-trial-token.txt   (gitignored — do not commit tokens)
 *
 * With no token the site still builds, and still works in Chrome with
 * chrome://flags/#enable-webmcp-testing enabled. That is the local dev path.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'site');

const pages = [
  { src: 'probe/agent.html', out: 'index.html' },  // agent-facing probe
  { src: 'probe/page.html', out: 'api.html' }      // API-shape probe
];

/**
 * Multiple tokens are supported, one per line.
 *
 * Chrome evaluates every origin-trial token on a page and enables the feature if any one of
 * them validates, so serving several costs nothing and removes a class of guesswork. This
 * matters because a token registered with third-party matching enabled can be rejected when
 * delivered via a <meta> tag on a first-party document — so we serve a first-party-only token
 * alongside it rather than trying to determine which variant Chrome will accept.
 */
function readTokens() {
  const split = (s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (process.env.ORIGIN_TRIAL_TOKEN?.trim()) {
    return { tokens: split(process.env.ORIGIN_TRIAL_TOKEN), from: 'ORIGIN_TRIAL_TOKEN env' };
  }
  const f = path.join(root, 'origin-trial-token.txt');
  if (fs.existsSync(f)) {
    const tokens = split(fs.readFileSync(f, 'utf8'));
    if (tokens.length) return { tokens, from: 'origin-trial-token.txt' };
  }
  return { tokens: [], from: null };
}

/**
 * Decodes the JSON payload so a wrong origin, a wrong flag, or an expired token is obvious at
 * build time rather than after a deploy.
 *
 * Chrome's version-3 token layout is fixed:
 *   byte 0        version (0x03)
 *   bytes 1..64   Ed25519 signature (64 bytes)
 *   bytes 65..68  payload length, uint32 big-endian
 *   bytes 69..    UTF-8 JSON payload
 *
 * Do NOT locate the payload by searching for the first '{' byte: the signature is random and
 * frequently contains 0x7b, which silently truncates the parse.
 */
function describeToken(token) {
  const raw = Buffer.from(token, 'base64');

  try {
    if (raw.length > 69 && raw[0] === 0x03) {
      const len = raw.readUInt32BE(65);
      if (len > 0 && 69 + len <= raw.length) {
        return JSON.parse(raw.subarray(69, 69 + len).toString('utf8'));
      }
    }
  } catch {
    // fall through to the heuristic
  }

  // Fallback for other token versions: take the last balanced-looking JSON object.
  try {
    const end = raw.lastIndexOf(0x7d);
    if (end < 0) return null;
    for (let start = 0; start < end; start++) {
      if (raw[start] !== 0x7b) continue;
      try {
        return JSON.parse(raw.subarray(start, end + 1).toString('utf8'));
      } catch {
        // keep scanning
      }
    }
  } catch {
    return null;
  }
  return null;
}

const { tokens, from } = readTokens();
const token = tokens[0] ?? null;

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const { src, out } of pages) {
  let html = fs.readFileSync(path.join(root, src), 'utf8');

  if (tokens.length) {
    // Must appear in <head>, and as early as possible so tokens are parsed before any
    // script touches document.modelContext.
    if (!html.includes('<head>')) throw new Error(`${src}: no <head> to inject into`);
    const metas = tokens
      .map((t) => `<meta http-equiv="origin-trial" content="${t}">`)
      .join('\n');
    html = html.replace('<head>', `<head>\n${metas}`);
  }

  // Stamp the build so a stale deploy is obvious when reading the page.
  html = html.replace(
    '</body>',
    `<div style="padding:12px;color:#7d8590;font:12px ui-monospace,monospace">`
    + `build ${new Date().toISOString()} &middot; origin-trial tokens: `
    + (tokens.length ? String(tokens.length) : 'none (flag required)')
    + `</div>\n</body>`
  );

  fs.writeFileSync(path.join(outDir, out), html);
  console.log(`  ${src} -> site/${out}`);
}

// _headers is Cloudflare Pages specific and ignored elsewhere.
// Note: we deliberately do NOT send Origin-Agent-Cluster. E1c confirmed originAgentCluster is
// already true with no header, so '?1' is a no-op. The only value that matters is '?0', which
// disables WebMCP — so the rule is simply never to send it.
fs.writeFileSync(path.join(outDir, '_headers'), [
  '/*',
  '  Cache-Control: no-store',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: no-referrer',
  // One header line per token; Chrome accepts repeated Origin-Trial headers.
  ...tokens.map((t) => `  Origin-Trial: ${t}`),
  ''
].join('\n'));

console.log(`  _headers written`);

if (!tokens.length) {
  console.log(`\nno tokens found — site will need chrome://flags/#enable-webmcp-testing`);
} else {
  console.log(`\n${tokens.length} token(s) from ${from}:`);
  tokens.forEach((t, i) => {
    const p = describeToken(t);
    if (!p) {
      console.log(`  [${i}] undecodable (${t.length} chars)`);
      return;
    }
    const expires = new Date(p.expiry * 1000).toISOString().slice(0, 10);
    const flags = [
      p.isSubdomain ? 'subdomain' : null,
      p.isThirdParty ? 'THIRD-PARTY' : 'first-party'
    ].filter(Boolean).join(', ');
    console.log(`  [${i}] ${p.feature} | ${p.origin} | expires ${expires} | ${flags}`);
    if (p.isThirdParty) {
      console.log(`       ^ third-party tokens can be rejected when delivered by <meta> tag`);
    }
  });
}
console.log(`\ndeploy:  npx wrangler pages deploy site --project-name airlock\n`);
