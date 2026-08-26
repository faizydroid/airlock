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

export function headersFile(tokens) {
  return [
    '/*',
    '  Cache-Control: no-store',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    // Deliberately no Origin-Agent-Cluster: originAgentCluster is already true without it in
    // Chromium. The only value that matters is '?0', which disables WebMCP, so the rule is
    // simply never to send it.
    ...tokens.map((t) => `  Origin-Trial: ${t}`),
    ''
  ].join('\n');
}
