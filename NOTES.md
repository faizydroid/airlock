# Day 1 — kill-or-confirm

Purpose: prove the platform can support Cleanroom before writing application code.
Record every result verbatim. Record negatives as **unproven**, never as *cannot* — with an
LLM you cannot distinguish "the agent could not" from "the agent did not try".

This file becomes the technical-credibility section of the submission.

---

## Gate 0 — account access (no code required, do this first)

ChatGPT **desktop app** on Windows, not the web app.

| Step | Check | Result |
|---|---|---|
| 0.1 | Desktop app updated to latest | yes |
| 0.2 | A **Codex** chat can be opened (Codex is included on all plans, incl. Free) | yes |
| 0.3 | Built-in browser opens with **Ctrl+Shift+B** | yes |
| 0.4 | **Settings → Browser → Permissions** shows an *Enable site tools* toggle | **NOT FOUND** — see note |
| 0.5 | Model picker offers **GPT-5.6 Sol** or **Terra** (WebMCP is disabled on Luna) | not recorded |
| 0.6 | Visit `https://developers.openai.com` → **Site tools** control in address bar? | not recorded |
| 0.7 | Ask: *"What site tools does this page offer?"* → expect 5, incl. `search_openai_docs` | **PASS** |

**0.7 verbatim result.** Agent returned all five with accurate descriptions:
`search_openai_docs`, `lookup_page`, `lookup_context`, `navigate_to_page`,
`generate_custom_guide`. Matches the public WebMCP directory listing for that origin exactly.

**Note on 0.4.** The *Enable site tools* toggle was absent, yet tool discovery works. So the
settings UI and the capability roll out independently — **do not treat the toggle's absence as
evidence the feature is unavailable.** Behaviour is the only reliable test.

**Caveat on 0.7, still open.** That tool list is publicly published in the WebMCP directory,
so the agent could in principle have retrieved it rather than discovered it. Not yet
distinguishable. Resolved by E2 below: our probe page is not on the public web, so there is
nothing to look up.

**Gate 0 decision: PASS.** ChatGPT desktop built-in browser is the primary target.
Plan A holds. The in-page agent panel stays a contingency, not a requirement — saving ~1.5 days.

---

## Gate A — existential

Run `node probe/server.mjs`, then open the URLs below. Also deploy and repeat on HTTPS:
localhost is a secure context, but the deployed origin is what judges use.

| # | Experiment | Where | Pass criterion | Result |
|---|---|---|---|---|
| E1 | `document.modelContext` exists with `registerTool` | `/api` + `/` | Environment table shows `present` / `function` | **ABSENT on `http://127.0.0.1:8201` in ChatGPT built-in browser** |
| E1b | Same, on an HTTPS origin, no origin-trial token | tunnel URL in ChatGPT | present / function | **ABSENT** — H2 falsified |
| E1c | Same, regular Chrome + `#enable-webmcp-testing` | `http://127.0.0.1:8201` | present / function | **PASS** |
| E2 | Agent **discovers** the 6 tools | `/` in ChatGPT | Agent names them unprompted | |
| E3 | Structured args survive | `/` | On-page log matches what the agent claims it sent; `choice` enum respected not free-texted | |

### E1 finding — enablement gate, recorded 2026-08-26

ChatGPT's built-in browser (Chrome 151.0.0.0) reported:

```
document.modelContext    ABSENT
navigator.modelContext   absent
registerTool             MISSING
secureContext            true
originAgentCluster       true
origin                   http://127.0.0.1:8201
```

Yet Site tools worked on `https://developers.openai.com` in the same browser (Gate 0.7).

So this is **not** secure context, **not** origin isolation, **not** browser version — Chrome 151
sits inside the origin-trial window of 149–156. It is the enablement gate. Two hypotheses,
not yet distinguished:

- **H1** the built-in browser honours the WebMCP **origin-trial token**, which
  `developers.openai.com` serves and we do not. Consequence if true: **our deployed origin must
  be enrolled in the trial or judges testing in ChatGPT see nothing at all.** Silent total
  failure at judging time, invisible in local testing.
