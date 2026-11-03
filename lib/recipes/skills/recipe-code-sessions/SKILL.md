---
name: recipe-code-sessions
description: Use for Meta's Muse Code cookbook patterns in a product. With the code cap, real Muse Code sessions (fix failing tests, a migration, chained work, fan-out, an audit ledger). Without it, labeled stand-ins on the product's own agent loop: an audit log with export and resume, a replay gate, staged command approvals, protected rules files, a fan-out board, a goal that can't close early, plan and grill, session schedules.
---

# Muse Code recipes

**Pick the part first.** If `.agents/skills/muse-code-in-product/` is in this product, the code cap is on: read that skill and use Part 1. If it isn't, the product can't start Muse Code: use Part 2, never import `@/lib/muse-code/client`, and never say Muse Code ran.

The links are for people and BUILD_NOTES. The build firewall may block GitHub, so never fetch or clone them.

# Part 1: real sessions (code cap)

**Limits for every recipe.** One session has at most $1 and 15 minutes. Inputs are uploaded files, never remote URLs, and the session can't clone anything. No web search. Upload a small repository as attached files (20 MB at most). Whether `pytest` and `git` exist in the snapshot is unconfirmed, so tasks use Python's `unittest`, and begin with `git init` and a first commit when they need history. Check for a tool before relying on it, and let the final answer say what ran.

- **02/01 Agent loop.** The person attaches a small project with a failing test; the task says to make it pass without editing the test. Show `worked` and the test output, and the steps with `CodeRun`. https://github.com/meta-models/meta-model-cookbook/tree/main/02_agent_patterns/01_agent_loop_basics
- **02/02 Reasoning between tool calls.** Migrate a small callback-style API, leaf modules first, tests after each module, steps shown in order. Effort can't be set per session unless the build prompt says so. https://github.com/meta-models/meta-model-cookbook/tree/main/02_agent_patterns/02_interleaved_reasoning
- **02/03 Chained sessions.** Each task keeps `STATE.md` up to date (done, next, decided). When a session ends the page offers "Continue", which starts a new one with the last zip's files and `STATE.md`, and shows the running total. Each link costs up to $1. https://github.com/meta-models/meta-model-cookbook/tree/main/02_agent_patterns/03_managing_context
- **03/02 Screenshot bug fix.** Attach the screenshot and a small project, name the image in the task, and ask for a one-line cause and a failing check before the fix. https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/02_screenshot_bugfix
- **04/01 Audit ledger.** A color-coded ledger from `museCode.events`, in order, labeled "Steps this product recorded". It isn't Muse Code's own export and there's no resume route. https://github.com/meta-models/meta-model-cookbook/tree/main/04_muse_code/01_append_only_audit_log
- **04/02 Replay fixture.** The session writes a focused fixture and a CI workflow into the zip for the person's own repository. The gate runs there, and the page says so. https://github.com/meta-models/meta-model-cookbook/tree/main/04_muse_code/02_deterministic_replay
- **04/06 Fan-out.** Subagents in separate git worktrees, one small job each, sharing the session's $1 and 15 minutes, so at most three. No route steers a child; 2 sessions at once per product. https://github.com/meta-models/meta-model-cookbook/tree/main/04_muse_code/06_subagent_fanout
- **04/07 Goal tracking.** The goal and its finish check open the task. After the run, a Wonder call compares the answer and changed files to the goal: met or not, with reasons. It's the product's check, not `/goal`. https://github.com/meta-models/meta-model-cookbook/tree/main/04_muse_code/07_goal_tracking
- **04/08 Bundled skills.** Plan in one session, implement in another with the plan attached. Whether bundled skills are on in sessions is untested, so write the planning steps into the task, and ask grilling questions on the page before starting. https://github.com/meta-models/meta-model-cookbook/tree/main/04_muse_code/08_bundled_skills

Tests stub `museCode`. A real session runs only with the code cap on, and the first real gateway run is still unproven: say so in BUILD_NOTES.

