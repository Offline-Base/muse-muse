# Muse Code {#muse-code}

Muse Code is Meta's coding agent for the terminal and CI, built for [Muse Spark](https://dev.meta.ai/docs/models#muse-spark). Run it in a project and it plans, edits, and runs commands to do a task, with approvals and an OS sandbox on from the first run.

Muse Code and the [Model API](https://dev.meta.ai/docs/overview) are two ways to use the same model. Call the API directly when you build your own agent or app. Run Muse Code when you want a ready-made coding agent at the command line or in a pipeline.

[Workflows](https://dev.meta.ai/docs/muse-code/workflows) coordinate parallel and staged agent work when the installed build includes the workflow engine and the rollout is enabled. They are not available on every build or platform. [Session messaging](https://dev.meta.ai/docs/muse-code/session-messaging) lets independent live sessions exchange handoffs, review requests, and status updates.

## Install {#install}

Install Muse Code with the one-line installer. It puts a native `muse` binary on your path.

**macOS and Linux**

```bash
curl -fsSL https://dev.meta.ai/install.sh | sh
```

**Windows**

```powershell
irm https://dev.meta.ai/install.ps1 | iex
```

Confirm it's on your path:

```bash
muse --version
```

## First run {#first-run}

Run `muse` in any project directory to start an interactive session. On first entry Muse Code asks whether to [trust the workspace](https://dev.meta.ai/docs/muse-code/permissions#trust-scopes) (which loads its skills, rules, and hooks) and prompts you to authenticate with a browser sign-in or an API key. The default model is `muse-spark-1.2`.

```bash
cd /path/to/your/project
muse
```

Reopen the sign-in options any time from an interactive session with `/login`. For a non-interactive environment such as [CI](https://dev.meta.ai/docs/muse-code/extending#headless), set `META_API_KEY` instead. See [authentication and billing](https://dev.meta.ai/docs/muse-code/auth) for the full sign-in and billing setup flows.

## Interactive or headless {#modes}

The same binary runs two ways:

- **Interactive**: `muse` opens a terminal UI for a back-and-forth session with slash commands, approvals, and live status. See [working with the agent](https://dev.meta.ai/docs/muse-code/interactive).
- **Headless**: `muse exec "<prompt>"` runs one prompt to completion for scripts and CI. See [headless and CI](https://dev.meta.ai/docs/muse-code/extending#headless).

## Platform support {#platforms}

Muse Code runs on macOS, Linux, and Windows from one codebase. A few capabilities work differently on Windows:

- **PowerShell replaces Bash.** Agent-run commands use PowerShell syntax and Windows command-line tools.
- **The sandbox may prompt for administrator approval.** Windows can show a User Account Control (UAC) prompt the first time the [sandbox](https://dev.meta.ai/docs/muse-code/permissions#sandbox) initializes. Normal use does not require running as administrator.
- **Voice input is unavailable** on Windows. See [voice input](https://dev.meta.ai/docs/muse-code/interactive#voice).
- **Session messaging is unavailable** on Windows. It is supported on macOS and Linux. See [session messaging](https://dev.meta.ai/docs/muse-code/session-messaging).

## Drive it from your own program {#sdk}

Beyond the CLI, you can drive a Muse Code session from your own program over a stable, versioned session protocol. `muse serve` runs the protocol, and `muse schema` prints its JSON schema. The TypeScript SDK wraps the protocol: install it with `npm install @muse-code/sdk`. A quickstart, cookbook recipes, and a generated API reference are in [the Muse Code SDK docs](https://meta-models.github.io/muse-code-sdk).

## What to read next {#whats-here}

- **[Authentication and billing](https://dev.meta.ai/docs/muse-code/auth)**: sign in, API keys, and plans.
- **[Permissions and safety](https://dev.meta.ai/docs/muse-code/permissions)**: approval modes, staged shell review, and the sandbox.
- **[Working with the agent](https://dev.meta.ai/docs/muse-code/interactive)**: slash commands to steer a session, manage context, set goals, and more.
- **[Rewind a conversation](https://dev.meta.ai/docs/muse-code/rewind)**: branch from an earlier message while preserving the original session and workspace files.
- **[Workflows](https://dev.meta.ai/docs/muse-code/workflows)**: check availability, coordinate parallel and staged agent work, monitor runs, and save repeatable workflows.
- **[Session messaging](https://dev.meta.ai/docs/muse-code/session-messaging)**: send handoffs, review requests, and status updates between live local sessions.
- **[Configuration and context](https://dev.meta.ai/docs/muse-code/configuration)**: settings, project instructions, model selection, and memory.
- **[Extending and automating](https://dev.meta.ai/docs/muse-code/extending)**: subagents, skills, hooks, MCP, and headless runs.

## Next steps {#next-steps}

- Sign in and set up billing in [authentication and billing](https://dev.meta.ai/docs/muse-code/auth).
- Understand the guardrails before your first real task in [permissions and safety](https://dev.meta.ai/docs/muse-code/permissions).
