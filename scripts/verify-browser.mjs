/**
 * End-to-end verification in a real browser.
 *
 * Everything in the test suite runs in Node against the kernel and the store. The React layer, the
 * canvas chart and the WebMCP registration path had never executed in a browser at all — so the
 * evidence for "it works" stopped at the module boundary. This script closes that gap.
 *
 * It serves the production build over http://127.0.0.1 (a secure context, so WebMCP is eligible),
 * launches Chromium with the WebMCP feature enabled, and checks the things only a browser can
 * answer:
 *
 *   - does the app render at all, with no console errors
 *   - does `document.modelContext` exist and do the tools register
 *   - does the tool list change as application state advances
 *   - does replay drive the real handlers and produce genuine refusals
 *   - does the counter stay at zero
 *   - does the canvas actually paint
 *
 * Screenshots land in `artifacts/` for use in the README and the video.
 *
 *   node scripts/verify-browser.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const artifacts = path.join(root, 'artifacts');

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/index.html not found — run `vite build` first');
  process.exit(1);
}
fs.mkdirSync(artifacts, { recursive: true });

/* ------------------------------------------------------------------ *
 * Static server                                                      *
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json'
};

// Mirrors the deployed _headers file so the tokens are delivered the same way in both places.
const headerLines = fs.existsSync(path.join(dist, '_headers'))
  ? fs.readFileSync(path.join(dist, '_headers'), 'utf8').split(/\r?\n/)
  : [];
const originTrials = headerLines
  .map((l) => l.trim())
  .filter((l) => l.startsWith('Origin-Trial:'))
  .map((l) => l.slice('Origin-Trial:'.length).trim());

const server = http.createServer((req, res) => {
  const rel = (req.url ?? '/').split('?')[0];
  const file = rel === '/' ? 'index.html' : rel.slice(1);
  const full = path.join(dist, file);

  if (!full.startsWith(dist) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  const headers = {
    'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store'
  };
  if (originTrials.length) headers['Origin-Trial'] = originTrials.join(', ');
  res.writeHead(200, headers).end(fs.readFileSync(full));
});

const PORT = 8311;
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const url = `http://127.0.0.1:${PORT}/`;

/* ------------------------------------------------------------------ *
 * Checks                                                             *
 * ------------------------------------------------------------------ */

let failures = 0;
const results = [];

function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/**
 * Prefer the locally installed Chrome over Playwright's bundled Chromium.
 *
 * WebMCP needs Chrome 146+ and Playwright ships 133, so the bundled browser cannot exercise
 * registration at all. Chrome Platform Status lists the feature's finch name as `WebMCP` and its
 * flag as "Experimental Web Platform features", so both switches are passed. An unrecognised
 * feature name is ignored rather than fatal, which makes trying several spellings free.
 */
const LAUNCH_ARGS = [
  '--enable-features=WebMCP',
  '--enable-blink-features=WebMCP',
  '--enable-experimental-web-platform-features'
];

let browser;
let browserLabel;
try {
  browser = await chromium.launch({ channel: 'chrome', args: LAUNCH_ARGS });
  browserLabel = 'installed Chrome';
} catch {
  browser = await chromium.launch({ args: LAUNCH_ARGS });
  browserLabel = 'bundled Chromium (too old for WebMCP)';
}

const page = await browser.newPage();
console.log(`\nbrowser: ${browserLabel} — ${browser.version()}\n`);

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(url, { waitUntil: 'networkidle' });

/* ---- render ---- */

const rootHtml = await page.locator('#root').innerHTML();
check('React root renders', rootHtml.length > 500, `${rootHtml.length} chars`);
check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));

check('brand visible', await page.getByText('Airlock').first().isVisible());

/* ---- the counterfactual counters ---- */

check(
  'the counterfactual is shown beside the outcome',
  (await page.locator('.counter-block.would').isVisible())
    && (await page.locator('.counter-block.did').isVisible())
);
check(
  'disclosed people reads zero on load',
  (await page.locator('.counter-block.did .figures b').first().textContent())?.trim() === '0'
);

/* ---- WebMCP availability ---- */

const mc = await page.evaluate(() => ({
  hasDocument: typeof document.modelContext?.registerTool === 'function',
  hasNavigator: typeof navigator.modelContext?.registerTool === 'function',
  secure: window.isSecureContext,
  oac: window.originAgentCluster
}));

