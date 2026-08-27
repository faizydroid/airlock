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
clearly labelled. In the agent panel, ask for the highest salary in the company. A red row lands in
the ledger. The counter still reads **0**.

> "That's an AI agent asking for the highest salary in a company's payroll. And that's the web
> page telling it no."

Beat. Let the red row sit on screen for a second.

### 0:15 – 0:35 · The problem, in one sentence

Screen: the counter, then a slow pan across the ledger.

> "This is a compensation file for five thousand employees. Nobody uploads that to a chatbot — so
> today, you get no help with it at all. Airlock is a browser tab where your agent analyses a file
> it never sees. The data never leaves this page. There is no server."

### 0:35 – 1:35 · The audit, as a visible chain of tool calls

This is the longest section and it carries the WebMCP-leverage score. Keep the right-hand panel
(what the agent received) on screen the whole time.

1. Agent calls `describe_dataset`. Note aloud that it reads the schema before spending budget.
2. Agent asks for the company-wide gap by gender. A big number appears.

   > "Fifteen percent. Which is misleading, and this is the interesting part."

3. Agent controls for level. The gap collapses.

   > "Most of that wasn't pay. It was composition — women are under-represented at senior levels.
   > An agent that ran one query would have reported a gap that isn't there."

4. Agent segments by function. Engineering and Sales separate from the rest.

   > "There's the real signal. Concentrated in two functions, widening with seniority, and not
   > explained by level, location or tenure."

5. Agent calls `record_finding`. It appears in the human's report.

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

### 2:10 – 2:35 · The human holds the veto

Agent calls `request_threshold_override` with a justification. The approval card appears. Click
**Deny**.

> "When the agent wants to look at smaller cohorts, it has to ask. It returns immediately and
> polls — it never blocks the tab. The decision is recorded either way, with the reason it gave."

### 2:35 – 2:50 · Close

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
