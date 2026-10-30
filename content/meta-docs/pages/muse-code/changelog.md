# Changelog {#changelog}

What's new, improved, and fixed in each Muse Code release. For install and upgrade steps, see the [Muse Code overview](https://dev.meta.ai/docs/muse-code).

## 1.4.13 {#v1-4-13}

### New {#new}

- On macOS and Linux, permission profiles extending `:ask-me` with filesystem `deny` rules now enforce them: workspace-root deny globs (`**/*.pem`) and absolute/`~/` denies refuse matching reads and writes, and sandboxed shell access to matching paths that exist when each shell command starts (files created mid-command under a deny glob are not covered on Linux — macOS enforces globs live through Seatbelt regex with no snapshot window; a deny on a not-yet-existing path is masked at its first missing component), instead of being silently ignored, while the profile keeps its write grants elsewhere
- `muse usage` shows your subscription allowance (window and weekly use, reset times, tier) without running a model turn; `muse exec --json` reads it too when the run saw no usage update
- Desktop and other connected clients offer the same third-party models as the terminal model picker
- Added a built-in `visual-coding` skill: for a 3D page, a browser game or Blender work, it points the agent to the one built-in skill that owns that kind of work before any code is written, so one request no longer runs two competing build processes
- Warnings near your usage limit show the remaining allowance and reset time above the message queue

### Improvements {#improvements}

- `/game-3d-visuals` now runs its plan, build and review as three steps and posts a one-line result to the todo list after each
- When cleanup after a finished turn keeps failing (goal accounting or the live turn state), the chat now shows one "cleanup failed after this turn" warning naming what gave up, instead of failing silently. It shows right after that turn, or the next time you open the chat if you have already moved on to another turn (in the rare case that the warning itself could not be saved, it shows only while you are still on that turn)
- `--yolo` keeps the `request_user_input` question tool and enables async questions instead of withholding them; pass `--disable-request-user-input` for runs that should ask nothing

### Fixes {#fixes}

- **Security:** Sessions in untrusted workspaces no longer receive project rules recorded by an earlier trusted session
- **Security:** Session worktree recovery now enforces the same protected paths as the rest of the session
- **Security:** Served sessions in workspaces you have not trusted no longer run workspace status checks or Sapling snapshots, and sessions that never establish trust now fail closed instead of inheriting trusted behavior
- **Security:** When `muse serve` resumes, forks or opens a side chat from a chat whose saved history lost a permission change, the chat no longer reopens with older, wider permissions: it resets to your defaults, keeps your saved settings when they were stricter, or switches to read-only when the two cannot be safely combined, and "allow for this session" approvals given before the loss stop applying. A permission profile you choose when resuming such a chat applies after the reset, or in its place when the reset is not allowed. When no safe reset exists, or managed policy forbids it, the chat refuses and asks you to start a new chat
- A chat whose tool result could not be saved (for example on a full disk) can compact again right away, and after a restart that turn is kept with the result shown as lost, instead of disappearing
- Notes sent to a subagent over a remote session keep their plain summary
- Removing a queued message with `turn/unqueue` now works when the message is waiting behind an internal turn, instead of failing with `missing_run` and running the message anyway
- Session names you gave earlier show up again in the session list and work with `muse resume <name>`, read from each session's own history
- `/feedback` uploads with a very large session record no longer fail; the record is shortened to fit and the shortening is noted
- When a chat's file could not be read while loading it for a save (a brief I/O error), the chat goes back to saving its progress once the read works again, instead of staying unable to save until restart
- Stopping messages say whether a workflow or a background command was stopped
- Long `/goal` sessions save their resume checkpoints again, so they stay compact and resume quickly instead of slowing down after every compaction
- A forked chat where the start of one of its own turns could not be written to disk keeps working after it compacts and is reopened; that turn stays left out, and Muse says so once per reopen
- A chat that messaged a subagent and then ran several tools at once no longer stops saving checkpoints for the rest of the session
- Fixed automatic compaction losing Monitor messages after a model response ended early
- A prompt that looks like a session-message envelope no longer stops later sessions from saving resume checkpoints
- A forked chat where the start of one of its own turns could not be written to disk (for example on a full disk) saves checkpoints again after a restart; that turn is left out, and Muse says so once
- After a subagent message or other background record could not be saved to a full disk, compaction checkpoints work again without restarting the chat
- `session/leave` with `stop: true` no longer releases a session while one of its workflows cannot be stopped (its stop record is in conflict); the leave fails and the session stays with its host, including when you retry it with a new command id; until the host process restarts, such a leave keeps failing (a known limitation)
- The todo list now stays on screen while a background workflow is still running, instead of disappearing as soon as the turn that launched it ends
- Notes waiting on a busy subagent now show Queued rows while they wait
- After a brief storage error in the middle of a task, the chat goes back to saving its progress at the next checkpoint once the error clears, instead of waiting for the task's next tool call or its end
- After a brief disk error interrupts one background save, the chat goes back to saving its progress once the error clears, also when the save had fully reached the disk or belonged to a side chat
- Loading a forked chat in the app or another client, where the start of one of its own turns could not be written to disk, no longer blocks its checkpoints; that turn is left out, and Muse says so once
- A chat forked from a compacted chat, where the start of one of its own turns could not be written to disk, can be reopened and continued; that turn is left out, and Muse says so once
- A compaction that runs while a background task's save is still unconfirmed now saves its checkpoint (keeping the older history until the task's save resolves) instead of skipping it
- The `game-3d-visuals` skill now names each of its pipeline runs, so its first launch is no longer refused and retried
- Usage limit stops explain when you can continue, and denied requests retain useful error details
- Pausing a Workflow that has just finished now reports that it already finished and shows its result, instead of leaving the Workflow paused with no result
- The peer message timeline no longer shows as unavailable after a session accepts a message automatically

### Performance {#performance}

- Context that hooks add after a prompt or tool call now stays in the conversation where it arrived, so a new hook rule no longer makes the whole conversation re-process on the next model call
- Reduce repeated session-log bookkeeping while disk writes are failing
- Starting the app or `muse serve` while other sessions are running uses much less memory, because listing sessions no longer keeps a full copy of each running session's history

## 1.4.12 {#v1-4-12}

### New {#new-1}

- Added a built-in `browser-game` skill for building playable browser games from a brief: it sizes the work to the request, plays the game with real input before handoff, and for a long design document runs up to three rounds in which a fresh critic plays a copy of the game against a checklist and the brief's rules, fixing what each round finds
- Permission profiles can open chosen local development ports to sandboxed commands with `network.local_ports` (`allow`, `ask`, or `deny` per port); `ask` prompts for each connection on Linux and once per session on macOS; a loopback entry in `network.targets` is now rejected, so move it to `network.local_ports`; an older Muse build cannot open a chat that saved local-port rules or a managed local-port limit, so update the app to open it (other chats are unaffected)
- Choose a run preset when starting a session host with `muse serve --preset`

### Improvements {#improvements-1}

- After you allow a network request once, the same non-interactive command's later requests to that exact host, port, and protocol no longer ask you again while it runs
- Chats containing saved continuations of finished subagents require a compatible app update; older versions cannot read them
- Better guidance for carrying research findings and notes into final reports
- An older Muse build cannot open a chat whose permissions were reset because part of its saved permission history was lost or damaged; update the app to open it (other chats are unaffected)
- `/game-3d-visuals` finishes in about half the time: it skips the separate visual-plan review and runs one render-vs-reference fix round by default
- Tiny text, style, or config changes, throwaway prototypes, one-file scripts or pages, and requests for a quick result no longer start by writing a failing test; other fixes run the broad test suite once after the last edit and post a status line during long test runs

### Fixes {#fixes-1}

