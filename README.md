# Airlock

**A browser tab where your agent analyses data it never sees.**

Live: **https://airlock.dofolabs.space**

5,000 compensation records are generated in the tab and stay there. Your AI agent conducts a full
pay-equity audit through a bounded, budgeted, fully audited tool interface — and never receives a
single employee record through any channel.

> **No agent, no flag, no setup?**
>
> - **[Watch the audit run](https://airlock.dofolabs.space/?replay=1)** — starts on load, drives the
>   real tool handlers, nothing mocked.
> - **[Try to break it](https://airlock.dofolabs.space/?attack=1)** — fire the attack suite at the
>   live app yourself.

### The number that makes the point

```
Uploading this file would have sent      5,000 people · 882 kB · ~225,810 tokens
Actually disclosed to the agent              0 people ·  98 aggregate values
```

That token figure doesn't fit in most context windows, which is part of why the answer today is
"you get no help at all". Both sides are derived — the left from measuring the loaded dataset, the
right from a counter the kernel increments each time a value actually leaves. Neither is a literal
in the source.

A bare zero is decoration. A zero beside 5,000 is a measurement.

Built for the [OpenAI WebMCP Challenge](https://openai.com/webmcp-challenge/).

**157 tests · 42 browser checks · zero network requests after load · no server**

**Scope, stated up front:** this build generates its dataset rather than importing one. There is no
file upload path. The privacy machinery is real and tested; the ingestion story is not built. See
[Tested environments](#tested-environments) and [What this does not protect against](#what-this-does-not-protect-against).

---

## Why this needs WebMCP

Normally, to get an agent's help with a file, you upload it. That is the whole problem. Nobody
uploads their company's salary data to a chatbot, so today they get no help at all.

WebMCP moves the tool boundary *inside the browser*, under the control of the page author. The
page becomes the gatekeeper. That is the only reason this application can exist:

**A backend MCP server could not do this**, because the data would have to reach the server. This
app has no server. There is no `fetch` anywhere in the codebase — the dataset is generated in the
tab, and every disclosure is computed there.

The tool layer is not a convenience wrapper over an API. It *is* the product, and most of its
value comes from what it refuses to do.

---

## What people and agents can do together that was difficult before

An agent can now perform statistical work on data it is not permitted to read, while the person
who owns that data watches the analysis happen and holds a veto.

Concretely, during the demo session:

1. The agent asks for the company-wide pay gap and gets a large number — which is **misleading**,
   because most of it is composition rather than pay. Women are under-represented at senior
   levels in this dataset.
2. It controls for level. The gap narrows sharply.
3. It segments by function and finds the real signal: an unexplained gap concentrated in
   Engineering and Sales, widening with seniority.
4. It records a finding, which appears in the human's report for review.
5. It tries to narrow further, into cohorts of a handful of people, and is **refused**.
6. It asks for the highest salary in the company, and is **refused** on a policy it cannot argue
   with.

Throughout, the counter at the top of the page reads **0 individual records disclosed**, and the
ledger at the bottom records every question asked and every question refused.

That Simpson's-paradox trap in steps 1–3 is real, not staged: it is asserted by a test, so an
agent that fails to control for level genuinely reports a gap in functions that are actually at
parity.

---

## How WebMCP is implemented

Nine tools registered directly via `document.modelContext.registerTool`, with no wrapper
library, so the real API is visible in the source:

```js
await document.modelContext.registerTool({
  name: 'summarize_metric',
  description: 'Reports a statistic for a metric across every cohort in a grouping…',
  inputSchema: { /* enum-bounded, no free-form query */ },
  annotations: { readOnlyHint: true },
  execute: async (input, { signal }) => { /* … */ }
}, { signal: controller.signal });
```

| Tool | Purpose |
|---|---|
| `load_sample_dataset` | Generates the dataset in-tab. Nothing is uploaded. |
| `describe_dataset` | Schema and policy. No data, no cohort sizes. |
| `count_cohorts` | Banded headcounts, so the agent can plan before spending budget. |
| `summarize_metric` | The analysis tool. Also renders the human's chart. |
| `adjusted_pay_gap` | Stratified gap. Discloses **less** than the raw table — see below. |
| `record_finding` | Writes a finding into the human's report for review. |
| `get_audit_report` | The artifact, with the full ledger as provenance. |
| `request_threshold_override` | Asks the human to relax a floor. Returns immediately. |
| `check_override_request` | Polls the human's decision. Registered only while one is open. |

### The tension that produced `adjusted_pay_gap`

Isolating a pay gap means comparing like with like: same level, same function. That is three
grouping dimensions, and the depth cap forbids it — for good reason, since the lattice generated by
combining dimensions is what marginal reconstruction attacks consume.

Meanwhile both two-dimensional views are actively misleading. A raw gap by function is dominated by
level composition: in this dataset **Support shows a 12% gap while being planted at parity**. A raw
gap by level is diluted across functions.

The resolution was not to relax the cap. It was to do the stratification inside the kernel and
release the conclusion instead of the ingredients:

- one quantized percentage per group, rather than a cell per stratum
- a stratum contributes only when **both** compared cohorts clear the numeric floor
- strata coverage reported as a band, so the number of usable strata is not exposed
- no coefficients, no standard errors, no degrees of freedom, no per-stratum figures

Regression was deliberately avoided. A coefficient is a linear functional whose weights can
concentrate on a single row, and degrees of freedom leak the exact n that count banding exists to
hide. A test asserts this tool releases fewer values than the raw table it replaces.

### Design decisions worth noting

**Registration is state-gated across three transitions**, so `toolchange` carries real meaning:
before a dataset loads only two tools exist; analysis tools appear once it does; the override
poller exists only while a request is outstanding. You can watch the tool list change in the
page.

**Refusals are returned as values, never thrown.** The WebMCP spec discards a rejected promise's
reason — the caller receives a generic `UnknownError` and the message is lost. An agent that
cannot read *why* it was refused cannot adapt, and the refusal is the centre of this product.

**No tool can set the disclosure floor.** Only a human click can, through the two-phase override
flow, and even then it is clamped so it can never approach the level at which a statistic becomes
an individual value.

**`requestUserInteraction()` is not used**, because it does not exist: `ModelContextClient` was
removed from the spec in June 2026. The two-phase approval flow is built from plain `registerTool`
and never blocks, so a backgrounded tab cannot hang the agent mid-turn.

**Every parameter is an enum or a bounded string.** No free-form query, no filter expression, no
SQL. The agent selects from a fixed vocabulary rather than composing predicates.

---

## The privacy kernel

One module holds the records. `Kernel.#rows` is a true JavaScript private field, so it is
inaccessible outside the class by language semantics rather than by convention. A test enforces
that nothing outside the kernel imports the generator or references the record type.

Nine controls, each traceable to a specific published attack. Full reasoning in
[`docs/threat-model.md`](docs/threat-model.md).

| Control | What it stops |
|---|---|
| Enum-only tool vocabulary | Arbitrary predicate targeting |
| Count floor of 5 | Reporting on a cohort at all |
| Numeric floor of 20 | Small-cohort inference |
| Statistics allow-list — `count` and `mean` only | Extremum, moment and order-statistic attacks |
| **Post-computation output gate** | **Zero-variance cohorts, and anything a floor cannot catch** |
| Minimum contributing strata | Stratified figures collapsing to one cohort |
| Output quantization | Precision at the margins |
| Count banding below 50 | Locating the cohorts worth attacking |
| Budget in released **cells** | Span and marginal-reconstruction attacks |
| Data-independent refusals | Refusal as a one-bit oracle |
| Aggregate-by-construction charts | The screenshot channel |

The output gate is the control that matters most, and it exists because everything else inspects the
*request* rather than the *result*. A statistic can be allow-listed and a cohort can clear every
floor while the released number is still attributable to one person. Two confirmed breaches came
through that gap.

### Two things deliberately not built

**A differencing detector.** An earlier design hashed group specifications and flagged pairs
differing by one bucket. It was cut because it does not work: it watches the group axis while bin
sweeping attacks the value axis, grouped queries contain a cohort and its complement inside a
*single* call at Hamming distance zero, and reconstruction requires a span condition rather than
an adjacency condition. It was the most expensive item on the roadmap and the least effective.

**Differential privacy.** An uncalibrated ε claim is worse than no claim. Named as honest future
work rather than implied by vague language.

---

## Adversarial evaluation

Named attacks from two adversarial reviews, executed against the real kernel. Run with `npm test`.

A note on scope, because precision matters here: the attack suite calls the **kernel API**, which
is a strict superset of what the tool schemas expose. It can therefore request statistics and
parameters no agent could reach. That is deliberate — testing a wider surface than the adversary
has is the conservative choice — but it is not the same as driving the tools, so the claim is
stated as "against the kernel" rather than "through the tools".

| # | Attack | Result |
|---|---|---|
| A1 | Extremum request (`min`, `max`, top-N) | Refused |
| A1b | Highest salary via any permitted statistic | Not recovered |
| **A2** | **Order statistics as individual values** | **Statistic withdrawn — see below** |
| **A2b** | **Zero-variance cohort disclosure** | **Withheld by the output gate — see below** |
| A3 | Moment reconstruction (count + mean + stddev) | Dispersion unavailable |
| A4 | Histogram bin sweeping | No agent-controllable binning |
| A5 | Regression leverage | No regression surface |
| A6 | Low-cardinality metric inversion | Floor applies to all metrics |
| A7 | Cohort narrowing to one person | Depth capped at 2 |
| A8 | Marginal reconstruction by differencing | Exact counts denied at the margins |
| A9 | Suppression pattern walking | Identical key set regardless of data |
| A10 | Reading the ledger for values | Questions recorded, answers never |
| A11 | Metadata and profiling leaks | No sample values |
| A12 | Override abuse | Clamped, and cannot be reached by a tool |

Plus seven regression tests (`src/eval/regressions.test.ts`) for defects a review found in the
finished build, so none can silently return.

The results table is derived from the test names, so an attack that is quietly deleted also
disappears from the published claim.

### Fire them yourself

**[airlock.dofolabs.space/?attack=1](https://airlock.dofolabs.space/?attack=1)**

The app ships a panel of one-click attacks. Each button makes a real tool call and shows the
outcome with its policy code.

The design property that matters: the buttons are generated from `src/eval/attack-specs.ts`, **the
same array the test suite iterates.** A test asserts every declared outcome, so the panel cannot
claim a refusal the tests do not verify. Weaken a control and the button and the test fail together.
Each result cites the test that proves it.

A security claim someone tests themselves lands differently from one they are told.

### Two attacks that succeeded, and what changed

An adversarial review of a near-final build **broke the invariant twice**. Both are fixed; both are
recorded here because a security claim with no failure history is not a claim, it is a hope.

**A2 recovered 53 exact salaries in 8 tool calls.** `percentile` returned a bare `sorted[i]`
whenever `(n-1)*q` was an integer — every odd n for a median. So the median of a 363-person cohort
*was* one specific employee's salary, to within the quantization step.

The instructive part is that an earlier version of `policy.ts` diagnosed this exact defect and then
"fixed" it by raising the cohort floor to 20. That does nothing: **the influence support of a median
is 1 at every odd n, not merely at small n.** A cohort floor cannot repair a statistic whose support
does not grow with the cohort. Median, p25 and p75 were withdrawn entirely. `mean` survives because
its support is n — every record contributes 1/n, so no single record determines the output.

**A2b disclosed 1,305 exact equity values in one call.** `equityValue` is zero for every L1 and L2
employee, so a mean of zero proved every member was zero. `stddev` had been excluded specifically to
prevent homogeneity disclosure, and `mean` reintroduced it.

Both share one root cause: **the policy gated statistic names and cohort sizes but never the
realised output.** A statistic can be allow-listed and a cohort can clear every floor while the
number leaving the kernel is still one person's value. The fix is a post-computation gate,
`outputPermitted()`, which takes the actual cohort values and answers one question — could this
output be attributed to an individual? — immediately before anything is released.

---

## Tested environments

Stated plainly, including what does not work.

![Airlock mid-audit. Across the top, the counterfactual: uploading this file would have sent 5,000 people, 882 kB and roughly 225,810 tokens — beside what was actually disclosed to the agent, which is 0 people and 98 aggregate values. Below, a bar chart of mean base salary by level and gender with three cohorts withheld as too small, the cell table listing a withheld cohort rather than hiding it, and the agent's verbatim tool return.](artifacts/airlock-audit.png)

| Environment | Result |
|---|---|
| **Chrome 151 with WebMCP enabled** | **Verified.** `document.modelContext` present; 2 tools registered before a dataset exists, 8 after; refusals surfaced with policy codes. 27 automated browser checks — run `npm run verify:browser`. |
| Chrome 149+ with `chrome://flags/#enable-webmcp-testing` | Same path as above; the flag is the manual equivalent of the launch switch. |
| Chrome without the flag, origin-trial token served | **Does not work.** See below. |
| ChatGPT desktop built-in browser | **Does not work.** Requires an authorised origin we could not obtain. |
| Any browser, no WebMCP | **The UI and Replay work.** The full audit narrative is one click away. |

### Automated browser verification

`npm run verify:browser` launches your installed Chrome with `--enable-features=WebMCP`, serves the
production build over a secure context, and asserts 27 properties that only a browser can answer.
Everything else in the test suite runs in Node against the kernel, so this is what closes the gap
between "the logic is correct" and "the application works".

It checks, among other things: that the app renders with no console errors; that
`document.modelContext` exists and the tools register; **that the registered tool count changes as
application state advances**, which is the dynamic-registration evidence; that replay drives the
real handlers and produces genuine refusals carrying policy codes; that the canvas actually paints;
that the counter still reads zero after a full audit; that the exported report contains the ledger
and the limitations; and — the strongest browser-side check available — **that no unquantized
currency figure and no employee identifier appears anywhere in the rendered DOM.**

Screenshots and a sample exported report land in `artifacts/`.

We registered two origins for the WebMCP origin trial and served both tokens as `<meta>` tags and
as repeated `Origin-Trial` response headers. Chrome rejected both with the flag disabled. The
portal issues third-party tokens and refuses duplicate registrations for the same origin, so a
first-party token was not obtainable. Cause unresolved; recorded as unknown rather than guessed
at. Full record in [`NOTES.md`](NOTES.md).

The challenge instructions tell judges to enable the flag to test in Chrome, so this is a
sanctioned path — but **Replay mode exists precisely so no judge is blocked by any of this.**

### Replay mode

Press **Replay the audit**. A scripted session runs through the real tool layer at readable speed
with no agent and no setup. The ledger, budget, charts and refusals are all genuine; every step
calls the same `execute` handler an agent would call. It is not a video and not a mock.

---

## Running it

```bash
npm install
npm run verify        # typecheck + 146 tests, including the adversarial and regression suites
npm run dev           # http://localhost:5173
npm run build
npm run verify:egress # asserts the shipped bundle contains no network primitives
```

To drive it with a live agent: Chrome 149+, enable `chrome://flags/#enable-webmcp-testing`,
relaunch, then open the page and ask your agent to audit the dataset.

---

## What this does not protect against

The precise version, because a defensible limitation beats a broad claim.

- **This is not differential privacy.** No calibrated noise, no ε.
- **Background knowledge.** Someone who already knows four salaries in a cohort of five can
  derive the fifth from its mean. Irreducible for any system reporting means; it is why the
  numeric floor is 20 rather than 5.
- **Marginal reconstruction** is mitigated, not eliminated.
- **The page's own memory.** Records live in this tab. An agent able to execute JavaScript here
  could read them. The tool interface is a policy boundary, not a sandbox.
- **The human.** Someone who approves every override request degrades the policy to whatever the
  agent asks for. Requests are per-query, one-shot (a decision cannot be replayed) and expire after
  two minutes. The description of *what would be revealed* is generated by the page; the agent's
  justification is shown, clearly marked as a quotation from the agent. A mitigation, not a
  solution.

---

## Data

Entirely synthetic, generated in-browser from a fixed seed. No real personal data, ever. The
inequity is planted deliberately, concentrated rather than uniform, because a flat company-wide
gap would be findable in one query and implausibly large across 5,000 people.

Minimum-N suppression is not invented for this demo. Compensation benchmarking suppresses bands
below a headcount floor, and statutory pay-gap reporting does the same. The floors here implement
an existing professional standard.

## Platform research

`probe/` is not part of the app. It is the harness used to work out how WebMCP actually behaves,
because several published details turned out to be wrong or stale.

Findings are recorded verbatim in [`NOTES.md`](NOTES.md), including: `toolchange` fires once per
registration; `navigator.modelContext` still exists in Chrome 151 as an undocumented alias;
`requestUserInteraction()` does **not** exist, having been removed from the spec in June 2026
while Chrome's own security page still links to it; a thrown error's message is discarded by the
platform, so refusals must be return values; and registering a duplicate tool name rejects rather
than replacing.

It also contains the full record of the origin-trial investigation — two registrations, both
rejected, hypothesis falsified, cause recorded as unknown rather than guessed at.

Run it with `npm run probe`.

## Licence

MIT. See [LICENSE](LICENSE).

**Inter** (© 2020 The Inter Project Authors) is embedded in the stylesheet as a base64 woff2 face
under the SIL Open Font License 1.1 — see
[licenses/SIL-OFL-1.1-Inter.txt](licenses/SIL-OFL-1.1-Inter.txt). Latin subset, variable weight axis
400–900, unmodified.

It is embedded rather than linked from Google Fonts on purpose. A webfont request would falsify the
"zero network requests after load" claim above, and it would send every visitor's IP address to a
third party — which is not a defensible thing for a product about not disclosing data to do. The
generator is `scripts/embed-font.mjs`; the committed output means the repository also builds with no
network access.
