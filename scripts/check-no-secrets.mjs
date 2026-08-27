/**
 * Pre-push guard: nothing secret-shaped in the tracked tree.
 *
 * The repository is public, so this runs before pushing and before submitting. It is deliberately
 * blunt — it looks for long base64-ish runs and a handful of common credential markers, and it
 * treats a hit as something a human must look at rather than something to auto-classify.
 *
 * The origin-trial token is not a secret in the security sense (it is served in the page's HTML to
 * every visitor) but it is per-origin and has no business in version control, so it is checked for
 * explicitly.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);

/**
 * Exemptions from the base64 scan, each for a stated reason.
 *
 * Kept short and justified: an allowlist that grows without explanation is how a real secret
 * eventually slips through.
 */
const BASE64_EXEMPT = [
  // These two files exist to read and inject the origin-trial token. They contain no token.
  /^scripts\/inject-token\.mjs$/,
  /^scripts\/lib\/tokens\.mjs$/,
  // npm integrity fields are SHA-512 checksums of public packages. Hundreds of them, all public.
  /^package-lock\.json$/
];

const MARKERS = [
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Cloudflare API token assignment', /CLOUDFLARE_API_TOKEN\s*=\s*["'][A-Za-z0-9_-]{20,}/],
  ['bearer literal', /Bearer\s+[A-Za-z0-9._-]{30,}/]
];

let problems = 0;

function report(file, what, sample) {
  problems++;
  console.log(`  ${file}\n    ${what}${sample ? `: ${sample}` : ''}`);
}

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');

  for (const [label, re] of MARKERS) {
    if (re.test(text)) report(file, label);
  }

  /**
   * Inline webfont payloads are woff2 binaries, not credentials.
   *
   * Stripped surgically rather than by exempting the file: the pattern only matches a payload that
   * actually begins with the base64 encoding of the woff2 signature — `wOF2` is `d09GMg` — so a long
   * base64 run that is not a font, including one hidden in this same file, is still reported. A
   * blanket file exemption would have created exactly the blind spot this script exists to prevent.
   */
  const scrubbed = text.replace(
    /(url\(data:font\/woff2;base64,)d09GMg[A-Za-z0-9+/]+={0,2}(\))/g,
    '$1WOFF2_PAYLOAD_STRIPPED$2'
  );

  // Long unbroken base64 runs. The origin-trial token is ~260 chars, so 80 is a safe net.
  if (!BASE64_EXEMPT.some((p) => p.test(file))) {
    const runs = scrubbed.match(/[A-Za-z0-9+/]{80,}={0,2}/g);
    if (runs) {
      // The inline SVG favicon is percent-encoded, not base64, so it will not match. Anything that
      // does match here is worth a human looking at.
      report(file, `${runs.length} long base64-ish run(s)`, `${runs[0].slice(0, 44)}…`);
    }
  }
}

// The token file must never be tracked, whatever else is true.
if (files.includes('origin-trial-token.txt')) {
  report('origin-trial-token.txt', 'origin-trial token is tracked; it should be gitignored');
}

console.log(
  problems === 0
    ? `\nCLEAN: ${files.length} tracked files, nothing secret-shaped.\n`
    : `\n${problems} thing(s) to look at before pushing.\n`
);
process.exit(problems === 0 ? 0 : 1);
