# Meta's cookbook in Muse Muse

The owner's ask (Nov 3): every recipe in Meta's cookbook (https://dev.meta.ai/docs/cookbook) buildable and built in Muse Muse. The offline copy is content/meta-docs/pages/cookbook/, one file per page, and a page's live address is https://dev.meta.ai/docs/cookbook/<file name>.

The mirror has 60 pages: 51 recipes and 9 section index pages. 50 recipes are app builds from one note each, 1 is a docs demo only (contained-execution), and the 9 index pages link recipes and have no recipe of their own. Every recipe also has a docs demo on /docs (lib/docs/demos/). Each build note is in `scripts/demo-batch.ts`, `--set=cookbook`, under the recipe's slug.

Status, Nov 3 midday ET: the skills, helpers, registry and notes are on main after the cookbook merge (tg-c-cookbook). **No cookbook build has run yet.** Everything below is built so and unproven until the owner runs the set. "After deploy" means the recipe skill fix is in this merge and reaches builds once main deploys (recipe skills ship in lib/recipes/generated.json, so no snapshot is needed for the skill itself).

## Run the whole set

Order:

1. Deploy main with this merge. `RECIPES_ENABLED` and `AGENT_LONG_RUNS` are already on in Production.
2. Make the new builder snapshot (`npm run snapshot` in a linked worktree with .env.local, then commit lib/sandbox/snapshots.json and deploy). The overlay, raster and media-store helpers and presigned uploads reach builds only with it, and several notes lean on them (grounding dots, vision, stickers, captions, voice over about 2 minutes). The skills have fallbacks, but the set is meant to run on the new snapshot.
3. From a linked worktree with .env.local (like ~/mm-wt/overnight), check the list, then start it:

```
npm run demo-batch -- --set=cookbook --dry
npm run demo-batch -- --set=cookbook
```

It starts 50 builds on https://www.musemuse.dev as the first admin (no daily build limit) and writes every build link to `.data/demo-batch-<time>.json`. Fill the Build id column below from that file. One recipe or a few: `npm run demo-batch -- --set=cookbook prompt-caching side-chats`.

**Cost, an estimate:** overnight builds on Muse Spark 1.3 Contributor were $0.17 to $0.40 each in Meta credits, so about **$8.50 to $20** for the 50. $1.80 is the most one build has cost so far (the README's local batch), so $90 for the 50 is a high guess, not a limit: the hard limit per build is its build token's $10 test budget (`buildTokenBudgetUsd`), and the daily cap below. Builds whose tests call Muse Image, SAM or Voice (the 9 media recipes) lean to the top of the range. Vercel Sandbox minutes come on top: 30 to 150 minutes a build, about 25 to 125 Sandbox hours in all. The four long simulated-loop products (sandboxed-execution, multi-agent-orchestration, computer-use, computer-use-macos) cost dollars per run once someone presses Start, not during the build beyond their smoke tests. The platform's daily spend cap (`DAILY_SPEND_CAP_USD`, $100 default) counts all platform spend that UTC day, reservations included, not only this set. The set fits under it at the estimate; at $1.80 a build it would take most of a day's cap, and once the cap is reached new builds are refused (503 paused), so a refused build can be rerun by id the next day.

**Time:** the script posts the 50 notes one after another in a minute or two, then the laptop can close. Each build takes about 30 minutes to the 150-minute wall, and they run on Vercel side by side, so the set is built so to finish in about 2.5 hours if Vercel starts them all at once. The team's limit on Sandboxes running at once hasn't been checked; if builds queue, it takes longer. Start it by about 6 AM ET Nov 4 to leave time to look at the products before the noon submission.

## Every page

Recipe ids are in lib/recipes/registry.ts; docs demos are `cookbook/<slug>` in lib/docs/demos/ (cookbook-fundamentals.ts, cookbook-use-cases.ts, muse-code-cookbook.ts, cookbook-media.ts, open-weights.ts). "Live" names an overnight product that already shows part of the recipe.

### API fundamentals (recipe-api)

| Recipe | Path | Covered by | Buildable today | Build id |
|---|---|---|---|---|
| quickstart-chat-completions | app build | recipe-api 01/01, template meta-chat skill, docs demo | yes | |
| streaming-responses | app build | recipe-api 01/02 with helpers/stream.ts, docs demo; live parking-policy-reader streams | after deploy | |
| tool-function-calling | app build | recipe-api 01/03, docs demo | yes | |
| structured-output | app build | template respondJson, recipe-api 01/04, docs demo; live dockline-triage-copilot | yes | |
| prompt-caching | app build | recipe-api 01/05 with helpers/usage.ts and context.ts, docs demo; parking-policy-reader read 0 cached (prefix too short) | after deploy | |
| reasoning-thinking-tokens | app build | recipe-api 01/06, template meta-reasoning skill, docs demo | yes | |
| vision-input | app build | template meta-reasoning skill, recipe-api 01/07, docs demo; live chart-check-deck, fresh-dot-fridge | yes | |
| long-context | app build | recipe-api 01/08 with helpers/context.ts, docs demo | after deploy | |
| error-handling-retry | app build | recipe-api 01/09 with helpers/retry.ts, template errors.ts, docs demo | after deploy | |
| search-grounding | app build | recipe-api 01/10 with helpers/footnotes.ts, docs demo; live parking-policy-reader, austin-budget-weekender | after deploy | |

### Agent patterns (recipe-agent-patterns)

| Recipe | Path | Covered by | Buildable today | Build id |
|---|---|---|---|---|
| basic-agent-loop | app build | recipe-agent-patterns 02/01 with helpers test-worker.ts and loop-guards.ts, docs demo | after deploy | |
| interleaved-reasoning-tool-use | app build | recipe-agent-patterns 02/02, docs demo | after deploy | |
| multi-turn-context-management | app build | recipe-agent-patterns 02/03, docs demo | after deploy | |
| search-and-replace-edits | app build | recipe-agent-patterns 02/04 with helpers edits.ts and diff.ts, docs demo | after deploy | |
| alert-fatigue-copilot | app build | recipe-agent-patterns 02/05 with helpers/alert-feed.ts, docs demo; live dockline-triage-copilot (thin sample). Note reused from DEMO_NOTES `alerts` | after deploy | |
| glimmer-api-agent | app build (stand-in) | recipe-agent-patterns 03/15 with helpers/egress-gate.ts, docs demo. The local model is a stand-in: Muse Muse never runs Glimmer on a person's device | after deploy | |
| github-agent | app build (stand-in) | recipe-agent-patterns 03/11 repo kit with a dry run, docs demo. The product never writes to GitHub | after deploy | |

### Use cases

| Recipe | Path | Covered by | Buildable today | Build id |
|---|---|---|---|---|
| perception-chart-analysis | app build | recipe-visual-reports 03/01, docs demo; live chart-check-deck. Note reused from DEMO_NOTES `charts` | after deploy | |
| perception-error-screenshot-fix | app build (stand-in) | recipe-visual-reports 03/02 bundled-page stand-in; recipe-code-sessions 03/02 with the code cap; docs demo | after deploy | |
| rayban-openclaw | app build, glasses target | recipe-voice 03/03, glasses target, docs demo; live market-day-reader. Real Ray-Ban hardware is untested | yes | |
| generating-slides | app build | recipe-visual-reports 03/04, docs demo | after deploy | |
| browser-verified-web-design | app build | recipe-visual-reports 03/05 (the build's own screenshot verify is the browser loop), docs demo | yes | |
| iterative-game-dev | app build | recipe-games 03/06, docs demo; lantern-canal-drift hidden after a soft-lock. Note reused from DEMO_NOTES `games` | after deploy | |
| sandboxed-execution | app build (long run, stand-in) | recipe-simulated-loops 03/07 (Pyodide in a Web Worker, not Docker), docs demo | after deploy | |
| multi-agent-orchestration | app build (long run) | recipe-simulated-loops 03/08, docs demo; live relay-board-studio (its four agents were scripted, Nov 3 audit). Note reused from DEMO_NOTES `studio` | after deploy | |
| one-shot-game-dev | app build | recipe-games 03/09, docs demo | after deploy | |
| perception-grounding | app build | recipe-visual-reports 03/10, docs demo; fresh-dot-fridge hidden (box scale). Note reused from DEMO_NOTES `fridge` | after deploy | |
| computer-use | app build (long run, simulated screen) | recipe-simulated-loops 03/12 with helpers/cu-sim.ts, docs demo; sim-desk-agent-demo hidden. Note reused from DEMO_NOTES `computer-use` | after deploy | |
| computer-use-macos | app build (long run, simulated screen) | recipe-simulated-loops 03/13 with helpers/cu-sim.ts, docs demo | after deploy | |

### Building with Muse Code

Production drops the builder-only code cap while `TRUST_SIGNED_IN_CAPS` is off, so recipe-code-sessions no longer needs it: without it a build uses Part 2 of the skill, labeled stand-ins on the product's own Muse Wonder agent that say on screen they aren't Muse Code.

| Recipe | Path | Covered by | Buildable today | Build id |
|---|---|---|---|---|
| audit-agent-sessions | app build (stand-in) | recipe-code-sessions 04/01 with helpers/journal.ts, docs demo | after deploy | |
| deterministic-replay | app build (stand-in) | recipe-code-sessions 04/02 (diffJson in helpers/journal.ts), docs demo | after deploy | |
| staged-approvals | app build (stand-in) | recipe-code-sessions 04/03 with helpers/stages.ts (short); recipe-simulated-loops 04/03 (long); docs demo | after deploy | |
| contained-execution | docs demo only | docs demo cookbook/contained-execution (ContainmentChecker); writer rule | no | n/a |
| immutable-guardrails | app build (stand-in) | recipe-code-sessions 04/05 with helpers/guardrails.ts, docs demo | after deploy | |
| subagent-fanout | app build (stand-in) | recipe-code-sessions 04/06, docs demo | after deploy | |
| goal-tracking | app build (stand-in) | recipe-code-sessions 04/07, docs demo | after deploy | |
| bundled-skills | app build (stand-in) | recipe-code-sessions 04/08, docs demo; template product-ui uses /taste in builds | after deploy | |
| loop-and-cron | app build (stand-in) | recipe-code-sessions 04/09 with helpers/cron.ts, docs demo | after deploy | |
| side-chats | app build | recipe-agent-patterns 04/10, docs demo; live dockline-triage-copilot has a side chat | yes | |

**Why contained-execution isn't a build:** the recipe's point is that the operating system (bubblewrap on Linux, seatbelt on macOS) enforces the sandbox profile on the person's own machine, after a live probe. A hosted product can't run that, and a simulated denial proves nothing, so a build would be theater. The docs demo teaches the policy, and the writer rule tells a brief to say so in its limits.

### Muse Image, Muse Voice Transcribe and SAM

| Recipe | Path | Covered by | Buildable today | Build id |
|---|---|---|---|---|
| image-generation-basics | app build | recipe-image 05/01, docs demo; live room-restyle-studio (refine half) | after deploy | |
| search-grounded-image-generation | app build | recipe-image 05/02, docs demo. That Muse Image really searches through the gateway is unproven | after deploy | |
| anchored-image-series | app build | recipe-image 05/03, docs demo | after deploy | |
| image-editing-with-reasoning | app build | recipe-image 05/04, docs demo; live room-restyle-studio | after deploy | |
| voice-api-fundamentals | app build | recipe-voice 06/01, docs demo; live standup-scribe-notes. Finished recordings only: the realtime WebSocket isn't proxied | yes | |
| voice-chess-cua | app build (stand-in) | recipe-voice 06/02, a board on the page, not Apple Chess; docs demo | after deploy | |
| sam-api-basics | app build | recipe-sam-media 07/01, docs demo; live object-count-studio, parking-lot-counter | after deploy | |
| video-to-sticker-pack | app build | recipe-sam-media 07/02 with sticker, webp-anim and gif helpers, docs demo; wag-sticker-studio hidden (uploads 503). Note reused from DEMO_NOTES `stickers` | after deploy | |
| headlocked-speech-bubble-captions | app build (stand-in export) | recipe-sam-media 07/03 with helpers/captions.ts plus recipe-voice's transcriber, docs demo. Exports WebM, not server-rendered H.264 | after deploy | |

### Open weights (recipe-open-weights, new)

| Recipe | Path | Covered by | Buildable today | Build id |
|---|---|---|---|---|
| muse-spark-open-mac | app build (kit) | recipe-open-weights Mac cluster kit with helpers/mac-cluster.ts, docs demo. Nothing runs on real Macs | after deploy | |
| muse-spark-open-torchtitan-sft | app build (kit) | recipe-open-weights SFT data studio with helpers/sft-data.ts, docs demo. The product trains nothing | after deploy | |
| muse-spark-open-torchtitan-rl | app build (kit) | recipe-open-weights reward spread check with helpers/grpo.ts, docs demo. The product trains nothing | after deploy | |

### Section index pages

These link recipes and have no recipe of their own, so they have no build. Their recipes are in the tables above.

| Page | Path | Its recipes |
|---|---|---|
| api-fundamentals | index | the ten API fundamentals |
| agent-patterns | index | the agent patterns |
| use-cases | index | the twelve use cases |
| muse-code | index | the ten Muse Code recipes |
| muse-image | index | the four Muse Image recipes |
| muse-voice-transcribe | index | voice-api-fundamentals |
| sam | index | the three SAM recipes |
| run-locally | index | muse-spark-open-mac |
| post-training | index | the TorchTitan SFT and RL recipes |

## What is still unproven

- Every cookbook build: none has run. The notes are built so that each finishes in one build on Contributor.
- Prompt caching hits through the gateway, and whether Contributor caches at all on test builds. The skill records the second call's cached count and doesn't fail on 0.
- Pyodide served from npm inside a built product (sandboxed-execution falls back to its replay).
- Muse Image searching the web when the prompt asks (search-grounded-image-generation).
- espeak voices separating under diarization for the captions sample (the skill falls back to manual labels).
- Real Ray-Ban glasses (rayban-openclaw has a phone-browser fallback).
- Muse Code itself: the stand-ins don't run it. Real sessions need `TRUST_SIGNED_IN_CAPS`, `CODE_ENABLED`, `MUSE_CODE_ENABLED` and a snapshot with the musecode overlay.