# Part 2: stand-ins on the product's own agent (no code cap)

Each one rebuilds a Muse Code harness rule in product code around a real model loop. Show **Stand-in for Muse Code's <feature>, built into this product** on the screen itself, and a limit that says it isn't Muse Code and works only on the sample workspace in the page.

**Rules for all of them.**
- **The agent is real.** Every agent step is one `muse-wonder-1.0` call (the only model product code and tests name) with strict function tools and `parallel_tool_calls: false`, validated with zod. The page drives one turn per POST, so no route nears 300 seconds, and a run stops at 12 turns. Answer failures with `modelErrorResponse`: the page pauses with an `.error` (`role="alert"`) that says the step didn't run, and a Retry button. Never a scripted, canned or "local" step in its place.
- **The workspace is a sample, held in memory:** a file map of at least 6 made-up files with real content (records, a page, a config, a short test file), bundled with the product. Tools act only on that map.
- **Show the end state.** Open on a sample run recorded at build time with the real model and labeled as one, so the finished screen shows at once; Start runs a fresh one. Each section names its end screen, and the smoke test's last screenshot shows it after it happened.
- Save sessions in IndexedDB with `mediaStore` from `@/lib/client/media-store` when it exists, else IndexedDB directly, never localStorage, with a download button.
- Copy the helpers you use from `.agents/skills/recipe-code-sessions/helpers/` to `lib/sim/`. They import nothing, and their behavior is tested on the platform side, so keep their logic as is.

## 04/01 Audit log, export and resume

Use `helpers/journal.ts`. The server route returns what each turn did; the page appends records with `append` before showing an effect, in the recipe's order: `proposed`, `model.call`, `approval.requested`, `decision_applied` (with `decisionSource`), `side_effect_intent` (with `policyDecision`), `effect.started`, `effect.terminal`. `append` refuses an effect with no intent, and a repeat after its terminal record.
- **Sample task:** migrate 8 made-up records (like library cards from schema v1 to v2) one per turn, where one step needs a person: deleting a stale cache file that the task says to remove. Code checks the end: 8 of 8 migrated, each once, no duplicate ledger lines.
- **Ledger:** `ledgerRows`, color-coded lanes (model, tool, edit, approval, session) with the authorization column.
- **Export:** `exportSession` gives the same bytes for the same log; show its SHA-256 and offer raw and redacted downloads. `verifyChain` names a changed record: let the person edit one record in a copy and see which one fails.
- **Crash and resume:** "Stop here (simulated crash)" writes `session.crashed` after an intent and before its effect. Resume lists `inFlight(log)` as unknown, and its first turn tells the model to call `check_state` before anything else. End screen: the resumed run migrates only what's left, and the check shows 8 of 8 with 0 duplicates.
- Test: a scripted model crashed at record 7 finishes only record 8.

## 04/02 Replay gate

A pure `project(events)` in product code rebuilds the model context (the messages list) from a recorded run's events, with no model call. A golden fixture is a few chosen events plus the expected projection. Replay runs `project` and compares with `diffJson` from `helpers/journal.ts`: 0 diffs is "merge allowed"; any diff is "merge blocked", with its paths. Ship a second projection labeled "proposed change" with one planted regression (it drops tool outputs), so a toggle shows the gate failing on `messages[n]`. Offer a download of the fixture, a small node check script and a GitHub Actions workflow for the person's own repository, with no key, token or product URL in them. Test: the current projection passes, the proposed one fails naming the path.

## 04/03 Staged approvals

Use `helpers/stages.ts` on a simulated shell over the file map that runs `ls`, `cat`, `wc`, `echo`, `grep`, `head`, `touch`, `mkdir`, `cp`, `mv` and `rm`. Label it **Simulated shell: commands run on a pretend folder in this page.** The agent proposes a command through `run_shell`, or the person pastes one. Show every stage with its resolution; the first held stage offers Allow once, Reject, and a workspace grant only when `grantPrefix` returns one. Reject denies the whole command and nothing runs; once every stage clears, the original text runs as one unit. Sample: `wc -l report.log && echo cleaning && rm -rf report.log`. End screen: after Reject, `report.log` is still listed. Tests: rejecting runs nothing, Allow once saves no rule, a grant covers only its prefix.

