# Muse Code at full strength, online

The owner's goal (Oct 30): Muse Muse runs Muse Code to the fullest, from the browser. Every Muse Code capability that
works in a build is turned on, shown in the build room, and steerable by the build's owner. Then every product gets an
MCP server, a CLI, a skill file and a Muse connector, each hosted, tested and shown working in a video.

This file holds what a real sandbox showed on Oct 30, the design, and the build order. Read it before changing
`lib/sandbox`, `lib/pipeline` or `components/build`.

## What a real builder sandbox showed (Oct 30, Muse Code 1.4.14)

A throwaway sandbox from the current builder snapshot, never saved (scripts, outputs and logs:
`docs/spikes/muse-full-2026-10-30/`). Phases A and B made no model calls. Phase C made seven tiny runs on
muse-spark-1.3-contributor at low effort, about $0.10 in all.

| Question | Answer |
|---|---|
| Version, arch | `Muse Code 1.4.14 (1.4.14-R7309.1)`, x86_64, user `ubuntu`, binary `/vercel/.local/bin/muse-bin-1.4.14-R7309.1` |
| Per-run settings | `muse exec -c KEY=VALUE` and `muse serve -c KEY=VALUE`, values are JSON, repeatable. **Unknown keys refuse the run (exit 2)**, so `-c` doubles as a validator. Accepted: `agents.execution_capacity=6`, `runtime_capabilities={"plugin:tbh-reminders:reminder:todo-reminder":{"enabled":true}}`, `max_consecutive_stop_hook_continuations=3`. Refused: `feature_config.enabled=[...]` (wrong type) |
| `agents.execution_capacity` | Integer 1 to 64; 0 and 65 make the settings file malformed; `agents` has no other key |
| Observers | Reminder plugins, toggled per id with `runtime_capabilities["plugin:tbh-reminders:reminder:<id>"].enabled`. Ids: `skill-reminder`, `goal-reminder`, `verify-reminder`, `memory-reminder`, `todo-reminder`, `scope-reminder`. `--disable-reminders` turns all off |
| Hooks file | `.muse/hooks.json` in **Claude Code's shape**: `{"hooks":{"<Event>":[{"matcher":"<regex>","hooks":[{"type":"command","command":"..."}]}]}}`. `UserPromptSubmit` and `Stop` groups must have no matcher. Startup prints `muse: Hooks: N runnable · M warnings` on stderr |
| Hook input | JSON on stdin: `hook_event_name`, `session_id`, `cwd`, `model`, `model_provider`, `permission_mode`, plus per event (`source` for SessionStart; `messages`, `tools`, `tool_count` for PreLLMCall; `error` for StopFailure). Env is only `HOME LANG MUSE_SESSION_ID MUSE_THREAD_ID PATH PWD SHELL SHLVL TRACEPARENT` |
| Hook output | JSON on stdout. `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}` reached the model (it repeated a codeword only the hook gave it). `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}` blocked an edit (deny needs a reason; allow needs `updatedInput`). `{"decision":"block","reason":"..."}` on `Stop` made the agent do the extra work first. Also seen in the binary: `systemMessage`, `suppressOutput`, `selectedSkills` |
| Events that fired | SessionStart, PreLLMCall, PostLLMCall, PreToolUse, PostToolUse, Stop, StopFailure, SessionEnd |
| Trust | `--yolo` trusts the workspace on exec. On serve, project hooks are listed but **disabled** without `--trust-workspace`, and run with it |
| MCP | A project `.mcp.json` in Claude's shape (`{"mcpServers":{"spike":{"command":"node","args":[...]}}}`) loaded under `--yolo`, and the model called `mcp__spike__spike_ping` |
| Workflows | The Workflow tool is offered on this Linux build and ran a one-child workflow; its child logs as owner type `workflow_child`. `muse workflows save <name> --from <js> --scope project` writes `.agents/workflows/<name>.js`; `muse workflows run <entry> --headless-qa` exists (QA lane) |
| Subagents | `subagent_spawn` with worktree isolation made `.muse/worktrees/subagent-v2-<...>` on a detached HEAD and the child committed there. Isolation is on by default per child request |
| Tools offered | 31: `workflow`, `read_file`, `search`, `write_file`, `edit_file`, `read_memory`, `add_memory`, `edit_memory`, `work_stop`, `work_list`, `work_status`, `bash`, `bash_input`, `monitor`, `cron_create`, `cron_delete`, `cron_list`, `get_goal`, `create_goal`, `update_goal`, `report_progress`, `image_generation`, `subagent_spawn`, `subagent_status`, `subagent_send_message`, `subagent_wait`, `subagent_read_result`, `subagent_cancel`, `read_skill`, `snooze_reminder`, `write_todos` |
| `muse serve` | Stdio JSON-RPC host. Flags: `--disable-sandbox` (needed: no bubblewrap), `--trust-workspace`, `--disable-request-user-input`, `--model`, `--contributor-mode`, `-c`. Approval mode is chosen per session over the wire (`approvalMode: "allowAll"`) |
| Session protocol | `@muse-code/sdk@1.4.14` (MIT, zero dependencies, versions in lockstep with Muse Code) spawned `muse serve` inside the build firewall. `session/start` (approvalMode allowAll), `hook/list`, `skill/list`, `model/list`, `task/list`, `goal/set` and `turn/steer` all worked. A goal set over the protocol started its own turn; a steer sent mid-turn was obeyed (both files it asked for were made) |
| Stream | Notifications: `item/started`, `item/updated`, `item/completed`, `item/delta`, `turn/started`, `turn/completed`, `session/goalChanged`, `session/todoListChanged`, `session/tokenUsage`, `session/contextUsage`, `session/statusChanged`, `approval/requested`, `userInput/requested`, and more. Item kinds: `userMessage`, `agentMessage`, `reasoning`, `toolCall`, `userShell`, `subagent`, `workflow` (with `children` and `declaredPhase`), `reminderChild`, `compaction`, `hookRun`, `sideChat`, `webSearch`, `monitorFeed`, and a few more |
| Exec log | Sparse for children: a workflow or subagent shows as one `tool.result`; the child's own work is only in `subagent/<id>/session.jsonl`. The session protocol carries it live |
| Model prices (from `model/list`) | Muse Wonder 1.0: $4 in, $0.20 cached, $20 out per million. Muse Spark 1.3: $1.25 in, $0.15 cached, $4.25 out |