- **H2** the built-in browser refuses WebMCP on `localhost`/loopback regardless of token.
  Consequence if true: no token needed, deploy to HTTPS and it works.

**Incidental result:** `originAgentCluster` is `true` with no header sent, on the port that
omits it. That confirms E12 early — `Origin-Agent-Cluster: ?1` is a no-op for a normal static
site, and the only thing to avoid is `?0`.

**Decision either way:** enrol the deployed origin in the WebMCP origin trial. Free, ~1 hour,
and it means the site works in Chrome 149–156 with no flag, so a judge who skips the flag
instruction still sees a working app.

**Kill condition:** E1 fails in ChatGPT desktop *and* flagged Chrome. That is the only true
project-killer. Everything else has a fallback.

---

## Gate B — architecture-defining

Ask the agent: *"List every CANARY value you can see on this page."* Then explicitly:
*"Use Computer Use to screenshot this page and read all canary values."*

| Channel | Token | Agent saw it? |
|---|---|---|
| DOM text | `CANARY-DOM-7f3a9c` | |
| SVG text | `CANARY-SVG-4d8f11` | |
| Canvas | `CANARY-CANVAS-b21e40` | |
| aria-hidden | `CANARY-ARIA-1c6d05` | |
| title attribute | `CANARY-TITLE-9a2e63` | |
| Below the fold | `CANARY-OFFSCREEN-e93b72` | |
| Memory only (control) | `CANARY-MEMORY-a70f28` | must be **no** |

| # | Experiment | Result |
|---|---|---|
| E4 | Which render channels are readable? | |
| E5 | Without calling any tool, can the agent describe the page? (is DOM content auto-supplied?) | |

**Interpretation.** Any rendered canary read → the pixel/DOM channel is live and
*aggregate-only rendering is mandatory*. None read without explicit Computer Use → the channel
is opt-in and the rule is defence-in-depth. Either way the design holds; what changes is how
strongly the video may phrase the claim. If `CANARY-MEMORY` is ever reported, stop and
re-examine everything.

---

## Gate C — design-shaping, each with a named fallback

| # | Experiment | Pass | Fallback if it fails | Result |
|---|---|---|---|---|
| E6 | Refusal **returned as a value** reaches the user (`probe_refuse` → `REFUSAL-REASON-3d7b21`) | Agent relays the reason | Ledger UI must carry the refusal narrative visually; rewrite the video beat | |
| E7 | Thrown message is discarded (`probe_throw` → `THROWN-DETAIL-8c4f90`) | Marker does **not** appear; generic error | — (expected per spec) | |
| E8 | Dynamic registration: click *Register probe_extra*, ask agent to re-list; click *Abort*, re-list | List changes without reload | Register all tools statically, gate at execution time | |
| E9 | Two-phase approval: `probe_request_approval` → approve in page → `probe_check_approval` | Round trip completes, nothing hangs | Pending payload must spell out the next call and id | |

---

## Gate D — calibration

| # | Experiment | Output | Result |
|---|---|---|---|
| E10 | `probe_sized_output` at small / budget / over / huge; ask agent to repeat verbatim | Real output ceiling. Chrome's 1.5K is advisory; find the truth | |
| E11 | Does `execute`'s 2nd arg carry `requestUserInteraction`? | Expect **no** — removed from spec 2026-06-11 (PR #205). Confirms the two-phase design is the only option | |
| E12 | `Origin-Agent-Cluster`: compare port 8101 (omitted) / 8102 (`?1`) / 8103 (`?0`) | Expect 8101 and 8102 work, 8103 disabled. Confirms `?1` is a no-op for a normal static site | |
| E13 | `executeTool` object form vs string form (`/api`) | Spec says object; Chrome's docs still show a string. Which works? | |
| E14 | Deployed HTTPS origin: does ChatGPT prompt for site permission, and does that gate *discovery* or only *invocation*? | Unresolved in all primary sources | |

---

## Findings summary

| Claim | Verdict | Evidence |
|---|---|---|
| `document.modelContext` is the correct namespace | | |
| `requestUserInteraction` is absent | | |
| Thrown error messages are discarded | | |
| Rendered content is readable by the agent | | |
| Dynamic registration propagates to the agent | | |
| Real tool-output ceiling | | |

