/**
 * Pre-submission check against the deployed site.
 *
 * Everything a judge relies on, verified over the network rather than assumed:
 * the page loads, the origin-trial tokens are being served by both mechanisms, the React root is
 * present, and the bundle contains no network primitives.
 *
 *   node scripts/verify-live.mjs [url]
 */
const url = process.argv[2] ?? 'https://airlock.dofolabs.space/';

const FORBIDDEN = [
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['EventSource', /\bEventSource\b/],
  ['RTCPeerConnection', /\bRTCPeerConnection\b/]
];

let failures = 0;

function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const res = await fetch(url, { cache: 'no-store' });
const html = await res.text();

console.log(`\n${url}\n`);

check('page responds 200', res.status === 200, `status ${res.status}`);
check('served over https', new URL(url).protocol === 'https:');

const title = (html.match(/<title>([^<]*)/) ?? [])[1] ?? '';
check('has a title', title.length > 0, title);

check('React root present', html.includes('id="root"'));

const metas = (html.match(/http-equiv="origin-trial"/g) ?? []).length;
check('origin-trial meta tags present', metas > 0, `${metas} tag(s)`);

const header = res.headers.get('origin-trial') ?? '';
check('Origin-Trial response header present', header.length > 0, `${header.length} bytes`);

// charset must remain the first thing in <head>, or the encoding declaration is out of position.
const headIdx = html.indexOf('<head>');
const charsetIdx = html.indexOf('<meta charset');
const otIdx = html.indexOf('origin-trial');
check(
  'charset precedes the injected tokens',
  charsetIdx > headIdx && charsetIdx < otIdx,
  `head@${headIdx} charset@${charsetIdx} token@${otIdx}`
);

const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
check('a module bundle is referenced', scripts.length > 0, scripts.join(', '));

for (const src of scripts) {
  const jsUrl = new URL(src, url).toString();
  try {
    const jsRes = await fetch(jsUrl, { cache: 'no-store' });
    if (!jsRes.ok) {
      check(`  bundle fetch ${src}`, false, `status ${jsRes.status}`);
      continue;
    }
    const js = await jsRes.text();
    console.log(`\n  ${src} — ${(js.length / 1024).toFixed(1)} kB`);
    for (const [label, re] of FORBIDDEN) {
      check(`  no ${label} in bundle`, !re.test(js));
    }
  } catch (err) {
    check(`  bundle fetch ${src}`, false, err?.message ?? String(err));
  }
}

const buildStamp = (html.match(/build (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/) ?? [])[1];
if (buildStamp) console.log(`\nbuild stamp: ${buildStamp}`);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