## Design

### 1. The engine: a session bridge over `muse serve`

Builds keep their shape (the durable workflow polls a log in the sandbox every 15 s), but the thing in the sandbox
changes from `muse exec` to a small bridge script:

- **What it is.** One plain ESM file, `/vercel/musemuse/bridge/bridge.mjs`, written by the platform before every
  start (so the agent can't change it and no snapshot is needed), using `@muse-code/sdk@1.4.14` installed once per
  sandbox under `/vercel/musemuse/bridge/node_modules` (npm is allowed through the build firewall; a future snapshot
  bakes it in).
- **What it does.** Spawns `muse serve --disable-sandbox --trust-workspace [--disable-request-user-input] --model <m>
  -c <settings>`, starts or resumes the build's session in `/vercel/app`, sets the goal (MSP `goal/set`) from the
  brief's "Done means", starts the turn with the prompt file and inspo images, and writes every frame to
  `bridgePaths(round).log` as `BridgeLogRecord` lines (`lib/sandbox/bridge-protocol.ts`).
- **Commands.** It polls `bridgePaths(round).mailbox` every second for `MuseCommandEnvelope` files and turns each into
  a protocol call: steer, queue, interrupt, goal set/edit/pause/resume/clear, answer, workflow pause/resume/cancel,
  subagent message/interrupt/stop, end. Each applied command is logged as a `command` record.
- **Ending.** It exits when the turn has completed and the goal is not active (complete, blocked or paused), or on
  `end`, or at the step cap, always writing the final `bridge`/`exit` record with an exit code like exec's (0 done,
  1 failed or interrupted, 2 usage or config error) and the last agent message. The agent can write to this log, so the
  record only tells the poll to look: `pollBridge` takes the exit code from the command, and stops a bridge whose command
  is still running after its log says it exited, so the round's cap, its Stop and its charges never end while it goes on.