## Decisions forced by these results

1.
2.
3.

### E1b — HTTPS, no token, ChatGPT built-in browser: ABSENT (2026-08-26)

`https://statewide-kidney-librarian-toolkit.trycloudflare.com` (cloudflared quick tunnel):

```
document.modelContext    ABSENT
secureContext            true
originAgentCluster       true
chrome                   151.0.0.0
```

**H2 falsified.** Not loopback. It is HTTPS, a secure context, origin-keyed, and Chrome 151 is
inside the 149–156 trial window. So ChatGPT's built-in browser requires the **origin to be
authorised**, by some mechanism we have not yet identified.

⚠️ **Highest-severity finding of Day 1.** Without solving this, the app works perfectly in
flagged Chrome and is **completely dead for any judge testing in ChatGPT desktop** — and we
would never see it locally. Two candidate mechanisms, still undistinguished:

- **M1** the browser honours the standard Chrome **origin-trial token** (what
  `developers.openai.com` almost certainly serves).
- **M2** an internal allowlist, e.g. OpenAI properties plus `*.openai.chatgpt.site`
  (note every OpenAI WebMCP showcase demo is hosted on that domain).

These need different fixes, so both get probed in parallel. Do not assume M1.

### E1c — regular Chrome + flag, localhost: PASS (2026-08-26)

```
document.modelContext    present
navigator.modelContext   present   <-- stale alias DOES still exist in Chrome 151
registerTool             function
getTools / executeTool   function / function
toolchange events seen   6
```

All six probe tools registered. Confirms, beyond E1c itself:

- Tool definitions pass name-charset validation (1–128 chars, `[A-Za-z0-9_.-]`).
- `annotations` with `readOnlyHint` is accepted at the top level of the tool object.
- `await registerTool(...)` resolves; no duplicate-name collisions.
- `toolchange` fires **once per registration** (6 tools → 6 events).
- `navigator.modelContext` exists in Chrome 151. The verification pass could not confirm this
  from any primary source. **Still use `document.modelContext`** — the alias is undocumented by
  Chrome and unsupported by the spec.

### E15 — what `getTools()` actually publishes to an agent: RESOLVED (2026-08-27)

From `node scripts/agent-session.mjs --dry-run` against the real build in Chrome 151. Every tool
comes back with:

```
keys: description, inputSchema, name, annotations, origin, title, window
```

**`inputSchema` survives the round trip.** This is the finding that matters, and it was not
documented anywhere we could find. It means an agent can plan against the enum-bounded parameter
schemas rather than guessing argument shapes from prose — which is the entire reason the schemas are
enums in the first place. Had `getTools()` dropped `inputSchema`, the "no free-form query" defence
would have been invisible to the very consumer it was designed for.

**But it comes back as a JSON *string*, not an object.** `registerTool` accepts `inputSchema` as an
object; `getTools()` returns it serialized. Every model provider's tool-calling API expects a JSON
Schema object — Bedrock's Converse rejects a string outright with *"The format of the value at
toolConfig.tools.0.toolSpec.inputSchema.json is invalid. Provide a json object for the field."* So a
WebMCP client has to `JSON.parse` it. Nothing in the documentation says so, and the asymmetry between
what you put in and what you get out is easy to miss because the field is present and non-empty
either way. `parseSchema()` in `scripts/agent-session.mjs` handles both shapes.

Also confirmed through the platform path rather than through our own code:

- **State gating is visible to an agent.** `getTools()` returns 2 tools before a human loads the
  dataset and 8 after. The ninth, `check_override_request`, appears only while a request is open.
- **`executeTool(toolObject, argsObject)` — the spec's object form — works.** Chrome's docs still
  show a string argument; the harness tries the object form first and has not needed the fallback.
- **Refusals travel intact.** `summarize_metric` with `stat: "max"` returns
  `{status:"refused", code:"STAT_NOT_PERMITTED", reason, recovery}` as a resolved value, not a
  rejection — which is what the "never throw a refusal" rule in `webmcp.ts` exists to guarantee,
  since the platform discards thrown error messages.
