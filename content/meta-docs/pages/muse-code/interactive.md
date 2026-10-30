# Working with the agent {#working-with-the-agent}

The interactive session is where you drive Muse Code. Run `muse` in a project and you get a terminal UI: type a prompt to start a turn, watch the agent work, and steer it with **slash commands**. This page covers the commands and shortcuts you use most.

To run one prompt to completion without a UI, see [headless and CI](https://dev.meta.ai/docs/muse-code/extending#headless).

## Slash commands {#slash-commands}

Type `/` in the composer to open the command palette. Keep typing to filter. Every command on this page is built in; run `/help` to see the full set in your workspace, and `/keymap` for keyboard shortcuts.

A command is either **safe to run mid-turn** or **held until the turn ends**. The UI tells you which when a run is active. A few commands are unavailable inside a [side conversation](https://dev.meta.ai/docs/muse-code/interactive#side-chats), and say so when you try them.

## Steer a running turn {#steering}

You don't have to wait for the agent to finish. While a turn is running:

- **`Enter` (steer)**: submit text to *inject into the turn in progress*. The agent applies it on its next step.
- **`Alt+Enter` (queue)**: hold your text for the *next* turn instead of the current one.
- **`Esc` (interrupt)**: cancel the current turn. `Esc` stops the turn only. It does **not** stop [background terminals](https://dev.meta.ai/docs/muse-code/interactive#stop) or subagents.
- **`Esc` on an empty composer (retract)**: pull the most recently queued instruction back into the composer to edit or drop it. Repeat to retract older ones. Only the newest eligible item is retractable at a time.

`Ctrl+C` also interrupts, but only from an empty composer. With text in the composer, it clears the input instead.

> **NOTE: Esc and /stop differ**
>
> If you interrupt a turn while background work is still running, Muse Code sets a reminder to run [`/stop`](https://dev.meta.ai/docs/muse-code/interactive#stop). These are two separate actions: `Esc` interrupts the turn, and `/stop` stops background processes.

## Manage the session {#sessions}

Each run is an append-only event log (see [how sessions work](https://dev.meta.ai/docs/muse-code/interactive#session-model)). These commands start, switch, and branch sessions:

```
/new       # start a fresh session, keep the terminal scrollback
/clear     # start a fresh session and wipe the scrollback
/name      # show or rename this session
/resume    # pick a retained session to resume (this workspace)
/resume --last   # resume the most recent session in this workspace
/fork      # branch a new session from the current point
```

- **`/new` vs `/clear`**: both begin a new session. The conversation, in-session context, token counts, goal, and tasks all reset. The only difference is your terminal scrollback: `/new` keeps it on screen, and `/clear` clears it. Neither changes on-disk [memory or rules](https://dev.meta.ai/docs/muse-code/configuration#local-memory).
- **`/name`**: shows the current session name or assigns one with `/name <name>`. A stable name lets other live sessions find this one through [session messaging](https://dev.meta.ai/docs/muse-code/session-messaging).
- **`/resume`**: reopens a retained session and continues it. Resume is scoped to the current workspace and relaunches the session rather than swapping it in place, so expect a brief transition.
- **`/fork`**: branches a *new* session from the current session's latest stable point. The source session stays active and unchanged, and the fork doesn't take over your view. Continue the fork later with `muse resume <fork-id>`.

To branch from an earlier user message, run `/rewind` or press `Esc` twice from an idle, empty composer. See [rewind a conversation](https://dev.meta.ai/docs/muse-code/rewind). Rewind restores the selected message as an unsent draft in a new retained session and leaves workspace files unchanged.

To keep independent sessions active at the same time, start Muse Code in separate terminals. See [run sessions in parallel](https://dev.meta.ai/docs/muse-code/session-messaging#parallel-sessions) for workspace and worktree guidance.

## Side conversations {#side-chats}

Start a short parallel conversation without a change to the main thread:

```
/side              # open a side conversation
/side <prompt>     # open one and send the first message
/btw <prompt>      # alias for /side
```

Muse Code seeds a side conversation from the main session's history, but runs it as its own thread. It snapshots your main transcript and any in-flight run, and sets them aside. Press `Ctrl+C` to return to the main thread. Muse Code restores it exactly, including a run that finished while you were away.

You can have one side conversation open at a time. While you're in it, `/side`, `/fork`, `/new`, `/clear`, and `/resume` are unavailable. Return to the main chat first. `/copy` works and copies the side transcript.

## Control the context {#context}

These commands manage what the model sees and let you save what it produced:

```
/compact            # summarize prior context to reclaim room
/recap              # show a summary of recent activity
/export transcript  # write the on-screen conversation to a .txt
/export trajectory  # write the full session log to JSON
/copy               # copy the last response to the clipboard
```

- **`/compact`** replaces earlier model-visible history with an LLM-generated summary to reclaim context room. It's **lossy** for the model's context (summarized, not verbatim), but does **not** clear your on-screen scrollback. Muse Code also compacts automatically when context fills. A manual `/compact` never counts against the auto-compaction budget. Compaction fires the [`PreCompact` and `PostCompact` hooks](https://dev.meta.ai/docs/muse-code/extending#hook-events).
- **`/recap`** renders a short summary of what happened since the last recap, which is useful after you step away. It needs new activity to summarize, and runs between turns, not during one. Muse Code also shows a recap automatically when you come back after 2 minutes away, once the session has at least 2 of your messages. If a run is still going when you come back, the recap appears when that run finishes. A recap is a summary cell only. It doesn't change the model's context.
- **`/export`** saves a session two ways: `transcript` writes a human-readable `conversation-<stamp>.txt` of the on-screen conversation, and `trajectory` writes the full session log as JSON (the same document the [`muse export`](https://dev.meta.ai/docs/muse-code/extending#headless) CLI produces for the current session). Bare `/export` opens a chooser. Add `--out <path>` to pick a location and `--redacted` to scrub secret-shaped strings.
- **`/copy`** copies the markdown of the last completed response to your clipboard.

## Goals and long-running loops {#goals-loops}

For work that spans many turns, set a **goal**, and Muse Code holds the agent to it:

```
/goal <objective>       # set the session goal
/goal                   # show the current goal
/goal edit <objective>  # revise it
/goal pause             # pause goal tracking
/goal resume            # resume it
/goal clear             # drop the goal
```

With a goal set, the runtime keeps the agent working toward it. After a turn finishes, the runtime queues a follow-up to continue unfinished work, and it prompts the agent to `report_progress` if the agent goes about 10 model steps without one. The goal reminder also holds the agent to a requirement-by-requirement completion check before it declares the goal done. When you interrupt a turn with `Esc`, Muse Code automatically pauses an unfinished goal, and `/goal resume` restarts it.

To run something on a schedule, use **`/loop`**:

```
/loop 10m /run-tests          # every 10 minutes, run the /run-tests skill
/loop "0 9 * * 1-5" standup   # weekdays at 9am (5-field cron)
```

`/loop` schedules a recurring prompt as a cron job. It accepts a shorthand interval (`5m`, `1h`, `2d`) or a full 5-field cron expression (`minute hour day-of-month month day-of-week`, local time). With no cadence, it defaults to every 10 minutes. The bundled command creates recurring jobs with `fire_when_active_run: false`. An occurrence that lands during an active run is skipped, and the job remains scheduled for its next eligible occurrence. Skipped occurrences are not queued or replayed. Recurring jobs auto-expire after 7 days. A scheduled prompt can be a plain instruction or a `/skill` invocation, and Muse Code passes it through verbatim.

> **NOTE: Loops use the cron tools**
>
> There is no dedicated loop-monitor panel. A loop is an ordinary scheduled job the agent manages with its cron tools. Pair it with a `/goal` if you want the runtime to hold progress to a defined outcome.

## Track background tasks {#tasks}

When the agent runs work in the background, such as long shell commands or monitors, you manage it through the Tasks surface:

```
/tasks      # open the Tasks drawer
/subagents  # view running and past subagents
/stop       # stop applicable background work
```

- **`/tasks`** opens a drawer for background tasks and direct subagents, with controls for the selected row.
- **`/subagents`** opens the subagent view for running and completed descendants.

### `/stop` {#stop}

Cancels applicable background tasks and terminals. It does not blanket-cancel direct subagents; manage those through `/tasks`. This is different from `Esc`, which only ends the current turn.

## Monitor workflows {#workflows}

When workflows are available, run `/workflows` to browse active and completed multi-agent workflow runs. The control room shows phases, child-agent progress, elapsed time, token usage, errors, and final results. You can pause, resume, cancel, skip, or restart a selected running child.

See [run multi-agent workflows](https://dev.meta.ai/docs/muse-code/workflows) for starting a workflow, writing reusable workflow scripts, and using the control-room keys.

## When the agent asks you a question {#clarify}

Sometimes the agent needs a decision it can't infer from the workspace. It pauses the turn and shows a short set of **clarifying questions**: one to three, each with a few options, single- or multi-select. Pick with the number keys, `Space` toggles a multi-select option, `Tab` adds an optional free-text note, `←/→` moves between questions, and `Enter` submits after a review step. `Esc` interrupts instead of an answer.

Your answers are conversational input that steer the next steps. They don't grant the agent any filesystem, shell, network, or approval authority. The agent asks only when the answer changes what it does next. It won't stop to ask about things it can verify itself, or about conventional defaults.

To have the agent produce a plan and stop for your approval before it builds, invoke the built-in `/plan` skill (see [skills](https://dev.meta.ai/docs/muse-code/extending#skills)).

## Voice input {#voice}

Dictate rather than type. Press `Alt+V` (`option-V` on macOS) to start or stop voice input. Muse Code transcribes your speech into the composer, and `Enter` submits it like any other text.

```
/voice status   # show voice status
/voice debug    # toggle voice diagnostics
```

Voice is enabled by default on macOS, off by default on Linux, and unavailable on Windows. `/voice` inspects state only. Turn voice on or off in [`/settings`](https://dev.meta.ai/docs/muse-code/configuration#settings-file), not with `/voice on`.

## Attach and reference images {#images}

Paste or drop an image into the composer and Muse Code gives it an `[Image #N]` label the model can see. Refer to an image by its number, such as "what's the error in `[Image #2]`?", and the agent knows which one you mean. The labels and their source paths survive [resume and fork](https://dev.meta.ai/docs/muse-code/interactive#sessions), and [rewind](https://dev.meta.ai/docs/muse-code/rewind).

## See the agent's reasoning {#reasoning}

While the agent works, Muse Code shows a live one-line **reasoning summary** in the status row (on by default). To commit the model's full reasoning into your transcript, turn on `show_reasoning` in [settings](https://dev.meta.ai/docs/muse-code/configuration#settings-file). It's off by default and independent of the summary line. [Reasoning effort](https://dev.meta.ai/docs/muse-code/configuration#reasoning-effort) governs how much reasoning the model produces (`--reasoning-effort` or `/effort`).

## How sessions work {#session-model}

Muse Code records every run as an append-only event log: model calls, tool calls and their results, and approval decisions. Because the session is event-sourced, an interrupted or crashed run replays cleanly on [`/resume`](https://dev.meta.ai/docs/muse-code/interactive#sessions). It rebuilds the conversation, closes the interrupted turn, and continues.

> **WARNING: Verify resumed destructive steps**
>
> Treat a resumed destructive step as "verify, then continue." Resume does **not** de-duplicate work that was in flight. Muse Code records a side effect interrupted mid-execution (for example a `write_file` that partially landed) with an **unknown** outcome, and tells the agent to verify the actual state before it retries.

The same log powers [`/export trajectory`](https://dev.meta.ai/docs/muse-code/interactive#context) and post-hoc inspection with `muse trace inspect`. Use `muse --no-session-log` for an interactive session without a retained log, or `muse exec --no-session-log` for a headless run. This forfeits resume, trajectory export and reattach, automatic retained-session naming and peer messaging, and retained workflow recovery (see [headless and CI](https://dev.meta.ai/docs/muse-code/extending#headless)).

## Next steps {#next-steps}

- Set defaults, models, and project context in [configuration and context](https://dev.meta.ai/docs/muse-code/configuration).
- Understand the guardrails these commands run under in [permissions and safety](https://dev.meta.ai/docs/muse-code/permissions).
- Run structured parallel work with [workflows](https://dev.meta.ai/docs/muse-code/workflows).
- Coordinate separate live agents with [session messaging](https://dev.meta.ai/docs/muse-code/session-messaging).