- **Fallback.** `MUSE_ENGINE=exec` (and any sandbox whose bridge can't install) keeps today's `muse exec` path. The
  default stays `exec` until test builds pass on `serve`.
- **The per-round engine file.** `startMuse` writes the engine a round really runs on to
  `/vercel/musemuse/run/muse-r<round>.engine` (an exec fallback rewrites it before `startMuse` returns), next to
  `muse-r<round>.cmd`. `<round>` is the log round, `roundBase + round` (a refinement's start at 10, 20, ...), which also
  names the bridge's log and mailbox and is what `museRoundStep` puts on the build row (`builds.muse_round`). The
  control route has no `MuseRun`, so `sendMuseCommand` reads this file to pick the mailbox (serve) or the notes hook and
  kill (exec), and refuses a command for a round whose command has finished (`MuseRoundEndedError`, answered 409
  `no_round`).

### 2. Every capability on, in platform-owned config

Rewritten by the platform before every Muse Code start, on both engines:

- **Settings** (`-c`): `agents.execution_capacity` sized to the 4 vCPU VM (`MUSE_AGENT_CAPACITY`, default 6, held to
  1 through 64), every reminder on (adds memory, todo and scope to the defaults), a stop-hook continuation cap.
- **Hooks** (`.muse/hooks.json`, scripts under `/vercel/musemuse/hooks/`, outside the product): a PreToolUse guard that
  denies writes to the platform's files and to `.env*`; a PostToolUse and PostToolBatch hook that delivers owner notes
  from the mailbox as `additionalContext` (the steering channel on the exec engine); a Stop gate that runs the
  typecheck and blocks once with the errors; and event loggers for SubagentStart/Stop, PreCompact/PostCompact and
  StopFailure.
- **MCP** (`.mcp.json`): the platform's build MCP over streamable HTTP on the platform host (already allowed by the
  firewall), `mode: "optional"`, with a per-build token only the Muse runner exports: Meta docs search and read (the
  mirror in `content/meta-docs`), the model catalog, and the build's own progress notes. Off when the sandbox can't
  reach the platform (local runs without a tunnel).
- **Skills**: turn `workflow-authoring` back on (a runner prelude, `WORKFLOW_SKILL_PRELUDE` in
  `lib/sandbox/muse-config.ts`, on both engines; a later start without MUSE_FULL turns it off again).
  `DISABLED_BUNDLED_SKILLS` in `lib/sandbox/setup.ts` still lists it, so the snapshot and plain exec keep it off. The
  build prompt gets a playbook for a scout subagent first, parallel writers in isolated worktrees, a read-only reviewer
  at the end, and workflows for fan-out checks, and every prompt gets the limits each child keeps to. The playbook
  lives in `sessionLines` in `lib/brief/render.ts`, behind its `playbook` option (`sessionNotes()` in
  `lib/pipeline/build-steps.ts` turns it on under MUSE_FULL or `MUSE_ENGINE=serve`). The template's AGENTS.md stays as
  it is: every build reads it, flags or not, and a product's sandbox keeps the copy it was built with.
- **Safety**: `.muse` joins the deploy exclusions; stray project config the agent wrote (`.mcp.json` it didn't get
  from us, extra hooks) is replaced before each start. The platform's `.mcp.json` is removed before a deploy collects
  files, in a sandbox that has this config (`MUSE_FULL_MARKER`).
- **Notes**: the start of a build or a change empties the exec notes a past run never read. A fix round keeps them, so a
  note sent just after a run's last tool call still reaches the same build's next run.

### 3. The build room shows all of it

From the bridge log: agent messages and reasoning summaries, tool calls with their outcome, a live agent tree
(subagents with their paths and status, workflows with phase and children), observer runs, hook runs, the goal with
its status and progress, the todo list, compaction, and owner commands. Questions the agent asks show as a card with
their options.

### 4. The owner steers

While a build runs, its owner can: send a note now (steer) or after this turn (queue), stop the turn, end the run,
edit, pause or resume the goal, pause or cancel a workflow, message or stop a subagent, and answer a question. Routes
check the owner as the messages route does (a Question card opens for whoever may steer, `canSteer`, the route's own
test), write the command into the mailbox (`MuseCommandEnvelope`), and add a
`control` build event. Words the owner writes (a note, a goal, a subagent message, a typed answer) pass the same
change check as a refinement first (`lib/brief/policy.ts`), charged to the build, and nothing goes when it refuses or
can't answer. On the exec engine, notes travel through the PostToolUse hook instead, and stop kills the run.

### 5. Every product as an MCP server, a CLI, a skill and a connector (phase 3)

All generated by the platform from the product's `musemuse.json` actions after the build passes: the MCP server and
Muse connector at `/api/mcp/<slug>` (exists; add read-only annotations and tests), a skill file at
`/p/<slug>/skill.md`, one `musemuse` CLI served from the site (npm later, with the owner's OK), a "Use it anywhere"
panel, and a "Prove it" stage that tests each and records a Demo Studio video of each working.

### 6. Accounting

Every child's spend is charged: `workflow_child` and reminders that run inside subagent logs are counted (by
`usage_id`, once), not only `native_child`, under the `muse exec children` or `muse serve children` endpoint. The
session log also gives an `unreported` group: the main agent's calls in runs with no `run.usage` (a run stopped at its
cap, and every session bridge round, which never writes one). It is charged under the round's own endpoint, so a run
that wrote `run.usage` is never charged twice (`parseSessionUsage` in `lib/sandbox/muse-log.ts`). A round's engine,
and under MUSE_FULL its capacity, show as a build room line (`museRunLine`); the build row doesn't store them yet.
That line and the agent's `build_note` lines stay in the build room: the public product page leaves them out
(`buildHighlights`).

