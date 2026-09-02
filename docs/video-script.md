# Video script

Target **2:30**, hard ceiling 3:00. Judges may score from the video alone, and the challenge
states they are not required to watch past three minutes.

Two rules that shape everything below:

**Open on the refusal, don't close on it.** In a pile of two hundred submissions, most judges
never reach 2:45. The single thing no other entry will show is software declining to answer, so
it goes in the first fifteen seconds.

**Record narration over a cut timeline.** Do not talk live over a screen recording. The agent is
slow and non-deterministic; you will need several passes and a live take forces you to re-record
everything each time.

---

## Shot list

## Which surface you are filming

Airlock has no chat panel of its own. The agent comes from the browser, which is the whole point of
WebMCP — but it means the video has to show *where* the prompt is being typed, or a first-time
viewer cannot orient. Name it on screen in the first ten seconds.

Two surfaces, used for different beats:

**Model Context Tool Inspector extension** (Chrome Web Store) — adds an agent chat panel. This is
where natural-language prompts go, and it drives the discovery, audit and refusal beats. Its model
is `gemini-3-flash-preview` by default, so say so in the video description: naming a third-party
driver reads as rigour, and the alternative is no agent evidence at all.

**DevTools → Application → WebMCP** — built into Chrome, no extension. Lists registered tools, lets
you invoke them manually, and logs each call with status and return value. Use this for the
dynamic-registration shot, because it is deterministic and therefore easy to capture cleanly.

Compose the frame so the two panes are visually distinct and label them once. Nothing on screen
currently tells a viewer which side is the agent and which is the page.

### 0:00 – 0:15 · Cold open, the refusal

Screen: Airlock with the dataset already loaded and a chart visible, agent panel on the right,
clearly labelled. Ask the agent to break salary down by **level, office and gender together**. A row
lands in the ledger carrying an **acid-yellow bar in its left margin** and **REFUSED** in a solid
yellow chip, followed by `GROUP_BY_TOO_DEEP`. The counter still reads **0**, in yellow, at the top of
the page.

> **Use the three-dimension request, not "what is the highest salary".** This matters and it is not
> obvious. `summarize_metric`'s `stat` parameter is an enum containing only `mean`, so a compliant
> model reads the schema, understands that extremes are unavailable, and explains that it cannot ask
> — without ever calling the tool. No refusal reaches the ledger and the cold open has nothing to
> show. Verified against a live model: `artifacts/agent-session.md` records exactly that outcome, with
> zero refusals logged across sixteen tool calls.
>
> `groupBy` is different. It is an array with no `maxItems`, so a three-dimension request is
> *representable* — the model can and will send it, and the kernel refuses it at depth. That is the
> one forbidden call an agent reliably makes on camera.
>
> Keep the highest-salary question for 1:35, where it belongs: as the point that the tool surface
> makes some questions unaskable rather than merely refused.

> "That's an AI agent asking for the highest salary in a company's payroll. And that's the web
> page telling it no."

Beat. Let the refused row sit on screen for a second — long enough that the policy code is
readable, because the code is what makes it a rule rather than a mood.

### 0:15 – 0:35 · The problem, and the counterfactual

Screen: the two counter blocks, side by side — an itemised bill of what uploading would have cost,
against a single acid-yellow zero at viewport scale. This is the strongest single frame in the app —
do not narrate over a static shot, cut straight to it. The live-telemetry marquee runs directly
beneath it; let it scroll through at least one full cell before cutting away.

> "Five thousand employees. Uploading that file means sending about two hundred and twenty-five
> thousand tokens — it doesn't even fit in most context windows, and nobody is putting their
> payroll in a chatbot anyway. So today you get no help with it at all."

Beat, then point at the right-hand block:

> "This agent has received zero people and ninety-eight aggregate numbers. It ran the whole audit
> on that."

The point of the frame is that zero has scale. A bare zero is decoration; a zero beside 5,000 is a
measurement.

### 0:35 – 1:35 · The audit, as a visible chain of tool calls

This is the longest section and it carries the WebMCP-leverage score. Keep the right-hand panel
(what the agent received) on screen the whole time.

1. Agent calls `describe_dataset`. Note aloud that it reads the schema before spending budget.
2. Agent asks for the company-wide gap by gender. A big number appears.

   > "Fifteen percent. Which is misleading, and this is the interesting part."

3. Agent controls for level. The gap collapses.

   > "Most of that wasn't pay. It was composition — women are under-represented at senior levels.
   > An agent that ran one query would have reported a gap that isn't there."