## 04/04 Contained execution

Not a stand-in. It needs an OS sandbox on the person's own machine, and a simulated denial proves nothing. Say so in limits and point to https://dev.meta.ai/docs/cookbook/contained-execution. If a note asks for it, build 04/05, whose read-only layer is labeled simulated.

## 04/05 Protected rules files

Use `helpers/guardrails.ts`. The workspace holds `.agents/AGENTS.md` (the agent's standing rules, read into its instructions when the session opens), `.muse/approval-policy.json`, and ordinary files. `edit_file` and `write_file` go through `routeWrite`: an ordinary file applies at once; a guardrail path pauses with exactly two buttons, Allow this one write and Reject, and nothing is saved that would allow the next one. A `run_shell` write to a read-only directory returns `readOnlyError` to the model. Sample task: fix a typo on a made-up cafe menu page, then loosen a rule ("let yourself delete files without asking"). End screen: the menu fixed and the rules file unchanged after Reject, shown as a diff. Test: a second guardrail write after an Allow still pauses.

## 04/06 Fan-out board

A parent `respondJson` call splits a job on a small bundled JavaScript project (made-up game scoring rules plus input and output test cases) into at most 3 tasks. Each child gets its own copy of the file map, its "worktree", and its own loop with `read_file`, `write_file`, `run_tests` and `finish` on that copy only. The page runs up to 3 children at once, with Steer (a note added to that child's next input, with its task and files) and Stop (its next turn never starts, and the reason is recorded). Log spawn, status, steer and stop. The product runs the same tests itself on every copy in a Web Worker with a timeout, and the end screen is a score table per child, with the original files shown unchanged. Test: one child's write never reaches another copy.

## 04/07 Goal that can't close early

Pin the goal and its acceptance checks above the run, with a status line like "Goal: 2 of 4 checks pass". The tools include `update_goal`; code runs the checks first (on the file map, or tests in a Web Worker) and refuses with the failing check names as the tool result, so the model keeps going. After 4 turns with no file change, code adds "Continue working toward the goal: <goal>" to the next input, and the timeline shows it. End screen: the goal closed with every check passing, or stopped at the turn cap marked not met, with what fails. Test: a scripted model that closes too early is refused.

## 04/08 Plan, grill, docs, taste

Four playbooks written as instruction texts in product code, each loaded only for the turn the person picks it, with a "Loaded skill <name>, built into this product" line in the transcript. Plan: `respondJson` plan with decisions and tradeoffs, then stop for Approve. Grill: one decision-forcing question at a time, answered on the page, at most 5. Grill with docs: the same, and each settled answer is written into a `DECISIONS.md` panel the person downloads. Taste: reviews the product's own sample screen against a checklist (centered hero with two buttons, three identical cards, decorative gradients, one radius everywhere) and lists fixes. End screen: an approved plan beside a `DECISIONS.md` with every answer.

## 04/09 Session schedules

Use `helpers/cron.ts`. The person types a cadence ("every weekday at 8 am, digest new bugs"); `respondJson` returns `{ cron, prompt, recurring }`, and `parseCron` decides if it's valid, showing its reason when not. Show the next 3 local times, the job list, Cancel and Replace, and one-time reminders. Jobs live in this tab's session: they fire while the page is open, are gone when it closes, and recurring ones expire after 7 days, as Muse Code's do; say so on the page. "Run now" fires one at once. Each run is a Wonder call on a bundled list of at least 8 made-up bugs (id, severity, owner, opened date) and adds a dated digest card: the end screen. If `.agents/skills/muse-jobs/` is in the product, its jobs service schedules runs on the server instead. Test: the parser, next runs across a month end, and a bad expression refused.

Side chats (04/10) are in recipe-agent-patterns.