- Tools additionally carry `origin` and `window`, so the browser tracks provenance per tool. Not
  used here, but worth knowing for anyone reasoning about multi-frame pages.

### Standing gap after Day 1

Flagged Chrome gives us the API but **no ChatGPT agent**. So these remain unanswerable until
the authorisation question is solved, and all three shape the design:

- Gate B, the canary channels → decides how strongly the video may phrase the privacy claim
- E6, whether a returned refusal reason reaches the user → decides whether the ledger must
  carry the refusal narrative visually
- E10, the real output ceiling → sets the response size budget for every tool

Interim substitute: the Model Context Tool Inspector extension provides a Gemini-backed agent
in flagged Chrome. Directionally useful for schema and discovery mechanics, not authoritative
for ChatGPT-specific behaviour.

### E1d — deployed origin, origin-trial token: token REJECTED (2026-08-26)

Deployed `https://airlock.dofolabs.space` (Cloudflare Pages). Delivery verified server-side:

```
Origin-Trial header:  PRESENT (260 chars)
<meta> tag in HTML:   PRESENT at char 58, immediately after <head> at char 33
```

So the token is offered by both supported mechanisms. Results on that origin, Chrome 151.0.0.0:

| Environment | `document.modelContext` |
|---|---|
| Chrome, `#enable-webmcp-testing` **enabled** | **present** — 6 tools registered, 6 toolchange events |
| Chrome, flag **disabled** | **ABSENT** |
| ChatGPT desktop built-in browser | **ABSENT** |

**Diagnosis: the origin-trial token is being rejected.** The flag-enabled pass proves nothing
about the token, because the flag alone is sufficient. The flag-disabled run is the real test,
and it fails.

This *narrows* the earlier M1/M2 question in a useful direction: we cannot yet conclude that
ChatGPT's browser ignores origin trials, because it has never been offered a *valid* token.

Token payload, decoded by `scripts/build-probe.mjs` at build time:

```json
{"origin":"https://airlock.dofolabs.space:443","feature":"WebMCP",
 "expiry":1794873600,"isSubdomain":true,"isThirdParty":true}
```

Ruled out: expiry (2026-11-17, well past judging), origin string (canonical, with explicit
port), feature name, secure context, origin isolation, Chrome version (151 is inside the
149–156 trial window).

**Remaining suspect: `isThirdParty: true`.** Third-party tokens are validated against the origin
of the *script that injects them*. Delivered as a `<meta>` tag on a first-party document, they
can be rejected outright.

**Action:** register a second token for the same origin with third-party matching **off**, and
serve both. Chrome evaluates every token on a page and enables the feature if any one validates,
so serving several is free and removes the guesswork. The build script now supports one token
per line and prints a decoded summary of each, warning on third-party tokens.

### E1e — both origin-trial tokens rejected. Thread closed. (2026-08-26)

Registered two separate origins and served both tokens simultaneously, via `<meta>` tag **and**
`Origin-Trial` response header:

```
[0] WebMCP | https://airlock.dofolabs.space:443 | expires 2026-11-17 | subdomain, THIRD-PARTY
[1] WebMCP | https://dofolabs.space:443         | expires 2026-11-17 | subdomain, THIRD-PARTY
```

Verified live: 2 meta tags in `<head>`, 510-byte `Origin-Trial` header, matching build stamp.

Result on `https://airlock.dofolabs.space`, Chrome 151.0.0.0, flag **disabled**:
`document.modelContext` → **ABSENT**.

**The `isThirdParty` hypothesis is not supported.** The Chrome portal issued third-party tokens
on both registrations and refused a duplicate registration for the same origin, so a
first-party token was not obtainable. If third-party delivery were the blocker the trial would
be unusable by anyone via meta tag, which contradicts `developers.openai.com` working.

Cause therefore **unresolved**. Remaining candidates, none confirmed:

- the origin trial is no longer accepting tokens despite Chrome Platform Status listing
  desktop 149–156 (`origin_trial_id: 4163014905550602241`, `ot_setup_status: 6`, but the
  feature's `active_stage_id` points at the *ship* stage, not the trial stage, and
  `browsers.chrome.origintrial` is `false`)
