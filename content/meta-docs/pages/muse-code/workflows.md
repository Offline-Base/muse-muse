# Run multi-agent workflows {#run-multi-agent-workflows}

Use a workflow when one task benefits from several agents working independently or in stages. Muse Code creates the orchestration, runs the child agents, and returns a synthesized result to your session.

> **IMPORTANT: Workflow availability depends on the build and rollout**
>
> Workflows require a build that includes the workflow script engine and access to the staged `WorkflowTool` rollout. If either requirement is unavailable, Muse Code omits the Workflow tool and `/workflows`. The current public `aarch64-apple-darwin` package does not include `workflow-script-engine-v8`, so workflows are unavailable in that Apple silicon macOS artifact.

## Start a workflow {#start}

Ask Muse Code to use a workflow and describe how you want the work divided. An explicit request starts the workflow without an extra confirmation:

```text
Use a workflow to review this service. Have separate agents inspect the API design,
security boundaries, and test coverage. Verify the findings, then return one prioritized report.
```

You can also describe a large task without naming workflows. When the **Workflows** setting is `auto`, Muse Code can propose a workflow if the task has enough independent work to justify the added time and token usage.

Use workflows for work such as:

- Auditing several subsystems in parallel.
- Comparing independent implementation approaches.
- Researching a question across several sources, then checking the claims.
- Splitting a migration into isolated ownership areas.
- Running an implementation, verification, and synthesis sequence.

Keep a task on the main agent when it is a small edit, a short explanation, or a tightly coupled change that needs one continuous line of reasoning.

## Choose workflows or subagents {#choose}

Both features delegate work to child agents. They provide different levels of control:

