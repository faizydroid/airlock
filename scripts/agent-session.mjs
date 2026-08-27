/**
 * Drives a real language model against Airlock's live WebMCP tools.
 *
 * WHY THIS EXISTS
 *
 * Everything else in this repository is verified: 157 tests against the kernel, 42 browser checks
 * in real Chrome with `document.modelContext` present. One claim was not: that a *model* discovers
 * these nine tools from their descriptions alone and chooses the right ones, unprompted, without
 * ever being shown the source. That is the claim a WebMCP submission actually rests on, and a
 * screen recording of a chat extension proves it only for the person who recorded it.
 *
 * This script makes it reproducible. It:
 *
 *   1. serves the production build over http://127.0.0.1 (a secure context, so WebMCP is eligible)
 *   2. launches the installed Chrome with the WebMCP feature enabled
 *   3. loads the dataset — a HUMAN action in the product's design, and treated as one here
 *   4. calls `document.modelContext.getTools()` to read the tool list the browser exposes
 *   5. hands those tools to a real model as function definitions, with a one-line goal
 *   6. executes whatever the model asks for via `document.modelContext.executeTool()`
 *   7. feeds the results back and loops, until the model stops calling tools
 *   8. writes a transcript to artifacts/ — including every refusal it walked into
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT
 *
 * Proves: the descriptions are good enough for a model to plan an audit; the enum-bounded schemas
 * survive contact with a real planner; the kernel refuses correctly under model-driven pressure
 * rather than under test-driven pressure.
 *
 * Does not prove: that the browser's own agent channel works end to end. This invokes `executeTool`
 * from page script, which runs the same registered handlers and the same policy kernel but bypasses
 * whatever permission plumbing sits between a browser-native agent and the page. The Tool Inspector
 * extension is still the thing that closes that last gap. These are complementary, not substitutes,
 * and the transcript says so.
 *
 * ON THE "NO NETWORK" CLAIM
 *
 * This script runs in Node, outside the page. The page still makes zero network requests — the
 * model API is called by this harness, exactly as ChatGPT would call it from outside the tab. And
 * note what crosses the wire: tool descriptions, and the aggregate values the kernel chose to
 * release. Never a record. That is the entire thesis, executed rather than asserted.
 *
 * `scripts/verify-no-egress.mjs` only scans `dist/assets/*.js`, so the `fetch` below is not in the
 * shipped bundle and does not weaken that gate.
 *
 * USAGE
 *
 *   node scripts/agent-session.mjs --dry-run     # no model, no credentials: proves the plumbing
 *   node scripts/agent-session.mjs               # real model
 *
 * Providers, in the order they are auto-detected:
 *
 *   ANTHROPIC_API_KEY   OPENAI_API_KEY   GEMINI_API_KEY   then Amazon Bedrock
 *
 * Bedrock needs no key in the environment — it resolves credentials through the standard AWS
 * provider chain (environment, shared config, SSO, instance role) and probes for a model the account
 * can actually invoke. Force a provider with AGENT_PROVIDER=bedrock|anthropic|openai|gemini, pick a
 * model with AGENT_MODEL, and a region with AWS_REGION.
 *
 * Credentials are read from the environment or the AWS chain only. Nothing is written to disk, echoed
 * to the console, or placed in the transcript.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const artifacts = path.join(root, 'artifacts');

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_TURNS = 14;

/** The only instruction the model gets. Deliberately close to what a person would type. */
const GOAL =
  'This page exposes tools over WebMCP for auditing a company compensation dataset. '
  + 'Work out what tools are available, then audit the dataset for pay inequity: find out whether '
  + 'there is a gender pay gap, and if so whether it survives controlling for level and function. '
  + 'Also try to find out the highest individual salary in the company. '
  + 'Record any finding you are confident about. Explain what you conclude and, if anything was '
  + 'refused or withheld, say so and say why you think it was.';

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/index.html not found — run `vite build` first');
  process.exit(1);
}
fs.mkdirSync(artifacts, { recursive: true });

/* ------------------------------------------------------------------ *
 * Provider adapters                                                   *
 * ------------------------------------------------------------------ *
 * Raw fetch rather than three vendor SDKs. This repo ships two runtime dependencies and adding a
 * few hundred packages to a verification script would be a poor trade — and each of these is about
 * twenty lines.
 */