console.log(
  `\n  document.modelContext: ${mc.hasDocument ? 'present' : 'ABSENT'}`
    + ` | secureContext: ${mc.secure} | originAgentCluster: ${mc.oac}\n`
);

check('page is a secure context', mc.secure === true);
check('document is origin-keyed', mc.oac === true);

// Not a failure if absent: headless Chromium may not expose the feature, and the app is designed
// to degrade to Replay. But the tool-count assertions below only mean something when it is there.
const webmcpAvailable = mc.hasDocument;
if (!webmcpAvailable) {
  console.log(
    '  note: WebMCP not exposed in this Chromium build, so registration cannot be checked here.\n'
      + '        The unsupported-browser notice and Replay are verified instead.\n'
  );
  check(
    'unsupported browsers are told what to do',
    await page.getByText('WebMCP is not available').isVisible()
  );
}

/* ---- tool registration and state gating ---- */

const toolChips = page.locator('.tools code');
const dimBefore = await toolChips.evaluateAll(
  (els) => els.filter((e) => e.style.opacity === '' || e.style.opacity === '1').length
);
check('tool chips rendered', (await toolChips.count()) === 9, `${await toolChips.count()} chips`);

if (webmcpAvailable) {
  check('two tools registered before a dataset exists', dimBefore === 2, `${dimBefore} active`);
}

/* ---- loading a dataset ---- */

await page.getByRole('button', { name: /Load sample dataset/i }).click();
await page.waitForTimeout(600);

check(
  'dataset loads and reports its size',
  ((await page.getByRole('button', { name: /Dataset loaded/i }).textContent()) ?? '').includes(
    '5,000'
  )
);

/* ---- A: the counterfactual becomes concrete once data exists ---- */

const wouldText = (await page.locator('.counter-block.would').innerText()) ?? '';
check('upload counterfactual shows a row count', wouldText.includes('5,000'), wouldText.replace(/\n/g, ' | '));
check('upload counterfactual shows a size', /\d+(\.\d+)?\s?(kB|MB)/.test(wouldText));
check('upload counterfactual shows a token estimate', /tokens/.test(wouldText));

/* ---- B: the attack panel ---- */

const attackButtons = page.locator('.attack > button');
check(
  'attack panel renders one button per spec',
  (await attackButtons.count()) >= 7,
  `${await attackButtons.count()} attacks`
);

await page.getByRole('button', { name: /^Run all/ }).click();
await page.waitForTimeout(2500);

const verdicts = await page.locator('.attack-result .verdict').allInnerTexts();
check('every attack produced a verdict', verdicts.length >= 7, `${verdicts.length} verdicts`);
check(
  'no attack disclosed',
  !verdicts.some((v) => v.toLowerCase().includes('disclosed')),
  verdicts.join(', ')
);
check(
  'refusals carry a policy code',
  (await page.locator('.attack-result code').count()) >= 4,
  `${await page.locator('.attack-result code').count()} codes`
);
check(
  'each result cites the test that verifies it',
  (await page.locator('.attack-result .attack-test').count()) >= 7
);
check(
  'the panel summarises how many attacks held',
  /\d+ of \d+ held/.test((await page.locator('.attack-list').locator('..').innerText()) ?? '')
);

// Attacks are real tool calls, so they must have cost budget and appear in the ledger.
const ledgerAfterAttacks = await page.locator('.ledger .row').count();
check('attacks appear in the ledger', ledgerAfterAttacks > 5, `${ledgerAfterAttacks} rows`);

if (webmcpAvailable) {
  const dimAfter = await toolChips.evaluateAll(
    (els) => els.filter((e) => e.style.opacity === '' || e.style.opacity === '1').length
  );
  check(
    'analysis tools register once a dataset exists',
    dimAfter > dimBefore,
    `${dimBefore} -> ${dimAfter}`
  );
}

/* ---- replay drives the real handlers ---- */

await page.getByRole('button', { name: /Replay the audit/i }).click();

// The script is roughly 22 seconds of paced steps.
await page.waitForTimeout(26_000);

const ledgerRows = await page.locator('.ledger .row').count();
check('ledger accumulated entries', ledgerRows > 6, `${ledgerRows} rows`);

const refusedRows = await page.locator('.ledger .row.refused').count();
check('replay produced genuine refusals', refusedRows >= 2, `${refusedRows} refused`);

check(
  'a refusal shows its policy code',
  ((await page.locator('.ledger .row.refused .code').first().textContent()) ?? '').length > 3,
  (await page.locator('.ledger .row.refused .code').first().textContent()) ?? ''
);

