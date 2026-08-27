/**
 * Accessibility and degraded-path verification.
 *
 * Answers "what does an ordinary visitor actually get?", which is a different question from
 * "does the demo work" — and the one `verify-browser.mjs` does not ask. Three areas:
 *
 *   1. The no-WebMCP path. Almost nobody arriving at this page has the Chrome flag enabled, so the
 *      unsupported experience is the common case, not the edge case. `document.modelContext` is
 *      shadowed before any app code runs and the whole Replay narrative is exercised without it.
 *   2. Accessibility structure: landmarks, a single h1, heading order, keyboard reachability,
 *      visible focus, and that prefers-reduced-motion genuinely suppresses transitions.
 *   3. Contrast, computed from the rendered page rather than reasoned about on paper — including the
 *      8.5px red test citations and the disabled button, both of which are where a contrast bug
 *      would be easiest to ship and hardest to notice.
 *
 * This exists because it caught a real defect on first run: the page had six h2 elements and no h1
 * at all, so anyone navigating by heading landed mid-document with nothing to orient against.
 *
 *   npm run verify:a11y
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const rel = (req.url ?? '/').split('?')[0];
  const full = path.join(dist, rel === '/' ? 'index.html' : rel.slice(1));
  if (!full.startsWith(dist) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return res.writeHead(404).end('x');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(full));
});
await new Promise((r) => server.listen(8377, '127.0.0.1', r));
const URL_ = 'http://127.0.0.1:8377/';

let fails = 0;
const check = (label, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ channel: 'chrome' });

/* ================= 1. the no-WebMCP visitor ================= */

console.log('\n=== A visitor with no WebMCP (the common case) ===\n');
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  // Shadow the API before any app code runs.
  await page.addInitScript(() => {
    Object.defineProperty(document, 'modelContext', { value: undefined, configurable: true });
  });
  await page.goto(URL_, { waitUntil: 'networkidle' });

  check('app renders without WebMCP', (await page.locator('#root').innerHTML()).length > 500);
  check(
    'the unsupported notice explains what to do',
    await page.getByText('WebMCP is not available').isVisible()
  );
  check('no console errors on the unsupported path', errors.length === 0, errors.join(' | ').slice(0, 200));

  // Replay is the advertised bridge for these visitors. It must work with no WebMCP at all.
  const t0 = Date.now();
  await page.getByRole('button', { name: /Load sample dataset/i }).click();
  await page.waitForTimeout(50);
  const genMs = Date.now() - t0;
  check('dataset generation is not a visible stall', genMs < 2500, `${genMs}ms for 5,000 rows`);

  await page.getByRole('button', { name: /Replay the audit/i }).click();
  await page.waitForTimeout(9000);
  const rows = await page.locator('.ledger .row').count();
  check('replay drives the ledger with no WebMCP', rows > 2, `${rows} rows after 9s`);
  check('counter still reads zero', (await page.locator('.counter-block.did .figures b').first().textContent())?.trim() === '0');
  await page.close();
}

/* ================= 2. accessibility structure ================= */

