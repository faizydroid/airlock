# Devpost submission text

Paste into the submission form. The four required questions are answered in order under
"What it does" through "How we built it".

---

## Project name

**Airlock**

## Tagline

A browser tab where your agent analyses a file it never sees.

## Live URL

https://airlock.dofolabs.space

Works in Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled. **If you don't want to
set the flag, press "Replay the audit"** — it runs a real agent session through the real tool
layer with no setup. Tested-environment matrix is in the README, including what doesn't work.

## Repository

https://github.com/faizydroid/airlock — MIT licensed.

---

## What it does

Load a compensation file for 5,000 employees. It stays in the browser tab and is never uploaded.
Your AI agent then conducts a full pay-equity audit through nine WebMCP tools — and never
receives a single employee record through any channel.

The agent can compute. It cannot read.

## Why this use case is a strong fit for WebMCP

Normally, to get an agent's help with a file, you upload it. That *is* the problem. Nobody uploads
their company's salary data to a chatbot, so today they get no help at all — and that refusal is a
live tax on the entire agent product category.

WebMCP moves the tool boundary inside the browser, under the page author's control. That is the
only reason this application can exist. **A backend MCP server could not do this, because the data
would have to reach the server.** Airlock has no server: there is no `fetch` anywhere in the
codebase. The dataset is generated in the tab and every disclosure is computed there.

Most WebMCP demos use tools to give an agent *more* capability. This one uses them to give it
*less*, precisely and deliberately, and that turns out to unlock a category of work that was
previously impossible rather than merely inconvenient.

## How it creates a better user experience

Three ways.

**It makes a refusal legible.** When the agent asks for something it shouldn't have, the person at
the keyboard sees a red row in an append-only ledger with the reason attached. Most agent
interfaces make denial feel like a malfunction. Here it is the product working.

**It shows both sides of the boundary at once.** The left panel is what you see: aggregate charts.
The right panel is what the agent received: the verbatim tool return. You can compare them
directly, which is normally impossible.

**It produces an artifact, not a transcript.** The exported audit report carries the full
disclosure ledger with it — every question asked and every question refused — so the finding comes
with its own provenance.

## What people and agents can do together that was difficult or impossible before

An agent can perform statistical work on data it is not permitted to read, while the owner of that
data watches and holds a veto.

The demo session shows why that is more than a slogan:

1. The agent asks for the company-wide pay gap. It gets about **10.5%** — which is **badly
   misleading**. Most of it is composition, not pay: women are under-represented at senior levels in
   this dataset.
2. It controls for level. The gap collapses.
3. It looks by function. Sales, Engineering and Support all show double-digit raw gaps — but this
   view doesn't control for level mix *inside* a function, so it misleads in the other direction.
4. It compares only within matching level-and-function strata. The gap drops to roughly **1.5%**.
5. It tries the one query that would tell the two apart — gender by function by level — and is
   **refused**. Three dimensions is cohort narrowing.
6. It records a finding that states what the evidence supports and names what it cannot establish.
7. It asks for the highest salary, and for a median. Both **refused** at any cohort size.

The trap in steps 1–4 is real, not staged, and it's pinned by tests that run over the raw rows.
Functions other than Engineering and Sales sit at parity once level is controlled, yet their
unadjusted gaps look alarming: Support carries no planted penalty and still shows an 11.8% raw gap
from level composition alone.

The part worth reading twice is step 5. The fixture *does* contain a real penalty in Engineering and
Sales that survives level control — the generator plants it and `generate.test.ts` proves it — and
the tool surface still cannot demonstrate that, because doing so requires the depth-3 query the
policy refuses. So the audit ends by handing the human a precise question rather than a verdict.

That is the honest version of human–agent collaboration on private data: the agent does the
statistical work, the boundary decides how far it can go, and the human is told exactly where the
analysis stopped and why. We found this by running a live model against the tools — transcript in
`artifacts/agent-session.md` — and it changed the claim we were going to make.

## How we implemented WebMCP

Nine tools registered directly via `document.modelContext.registerTool`, no wrapper library, so
the real API is visible in the source.

**Registration is state-gated across three transitions**, so `toolchange` carries meaning. Before a
dataset loads, two tools exist. Analysis tools appear once it does. The override poller exists only
while a request is outstanding. You can watch the tool list change in the page.

**Refusals are returned as values, never thrown.** The spec discards a rejected promise's reason —
the caller gets a generic `UnknownError` and the message is lost. An agent that can't read *why* it
was refused can't adapt, and the refusal is the centre of this product.