| Use                                                                   | Choose it when                                                                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [Subagents](https://dev.meta.ai/docs/muse-code/extending#multi-agent) | The lead agent needs one or more bounded helpers and can manage them directly.                                          |
| Workflows                                                             | The task needs repeatable orchestration, parallel groups, dependent stages, progress phases, or a final synthesis step. |

A workflow can call up to 1,000 child tasks over its lifetime. The local active-child limit is CPU-derived and capped at 16. A request-array batch wider than the effective limit queues the remaining work. Attempting a 1,001st child call fails the workflow before that child launches. Each child makes its own model calls, so a broad workflow can use substantially more tokens than a normal turn.

## Monitor and control a run {#monitor}

Run `/workflows` to open the workflow control room. The list shows each workflow's status, elapsed time, token usage, and child progress.

Use these controls from the run list:

- **Up and Down**, or **J and K**: select a run.
- **Enter** or **Right**: open its phases and child agents.
- **C**: cancel the selected workflow.
- **R**: open the result of a completed workflow.
- **Space** or **Esc**: close the control room.

Inside a workflow, you can pause or resume the run with **P**, skip a selected running child with **X**, and restart a selected running child with **R**. **R** is not a general retry for completed or failed children. Press **Esc** or **Left** to return to the previous level, or **Space** to close the control room from any level. The available action depends on the selected row and its current state.

The workflow continues in the background. Muse Code delivers its completion to the conversation, so you don't need to poll it.

## Structure effective workflow requests {#requests}

Give each child a bounded responsibility and define the final deliverable. This prompt gives Muse Code enough structure while leaving implementation details to the workflow author:

```text
Use a workflow to prepare this repository for the dependency upgrade.

1. Inspect production call sites and compatibility risks.
2. Inspect tests, build configuration, and release constraints in parallel.
3. Have a verifier challenge every high-risk finding.
4. Synthesize an ordered implementation plan with file references.

Keep this run read-only.
```

For tasks that change files, state whether parallel writers should use isolated worktrees. Isolation gives each child a separate Git worktree and prevents concurrent writes from colliding:

```text
Use a workflow to update these independent packages. Give each writing agent an
isolated worktree, run the package tests, ask each writer to commit its changes,
then summarize the commits for review.
```

Keep read-only children in the shared workspace. Worktree isolation follows the same rules as for [subagents](https://dev.meta.ai/docs/muse-code/extending#multi-agent): it requires a Git repository and is never applied as a silent fallback.

## Save a reusable workflow {#save}

Save a JavaScript workflow when your team repeats the same orchestration pattern. Ask Muse Code to author a script from your requirements. You can also provide an existing `.js` script written for your Muse Code version:

```text
Create review-change.js as a reusable workflow that reviews the current change for
API compatibility, security risks, and missing tests in parallel, then synthesizes
one prioritized report. Keep every child read-only.
```

Save it at project scope to write `.agents/workflows/review-change.js`:

```bash
muse workflows save review-change --from ./review-change.js --scope project
```

The save is local. Commit or otherwise share `.agents/workflows/review-change.js` before another clone can discover it. User-scoped workflows are stored in your Muse Code configuration directory and remain local to your account.

Before listing project workflows, start Muse Code in the repository and trust the workspace. Then exit the session and run:

```bash
muse workflows list
```

A project-scoped and user-scoped workflow can have the same name. Discovery selects the project workflow because project scope has higher precedence.

Muse Code loads named workflows once when a session starts. Save the workflow before launching the session that will run it. If a session is already open, restart Muse Code after saving. Muse Code loads project workflows after you [trust the workspace](https://dev.meta.ai/docs/muse-code/permissions#trust-scopes). User-scoped workflows remain available across projects.

Run a saved workflow by asking for it in an interactive session:

```text
Run the saved review-change workflow against my current changes.
```

Workflow names can contain lowercase letters, digits, periods, underscores, and hyphens. The first character must be a lowercase letter or digit, and the complete name can contain up to 64 characters.

> **NOTE: Authoring constraints**
>
> The source must be a regular, nonempty UTF-8 file no larger than 512 KiB. Saving validates the file and name, but it does not parse or run the JavaScript. Syntax errors appear when the workflow launches. Saving defaults to project scope. A collision at the exact selected destination fails unless you pass `--overwrite`; the same name may exist in another scope. A completed script must return a JSON-serializable value; `undefined` and other non-JSON terminal values fail the workflow.

## Recover and revise a workflow {#recover}

In an ordinary retained interactive session, Muse Code persists generated inline JavaScript under the durable workflow directory inside that session's retained directory. The Workflow result returns the script as `scriptPath`. If no workflow session directory is available, including relevant `muse --no-session-log` sessions, Muse Code falls back to process-lifetime temporary storage. That fallback disappears when the process exits and cannot support retained recovery.

For same-process editing, wait for the failed workflow owner to stop, edit the returned `scriptPath`, and call the Workflow tool with that path and the same run's `resumeFromRunId`. The resumed workflow evaluates the script from the top and reuses the longest unchanged prefix of completed child calls.

For recovery after a process restart, use a workflow-engine-enabled build and the retained session identifiers:

```bash
muse workflows recover <run-id> --session <session-id> --apply
```

Restart recovery reads the retained workflow records and script. It reuses committed results and restarts only remaining child work when applicable.

Wait for the current workflow attempt to finish or fail before you resume it. One workflow owner runs at a time.

## Configure workflow selection {#configure}

Open `/settings`, find **Tools > Workflows**, and select one of these modes:

- **`auto`**: Muse Code can propose and launch a workflow for workflow-scale work.
- **`explicit`**: Muse Code launches a workflow when you request one directly.
- **`off`**: Muse Code removes the workflow tool from the session.

The setting applies immediately to the current session.

## Next steps {#next-steps}

- Start with direct helper agents in [subagents and multi-agent](https://dev.meta.ai/docs/muse-code/extending#multi-agent).
- Coordinate separate live sessions with [session messaging](https://dev.meta.ai/docs/muse-code/session-messaging).
- Set model and reasoning defaults in [configuration and context](https://dev.meta.ai/docs/muse-code/configuration).