- **Security:** Deny rules now cover paths that do not exist yet in sandboxed shell commands, blocking their creation without leaving anything behind
- **Security:** Shell and file tools refuse a workspace root that no longer resolves to its recorded location instead of following it to a new target
- **Security:** The Sapling commands the harness runs for you (workspace snapshots, session worktrees) now run inside the sandbox instead of directly on your machine, and session worktrees refuse to run Sapling in a workspace you have not trusted
- Shell commands can write under every workspace root a session protocol client grants with `workspaceRoots`, not only the primary root
- Startup warns again when the configured Bubblewrap path is unusable instead of hiding the sandbox-unavailable notice
- When a Workflow pause or stop keeps an agent call from starting, its Recovery line and its failed row now say so instead of calling it an internal error and asking for a `/feedback` report
- A chat whose tool call could not be written to disk (for example on a full disk) while its result was written can now be forked or given a side chat after a later checkpoint, instead of the fork failing
- A Workflow agent call whose Agent Definition asks for a model this session doesn't offer now runs on the session's model instead of failing, and the main agent tells you which calls ran on which model
- After a `session/leave` times out, reading that session on the same host works again once its runtime has stopped; until then the read reports that the session is still stopping
- A `session/leave` whose accepted reply cannot reach the client now fails at its deadline, instead of holding the session until the connection closes
- The TUI refreshes the model catalog once in the background when the chosen model is missing from the cache, instead of starting a second refresh
- Pending approvals and questions in `muse serve --no-session-log` sessions stay readable after the agent starts a subagent
- `session/leave` with `stop: true` now stops a running workflow before it hands the session over, so resuming the session no longer offers to recover the workflow you stopped
- Subagent crash recovery reports missing tool results as unknown without automatically rerunning the calls
- Over `muse serve`, resending a finished turn's `turn/start` with the same command id after a restart returns its original reply instead of a command id conflict
- When a finished reply or a subagent result cannot be saved, Muse retries briefly, then shows a clear error that says why new messages are refused instead of retrying silently every second
- `/permissions` now names why a permission change could not be saved
- When a sandboxed shell command fails writing outside the session's writable roots (for example a cache under the home directory failing with `Read-only file system`), the failure now explains that the sandbox blocked it and names the `workspace_roots` grant, a one-time unsandboxed run, and workspace-or-`/tmp` cache options, instead of the raw filesystem error
- In the terminal app, a chat where the start of one turn could not be written to disk (for example on a full disk) no longer loses every later checkpoint after a restart; that turn is set aside, and Muse says so once
- Sessions wake once the blocking run settles after a background task finishes while the session is busy
- Rewinding to before a turn that failed, or whose end could not be saved (for example on a full disk), now works instead of every attempt being refused, and a turn that can never be rewound is shown as unavailable instead of offered
- Opening a subagent's detail view now loads the child's transcript from the child's own session and keeps it live while open
- Keep long requests running with their full context when compaction fails
- When a Workflow pause or stop keeps an agent call from starting, its Recovery line and its failed row now end with what you can do: "Start the Workflow again if it is still needed."
- On EdenFS checkouts, `sl` and `hg` commands need the launcher (sandbox disabled) to reach Eden state; the native sandbox no longer grants Eden filesystem or socket access
- Rewinding to a turn after one that was still running when the chat saved a checkpoint now works, instead of every such rewind being refused after you confirm it
- Goal sessions waiting on external work wait on a change watcher instead of appearing stopped
- Stopping background work from a notification now works instead of reporting it was not found
- A chat that lost two saves in one turn on a full disk (a tool result, then the next tool call) can be reopened again; the affected turn is set aside instead of blocking the whole chat
- A prompt sent while the session view is stale-idle steers into the active background delivery over the session protocol instead of starting a duplicate fresh run
- `/game-3d-visuals` now starts on its own only for polished 3D work (a reference image, Blender, or an explicit high-fidelity ask); quick 3D pages and games are built directly instead of waiting on its multi-agent pipeline
- Rewinding to a turn after the conversation was compacted now works, instead of every such rewind being refused
- Keep interrupted startup from leaving a partially created session
- A subagent stop that was interrupted right after it took effect no longer leaves that subagent stuck: the next open completes the stop's record, and if that record cannot be written the session still opens and the next open retries
- Startup fails with a clear error when the configured Linux sandbox helper path is unusable instead of silently starting unsandboxed
- After a crash, a message you sent to replace Muse's current reply, or one Muse showed as queued while it was busy, is no longer treated as done: retrying it now says it was abandoned instead of claiming it already ran
- Apps built on the Muse SDKs now see the new turn a Replace starts as the running turn (the session snapshot's `activeTurn`) instead of no running turn
- In apps that open chats through the Muse session server, a chat where the start of one turn could not be written to disk (for example on a full disk) no longer loses later checkpoints after it is reopened; that turn is set aside, and Muse says so once
- Fork and side chat no longer fail with an internal error when the system is under load
- Forking a session at an earlier turn keeps exactly the turns up to that turn instead of refusing the cut (some compacted sessions and forks of forks still refuse the cut or fork from a later turn, and a cut that keeps no turns of an older session still refuses while that session is open)
- After a reply or an ordinary tool result could not be saved to a full disk, compaction checkpoints work again without restarting the chat
- Fixed degraded session recovery losing the latest workspace root set
- After a mid-reply compaction, the TUI no longer fires a needless second auto-compaction on the stale Blocked pressure reading
- Hooks set with `muse serve -c hooks.…` now run in served sessions instead of being silently dropped
- `pip install muse-code-sdk` now also installs its companion wire-types package, so `import muse_code` works in a fresh Python environment
- When one write to a side chat's file fails (for example on a full disk), the main chat keeps saving its progress and can still be forked once the problem clears, instead of staying unable to save until restart
- The first manual compaction in a side chat now works, including after resuming it
- A user review gate now explicitly defers outward-facing actions until post-inspection approval, so bounded steps stop instead of running ahead into tracker and chat writes
- Idle sessions reliably wake when a background task finishes
- `/plan` on a small change now plans instead of implementing it — the skill keys the explicit case on how its body arrived, so implement-shaped task text is read as the planning subject, not an implement request
- With MCP servers configured, using `/side` before your first message (for example right after resuming) no longer stops every later message before it reaches the model; a side chat you open with `/side` now runs without MCP tools
- A chat whose Workflow result could not be saved (for example on a full disk) and that then ran another tool now reopens in the same app session after a restart, instead of failing to open
- When a write to a background helper session's file fails once (for example on a full disk) right after it starts, its later writes and checkpoints go through once the problem clears, instead of staying refused until restart
- Older builds keep reading durable session records after a newer build adds a member, instead of failing the whole session read
- A workflow that ended after its durable fact write failed no longer stays listed as running forever in the bottom work list; its row now shows the failed or cancelled result and clears after the usual grace
- On macOS, Muse Code no longer freezes when the Keychain stops answering: it stops waiting after 5 seconds and says your login is still saved, and `muse --help` no longer waits on the Keychain
- A sandboxed shell command killed mid-run no longer breaks the next command with the same deny rules; its leftover empty placeholder is now cleaned up automatically
- Notes sent to a running subagent now show a Delivered row once the child picks them up
- After a full disk, starting a new chat no longer retries the previous chat's unsaved run ending in the new chat
- When a brief storage failure, such as a full disk, keeps the session log from saving a new Workflow agent call's start even after its one retry, only that call now fails, with a plain reason, and the rest of the Workflow keeps running; before, the whole Workflow ended
- A chat where the start of one turn could not be written to disk (for example on a full disk) can be forked and can open a side chat again; the new chat leaves out that one turn, and Muse says so once
- If a Workflow subagent switches model or has a wake-up refused and you cancel your next turn before it starts, the turn after it still tells you about it
- On an ephemeral `muse serve` host, replaying the original `session/start` of a session that `session/leave` released now answers the original acknowledgement without bringing the removed session back
- After a full disk cancelled a workflow run, a later background result on that run no longer stops checkpoints until a restart
- Failed `/feedback` uploads now show the reason returned by the server instead of only the status code
- When a chat is stuck retrying a save that failed, `/new`, `/clear` and other new sessions from it, local-model setup and a provider key swap now fail at once with the "saving failed … retrying automatically" message instead of waiting quietly or saving a rejection, and the same command works once the chat recovers
- Sessions served by `muse serve` that use a goal keep saving context checkpoints, so they resume quickly again
- A chat where the start of one turn could not be written to disk (for example on a full disk) can be rewound again; the rewind leaves out that one turn, and Muse says so once
- Workflow guidance keeps large-result details ahead of lengthy research notes
- When a background save to the chat file is cut short by a brief I/O error and never retried, the chat goes back to saving its progress once the problem clears, instead of staying unable to save until restart
- Resume and history show the finished marker for background terminal completions served over the session protocol, matching the live view
- A `muse serve` chat whose saved view on disk is damaged or unreadable (for example a torn `HEAD.json`, a missing journal file, or history a newer build wrote) is rebuilt from its session log while it is being resumed, so that resume shows the whole history instead of no history, and the chat never needs reopening
- Reminder checks no longer repeat after their decision when a Stop or PreToolUse hook blocks them
- Side chats retain the original conversation after a checkpoint
- A forked chat where the start of one of its own turns could not be written to disk (for example on a full disk) can be reopened and continued again; that turn is left out, and Muse says so once
- When one save to the chat file fails because the file could not be opened or read (a brief I/O error), the chat goes back to saving its progress as soon as the problem clears, instead of staying unable to save until restart
- Forking a session over the session protocol no longer intermittently reports the new session is already in use
- Quitting the TUI no longer prints internal cleanup or shutdown diagnostics to the terminal; they now go to the local diagnostic log
- Worktree creation and cleanup stay sandboxed in unprivileged containers, using an empty read-only process view where the container refuses a fresh one
- After a one-time storage error leaves a background task's save unconfirmed, the session's periodic context checkpoints keep landing instead of being refused until restart
- A tool result or other chat record whose save failed while the disk was full is saved again at the session's next step if there is room by then, so a restart after that keeps it
- A chat that was never compacted and whose saved log has an unreadable or missing line in the middle now opens for reading in apps that use the session protocol, showing everything that can be read with a notice at the spot, instead of refusing the whole chat; continuing or forking such a chat is still refused for now
- When another agent's start could not be confirmed as saved just as a Workflow starts a new agent call, that call now fails on its own with a plain reason; while session storage is still failing, the Workflow still stops at its next save
- When saving a checkpoint is interrupted twice in a row by a brief I/O error, the chat (and a reminder helper) now cleans up the half-written save and keeps saving its progress once the problem clears, instead of staying unable to save until it is reopened
- Resumed sessions exit after the run finishes instead of hanging when an earlier denied tool approval predates the session's latest checkpoint
- When the same configuration, environment or step-limit error stops two turns back to back with nothing shown between them, it now appears once while the session runs, as it already does after a resume

### Performance {#performance-1}

- In `muse serve`, leaving a session and shutting the host down no longer reread the whole chat history to report its final position
- Long sessions store repeated setup blocks once, so logs stay small and resume loads faster

## 1.4.11 {#v1-4-11}

### New {#new-2}

- Added `session/leave` to the session protocol, so a client can hand one loaded session to another host while this host and its other sessions keep running
- Added a built-in `web3d` skill that guides building single-file 3D web pages and browser games and checking them in a browser before handoff
- The TypeScript and Python SDKs can answer the agent's questions with `Session.answerUserInput` and `Session.answer_user_input`, including a question still open when a session is resumed
- Agent plugins can supply MCP servers with per-server review and `muse mcp login` sign-in
- The TypeScript and Python SDKs accept an approval handler and an approval-failure observer when resuming a session, so an approval still pending at resume reaches the handler and any failure reaches the observer
- `muse exec --json` prints a `run.usage` line before each run ends, with the run's token usage per model and your subscription allowance
- `muse serve` reads three environment settings for its worker threads, command admission capacity, and loaded-session ceiling; an invalid value is reported and the production value is used
- Added `/game-3d-visuals` to drive 3D models and games from reference images, a visual spec, and a render-vs-reference acceptance loop

### Improvements {#improvements-2}

- Workflow agents receive source and field labels when reading saved results
- `/blender` now handles general 3D work in Blender, including object modeling, scene recreation from an image, animation and large environments, and ships helper scripts that work on Blender 4 and 5
- The built-in `web3d` skill now plans each part's shape, surroundings and materials before building, and after the first working build a fresh tester subagent plays the page and writes a critique that must be closed before delivery, with a time guard on review rounds
- ParallelGroup refusals now name the members argument and the .defer correction instead of a generic plain-data error or an internal agent identifier
- Terminals that support program status reports (OSC 7501) now also show each monitor and background terminal a session is running
- `/blender` can now measure a render against its reference image and check animations frame by frame for pops, sinking and objects leaving the shot, and keeps more refraction bounces so stacked glass renders less dark
- Terminals that support program status reports (OSC 7501) now also show each workflow, subagent and background follow-up turn a session is running, and which one is waiting for you
- Network approval prompts now start on "Yes, don't ask again this session" for that exact host and port, so pressing Enter stops the same destination from asking again
- Auto-review no longer hands you every request to a local server on `localhost` or `127.0.0.1` just because of its address or port; it reviews them like any other action
- Video file reads guide local frame extraction without uploading the video
- The queued input panel says when message updates fail and that your input still works

### Fixes {#fixes-2}

- Resuming a session after a checkpoint prune no longer loses MCP tool identity bindings for servers that contribute no tools in the new generation
- A Workflow subagent that names the model your session is running now runs even when that model is hidden or missing from the model list, the same as leaving the model out
- Avoid repeated table-formatting skill loads within a conversation
- Side chats now record their attempts on the source session instead of dropping them, matching gate-off; a contended side still opens and a retry backfills or joins the prior outcome
- When a context checkpoint could not be saved during a compaction, the next turn now saves it without another summary, so reopening a long session is fast again
- Resuming a Workflow after a crash no longer reruns parallel subagents that had already finished at different times, or warns that the saved recovery state was not trustworthy, unless a subagent started before them was still running at the crash
- Service and loop restarts verify every process against an ownership record before stopping it, so look-alike sessions are left running
- After Muse restarts from a crash, a subagent the agent started directly (not from a workflow) that had not started running yet is no longer started again by itself; its parent gets one result saying the outcome is unknown, so it can check and start the subagent again if still needed
- Resuming a session stays fast after a side chat was mid-tool during a compaction, or after a cancelled workflow tool could not be saved; those compactions now save their resume checkpoint
- On Windows, plugins whose hooks start a program by a rooted path such as `/bin/bash` now install instead of failing with "plugin capability path must stay inside plugin root"
- The Python SDK no longer stops filling a delivery gap early, or reports the session current with events missing, when an earlier gap notice is redelivered after a later one; the repeat now returns `IgnoredStaleFrame`
- The TypeScript SDK no longer stops filling a delivery gap early, or reports the session current with events missing, when an earlier gap notice is redelivered after a later one; the repeat now returns `ignoredStaleFrame`, and `StaleDroppableMethod` gains `view/gap`, so code that matches it exhaustively needs a new case
- Report tasks that finish during `/stop all` as already finished instead of failing the stop
- Workflow agents now get a notice when the summary list omits earlier results, even when full results are available
- Long sessions trim covered records at checkpoints instead of growing without bound
- The TypeScript and Python SDKs no longer send feedback on an approval choice that does not accept it, which left the approval open; they report the new `feedbackNotAccepted` failure kind (listing the choices that accept feedback) and answer with the offered deny or abort choice so the turn goes on, and code that handles every `ApprovalFailure` kind needs a case for it
- A Workflow subagent that names a model now runs in sessions first started on an older version, when `/model` lists that model once for your provider, instead of being refused
- Session retention no longer gives up on a session forever when one background read of its log fails; the read is retried on a later pass, so the session still expires once it is past the retention period
- Hook input `model_provider` is `meta` again for Muse models on every Meta gateway connection, including the corp Mac launcher, and is still omitted for Claude and GPT models served through the Meta gateway
- Queued input typed while the agent was working now runs after a post-turn context compaction instead of waiting at an idle prompt
- When a subagent runs on the session model because its configured model is unavailable, the agent that started it is still told which model ran
- After resuming a session, `/compact` now shows its `◆ Context compacted` outcome row in the transcript instead of silently leaving the transcript unchanged
- A Workflow resume that is refused or fails after launch now records its terminal reconciliation, so clients no longer show the Workflow as open until the host exits
- Commands run by tools (shell, MCP calls, hooks, background terminals, `!` shell) now join the turn's trace instead of starting orphan traces, so downstream spans from tools like `meta` nest under the tool call that ran them
- Context checkpoints are no longer skipped for the rest of a turn when a monitor or background task reports in while tools are running
- The built-in `web3d` skill now stops checking a page as soon as you say stop or ask it to just open the page
- When you log in while `muse serve` is running and your account still needs onboarding, turns now say what to do instead of asking you to log in again
- After a full disk or a failed write clears, the next context checkpoint is saved instead of being skipped once more
- A reopened chat no longer fails every compaction when a subagent delivery was saved late, just before an earlier compaction
- When the model only says what it will do next and calls no tool, the agent asks it to go on (up to twice per run) instead of ending the turn there
- When part of a session's saved history written after a Workflow started is missing, resuming that Workflow now stops with the reason and asks you to run that work again, instead of continuing it
- Resume conversations with pending background results without unnecessary context limit errors
- Tables in assistant replies draw a line between every row
- `/fork` now works in a forked chat that was branched from a compacted chat, instead of failing with "source Goal state changed or failed validation"
- A session whose compaction checkpoint failed and could not be rolled back no longer re-summarizes the same history on every step; it keeps each compacted summary and continues
- A chat no longer stops saving until restart after a disk error while recording a workflow launch result
- A `muse serve` chat reopened after a crash cut the end of its session log now shows its history, new turns and approval requests again, instead of looking stuck
- A forked, rewound or side chat opened in the same app run as its source now saves its context checkpoints, instead of skipping them until the app restarts
- A reviewed skill's invocation-grant resolver now survives the post-login re-arm, so reviewed `allowed-tools` keep their preapproval instead of falling back to an approval prompt after a logged-out start
- `/compact` works repeatedly in resumed forked conversations
- Paging more sessions into the resume picker now stays linear instead of rescanning every loaded row for each new one, so long session lists keep loading pages at the same speed
- Resume conflict names the holding session server instead of suggesting killing it
- Resume picker notes that sessions with no turns are not kept
- When Muse can't read a session's saved history file, resuming a Workflow from that session now stops with the reason and asks you to run that work again, instead of re-running the Workflow from the start
- Resuming over `muse serve` a chat first recorded under the `muse` provider label that also used a plugin recording session events now keeps its earlier reasoning instead of dropping it as another provider's
- The TUI no longer erases the terminal's pre-existing scrollback when session rows arrive, matching gate-off
- Pay-as-you-go sessions restore a saved contributor model remapped at startup once the subscription check answers, instead of staying on the standard-price base
- /compact issued while viewing a background delivery now compacts the newest top-level run instead of the delivery run
- Resuming an Auto-review session with the reviewer explicitly off now proceeds under the recorded human override instead of refusing, matching gate-off
- A saved chat whose tool result could not be written to disk (for example on a full disk) now opens again without a restart
- Rewinding to an earlier turn no longer fails after an automatic history-preserving checkpoint in a conversation created by rewinding with an image
- A session left running through an auto-update now resumes with its history instead of coming back empty
- Gate-on resume settles the session's automatic name like gate-off instead of leaving the reopen unnamed
- A skill reminder prepared before you answered Muse's question or sent it another message is now dropped instead of reaching Muse as current advice, so Muse no longer acts on guidance your answer already settled
- A chat whose tool call could not be written to disk (for example on a full disk) while its result was written now opens again after a restart; only that turn is set aside, and Muse says so once
- Text you type while `/new` or `/clear` starts a fresh session no longer loses its first letter
- When the missing part of a session's saved history includes the record of how a Workflow started, resuming that Workflow now also stops with the reason and asks you to run that work again, instead of failing with a bare error
- Retrying `session/fork` with the same command after the host unloaded the idle fork, or after a host restart, now returns that fork and its history instead of an internal error
- A background task that finishes after you reopen a chat no longer stops compaction from saving checkpoints when the turn that started it could not be restored
- Session rows no longer render twice in the TUI transcript
- /new and /clear now clear the screen immediately instead of leaving the old chat visible for seconds
- `/usage` totals now include background work and break it out in a separate Observers row
- A failed turn now shows its error once instead of twice when partial output arrived before the failure finished
- Keep background work status available after reopening a side conversation or fork
- Pay-as-you-go sessions keep a saved contributor model from the first request, instead of mapping it to the standard-price base until the subscription check answers
- Reopening a saved chat while a background task it started is still running no longer stops compaction from saving its checkpoint, or the task's result from being recorded, when that task finishes
- Agent no longer repeats a pending question when a background task finishes

### Performance {#performance-2}

- In `muse serve`, reading the next page of a long agent message, a workflow child's prompt or a raw web-search result no longer rereads the whole chat while nothing new has been saved
- Reduce repeated history scans when opening forked sessions

## 1.4.10 {#v1-4-10}

### New {#new-3}

- Added `/blender` to reconstruct reference images as editable Blender scenes

### Improvements {#improvements-3}

- A background command that runs past 30 minutes now prompts the agent once instead of every 30 minutes; the agent schedules its own later check if it needs one
- The transcript shows "Waiting for background task" when the agent is prompted about a long-running background command, so you can see why it started working
- Computer Use makes fewer tool calls: it skips re-reading its own instructions, opens the app a task clearly points to without listing apps first, answers file and system questions with the shell, and does the task even when the screen already looks done
- Saved sessions can record whether a run was still starting when they were saved; nothing records it yet, so no session opens differently today, and once a later Muse records it, Muse versions released before that one will not open such a session
- Long analysis answers use short sentences and paragraphs instead of dense walls of text

### Fixes {#fixes-3}

- **Security:** Sandboxed commands can no longer read or change sign-in details, settings, approval rules or blocked apps stored in `~/.config/muse`, `~/.config/tbh` or the same folders under `XDG_CONFIG_HOME`
- **Security:** The git skill now refuses to hide your untracked files with ignore rules or a stash when a task only asks for a clean tree
- **Security:** Hook input `model_provider` now names the vendor of the selected model instead of the connection it was routed through: it is `meta` only for a model the built-in Meta gateway catalog lists as Meta-owned, and is omitted otherwise, so a Claude or GPT session on the Meta gateway no longer reports `meta`
- A duplicate wait for a background command that is still running no longer holds the chat for its full requested wait
- A Workflow child that stops because its start record can't be saved, or because a different start record was already saved for it, now says in plain words that nothing new ran, that the other Workflow children keep running, and what to do next
- A Workflow task that was interrupted right after it scheduled a retry now resumes with its recorded model and effort instead of being held
- Resuming a session whose log cannot prove its last start is refused with a message naming the broken record instead of opening silently
- SessionStart hooks run on every resumed TUI session whose log proves its last start, reporting `resume` (or `fork` for a never-activated clone) as their source; a replayed copy that cannot prove it runs none and says so in its startup notice
- Spawn rejection hints now explain the reason in plain words instead of internal enum names
- Repository-wide Sapling file listings (`hg files`, `hg locate`, `hg manifest`) on EdenFS checkouts are refused before they hang, pointing at `search` or `hg biggrep` instead
- `muse serve` now shows the history of a session that Muse 1.4.8 is still running, instead of failing to read it until that session closes
- Sessions started through the session protocol honor saved reasoning effort
- Workflow messages and exit prompts keep the recorded name after resume
- A monitor you start now appears in the footer and in `/tasks` right away, even when the machine is busy or the disk is slow
- A forked chat whose history has a background-task notice delivered mid-turn now opens in apps and SDKs in more cases, instead of failing to load
- When a `muse serve` client resumes a chat whose saved history view file was deleted, the chat shows its history again instead of none
- Manual `/compact` now compacts sessions with MCP servers configured, instead of answering "no compactable run is available"
- An MCP server whose process stays alive but never responds during startup now fails with `the server did not respond during startup` instead of the generic operation timeout
- Switching a conversation between the desktop app and the terminal when they run different versions of Muse Code now catches up a short exchange made on the other side instead of rebuilding its saved history from scratch; the first open after updating from a release before 1.4.9 still rebuilds it once
- When a resumed Workflow task's first save fails before anything is written, only that task retries instead of the whole Workflow stopping; if the retry's save fails too, only that task fails and tells you what to do next
- A context compaction no longer skips its checkpoint when another session write lands while that checkpoint is being saved
- Running /compact in a chat whose turns all ended before any model request (for example, a message cancelled before Muse began preparing its model request) now reports that there is nothing to summarize instead of writing a summary checkpoint that could later let the chat skip setting up its developer instructions
- Resuming a thread whose saved history had fallen far behind now brings it up to date in that same resume, instead of showing no history and missing live replies until the next resume
- A session whose model reused a tool call id for two same-length results no longer becomes impossible to resume or compact after old tool results are cleared
- `muse serve` keeps answering other requests while a long session's history loads for the first time, and resuming a session that is still loading waits for it instead of reporting the session as in use
- Subagents now honor the reasoning effort set in their agent definition
- A turn whose final answer consists only of the "\[Previous turn ended without an assistant reply.]" marker now gets one bounded re-prompt for a real reply, and the marker is stripped from run summaries
- Compaction keeps working after you reopen a saved chat, instead of summarizing again at every boundary and eventually failing with "could not prepare the conversation"
- The TypeScript and Python SDKs no longer mark a turn retracted, or drop its completion, when its retract is declined; in the TypeScript SDK, `StaleDroppableMethod` gains `turn/retracted`, so code that matches it exhaustively needs a new case
- Workflow control rooms and opened results keep the recorded workflow name
- Retrying a fork with the same command id now returns the original outcome instead of answering command\_id\_conflict, matching gate-off idempotency; reusing a command id with a different cut still conflicts
- Newly saved workflow history and live updates use recorded names, with "name unavailable" for older runs that have none
- `muse serve` keeps answering other requests while it resumes or forks a long session, opens a side chat on one, lists its pending approvals or reads one of its tool outputs, instead of stalling every other thread until that session's history is read
- A Workflow subagent that named your session's model keeps running after a restart even when that model is now hidden or missing from the model list, the same as one that left the model out
- Subagents use their definition's model, falling back to the session model with a notice when unavailable
- A long goal run no longer stops early when fresh next-step guidance replaces still-active guidance after new tool work; identical guidance still stops as before
- When `muse serve` starts with no saved model list and your account still needs a payment method, onboarding or age confirmation, turns now say what to do instead of asking you to log in again
- The transcript no longer shows a "◆ \[Previous turn ended without an assistant reply.]" row — a reply containing only that resume marker renders nothing, and a real answer prefixed by it shows just the answer
- The bundled Three.js skill now gives a working WebGPU post-processing example instead of one that imports a file current three.js no longer ships
- Allow subagents to process pending results while the parent waits
- A Workflow resumed after a crash no longer shows a killed agent as still running when its relaunch is refused before it starts; the killed attempt's row now ends Failed and the Workflow completes
- Correct `/compact` token counts when tool results are cleared or reminders expire

### Performance {#performance-3}

- `/btw`, `/side`, and `/fork` open faster in very large compacted sessions
- Reduce memory use when loading sessions with repeated approval records

## 1.4.9 {#v1-4-9}

### New {#new-4}

- `--disable-request-user-input` (TUI, `muse exec`, `muse serve`) withholds `request_user_input` from the main conversation (side chats keep it), so an unattended run never stops to wait on a question; a call naming it gets an unavailable-tool error instead. `--yolo` implies the flag on the TUI and `muse exec`
- Every MCP `tools/call` Muse sends carries the model's tool-call id in `_meta.callId` (and the idempotency key when set), so an MCP server can correlate it with the session's tool-call item and dedupe retries
- Session-protocol clients receive an `approval/reviewing` view event while the built-in Auto-review reviewer holds an approval, so a UI can show that the request is under review without asking the user to decide it
- Tool-call items in `muse serve` sessions carry the words a tool declares for the call, with running, done and neutral forms, so apps can say what a call does instead of showing the tool name

### Improvements {#improvements-4}

- Session-protocol clients: view cursors are now minted in the `v4:` spelling; a cursor in the previous `v3:` spelling is refused once with the standard "reopen without a cursor" guidance, and a view cache saved under the previous generation is rebuilt on first use, so no client silently skips events now that the Auto-review hold folds its own `approval/reviewing` event into older sessions

### Fixes {#fixes-4}

- Sapling commands now work inside the sandboxed shell on EdenFS checkouts
- Clear interrupt status when the interrupted run ends
- Long sessions no longer summarize the same history again at every turn when a context checkpoint cannot be saved
- Long sessions with an active goal that start more than one subagent compact their context again, instead of retrying a summary on every turn that never takes effect
- Contributor-mode requests with no served model list yet now consistently carry the contributor signal
- When `muse serve` starts without a saved model list and the provider rejects your saved key or sign-in, turns now fail with a sign-in-required error that apps can act on, and reloading the session works once the key is fixed, with no restart
- On a `muse serve` host running the native Auto-review reviewer, an approval the reviewer was holding is handed to the human client when the turn ends before the reviewer decides, and one recovered after a host restart is presented instead of staying hidden; a request the reviewer hands over says so (`judgeEscalated`)
- Rechecks conversation history and restored context before applying a background summary
- When a skill you named cannot load, the agent now stops and asks instead of improvising
- Hooks and MCP servers now receive `PROVENANCE_PROVIDER_SCOPE` when the app that launched the session set it
- Allow one more attempt to clear old tool results after reopening a session whose required compaction failed
- `muse serve` now closes the open approval of a subagent that has no session log of its own (for example one started by an earlier version) when a session that has not been compacted is resumed after a crash, so a late decision on it reports that it is already resolved instead of not found
- A `/goal` replace question now appears even while a run waits for admission, instead of the submit being silently dropped
- `muse serve` answers `plugin/install` and the `plugin/marketplace*` methods for an existing session it has not loaded with `sessionNotLoaded`, `sessionInUse` or `sessionAmbiguous` instead of `sessionNotFound`, so a client no longer treats a stored session as gone
- After a compaction whose history clean-up was refused, the next model step no longer fails with "Origin read requires valid checkpoint-suffix ..."

### Performance {#performance-4}

- While idle, `muse serve` no longer rewrites the lock file of every old empty session it has to keep, or re-reads most sessions it cannot list, every few seconds
- Typing stays responsive in long sessions with many subagents
- `muse serve` answers a `session/resume` that carries a known cursor by reading only the events after that cursor, instead of the whole session history. This includes a cursor taken from a streaming delta, which now resumes after the event it streams from. Such a resume of a session whose history exceeds the 64 MiB read limit now gets its new events instead of `noneReason: projectionReadLimit`

## 1.4.8 {#v1-4-8}

### New {#new-5}

- Pick the permission profile when resuming a served session with the `permissionProfile` member of `session/resume` (and the SDK resume option); an id the host does not offer is refused before anything is written
- Muse now saves a note when cleanup after a finished turn keeps failing; an older Muse build cannot open a chat that contains this note, so update the app to open it (other chats are unaffected)
- The Linux sandbox helper plants in-namespace loopback listeners for listed local ports and bridges them to host loopback (delivery half of `network.local_ports`; the profile verdict map itself lands with the agent side)
- Session protocol now serves the model's narration between tool calls as `agentMessage` items, and every completed `agentMessage` says whether it is commentary or the final answer (`messagePhase`); the Python wire-types package has the matching typed field; view cursors saved by an earlier version are refused (`-32011` with reason `missingAnchor`; the resume guide covers the reopen)
- `--preset empty` starts a session with no built-in tools; the model gets only the tools of MCP servers you configured
- Apps connected to `muse serve` can follow a running subagent live by subscribing to its session, and unsubscribing from a subagent session no longer fails
- Monitor feed lines are recorded as `monitorFeed` items; builds older than this change cannot open a chat containing one (updating fixes it)

### Improvements {#improvements-5}

- `skill/list` rows include an optional `title` with the name a skill declares for people to read, beside the unchanged `displayName`
- When a plugin hook finishes, helper processes it left running in the background are stopped so the plugin's installed files can be released; hooks configured in settings keep their existing background-helper behavior
- `SessionStart` hooks report `clear` and `compact` as their source on the runtime's own `/clear` and compaction boundaries, so a hook that matches only `startup` no longer runs there
- A permission-profile change made over the session protocol records the client's name on the durable audit fact and in the experimental `session/permissionProfileChanged` notification; a forked session's own fork entry carries no name until the child records a change of its own, and the fork is refused when the parent's retained history and live state disagree on the recorded name; an older Muse build cannot open a chat whose permission profile a newer build changed, so update the app to open it (other chats are unaffected)
- Auto-review now hands an action to you for approval once the reviewer has used 15 steps without reaching a decision, instead of letting a single review run for dozens of steps and use many tokens

### Fixes {#fixes-5}

- `muse serve` sessions started after the startup model list finishes loading, or after a login, use the sandbox the server checked at startup instead of checking it again for every session
- Repeated status lines between commands no longer flood the transcript; the commands fold into one row
- Resuming a session after its latest run was interrupted keeps the earlier title and history readable
- Resuming a session keeps earlier run history readable after a later run replaces it
- Paging through a large tool output in a `muse serve` client no longer re-reads the whole session for every later page while the session log is unchanged
- Resuming a session again in the same `muse serve` process after its earlier load ended without a clean shutdown now reports the session as in use instead of risking a damaged session log
- Forking a session with no turns yet no longer fails when background cleanup runs at the same moment
- A question asked during goal-carried work without its own timeout now times out after 5 minutes (recorded as timed\_out; no answer is chosen for you) instead of parking the run indefinitely; touching the prompt still cancels that safety deadline, and ordinary interactive questions keep waiting with no deadline
- Claude plugins whose command files are up to 256 KiB now install
- The verify reminder no longer pushes the agent past a question it asked you; it nudges only when the agent calls work done without running it
- Sessions keep the selected model's output limit after model changes and reloads
- Resuming a session keeps compaction usable after a later run takes over
- Over `muse serve`, a session that lost saved records now opens with the rest of its history instead of failing with "projection unavailable"
- The startup trust prompt no longer times out under terminals that report the cursor slowly, such as Zellij
- Preserve measured context usage when resuming a session
- After Muse restarts, a Workflow agent call whose saved start record is missing or incomplete, or whose agent definition is gone or no longer matches how the call started, now fails on its own with a result that says what happened and what to do next, instead of failing the whole Workflow
- Running plugin hooks and MCP servers keep their original installed files available through completion and child cleanup when a newer plugin version is installed
- Workflow subagents that pick their own model keep working when you resume a session with `--model` and later resume it without the flag (sessions resumed with `--model` on an earlier version are not repaired)
- Startup notices for MCP servers the managed policy does not admit now appear even when a required MCP server fails to start
- `sl` and `hg` commands that use globs or braces, such as `sl status *.rs`, now ask for approval like `git` commands do
- Read-only Sapling commands such as `sl status`, `sl log` and `hg diff` are now treated like their `git` equivalents
- Resuming a workflow after tbh stopped no longer fails the whole run when an agent call was still waiting for a free agent slot; that call now starts normally
- `muse resume` no longer refuses a session whose journal head was pruned when a checkpoint anchors the suffix; the no-anchor case names the recovery
- Sessions that `muse serve` recorded under the old `muse` provider label keep their reasoning after a model change and a restart, instead of dropping it or failing every turn once compacted
- Resuming a workflow no longer requires repeating its name
- Runtime-owned child runs (branches, side chats, subagents) no longer re-fire the root session's `SessionStart` hooks
- Prompt hints and away recaps wait for a session's SessionStart hooks to finish before they run
- Fix completed workflows reappearing as running after resuming a compacted session
- Plan files under .agents/plans/ no longer raise an approval card — the directory is an ordinary writable workspace path, while the rest of .agents stays protected
- When Muse resumes a Workflow after a restart and the script finishes without waiting for an agent call that Muse held back, Muse now tells you which call did not run, why, and what to do next, instead of reporting plain success
- When a chat is stuck retrying a save that failed, `!` shell commands, `/compact` and new turns over `muse serve` now fail at once with the "saving failed … retrying automatically" message instead of a busy answer
- `muse serve` now re-asks a pending approval with `approval/request` when a multi-stage approval moves on to its next stage, and when a client replays its `session/start` after a host restart, so session protocol clients see the prompt instead of a turn that waits forever
- `muse exec` waits for context compaction to finish before exiting, so resumed sessions keep their compacted summary
- On Windows, renaming a session now fails with a plain "not supported on this platform" error (`session/rename is not supported on this platform`) instead of an internal one, and a client that requests the new `sessionRename` capability at connect time learns that rename is unavailable there. `CapabilityName` gains a `SessionRename` variant; exhaustive matches on it need a new arm
- A session whose MCP startup could not be audited (its open record was missing or unreadable) now shows one startup notice for each MCP server the managed policy did not admit, beside the audit-failed notice; a session whose every server was refused, which showed nothing before, now shows those notices too
- `/goal` changes no longer freeze the TUI on long sessions; repeat Goal edits now re-read only newly committed run records instead of rescanning every run stream
- Compacting a session keeps the request detail the summary needs, so manual compaction rebuilds the exact prefix instead of falling back to a bounded summary
- Startup selection now skips a PATH-discovered system Bubblewrap copy that does not advertise every required capability and uses the embedded copy instead; an explicit override missing one fails closed naming the flag
- Resending a request after a restart returns the original result instead of running it twice
- With contributor mode ON, requests route to the family's `-contributor` model as soon as a fresh served catalog shows it — including mid-session logins, background refreshes, and late-appearing siblings — instead of sticking to the base model on a stale list
- A session whose saved images or videos have wider folder or file permissions than the app creates now resumes, and its videos still send
- `tbh serve -c` settings such as `endpoint_transport.base_url` now reach the model provider instead of being silently ignored
- Opening the transcript link of a memory-only reminder helper, while its chat is open and the helper ran since the chat was opened, now says the helper kept no transcript and names its chat, instead of "session not found"
- Explain context compaction failures in plain language
- Over `muse serve`, retrying `turn/start` with the same command id but a different message or options while that turn is still parked (replacing a running turn, waiting for the running turn to finish, or waiting behind a reminder) now fails with `command_id_conflict` instead of being treated as the original turn
- Sessions named more than once (an automatic name counts) open with their full history every time instead of sometimes showing an empty transcript
- Keep `/side` and `/btw` progress visible while a side chat is starting
- SessionStart hook runs no longer appear as `hookRun` items in the session view stream
- Concurrent resumes of a `muse serve` session no longer run its SessionStart hooks twice
- Turning off Contributor mode in settings now fully opts out, including background requests
- Keep pending results from an earlier turn intact when the next model response is cut off
- A compacted chat whose saved history file was damaged or deleted shows its full history again after the next resume instead of staying empty; a forked chat in that state now says why it cannot resume instead of opening with no history
- The permission-profile refusal announced early in the 1.4.6 notes takes effect in this release: profiles the live session cannot enforce are now refused when chosen at launch (`--permission-profile` or the configured default) instead of silently collapsing to read-only; the refusal names each offending rule with the reason and a remedy (remove or adjust it, or set the temporary escape hatch to run with it unenforced and a warning). Profiles that keep a built-in profile's filesystem rules, `:unrestricted` included, keep working; profiles that add or change filesystem rules (deny rules included), add `workspace_roots`, or add Unix-socket rules are refused — most users can delete those rules and relaunch

### Performance {#performance-5}

- Long sessions no longer spend more time on every frame keeping the session token totals up to date
- Large batches of parallel tool calls now land their results without rescanning the transcript for each one
- Bash command results no longer repeat the command back to the model, so a long inline script takes up context once instead of twice
- Task panel refreshes stay fast in long sessions with many finished tasks
- Opening a long older session for the first time now rebuilds its history many times faster

## 1.4.7 {#v1-4-7}

### New {#new-6}

- `muse serve` now tells session protocol apps on `initialize` whether this machine can enforce the shell sandbox and, when it cannot, why; the Python wire-types package has the matching typed fields
- A skill can set `metadata.display-name` in its `SKILL.md`; the transcript's skill rows and the `/skills` list then show that name instead of the skill's id
- Terminals that support program status reports (OSC 7501) can now show whether a session is working, waiting for you, or done
- The agent can now generate and edit images when your model catalog includes an image model

### Improvements {#improvements-6}

- `/goal cancel` and `/goal stop` now clear the goal like `/goal clear`, and `/goal` subcommands ignore case
- `/goal <objective>` now asks before replacing an unfinished goal; Esc keeps the current goal and your typed text
- Menus consistently use `⟩` to mark the focused choice

### Fixes {#fixes-6}

- Resuming a session saved by an older version no longer sets aside one earlier turn's history on the next resume, including sessions an affected version already resumed
- Manual /compact on a short conversation now summarizes the full history instead of installing an empty summary beside it
- Stopping a subagent the agent is waiting on no longer makes the agent report the stopped result again in an extra turn
- `session/list` now includes a session that another Muse Code process, such as an open TUI, is using; its details catch up as that session settles, and resuming it is still refused as in use
- Long-running `muse serve` sessions no longer use a little more memory with every turn
- A context compaction now always saves its resume checkpoint together with it; if the checkpoint cannot be written, the compaction is skipped and retried at the next step instead of leaving a session that resumes slowly
- Clarify known turn errors while preserving sign-in guidance
- Preserve pending tool results when a model rejects a large request
- When a turn dies and its failure cannot be saved, a message sent after the quick retries run out (about 30 seconds) now returns a clear "saving failed: \<cause>; retrying automatically" error instead of being silently held, and the chat unlocks by itself as soon as a retry (once a minute) saves the failure
- When a tool panics with a text message while the turn waits on it, its failed result now includes that message (`tool task panicked: <message>`) instead of only `tool task panicked`
- Forked conversations can continue after their first compaction
- `muse serve` refuses a session whose permission profile needs the automated reviewer up front, with the reviewer-unavailable reason, when it starts without a saved model list and then falls back to logged-out mode, as it does on a logged-out start
- After `/goal resume`, the agent can start workflows again when your settings allow them, instead of being refused
- Forking a session whose earlier turns were folded into a summary, or one forked right after its rules were updated past a compaction, now gives a fork that every client can open
- Closing stdin on a `muse serve --no-session-log` host while a turn is running now sends that turn's `turn/completed` (cancelled) before `session/closed`, instead of leaving the turn without a terminal
- Retrying Stop while a workflow is recovering preserves its original acknowledgement
- Workflow subagents that pick their own model now start in sessions launched with `--yolo` or with approvals off

### Performance {#performance-6}

- Resuming a session no longer re-reads every finished agent, so sessions that ran many agents open much faster
- Resuming or running a session with many workflow agents spends less time refreshing the workflow control room
- Resuming a session whose workflows ran many agents starts its runtime much faster

## 1.4.6 {#v1-4-6}

### New {#new-7}

- Session protocol clients can install plugins and add, update, or remove marketplaces, with change notices after each success
- `muse serve` runs its own reviewer, honors a configured `permissions.default_profile: ":auto-review"`, and a host with no default permission profile configured and no sandbox flags now starts new sessions on Auto-review instead of Ask me when a reviewer is available (a `--disable-sandbox` or `--sandbox-network` host keeps human approval; set `permissions.default_profile: ":ask-me"` to keep it everywhere)
- A named toolset (`run.toolset`) can now select a server's MCP tools with a trailing `*`, such as `mcp__docs__*` for every `docs` tool or `mcp__docs__search*` for tools whose names start with `search`
- `task/list` reports the session's running background tasks over the session protocol
- Contributor mode is subscribers-only and routes each model family to its served contributor model; without an active subscription or a served contributor model the toggle stays hidden and requests go out unchanged
- A `PostToolBatch` hook now runs once after each committed tool batch with the ordered tool calls; a handler can block the batch with a reason, stop the turn, or add context that is held until the turn's completion hook settles
- A `StopFailure` hook now runs once when a turn ends in a final model failure and receives the failure category and safe details
- Choose the permission profile for a served session at start with the `permissionProfile` member of `session/start`; an id the host does not offer is refused before the session exists, and a session served without a signed-in provider now lists the profiles the host policy excludes as unavailable, as a signed-in host does
- Managed background shell launches under Linux proxy-only networking now carry a note that ports they bind are reachable only inside that launch, naming `--sandbox-network enabled` for serving the host
- Apps using the session protocol can resume a paused workflow and replay the same receipt when retrying
- Turn retry notifications now include the failing provider attempt's details (provider system, error kind, and HTTP status) for clients that read them
- Approval prompts point to `/permissions` for changing approval defaults
- Contributor mode is now on by default for subscribers, and after your first login inside the app the contributor-mode notice shows right away, before any request is sent in contributor mode; turn it off any time in `/settings`

### Improvements {#improvements-7}

- The "Worked for" line shown after a long turn now ends with the date as well as the time, such as `Worked for 2m 29s · 9:34 AM · 8/Oct`
- If you come back while a run is still going, the automatic recap now appears once that run finishes instead of being skipped
- The host-network sandbox mode is now spelled `unrestricted` (`--sandbox-network unrestricted`, `network.mode: unrestricted`); `enabled` still works as a deprecated silent alias
- The automatic recap shown when you come back now appears after 2 minutes away (was 3) and once the session has 2 of your messages (was 3)
- `session/read` and `view/page` on a finished subagent's session now return its history instead of no history or a refusal
- `PostToolBatch` hook feedback that ends a turn reaches the model on the next user turn, exactly once and in handler order
- Pressing Esc before the model answers now gives back your message together with every message you queued after it, as one draft in the input box, images included, instead of returning only the newest queued message
- Chat answers now favor diagrams drawn with text characters over raw Mermaid source
- After an interruption, a Workflow task whose model and effort choice was never recorded is held with a reason instead of restarted, and recovery keeps the recorded effort even if settings changed
- Agent definitions can choose a model and reasoning effort for delegated Workflow tasks
- When `/goal` replaces an earlier goal, the agent is now told which goal was replaced, so it no longer mistakes the replacement for a cancellation

### Fixes {#fixes-7}

- **Security:** Ask me and Auto-review now ask before running `find -delete`, `find -exec rm` (such as `find -exec rm '{}' \;`) or `find -exec '{}'`, as they already did for `find | xargs rm`, instead of running it without asking; `find -exec` with plain programs such as `grep` or `chmod` still runs, while some other launches such as `find -exec sudo rm -rf '{}' +` or `find -exec sh '{}' \;` now ask too; a `find -exec sh -c '…'` script can still run without asking, even one that deletes files
- **Security:** Ask me and Auto-review now also ask before running a `find -exec` that reaches `rm` or the matched file through `sudo`, `env`, `setsid`, `nice`, `nohup`, `timeout`, `stdbuf`, `time`, `command` or `xargs` (for example `find -exec sudo rm '{}' \;`), instead of running it without asking, and before a `find -exec sudo` whose options it cannot read, even when the launched program is not `rm` (for example `find -exec sudo --bogus cat '{}' \;`); a known wrapper that launches a program such as `cat` (`find -exec sudo cat '{}' +`) still runs, and so does the matched file itself (`'{}'`) behind another wrapper such as `ionice` or `doas`
- **Security:** Ask me and Auto-review now also ask before running a `find -exec` that launches `rm` behind a wrapper they do not otherwise know, such as `ionice`, `doas`, `flock` or `chrt` (for example `find -exec ionice rm '{}' \;`); `find -exec chmod`, `mv`, `sed -i` and `grep` still run without asking unless the command itself would ask (an argument named `rm` alone does not make them ask), and so does such a wrapper launching the matched file itself (`find -exec ionice '{}' \;`)
- When another program replaces a session's lock file while Muse is running (for example a sync between machines), side chat and fork now explain what happened and that restarting the Muse process holding the session fixes it (the message names it), instead of a cryptic lock error
- Sessions with an active `/goal` now save their resume checkpoint at compaction instead of losing it to goal usage tracking, including after the goal is paused, resumed, or replaced. If goal usage truly cannot be recorded, that compaction skips its checkpoint with the reason in the session log, and the next compaction tries again
- Subagent rows, queued counts, and child views now stay in sync when the experimental TUI client is on — foreign assistant turns no longer stamp the live answer, sent input feeds the same queue the counts read, and resumed sessions reseed their child threads
- Keep an image tied to its original message when background compaction drops a video that could not be sent with it
- `/plan` on a small change now returns a plan instead of making the edit
- Resuming a long session no longer marks an already-finished turn as cancelled, and the session keeps saving resume checkpoints afterward instead of replaying ever more history
- When compaction cannot safely keep part of a conversation, such as a video, it now reports a normal compaction failure that tells you to start a new session with `/new` or `/clear` instead of an internal error
- Keep an image tied to its original message when older tool output carried over from earlier turns is cleared from context
- A logged-out `muse serve` host now gives new sessions your configured permission profile and sandbox flags instead of silently starting them as Ask me; an Auto-review profile is refused with the reviewer-unavailable reason
- A skill already read in an earlier run of the same session is no longer reminded again in the next run; the reminder observer and admission now honor prior-run reads
- The published session protocol schema now accepts the `null` the host already sends for `session/goalChanged.goal`, `session/branchChanged.branch`, `session/modelChanged.providerId`, `session/modelRouteUnserved.providerId`, `session/tokenUsage.modelId` and a failed skill import's `id`, so clients that validate host messages against it no longer reject them; in the generated TypeScript and Python types these members are now required and may be `null`
- Messages sent during a reply still run after `/goal pause` or `/goal clear`
- Stop automatic continuation when a reminder is rejected, snoozed or fails without fresh guidance
- Resuming a session with a very large saved snapshot now reports the snapshot size when it cannot be read
- After a rewind or a return from `/side`, a finished subagent hidden from the current subagent tree view no longer reappears when its workspace cleanup is reported
- Permission profiles with filesystem rules the session cannot enforce (extra file or home-directory paths, workspace subrules, deny patterns, altered temp or root accesses, missing minimal read set, added workspace roots, or socket rules) are now refused at selection with the reason, instead of silently running read-only; setting `MUSE_PERMISSION_PROFILE_FAIL_OPEN=1` restores the old read-only fallback with a startup warning
- Limit retries when saving a Monitor's final state and report when it cannot be confirmed
- In containers where the sandbox cannot start, trusted workspaces can create session and subagent worktrees again, and untrusted workspaces get a clear refusal instead of a Git error
- A network request that arrives while an identical request from the same tool call is already waiting for your answer now joins that prompt instead of opening a second one and running a second Auto-review; a different command in the same run keeps its own prompt
- Long sessions that get a scheduled or background notification at almost every step now resume quickly from their latest compaction instead of rereading most of the session log
- Queued /goal edits now deliver in the order they were accepted even when the system clock moves backward between them, instead of replaying newest-first
- A workflow launch that was cancelled before it started is now recorded as cancelled; a saved session whose history leaves such a launch in doubt refuses to open with an error naming the launch instead of guessing, and a session whose cancel hit a storage error part-way reopens and finishes that bookkeeping instead of refusing to open
- When picking up a handed-over or resumed plan, the agent re-checks the plan's next step against evidence that arrived after the plan was approved before starting long work on it
- Clear leftover spaces when loading and indexing messages disappear from the session picker
- The published session protocol schema now accepts the `null` the host sends for a root session's `sideFrom` and an unnamed session's snapshot `name`; both stay optional in the generated TypeScript and Python types
- Closing the terminal while a hook is still running now stops the hook and the processes it started, instead of leaving them running after Muse Code exits
- Continue unfinished work after a failed goal check only when usable guidance remains
- Stopping or backgrounding a task that already finished before the session was reopened now gets the already-finished answer instead of `invalid_target`
- TUI /export falls back to the OS temp dir when the target directory is unwritable, and transcript failures name the intended file
- Starting with no model configured and a cold model cache now resolves the default model from the freshly fetched catalog instead of stopping with a missing-default error
- A renamed session now updates in an open session picker right away
- When a turn fails while draining hook continuations after a `PostToolBatch` commit and the first write of its `Failed` terminal does not land, the run is now closed with exactly one durable `Failed` terminal instead of being left open
- After a rewind or a return from `/side`, a finished subagent hidden from the current subagent tree view no longer reappears when a new subagent with the same role starts or a late message to it is settled
- Clearing a goal whose store cannot be read now reports the store as unavailable instead of claiming no goal is set
- Escape returns directly to the composer from a workflow opened below it
- Resumed older sessions and subagents now save a resume point at every compaction, and sessions holding an older-format resume point reopen without rereading the whole log
- If Muse cannot read a chat's session log when the chat starts, the chat now fails to open with an error that names the failed read, and reopening retries it. Before, the chat opened but /new, /clear, /resume, fork and rewind failed until Muse restarted, and the next resume wrongly reported that the previous run had ended abnormally
- When a disk fault left a live permission-profile change half-written, Muse could fall back to the old permissions even though the change might already be saved. Muse now finishes the interrupted write first: the change completes normally when that works, and otherwise the session stops accepting permission changes instead of falling back to the old permissions
- `-c session_retention_days=N` sets retention for one run
- Approval prompts open at the first choice instead of inheriting a previous Abort highlight
- Session lists no longer fail after an interrupted update
- File tools accept relative paths with `..` that resolve inside an allowed workspace root instead of refusing them
- Improve context compaction timing across turns and after clearing old tool results
- The file-tool watchdog row no longer promises "Esc to cancel" while an async question owns Esc; the hint hides until the question editor closes
- Stopping a background task on the first reopen after the app closed unexpectedly now gets the already-finished answer instead of `invalid_target`
- `web_fetch` now honors a live Unrestricted permission profile on every fetch — fresh, switched, and resumed sessions skip the per-host approval like `--yolo` — and reads profile static network targets before session rules, matching the shell order
- Editing or pausing a goal no longer resets its progress-reminder timing
- `muse serve` now prints a line naming any session whose saved view could not be brought up to date at shutdown, instead of exiting with no sign of it
- Under `muse serve`, a running or finished subagent or workflow child's conversation is now readable over `session/read` and `view/page` from any client
- Monitor watches over the new session connection now show their end marker (`Monitor "name" — ended` / `— failed` with the reason) and resume without doubling rows
- Changing a `muse serve` session's permission profile while it runs now keeps the approval mode the client selected
- Session lists stay available after an interrupted upgrade
- Transcript rows left in-progress when a turn ends now settle as failed instead of hanging
- Final answers report only the quantities asked for; extra accounting goes to a linked file instead of the chat answer
- A workflow child that the model provider rejected as rate limited, overloaded or with a server error now reports that as its error kind
- Opening `/permissions` immediately after session start no longer fails with "Session permission state is incomplete."; the picker waits for permission state to load
- Gate-on `/new` and `/clear` no longer stall \~30s on sessions that start no MCP servers; the fresh-session handoff settles as soon as the host reports no startup task instead of waiting out the full settle bound
- `muse serve` answers the app right away on a machine with no saved model list, instead of waiting for the model list download; the model picker and new sessions wait for the list
- A session whose Workflow launch was cancelled before its owner bound it now shows the same "history unreadable" state whether it is read from the session cache or loaded in full
- Resumed workflows keep their recorded names
- A `Notification` hook no longer freezes the session while an always-allow rule is being saved to a stalled disk; the approval reports the save timeout instead

### Performance {#performance-7}

- `muse serve` answers `initialize` without first scanning every retained session
- Resuming a session whose workflows ran hundreds of agents spends far less time rebuilding the workflow view

## 1.4.5 {#v1-4-5}

### New {#new-8}

- Turn on Automatic session naming in `/settings` to have each session named with a short Name and a Description; a name you set with `/name` or `/rename` always wins

### Improvements {#improvements-8}

- A turn that stops because the session's MCP link could not be confirmed now reports its own `mcpLinkError` turn error kind instead of a generic configuration error
- Apps and SDKs can switch a session to a model id that is not in the model list, on the same provider, as `--model` already allows at launch; a mistyped id is no longer refused at switch time and fails on the next turn instead
- When a resumed session can't replay its earlier private reasoning to the current model, the error now tells you to start a new session to continue and confirms the session's history is kept
- Session-protocol clients can import foreign skills over `skill/import` — bring Claude or Codex skills into the user collection (or preview the run with a dry run) through the same shared pipeline the app uses, with installed, quarantined, skipped, and failed sets in the receipt
- `/model <model-id>` switches to that model directly, without the picker; an id that is not in the model list applies to this session only and is not saved
- `muse serve` now keeps up to 256 sessions loaded at once instead of 32, raises its own open-file limit at startup to hold them, and when the system's open-file limit still cannot hold another session it refuses that load with a message naming the limit instead of failing mid-load
- Claude plugins whose hooks name events Muse does not run (such as `TaskCompleted` or `TeammateIdle`) now install; each such hook is skipped with a warning that names the event, and the plugin's other hooks, skills, and commands work
- A workflow's row on the main screen now shows the workflow page's colored progress bar before its agent count
- With Automatic session naming on, the bottom status row and `/status` show the generated short Name; `/status` keeps the session name that `/resume` uses in parentheses

### Fixes {#fixes-8}

- **Security:** Static target matching now resolves hex, octal, and shorthand IPv4 spellings the way the proxy does, so wildcard allows can no longer admit a non-public destination through an alternate spelling; IP rules must use canonical strict literals, and anything else falls through to a prompt
- **Security:** The `write_file` near-duplicate note no longer names a credential file, such as `.netrc`, that sits next to the file you created
- Keep images tied to their original message after background context compaction
- A brief server error no longer ends a chat right away when its model isn't in your model list; the request is retried again
- Sessions holding an older checkpoint above a newer capable one now reopen instead of failing every resume
- Monitor start guidance now names the sanctioned wait — end the turn when nothing else needs doing, because event batches wake the session — so a model watching a quiet job no longer fills the wait with sleep runs, log polling, or invented placeholder tool calls
- Keep images sent in later turns tied to their original message after periodic context saves
- When creating an operating-system socket fails with EPERM (for example crashpad's `socketpair` under a headless browser), the failure now carries guidance that names the sandbox as a possible cause with a probe to verify attribution, instead of no guidance
- Restore complete bulk stop notifications when reopening a session
- Background context compaction works after resuming a session, and your next message is no longer rejected when a background compaction cannot be applied
- Queued messages left behind after a turn ends no longer get stuck — press ↑ at idle to pull them back into the composer, then edit and send them or clear them
- Keep subagent answers visible after the parent reads their result
- Forking a session that was rewound in an older version, or whose compacted history ends with a summary note, now gives a fork that every client can open
- Keep an image tied to its original message when compaction during a turn or `/compact` removes a video sent in that same message
- Sandboxed Linux commands no longer fail with "Argument list too long" when the inherited environment is large; the environment and profile now travel to the sandbox helper as staged files instead of command-line arguments
- Hosts allowed in a permission profile now load from the sandboxed shell through the per-launch proxy instead of failing DNS resolution, and statically denied hosts fail without prompting
- A long-running background command (a watch loop or dev server) no longer keeps your next message waiting behind log cleanup
- Headless browsers (chrome-headless-shell, Firefox) and other tools that open anonymous AF\_UNIX SOCK\_SEQPACKET socketpairs now run in the managed Linux sandbox under Restricted and ProxyOnly network modes; re-addressable datagram pairs stay denied (full-Chrome headless still cannot take its ProcessSingleton lock under the filter)
- The TypeScript SDK no longer asks `onApproval` again about a multi-stage approval the host already closed, when the closing decision's reply and the final stage update arrive together
- The Python SDK no longer opens a console window on Windows when it starts `muse serve` from an app without its own console, such as a GUI app or a service
- A chat that used a plugin recording session events is no longer refused after you switch it to another provider's model and resume it in an app
- Shell writes to /dev/shm now persist for the rest of the session instead of silently vanishing after each command, and other writes directly under /dev now fail visibly
- Every `-32030` `commandRejected` with reason `runtime_busy` now reports `retryable: true`, including the ones that reported `false` before (a `turn/start` or `turn/steer` refused while another session's turn is running, `session/rename`, `session/userShell`, workflow pause, cancel and child control); retry after a short wait, and switch to a fresh `commandId` if the same one keeps returning `runtime_busy`
- `muse resume` refusal for a sequence-holed retained session names the expected and found gap positions
- A session you started with an explicit approval mode and then left without sending a message is now cleaned up like any other empty session, instead of staying in your session list with no turns
- When context compaction can't confirm where an older image came from, it now leaves a short note in the image's place and keeps going instead of stopping the run; the image stays in the session history
- A temporary (not logged) session, or a resumed session from before permission profiles were recorded, no longer reports a read-only permission profile that nothing enforced; it reports the profile it actually enforces, or no profile when none is in effect
- Stopping or backgrounding a task from an older session now gets the normal answer (finished, accepted, or not found) instead of an invalid-parameters error
- Under `muse serve`, subagent and workflow child records now land in each child's own session log instead of mixing into the parent's log, for new and resumed sessions; older sessions with mixed-in child records keep working with no changes
- A session whose transcript view fell behind a later compaction loads fully again instead of showing "live updates are unavailable" on every restart
- The verify reminder no longer pushes a full app rebuild or a platform download when you run the build yourself
- Answers to questions in chat fit on one screen again instead of running to a report; a request for a report, an audit, an inventory, or a file keeps the full detail

## 1.4.4 {#v1-4-4}

### New {#new-9}

- MCP server `url` and header values in `settings.json` and a trusted project `.mcp.json` now expand `${VAR}` and `${VAR:-default}` from your environment, so a checked-in config can keep its secrets out (write `$$` for a literal `$`)
- Session protocol toolCall items now carry the task's latest status detail (status line, phase, progress, step, retry attempt, health, child counts); the Python wire-types package has the matching typed fields
- Set `session_retention_days` in your settings file to delete saved sessions you have not opened for that many days; unset keeps sessions forever (macOS and Linux only for now)
- Session protocol workflow items now carry monitor detail (launch token budget, declared phase, final summary, stop availability, child prompt references); the Python wire-types package has the matching typed fields
- Shell commands, background monitors and hook commands now see the top-level chat's session ID in `MUSE_SESSION_ID` and the running chat or subagent's session ID in `MUSE_THREAD_ID`
- `muse exec`, the interactive TUI, and `muse serve` accept repeatable `-c key=value` (`--config`) flags that set any existing setting for that run only, including MCP servers; secret fields take `${VAR}` references instead of inline values and managed policy still wins
- Apps using the session protocol can pause a running workflow and read its paused state on the workflow item
- Apps using the session protocol can upload video in chunks and attach it to a turn by reference
- `muse serve` now pushes an experimental `session/permissionProfileChanged` notification when a session's permission profile is set or refreshed after start — from the picker, a resume selection, or a managed refresh — with the profile id now in effect (`null` for a launch-override profile) and, when a client command caused it, that command's id
- Attached videos now send with your turn instead of being refused

### Improvements {#improvements-9}

- The goal reminder is on by default again for every model except Muse Spark 1.3 at `max` effort, including models released later, because a long-task benchmark solved more tasks with it on. The todo and memory reminders keep their current defaults, and a saved on or off choice still wins
- Clearing the input with Ctrl+C now says so, and when the Up arrow can bring the text back it says that too
- Pressing Esc with text in the input box now shows that Ctrl+C clears it, and `/help` and the `?` shortcuts list Ctrl+C as clear, interrupt, or exit
- Background updates can wake a conversation while a subagent is waiting for approval
- The goal check now runs by default on new models and treats a requested publish as done only after the publish itself succeeds, so the agent keeps working instead of reporting done after a failed publish
- When the agent rewrites its plan and drops unfinished steps, the plan panel now says how many were replaced
- Quitting waits up to 5 seconds for a clean shutdown instead of 2, shows what it is waiting on when the exit is slow, and names that step if it still times out
- The `grill` skill now explains decisions in your language and uses comparison tables when they help
- `tbh exec` accepts inline `--flag=value` options
- `tbh exec` rejects a repeated single-value option instead of silently keeping the last value
- The macOS release for Apple silicon now requires macOS 12 or later
- Long model-prefill waits no longer false-timeout while bytes are still arriving: the pre-content wait now treats transport bytes as liveness (300s silence budget, 1800s overall cap), and a fully silent first attempt gets exactly one escalated retry before the turn fails
- Inside tmux, web links show only their clickable label when tmux is set to pass hyperlinks through to every attached terminal (for example `set -as terminal-features ',xterm-ghostty:hyperlinks'`); otherwise the address stays visible
- A running interactive session now refreshes its remote feature settings every four hours instead of only at startup, using the same opt-out as the startup check
- `--effort` now works as a shorter alias for `--reasoning-effort`, both when launching and in `exec`
- The background command view now shows the whole command over several lines instead of one cut-off line, and it and the monitor view color the command as shell syntax
- The grill skill's scope contract now treats a repository's own definition of done as its floor: the boundary cannot exclude what it requires, the "Done means" checklist cannot omit it, and adding it is not scope widening
- Session-protocol clients can change skill activation over `skill/setActivation` — turn any skill on or off in user, project, bundled, or plugin scope through the same shared service the app uses, with the previous value echoed in the reply
- Answers about what a skill runs now name the actual final program in plain words instead of stopping at the entry command
- `muse resume <id-or-name>` on a session whose saved log can't be replayed now starts a new session that reads that log and continues the work, instead of exiting with an error
- With `--disable-sandbox`, file tools can read and write outside the workspace whether or not the workspace is trusted and whichever built-in permission profile is selected, unless an administrator has turned off user sandbox overrides; `--trust-workspace` now only decides whether the workspace's skills and rules load

### Fixes {#fixes-9}

- **Security:** File tools now refuse to read, search, or change credential files (SSH, AWS and GPG keys, keychains, saved browser logins, Git and GitHub CLI credentials) and anything inside the Trash, even through links; the match is by file and folder name, so project files with these names are refused too, and the shell is unaffected
- **Security:** Ask me and Auto-review now ask before running dangerous commands hidden behind wrappers such as `env LD_PRELOAD=…`, `nice`, `timeout`, `xargs`, or a wrapped `bash -lc` script, matching the unwrapped commands; benign wrapped commands like `timeout 5 cargo test` still run without asking. A shell invocation that is not a `-c`/`-lc` script (for example `bash ./run.sh` or `bash -cl '…'`) also asks instead of auto-running
- **Security:** Creating a session worktree in an untrusted Sapling repository is now refused with a clear message instead of running that repository's hooks
- **Security:** Shell approvals now deny the whole action when a deny rule is added during review, including session approvals and approvals whose rule save failed
- Long sessions let go of finished task data, so memory grows more slowly over many turns
- Stopping a background shell now also ends child processes that moved into their own process group (such as `timeout`-wrapped commands) instead of leaving them running after the stop reports cancelled
- Keep readable agent paths in subagent message cards
- Tool calls denied before running, or naming an unknown tool, now show as rejected or failed items with their result text in every session view instead of silently disappearing
- Scheduled task confirmations no longer promise incorrect repeat intervals
- `--worktree` sessions start correctly in sandboxed Git repositories
- Preserve hook blocks when the same output requests approval or rewrites tool input
- Paused goals stay paused when the assistant reports a blocker
- Terminal commands that cannot start now report the real reason instead of running in the background
- A turn no longer ends with an event-log error when a background command finishes after the conversation was compacted
- Keep plugin command approvals revoked after rejected input during startup
- Identify hook matchers whose regex is too big to compile
- `/status` shows context usage after a turn instead of sticking at not projected
- Resume sessions correctly when a policy rule denies a compound shell command after its final approval
- An unreadable `settings.json` or `trust.json` now prints one warning naming the file and the error, instead of silently running as if the file were missing
- Linux sandbox preserves explicit write access when a read grant names the same path
- Recover saved command approvals after repeated restarts
- A protected file write still waiting for your review when the session restarts now reopens under the same approval instead of being cancelled, so you can decide it without asking for the write again
- The `/` command palette shows one row for identical copies of a skill kept in several folders, such as `~/.agents`, `~/.claude` and `~/.codex`, instead of one row per copy
- Subagent approval requests remain available when the parent conversation starts another turn
- Keep background Bash commands recognizable after a session restart
- Stopped or closed subagents report their final status correctly
- Long-running sessions resumed after an upgrade no longer become impossible to resume again after their next compaction
- Keep nested subagent starts and completions in their parent conversation
- Recent messages and detailed results no longer run together while a tool is still running
- Text copied from the conversation no longer carries trailing spaces padding each line to the terminal width
- Long sessions release covered in-memory session mirrors as checkpoints land, so memory grows more slowly over many turns — saved history is unchanged
- A queued item delivered by a later run is no longer delivered a second time after a restart when a context checkpoint on the delivering run had pruned its delivery record
- `tbh -w` creates a session worktree again on macOS instead of failing with Operation not permitted
- Changing the model while a turn is running now updates the approval reviewer instead of leaving it on the previous model
- Pressing Enter right after answering a permission prompt no longer sends the half-typed message hidden behind it, and a prompt that just appeared ignores Enter, y, p, and number keys for a moment so a stray keystroke can't approve it
- Sessions served over `muse serve` now load your custom agents just like the interactive app, instead of offering only the built-in agents
- A resumed session whose profile the enterprise config refloor downgraded to human no longer fails startup when the approval reviewer cannot be built
- A running session keeps its Linux sandbox when an update replaces its executable before the first sandboxed command, instead of failing to start
- Quitting while an agent or workflow child is still being admitted no longer stalls shutdown for its whole timeout and ends the session cleanly
- A Workflow tool call given an object argument now receives the object itself on the Meta provider path instead of a JSON-encoded string
- Restore readable `/loop 2d` schedule confirmations that explain the monthly restart
- Resumed sessions no longer show finished or cancelled subagent rows
- Background workflows can start after restarting a session without waiting for a new message
- Generated images now save in workspaces on EdenFS or NFS instead of failing with "write failed"
- A hook that already finished keeps its real outcome instead of showing cancelled when the run ends at the same moment
- Keep reported token usage when a background context summary fails
- Enter in `/resume` and `muse resume` no longer opens a different session when the one you moved to drops out of the list while it refreshes; pick again instead
- `tbh exec` rejects an empty `--worktree-existing` instead of silently using the current directory
- Prevent scheduled work from running twice after a storage retry, clock rollback, and session resume
- Fix waits that remain blocked after a nested subagent stops
- Workflow steps can read full results from earlier steps
- Starting or resuming a session through the SDKs no longer drops the events delivered together with the reply
- `view/page` now refuses a child session, or a session that loaded with no live view, instead of slowly rebuilding its whole history; `session/read` still returns such a session without its history, and in Zed a session that loaded with no live view opens with an empty transcript
- The terminal no longer flashes every second while a workflow runs after its progress block has scrolled into history
- `MuseClient.spawn` in the Python SDK now raises `MuseHostStartError`, carrying the host's exit code, the last lines of its stderr, and whether the host had already answered the startup handshake, instead of a bare `ProtocolError` (`connection reached EOF`)
- In Vim mode, a counted search repeat such as `999999n` no longer freezes the composer on a long draft
- In Vim mode, a search no longer matches inside an emoji or accented letter, so `d/`, `c/`, and `y/` never cut a character in half
- Python SDK `on_approval` is asked again when a multi-stage approval moves to its next stage, instead of leaving the turn waiting
- Native subagent results retry cleanly after a temporary session storage failure
- `view/page` again serves a child session, or a session that loaded with no live view, when an earlier build saved its view, so Zed shows that transcript instead of an empty one
- Long turns that finish on their final step now show the final answer instead of an error
- A long-running session resumed above a capable checkpoint floor no longer stops pruning when checkpoint capture is refused; the floor's authority is carried forward into a new prunable checkpoint so the log stays bounded and the session still reopens
- The TypeScript SDK no longer applies events twice when a second gap notice arrives while it is still filling the first
- Sessions with MCP servers keep accepting new turns after their context is compacted
- Long answers no longer wrap a line between inline code or a link and the punctuation right after it
- After resuming a session, the background-command reminder reports the real time since the command last printed output
- The Python SDK no longer applies events twice when a second gap notice arrives while it is still filling the first
- Re-checking a finished background command no longer adds another "Finished" row — repeat polls of an already-reported result stay quiet while still returning the full output
- Show a background subagent's paused, resumed, or redirected state in work status instead of its earlier state
- `MuseClient.spawn` in the TypeScript SDK now says why the host could not start — the missing binary, or its exit code and the last lines of its stderr — instead of a bare `write EPIPE`
- `MuseClient.spawn` in the TypeScript SDK reports the real reason when `muse` answers the startup handshake with a reply the SDK cannot use, such as a version mismatch, and says when the host died after answering rather than at startup
- Sessions left behind by an unfinished `/delete` show up in the session list again
- Background command completion notices that run out of room now say how much of the output is shown and where the full output is saved, instead of silently cutting the end
- Keep images from earlier turns tied to their original message after periodic context saves
- Workflow tasks can continue running commands after background results wake them
- `muse serve` argument errors now use the same wording as the rest of the CLI, repeated `--provider`/`--model`/`--sandbox-network` flags are rejected instead of silently taking the last value, and the attached `-c<key=value>` spelling is accepted
- `/clear` and `/new` keep the prepared session available while switching sessions
- Subagent capacity rejections now say to raise `agents.execution_capacity` in user settings and start a new session
- Restarted sessions stop waiting for message receipts when tracking could not start
- In-app `/resume` keeps showing "Indexing sessions…" after it loads more rows, until indexing actually finishes
- Restore background work status when reopening a conversation
- Resumed sessions keep older background work from replacing newer conversation state
- Interrupting a request\_user\_input card before answering any question now reports no consent in the tool result, so the model stops or waits instead of proceeding with the recommended options
- Checkpoint-covered session mirrors of run starts and user inputs now count against their retention tail, so long sessions stop accumulating them for the process lifetime
- Turning off web fetch in `/settings` no longer also stops the model from checking on background work
- Forking a session now works after a long turn was compacted and then received more of your messages before it finished
- Switching a session to the Auto-review profile is refused when no reviewer can be prepared, instead of committing a profile that cannot run
- Linux sandbox errors now name the rejected helper or Bubblewrap binary and the setup change that fixes it
- Python multiprocessing pools now run inside the macOS managed shell sandbox instead of failing with PermissionError at SemLock
- On a short terminal, a multi-step command approval now keeps showing which step is up and that step's command (cut with … when it is too long), with every choice still visible
- A background child that moved into its own process group (for example under coreutils `timeout`) no longer survives process shutdown or fixed-child cleanup — the exit sweep and the web-fetch child settle now check the leader's whole session before deciding nothing is left to kill
- Subagent worktree creation over serve on hosts without an enforceable creation sandbox now succeeds for trusted workspaces instead of refusing; untrusted workspaces still refuse with the trust-or-sandboxing remedy
- Sessions with MCP servers keep accepting new turns after a later turn compacts the conversation, and a failed MCP link is reported as such instead of as an MCP startup audit failure
- Long mirror sessions no longer stop publishing compaction checkpoints after a few dozen turns: the preserved recent suffix is now capped against the hard context limit instead of growing with the whole history, so each replacement stays small enough to install
- Effort picker and settings cycle offer only the reasoning levels the active model supports
- A chat whose model is no longer offered now stops right away with a message listing the models you can switch to, instead of retrying for several minutes and ending in an internal server error
- Compacting a session that was started in the terminal app and later reopened through `muse serve` no longer fails as if the conversation had changed
- Approval cards on short panes fit the command to the panel so every choice stays visible
- After `/compact`, the compaction now shows as finished only once its own cleanup is done, so a message sent right after "Compacted" is no longer refused as busy by the compaction
- File edits inside a `--worktree` session worktree no longer ask for approval every time — Auto-review now handles them like edits in the main checkout, while the worktree's own `.git`, `.muse`, `.agents` and `.husky` metadata still needs your approval

### Performance {#performance-8}

- `muse resume` lists the sessions Muse has already indexed right away, while it checks the rest in the background
- Long sessions stay responsive as background activity rows arrive, even with many earlier prompts in the session
- With no session index, or one missing many sessions, `muse resume` now lists your newest sessions while it indexes the rest instead of waiting for all of them
- Checking on a session that is not open no longer re-reads its whole saved transcript when nothing has changed since the last check
- Faster startup when a cached model list is available
- With no session index, in-app `/resume` now indexes several sessions at once, so the full list finishes sooner
- Cancelling a command with a large process tree is faster on busy machines because teardown now scans the process table once instead of once per process in the tree
- Session retention cleanup does less background work when many saved sessions are old
- `muse serve` no longer takes tens of seconds to start answering when many sessions are saved
- Long in-progress sessions stay responsive; transcript trimming no longer rescans history beyond its size caps on every frame
- Long tool-heavy sessions stay responsive instead of repeatedly re-parsing earlier tool output

## 1.4.3 {#v1-4-3}

### New {#new-10}

- Session protocol `reminderChild` items carry `blocking: true` when the reminder holds the turn open, so apps can say which reminder the turn is waiting on
- Plugin management is on by default — browse, install, and create plugins from `/plugins`, `muse plugins`, or the Settings Plugins row with no setup
- Each image on a message now carries a stable id apps can use to refer to it
- Set `ca_bundle` to your company's CA file and model providers plus telemetry trust it, so corporate networks that inspect traffic connect instead of failing; certificate problems now report a clear error instead of retrying
- Workflow items served by `muse serve` now report the run's real duration and, for each child that failed, its failure kind and reason
- Session protocol clients can read the hook and plugin catalogs over `hook/list` and `plugin/list`
- A reopened session can show that its last turn failed: `session/resume` and `session/read` now return how the last turn ended, with its error, as `lastTurn`
- Session protocol clients can track hook runs in the session view as hookRun items
- `/resume <id-or-name>` inside Muse Code switches straight to that session, like `muse resume <id-or-name>`
- `muse exec --disable-reminders` runs without reminder agents
- Session protocol serves `turn/foregroundCompleted` when the answer is done but background reminder checks still hold the turn open, so apps can stop showing "Working…" while the checks run

### Improvements {#improvements-10}

- Queued input uses a shared tree with agent names and delivery hints
- When the agent pauses its automatic `/goal` follow-up turns, the goal progress row shows for how long, such as `snoozed 15m`
- `muse exec` and offline sessions using Spark 1.3 contributor now default to max reasoning effort, like connected sessions
- `muse exec` and offline sessions now include web fetch like connected sessions
- Reasoning effort picks are now remembered per model, so switching models restores each model's own saved effort
- `muse trace inspect --causal` shows which model request message contains an installed summary
- Removed the `/delete` command
- HTTPS clients trust your system's certificate store alongside the built-in roots, so corporate networks that inspect traffic connect without extra configuration
- Live watches and realtime connections trust your system's certificate store and honor proxy settings, so corporate networks that inspect traffic connect without extra configuration
- Clarify cumulative token usage and current context estimates in `/status`
- Repeated scheduled-task fires from the same job now show as one summary row instead of one row per fire
- `muse exec --disable-write` and `--disable-shell` no longer offer the disabled tools to the model
- Sessions now report whether they are a top-level session or a subagent, which session a subagent belongs to, and which client opened them, so clients can tell them apart without guessing from folder names
- Exit confirmation now defaults to Exit anyway so Enter confirms the exit
- Rewind can again reach the earlier turns of a long session after its automatic history checkpoint, with the same history the branch would have had without the checkpoint
- Ephemeral `muse serve --no-session-log` sessions can now change approval modes freely during a session (switching to or from "always allow" and the other approval modes is no longer locked to the mode the session started with); managed policy still applies
- The queued-input panel now shows `↑ to edit` when pressing Up would pull your queued messages back into the composer
- The session protocol no longer offers `session/delete`; a client that sends it gets a method-not-found error
- `work_status` reports running and terminal states for background monitors and shows naturally completed native subagents as paused with a result ready
- `muse serve` clients can steer a skill into a running turn by sending its skill part to `turn/start` with `ifBusy: "steer"`
- While a turn is running, a skill typed or picked in the composer now steers into the turn with Enter or waits for the next turn with Alt+Enter, instead of being refused
- While a turn is running, Tab now queues your message for the next turn and Alt+Enter inserts a new line, so Alt+Enter works the same in tmux whether or not a turn is running; with nothing to queue, Tab inserts a tab. If you set your own `composer.newline` keys, add `alt+enter` to keep it as a newline

### Fixes {#fixes-10}

- **Security:** Worktree creation from untrusted sources runs sandboxed and refuses when no sandbox can protect it
- Recover the latest hook-blocked prompt when new input arrives as a run finishes
- Pressing Ctrl+C to clear a draft now also removes its pasted images and videos, so a new video can be pasted right away
- Switching sessions with `/resume` no longer freezes on "Restoring conversation" until the next keypress
- TypeScript SDK connections no longer retain every command payload in memory
- TypeScript SDK no longer opens a console window when it starts on Windows
- A pasted video whose upload stalls now times out and retries instead of hanging the turn
- The terminal no longer flashes each time a running workflow reports progress
- Workflow progress, completion, and save-as use recorded names and hide anonymous internal identifiers
- The session list orders by latest activity, so reopening a session no longer moves it to the top
- `/goal` works in a session that was interrupted before its first goal, instead of failing with a goal-store custody error
- After you answer an approval, Esc and typing no longer reopen it and fail with "approval decision failed" while the prompt is still closing
- Load ancestor project rules in Sapling repositories
- Subagent nudges and close-outs keep working after a session resumes from a checkpoint
- `muse resume` recovers sessions with very large saved snapshots
- In `/resume`, rows you scrolled past stay in place when other sessions change; a note says when sessions changed above, and moving back to the top shows them
- Accepting the workspace-trust prompt during `muse resume` no longer leaves a blank terminal — the startup progress row stays visible through the post-prompt load instead of going dark until the transcript appears
- Model timeout error no longer blames your local network when the service does not respond
- A rejected turn or steer replayed after a session resumes answers the recorded rejection instead of being re-judged, and a new turn can no longer start under a rejected command id
- Sessions with a damaged view stay usable and report history as unavailable instead of failing with an internal error
- Recover the latest hook-blocked prompt when older queued inputs share its text
- A model request stuck on a failing server route now moves to a fresh route after three server errors instead of retrying the same route ten times
- Max reasoning effort now shows for settings-listed models that declare it
- Muse now starts when a project or home folder has a plain file named .agents, .codex, or .claude, skipping that skills location instead of exiting with "Not a directory"
- After a restart, approving a re-presented ordinary approval now runs the tool exactly once instead of accepting but doing nothing; denying still never runs it
- After a restart, a fresh protected review stays pending for a connected reviewer until they decide it instead of aborting before the first `approval/listPending`; a resume with truly no reviewer still aborts fail-closed
- Resume recovers sessions that previously stopped with a permission recovery error
- Preserve a forked session's checkpoint state after reopening
- Ctrl+C and Ctrl+D in a side chat now return to the main chat instead of quitting the whole session, and the side status row says whether the key stops the running side turn or returns
- A finished run no longer freezes the session while it tidies up its compaction summary in the background, so the command that ends the run stops timing out
- Resuming a session no longer fails while background indexing reads it, and the already-open error no longer names a program that already exited
- `muse serve` rejects a session start whose saved default profile needs an automated reviewer this host does not have with a clear `permission_profile_reviewer_unavailable` reason instead of an internal error
- `/feedback` upload failures now show the server's reason instead of only the status code
- After a resume falls back to a recovery checkpoint, earlier chat history stays visible instead of the conversation looking empty
- A named toolset (`run.toolset`) can now select MCP tools by their full name, such as `mcp__docs__search`; if a selected MCP tool is still missing after the MCP servers start, the run stops before contacting the model and lists every missing name
- The warning for a plugin blocked by changed cache files now names the changed or missing files and says to update or reinstall the plugin
- `muse plugins approve <plugin-id>` succeeds for an installed plugin that has nothing to review
- Sessions whose saved history view was written by an older build and could no longer be restored now rebuild it from the session log on resume, instead of showing history as unavailable on every load
- Reopening a session that contains a record written by a newer version now shows the rest of its history instead of an empty conversation
- Claude plugins with hooks that set `asyncRewake` or `once` now install, skipping just those hooks with a warning instead of refusing the whole plugin
- A plugin whose cached files are missing or damaged no longer blocks installing or updating other plugins; Muse warns and names the `muse plugins update` command that repairs it
- Reading a large image file no longer sends the model a copy several times bigger than the file
- When a trusted project folder cannot be verified, the MCP startup error now names that folder and the reason instead of blaming a missing `.mcp.json` file
- "Loaded skill" now appears only when a skill is actually loaded, not when its text just shows up in a message, a tool output, or another skill
- Let large sessions carry pending results before compaction when the complete request fits the configured context budget. Manual compaction now explains when pending results need a completed model turn first
- Claude plugins whose command files use capital letters, such as `reviewPullRequest.md`, now install, and each command runs by its exact name
- Plugins that list other plugins they depend on now install instead of being refused, and `muse plugins validate` and `muse plugins install` show whether each of those plugins is installed and warn about the missing ones
- `/name` explains why session naming is unavailable and how to recover
- A settled approval in an open session now points at the same place in its history as the session's saved view, on any machine
- A served session resume that your permission policy blocks now explains it was refused by permission policy and how to recover, instead of wrongly telling you to retry on a compatible host
- Starting inside tmux no longer hangs before the first screen when a tmux query does not answer
- Resuming a long session that keeps receiving subagent or background notifications now starts from its latest compaction instead of rereading the whole session log
- The todo list above the prompt stays visible between runs while a scheduled task is still active, instead of disappearing after each run and reappearing at the next one
- Resuming an empty session no longer shows a false crash warning
- Reopened SDK sessions keep the Workflows setting and can run workflows; sessions restored from compaction or periodic checkpoints can also be renamed
- Model failures now suggest checking service status and retrying
- Side chat no longer refuses to start on compacted sessions
- Staged work keeps a todo item for each named stage and checks it off when tool output proves that stage landed, so the visible plan no longer stays on a finished stage
- `/exit` typed right after a Workflow launch now asks before quitting instead of exiting without the confirm and abandoning the run
- Ephemeral `muse serve --no-session-log` sessions with a configured permission profile now honor approval-mode changes during the session (switching to "always allow" takes effect for the next action instead of still asking); on those configured ephemeral sessions a native auto-review child inheriting a managed prompt reservation is now refused like the session's own actions, while durable sessions and profile-less hosts keep their existing child behavior
- `muse resume` no longer refuses a session after you pressed Esc on a turn that had just compacted; that Esc now stops the turn and keeps your message instead of putting it back in the composer
- Opaque workflow child failures now report their specific error kind
- A message sent while a background compaction is wrapping up now starts after it instead of being rejected with "the runtime is busy"
- Keep the Sent marker visible when a session message's delivery is unconfirmed
- Keep images available when compaction removes a video from the current turn
- Preserve work-stop notices when a session is interrupted
- Pasted text that arrives in split terminal reads collapses into one placeholder instead of stranding leading characters outside it
- Feedback can now be sent with no session open
- Plugin tools can show their own running and completed names. Image generation now shows Generating image and Generated image, while image editing shows Editing image and Edited image
- Background message tasks stop polling for unsupported delivery receipts
- Stopping your own background Bash task with `work_stop` now settles the transcript row to the task's real ending (for example `Stopping work — cancelled`) instead of leaving it as `unresolved — manual reconciliation required`
- Reconnecting to an open session from a machine with different settings now replays its history with the same numbering as its saved view
- Report the full wait in model failure summaries instead of starting the clock at the first failure
- Let stopped subagents finish cleanup when cancellation is recorded by their parent
- Zero-byte model responses now preserve the final attempt request ID
- `/clear`, `/new`, and in-TUI `/resume` no longer crash with "old runtime did not stop within 2s" on slow machines — the new session appears right away while the old one finishes saving in the background, and you get one notice with the old session's resume command if that save does not finish cleanly

### Performance {#performance-9}

- Shutting down many stdio MCP servers at once no longer stalls: they share one scan of the process table instead of each scanning every process on the machine
- `/resume` lists saved sessions right away while the app indexes new ones in the background, instead of reading them all first
- `/resume` in the default app lists sessions from one background indexer, newest first, as it writes them, instead of reading every session log again
- `/resume --last` and `/resume <name>` no longer reread every saved session once Muse has indexed them in the background
- Long sessions use less peak memory per model step: building the provider request now moves the message history instead of copying it, cutting the per-step spike that grew with history length

## 1.4.2 {#v1-4-2}

### New {#new-11}

- `/delete` asks before removing the current session and its child sessions; video-enabled sessions and sessions with unverified log ownership are kept with an explanation
- Background Bash commands return a Work ID so agents can stop the command
- Muse session protocol clients can grant several workspace roots at once — `session/start` and `turn/start` accept a `workspaceRoots` list of absolute paths; every listed root gets the same write access as the primary root, and a `turn/start` list replaces the set for that turn and later turns
- Added `muse voice transcribe <file>`
- Added `muse model-profile show <model> --effort <level>`, which prints what a model actually resolves to for each setting at that effort level
- `session/list` accepts an optional `filter` that narrows the list by session ID, branch, or name and title words, and echoes the filter it applied as `appliedFilter`
- The TUI serve lane honors several workspace roots at once — every listed root gets the same write access as the primary root, each extra root's own rules file loads under that root's recorded trust, and the system prompt names every root; extra roots never gain project trust
- `muse serve` accepts feedback submitted by connected clients
- Choose the provider and model for one `muse serve` process with `--provider` and `--model`, without changing saved settings

### Improvements {#improvements-11}

- The `model/list` described-level schema type is now `ModelDescribedReasoningEffort`, and per-level `description` is omitted when the catalog declares none
- Subagent-tree live rows now breathe color smoothly — the ◆/◈/◇ glyph brightens and dims smoothly instead of stepping through a few held shades, matching the resume startup row
- A follow-up sent while your lane is still busy gets an immediate "Received, on it." instead of silence until the current step ends
- Show alt(option) in tmux shortcut hints and explain Mac modifier names in shortcut help
- Automatic history-preserving checkpoints every 16 MiB of session log are now off by default while their follow-up fixes land; set `context_compaction.periodic_checkpoint_bytes` to a positive byte count (for example 16777216) to opt back in, and compaction checkpoints are unaffected
- Retry stalled model responses through the remaining attempt budget
- Verify reminder no longer accepts a scoped "not run" disclosure as cancelling a done or fixed claim, lint alone as the covering gate when a test exercises the change, or "cannot run here" without a failed attempt to acquire the runtime or device (install, lease, launch)
- Grill uses available project checks to focus follow-up questions
- The full-screen monitor view shows the command or script the watch runs, with secret values masked
- The rewind picker shows turns older than the live window as read-only history
- Idle composer tips can now suggest using a workflow or asking the agent to monitor a long-running task
- Compaction now shows `Compacting context` while running and `Context compacted` when done
- While working on a `/goal`, the agent can pause its automatic follow-up turns for up to an hour while it waits on a background command or monitor, instead of checking again and again; the completion notice or your next message resumes the goal at once

### Fixes {#fixes-11}

- **Security:** Subagent worktree git probes and cleanup dirty checks now run in the actor-confined sandbox, so hostile repo config in an agent-writable nested repo can no longer execute filter commands on the host. When the sandbox cannot be created, cleanup keeps the worktree for inspection instead of deleting it
- Keep human messages that match generated summaries when replaying compacted conversations
- Recover session name changes from saved checkpoints
- Long sessions with a background monitor, running subagents or many open tool calls keep their live view history up to date instead of freezing
- Keep previously completed Workflow indicators from reappearing when a session resumes
- Ignore saved work-stop notices linked to a different session when resuming
- Rejected peer messages no longer appear delivered or read
- Completed message batches with invalid results show an unresolved status, consistent with message headers and groups
- Lost task-stop confirmations no longer appear as a disconnected session
- A subagent's final result stays visible in its detail view instead of briefly disappearing while the view refreshes
- Unstarted subagents from older sessions without saved execution state are now marked failed after a restart instead of staying scheduled forever
- Prompt Hint now sees the full conversation instead of only the last turn, Away Recap has its own session cache key, and side-call model requests carry a purpose label so they are no longer mistaken for the main conversation in session records
- The verify reminder's checker now keeps its fixed `high` level only on the Muse Spark 1.3 models at `max` effort — the configuration that level was actually measured on. On any other model, a session at `max` now gets a checker at its own level instead. This mattered because `max` can be reached on models that do not offer it in the effort picker: a stored setting or an effort carried across a model switch all keep `max`, and those sessions were being checked with a level tuned for a different model
- `muse exec` exits with the run's own result when post-run cleanup stops responding, instead of failing a completed run
- Long reasoning turns are no longer cut off by the stream idle timeout while the model is still thinking
- A finished subagent now shows above the agent's final reply in the live transcript, matching a resumed session
- Restore recorded workflow completion and cancellation status when resuming a session
- Stopping a watch shows one completion with its reason available in expanded details
- Prevent `work_stop` from leaving the session waiting after a subagent's background tools stop
- Keep repeated and queued messages distinct when continuing a conversation
- Long sessions no longer fail every later turn with `Duplicate function_call_output` after an automatic context checkpoint
- A session being deleted no longer appears in the session list while its removal is still in progress
- Images read with `read_file` are re-encoded when over 2 MiB and requests keep image payload under a budget instead of failing with HTTP 413
- `bash_input terminate` on a background command that carries a v2 Work ID now stops it (or returns its finished result) instead of failing with a Work Stop contract violation
- Reopen saved sessions without losing their original checkpoint capture choice
- Stop child agents consistently from tool requests and confirmed item or bulk actions
- The `/model` flow no longer flashes the bottom status bar between the model and reasoning-effort pickers, and the reasoning-effort picker no longer repeats a hint line on the selected row
- Keep restored workflow messages in their original conversation positions after session resume
- Workflow stop receipts show cancellation after the workflow stops
- A turn that includes a video input no longer fails with an invalid-checkpoint error when an automatic history-preserving checkpoint comes due; the checkpoint is skipped with a recorded reason and the previous one stays in place
- Changing the Workflows setting between sessions is announced to the model on the next turn even when the session resumes through a checkpoint
- `--model` now accepts the name shown in the /model picker and resolves it to that model's gateway id instead of failing with "model does not exist or you lack access"
- Detail lines under the Thinking and Working status now start their connector under the status diamond instead of under the status text
- Sessions no longer become unresumable when a checkpoint grows past the resume reader's size limit; the oversized checkpoint is skipped and the previous one stays in use
- Resuming saved sessions now restores missing conversation history
- Pending approvals listed for a session that is not open now point at the same place in its history as the session's saved view, on any machine
- Sessions no longer exit silently at startup on terminals that never answer the cursor-position query
- Preserve saved subagent stop results when retrying older long request IDs
- Peer messages that cannot start a turn now show as parked until your next turn in the queue instead of looking stuck
- Messages and follow-up instructions sent on later turns reach the original running subagent
- A finished background result no longer stays hidden behind a stuck "Working" indicator when a new prompt lands as the previous turn ends
- Use Up or Ctrl-P to recall a hook-blocked prompt while preserving your current draft
- Oversized tool-call identifiers return a retryable error without interrupting other tool calls
- Keep credentials in macOS Keychain across updates
- Installing a plugin from `/plugins` now finishes on the plugin's own page with an "Installed \<plugin> plugin." note instead of an extra screen, and Discover marks installed plugins so Esc takes you back where you started
- When a checkpoint cannot be saved, the turn keeps going from the previous checkpoint instead of failing with `invalid context projection checkpoint`; the refused checkpoint leaves nothing behind for a later read or resume to trip on
- Starting a session with a chosen id no longer fails with an id conflict while the host is cleaning up an unused session directory for that id
- A clean session end no longer fails on a slow disk while shutdown time remains; the final log flush now uses the whole shutdown window instead of a fixed ten seconds
- Reject new managed-work batches above the session limit while preserving existing work status and controls
- The monitor view's command line keeps the rest of a command after a masked value that is glued to a separator
- A session id carried in a web address (jsessionid or sessionid) is hidden like other address credentials before text reaches the model
- Monitor commands with non-ASCII web addresses no longer crash the task view
- Pasting a large block under load no longer occasionally strands its first character outside the collapsed paste placeholder
- Keep subagent follow-ups working after resuming a session whose latest checkpoint was written with capture enabled, instead of failing the send with a session-read error
- Setting a goal right after resume no longer fails with a goal-store custody error while the previous session-log write settles
- Preserve original instructions across context compaction
- Session views stay readable while the server cleans up old sessions
- Resuming a session after an automatic context checkpoint keeps its todo list, so the todo reminder and later compaction summaries show the accepted items instead of an empty list
- An automatic history-preserving checkpoint (opt-in via `context_compaction.periodic_checkpoint_bytes`) now carries the reminder budgets inherited from earlier turns and waits for a turn's first model reply before publishing over an undelivered message, so the next turn keeps its due reminders and never compacts away text the model has not seen
- Turns under the denyUnmatched approval mode no longer hang for about a minute after the answer is done
- Switching sessions no longer fails when the previous session is slow to shut down
- Scrolling back through an open session whose saved history stopped updating no longer shows running work as failed; loading history newer than the last save now fails with an error instead
- Resuming a session after an automatic context checkpoint no longer re-records a skill you read earlier or changes the skill reminder's view of it
- Keep loaded skill instructions when trimming old tool results
- Reopen a session whose newest checkpoint cannot be replayed, instead of failing the whole open
- Reconcile a saved reasoning effort against the selected model instead of failing the launch when the model does not serve it
- Approved peer notifications wake idle agents by default and respect explicit delivery and wake settings
- Resume workflows from the session copy you opened instead of a stale source path
- `serve --no-session-log` sessions now emit live frames — `turn/started`, `turn/completed`, `session/statusChanged`, item events, and `approval/request` presentation — instead of acknowledging a turn and going silent; approvals parked under the profile's prompt-unmatched ceiling become visible and answerable
- Let a resumed session send a follow-up to its dormant subagent after a periodic checkpoint instead of failing the send and repeating the subagent's earlier result
- Resuming a session in the terminal app after its context was compacted delivers, exactly once, the messages from other sessions that were accepted but not yet delivered before the compaction
- Work status reports when background Bash commands finish
- Apps connected to `muse serve` can show a manual compaction as running while it runs, not only after it finishes
- Start sessions when the app data folder is group-writable

### Performance {#performance-10}

- Scrolling back through a session that is not open reads its saved view instead of rereading the whole session log
- Long sessions with large retained task failure messages no longer re-copy that text on every refresh
- Finishing background commands and monitors no longer rescan the whole transcript in long sessions
- /fork no longer stalls on large session stores
- Refreshing a session with a generated workflow child no longer rereads and rebuilds all of its settled task history on every refresh, so long workflow sessions stay responsive
- `/resume` and `muse resume` find new sessions already listed, so they have less to catch up on when they open
- Repeated scheduled prompts can use less space when created and delivered within the same run before compaction, while keeping distinct occurrences

## 1.4.1 {#v1-4-1}

### Improvements {#improvements-12}

- `model/list` rows now carry each model's described reasoning-effort levels (`reasoningEffortVariants`, with the catalog's per-level display strings) and the row's catalog default (`defaultReasoningEffort`), so Muse session protocol clients can render the effort picker without guessing
- Expanded peer message rows show readable message details instead of internal status fields
- Forking shows a progress status in the chat until the new session is ready

### Fixes {#fixes-12}

- A long session keeps its live view running when view checkpointing falls behind, instead of going dark
- Unknown peer message results stay unresolved instead of borrowing a known delivery status
- After a crash and reopen, a re-asked tool approval shows the arguments the model wrote again, not the runtime's internal version of them
- Scrolling back through a session while a turn is still running no longer shows the running tool call as failed
- Sessions below `max` effort, and every model other than Muse Spark 1.3 at `max`, get the fuller system instructions back — including the verification, evidence, and professional-objectivity guidance — while Muse Spark 1.3 at `max` keeps the trimmed version. Later formatting and summary improvements are kept in both
- Stop failed session recovery from incorrectly quarantining pending subagents
- Sessions on the Muse Spark 1.3 contributor model now get the todo, memory, and goal reminders below `max` effort, matching the other 1.3 models
- Interrupting, cancelling, unqueuing, compacting, or steering a turn from an older session, or one the server started itself (Goal steps, reminders, scheduled runs, queued follow-ups), no longer fails with `invalidParams`; IDs the server creates for turns and approvals are now UUIDv7
- Repeating `work_stop` for a stopped subagent reports its terminal state
- Support `Ctrl+J` for newlines in feedback and editor inputs
- Use `Ctrl+Alt+B` to background commands when tmux intercepts `Ctrl+B`, with matching shortcut hints
- Keep task controls scoped to the selected session, including after recovery
- Preserve each user input's identity when restoring compacted context
- Completed Workflows show one accurate status and keep the full result available in details

### Performance {#performance-11}

- Long sessions with many completed workflow-child tasks stay responsive instead of re-scanning retained task history on every child update
- Long-running sessions stay responsive when the task list refreshes

## 1.4.0 {#v1-4-0}

### New {#new-12}

- Session protocol clients can list a session's invocable skills with `skill/list`, receive `skill/changed` updates, and invoke a skill directly through a `turn/start` skill input part
- `muse serve` clients receive live session status changes and an attention flag when a session has a pending approval or input
- The serve protocol can now report your remaining subscription usage on demand — `usage/read` returns the last-seen 5-hour and weekly windows without spending a prompt, and `usage/changed` pushes updates when they move
- Ctrl-R prompt history search gains a per-gesture scope: `Ctrl-S` cycles this session, this project, and everywhere, with the scope shown in the search row
- Save MCP tool and network destination approvals across sessions with Always allow
- Continue local Claude Code or Codex sessions with `/resume-claude` and `/resume-codex`
- `/plugins install` accepts `--scope user` or `--scope project`, so a local plugin can be installed for the project instead of only for you
- `muse serve` now pushes a best-effort `session/viewHealthChanged` notification when a session's live view becomes unavailable, with the reason, so clients need not wait for their next read to learn it
- Set `MUSE_SKIP_PROMPT_HISTORY=1` to stop saving new prompts to history; prompts already saved still load and recall normally
- The Errors tab's detected-plugin row now asks before installing a detected plugin, instead of installing it the moment you press Enter
- The exported session protocol schema now describes the `task/background`, `task/stop`, and `task/stopAll` commands
- Choose a local Claude Code conversation in `muse resume` and continue it in a fresh session
- Choose the Codex source in `muse resume` to continue a local Codex conversation in a fresh session
- A hook can declare an `onFailure` fallback — when the hook fails (non-zero exit, timeout, or invalid output), the declared successor runs as an ordinary hook at the same event and can ask for your approval; a successor can never loosen a decision, widen the original tool call, or grant approval itself
- Choose a local Claude Code or Codex conversation in `/resume` and continue it in a fresh session
- `/permissions` (choose what Muse Code is allowed to do) is listed in the slash palette, Help, and inline completion instead of being hidden
- Install the Python SDK from PyPI — muse-code-sdk and its wire-types companion muse-code-msp
- Resume a session by its exact Session Name with `muse resume <name>`
- Native subagents whose spawn result shows a Work ID can be stopped with `work_stop`
- Choose which fields appear in the bottom status bar with `/hud`, with live preview and saved preferences
- `muse exec --output-schema <FILE>` makes the final answer schema-shaped JSON by sending the file's JSON schema with the request (Meta provider; other providers refuse the flag at startup)
- After a failed tool call, a `PostToolUseFailure` hook (or a failing hook's `onFailure` successor) can propose a corrected call through `updatedInput`; the correction re-runs as a new call through hooks, policy, and approval, bounded by the declared `onFailure` chain depth
- Session protocol clients can opt in to a live session-list stream — request the `sessionListStream` capability at `initialize` to receive `session/listChanged` with the updated row instead of re-polling `session/list`
- Sandboxed Bash commands on macOS can request one-time approval to connect to specific Unix sockets
- Plugins that declare Claude-format agents now install and publish those agents as reviewable Agent Definitions, and unsafe or duplicate agent declarations are rejected at install instead of being silently ignored
- `resume <id> --no-session-log` replays a saved session read-only and says up front that nothing is being recorded; `resume --last` and the startup picker still need session logging
- Preview pending agent messages above the composer with sender labels
- `plugins inspect` shows a Claude plugin's agent inventory with each agent's review status, and keeps showing it after the plugin's source files are removed
- `/rename` aliases `/name`
- `plugins approve` and `plugins reject` accept plugin agent selectors and persist review decisions safely
- Native subagents can now be inspected with `work_status` using their Work ID; the status shows their spawn-time state
- The TUI Plugins screen shows each Claude plugin's agent count, one row per Agent definition with its review status, and the passive Agent inventory alongside the live package review
- Review pending plugin hooks at startup, with options to trust them or continue without approval
- Claude plugin command and skill `allowed-tools` declarations can now be reviewed in plugin review, and an approved declaration skips approval prompts for matching tool calls while that command's or skill's invocation turn is live
- Switch between the main conversation and a side chat with `Ctrl+/` without losing drafts or interrupting either run
- Added an observation-only `Interrupt` hook that runs when you cancel a turn with Escape
- `/bug` reports a bug with the type already selected
- Use passive FTP from sandboxed commands with network approval
- The exported session protocol schema now types the `session/started` and `session/closed` lifecycle notifications, so generated clients decode the first frame a session broadcasts instead of hand-parsing an untyped payload
- `/models` picker now offers a reasoning-level step right after each model switch
- Renaming a session now pushes the updated row to `session/listChanged` subscribers — your own accepted `session/rename` streams instead of waiting for the next `session/list` poll
- Press Delete on a supported settings row (`/settings`) to reset it to its default — the saved choice is removed and the setting returns to what it would be without it (some rows take effect next session; rows without a reset say so)
- `/copy` now opens a scope picker over the last response when it contains code blocks or ran shell commands, so you can copy the full text, one block, or one command; Enter copies, `w` writes the focused item to a file, and the Always row (or the new Copy full response setting) skips the picker from then on. `/copy N` targets an older response
- `muse resume` and `/resume` now list sessions with a damaged log by their ID; choosing one starts a new session that continues the work from that log, which is left unchanged
- Inspect recorded cross-agent links with `muse trace inspect --session-log --causal`

### Improvements {#improvements-13}

- The startup resume picker's "session already open" notice now names the process holding the session (pid, host, and lock age) and, when that process is on your machine and still running, shows the exact `kill` command to free it
- Prompts saved by earlier versions and prompts from other projects no longer show on Up/Down; find them with `Ctrl-R`
- Up/Down prompt recall shows only prompts from the current project, starting with this session's
- Todo, memory, and goal reminders are on by default only in muse-spark-1.2 and muse-spark-1.3 sessions below `max` reasoning effort, and off by default elsewhere
- Muse now gets guidance for saving your first memories and importing local Claude Code or Codex memories
- Subagent results report their working folder, starting commit, excluded parent changes, and cleanup status
- Image and video attachments now keep numbered references across prompts and replay
- `@muse-code/sdk` now versions in lockstep with Muse Code, so the SDK version matches the release it ships with
- Voice input is enabled by default on Windows x64 and ARM64
- `muse exec` reports retained subagent workspace paths and setup or cleanup failures on stderr
- `/upgrade` and subscription quota guidance are now available to everyone without a launch flag
- New subagents receive explicit guidance to follow parent task updates within the user's constraints and their existing permissions
- Align `/usage` card styling with `/status` and `/mcp`
- Running `resume` with `--no-session-log` now says the flag turned session logging off, how to resume, and that sensitive-mode launches always set it
- Live tool activity uses the same pulsing diamond as Thinking
- When the skills catalog must compress entries to fit, compressed skills keep their short description, plugin and prompt-named skills keep full detail first, and the catalog and `/skills` say how many entries were compressed
- Agent tree commands now reject non-sound ancestry while keeping healthy branches controllable
- Preserve shell output colors in `Ctrl+O` and `!` commands on supported terminals
- `/resume-codex` and `/resume-claude` ask which session to resume when no session ID or log path is given
- Show context Warning/Blocked alarms as a percentage whenever the provider's context limit is known
- Subagent views show workspace paths, base commits, and cleanup status, including after reopening a session
- Claude plugin skills that declare `allowed-tools` now load with plugin status `partial` and a compatibility row for `allowed-tools`; a malformed `allowed-tools` value rejects the plugin
- Work status results show a plain-language summary instead of raw JSON
- Workflow results show where child tasks ran and whether their workspaces were kept, removed, or could not be cleaned up
- The built-in grill skill credits the upstream skills it adapts, and the core plugin ships their MIT notice
- Recover prompts cleared with `Ctrl+C` from prompt history
- Recurring scheduled prompts give the agent an expiration countdown on their final three runs
- Built-in capabilities activate without asking for review
- Foreign hooks only ask for re-review when their own command or script changes
- Whole-plugin `plugins reject <plugin-id>` reports how many trust rows it disabled instead of listing each capability
- Keep pending peer-message sends running in the background after the initial wait
- Feedback reports can include redacted local trace files after you approve file attachments
- `/stop` and Tasks Stop actions now use the same durable Work Stop path for workflows, background commands, and monitors
- Avoid repeated plugin hook approval after script-only or metadata-only updates
- Clarified Name and Description in `/name` help and resume search
- Quota in the HUD no longer shows a `(stale)` suffix
- Keep later session message status updates in the sender's conversation without repeating the original message
- SDK clients can discover each model's supported reasoning-effort choices
- Vim composer editing is available; turn it on for the session with `/vim` or persist it with `tui.editor_mode` set to `vim`
- `/plugins` no longer lists the TBH Reminders row — bundled reminders run invisibly like every other builtin
- Message results show receipt details alongside the send outcome
- The `monitor` tool is now available by default
- `/skills` list rows for third-party skills show a short source tag (e.g. `[x] threejs · threejs.org`), and `skills inspect` reports the skill's `source` and `license`
- Built-in grill skill ships cleaner instructions with corrected upstream credit
- Long assistant answers now show up to 300 lines before folding behind `ctrl+o`
- Session Name lookup reports former names as unknown and lists affected UUIDs in recovery errors
- Startup memory summary keeps more of your saved notes before trimming
- MCP plugins can declare literal environment values and named host variables
- Plugins with up to 20,000 files and folders now install instead of refusing over 4,096
- Prompts with many media labels, malformed markers, or unpaired marker text are scanned in one forward pass instead of repeatedly searching the remaining prompt, so composer history, launch, and retraction stay responsive on long prompts
- When asked for a short summary, the agent names user-visible features and stops — no run instructions, ports, file inventories, or version strings
- Plans stay in chat and clearly tell you how to start or revise the work
- Allow sessions to share the same name
- When a file edit finds no exact match, the failure now names where the snippet appears at a different indentation and by how much it is shifted, so the retry can be issued with the file's own indentation instead of guessing
- New sessions at `max` effort now allow 64 concurrent agents including the main agent, matching `ultra`; set `agents.execution_capacity` to keep a smaller pool
- Resume search now matches the Settings input, with a visible cursor and the end of long searches kept in view
- Pasted text now searches sessions in both `/resume` and the startup resume picker
- Submitted prompts appear dimmer while held above the composer awaiting a response
- The resume startup progress row (muse resume) now breathes with a ◆/◈/◇ diamond glyph (like the working-activity row) instead of a braille spinner, brightening and dimming smoothly with the breath
- Subagent, workflow, and background terminal rows in the session tree now breathe with the diamond activity glyph instead of a braille spinner, and finished rows show a static diamond in their success or failure color

### Fixes {#fixes-13}

- **Security:** When `settings.json` cannot be read, feedback and diagnostic upload stay off instead of turning back on over a saved opt-out
- **Security:** Prompts carrying a credential in a recognized format — a token with a known vendor prefix such as `sk-` or `ghp_`, credentials in a URL, an `Authorization:` header, a private key, or `/login` with its argument — are no longer saved to prompt history or offered by recall; prompts saved before this change are unaffected
- **Security:** The local prompt-history file and its lock file are now created owner-only, so the workspace paths and session ids recorded beside each prompt are not readable by other accounts on a shared machine; a history file that already exists keeps its permissions until the store is next rewritten at the entry cap, when the owner-only replacement takes over
- **Security:** Plugin agent definitions now bind the plugin package contents into their review approval, so a previously approved agent shows as modified and stays inactive until you approve it again in the plugins drawer
- **Security:** Background Git status checks now run inside the sandbox, so a program named in a workspace's Git configuration cannot change files on your machine or reach the network
- **Security:** Plugin agent definitions are no longer loaded from a stale or tampered installed record; a stale record asks for a plugin refresh and a tampered one is refused as an inventory integrity failure
- **Security:** `MUSE_TRANSPORT_TRACE` no longer prints your API bearer token when a request is retried after the credential refreshes
- **Security:** Windows sandbox Root:Read now grants the sandbox group read-only access through an optional background worker; existing write, credential, token, desktop, Job and network limits remain
- **Security:** The Linux sandbox now drops every capability before running a command, so sandboxed code can no longer unmount the sandbox's own protective mounts
- **Security:** Subagents keep their admitted permission authority as a ceiling. A committed human mode change reaches running subagents at their next action in either direction, but never widens one beyond that ceiling; a request already pending keeps its captured posture
- **Security:** Sapling repository commands now run inside the sandbox, so a `[hooks]` entry in a repository's own config can no longer execute unconfined when a workspace opens
- **Security:** Limit TCP network approval rules to the exact host and port
- **Security:** Redact credential-like values from provider error request and trace IDs
- Keep the todo list up to date when long sessions compact older context
- Active goals keep making progress after a mid-run update instead of stalling
- A command that reaches a session just as it stops now fails cleanly instead of waiting forever for its reply
- A video attached to a model that cannot accept video no longer breaks the session with a repeating API error; the video is skipped with an inline note and the conversation continues, including for sessions already stuck before this fix
- A resumed workflow that replays its previous result now settles the workflows row instead of spinning forever
- Collapsed tool headers fit narrow terminals while keeping reminder and goal outcomes visible and marking shortened text with an ellipsis
- Improve recovery of queued subagent messages after interrupted session saves
- Completed subagent command rows no longer reappear when switching between Main and child views
- Subagent commands accept requests containing extra fields
- Forking preserves user messages when the initial prompt changes after a reminder
- A session started while the session-name registry is briefly locked still gets its name once the lock clears
- Context compaction no longer reports you as logged out after `/login`
- Skills opened with `read_skill` now show their folder location, so helper files open on the first try
- Errors for invalid subagent tool lists explain the cause instead of suggesting an ineffective retry
- Pressing `p` to resume a paused Workflow no longer answers "resume handoff unavailable" when the monitor still holds a stale stop snapshot; the typed resume handoff reaches the runtime
- Allow `git init` on Windows around empty `.git` directories while preserving protected metadata and existing access denials
- Goals recovering after a restart keep the finished update instead of starting it over
- Preserve conversation output when loading history needs a retry
- Memories saved after a session starts, on this or another device, now show up in that session at the next turn instead of staying hidden until restart
- Pressing Up to recall a very large prompt from history no longer floods the composer with the whole text — it comes back as the same `[Pasted Content N chars]` placeholder a fresh paste shows, and Enter still sends the full original prompt
- When your saved prompt history cannot be read, the footer now says so and names the file instead of starting up as if you had none
- Sessions whose history view was poisoned by a since-fixed defect recover on the next open instead of staying empty
- Trusted project `.mcp.json` files now load MCP servers and override user settings
- A command still waiting for its acknowledgement when a session stops now fails at once instead of waiting out its whole budget
- A session without a resolved model (for example a first run without a plan) now fails each prompt with a clear "no model configured" message instead of sending an invalid request and showing a provider 400 error
- Show recovered task failures in the session timeline after restart
- `read_skill` no longer fails with unknown-skill after a plugin is installed or updated from another terminal; the session picks up the current packages on the next prompt submit
- Retyping a prompt in a different project saves it to that project's history instead of silently dropping it
- Keep subagent cancellation retries scoped to their original parent session after restart
- `/new` and `/clear` start the fresh session with the `/effort` level in force when you typed the command
- A failed `muse exec` run now shows the recorded reason on its final stderr line instead of a generic exit message
- One malformed model catalog row in settings no longer hides every model of that provider
- Context compaction preserves the todo list across turns
- Restore queued subagent input state when resuming from a checkpoint
- Resuming a workflow now keeps healthy tasks available when one task has invalid recovery state
- The TypeScript SDK declares `@types/node` as an optional peer dependency, so package managers surface the types install strict consumers need instead of missing-type errors
- Explicit tool selections consistently limit the main conversation's tools
- A session no longer becomes permanently stuck after the model tries to call a tool that is not available; the invalid call is automatically corrected on the way to the model and the session keeps working, with no conversation history removed
- Manual and automatic context compaction work after multiple tools run together, including after restarting a session
- Keep emoji and joined text intact in terminal tab titles
- Workflow child activity appears reliably when a child run starts
- Resuming a rewound conversation no longer sticks the footer on the tasks-still-running warning once the original session has ended with no live tasks
- Preserve working directory context for pending tool approvals and their hooks
- Pasting Windows image paths with spaces creates an image attachment
- `/goal set` issued during a run that is then cancelled delivers once a later turn finishes instead of stalling
- Expanded Workflow blocks label every agent row by name instead of a raw session id
- Interrupted goal runs no longer stall on resume with the goal stuck active
- Preserve Windows sandbox credentials and stored permissions when upgrading sandbox setup
- Messages sent to Claude Code include the command for replying to the source Muse session
- A first run with no interactive terminal now stops with a message naming --trust-workspace instead of waiting on the workspace-trust prompt
- Background reminder agents now follow the same permission setting as the session that started them
- Subagent status shows the command, elapsed time, and latest output when a background command keeps the child running
- Human-approved `require_escalated` commands run under restricted permission profiles
- Keep the main conversation usable when subagent input recovery fails
- Plugin agent definitions reviewed before the source-bound trust review now show a one-time notice explaining why they resolve modified and that reviewing them again clears it
- Apply Windows read-deny rules to the shared sandbox group and protect their saved state
- Subagent settlement warnings appear in the parent conversation without disrupting typing
- `settings.json` no longer drops an unrecognized top-level member in silence: startup now names each one (`reason=unknown_member location=<member>`, with the file path) while the rest of the file still applies, so a wrapped `{"schema_version":1,"settings":{...}}` document is reported instead of quietly losing its whole configuration
- Restored guidance for Markdown tables, clickable links, and consistent answer formatting
- Stopping your own persistent monitor with `work_stop` now settles the Workflow Stop receipt as succeeded instead of "manual reconciliation required"
- The `/status` card ACCESS row shows the permission display name verbatim (Ask me, not Ask · me)
- Agents keep running when session logs run out of disk space instead of failing while saving tool results
- Preserve drafts, attachments and conversation history when opening and closing side chats
- Reject conflicting command IDs before a new subagent followup changes conversation history
- Preserve saved session activity times in the resume list
- Prevent delayed terminal color replies from appearing in the input box during startup
- A warm `session/resume` on a session started with a `workspaceRoot` that carries MCP additions the loaded session was not built with is now rejected with `session_configuration_conflict` instead of acking success with the servers silently unattached
- Keep delayed side chat results in the conversation that started them
- Stop unanswered questions from blocking input after resuming an interrupted session
- MCP stdio server processes no longer outlive the session when its terminal or process is killed on Linux
- A launch prompt longer than the screen no longer leaves its own tail and footer in terminal scrollback above the committed prompt
- `work_status` calls now show a readable "Checked work status" header instead of the generic "Used tool operation" fallback
- Re-sending a turn interrupt after the app restarts now returns its original accepted answer instead of a spurious rejection
- Forked and rewound sessions keep mid-turn instructions (including attached images) sent while a goal reminder fired in the same turn
- Receiver limits declared under `local_session_messaging.receiver_limits` in settings.json now bound the peer-message receiver in the TUI and `muse exec` instead of being ignored; an out-of-envelope or malformed entry now makes that receiver refuse every peer message for the session (the session itself keeps running), where before it was silently dropped
- Workflow launch preparation refusals no longer leave successful completion receipts
- Returning an unanswered prompt to the composer with `Esc` or `Ctrl+C` no longer shows an `Interrupted` notice
- Subagent commands in restored sessions remain recorded across crashes
- Approval prompts raised by subagents now appear in connected clients on the parent session and can be approved or denied there
- Recover from subagent startup failures without leaving the child active or blocking later work
- Resume interrupted workflows after a restart without dropping or duplicating the recovery notice
- Keep background run results in the conversation that started them
- Tree header return hint names the workflow it returns to
- Honor the Context option in `/hud` without enabling an experiment
- Limit `Ctrl+O` history expansion to at most ten recent terminal screens
- The `search` tool accepts `output_mode: "content"` as an alias of `text` instead of rejecting the call
- Keep tool-returned images attached to their matching tool results when using Meta models in tool batches without video
- Preserve every image label and attachment association when a media-bearing turn is rewound or forked
- Multi-stage approvals no longer hang in the TypeScript SDK — `session.onApproval` is re-invoked with the refreshed requirement when the host advances a compound approval to its next stage
- Use Unicode, spaces, punctuation and single words in session names with `/name`
- A gate override banner printed at the start of an interactive direct resume now stays visible above the resume progress instead of being erased by the spinner, which also no longer leaves a stale "Preparing resume" row behind
- Keep a pending tool approval out of the review list until its request is durably recorded
- Vim mode redraws no longer clear terminal scrollback
- Zed (ACP) adapter: session/set\_mode now works — switching approval mode from the agent panel no longer fails with "Method not found"
- `muse mcp login` now keeps and reuses its OAuth client registration across logins (no more one-new-client-per-attempt), asks for the same scopes at registration that it uses at authorize (fixes `invalid_scope` on servers like Clerk), and answers the browser callback tab with a "you can close this window" page — or the error name when authorization fails
- Slow stdio MCP servers now connect on the first try instead of restarting during startup
- Resuming a session with a different `--model` now keeps that model on later resumes
- /clear and /new now refuse a damaged outgoing session journal before switching and name the validator failure instead of blaming session logging; a same-process retry after write access is restored succeeds on the first attempt
- `/side` and `/fork` preserve images returned by tools when reopening saved conversations
- Give Japanese halfwidth katakana voiced marks their own column so kana text is not clipped
- Sessions served over `muse serve` now send turns to the model pinned at `session/start` or via `session/setModel`, instead of always using the default model
- When a hook corrects a failed tool call, the corrected call and its result now appear in the transcript as their own entry marked as a retry of the original call; previously only the failure was shown
- Subagent transcripts are readable over the SDK — `session/read`, `view/page`, and `item/readOutput` now accept the `childSessionId` that session items advertise, instead of answering "session not found" for a child transcript that exists on disk
- Keep the session name and description in sync after `/name`
- Native subagents stopped with Work Stop no longer fail again while the child finishes
- Quitting after browsing `/resume` no longer crashes when session discovery is still running
- `muse serve` now sends the interactive `approval/request` when a tool call parks on an approval while a client is attached, so session protocol and ACP clients get the permission prompt instead of a forever-parked turn
- Scheduled-task data can be backed up while a session is running
- Show retained subagent workspaces and cleanup failures when `muse exec` is interrupted
- Make workflow names required in model tool instructions
- A subagent's result that finished just before a context checkpoint is now readable after you resume the session, instead of being reported as never ready
- Resumed sessions retain conversation context from interrupted tool calls
- Missing reasoning history provenance is explained without claiming a provider switch
- A `/goal` set typed while the previous run is still finishing keeps its usage and reminders attributed to that goal
- Redirected subagents resume after their previous attempt settles
- Readable default colors when attaching with tmux control mode
- Retrying a session start after a host restart no longer fails because that host is cleaning up an unused session
- Esc while browsing prompt history during a running turn restores your draft instead of interrupting the turn
- Let Esc leave Vim editing mode before interrupting a running turn
- When an onFailure correction's corrected call is itself rewritten by a PreToolUse updatedInput, that rewrite now counts as exactly one attempt against the same declared chain depth instead of a free extra attempt
- Long pending-input queues preserve the composer and bottom bar in short terminals
- Agent Tree capacity rejections now show the exact cause and next step in the TUI
- Preserve agent recovery state when restarting a session
- Resumed workflows keep their Work ID and show the correct target for the next resume
- Keep recovered Workflows responsive when a missing child history is quarantined
- Forking or rewinding a session with a persistent monitor no longer silently drops the monitor's wake turns from the branch's model context — the branch now conditions on the same wake bodies and answers the original conversation did
- V1 workflows reject missing or blank names with a retryable error and include the current name in resume guidance
- Keep completed tool failures from hiding later assistant replies
- Prevent duplicate message delivery after reopening a compacted session
- Stopping an approved Bash command after restart now follows the shared Work Stop path and records its real cancelled terminal
- A persistent watch armed while `muse exec` is settling is stopped with its receipt instead of failing to start
- Subagent input status stays correct after interruption and resume
- Clear queued input and show the reply when Enter arrives as a turn finishes
- Agent path-length rejections report byte counts and guidance for shortening the path
- Sessions with one damaged background task now reopen with healthy work still available
- Parent task updates guide the same running subagent on its next eligible model call, without restarting it; downgrading is unsupported when resuming a subagent that received one of these updates
- Accept fenced reports in workflow recovery evaluations
- A persistent `ws` monitor caught by exec end-of-run while still connecting now stops with its normal receipt (stopped terminal plus stop notice) instead of failing the start with no receipt
- Reject duplicate keys in standalone Agent Tree authority records before decoding
- Committed Agent Tree Spawn retries remain replayable when a later command has an unconfirmed write
- Keep subagent background command results in their own conversation
- Resume sessions whose failed or cancelled runs lost tool results, and recognize native Windows disk-full errors during log retention
- Launching a subagent without an agent type now trims the requested tools to what the parent has instead of failing
- Keep Work Stop responsive while cancellation settles and report unconfirmed stops after 30 seconds
- Several images sent into one turn keep their separate numbered labels when the session is resumed
- Forked sessions keep the correct conversation history after compaction
- A project `.mcp.json` entry with Claude's `"type": "http"` now lights up as a streamable-HTTP server instead of disabling all MCP
- Resuming a session and prompting right away no longer skips peer messages that were already waiting for it
- Tools approved after a restart keep their original run identity
- /side and /fork no longer refuse a session because an earlier tool call was cancelled while it was still running; the cancelled turn keeps its committed output with the standard pending-tool placeholder, matching what /resume replays
- Declining workspace trust now also stops the background Sapling snapshot commands from running in that workspace, and a session with no workspace configuration is treated as untrusted
- Refuse session forks when retained history cannot establish consistent delegation settings
- Paste text into clarification answer notes and custom choices
- Keep installed plugin files available while their capabilities are being loaded
- Finished background tasks no longer stick in the subagent tree — press `x` to dismiss one, or it retires on its own after 30 seconds
- On resuming a session mid-correction, a corrected tool call now appears next to the call it retried instead of at the bottom of the transcript
- Typing right after approving a command no longer loses the first `p`, `y`, or digit to the finished approval prompt
- Typing a plugin skill name in the `/` palette shows one row instead of both `/name` and `/plugin:name`
- A steer you send while a reviewed command's or skill's turn is running now ends that turn's approved-tool suppression even when the steer itself is rejected, so the turn's next matching tool call asks for approval again
- Sessions created by `muse exec --session-id` with `--yolo`, `--disable-approval`, or an explicit human permission profile now publish context checkpoints like TUI sessions, so resuming them reads only the newest checkpoint plus its suffix instead of replaying the whole log
- Generated plugin runtime files no longer disable an otherwise valid plugin
- Plugin skill reads keep their selected files available across plugin updates
- Refuse unsafe image replay when retained session authority is missing or ambiguous
- After a blocked command is corrected and succeeds, the assistant reports the corrected result on the current turn, not only after the session is resumed
- An open child thread view refreshes its status card when the child finishes instead of showing running until reopen
- Retry a peer message whose receiver briefly answers owner\_unavailable instead of dropping it after the first attempt
- Previously approved plugin hooks carry over once without re-approval after upgrade; later declaration changes still require review
- Start default plugin installation after headless startup finishes so a stalled clone cannot block startup plugin reads
- A subagent result that arrives after its turn has finished no longer breaks resume of that turn or blocks later context checkpoints
- Trust prompt actions now appear directly after the workspace safety text
- The `/feedback` note screen now answers arrow keys, Home/End, and Delete so typed feedback can be edited in place
- Peer message summaries retain reported progress when no final send outcome is available
- Messages accepted by another app no longer appear as unsent
- A reviewed plugin command no longer skips the approval prompt when it reaches a symlink planted inside the installed plugin package, and every `read_file` path refuses to follow a symlink inside a plugin package instead of only the direct one
- A peer message admitted while the session is idle always reaches the very next turn, even when the runtime is CPU-starved
- Resuming a paused workflow after restarting lets its new child submit the result
- An expired or rejected credential reported after a response starts streaming now shows as a sign-in problem instead of a model error
- Malformed message receipts no longer use the normal sender status marker
- Queued parent updates stay visible in the child view through exit and resume
- Subagent rows show queued parent-message counts, and child views distinguish queued messages from delivered messages
- Prevent Windows sandbox permission failures after repeated commands
- Preserve browser sign-in URL parameters on Windows for `muse mcp login`
- First-login sessions on muse-spark-1.3 models now show max reasoning effort immediately instead of high until restart
- Downgrade-save-upgrade cycles no longer re-run the one-time legacy hook trust amnesty
- Side chats (`/side`, `/btw`) now use the main session's history to answer questions about its work, progress, or status instead of claiming they have no context
- Recover background task handles after context compaction so active work can still be stopped
- Peer message headers preserve waiting, held, and unavailable states. Generic rejection and missing-target results now use "Message status"; admission timeouts, expired reply contexts, and unsupported requests use warning-colored "Message status" headers
- A resume refused at startup no longer duplicates a session-log sequence, so the session log stays readable afterwards
- `plugins validate` and `plugins install` now warn (`agent-definition-unsupported`) and name the file when a plugin Agent Definition resolves no identity — for example a `name` outside the `^[a-z]+(?:-[a-z]+)*$` grammar — and `plugins inspect` carries the closed reason; the definition was already inert but nothing told the author
- Tab-completing a slash command that takes an argument (e.g. `/effort`) now leaves one space after the command, so typing the argument no longer fuses it into the command name and sends it to the model as prose
- `/side` and `/fork` no longer refuse a session whose earlier turn died while a tool was running; that turn is left out of the branch exactly as it is left out of a resumed session, a side chat survives its own interrupted turn, and a rewind past a turn that failed at the provider no longer carries that failed prompt into the child
- Steering a running turn stops a reviewed plugin command from skipping approval prompts right away
- An approved plugin `allowed-tools` rule such as `Bash(cat ${CLAUDE_PLUGIN_ROOT}/notes.md)`, where the plugin folder placeholder is not the first word, now skips the approval prompt for the command it describes instead of asking every time
- Verified peer messages show receipt progress, keep receipt conditions visible when expanded, and preserve full message text; safety refusals hide the body. Accepted messages keep normal grouping, and unknown results retain their diagnostic details
- Unconfirmed peer messages stay separate instead of appearing as a successful send count
- Subagents keep large structured results instead of failing the submission
- Hook-blocked prompts keep their source and reason visible in the conversation, including after reopening the session
- Resuming a session after a clean exit no longer marks a long-completed turn as interrupted when its compaction checkpoint was followed by a late background-task notice, and a session already carrying that stale mark opens and accepts prompts again instead of failing every message and /compact with a duplicate-terminal projection error
- Plugins installed just before a capability scan are no longer silently skipped while other programs are being launched
- Installing a Claude plugin no longer fails when one skill or command writes its `allowed-tools` `:*` marker in a place Muse cannot use; that one rule goes inert and the rest of the package installs
- `/compact` after a background-task notification now compacts the latest conversation turn instead of answering "no compactable run is available"
- Restore compaction for older saved sessions hosted by `muse serve`
- Background commands started by subagents stop without timing out
- Paste clipboard images on Linux, with `Ctrl+Alt+V` as an alternate shortcut
- Workflow sub-agents keep repository instructions instead of losing them
- Retry transient macOS Keychain reads and preserve unsent messages when credential access fails
- Preserve conversation context when forking sessions with unfinished turns or unrecognized history records
- Conversation summaries follow the selected provider after an account change
- Peer messages with a receipt but no send outcome show the available receipt progress and full message text when expanded; they remain unresolved in message groups and batch status
- Stopping a background task no longer shows as unresolved once it has stopped
- Quitting after a resumed workflow finishes no longer warns about its earlier paused tasks
- Show the process observation error when MCP cleanup must keep waiting
- `/skills` shows a credited skill's full source URL under the selected row
- Toggling a skill in `/skills` no longer flashes the status bar
- Sessions you leave with `/new`, `/clear`, or `/resume` can be resumed from another window right away instead of being reported as already open
- Resumed workflows stop showing as running after their recovered agents finish
- Resuming a conversation keeps earlier messages after a prompt is taken back
- Withheld peer replies hide message text and private identifiers
- Plain `muse exec` shows progress while retrying an interrupted model turn
- A resume that is refused at startup no longer writes anything to the session log; the previous run's crash marker now lands together with the resume record only when the resume succeeds
- Git over SSH uses system SSH configuration correctly on Linux
- Side chat follows Main for message steering, queueing, and draft recovery
- While an approval is waiting, typing no longer leaks into the hidden composer and Enter approves the selected choice instead of sending the draft
- Approving or denying a tool action now works after you rename a session; the decision no longer fails with an "approval not found" error
- `write_file` and `edit_file` no longer fail with "tool output storage failed before result publication" when the Muse data directory is on NFS or another filesystem without renameat2 flag support, and the local session registry stops logging "Invalid argument" there
- Keep delayed terminal color replies out of the input box
- On-request approval now prompts before `sl hide` and `sl phase --secret` instead of auto-allowing them
- Oversized session records and traces attached to /feedback are truncated to fit instead of being dropped
- Rewind in long sessions now drops history the latest compaction checkpoint already covers, keeping memory bounded and the picker scoped to entries after that checkpoint
- Workflow authoring guidance preserves large child result references and explains compact summaries and file artifacts
- Paged transcript history, live-stream replays, and approval replies now number events like the live stream when the model reports context usage, so paged history lines up with live updates in most sessions
- Avoid duplicate background compaction cancellations after a temporary storage error
- Keep images and compatible reasoning when continuing or compacting Muse sessions
- The `/status` context row keeps projecting after a fast follow-up turn instead of falling back to not projected
- Resume saved subagent launches after restarting a session
- Resumed Workflow monitors stop spinning after followup agents finish
- Checkpoint suffix writing no longer rescans all retained session records for every distinct task owner, so resuming sessions with many subagent-owned tasks stays fast instead of slowing quadratically
- Fixed startup failing with `meta provider resolution did not construct its credential-provider handle` when a saved login was paired with a keyless custom endpoint; the session now starts without the withheld credential
- The resume picker and `--last` no longer offer sessions that another Muse window is still using; they reappear once that window exits
- An MCP server's `tool_timeout_sec` above 600 seconds now takes effect instead of being silently capped by the foreground tool deadline, so long-running MCP tools can run to their configured budget
- Mark read subagent results closed and display final text once
- Preserve known message receipts when background tracking cannot start
- Session protocol clients get a retryable `commandRejected` (`runtime_busy`) instead of an internal error when a session is busy and refuses `turn/start` or `turn/steer`
- A new `/loop` job now runs until you delete it instead of stopping on its own after about a week — for a loop you started earlier, delete it and run `/loop` once more
- Cancel unfinished SessionEnd hooks before they exhaust the session shutdown budget
- Prevent macOS diagnostic messages from overwriting the input composer
- The verify reminder's checker now runs at the session's own reasoning effort instead of a fixed level. Previously every session was checked at `high`, so a session thinking harder than that — `xhigh`, `max`, or `ultra` — was judged by a weaker model than the one doing the work, and a session below `high` was judged by a stronger one. Sessions at `max` keep the existing `high` checker; `high` is unchanged; `xhigh` and `ultra` gain a checker at their own level; and `medium` and `low` now get a checker at their own level rather than `high`
- Make `work_status` report ordinary Workflow launches by their returned v1 work IDs
- `muse login` and `muse auth set` save credentials again on Windows and Linux
- Fix event-log errors when resuming work after tool output
- Keep composer text visible while typing during an active run
- A session no longer stays busy for the rest of the process after a finished turn's Goal accounting fails; the next turn starts normally while the accounting retries a few times in the background
- Preserve Markdown formatting and handoff notes in conversation summaries
- Reading or resuming a session you already opened no longer re-reads its whole history each time
- Exit confirmation stops listing completed Workflows after a later prompt
- Approving or denying a tool action no longer fails with an "approval not found" error in a session where MCP startup audit failed

### Performance {#performance-12}

- Read-only MCP tools called in one model turn now run in parallel instead of one at a time
- `muse resume` no longer hangs for minutes at "Initializing runtime" on sessions whose subagent logs carry many run generations — startup now reads each subagent journal once instead of once per run
- Faster exit from long-running saved sessions
- Resuming a long session needs far less memory for the pre-open log read, and hydration checks for the next keystroke less often
- Resuming a long session no longer keeps a second copy of the whole saved log in memory while the session opens
- Resuming a long session is about a third faster and uses less memory, thanks to a new memory allocator
- Resuming a session with many runs no longer re-walks the whole saved log once per run while goal progress is recovered
- Long sessions resume faster when a large amount of history follows the last checkpoint
- Keymap validation in `tui.keymap` settings stays fast even when one action lists hundreds of bindings
- Resuming a session with many orphaned or unreadable runs recovers them with a single shared history pass instead of rescanning the whole log for each run
- Keymap validation in `tui.keymap` settings stays fast when bindings repeat one key under different spellings
- Submitting a draft with many collapsed large pastes no longer slows down as the paste count grows
- Long sessions publish a history-preserving checkpoint every 16 MiB of retained log (tunable with `context_compaction.periodic_checkpoint_bytes`; `0` disables it), so a later resume reads the checkpoint plus its suffix instead of the whole log; compaction keeps publishing its own checkpoints unchanged
- Task-status refreshes stay fast in long sessions with many completed tool tasks
- Reduce terminal lag when refreshing child command status in sessions with many completed tasks
- Task-status refreshes stay fast in long sessions as more tool tasks complete, instead of slowing down with every finished task

## 1.2.1 {#v1-2-1}

### New {#new-13}

- Voice input is on by default on macOS: press `Option+V` to dictate, and manage it with `/voice`
- Added a `/rewind` command that rewinds the conversation to an earlier input — same picker as double `Esc`
- Pasted and dropped images get `[Image #N]` labels the model can see, so you can ask about a specific image by number; labels and their source paths survive resume, rewind, and forks
- `/mcp` shows a live inventory of connected MCP servers and their tools in the transcript
- Added a bundled `migrate` skill that imports your Claude Code or Codex memory notes and MCP servers into Muse Code
- Set `MUSE_TRANSPORT_TRACE=1` to print raw provider request and response lines to stderr for debugging model calls; credentials are scrubbed
- Sessions can be renamed over the session protocol with `session/rename` (with `session/nameChanged` notifications), and `session/list` carries display metadata — title, first user prompt, and branch
- Edit-tool calls on the session protocol carry a structured diff fact — `patchSummary` line counts plus a durable `patchRef` — so clients can render what an edit changed
- Programs driving a session can set a session-wide reasoning-effort default with `session/setReasoningEffort`, inherited across resume and fork
- Workflows now run in `muse serve` sessions, matching what `muse exec` supports

### Improvements {#improvements-14}

- New sessions start in the Auto-review permission profile: the same access as Ask me, with an automated reviewer deciding eligible approval requests; it falls back to asking you when the reviewer is unavailable
- Permission selections are remembered and applied to new sessions
- MCP tools whose server declares them read-only run without an approval prompt under on-request approvals
- MCP server configs support `${VAR}` environment interpolation, and stdio MCP servers receive `MUSE_SESSION_ID`
- The MCP handshake advertises protocol version 2025-06-18 on both transports
- Hook payloads include the session's canonical `model_provider`, so hooks can branch on the active provider
- Clearer, typed guidance when a sandboxed command is denied listening on a network port
- Messaging local Claude Code sessions is more robust: interrupted sends cancel cleanly, stale late replies are rejected, and peer discovery shows whether a peer supports read receipts
- `session/resume` runs the same startup reconciliation as a fresh launch, so work orphaned by a crash settles instead of staying stuck
- Launching a subagent with an unknown agent type or an invalid task name is rejected with an explanation of what was wrong and which targets are valid
- Every non-Main viewer's footer shows `Ctrl+C` to return, even when the view isn't focused
- Scheduled-task rows keep long prompts to a single header line, and creation receipts are one line, with detail available on expand

### Fixes {#fixes-14}

- **Security:** commands launched through wrappers such as `env` and `setsid` are reviewed as the command they actually launch
- **Security:** changing the permission mode mid-session now applies to already-running tools at their next action
- **Security:** MCP tool grants in custom agent definitions are validated against the prepared toolset instead of falling back to a legacy path
- **Security:** the Unrestricted permission profile now behaves exactly like `--yolo`
- Only the main and side sessions can prompt for user input; subagents no longer can
- Smoother `/clear` and `/new`: the screen no longer blanks before the new session's first frame, keystrokes typed during the restart are kept and replayed in order, and a `Ctrl-C` in the restart window no longer kills the app
- `/clear` and `/new` refuse trailing text on the command line with a usage hint instead of silently discarding it
- MCP servers that fail to start after `/clear` or `/new` now surface the failure instead of staying silent
- Double `Ctrl-D` over a pending approval opens the exit confirmation instead of force-quitting past running background work
- With an approval prompt open and text in the composer, `Enter` goes to your message instead of being swallowed by the approval panel
- Each guarded call in a parallel tool batch gets its own approval prompt
- Permission selections committed during a session survive resume
- Pending approvals survive a headless restart instead of inheriting the predecessor's abort
- After a crash, a tool approval that was still waiting for your answer shows as unresolved on resume — never as already executed
- Saving settings preserves the file's permissions and symlinks, and no longer writes an all-default `tui` block
- MCP `startup_timeout_sec` is honored, and slow servers that emit newline-delimited JSON are admitted
- An MCP server's `required` flag follows the winning configuration layer
- An MCP server's `cwd` setting now sets the stdio server's working directory
- Resuming is more reliable: resume no longer fails after compaction has pruned older history, on a session saved mid-way through parallel tool calls, on a checkpoint taken while a workflow was paused, on a checkpoint that went stale while the session kept running, or with "duplicate or non-monotonic" sequence errors; a run that cannot be rebuilt is set aside instead of blocking the whole session, and an empty saved session file is refused with a named reason instead of opening broken
- A malformed tool call from the model no longer poisons the session: the model gets a clear error it can retry from, and sessions already saved with such a call resume cleanly
- Forks and side chats are more reliable: they stay available after resuming from a checkpoint, keep messages and attachments that used to be dropped from the new branch, open on histories that previously failed with a read error, and branches created in quick succession keep their creation order
- Your model and reasoning effort choices stick: forks and side chats start on the parent's model and effort, a per-turn effort applies to that turn's model requests, and turns the runtime starts on its own (like background-work wake-ups) use your settings instead of the startup defaults
- Stopping and cancelling subagents is dependable across restarts: a stop or cancel in flight when the app closes is completed on the next launch instead of forgotten, stays in force after the agent is closed and reopened, and is not reopened by a late result from the agent's own children; restart recovery no longer revives, duplicates, or corrupts agents it should leave alone, and closing an agent's whole subtree no longer wakes the agents being closed
- Background work reports in reliably: a live view opened before a background task produced output now fills in instead of staying blank, messages for a subagent's own subagents reach the right agent, and a finished subagent whose session can no longer accept results settles instead of waiting forever
- Workflows start and finish cleanly: an invalid workflow source is rejected before anything launches (and `muse exec` JSON output stays clean), a finished workflow agent with a missing or invalid report settles instead of leaving the workflow waiting, and resuming mid-workflow replays already-completed steps correctly
- Workflow progress narration shows in the conversation on the default view, not only inside `/workflows`
- Goals handle blocked work honestly: a goal denied by session policy ends with a clear final message naming what was blocked instead of empty output, and progress that was blocked resumes correctly when the goal continues
- `muse exec` no longer exits with an error when the process reading its stderr goes away during shutdown
- Finished shell commands clean up fully: releasing a captured terminal no longer injects a stray blank line into the command's output, and long sessions no longer accumulate runtime resources from completed commands
- Session storage is more robust: listing sessions no longer intermittently fails with "session index unavailable: database is locked", and a full disk no longer crashes the app before it can restore your terminal and print the session id and resume command
- Pastes into `!` shell mode stay literal — image file paths are no longer rewritten into `[Image #N]` attachments
- Long assistant replies stay within the collapsed row cap while streaming, and `Ctrl+O` mid-stream no longer garbles the elided view
- Tool rows in narrow terminals keep their expand hint instead of dropping it when the header runs out of room
- `/settings` refreshes its rows when a side chat starts or returns, so the Reasoning effort row can't go stale and the highlight can't act on the wrong row
- Messages parked in a side chat no longer linger in the main session's queued-messages panel after returning
- After `/side`, `/status` and `/tasks` count only the visible session's work instead of leaking the other session's subagents and pending items
- `/tasks` preview of a finished terminal shows the same status wording as its drawer row instead of "no output yet"
- Keys pressed while the rewind loading screen is up are absorbed instead of leaking into the composer; `Esc` and `Ctrl-C` still cancel
- Resuming a session by exact id warns when its declared predecessor session is missing from the store instead of resuming silently
- A freshly launched session no longer vanishes from other terminals' resume pickers until it exits
- `/stop` always renders a verdict — a background task that never confirms now reads as a failed stop instead of leaving `/stop` silent
- `muse serve`: `session/list` includes sessions loaded on the answering host with fresh metadata so a new session appears immediately after `session/start`; session recency ignores internal bookkeeping writes, so crashed old sessions no longer jump above newer work; page cursors bind to the listing that minted them, and cursors from live streaming and durable reads share one space instead of being rejected as unknown; `session/setModel` acknowledges only after the change is durable; omitting `providerId` on `session/start` resolves to the host's composed provider; a brand-new session can no longer be pruned out from under its own start; and stopping the server with SIGTERM or SIGINT winds down cleanly, closing sessions durably instead of crashing them
- `muse serve`: a rejected `session/resume` no longer leaves a stray view subscription; resuming with a cursor delivers pending approval and user-input requests instead of an empty list; live view updates re-arm after a `view/unsubscribe`; approval modes selected over the wire are honored for shell commands instead of being clamped; setting the model to the same provider no longer bricks a resumed session; subagent results recorded before a resume are readable again; follow-up turns spawned from a carried-forward `turn/steer` can be interrupted and steered; the `retryable` flag on `turn/completed` errors reflects the provider's real classification; reminder-spawned child tasks show their real lifecycle instead of appearing completed at spawn; and sessions started without a workspace root can still prompt via `request_user_input` when the client supports dialogs

### Performance {#performance-13}

- Opening or resuming a long session is dramatically faster: startup work now scales with the size of the session log rather than multiplying by the number of turns
- `item/readOutput` no longer scans the whole session per read — dramatically faster on long sessions
- Re-attaching a live session view over `muse serve` is now constant-time, independent of how many events streamed since load

## 1.1.1 {#v1-1-1}

### New {#new-14}

- Added `muse mcp login <server>` and `muse mcp logout <server>`: OAuth 2.1 sign-in for remote MCP servers, in the browser or headless. Tokens are kept in the auth store and refreshed automatically, a login done in another terminal is picked up without a restart, and a startup or mid-session 401 now tells you the exact `muse mcp login` command to run. Set `mcp_oauth_dynamic_client_registration: false` to turn off automatic client registration
- Markdown links render as clickable labels in terminals that support hyperlinks, with automatic fallback (including under tmux); exported transcripts keep the full URL, and links survive redraws and scrollback
- `/theme` gains a Terminal background row: Left/Right cycles auto, light, and dark and re-derives the picker live, a notice appears when your choice contradicts what the terminal reported, Enter saves it as `tui.terminal_background`, and Esc reverts
- The agent can check on and stop its own background work (workflows, subagents, and background commands) with the new `work_status` and `work_stop` tools, using the same work ids it is shown
- Todo reminders are on by default: the model is nudged to create and update a todo list during complex multi-step work
- Two new built-in skills, on by default: one has the agent ask about an unresolved product decision before committing to it, the other keeps a focused regression test with each bug fix or behavior change
- Added a bundled Three.js skill (`/threejs`) with references for scenes, geometry, materials, lighting, textures, animation, loaders, shaders, post-processing, and interaction
- Added a `PostToolUseFailure` hook that fires when a tool call fails or crashes
- After a rewind or fork, the status bar warns while tasks from the original conversation are still running, and the new branch's transcript notes the background work that stayed behind
- Press `s` in a workflow's detail view under `/workflows` to save the running workflow under a name so you can run it again
- Programs driving a session can declare `capabilities.userInputDialogs` at `initialize`; sessions whose client can show a dialog get the ask-the-user tool, and a client that opts out has such calls rejected cleanly instead of hanging
- Programs driving a session can read an item's stored tool output by reference with `item/readOutput`, and re-attach a live view with `view/subscribe` after `view/unsubscribe` on a still-loaded session, replaying the gap from a cursor

### Improvements {#improvements-15}

- Memory, Skill, Todo, and Scope reminder child logs now default to **Memory only**, so a long session no longer accumulates one `subagent/<id>/session.jsonl` per model step. Choose **Saved** under TBH Reminders → Settings to keep writing them; Goal and Verify are unchanged
- A forced `max` reasoning effort (`--reasoning-effort max`, settings, `/effort max`) is now sent to the model as-is on every model instead of being silently downgraded, so an unsupported value shows the provider's error; `max` is also accepted as a `reasoningEffort` on `turn/start` and `turn/steer` over the session protocol
- The Scope reminder is on by default in sessions using muse-spark-1.2
- Tuned the built-in instructions: the agent asks one grouped question before scaffolding when a request leaves a material product decision open, never claims a server is up without a fresh check, confirms decisive values (versions, config values, paths, counts) by a second route, surfaces degraded external causes in the deliverable itself, resolves which file a correction refers to before editing, and reports rather than refuses safety concerns about explicitly requested changes
- The goal reminder no longer steers the agent toward faking, bypassing, or disabling a test to satisfy a goal; it names the honest blocker instead
- Workflow scripts steer child agents to inherit the parent model unless a task clearly needs a different tier, and research children inspect the source and tests behind each claim instead of stopping after a fixed number of tool batches
- The built-in `grill` skill now records each settled decision in your project docs and closes with a written scope contract (what is in and out of scope, and what done means); the separate `grill-and-record` skill was removed
- The `plan` skill asks about open product preferences up front when you request a collaborative planning checkpoint, instead of leaving them as open questions at the end
- The composer prompt uses a heavier `❯` glyph
- `/new` and `/clear` prepare the new session before shutting down the old one, so both stay resumable if the process dies mid-restart; `/new` now clears the visible thread like `/clear`, both share one palette description, and quitting after keeping background tasks across them warns that those tasks will be stopped
- `--disable-sandbox` no longer prints a startup notice on its own or changes your selected permission profile; startup warns that profile filesystem and network restrictions are not enforced for direct shell commands, and `/status` shows a Sandbox row when it was disabled at launch
- Commands you run yourself with `!` (and `session/userShell` over `muse serve`) no longer trigger approval prompts, including for network access; hard policy denials still apply and stay visible
- Tool calls that fail only because a path does not exist are shown quietly in a dimmed style instead of as loud errors
- Tool cells with several attachments draw one continuous tree guide from the header to the last attachment, and wrapped continuations no longer land at column zero
- The "Worked for" line also shows the local time the turn finished, e.g. `Worked for 1m 01s · 10:15 AM`
- The Plan panel appears only while a run is active and hides while a prompt is waiting for your answer
- When a session wakes for a peer message, the text it writes before calling a tool is folded into that tool row (expand with `ctrl+o`) instead of a separate transcript cell
- Startup notices say exactly what was trimmed: a memory truncation names the file and the limit that fired, and a skill catalog over its size limit keeps every skill's name visible and reports how many entries were cut
- `muse exec` prints once on stderr why subagent delegation is unavailable
- Spawning a subagent whose definition (prompt, skills, memory) already exceeds the context budget is refused up front with a clear diagnostic instead of failing later
- Resuming a session refuses with a named reason and remedy when the saved state cannot be trusted (identity mismatch, another live writer, unreadable state, unrebuildable history) instead of silently degrading
- Resumed sessions describe the current sandbox and permission posture to the model instead of the posture recorded when the session was first started
- The agent's subagent-tree status can page through completed history, oldest first
- `--worktree` sessions remove their Git worktree on close when it is clean and its commits are already on the default remote; unique or unproven work is kept
- Sessions you open and quit before sending anything no longer linger in the resume list or on disk, including zero-turn `muse serve` sessions whose owner process died
- Removed the confusing "model … not in catalog — using assumed limits" notice at startup
- In `/workflows`, press `f` inside a workflow's agent view to filter agent cards by label; the phase drill-down filter is offered only while agents are live and clears itself when the last one finishes
- A turn that fails because no usable credential is available ends with a distinct `authRequired` error over the session protocol and in the SDKs, instead of a generic model error
- SDK: `apply()` session-state outcomes are deeply read-only, and the `DeepReadonly` type is exported
- Shell output containing invalid UTF-8 now notes how many bytes were replaced instead of being rewritten silently
- Selecting the `max` reasoning effort in the Effort drawer plays a gold activation animation, and the gold prompt and rail stay settled across model switches

### Fixes {#fixes-15}

- **Security:** Closed a gap where `rm -fr`, `rm --force`, and wrapper-nested variants slipped past the dangerous-command check that guards destructive shell commands
- **Security:** Model-authored subagent names and objectives, text read back from an external editor, and provider error messages are stripped of terminal control sequences before they reach the terminal or the session log; provider errors are also scrubbed of credentials
- Sending an image with no text no longer makes every later message in the session fail with "Message not sent", including after resume
- New prompts are no longer rejected after a restart when the session's replay evidence is missing or unreadable, and "Message not sent — projection failed" no longer follows a turn that ran several tools at once and had its results cleared
- A background delivery whose submission keeps failing no longer retries forever or starves your own messages ("Message not sent — runtime admission timed out"): retries are single-flight and a poison item is quarantined after three failures
- Sessions whose log can no longer be fully replayed, whose checkpoint records a wrong message count, or whose saved runtime snapshot is invalid now resume from the last valid checkpoint or a safe reopen instead of failing to open
- Resuming after a checkpoint no longer fails on the next turn, leaves a gap that breaks the next checkpoint, or fails on the first write after a compaction had already summarized a superseded marker
- Resuming no longer aborts when one subagent's log is unreadable, drops the answer the agent gave after a retried turn, shows an interrupted MCP call as completed, or loses a running workflow's agent tree after a compaction
- A resume that fails before it is ready no longer writes partial records to the session log, and a resume forced to fall back after an invalid checkpoint recovers with a single recovery checkpoint
- Reminder-agent logs that end in a blank line no longer fail to replay on resume
- The session list refresh no longer races sessions that are still being written, and keeps a session's cached title and details when its lock cannot be opened instead of showing an "unreadable" placeholder
- The `--resume` picker stays responsive while sessions are still being discovered on a cold start, and resuming from it or after a session-in-use notice shows startup progress instead of a blank pane
- Resume and `muse export` report a permission-blocked session directory as unreadable, with a `chmod` remedy, instead of claiming the session has no saved log
- Running `resume` without a terminal now points to the headless remedy (`exec --session-id <uuid>`), and the export picker names its real `--last` and `--session` flags
- `muse exec --resume` works for sessions created with `--worktree`, records the crash before adopting a crashed session, and `muse exec --no-session-log` starts when subagent delegation is enabled
- Nested subagents (a subagent's own subagents) now open their session logs, write their control records, and recover in the right place across restarts, so their results survive a resume and are not duplicated
- Subagent results no longer point at the wrong transcript when several subagents run at once; interrupting a subagent before its first model call takes effect immediately; waiting on a worktree-isolated subagent after cancelling it no longer errors; reading a subagent's transcript works after its log crosses a checkpoint; and messages a subagent rejects are recorded with the reason
- The subagent panel keeps a Finished marker that arrives out of order, shows the selected subagent's own activity while it waits on the model, expires a finished row you parked the cursor on, names agents by label in steering acknowledgments, keeps its place when paging a completed transcript after a status refresh, and counts each subagent's tokens the same way `/usage` does
- An invalid `subagent_type` value, or a default subagent definition that fails to load, now gets a rejection naming the real cause instead of a generic argument or selection error
- The task inventory shown for a child conversation lists only that conversation's workflows, subagents, and terminals instead of the parent's
- Paused workflows survive: cancelling a turn no longer marks a paused workflow cancelled, and a paused workflow keeps its owner, children, capacity slot, completion state, and resume handoff across `--resume`
- Workflow children report reliably: a child that fails shows its final status live, a finished child stays finished, cancelled children show no error receipt, follow-up subagent results reach the workflow, results are no longer held back behind a long main turn, messages sent to a child before it is live are queued instead of rejected, children woken after a restart no longer stall on reminders, and children keep their memory tools after recovery
- Quitting cleanly while a workflow still has live child work leaves that work recoverable on the next launch, the same as after a crash
- Subagents spawned by a workflow child no longer clutter the main transcript with spawn and finish rows
- Steering a running turn no longer drops Workflow mode when the steer lands as a fresh turn
- `/workflows` shows a short run id next to unnamed workflows so identical-looking rows can be told apart
- Saving a named workflow no longer overwrites a file a concurrent save just wrote, cleans up its staging file on failure, and names the target path in the error
- On Linux, workflow script syntax errors report the real message and source line, keep `--json` output clean, and scripts whose default export is an expression are detected correctly
- Goal controls accepted in the final moments of a turn, or just before a cancelled turn restarted, are no longer left queued; interrupting a run with an active goal reliably shows the goal-paused notice; Esc stops the turn even when goal storage is unavailable; goals closed automatically when a run ends are recorded and announced; and a rolled-back fork no longer leaves goal store files behind
- Rewinding to a point mid-conversation works again; rewind branches from the exact point you chose; a window holding a queued steer or an in-flight run no longer fails after you confirm; sessions compacted mid-turn can be rewound; and a finished task whose result is still being delivered no longer counts as active work
- `/side` no longer fails on a session compacted after its checkpoint, on a log with only bookkeeping records since the last checkpoint, or when resuming a side chat created on an earlier day; a prompt sent right after returning from `/side` is queued instead of rejected as busy
- `session/fork` preserves the source turn and item identities, accepts the source session's real turn ids as the cut point, reports the child's own turn count, and forked sessions over `muse serve` start their MCP servers instead of failing with "MCP startup audit failed"
- Failed turns no longer count as phantom turns in session listings, reads, resumes, and rewinds
- Manual `/compact` summarizes with the model you switched to via `/model` instead of the launch-time model
- `/new` and `/clear` no longer break every following turn with "MCP startup audit failed" when MCP servers are configured, and `/clear` refuses to start a new session when the session log cannot be retained instead of minting one that would lose history
- Enabling or disabling a skill now takes effect on background and reminder-driven turns immediately, not only on your next prompt
- Re-running `/skills import` reports already-imported skills as skipped instead of counting them again (`--dry-run` shows the same rows); a project copy of a bundled skill with identical content is no longer listed twice; and a skill whose manifest cannot be read reports the real filesystem error
- The skill reminder no longer fires in sessions where the `read_skill` tool is unavailable
- One mistyped entry under `skills.activation.projects` or `hooks.state` no longer discards the rest of the map (a startup warning names the bad key); settings and credential writes follow a symlinked config file instead of replacing the link; and a rules directory that cannot be searched is reported by name with a remedy
- `PostCompact` hooks fire exactly once for background compactions adopted after a turn ends; a `PostLLMCall` hook that keeps returning `additionalContext` stops re-driving the turn after 8 continuations; and hook trust and enable state no longer collide between argv-style hooks whose arguments join to the same string
- MCP tool calls keep their server attribution through live refreshes and after closing a rewind overlay; the per-server `tool_timeout_sec` setting applies to tool calls, resource reads, and prompt fetches on both transports; and a server that requires an OAuth sign-in says so at startup, with HTTP 403 reported as an authentication failure instead of a generic initialization error
- Interrupting a running `bash` command returns the output it had already produced; a background command's exit status is shown once; input sent to a non-interactive background command points at `terminate`; starting a second `!` command while one is running names the running command and keeps your draft; and denied `!` commands report output truncation correctly
- Search results in JSON mode return invalid-UTF-8 lines as base64 `bytes` instead of silently rewriting them
- Runaway loops that repeat the identical command with identical output are stopped even when compactions happen mid-loop
- Cron jobs created during a fresh `muse exec` run are bound to that session; queued cron wake-ups are no longer lost when a session is resumed after a compaction; and `muse serve` sessions expose the scheduled-task and goal tools that were advertised but never reached the model
- `muse exec` text output no longer loses the answer when a background wake starts a second run; `exec` no longer hangs on a protected write it cannot get approved; `--max-tool-output-bytes` rejects values below the readable floor (`0` disables the cap); and a failed model-catalog fetch is no longer retried a second time on a cold cache
- Startup no longer fails when the temp directory is unusable (it warns and continues); on Linux the startup warning about a missing system `bwrap` is gone; and `muse init` no longer hangs on a package manifest that is a FIFO
- Meta Model API requests that fail with HTTP 402 are not retried, and retry status reads in plain words, e.g. `rate limited (HTTP 429) · retrying in 60s · attempt 2/10`; a transient token-refresh failure during `web_search` is reported as a connection problem instead of an authentication failure
- Ctrl-B and Ctrl-D edit text when the draft is non-empty and the exit hint follows remapped keys; fast-typed or terminal-buffered text no longer arrives out of order around character-form shortcuts or Tab; cutting a large paste with Ctrl-W and yanking it back restores the content; the cursor no longer drifts after Indic spacing-mark clusters; and an image path in the middle of a sentence stays as text
- Typing no longer stalls right after resuming a long session; idle sessions no longer churn CPU after a turn ends and the terminal cursor blinks again; and opening or answering an ask-question prompt no longer blanks and redraws the whole terminal
- Collapsed read and search summaries always show the `ctrl+o` hint; wrapped lines no longer tear emoji sequences or overflow the pane; narrow panes keep the state cell and timer visible for long task labels; the live-follow view for a background command uses the full pane width; an external tool's failure details render once; and tool rows rejected for bad arguments switch to `rejected` promptly
- Run failures caused by step limits, configuration, environment, or workflow launch errors no longer carry a misleading `model failed` prefix; the context-usage notice no longer reports almost nothing remaining on an implausible token count; and the notice shown when resuming a session that did not shut down cleanly no longer tells you to run `reset`
- `--worktree` sessions no longer fail intermittently when several sessions create worktrees in the same repository at once, and resuming one no longer hits a worktree collision after an earlier removal was interrupted
- `muse export --out` writes to a temporary sibling and renames it into place, so a failed export never truncates an existing file
- Pending approvals no longer flash into the approval list while the automated reviewer is still deciding
- `@muse-code/sdk` bundles its protocol type declarations, so consumers typecheck with `skipLibCheck` off; `Item.turnId` is typed as nullable to match what the server sends
- `muse serve`: protected-write approvals wait for the subscribed client's `approval/decide` instead of aborting right after prompting; `session/resume` re-issues pending approval and user-input requests so a reconnecting client can answer them after a crash; a resume with a cursor no longer lets a live event reach the client before the replayed suffix; and views restored after a restart match the live view when a reply was still streaming at checkpoint time
- `muse serve`: `session/list`, `session/read`, and `session/resume` report `running` and the active `turnId` while a turn is in flight; a session whose cached view history is unreadable reports history as unavailable instead of failing every read; failed, cancelled, and timed-out tool calls include the tool's final output; `session/start` ignores unknown keys inside `config` instead of failing; rejected `userShell` commands are settled durably so an identical retry gets the original answer; and a queued follow-up left stranded when the connection closed mid-admission is no longer executed on the next load
- Scheduled (cron) deliveries run as one bounded turn: the end-of-turn goal reminder no longer fires on a scheduled run, which had kept a single delivery looping through phantom ticks every few seconds
- A `muse serve` host that started logged out now picks up a later device-code login on the next session start, resume, or fork instead of answering "auth required" until the host restarts

### Performance {#performance-14}

- `view/page` on long sessions is dramatically faster over `muse serve`: page reads are linear in session size and repeat pages on a loaded session are served from cache
- Faster startup and resume: multi-megabyte checkpoint lines are read in linear time, session-index housekeeping and crash-recovery scans run after the prompt is ready, the trust store is read once per launch, a turn submitted into a resumed session no longer replays history older than the last compaction, and `session/resume` over `muse serve` loads from the latest checkpoint instead of replaying the whole log
- Rewind evaluates and applies from an in-memory window of the current conversation (back to the latest compaction checkpoint) instead of re-reading the session log, so the picker opens faster in long sessions

## 1.0.x {#v1-0-x}

Also delivered in 1.0.x patches: the `tui.terminal_background` setting (`auto`, `light`, or `dark`); `muse serve` sessions expose the same `bash` tools as `muse exec`, `model/list` lists only the models a session can route to, `session/resume` from a cursor delivers the retained events after it, an oversized `session/start` workspace path is refused and `session/list` pages large listings, `initialize` rejects a malformed `clientInfo.name`, and `muse serve` exits with code 3 when settings or credentials cannot be loaded; forking carries compacted permission state into the fork; forked and side sessions show their real creation time instead of 1970; web search reads compressed responses; logging out clears the cached feature configuration; the skill reminder is active again in default `muse exec` runs and no longer repeats its loaded notice; the blocking verify reminder header reads "Double checking"; resume tolerates a blank line in the session log; checkpoint and explicit saves no longer stall behind background flushing; memory writes survive a stale temp file left by a crash; subagent results and goal reminders arrive as developer context; the search tool routes filename lookups to `glob`; Esc exits input-history browsing and restores your draft; `/resume` inside the app shows startup progress instead of a frozen screen; the `/tasks` drawer lists only the visible session's tasks; a retried `turn/interrupt` after a restart no longer records a duplicate rejection; and two security fixes: on-request approval mode requires approval when shell arguments cannot be fully parsed, and provider error messages no longer include the credential that failed.

## 0.2.1 {#v0-2-1}

### New {#new-15}

- Rewind the conversation with a double Esc: pick an earlier point, confirm before anything is undone, and only safe rewind points are offered
- Automatic approval pre-screening: a model-based reviewer clears tool requests it judges safe, so you see fewer prompts. Anything it doesn't clear still comes to you, and it can be disabled
- When the sandbox blocks a command, the agent can ask for a one-time approval to run that exact command outside it
- Added a "Review plan" action to step through long plans that overflow the panel
- Added `muse config` to validate enterprise-managed configuration documents
- Added a built-in skill for setting up isolated Python environments
- Added a built-in skill for handing off and verifying browser apps the agent builds
- Hook commands now receive a selected set of environment variables
- The input box can show a short contextual hint after a turn finishes

### Improvements {#improvements-16}

- Approval dialogs wait for a pause in your typing before appearing, so they stop stealing keystrokes mid-sentence
- Permission decisions are retained in the session log and restored on resume
- The resume picker surfaces sessions that were previously hidden
- `--model` accepts any model id; unknown ids use sensible assumed metadata instead of being rejected
- Settings accept the standard `mcpServers` key, matching the common ecosystem format
- MCP configuration across multiple files and scopes merges consistently
- Clearer diagnostics when an MCP server fails to start, reported once instead of pinned in the interface
- Optional MCP servers that fail at startup no longer spam the transcript
- You can see which of your hooks are running in the live activity area
- Messages sent as a turn finishes are delivered together in one follow-up turn
- Text typed as part of a rewind is kept and restored
- The agent can ask longer questions, up to 500 characters
- The Write tool flags when a new file nearly duplicates an existing one
- Sessions at `ultra` reasoning effort default to maximum parallel-agent capacity unless you set a limit
- Session export stitches in subagent transcripts that finish independently
- Redesigned `/status` as a cleaner summary card
- `/usage` and `/models` label costs explicitly as USD
- Skill slash commands are highlighted while you type
- Tables stay narrow enough to read in a terminal
- The bundled plan skill researches sources first and presents the plan for review before starting work
- Rewrote the built-in plan, doctor, and source-control skills with clearer guidance
- The design skill reliably engages before the assistant writes visual web frontend code
- Within a session, the agent remembers which skills it already read and avoids redundant re-reads
- Skills with aliases appear once under their canonical name
- `skills import --from` errors now list the accepted values

### Fixes {#fixes-16}

- **Security:** a malicious repository's git configuration can no longer run arbitrary commands
- **Security:** git commands on your repos ignore repo-configured hooks, so a malicious repo can't run code through them
- **Security:** skill text containing hidden terminal-control characters is rejected, preventing display spoofing
- **Security:** Linux sandboxed commands can no longer reach host services through Unix-domain sockets
- **Security:** a folder carrying both Mercurial and Sapling metadata is no longer probed for repository status
- Fixed a crash when resuming a session whose background agent run couldn't be re-read
- Fixed a panic when piping output into commands such as `head`
- Fixed a crash on non-UTF-8 command-line arguments
- Partial model responses cut off mid-stream are kept and marked incomplete instead of lost
- Model calls fail fast with a clear status when the network is down, instead of hanging through silent retries
- The working indicator and retry countdown stay visible when a response drops mid-stream
- Streamed answer text no longer appears in the wrong place before the response type is known
- HTTP and HTTPS proxy environment variables are respected for all network traffic
- Keystrokes are no longer lost while an approval decision is submitting
- Multi-line pasted text stays together, including in terminals without bracketed-paste support
- Fixed shifted keys being misread in older VS Code terminals
- Prompts typed in quick succession while a run starts are accepted instead of dropped
- Prompts appear in the transcript as soon as you submit them, even while the run is still starting
- Ctrl-C withdraws queued messages that hadn't started yet
- A steering message you already sent is no longer lost when you retract the turn
- Retracting a turn just after a steering message went through no longer freezes the interface
- Prompts entered when forking a session run in the forked session, not the original
- Esc interrupts the end-of-turn reminder wait instead of appearing to hang
- Tools no longer time out while waiting for you to answer an approval prompt
- Resume restores permission prompts that were still awaiting an answer
- Resumed sessions keep the approval mode you chose
- Permission prompts stay visible when the side panel refreshes
- Denying a network permission request now tells the agent and shows in the transcript
- The automatic permission reviewer is more predictable, with consistent verdicts, retry caps, and timeouts
- `/compact` compacts the session's real working set, including after forks and side chats
- `/compact` runs in the background instead of blocking the session
- Branching into a side chat after a restart no longer breaks conversation history
- Resume replays subagent activity recorded in the parent session log, with the original identity
- Resumed sessions keep subagent lifecycle events in their original order
- Output from background subagents started before a resume is replayed instead of disappearing
- Subagent results that finished before you pressed Esc are preserved instead of disappearing with the cancelled turn
- Long-running background subagents reliably deliver their final answer
- Input submitted just before the app stops is no longer stranded on resume
- Resume no longer writes checkpoints from a half-replayed log, or breaks on expected gaps in the checkpoint log
- Resume no longer risks adopting the wrong `/compact` result during recovery
- Manual `/compact` runs are recorded durably and survive restarts
- A log truncated mid-write no longer restores a partially written permission record
- Session goals are restored with working controls after a kill and resume, and usage totals stay correct when a goal is replaced
- Resumed session goals restore their usage totals instead of failing to resume
- Session goals pause when successive turns stop making progress, instead of looping indefinitely
- Exported sessions keep the full record of permission prompts and decisions
- Sessions get a proper end record on normal exit, keeping history and resume listings accurate
- Closing or losing your terminal is no longer misreported as a crash
- Starting two sessions at the same moment no longer fails to open the local session store on a first run
- Starting from a missing or unreadable folder fails immediately with a clear error
- A prompt passed at startup is no longer occasionally captured as blank
- Fixed a race at run start that could leave the session in a confused launch state
- Headless runs pass your prompt text through unmodified by default
- A `!` shell command whose process dies unexpectedly settles cleanly instead of leaving the session stuck
- Background processes are cleaned up more reliably when a session exits
- The agent gets correct guidance for backgrounding commands from the shell tool on macOS
- Stopping a background task no longer hangs when two stop requests race
- Background reminder checks are tied to their own run, so no activity lingers after it ends
- Headless runs no longer hang after finishing because an older reminder task is still open
- Background command and task ids are globally unique and time-ordered
- Scheduled tasks with a timezone problem warn once instead of every tick
- A corrupt scheduled-task database now warns at startup and identifies where the quarantined data was retained
- A failed subagent launch no longer permanently consumes a capacity slot
- Subagents that finish without a result show a proper final state
- Notes typed in a subagent's view reach the running subagent
- Subagent worktrees whose ownership can't be proven after a crash are quarantined instead of wrongly cleaned up
- Status lines for cancelled and waiting agents show the agent name instead of a raw UUID
- Messages with pasted images sent while the agent is busy arrive in order
- Pasting an image alongside a pending rewind routes correctly
- Hook output starting with a UTF-8 BOM has its allow or deny decision honored
- Project hooks take effect as soon as you trust a folder, without a restart
- Hooks triggered by `!` shell commands are durably recorded and survive resume and export
- Structured JSON output from file hooks is preserved instead of flattened
- Rejected hook output produces a bounded, readable diagnostic
- Shell approval prompts keep the command's original line breaks
- Invalid todo-list tool arguments produce a proper structured error
- A malformed skill on or off value in settings is ignored gracefully instead of breaking loading
- Prompt hints only suggest commands that exist in your session
- A symlinked user config directory no longer breaks loading of project and built-in agent definitions
- Fixed a settings file lock held longer than needed, which could block later writes
- Ctrl-L clears the screen without redraw artifacts
- `/help` shows the full shortcut list in an 80×24 terminal
- Fixed a wildly wrong elapsed time in the activity row after reattaching to a session
- The task panel no longer glitches while old checkpoints are retired
- The `ultra` reasoning-effort display and activation animation no longer pop, flicker, or dim
- On Linux, the command sandbox is selected once at startup so behavior stays consistent for the session
- The built-in doctor skill's session-evidence collection and redaction work correctly again

### Performance {#performance-15}

- Faster startup with a large skill catalog, and an accurate count of skills dropped from the catalog
- Git operations for isolated subagent worktrees no longer block the agent runtime

## 0.1.x {#v0-1-x}

Also delivered in 0.1.x patches: attaching the session recording when reporting a bug as well as a bad result; correct truecolor detection for Ghostty over SSH; reliable replay of terminal command output in long sessions; subagent results shown once with the correct outcome; and a rollback of a built-in instruction change that had regressed answer quality.

## 0.1.0 {#v0-1-0}

- Launch version