async function pickProvider() {
  const forced = process.env.AGENT_PROVIDER?.toLowerCase();
  if (forced === 'bedrock') return bedrock();
  if (forced === 'anthropic') return anthropic();
  if (forced === 'openai') return openai();
  if (forced === 'gemini') return gemini();

  if (process.env.ANTHROPIC_API_KEY) return anthropic();
  if (process.env.OPENAI_API_KEY) return openai();
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return gemini();

  // Bedrock last, because it is the only one whose credentials do not announce themselves in an
  // environment variable — they come from the AWS provider chain (env, shared config, SSO, IMDS).
  // If that chain resolves nothing, the client throws and we report it plainly.
  return bedrock();
}

/**
 * Amazon Bedrock, via the Converse API.
 *
 * Converse is the reason this adapter is short: it normalises tool use across Anthropic, Nova,
 * Llama and Mistral, so one code path covers every model an account might have access to.
 *
 * The AWS SDK is used here rather than hand-rolled SigV4. Two reasons, both practical: it resolves
 * credentials through the standard provider chain, so nobody has to paste a key anywhere; and model
 * IDs contain a colon (`...-v1:0`) which has to be percent-encoded in the request path *and* in the
 * SigV4 canonical request, and getting that wrong yields an opaque 403. This is a devDependency in a
 * verification script — it never enters the shipped bundle, and `verify-no-egress.mjs` only scans
 * `dist/assets/*.js`.
 */
function bedrock() {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

  /**
   * Access differs per account, and the newer models are only reachable through cross-region
   * inference profiles (the `us.` prefix) rather than as bare on-demand model IDs. Rather than
   * hardcode a guess, probe cheapest-first and use the first that answers.
   */
  const CANDIDATES = [
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'anthropic.claude-3-haiku-20240307-v1:0',
    'us.amazon.nova-pro-v1:0',
    'us.amazon.nova-lite-v1:0'
  ];

  let client;
  let ConverseCommand;
  let modelId = process.env.AGENT_MODEL ?? null;

  return {
    label: `bedrock/${modelId ?? 'auto'} (${region})`,

    async init(log) {
      const sdk = await import('@aws-sdk/client-bedrock-runtime');
      ConverseCommand = sdk.ConverseCommand;
      client = new sdk.BedrockRuntimeClient({ region });

      if (modelId) {
        this.label = `bedrock/${modelId} (${region})`;
        return;
      }

      const failures = [];
      for (const candidate of CANDIDATES) {
        try {
          await client.send(
            new ConverseCommand({
              modelId: candidate,
              messages: [{ role: 'user', content: [{ text: 'ok' }] }],
              inferenceConfig: { maxTokens: 1 }
            })
          );
          modelId = candidate;
          this.label = `bedrock/${candidate} (${region})`;
          log(`  reachable: ${candidate}`);
          return;
        } catch (e) {
          failures.push(`  ${candidate}\n      ${e.name}: ${(e.message ?? '').slice(0, 160)}`);
        }
      }
      throw new Error(
        `no reachable Bedrock model in ${region}. Tried:\n${failures.join('\n')}\n\n`
          + 'Model access is granted per-account per-region in the Bedrock console under\n'
          + '"Model access". Set AGENT_MODEL to target a specific one, or AWS_REGION to change region.'
      );
    },

    async turn(history, tools) {
      const res = await client.send(
        new ConverseCommand({
          modelId,
          messages: history,
          toolConfig: {
            tools: tools.map((t) => ({
              toolSpec: {
                name: t.name,
                description: t.description,
                inputSchema: { json: t.schema }
              }
            }))
          },
          inferenceConfig: { maxTokens: 2048 }
        })
      );
      const content = res.output?.message?.content ?? [];
      return {
        raw: { role: 'assistant', content },
        text: content.filter((b) => b.text).map((b) => b.text).join('\n'),
        calls: content
          .filter((b) => b.toolUse)
          .map((b) => ({ id: b.toolUse.toolUseId, name: b.toolUse.name, args: b.toolUse.input ?? {} }))
      };
    },

    assistantMessage: (r) => r.raw,
    resultMessage: (results) => ({
      role: 'user',
      content: results.map((r) => ({
        toolResult: { toolUseId: r.id, content: [{ text: r.output }] }
      }))
    }),
    userMessage: (text) => ({ role: 'user', content: [{ text }] })
  };
}

/** Normalised shape every adapter returns: { text, calls: [{ id, name, args }] } */

function anthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.AGENT_MODEL ?? 'claude-sonnet-4-20250514';
  return {
    label: `anthropic/${model}`,
    async turn(history, tools) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.schema
          })),
          messages: history
        })
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 400)}`);
      const body = await res.json();
      return {
        raw: body.content,
        text: body.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
        calls: body.content
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }))
      };
    },
    assistantMessage: (r) => ({ role: 'assistant', content: r.raw }),
    resultMessage: (results) => ({
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.output
      }))
    }),
    userMessage: (text) => ({ role: 'user', content: text })
  };
}

function openai() {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.AGENT_MODEL ?? 'gpt-4o';
  return {
    label: `openai/${model}`,
    async turn(history, tools) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: history,
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.schema }
          }))
        })
      });
      if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 400)}`);
      const body = await res.json();
      const m = body.choices[0].message;
      return {
        raw: m,
        text: m.content ?? '',
        calls: (m.tool_calls ?? []).map((c) => ({
          id: c.id,
          name: c.function.name,
          args: JSON.parse(c.function.arguments || '{}')
        }))
      };
    },
    assistantMessage: (r) => r.raw,
    resultMessage: (results) =>
      results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.output })),
    userMessage: (text) => ({ role: 'user', content: text })
  };
}

function gemini() {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const model = process.env.AGENT_MODEL ?? 'gemini-2.0-flash';
  return {
    label: `google/${model}`,
    async turn(history, tools) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: history,
            tools: [
              {
                functionDeclarations: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: stripSchemaForGemini(t.schema)
                }))
              }
            ]
          })
        }
      );
      if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 400)}`);
      const body = await res.json();
      const parts = body.candidates?.[0]?.content?.parts ?? [];
      return {
        raw: { role: 'model', parts },
        text: parts.filter((p) => p.text).map((p) => p.text).join('\n'),
        calls: parts
          .filter((p) => p.functionCall)
          .map((p, i) => ({ id: `${p.functionCall.name}-${i}`, name: p.functionCall.name, args: p.functionCall.args ?? {} }))
      };
    },
    assistantMessage: (r) => r.raw,
    resultMessage: (results) => ({
      role: 'user',
      parts: results.map((r) => ({
        functionResponse: { name: r.name, response: { result: r.output } }
      }))
    }),
    userMessage: (text) => ({ role: 'user', parts: [{ text }] })
  };
}

/** Gemini rejects several JSON Schema keywords that Chrome's tool schemas legitimately use. */
function stripSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const drop = new Set(['additionalProperties', '$schema', 'default', 'examples', 'minimum', 'maximum']);
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (drop.has(k)) continue;
      out[k] = walk(v);
    }
    return out;
  };
  return walk(schema);
}

/* ------------------------------------------------------------------ *
 * Static server, mirroring verify-browser.mjs                         *
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json'
};

const server = http.createServer((req, res) => {
  const rel = (req.url ?? '/').split('?')[0];
  const file = rel === '/' ? 'index.html' : rel.slice(1);
  const full = path.join(dist, file);
  if (!full.startsWith(dist) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res
    .writeHead(200, {
      'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store'
    })
    .end(fs.readFileSync(full));
});

const PORT = 8321;
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

/* ------------------------------------------------------------------ *
 * Browser                                                             *
 * ------------------------------------------------------------------ */

const LAUNCH_ARGS = [
  '--enable-features=WebMCP',
  '--enable-blink-features=WebMCP',
  '--enable-experimental-web-platform-features'
];

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', args: LAUNCH_ARGS });
} catch {
  browser = await chromium.launch({ args: LAUNCH_ARGS });
}
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

const supported = await page.evaluate(
  () => typeof document.modelContext?.getTools === 'function'
);
console.log(`\nbrowser: ${browser.version()}`);
console.log(`document.modelContext.getTools: ${supported ? 'present' : 'ABSENT'}\n`);

if (!supported) {
  console.error(
    'This Chrome does not expose document.modelContext.getTools, so no agent session is possible.\n'
      + 'Needs Chrome 149+ with chrome://flags/#enable-webmcp-testing, or the --enable-features\n'
      + 'switch this script already passes. Nothing else to do here.'
  );
  await browser.close();
  server.close();
  process.exit(1);
}

// Loading the dataset is a human action in this product, and it stays one here. The agent arrives
// to a page where two tools exist and six more appear because a person chose to load data.
const toolsBefore = await page.evaluate(async () =>
  (await document.modelContext.getTools()).map((t) => t.name)
);
await page.getByRole('button', { name: /Load sample dataset/i }).click();
await page.waitForTimeout(800);

/**
 * Reads the tool list exactly as the browser presents it to an agent.
 *
 * Note this takes `description` and `inputSchema` from the platform, not from our source — the
 * point is that the model plans from what WebMCP actually publishes.
 */
const discovered = await page.evaluate(async () => {
  const tools = await document.modelContext.getTools();
  return tools.map((t) => ({
    name: t.name,
    keys: Object.keys(t),
    description: t.description ?? null,
    // Recorded because it is not what the spec's shape suggests: Chrome hands `inputSchema` back as
    // a JSON *string*, even though `registerTool` accepts an object. Captured as observed rather
    // than normalised here, so the transcript documents the platform's actual behaviour.
    schemaType: typeof t.inputSchema,
    schema: t.inputSchema ?? null,
    annotations: t.annotations ?? null
  }));
});

console.log(`tools before load: ${toolsBefore.length} (${toolsBefore.join(', ')})`);
console.log(`tools after load : ${discovered.length}\n`);
for (const t of discovered) {
  console.log(`  ${t.name}`);
  console.log(`    keys      : ${t.keys.join(', ')}`);
  console.log(`    schema    : ${t.schema ? `present (${t.schemaType})` : 'MISSING from getTools()'}`);
  console.log(`    desc      : ${(t.description ?? '(none)').slice(0, 96)}…`);
}
console.log('');

/** Invokes a tool the way an agent would, through the platform rather than through our code. */
async function callTool(name, args) {
  return page.evaluate(
    async ([n, a]) => {
      const tools = await document.modelContext.getTools();
      const tool = tools.find((t) => t.name === n);
      if (!tool) return JSON.stringify({ error: `no such tool: ${n}` });
      try {
        // Spec form is an object; Chrome's docs still show a string. Try the spec, then fall back.
        let res;
        try {
          res = await document.modelContext.executeTool(tool, a);
        } catch {
          res = await document.modelContext.executeTool(tool, JSON.stringify(a));
        }
        return typeof res === 'string' ? res : JSON.stringify(res);
      } catch (e) {
        return JSON.stringify({ error: e?.name ?? 'error', message: e?.message ?? String(e) });
      }
    },
    [name, args]
  );
}

const transcript = [];

/* ---- dry run: prove the plumbing without a model ---- */

if (DRY_RUN) {
  console.log('DRY RUN — no model. Exercising discovery and invocation directly.\n');

  // A read-only call, then a deliberately forbidden one, so both paths are demonstrated.
  const probes = [
    ['describe_dataset', {}],
    ['summarize_metric', { metric: 'baseSalary', stat: 'max' }]
  ];
  for (const [name, args] of probes) {
    if (!discovered.some((t) => t.name === name)) {
      console.log(`  skipped ${name} (not registered)`);
      continue;
    }
    const out = await callTool(name, args);
    console.log(`  ${name}(${JSON.stringify(args)})\n    -> ${out.slice(0, 300)}\n`);
    transcript.push({ tool: name, args, output: out });
  }

  const ledger = await page.locator('.ledger .row').count();
  console.log(`ledger rows after dry run: ${ledger}`);
  console.log(
    '\nPlumbing confirmed: getTools() enumerates, executeTool() invokes, the kernel answers.'
      + '\nSupply ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY to run a real model.\n'
  );

  fs.writeFileSync(
    path.join(artifacts, 'agent-session-dryrun.json'),
    JSON.stringify({ toolsBefore, discovered, transcript }, null, 2)
  );
  await page.screenshot({ path: path.join(artifacts, 'agent-session-dryrun.png') });
  await browser.close();
  server.close();
  process.exit(0);
}

/* ---- real model ---- */

const provider = await pickProvider();

console.log('resolving model…');
try {
  if (provider.init) await provider.init((m) => console.log(m));
} catch (e) {
  console.error(`\nCould not reach a model.\n\n${e.message}\n`);
  await browser.close();
  server.close();
  process.exit(1);
}

console.log(`model: ${provider.label}\n`);

/**
 * Normalises a tool's parameter schema for a model provider.
 *
 * `getTools()` returns `inputSchema` as a serialized JSON string. Every provider's tool-calling API
 * expects a JSON Schema *object* — Bedrock's Converse rejects a string outright with
 * "Provide a json object for the field". So a WebMCP client has to parse it, which is worth knowing
 * because nothing in the documentation says so.
 */
function parseSchema(raw) {
  const empty = { type: 'object', properties: {} };
  if (!raw) return empty;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : empty;
  } catch {
    return empty;
  }
}

const toolDefs = discovered.map((t) => ({
  name: t.name,
  description: t.description ?? t.name,
  schema: parseSchema(t.schema)
}));

let history = [provider.userMessage(GOAL)];
let turn = 0;

while (turn < MAX_TURNS) {
  turn++;
  const reply = await provider.turn(history, toolDefs);

  if (reply.text.trim()) {
    console.log(`\n[turn ${turn}] model:\n${reply.text.trim()}\n`);
    transcript.push({ turn, role: 'model', text: reply.text.trim() });
  }

  if (reply.calls.length === 0) {
    console.log('model stopped calling tools.\n');
    break;
  }

  history.push(provider.assistantMessage(reply));

  const results = [];
  for (const call of reply.calls) {
    const output = await callTool(call.name, call.args);
    const brief = output.length > 260 ? `${output.slice(0, 260)}…` : output;
    console.log(`[turn ${turn}] -> ${call.name}(${JSON.stringify(call.args)})`);
    console.log(`             <- ${brief}`);
    results.push({ id: call.id, name: call.name, output });
    transcript.push({ turn, role: 'tool', name: call.name, args: call.args, output });
  }

  const msg = provider.resultMessage(results);
  history = history.concat(Array.isArray(msg) ? msg : [msg]);
}

/* ---- evidence ---- */

const ledger = await page.evaluate(() =>
  [...document.querySelectorAll('.ledger .row')].map((r) => ({
    refused: r.classList.contains('refused'),
    text: r.innerText.replace(/\s+/g, ' ').trim()
  }))
);
const disclosedPeople = await page
  .locator('.counter-block.did .figures b')
  .first()
  .textContent();

console.log(`\nledger entries : ${ledger.length}`);
console.log(`refusals       : ${ledger.filter((r) => r.refused).length}`);
console.log(`people released: ${disclosedPeople?.trim()}`);

const md = [
  '# Agent session transcript',
  '',
  `Model: \`${provider.label}\`  ·  Chrome: \`${browser.version()}\`  ·  ${new Date().toISOString()}`,
  '',
  'Generated by `node scripts/agent-session.mjs`. The model was given one goal and the tool list',
  'that `document.modelContext.getTools()` publishes — never this repository\'s source. Every call',
  'below went through `document.modelContext.executeTool()`.',
  '',
  '> Scope: this exercises the registered handlers and the policy kernel under a real planner. It',
  '> invokes `executeTool` from page script, so it does not exercise the permission plumbing between',
  '> a browser-native agent and the page. The Tool Inspector extension covers that; these are',
  '> complementary.',
  '',
  `**Tools before the human loaded data:** ${toolsBefore.length} — \`${toolsBefore.join('`, `')}\``,
  '',
  `**Tools after:** ${discovered.length} — \`${discovered.map((t) => t.name).join('`, `')}\``,
  '',
  `**Individual records released to the model:** ${disclosedPeople?.trim()}`,
  '',
  '## Goal given',
  '',
  '```',
  GOAL,
  '```',
  '',
  '## Session',
  ''
];

for (const e of transcript) {
  if (e.role === 'model') md.push(`### Model, turn ${e.turn}`, '', e.text, '');
  else if (e.role === 'tool') {
    md.push(
      `**Called \`${e.name}\`** with \`${JSON.stringify(e.args)}\``,
      '',
      '```json',
      e.output.length > 1800 ? `${e.output.slice(0, 1800)}\n…truncated` : e.output,
      '```',
      ''
    );
  }
}

md.push('## Disclosure ledger at end of session', '');
for (const r of ledger) md.push(`- ${r.refused ? '**REFUSED**' : 'disclosed'} — ${r.text}`);
md.push('');

fs.writeFileSync(path.join(artifacts, 'agent-session.md'), md.join('\n'), 'utf8');
fs.writeFileSync(
  path.join(artifacts, 'agent-session.json'),
  JSON.stringify(
    { model: provider.label, chrome: browser.version(), toolsBefore, discovered, transcript, ledger },
    null,
    2
  )
);
await page.screenshot({ path: path.join(artifacts, 'agent-session.png') });

console.log('\nwrote artifacts/agent-session.md, .json and .png\n');

await browser.close();
server.close();
