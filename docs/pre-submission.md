# Pre-submission checklist

Devpost judges reportedly check basic requirements before anything else, and a surprising number of
entries fail there rather than on merit. This is the list, with the automated parts already wired up.

Run everything in one go:

```bash
npm run verify:all
```

---

## Automated — all currently passing

| Check | Command | Status |
|---|---|---|
| Typecheck | `npm run typecheck` | clean |
| 166 unit, invariant, adversarial and regression tests | `npm test` | passing |
| No network primitive in the shipped bundle | `npm run verify:egress` | passing |
| 47 browser checks in real Chrome with WebMCP live | `npm run verify:browser` | passing |
| Accessibility, contrast and the no-WebMCP path | `npm run verify:a11y` | passing |
| A real model chooses and drives the tools | `npm run agent` | passing |
| Deployed site serves tokens and the current build | `npm run verify:live` | passing |
| Nothing secret-shaped in the tracked tree | `npm run verify:secrets` | passing |

---

## Requirements from the official rules

| Requirement | State |
|---|---|
| Working live URL | https://airlock.dofolabs.space |
| Judges can reach it without setup | `?replay=1` and `?attack=1` need no flag, no agent, no account |
| Public code repository | https://github.com/faizydroid/airlock |
| Open source licence **visible in the GitHub About box** | MIT, confirmed via GitHub's licence API |
| Repo contains `document.modelContext.registerTool({...})` | `src/tools/webmcp.ts`, called directly with no wrapper |
| Text description covering all four required questions | `docs/submission.md` |
| Demo video under 3:00, public on YouTube, with audio | **outstanding** |
| Video shows a working demo and explains the WebMCP use | script in `docs/video-script.md` |

---

## Still on a human

**1. Record one real agent-driven session.** Chrome 149+, flag enabled, Model Context Tool
Inspector extension. Ask it: what tools does this page offer; audit the dataset for pay equity;
what is the highest salary. This is the last piece of evidence missing — everything else is
verified, but nobody has yet confirmed a model *chooses* these tools from their descriptions
unprompted.

**2. Shoot the video.** `docs/video-script.md` is a timed shot list. Three things from it that
matter most: open on the refusal, record narration over a cut timeline rather than talking live,
and protect the mechanism section if a take runs long.

**3. Submit.** Paste from `docs/submission.md`. Four fields: live URL, repo URL, video URL,
description.

---

## Timing

**Deadline: 1 pm Pacific, 3 September 2026.** Not midnight — half a day earlier than instinct
suggests. The announcement thread quotes a slightly later instant than the challenge page; the
challenge page governs, so use 1 pm PT.

Submit with whatever exists and refine afterwards if the platform allows edits. A late perfect
entry scores zero.