**`requestUserInteraction()` is not used, because it doesn't exist.** `ModelContextClient` was
removed from the spec in June 2026, though Chrome's own security page still links to it. The
two-phase approval flow is built from plain `registerTool`: the tool returns a pending status
immediately with a request id, the human decides in the page, the agent polls. It never blocks, so
a backgrounded tab can't hang the agent mid-turn.

**Every parameter is an enum or a bounded string.** No free-form query, no filter expression. The
agent selects from a fixed vocabulary rather than composing predicates — which is both a security
property and, per Chrome's own best-practice guidance, better tool design.

### The privacy kernel

One module holds the records, behind a true JavaScript private field, so it's inaccessible outside
the class by language semantics rather than convention. A test enforces that nothing else imports
the generator or references the record type.

Nine controls, each traceable to a published attack:

- Enum-only vocabulary, and a cap of two grouping dimensions
- Count floor of 5; numeric floor of 20 for anything reading a value
- Statistics allow-list: **`count` and `mean` only**. No extremes, no dispersion, no sums, no order statistics
- A **post-computation output gate** on realised cohort values
- Output quantization, and count banding below 50
- Disclosure budget denominated in **released cells**, not tool calls, and enforced as a bound
- Refusal text that is a pure function of the refusal code
- Aggregate-by-construction charts, drawn to canvas with no chart library

### Two attacks that succeeded, and what we changed

An adversarial review of a near-final build broke the invariant twice. Both are fixed and both are
documented, because a security claim with no failure history is a hope rather than a claim.

**53 exact salaries recovered in 8 calls.** An order statistic has an influence support of one
record however large the cohort: with index `(n-1)*q`, a median is a bare `sorted[i]` at every odd n.
So the median of a 363-person cohort *was* one employee's salary. An earlier version of the policy
diagnosed exactly this and "fixed" it by raising the cohort floor — which does nothing, because the
support of a median does not grow with the cohort. Median, p25 and p75 were withdrawn entirely.

**1,305 exact equity values disclosed in one call.** Equity is zero for every junior employee, so a
mean of zero proved every member was zero. `stddev` had been excluded specifically to prevent
homogeneity disclosure; `mean` reintroduced it.

One root cause: the policy gated statistic *names* and cohort *sizes* but never the realised output.
The fix is `outputPermitted()`, a gate that takes the actual cohort values immediately before
release and asks whether the result could be attributed to an individual.

That episode is the most useful thing in this submission. It is also why the attack suite is in the
repository rather than described in prose.

**Nothing individual is rendered anywhere in the page** — not in the DOM, not in a chart. That's
because ChatGPT's Computer Use can screenshot the tab, and a privacy boundary a screenshot defeats
isn't one. Box plots and violin plots were removed for the same reason: a box plot draws outliers
as individual dots.

### Two things we deliberately didn't build

**A differencing detector.** An earlier design hashed group specs and flagged pairs differing by
one bucket. Cut, because it doesn't work: it watches the group axis while bin sweeping attacks the
value axis; grouped queries contain a cohort and its complement inside a single call at Hamming
distance zero; and reconstruction needs a span condition, not an adjacency condition. It was the
most expensive item on the roadmap and the least effective.

**Differential privacy.** An uncalibrated ε claim is worse than no claim. Named as honest future
work rather than implied by vague language.

### Adversarial evaluation

Twelve named attacks from a security review, executed against the real kernel using only the tools
an agent has, and run by `npm test`. Extremum requests, order-statistic recovery, moment
reconstruction, bin sweeping, regression leverage, low-cardinality inversion, cohort narrowing,
marginal differencing, suppression-pattern walking, ledger mining, profiling leaks, override abuse.
Results table in the README, derived from the test names so an attack that gets deleted also
disappears from the claim.

## What we'd tell a judge to be sceptical about

The README has a "what this does not protect against" section, and it's specific: this is not
differential privacy; background knowledge is undefendable for any system reporting means;
marginal reconstruction is mitigated rather than eliminated; the page's own memory is out of scope
because an agent that can execute JavaScript in the tab can read the records; and a human who
approves every override degrades the policy to whatever the agent asks for.

We'd rather state the boundary precisely than claim one we can't defend.

## Built with

TypeScript · React · Vite · WebMCP (`document.modelContext`) · Cloudflare Pages · Canvas 2D

No backend. No dependencies at runtime beyond React. No network calls after the bundle loads.