4. Agent looks by function. Sales, Engineering **and Support** all show double-digit gaps.

   > "Now it looks like three functions have a problem. Support doesn't — it's at parity, and that
   > eleven percent is level composition again. The raw view misleads in both directions."

5. Agent stratifies by level and function. The gap collapses to about 1.5%.

6. **The wall.** Agent asks for gender by function by level — the one query that would separate a
   real penalty from level mix inside a single function. **Refused: three dimensions.**

   > "That's the query that would settle it. Three dimensions is how you narrow toward one person,
   > so the policy refuses it. Which means this audit cannot tell you whether Engineering's gap is
   > real."

   Hold on the refused row. This is the honest centre of the whole demo — do not cut it.

7. Agent calls `record_finding`. It records the candidates and states what it could not establish.

   > "So it hands back a question instead of a verdict: escalate these two functions to someone with
   > lawful access to the records. That's what a boundary costs, and pretending otherwise would be
   > the dishonest version of this demo."

Emphasise the process, not the conclusion. Showing the *path* is more convincing than showing the
answer, and it doubles as the evidence that the tool layer is doing real work.

### 1:35 – 2:10 · Mechanism

Screen: the tool list, then scroll the source briefly.

> "Nine tools, registered with `document.modelContext.registerTool`. Every parameter is an enum —
> there's no free-form query, so the agent can't compose its way to a single person. Cohorts under
> twenty people are never reported on, because at small numbers a median *is* somebody's salary.
> Extremes and dispersion don't exist at any size."

Then the line that buys the most credibility with this panel:

> "Nothing individual is rendered in the page either — not in the DOM, not in a chart. Because
> Computer Use can screenshot this tab, and a privacy boundary that a screenshot defeats isn't
> one."

Show tools appearing and disappearing as state changes. Ten seconds of a live tool list mutating
outscores thirty seconds of chart tour.

### 2:10 – 2:25 · Hand the attacks to the viewer

Screen: the **Try to break it** panel — section 07, full width at the foot of the page, laid out as
a two-column grid of cases. Click **Run all**, let the verdicts land. Refusals settle to a muted field
with a yellow margin rule and a solid yellow **REFUSED** block; withheld results are hatched grey.

> "You don't have to take my word for any of this. These are the same attacks the test suite runs,
> so every outcome you see here is one a test asserts — including two that succeeded against an
> earlier build. Seven of seven held."

Hold on one result long enough that `verified by test A2` is readable. That line is the whole
argument about trust: the demo cannot claim an outcome the tests do not prove.

This is the beat most likely to be remembered, because it converts the viewer from someone being
shown a claim into someone testing one.

### 2:25 – 2:40 · The human holds the veto

Agent calls `request_threshold_override` with a justification. The approval card appears. Click
**Deny**.

> "When the agent wants to look at smaller cohorts, it has to ask. It returns immediately and
> polls — it never blocks the tab. The decision is recorded either way, with the reason it gave."

### 2:40 – 2:55 · Close

Screen: export the report, show the disclosure record at the top of the markdown.

> "The output is an audit document that carries its own provenance: every question asked, every
> question refused. Individual records released: zero. Same number as when we started."

---

## Cut list

Do not include: a talking-head intro, an architecture diagram, a UI walkthrough, a tour of the
charts, or an explanation of the tech stack.

## Practical

- Record at 1920×1080, browser zoomed so the ledger text is legible when scaled down.
- Pre-load the dataset before recording. The load step is not interesting.
- Have the exact prompts written down. Improvising with a slow agent wastes takes.
- If a take runs long, cut **the chart tour and the cell table**, not the mechanism section. An
  earlier version of this script said to cut mechanism first, which was wrong: that section is
  where `document.modelContext.registerTool` appears, where the enum-bounded schemas are explained,
  and where the tool list mutates on camera. It is the WebMCP Leverage criterion. Protect it.
- Say the word **WebMCP** inside the first thirty seconds. An earlier cut of this script did not
  reach it until 1:35, in a WebMCP competition.
- Three seconds of the DevTools **Network** tab showing no requests after the bundle loads proves
  "there is no server" better than any sentence. Include it.
- Name **Replay the audit** on screen and in the description. You are filming in flagged Chrome, so
  a judge who opens the live link in a normal browser sees a different app; Replay is the bridge.
- Upload with the visibility setting the challenge rules require, and confirm playback from a
  logged-out browser before submitting.