A session bridge round whose session log can't be read, or has none of its main agent's calls, is charged from the
`session/tokenUsage` tallies in its condenser state (`bridgeTokenUsage`), with a build room line saying so. Those tallies
are the main session's stream, so children are charged only when the session log can be read.

**This accounting also changes plain `muse exec` builds, with both flags off.** Against `tuned-model-options`:
`workflow_child` calls and `reminder_child` calls inside child logs now count, and every `run.usage` in a round is charged
rather than only the first poll's, so `costUsd`, the room's cost line and the spend cap all read higher on a build that
uses workflows, subagents with reminders, or a second run. The room also says `Muse Code started a workflow: X` where it
showed the workflow tool's raw first line. The old numbers undercharged real spend, so this is kept for now, but it is the
one known break from flags-off parity (see the open checks).

## Build order and flags

1. **Engine, config, accounting** (`MUSE_ENGINE`, default `exec`; `MUSE_FULL=1` turns on the settings, hooks and MCP;
   `MUSE_AGENT_CAPACITY` sizes the agents under it).
2. **Build room and steering** on top of it. Steering is on when either flag is (`env.steeringEnabled`), and needs
   migration `0012_build_controls` (`builds.muse_round`, `builds.stop_requested`).
3. **Test builds** on a dry-run copy, then real builds within the $100 test budget, comparing cost, time and judge
   score against today's engine.
4. **Product outputs and Prove it.**

## Open checks

Merged on Oct 31 with tests, the typecheck and the workflow compile check passing, but no sandbox run yet:

- **Flags-off accounting (Ethan's call).** Section 6 says what changes on plain exec. To restore strict parity instead:
  a `legacy` option on `parseSessionUsage` with `CHILD_OWNERS = {native_child}` and no child-log `reminder_child`, the
  `!input.usageRecorded` gates back in `pollMuseStep`, last-run-wins in `condenseMuseLines`, and no `workflowText`, all
  when `engine === "exec" && !env.museFull`.
- **A real round on `serve`.** Nothing has run the bridge since the Oct 30 spike: a build, a fix round and a change, with
  the condenser state carried between polls (at most 200 open items, 256 KB of them, and 32 announced keys in each step's
  result; an open agent message or reasoning line shows its first 8,000 characters until it finishes). That run also
  checks that session log run ids match the turn ids the bridge logs: if they don't, every serve round is charged from
  the session host's tallies, with its children left out.
- **Questions can't come yet.** The bridge always passes `--disable-request-user-input` (`disableRequestUserInput:
  true` in `startBridge`), so Muse Code never asks and the Question card and the `answer` action go unused. Turning it
  on for steerable rounds needs a check of what a round waiting on an answer does to the poll and the step cap.
- **The goal line on a fallback.** The prompt says the goal is set whenever `MUSE_ENGINE=serve`, decided when the
  prompt is written. A round whose bridge can't start runs on exec with no goal, and a product with no brief at all
  gets none either, so `get_goal` shows nothing there.
- **Controls with no UI.** The steer box sends notes, queued notes and stop, and the Question card sends answers. Goal,
  workflow and subagent commands work only through the route. On exec they are refused and come back 502
  `not_delivered`, worded as if Muse Code couldn't be reached.
- **Engine on the build row.** The control route reads the per-round engine file (one sandbox read per command). If
  that shows up as latency, store the engine next to `muse_round`.
- **Test builds** (step 3 above): cost, time and judge score on `serve` and on MUSE_FULL against today's exec.

Spend so far on this work: about $0.10 of model calls and a few cents of sandbox time (the Oct 30 spike).