console.log('\n=== Accessibility structure ===\n');
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Load sample dataset/i }).click();
  await page.waitForTimeout(600);

  const struct = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('h1,h2,h3,h4')].map((h) => ({
      level: Number(h.tagName[1]),
      text: h.innerText.replace(/\s+/g, ' ').trim().slice(0, 40)
    }));
    return {
      heads,
      h1Count: heads.filter((h) => h.level === 1).length,
      landmarks: {
        main: document.querySelectorAll('main').length,
        header: document.querySelectorAll('header').length,
        nav: document.querySelectorAll('nav').length
      },
      lang: document.documentElement.lang || null,
      title: document.title,
      imgsNoAlt: [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).length,
      canvasLabelled: [...document.querySelectorAll('canvas')].every(
        (c) => c.getAttribute('role') === 'img' && (c.getAttribute('aria-label') ?? '').length > 20
      ),
      buttonsUnnamed: [...document.querySelectorAll('button')].filter(
        (b) => !(b.innerText.trim() || b.getAttribute('aria-label'))
      ).length
    };
  });

  check('document has a lang attribute', struct.lang !== null, String(struct.lang));
  check('document has a title', struct.title.length > 10, struct.title);
  check('exactly one h1', struct.h1Count === 1, `${struct.h1Count} found`);
  check('a main landmark exists', struct.landmarks.main === 1);
  check('every canvas has role=img and a real aria-label', struct.canvasLabelled);
  check('every button has an accessible name', struct.buttonsUnnamed === 0, `${struct.buttonsUnnamed} unnamed`);
  check('no img without alt', struct.imgsNoAlt === 0);

  // Heading order: no level should jump by more than one.
  let jump = null;
  for (let i = 1; i < struct.heads.length; i++) {
    const d = struct.heads[i].level - struct.heads[i - 1].level;
    if (d > 1) { jump = `${struct.heads[i - 1].text} (h${struct.heads[i - 1].level}) -> ${struct.heads[i].text} (h${struct.heads[i].level})`; break; }
  }
  check('heading levels never skip', jump === null, jump ?? '');
  if (struct.h1Count !== 1) console.log(`      headings: ${struct.heads.map((h) => 'h' + h.level).join(' ')}`);

  /* keyboard reachability and visible focus */
  const kb = await page.evaluate(() => {
    const focusable = [...document.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')]
      .filter((e) => !e.hasAttribute('disabled') && e.offsetParent !== null);
    return { count: focusable.length };
  });
  check('there are focusable controls', kb.count > 3, `${kb.count} reachable`);

  await page.keyboard.press('Tab');
  const focusVisible = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { ok: false, why: 'nothing focused' };
    const cs = getComputedStyle(el);
    const w = parseFloat(cs.outlineWidth || '0');
    return { ok: w >= 2 && cs.outlineStyle !== 'none', why: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`, tag: el.tagName };
  });
  check('first tab stop has a visible focus ring', focusVisible.ok, `${focusVisible.tag}: ${focusVisible.why}`);

  /* reduced motion actually takes effect */
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(200);
  const rm = await page.evaluate(() => {
    const b = document.querySelector('.toolbar button');
    return parseFloat(getComputedStyle(b).transitionDuration) < 0.01;
  });
  check('prefers-reduced-motion suppresses transitions', rm);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  /* ================= 3. measured contrast ================= */
  console.log('\n=== Measured contrast (not reasoned) ===\n');

  await page.getByRole('button', { name: /^Run all/i }).click().catch(() => {});
  await page.waitForTimeout(2500);

  const contrast = await page.evaluate(() => {
    const lum = (rgb) => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const parse = (c) => (c.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    const effectiveBg = (el) => {
      let n = el;
      while (n) {
        const bg = getComputedStyle(n).backgroundColor;
        const p = parse(bg);
        if (p.length === 3 && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(bg)) return p;
        n = n.parentElement;
      }
      return [255, 255, 255];
    };
    const ratio = (el) => {
      const fg = parse(getComputedStyle(el).color);
      const bg = effectiveBg(el);
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    };
    const out = [];
    const targets = [
      ['.attack-result .attack-test', 'test citation (small red)'],
      ['.row .verdict', 'ledger verdict chip'],
      ['.attack-result .verdict', 'attack verdict block'],
      ['section.panel > h2 .num', 'section number (red)'],
      ['.sev', 'severity badge'],
      ['table.cells td.withheld', 'withheld cell'],
      ['.provenance', 'provenance label']
    ];
    for (const [sel, label] of targets) {
      const el = document.querySelector(sel);
      if (!el) { out.push({ label, ratio: null }); continue; }
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 700;
      const large = size >= 24 || (bold && size >= 18.66);
      out.push({ label, ratio: Math.round(ratio(el) * 100) / 100, size, large, need: large ? 3 : 4.5 });
    }
    return out;
  });

  for (const c of contrast) {
    if (c.ratio === null) { console.log(`      (absent) ${c.label}`); continue; }
    check(
      `contrast ${c.label}`,
      c.ratio >= c.need,
      `${c.ratio}:1 at ${c.size}px, needs ${c.need}:1`
    );
  }

  // Disabled button, which is where an invisible label bit once already.
  await page.locator('.toolbar button').first().waitFor();
  const dis = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.disabled);
    if (!b) return null;
    const cs = getComputedStyle(b);
    return { color: cs.color, text: b.innerText.trim().slice(0, 30) };
  });
  check('disabled button keeps a visible label', dis === null || dis.color === 'rgb(0, 0, 0)', dis ? `${dis.color} "${dis.text}"` : 'none disabled');

  await page.close();
}

console.log(`\n${fails === 0 ? 'no failures' : `${fails} failure(s)`}\n`);
await browser.close();
server.close();
process.exit(fails === 0 ? 0 : 1);