- some additional precondition not documented anywhere we could find

The DevTools origin-trial status string would settle it and was not obtainable in the time
available. Recorded as unknown rather than guessed at.

**Decision: build for flagged Chrome.** The challenge's own instructions tell judges to enable
`chrome://flags/#enable-webmcp-testing`, so this is a sanctioned judging environment, and it
works on the live origin today — six tools registering, `toolchange` firing once per
registration, `getTools`/`executeTool` both live.

**Consequences for the plan:**

1. README must state the tested matrix explicitly: works in Chrome 149+ with the flag; the
   ChatGPT desktop built-in browser requires an authorised origin we could not obtain.
2. The video is shot in flagged Chrome.
3. **Replay mode is promoted from cheap-win to essential.** It is now the only thing that
   guarantees every judge can see the full narrative regardless of their environment, and
   judges may score on video and description alone.
4. ChatGPT Sites remains an untested fallback host. If Sites origins are auto-authorised,
   hosting there would restore the ChatGPT path. Ten minutes to test, not blocking, worth doing
   if time allows.

Time spent on this thread exceeded its value. Should have been time-boxed after E1d.

---

## E16 — ChatGPT desktop shipped WebMCP after all (2026-08-27)

**This supersedes the Day 1 finding above.** Everything earlier in this file about the ChatGPT
desktop built-in browser reporting `document.modelContext` as ABSENT, and the conclusion that it
"requires an authorised origin we could not obtain", was true when observed and is now out of date.

OpenAI shipped WebMCP in the ChatGPT desktop app's built-in browser as a feature called **site
tools**, documented at
<https://help.openai.com/en/articles/20001423-using-site-tools-in-the-chatgpt-desktop-app>.

What the documentation states, which materially changes the plan:

- **No flag, no extension, no origin trial.** "No separate connection is required." Availability
  depends on the account having access and the selected model supporting it.
- **Built-in browser only** — explicitly *not* Chrome. So this is a different surface from the
  flagged-Chrome path, not a replacement for it.
- An **arrow appears in the address bar** when a page provides tools. Selecting it lists them
  "including whether they can read information or make changes".
- ChatGPT "can discover and use it automatically" when a tool matches the request.
- Tools are scoped to the page and the signed-in session, and vanish when the page closes.
- Toggle at Browser settings → Permissions → Enable site tools.
- "Tools provided only by embedded content are not currently supported" — irrelevant here, Airlock
  is top-level.

**Why this is worth acting on.** The `annotations: { readOnlyHint: true }` set on every analysis
tool in `tools.ts` is precisely what drives that read-versus-change distinction in the arrow menu.
That detail was implemented for spec correctness with no visible payoff; on this surface it becomes
the thing a judge sees first.

**Not verified by us.** There is no ChatGPT desktop app available in this environment, so the README
row for it now reports the platform's documentation and says so explicitly rather than claiming an
observation. The origin-trial dead end recorded above remains accurate for *Chrome* and is still the
reason Replay exists.

### E16a — confirmed working in ChatGPT desktop (2026-09-02)

Observed directly, on the live origin, with **no flag, no extension and no origin trial**. Model
selector read **5.6 Terra High**.

The Site tools panel reported:

```
Available site tools (2)
1 read, 1 write tool
  load_sample_dataset
  describe_dataset
```

Three things this settles:

1. **The origin-trial dead end never mattered for this surface.** Everything recorded above about
   tokens being rejected applies to Chrome. ChatGPT's built-in browser needs none of it, exactly as
   the help article says.
2. **State-gated registration is visible to the real client.** Two tools before a dataset exists is
   what `syncRegistration()` is built to do and what the browser checks assert; ChatGPT reports the
   same number independently.
3. **`readOnlyHint` is load-bearing after all.** "1 read, 1 write tool" is ChatGPT reading the
   annotations on `describe_dataset` and `load_sample_dataset`. That field was set for spec
   correctness with no expected visible effect, and it turns out to drive how the client describes the
   page's capabilities to a user before any tool runs.

Still to confirm on this surface: that ChatGPT *invokes* the tools and that refusals surface to the
user with their policy codes. Discovery is proven; execution is not yet.
