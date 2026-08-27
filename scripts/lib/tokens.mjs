/**
 * Origin trial token handling, shared by the probe build and the app build.
 *
 * Tokens are read one per line from ORIGIN_TRIAL_TOKEN or ./origin-trial-token.txt. Chrome
 * evaluates every token present on a page and enables the feature if any one validates, so
 * serving several costs nothing.
 */
import fs from 'node:fs';
import path from 'node:path';

export function readTokens(root) {
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
 * Decodes a token's JSON payload.
 *
 * Chrome's version-3 layout is fixed:
 *   byte 0        version (0x03)
 *   bytes 1..64   Ed25519 signature
 *   bytes 65..68  payload length, uint32 big-endian
 *   bytes 69..    UTF-8 JSON payload
 *
 * Do not locate the payload by searching for the first '{' byte: the signature is random and
 * frequently contains 0x7b, which silently truncates the parse.
 */
export function describeToken(token) {
  const raw = Buffer.from(token, 'base64');

  try {
    if (raw.length > 69 && raw[0] === 0x03) {
      const len = raw.readUInt32BE(65);
      if (len > 0 && 69 + len <= raw.length) {
        return JSON.parse(raw.subarray(69, 69 + len).toString('utf8'));
      }
    }
  } catch {
    /* fall through */
  }

  try {
    const end = raw.lastIndexOf(0x7d);
    if (end < 0) return null;
    for (let start = 0; start < end; start++) {
      if (raw[start] !== 0x7b) continue;
      try {
        return JSON.parse(raw.subarray(start, end + 1).toString('utf8'));
      } catch {
        /* keep scanning */
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function reportTokens(tokens, from) {
  if (!tokens.length) {
    console.log('no origin-trial tokens — the site will require chrome://flags/#enable-webmcp-testing');
    return;
  }
  console.log(`${tokens.length} origin-trial token(s) from ${from}:`);
  for (const [i, t] of tokens.entries()) {
    const p = describeToken(t);
    if (!p) {
      console.log(`  [${i}] undecodable (${t.length} chars)`);
      continue;
    }
    const expires = new Date(p.expiry * 1000).toISOString().slice(0, 10);
    const flags = [p.isSubdomain ? 'subdomain' : null, p.isThirdParty ? 'third-party' : 'first-party']
      .filter(Boolean)
      .join(', ');
    console.log(`  [${i}] ${p.feature} | ${p.origin} | expires ${expires} | ${flags}`);
  }
}

export function metaTags(tokens) {
  return tokens.map((t) => `<meta http-equiv="origin-trial" content="${t}">`).join('\n');
}

/**
 * Content Security Policy for the app.
 *
 * `connect-src 'none'` is the point of this whole header, and it is the strongest single line in the
 * project. Until now "data cannot leave the tab" rested on `verify-no-egress.mjs` grepping the built
 * bundle for network primitives — good evidence, but evidence about the code we happened to ship.
 * With this directive the *browser* refuses fetch, XMLHttpRequest, WebSocket, EventSource and
 * sendBeacon outright, so the guarantee survives code we did not anticipate. Claim becomes
 * enforcement.
 *
 * `default-src 'none'` then makes every other directive an explicit allowance:
 *
 *   script-src 'self'        the single Vite module bundle; no inline script anywhere
 *   style-src  'unsafe-inline'  unavoidable, and styles only — never scripts. React writes inline
 *                            `style` attributes for the two genuinely dynamic values in the UI (the
 *                            budget meter's width and the chart legend swatches). CSP governs style
 *                            attributes under style-src, so there is no nonce or hash route to it
 *                            short of removing dynamic styling altogether.
 *   img-src    data:         the inline SVG favicon
 *   font-src   data:         the inlined base64 woff2
 *   frame-ancestors 'none'   not embeddable, so the UI cannot be framed and clickjacked
 *   base-uri / form-action / object-src 'none'   nothing to allow, so allow nothing
 *
 * Deliberately absent: Cross-Origin-Embedder-Policy. `require-corp` would demand CORP on every
 * subresource and has a history of interacting badly with origin trials, and there is no
 * cross-origin isolation requirement here to justify the risk.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join('; ');

/**
 * Cache-Control is deliberately NOT in the `/*` block.
 *
 * Cloudflare Pages *combines* the headers of every matching rule rather than letting a more specific
 * path override one. With `no-store` on `/*`, adding an immutable rule for `/assets/*` produced the
 * literal value `no-store, public, max-age=31536000, immutable` — self-contradictory, with `no-store`
 * winning, so the caching gained nothing and the header became nonsense. Verified against the live
 * deployment, not assumed.
 *
 * So freshness is scoped to the documents that need it and the hashed assets are cached hard.
 */
export function headersFile(tokens) {
  return [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    `  Content-Security-Policy: ${CSP}`,
    // frame-ancestors covers modern browsers; this is for the ones that do not implement it.
    '  X-Frame-Options: DENY',
    '  Cross-Origin-Opener-Policy: same-origin',
    // No feature this page uses needs any of these, and a privacy tool should not be able to ask.
    '  Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=(), usb=(), '
      + 'midi=(), serial=(), bluetooth=(), display-capture=()',
    // Two years. No includeSubDomains: this is one subdomain of a shared apex and it has no business
    // setting policy for its siblings.
    '  Strict-Transport-Security: max-age=63072000',
    // Deliberately no Origin-Agent-Cluster: originAgentCluster is already true without it in
    // Chromium. The only value that matters is '?0', which disables WebMCP, so the rule is
    // simply never to send it.
    ...tokens.map((t) => `  Origin-Trial: ${t}`),
    '',
    // The document must never be stale: a visitor has to get the build that matches the current
    // asset hashes, and a judge has to get whatever is deployed right now. Both spellings, because
    // the site is reachable as `/` and as `/index.html`.
    '/',
    '  Cache-Control: no-store',
    '',
    '/index.html',
    '  Cache-Control: no-store',
    '',
    // Vite content-hashes every asset filename, so the bytes behind a given URL can never change.
    // Without this every repeat visit re-downloaded ~310 kB of JS and CSS for nothing.
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    ''
  ].join('\n');
}