check('findings recorded', (await page.locator('section.panel .card h3').count()) > 0);

check(
  'inspector shows a verbatim tool return',
  ((await page.locator('pre.json').textContent()) ?? '').length > 100
);

check(
  'disclosed people still reads zero after the whole audit',
  (await page.locator('.counter-block.did .figures b').first().textContent())?.trim() === '0'
);
check(
  'aggregate values released is non-zero, so the zero has a denominator',
  Number(
    ((await page.locator('.counter-block.did .figures b').nth(1).textContent()) ?? '0').replace(
      /,/g,
      ''
    )
  ) > 10
);

/* ---- the chart actually painted ---- */

const painted = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  if (!c) return { found: false, nonBlank: false };
  const ctx = c.getContext('2d');
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  // Any non-transparent pixel means something was drawn.
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return { found: true, nonBlank: true };
  return { found: true, nonBlank: false };
});
check('canvas exists', painted.found);
check('canvas painted something', painted.nonBlank);

check(
  'withheld cohorts are shown rather than hidden',
  (await page.locator('table.cells td.withheld').count()) > 0,
  `${await page.locator('table.cells td.withheld').count()} withheld cells`
);

/* ---- no individual record in the DOM ---- */

// The strongest browser-side check available: the rendered document must contain no employee id
// and nothing resembling an unquantized salary.
const domLeak = await page.evaluate(() => {
  const text = document.body.innerText;
  const numbers = [...text.matchAll(/\$([\d,]+)/g)].map((m) => Number(m[1].replace(/,/g, '')));
  return {
    unquantized: numbers.filter((n) => n % 500 !== 0),
    hasEmployeeId: /employee[_ ]?id/i.test(text)
  };
});
check(
  'no unquantized currency in the DOM',
  domLeak.unquantized.length === 0,
  domLeak.unquantized.slice(0, 5).join(', ')
);
check('no employee identifier in the DOM', !domLeak.hasEmployeeId);

/* ---- artifacts ---- */

await page.setViewportSize({ width: 1600, height: 1000 });
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(artifacts, 'airlock-audit.png'), fullPage: false });
await page.screenshot({ path: path.join(artifacts, 'airlock-full.png'), fullPage: true });
console.log(`\n  screenshots written to artifacts/\n`);

/* ---- export ---- */

const download = await Promise.all([
  page.waitForEvent('download', { timeout: 10_000 }).catch(() => null),
  page.getByRole('button', { name: /Export audit report/i }).click()
]).then(([d]) => d);

if (download) {
  const to = path.join(artifacts, 'airlock-audit-report.md');
  await download.saveAs(to);
  const md = fs.readFileSync(to, 'utf8');
  check('report exports', md.length > 500, `${md.length} chars`);
  check('report states zero records released', md.includes('| **0** |'));
  check('report carries the ledger as provenance', md.includes('Full disclosure ledger'));
  check('report states its limitations', md.includes('## Limitations'));
} else {
  check('report exports', false, 'no download event');
}

/* ------------------------------------------------------------------ *
 * C: deep links                                                      *
 * ------------------------------------------------------------------ */

{
  const p = await browser.newPage();
  await p.goto(`${url}?replay=1`, { waitUntil: 'networkidle' });
  // Replay resets and loads on its own; a few seconds is enough to see it moving.
  await p.waitForTimeout(5000);
  const rows = await p.locator('.ledger .row').count();
  check('?replay=1 starts the audit with no interaction', rows > 0, `${rows} ledger rows`);
  check(
    '?replay=1 shows narration',
    await p.locator('.notice[role="status"]').first().isVisible()
  );
  await p.close();
}

{
  const p = await browser.newPage();
  await p.goto(`${url}?attack=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  check(
    '?attack=1 loads the dataset with no interaction',
    ((await p.getByRole('button', { name: /Dataset loaded/i }).textContent()) ?? '').includes(
      '5,000'
    )
  );
  check(
    '?attack=1 leaves the attacks ready to fire',
    await p.locator('.attack > button').first().isEnabled()
  );
  await p.close();
}

await browser.close();
server.close();

console.log(
  failures === 0
    ? `\nAll ${results.length} browser checks passed.\n`
    : `\n${failures} of ${results.length} browser checks failed.\n`
);
process.exit(failures === 0 ? 0 : 1);
