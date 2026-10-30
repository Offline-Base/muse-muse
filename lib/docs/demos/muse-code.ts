import { AgentConfigGenerator } from "@/components/docs/playgrounds/muse-code/AgentConfigGenerator";
import { ApprovalSimulator } from "@/components/docs/playgrounds/muse-code/ApprovalSimulator";
import { AuthSetup } from "@/components/docs/playgrounds/muse-code/AuthSetup";
import { ChangelogExplorer } from "@/components/docs/playgrounds/muse-code/ChangelogExplorer";
import { CommandExplorer } from "@/components/docs/playgrounds/muse-code/CommandExplorer";
import { ExtendingBuilder } from "@/components/docs/playgrounds/muse-code/ExtendingBuilder";
import { FrameworkSetup } from "@/components/docs/playgrounds/muse-code/FrameworkSetup";
import { MuseCodeStart } from "@/components/docs/playgrounds/muse-code/MuseCodeStart";
import { PlanPicker } from "@/components/docs/playgrounds/muse-code/PlanPicker";
import { RewindTimeline } from "@/components/docs/playgrounds/muse-code/RewindTimeline";
import { SessionMessagingSim } from "@/components/docs/playgrounds/muse-code/SessionMessagingSim";
import { SettingsBuilder } from "@/components/docs/playgrounds/muse-code/SettingsBuilder";
import { WorkflowPlanner } from "@/components/docs/playgrounds/muse-code/WorkflowPlanner";
import type { DemoMap } from "@/lib/docs/demos/types";

/**
 * Live demos and coding-agent prompts for the "muse-code" pages:
 *   muse-code
 *   muse-code/auth
 *   muse-code/subscriptions
 *   muse-code/permissions
 *   muse-code/interactive
 *   muse-code/workflows
 *   muse-code/session-messaging
 *   muse-code/rewind
 *   muse-code/configuration
 *   muse-code/extending
 *   muse-code/changelog
 *   coding-agents
 *   agent-frameworks
 * Components live in components/docs/playgrounds/muse-code/.
 *
 * The Muse Code CLI can't run in a browser, so its pages get builders, simulators and explorers made from the page's
 * own facts, plus a live call through the docs proxy where one shows something real: the same prompt on the model
 * Muse Code runs on, a stand-in approval judge, a fan-out workflow, a delivered peer message, a rewound branch, two
 * reasoning efforts side by side, config checks, and an agent loop. Each agentPrompt hands the reader's coding agent
 * a task in their own repository, with the facts it would otherwise get wrong.
 */
export const museCodeDemos: DemoMap = {
  "muse-code": {
    title: "Install Muse Code and run your first prompt",
    blurb:
      "Copy the installer and first-run commands for your OS, see what differs by platform, build the command for what you want to do, then send a prompt straight to the model Muse Code runs on. Under a cent a message, about 2 cents on Muse Wonder.",
    Component: MuseCodeStart,
    props: {
      prompt: "Run the test suite and summarize failures.",
      // No tools, shell or workspace here: the model says what it would run instead of inventing a session's output.
      system:
        "You are a senior engineer. You have no tools, shell or workspace in this chat, so you can't run anything: say which commands you would run and what to look for in their output, and never invent command output. Be brief and concrete.",
      presets: [
        { label: "Explain a command", prompt: "What does this shell command do, and is it safe to run in a repo? wc -l report.log && echo cleaning && rm -rf report.log" },
        { label: "Write a test", prompt: "Write a pytest test for slugify(title), which lowercases a title and joins its words with hyphens. Under 15 lines." },
        { label: "Plan a change", prompt: "In five short steps, plan how to add input validation to a signup handler and prove it with tests." },
      ],
    },
    agentPrompt: {
      task: 'Make this repository ready for Muse Code. Add scripts/muse-exec.sh that checks `muse --version` (printing the one-line install command for this OS when muse is missing), then runs `muse exec "$@"` from the repo root so any prompt can run headless. Add a short "Using Muse Code" section to the README: install, first run (`muse` in the repo, trust the workspace, sign in with the browser or an API key, `/login` to reopen it) and META_API_KEY for CI. Don\'t install anything or sign in yourself.',
      facts: [
        "Install: `curl -fsSL https://dev.meta.ai/install.sh | sh` (macOS, Linux) or `irm https://dev.meta.ai/install.ps1 | iex` (Windows PowerShell); confirm with `muse --version`.",
        "`muse` starts a session. The first run asks to trust the workspace (that loads its skills, rules and hooks) and to sign in with a browser or an API key.",
        '`muse exec "<prompt>"` runs one prompt to completion. Without a browser, Muse Code reads META_API_KEY (not MODEL_API_KEY).',
        "The default model is muse-spark-1.2; `--model` overrides it per run.",
        "On Windows agent commands use PowerShell, voice input and session messaging are unavailable, and the sandbox may show a UAC prompt once.",
        "Programs can drive a session with `muse serve` (`muse schema` prints the protocol's JSON schema) or `npm install @muse-code/sdk`.",
      ],
      checklist: [
        'bash scripts/muse-exec.sh "Summarize this repo" prints the agent\'s answer when muse is installed, and the install command when it isn\'t.',
        "The README section covers install, first run, /login and META_API_KEY for CI.",
      ],
      snippets: {
        curl: `#!/usr/bin/env bash
# scripts/muse-exec.sh: run one Muse Code prompt headless from the repo root.
set -euo pipefail
if ! command -v muse >/dev/null 2>&1; then
  echo "Muse Code isn't installed. Install it with:"
  echo "  curl -fsSL https://dev.meta.ai/install.sh | sh"
  exit 1
fi
muse --version
cd "$(git rev-parse --show-toplevel)"
# Signed in once with \`muse\`, or META_API_KEY set (CI): either works.
muse exec "$@"`,
        python: `import shutil
import subprocess
import sys

# Run one Muse Code prompt headless; the agent's output comes back on stdout.
if shutil.which("muse") is None:
    sys.exit("Install Muse Code: curl -fsSL https://dev.meta.ai/install.sh | sh")

prompt = " ".join(sys.argv[1:]) or "Summarize this repo."
run = subprocess.run(["muse", "exec", prompt], capture_output=True, text=True)
print(run.stdout)
if run.returncode != 0:
    sys.exit(f"muse exec exited {run.returncode}: {run.stderr.strip()}")`,
        typescript: `import { spawnSync } from "node:child_process";

// Run one Muse Code prompt headless from the repo root.
const prompt = process.argv.slice(2).join(" ") || "Summarize this repo.";
const run = spawnSync("muse", ["exec", prompt], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
if (run.error) {
  console.error("Install Muse Code: curl -fsSL https://dev.meta.ai/install.sh | sh");
  process.exit(1);
}
process.stdout.write(run.stdout);
process.exit(run.status ?? 1);`,
      },
    },
  },

  "muse-code/auth": {
    title: "See which credential wins, and set up CI",
    blurb:
      "Toggle what's set on a machine to see which credential Muse Code uses and what muse logout leaves behind, then build a CI job that reads META_API_KEY from your secret store. Nothing here asks for a key.",
    Component: AuthSetup,
    props: { secret: "MUSE_KEY", prompt: "Run the test suite and summarize failures." },
    agentPrompt: {
      task: "Add a CI job to this repository that runs Muse Code headless on demand: install the CLI, confirm `muse --version`, and run `muse exec` with META_API_KEY taken from the CI secret store (a secret named MUSE_KEY), --disable-approval, a --max-model-steps cap and --contributor-mode off. Then run the project's own tests as the real gate. Use the CI system this repo already has, or GitHub Actions if it has none.",
      facts: [
        "Muse Code reads META_API_KEY. An API key always beats a browser sign-in: META_API_KEY, then a key stored with `muse auth set`, then a stored browser session.",
        'CI has no browser: pass the secret through the environment, as in `META_API_KEY="$MUSE_KEY" muse exec "..."`. Never echo it or write it to a file.',
        "Meta Managed Accounts (Business & Enterprise sign-up) can't use the browser sign-in; they always use an API key.",
        "`muse logout` clears the stored session and stored key, never an exported META_API_KEY.",
        "Headless runs can't answer approval prompts: --disable-approval keeps the sandbox; --yolo drops it and trusts the workspace, so only in a disposable container with trusted code.",
        "Pin Contributor mode per run (`--contributor-mode off` or MUSE_CONTRIBUTOR_MODE=0): saved settings differ by machine.",
      ],
      checklist: [
        "The job uses the secret only through the environment (secrets.MUSE_KEY or $MUSE_KEY); no key appears anywhere in the repo.",
        "A manual run installs muse, prints its version, runs the prompt, then runs the tests and fails the job when they fail.",
      ],
      snippets: {
        curl: `# .github/workflows/muse-code.yml
name: Muse Code
on:
  workflow_dispatch:
jobs:
  muse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Muse Code
        env:
          META_API_KEY: \${{ secrets.MUSE_KEY }}
        run: |
          curl -fsSL https://dev.meta.ai/install.sh | sh
          muse --version
          muse exec --disable-approval --max-model-steps 40 --contributor-mode off "Run the test suite and summarize failures."
      - name: Check the result yourself
        run: npm test`,
        python: `import os
import subprocess
import sys

# CI step: META_API_KEY comes from the pipeline's secret store, never from the repo.
if not os.environ.get("META_API_KEY"):
    sys.exit("META_API_KEY isn't set: add it from your CI secret store.")

cmd = ["muse", "exec", "--disable-approval", "--max-model-steps", "40",
       "--contributor-mode", "off", "Run the test suite and summarize failures."]
run = subprocess.run(cmd, text=True)
if run.returncode != 0:
    sys.exit(f"muse exec ended with exit code {run.returncode}")
# Exit 0 means the turn completed, not that the work is right: gate on the tests.
subprocess.run(["npm", "test"], check=True)`,
        typescript: `import { spawnSync } from "node:child_process";

// CI step: META_API_KEY comes from the pipeline's secret store, never from the repo.
if (!process.env.META_API_KEY) throw new Error("META_API_KEY isn't set: add it from your CI secret store.");

const run = spawnSync(
  "muse",
  ["exec", "--disable-approval", "--max-model-steps", "40", "--contributor-mode", "off", "Run the test suite and summarize failures."],
  { stdio: "inherit" },
);
if (run.status !== 0) throw new Error(\`muse exec ended with exit code \${run.status}\`);
// Exit 0 means the turn completed, not that the work is right: gate on the tests.
const tests = spawnSync("npm", ["test"], { stdio: "inherit" });
process.exit(tests.status ?? 1);`,
      },
    },
  },

  "muse-code/subscriptions": {
    title: "Pick a plan, and see when a run is in Contributor mode",
    blurb:
      "Compare the four plans against your usage and the features you need (with a rough pay-as-you-go estimate), work out whether a run will be in Contributor mode by the page's rules, and list your renewal and cancel-by dates.",
    Component: PlanPicker,
    props: { prompts: 30, subscribed: "2026-01-31" },
    agentPrompt: {
      task: "Make every scripted Muse Code run in this repository state its Contributor mode: find each `muse exec` (scripts, CI, Makefile, package.json) and add `--contributor-mode off` (or on, if I say so), or set MUSE_CONTRIBUTOR_MODE for the whole job. Add a README note saying how this project is billed and how to switch Contributor mode in an interactive session.",
      facts: [
        "Headless runs use the saved setting: off with no settings file, possibly on if the file exists but the setting was never saved. So set it on every scripted run.",
        "`--contributor-mode on|off` or MUSE_CONTRIBUTOR_MODE=1|0 sets one run without changing the saved setting; when both are set, the flag wins.",
        "In a session: /settings, Model, the Contributor mode row, Enter. It's saved per computer and applies from the next request.",
        "The row exists only with an active Muse Code subscription: not with pay-as-you-go or a Zero Data Retention account, and not when your organization manages the setting (then it stays off, and the flag and variable have no effect).",
        "Contributor mode gives more usage in exchange for Meta training on your content. Plans: Everyday (10-50 prompts every 5 hours), High (5x), Power (20x, Muse Wonder Full), Maximum (80x).",
      ],
      checklist: [
        "`grep -rn \"muse exec\" .` shows every match with --contributor-mode, or inside a job that sets MUSE_CONTRIBUTOR_MODE.",
        "The README says how the project is billed and how to change Contributor mode.",
      ],
      snippets: {
        curl: `# Pin Contributor mode on every headless run (the flag wins over the variable).
muse exec --contributor-mode off "Summarize the changes on this branch"

# Or for a whole job:
export MUSE_CONTRIBUTOR_MODE=0
muse exec "Summarize the changes on this branch"`,
        python: `import os
import subprocess

# Every scripted run states its Contributor mode: saved settings differ by machine.
env = {**os.environ, "MUSE_CONTRIBUTOR_MODE": "0"}
subprocess.run(
    ["muse", "exec", "--contributor-mode", "off", "Summarize the changes on this branch"],
    env=env,
    check=True,
)`,
        typescript: `import { execFileSync } from "node:child_process";

// Every scripted run states its Contributor mode: saved settings differ by machine.
execFileSync("muse", ["exec", "--contributor-mode", "off", "Summarize the changes on this branch"], {
  stdio: "inherit",
  env: { ...process.env, MUSE_CONTRIBUTOR_MODE: "0" },
});`,
      },
    },
  },

  "muse-code/permissions": {
    title: "Watch approval and the sandbox review a shell command",
    blurb:
      "Type a command or pick one to see it split into stages, which pass and which hold for review under each profile and approval mode, and what the sandbox allows. In Auto-review, a stand-in judge on the API can review the held stage. Under a cent, about 2 cents on Muse Wonder.",
    Component: ApprovalSimulator,
    props: { task: "Clean up old log files before a fresh test run." },
    agentPrompt: {
      task: "Audit how this repository runs Muse Code and tighten its guardrails. Find every muse and muse exec invocation (scripts, CI, docs). Replace --yolo and --disable-sandbox with --disable-approval wherever the job isn't a disposable container, never allow --yolo on pull-request or fork checkouts, add --sandbox-network restricted to jobs that don't need the network, and write docs/muse-permissions.md listing each job's posture and why.",
      facts: [
        "Two independent layers: approval (risky tool calls wait for a decision) and an OS sandbox (writes only in the workspace and temp dir; .git, .muse and .agents stay read-only).",
        "--approval-mode on-request (default) passes recognized safe stages and holds dangerous ones (rm -rf forms, ripgrep -z, --pre, --hostname-bin); untrusted holds any shell stage without an allow rule; never holds nothing.",
        "Compound commands are reviewed stage by stage; rejecting a held stage runs nothing at all.",
        "--sandbox-network proxy-only (default: the first connection to a new host asks), restricted (none) or unrestricted.",
        "--yolo means no approval, no sandbox and a trusted workspace: it loads the checkout's AGENTS.md, rules and skills, which on a PR or fork are attacker-controlled. --disable-sandbox also lets file tools write anywhere.",
      ],
      checklist: [
        "`grep -rnE -- \"--yolo|--disable-sandbox\" .` matches only jobs documented as disposable containers, none triggered by pull requests.",
        "docs/muse-permissions.md lists every job with its flags and the reason for them.",
      ],
      snippets: {
        curl: `# Unattended but contained: approvals skipped, the sandbox still on, no network.
muse exec --disable-approval --sandbox-network restricted --max-model-steps 40 \\
  "Run the unit tests and summarize failures."

# Stricter interactive review: every shell stage without an allow rule asks you.
muse --approval-mode untrusted --approval-judge off`,
        python: `import pathlib
import re

# List every Muse Code invocation that drops a guardrail, for the audit.
RISKY = re.compile(r"--yolo|--disable-sandbox")
for path in pathlib.Path(".").rglob("*"):
    if ".git" in path.parts or not path.is_file():
        continue
    try:
        text = path.read_text()
    except (UnicodeDecodeError, PermissionError):
        continue
    for n, line in enumerate(text.splitlines(), 1):
        if "muse" in line and RISKY.search(line):
            print(f"{path}:{n}: {line.strip()}")`,
        typescript: `import { readdirSync, readFileSync, statSync } from "node:fs";

// List every Muse Code invocation that drops a guardrail, for the audit.
const risky = /--yolo|--disable-sandbox/;
for (const file of readdirSync(".", { recursive: true }) as string[]) {
  if (file.split("/").includes(".git") || !statSync(file).isFile()) continue;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split("\\n").forEach((line, i) => {
    if (line.includes("muse") && risky.test(line)) console.log(\`\${file}:\${i + 1}: \${line.trim()}\`);
  });
}`,
      },
    },
  },

  "muse-code/interactive": {
    title: "Find the right command, steer a turn, schedule a /loop",
    blurb:
      "Search every slash command and shortcut the Muse Code pages document, press Enter, Alt+Enter, Esc and Ctrl+C on a pretend running turn to see what each does, and check what a /loop cadence schedules before it expires.",
    Component: CommandExplorer,
    props: { loop: "/loop 10m /run-tests" },
    agentPrompt: {
      task: "Make the page's `/loop 10m /run-tests` example work in this repository: create a project skill at .agents/skills/run-tests/SKILL.md that runs this repo's test command, summarizes failures in a few lines and changes nothing. Then add docs/muse-session.md for the team with the commands that matter here: /goal for long tasks, /loop with this skill, /compact and /recap, /fork and /rewind, /stop versus Esc, and the steering keys.",
      facts: [
        "/loop takes an interval (5m, 1h, 2d) or a quoted 5-field cron in local time; no cadence means every 10 minutes. Jobs expire after 7 days; an occurrence during an active run is skipped.",
        "Project skills live at <repo>/.agents/skills/<skill-id>/SKILL.md (name and description front matter, as Claude Code and Codex skills use). Check one with `muse skills validate <dir>`.",
        "While a turn runs: Enter steers it, Alt+Enter queues for the next turn, Esc interrupts it (not background work: that's /stop), Esc on an empty composer retracts the newest queued item.",
        "/compact summarizes context (lossy for the model; scrollback stays); /recap summarizes recent activity without changing context.",
        "/new keeps scrollback, /clear wipes it; /fork branches from the latest point; /rewind from an earlier message; /side opens a side conversation.",
      ],
      checklist: [
        "`muse skills validate ./.agents/skills/run-tests` passes, and the skill uses this repo's real test command.",
        "docs/muse-session.md lists /loop 10m /run-tests and each other command with one line on when to use it.",
      ],
      snippets: {
        curl: `mkdir -p .agents/skills/run-tests
cat > .agents/skills/run-tests/SKILL.md <<'EOF'
---
name: run-tests
description: Run this repo's test suite and summarize failures. Used by /loop 10m /run-tests.
---
# Run the tests

1. Run the test command from the repo root (npm test here; use this repo's real one).
2. Report the pass and fail counts, then each failure in one line with its file.
3. Change nothing: no edits, no commits.
EOF
muse skills validate ./.agents/skills/run-tests
# Then, in a session: /loop 10m /run-tests`,
        python: `import pathlib
import subprocess

skill = pathlib.Path(".agents/skills/run-tests/SKILL.md")
skill.parent.mkdir(parents=True, exist_ok=True)
skill.write_text("""---
name: run-tests
description: Run this repo's test suite and summarize failures. Used by /loop 10m /run-tests.
---
# Run the tests

1. Run the test command from the repo root (use this repo's real one).
2. Report the pass and fail counts, then each failure in one line with its file.
3. Change nothing: no edits, no commits.
""")
subprocess.run(["muse", "skills", "validate", str(skill.parent)], check=True)`,
        typescript: `import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const dir = ".agents/skills/run-tests";
mkdirSync(dir, { recursive: true });
writeFileSync(\`\${dir}/SKILL.md\`, [
  "---",
  "name: run-tests",
  "description: Run this repo's test suite and summarize failures. Used by /loop 10m /run-tests.",
  "---",
  "# Run the tests",
  "",
  "1. Run the test command from the repo root (use this repo's real one).",
  "2. Report the pass and fail counts, then each failure in one line with its file.",
  "3. Change nothing: no edits, no commits.",
  "",
].join("\\n"));
execFileSync("muse", ["skills", "validate", dir], { stdio: "inherit" });`,
      },
    },
  },

  "muse-code/workflows": {
    title: "Plan a workflow, save it, and run a small one live",
    blurb:
      "Write a workflow request in the page's structure, check a saved workflow's name, file and save command and both ways to recover a failed run, see how the child limits play out, drive the control room's keys, then run three child calls in parallel and a synthesis call on the API. Under a cent a run; about 7 cents on Muse Wonder.",
    Component: WorkflowPlanner,
    props: {},
    agentPrompt: {
      task: "Prepare this repository for Muse Code workflows. Add docs/workflows.md with three request templates written for this repo (a parallel review of its real subsystems, a dependency-upgrade plan, and package updates in isolated worktrees), and scripts/save-workflow.sh <name> <file.js> that checks the name and file the way `muse workflows save` does, then saves at project scope and lists workflows. Don't write workflow JavaScript yourself: the request templates are what I'll ask Muse Code to author.",
      facts: [
        "Workflows need a build with the workflow engine and the WorkflowTool rollout (not the public aarch64-apple-darwin package). /settings, Tools, Workflows: auto, explicit or off.",
        "Up to 1,000 child tasks per workflow and at most 16 active (CPU-derived); wider batches queue; a 1,001st child fails the run. Each child makes its own model calls.",
        "`muse workflows save <name> --from <file.js> --scope project|user [--overwrite]`; project scope writes .agents/workflows/<name>.js, so commit it to share. Project wins a name clash with user.",
        "Names: lowercase letters, digits, periods, underscores and hyphens, starting with a letter or digit, up to 64. Files: regular, nonempty UTF-8, at most 512 KiB; saving doesn't parse the JS.",
        "Workflows load at session start, project ones only in a trusted workspace. After a restart: `muse workflows recover <run-id> --session <session-id> --apply`.",
      ],
      checklist: [
        'scripts/save-workflow.sh refuses "Review Change" and a 600 KiB file, and saves a valid one.',
        "docs/workflows.md has the three templates with this repo's real subsystem and package names.",
      ],
      snippets: {
        curl: `#!/usr/bin/env bash
# scripts/save-workflow.sh <name> <file.js>: check what muse workflows save checks, then save.
set -euo pipefail
name="$1"; file="$2"
[[ "$name" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || { echo "Bad name: lowercase letters, digits, . _ -, starting with a letter or digit, up to 64."; exit 2; }
[[ -f "$file" && -s "$file" ]] || { echo "$file is missing or empty."; exit 2; }
(( $(wc -c < "$file") <= 524288 )) || { echo "$file is over 512 KiB."; exit 2; }
iconv -f UTF-8 -t UTF-8 "$file" > /dev/null || { echo "$file isn't valid UTF-8."; exit 2; }
muse workflows save "$name" --from "$file" --scope project
muse workflows list`,
        python: `import pathlib
import re
import subprocess
import sys

name, file = sys.argv[1], pathlib.Path(sys.argv[2])
if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", name):
    sys.exit("Bad name: lowercase letters, digits, . _ -, starting with a letter or digit, up to 64.")
data = file.read_bytes() if file.is_file() else b""
if not data or len(data) > 512 * 1024:
    sys.exit(f"{file} must be a nonempty file of at most 512 KiB.")
data.decode("utf-8")  # raises on invalid UTF-8
subprocess.run(["muse", "workflows", "save", name, "--from", str(file), "--scope", "project"], check=True)
subprocess.run(["muse", "workflows", "list"], check=True)`,
        typescript: `import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [name, file] = process.argv.slice(2);
if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name ?? "")) throw new Error("Bad name: lowercase letters, digits, . _ -, starting with a letter or digit, up to 64.");
const data = readFileSync(file);
if (!data.length || data.length > 512 * 1024) throw new Error(\`\${file} must be nonempty and at most 512 KiB.\`);
new TextDecoder("utf-8", { fatal: true }).decode(data); // throws on invalid UTF-8
execFileSync("muse", ["workflows", "save", name, "--from", file, "--scope", "project"], { stdio: "inherit" });
execFileSync("muse", ["workflows", "list"], { stdio: "inherit" });`,
      },
    },
  },

  "muse-code/session-messaging": {
    title: "Name sessions and pass messages between them",
    blurb:
      "Rename sessions by the page's rules, send between them with each delivery behavior, approve or block a peer and let a request expire, then hand a delivered message to a live model to see it stay data. Under a cent, about 2 cents on Muse Wonder.",
    Component: SessionMessagingSim,
    props: {},
    agentPrompt: {
      task: "Set this repository up for parallel Muse Code sessions. Add docs/parallel-sessions.md with our convention: session names by responsibility (implementation-<suffix>, api-review-<suffix>), read-only sessions in the main checkout and each writer in its own worktree (`muse -w`), and message templates for a review request, a handoff and a completion check. Add scripts/check-session-name.sh that normalizes and validates a proposed name by Muse Code's rules.",
      facts: [
        "Names: uppercase is lowercased first; then 3-32 characters, a lowercase letter first, lowercase letters, digits and single hyphens, no trailing hyphen. all, self and current are reserved.",
        "Names are unique across all your sessions, and old names stay reserved to theirs. Address peers by exact name or full UUID, after listing peers.",
        "Messages are plain text up to 8,192 bytes; self-messages are rejected; duplicate message ids are deduplicated. Delivery: steer the active turn (default), queue for the next turn, or notify only.",
        "Unverified senders may prompt: Allow once, Reject once, Allow or Block for this session. Requests expire after 30 minutes, then a 30-minute retry cooldown.",
        "A message can't approve tools, grant consent or change permissions. Only interactive sessions of one user on one macOS or Linux machine; not Windows, headless or --no-session-log.",
      ],
      checklist: [
        "scripts/check-session-name.sh API-Review-482731 prints valid: api-review-482731, and it rejects ab, review--api, api-, all and 1review.",
        "docs/parallel-sessions.md shows the naming convention, muse -w for writers, and the three message templates.",
      ],
      snippets: {
        curl: `#!/usr/bin/env bash
# scripts/check-session-name.sh <name>: Muse Code's session-name rules.
name="$(printf '%s' "$1" | tr 'A-Z' 'a-z')"
case "$name" in all|self|current) echo "\\"$name\\" is reserved"; exit 1 ;; esac
if [[ \${#name} -ge 3 && \${#name} -le 32 && "$name" =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ ]]; then
  echo "valid: $name"
else
  echo "invalid: $name (3-32 characters, a lowercase letter first, then letters, digits and single hyphens)"
  exit 1
fi`,
        python: `import re
import sys

def check(raw: str) -> str:
    """Muse Code's session-name rules; returns the stored name or raises ValueError."""
    name = "".join(c.lower() if "A" <= c <= "Z" else c for c in raw.strip())
    if name in {"all", "self", "current"}:
        raise ValueError(f"{name!r} is reserved")
    if not (3 <= len(name) <= 32 and re.fullmatch(r"[a-z][a-z0-9]*(-[a-z0-9]+)*", name)):
        raise ValueError(f"{name!r}: 3-32 chars, a lowercase letter first, letters, digits, single hyphens")
    return name

print("valid:", check(sys.argv[1]))`,
        typescript: `// Muse Code's session-name rules; returns the stored name or throws.
export function checkSessionName(raw: string): string {
  const name = raw.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (["all", "self", "current"].includes(name)) throw new Error(\`"\${name}" is reserved\`);
  if (name.length < 3 || name.length > 32 || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(\`"\${name}": 3-32 chars, a lowercase letter first, letters, digits, single hyphens\`);
  }
  return name;
}

console.log("valid:", checkSessionName(process.argv[2] ?? ""));`,
      },
    },
  },

  "muse-code/rewind": {
    title: "Rewind a live conversation into a new branch",
    blurb:
      "Hold a short conversation on the Responses API, then rewind to an earlier message: a new branch continues from the response before it with the message back as a draft, while the original keeps every turn. Each turn costs a fraction of a cent, about 2 cents on Muse Wonder.",
    Component: RewindTimeline,
    props: {},
    agentPrompt: {
      task: "Add rewind to this project's chat feature, the way Muse Code's /rewind works: let the user pick an earlier user message, start a new branch that continues from the stored response before it (previous_response_id), put the picked message back in the composer as an editable draft, and keep the original thread unchanged and reachable. Store each turn's response id so any branch can continue from any point.",
      facts: [
        "POST https://api.meta.ai/v1/responses with previous_response_id continues a stored response (stored by default). Rewinding to message k continues from turn k-1's response id, or from nothing for the first message.",
        "Send instructions on every call: they don't carry over through previous_response_id.",
        "Rewind changes conversation history only. Whatever earlier turns did outside the chat stays done, so the UI should say so.",
        "The source branch keeps A, B, C; rewinding to B makes a child whose context is only A, with B as an unsent draft.",
        'Chaining can briefly fail right after a response is created (503, or 400 "referenced response not found"). Retry with backoff before giving up.',
        "Keep max_output_tokens at 400 or more: reasoning uses tokens too.",
      ],
      checklist: [
        "A conversation A, B, C rewound to B gives a branch whose next request carries A's response id as previous_response_id, with B in the composer.",
        "The original thread still shows A, B, C and can continue from C.",
      ],
      snippets: {
        python: `import os

from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])
MODEL = "muse-spark-1.3-contributor"

def send(text, previous_id=None):
    chain = {"previous_response_id": previous_id} if previous_id else {}
    r = client.responses.create(model=MODEL, input=text, instructions="Keep answers short.",
                                max_output_tokens=800, **chain)
    return r.id, r.output_text

thread = []  # (response_id, user_text) for every turn on the original branch
for text in ["Suggest a rate-limiting approach.", "Show the middleware.", "Write a test."]:
    rid, _ = send(text, thread[-1][0] if thread else None)
    thread.append((rid, text))

k = 1  # rewind to B: continue from A's response; B comes back as an editable draft
draft = thread[k][1]
branch_id, reply = send(draft + " Use a Redis store.", thread[k - 1][0])
print(reply)`,
        typescript: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const model = "muse-spark-1.3-contributor";

async function send(input: string, previous?: string) {
  const r = await client.responses.create({ model, input, instructions: "Keep answers short.", max_output_tokens: 800, ...(previous ? { previous_response_id: previous } : {}) });
  return { id: r.id, text: r.output_text };
}

const thread: Array<{ id: string; input: string }> = [];
for (const input of ["Suggest a rate-limiting approach.", "Show the middleware.", "Write a test."]) {
  const { id } = await send(input, thread.at(-1)?.id);
  thread.push({ id, input });
}

// Rewind to B: continue from A's response; B comes back as an editable draft.
const k = 1;
const branch = await send(\`\${thread[k].input} Use a Redis store.\`, thread[k - 1].id);
console.log(branch.text);`,
        curl: `# Turn A: keep its id.
A=$(curl -s https://api.meta.ai/v1/responses \\
  -H "Authorization: Bearer $MODEL_API_KEY" -H "Content-Type: application/json" \\
  -d '{"model":"muse-spark-1.3-contributor","input":"Suggest a rate-limiting approach.","max_output_tokens":800}' | jq -r .id)

# Rewind to B: a new branch continues from A, whatever came after it.
curl -s https://api.meta.ai/v1/responses \\
  -H "Authorization: Bearer $MODEL_API_KEY" -H "Content-Type: application/json" \\
  -d "{\\"model\\":\\"muse-spark-1.3-contributor\\",\\"previous_response_id\\":\\"$A\\",\\"input\\":\\"Show the middleware with a Redis store.\\",\\"max_output_tokens\\":800}"`,
      },
    },
  },

  "muse-code/configuration": {
    title: "Build your settings file, instruction files and launch flags",
    blurb:
      "Build a settings.json from the documented keys (or check yours), see which instruction files load and in what order, lay out memory, build flags for muse or muse exec, and compare two reasoning effort levels live. Under a cent, about 3 cents on Muse Wonder.",
    Component: SettingsBuilder,
    props: {},
    agentPrompt: {
      task: 'Give this repository its Muse Code project context. Run `muse init --dry-run` first; if there\'s no AGENTS.md, run `muse init` and fill it with this repo\'s real commands and conventions. Add .agents/memory/MEMORY.md as an index with one Markdown file per durable fact you find (deploy steps, why a workaround exists, a service\'s quirks). Then show me, without writing it, a ~/.config/muse/settings.json with only what I ask for and "schema_version": 1.',
      facts: [
        '~/.config/muse/settings.json needs "schema_version": 1, or every command fails ("malformed settings file"; other values: "unsupported settings schema version"). A missing file is fine.',
        "Keys: permissions.default_profile, session_retention_days, show_reasoning, tui.terminal_background, agents.execution_capacity (1-64), mcp_servers, hooks, managed_hooks_path.",
        "From the workspace root up to .git, each level uses the first of AGENTS.md, CLAUDE.md, .agents/AGENTS.md, .claude/CLAUDE.md. Project beats user, deeper beats shallower; project rules need a trusted workspace.",
        "`muse init` writes only AGENTS.md and stops if one exists (--force overwrites it).",
        "Memory: MEMORY.md indexes one file per topic (48 listed at most). It loads even in untrusted workspaces: no secrets or instructions in it.",
        "Default model muse-spark-1.2 (--model); Meta rejects --reasoning-effort none.",
      ],
      checklist: [
        "AGENTS.md lists this repo's real install, test and lint commands, and `muse init --dry-run` ran first.",
        ".agents/memory/MEMORY.md links every topic file, and none of them holds a secret.",
      ],
      snippets: {
        curl: `muse init --dry-run      # see what it would write
muse init                # writes AGENTS.md only; stops if one exists
mkdir -p .agents/memory
cat > .agents/memory/MEMORY.md <<'EOF'
# Memory
- [Deploy](deploy.md): how we ship to production and roll back
EOF
# User settings (print, don't write): only what you set, and always the schema version.
cat <<'EOF'
{
  "schema_version": 1,
  "permissions": { "default_profile": ":auto-review" },
  "session_retention_days": 30
}
EOF`,
        python: `import json
import pathlib

memory = pathlib.Path(".agents/memory")
memory.mkdir(parents=True, exist_ok=True)
topics = {"deploy.md": "How we ship to production and roll back"}
(memory / "MEMORY.md").write_text("# Memory\\n" + "".join(f"- [{f[:-3]}]({f}): {t}\\n" for f, t in topics.items()))

# Check a settings file the way Muse Code's startup does.
settings = pathlib.Path.home() / ".config/muse/settings.json"
if settings.exists():
    data = json.loads(settings.read_text())
    if data.get("schema_version") != 1:
        raise SystemExit('settings.json needs "schema_version": 1, or every command fails at startup')`,
        typescript: `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

mkdirSync(".agents/memory", { recursive: true });
const topics: Record<string, string> = { "deploy.md": "How we ship to production and roll back" };
writeFileSync(".agents/memory/MEMORY.md", "# Memory\\n" + Object.entries(topics).map(([f, t]) => \`- [\${f.slice(0, -3)}](\${f}): \${t}\\n\`).join(""));

// Check a settings file the way Muse Code's startup does.
const settings = join(homedir(), ".config/muse/settings.json");
if (existsSync(settings) && JSON.parse(readFileSync(settings, "utf8")).schema_version !== 1) {
  throw new Error('settings.json needs "schema_version": 1, or every command fails at startup');
}`,
      },
    },
  },

  "muse-code/extending": {
    title: "Build subagents, skills, hooks, MCP servers and CI runs",
    blurb:
      "Plan subagents against the tree's capacity, package a skill, review the command a hook would run outside the sandbox, declare an MCP server and test a named toolset's patterns, and build a headless CI run with its exit codes and resume commands.",
    Component: ExtendingBuilder,
    props: {},
    agentPrompt: {
      task: "Package one routine of this repository as a Muse Code project skill and run it headless in CI. Create .agents/skills/<id>/SKILL.md for the routine I name (default: drafting release notes from merged changes), validate it with `muse skills validate`, and add a CI job that runs `muse exec --json --disable-approval --max-model-steps 40` with that skill, keeps the JSONL output as a build artifact, and gates on the repo's own tests.",
      facts: [
        "Project skills: <repo>/.agents/skills/<skill-id>/SKILL.md. Commands: muse skills validate, install, enable, list, inspect, and `muse skills import --from claude|codex`.",
        "muse exec exit codes: 0 the turn completed (not proof the work is right), 1 failed or cancelled (including --max-model-steps), 2 usage error, 130 or 143 on SIGINT or SIGTERM.",
        "Headless runs can't answer prompts: --disable-approval keeps the sandbox; --yolo drops it and trusts the workspace. Linux runners need a working bubblewrap and a non-musl build.",
        'Resume and audit: `muse exec --session-id <uuid> "Continue the task."` and `muse export --session <uuid> --out run.json`.',
        "Hooks (.muse/hooks.json, the settings hooks block, managed_hooks_path) and MCP tools run outside the sandbox. mcp_servers entries take transport stdio (command, args, env) or streamable_http (url, headers).",
      ],
      checklist: [
        "`muse skills validate ./.agents/skills/<id>` passes.",
        "The CI job's test step decides pass or fail, and the --json output is saved as an artifact.",
      ],
      snippets: {
        curl: `mkdir -p .agents/skills/release-notes
cat > .agents/skills/release-notes/SKILL.md <<'EOF'
---
name: release-notes
description: Draft release notes from merged changes. Use when asked for release notes.
---
1. List merged changes since the last tag with git log.
2. Group them as New, Improvements and Fixes, one user-facing line each.
3. Show the draft and stop.
EOF
muse skills validate ./.agents/skills/release-notes

# CI step: JSONL events to a file, then your own tests decide.
muse exec --json --disable-approval --max-model-steps 40 "Use the release-notes skill." > muse-run.jsonl
npm test`,
        python: `import subprocess
import sys

# CI: keep the JSONL events, then let the tests decide (exit 0 only means the turn ended).
with open("muse-run.jsonl", "w") as out:
    run = subprocess.run(
        ["muse", "exec", "--json", "--disable-approval", "--max-model-steps", "40", "Use the release-notes skill."],
        stdout=out,
    )
codes = {1: "failed or cancelled", 2: "usage error", 130: "SIGINT", 143: "SIGTERM"}
if run.returncode != 0:
    sys.exit(f"muse exec: {codes.get(run.returncode, run.returncode)}")
subprocess.run(["npm", "test"], check=True)`,
        typescript: `import { openSync } from "node:fs";
import { spawnSync } from "node:child_process";

// CI: keep the JSONL events, then let the tests decide (exit 0 only means the turn ended).
const out = openSync("muse-run.jsonl", "w");
const run = spawnSync("muse", ["exec", "--json", "--disable-approval", "--max-model-steps", "40", "Use the release-notes skill."], { stdio: ["ignore", out, "inherit"] });
const codes: Record<number, string> = { 1: "failed or cancelled", 2: "usage error", 130: "SIGINT", 143: "SIGTERM" };
if (run.status !== 0) throw new Error(\`muse exec: \${codes[run.status ?? -1] ?? run.status}\`);
process.exit(spawnSync("npm", ["test"], { stdio: "inherit" }).status ?? 1);`,
      },
    },
  },

  "muse-code/changelog": {
    title: "Explore every Muse Code release",
    blurb:
      "Filter every change in every release by version range, type of change and keyword, or show just the security fixes, with each result linked to its place on the page and the set copyable as Markdown.",
    Component: ChangelogExplorer,
    props: {},
    agentPrompt: {
      task: "Write a script for this repository that tells me what changed in Muse Code since the version I run. Read the installed version from `muse --version`, fetch https://dev.meta.ai/docs/muse-code/changelog.md, parse it into releases with their New, Improvements, Fixes and Performance sections, and print every change newer than mine, security fixes first. Exit nonzero when the fetch or the parse fails.",
      facts: [
        "Each release is a `## <version>` heading, newest first, with `### New`, `### Improvements`, `### Fixes` and `### Performance` sections of `- ` bullets.",
        "Some releases (1.0.x, 0.1.x) are one paragraph of patch notes instead of sections, and 0.1.0 is a single bullet.",
        "x in a heading (1.0.x) matches any number. Stop at the first heading at or below the installed version: 1.0.3 stops at 1.0.x, and a version newer than the page has nothing to print.",
        "Security fixes start with `**Security:**`.",
        "The page gives no release dates. Its anchors are v plus the version with dots as hyphens (#v1-4-13).",
      ],
      checklist: [
        "Given 1.4.10 it prints the 1.4.11, 1.4.12 and 1.4.13 changes and nothing older; given 1.0.3 it stops at 1.0.x; given 1.4.14 it says it's up to date.",
        "Security fixes come first, and an unreachable URL exits nonzero.",
      ],
      snippets: {
        python: `import re
import subprocess
import sys

import requests

out = subprocess.run(["muse", "--version"], capture_output=True, text=True, check=True).stdout
found = re.search(r"\\d+\\.\\d+\\.\\d+", out)
if not found:
    sys.exit(f"Can't read a version from {out!r}")
mine = [int(n) for n in found.group(0).split(".")]

def at_or_below(heading):
    """The installed version or older; x matches any number (1.0.x)."""
    for part, own in zip(heading.split("."), mine):
        if part == "x":
            return True
        if int(part) != own:
            return int(part) < own
    return True

md = requests.get("https://dev.meta.ai/docs/muse-code/changelog.md", timeout=30)
md.raise_for_status()

changes, version, kind, releases = [], None, "Notes", 0
for line in md.text.splitlines():
    if line.startswith("## "):
        releases += 1
        heading = line[3:].split()[0]
        if at_or_below(heading):
            break
        version, kind = heading, "Notes"
    elif version and line.startswith("### "):
        kind = line[4:].strip()
    elif version and line.strip():
        changes.append((version, kind, line.removeprefix("- ").strip()))
if not releases:
    sys.exit("No releases found: has the page's format changed?")
if not changes:
    print(f"Up to date: nothing newer than {found.group(0)}.")
for v, k, text in sorted(changes, key=lambda c: not c[2].startswith("**Security")):
    print(f"{v} [{k}] {text}")`,
        typescript: `import { execFileSync } from "node:child_process";

const found = /\\d+\\.\\d+\\.\\d+/.exec(execFileSync("muse", ["--version"], { encoding: "utf8" }))?.[0];
if (!found) throw new Error("No version in muse --version");
const mine = found.split(".").map(Number);
// The installed version or older; x matches any number (1.0.x).
const atOrBelow = (heading: string) => {
  const parts = heading.split(".");
  const i = parts.findIndex((p, j) => p === "x" || Number(p) !== mine[j]);
  return i < 0 || parts[i] === "x" || Number(parts[i]) < mine[i];
};

const res = await fetch("https://dev.meta.ai/docs/muse-code/changelog.md");
if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
const changes: string[][] = [];
let [version, kind, releases] = ["", "Notes", 0];
for (const line of (await res.text()).split("\\n")) {
  if (line.startsWith("## ")) {
    releases++;
    const heading = line.slice(3).split(" ")[0];
    if (atOrBelow(heading)) break;
    [version, kind] = [heading, "Notes"];
  } else if (version && line.startsWith("### ")) kind = line.slice(4).trim();
  else if (version && line.trim()) changes.push([version, kind, line.replace(/^- /, "").trim()]);
}
if (!releases) throw new Error("No releases found: has the page's format changed?");
if (!changes.length) console.log(\`Up to date: nothing newer than \${found}.\`);
const sec = (c: string[]) => (c[2].startsWith("**Security") ? 0 : 1);
for (const [v, k, text] of changes.sort((a, b) => sec(a) - sec(b))) console.log(\`\${v} [\${k}] \${text}\`);`,
        curl: `#!/usr/bin/env bash
# What changed in Muse Code since the installed version, security fixes first.
set -euo pipefail
mine=$(muse --version | grep -Eo -m1 '[0-9]+\\.[0-9]+\\.[0-9]+')
curl -fsSL https://dev.meta.ai/docs/muse-code/changelog.md | awk -v mine="$mine" '
  function at_or_below(v,  a, b, i) {  # x matches any number (1.0.x)
    split(v, a, "."); split(mine, b, ".")
    for (i = 1; i <= 3; i++) {
      if (a[i] == "x") return 1
      if (a[i] + 0 != b[i] + 0) return a[i] + 0 < b[i] + 0
    }
    return 1
  }
  # Reads to the end instead of exiting early, which would cut curl off (exit 23) under pipefail.
  /^## / { seen = 1; if (at_or_below($2)) stop = 1; v = $2; kind = "Notes"; next }
  stop || !v { next }
  /^### / { kind = $2; next }
  NF { sub(/^- /, ""); item = v " [" kind "] " $0 "\\n"; if (/^\\*\\*Security/) sec = sec item; else rest = rest item }
  END {
    if (!seen) { print "No releases found" > "/dev/stderr"; exit 1 }
    if (sec rest == "") print "Up to date: nothing newer than " mine
    printf "%s%s", sec, rest
  }'`,
      },
    },
  },

  "coding-agents": {
    title: "Generate your coding agent's config and check it answers",
    blurb:
      "Build the OpenCode, Codex, Claude Code or generic OpenAI-compatible config from the page's own settings, then send the request it would make through the docs proxy to confirm it answers. A check costs a fraction of a cent, up to about 2 cents with Muse Wonder.",
    Component: AgentConfigGenerator,
    props: {},
    agentPrompt: {
      task: "Connect the coding agent I use with this repository (Claude Code, Codex, OpenCode or another OpenAI-compatible tool; ask me if you can't tell) to Meta Model API. Write its provider config from this page with the model I pick, keep the key in MODEL_API_KEY or the agent's credential store and out of every committed file, and add scripts/check-model-api.sh that makes one tiny request in the same shape the agent uses and prints whether it answered.",
      facts: [
        "OpenAI-compatible base: https://api.meta.ai/v1, no trailing slash. Claude Code speaks Messages at https://api.meta.ai with no /v1 (it appends /v1/messages).",
        'Claude Code env: ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN="$MODEL_API_KEY" (Bearer; never ANTHROPIC_API_KEY), ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL, CLAUDE_CODE_SUBAGENT_MODEL, ENABLE_TOOL_SEARCH=true.',
        'Codex config.toml: model_provider = "meta" with base_url, env_key = "MODEL_API_KEY", wire_api = "responses"; model_context_window = 1048576. Run /logout first if signed in to OpenAI.',
        'OpenCode: npm "@ai-sdk/openai" (Responses) with include ["reasoning.encrypted_content"] and input modalities; "@ai-sdk/openai-compatible" loses reasoning between turns.',
        "Models: muse-wonder-1.0 for the main loop, muse-spark-1.3-contributor for cheaper work. max effort isn't on muse-spark-1.3-contributor; none isn't accepted.",
      ],
      checklist: [
        "scripts/check-model-api.sh prints the model's answer to a one-line prompt, on the same endpoint the agent's config uses.",
        "`git grep -n MODEL_API_KEY` shows only variable references, never a key.",
      ],
      snippets: {
        curl: `#!/usr/bin/env bash
# scripts/check-model-api.sh: one tiny request in the agent's own shape.
set -euo pipefail
# Codex and OpenCode (Responses):
curl -sf https://api.meta.ai/v1/responses \\
  -H "Authorization: Bearer $MODEL_API_KEY" -H "Content-Type: application/json" \\
  -d '{"model":"muse-spark-1.3-contributor","input":"Reply with exactly: config OK","max_output_tokens":800}' | jq -r '.output[] | select(.type=="message") | .content[0].text'
# Claude Code (Messages):
curl -sf https://api.meta.ai/v1/messages \\
  -H "Authorization: Bearer $MODEL_API_KEY" -H "Content-Type: application/json" \\
  -d '{"model":"muse-spark-1.3-contributor","max_tokens":800,"messages":[{"role":"user","content":"Reply with exactly: config OK"}]}' | jq -r '.content[] | select(.type=="text") | .text'`,
        python: `import os

from openai import OpenAI

# The same base URL and key variable the agent's config uses.
client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])
r = client.responses.create(
    model="muse-spark-1.3-contributor",
    input="Reply with exactly: config OK",
    max_output_tokens=800,
)
print(r.model, r.output_text)`,
        typescript: `import OpenAI from "openai";

// The same base URL and key variable the agent's config uses.
const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const r = await client.responses.create({
  model: "muse-spark-1.3-contributor",
  input: "Reply with exactly: config OK",
  max_output_tokens: 800,
});
console.log(r.model, r.output_text);`,
      },
    },
  },

  "agent-frameworks": {
    title: "Set up an agent framework and run a mini agent loop",
    blurb:
      "Generate the Claude Agent SDK or Codex app-server setup from the page's code with your options, then run a small agent loop live on the Messages or Responses API that reads, edits and tests a simulated repo. About a tenth of a cent a run on the default model, up to about 15 cents on Muse Wonder.",
    Component: FrameworkSetup,
    props: {},
    agentPrompt: {
      task: "Build a small agent in this project on Meta Model API with the Claude Agent SDK: one script that runs a task in a workspace directory with only Read, Edit and Bash, the provider env passed inline, and the page's production patterns: done only on the result message, a wall-clock cap plus an idle watchdog, usage logged from the final event, and retries with backoff for transient errors. Use the Codex app-server instead only if I ask.",
      facts: [
        "SDK env: ANTHROPIC_BASE_URL=https://api.meta.ai (no /v1), ANTHROPIC_AUTH_TOKEN from MODEL_API_KEY (not ANTHROPIC_API_KEY), and ANTHROPIC_MODEL, the opus, sonnet and haiku tiers and CLAUDE_CODE_SUBAGENT_MODEL all on Model API models.",
        'Options from the page: allowedTools, permissionMode "bypassPermissions" (only inside a sandbox), settingSources: [] (hermetic), systemPrompt, env with ...process.env first.',
        "Codex: `codex app-server` with -c overrides (base_url https://api.meta.ai/v1, env_key MODEL_API_KEY, wire_api responses, requires_openai_auth=false) and -c model_catalog_json=<file path>.",
        'Codex JSON-RPC: initialize, initialized, thread/start (approvalPolicy "never", sandbox "workspace-write"), turn/start; done on turn/completed for your turn id.',
        "Models: muse-wonder-1.0 for the main loop, muse-spark-1.3-contributor for subagents and lower cost.",
      ],
      checklist: [
        "Running the script on a scratch directory prints the result text and usage, and exits nonzero when no result message arrives.",
        "With the idle watchdog set very low it fails fast with a timeout message.",
      ],
      snippets: {
        typescript: `import { query } from "@anthropic-ai/claude-agent-sdk";

const spark = "muse-spark-1.3-contributor";
const run = query({
  prompt: "Add input validation to the signup handler and run the tests.",
  options: {
    model: "muse-wonder-1.0",
    cwd: "/path/to/workspace",
    allowedTools: ["Read", "Edit", "Bash"],
    permissionMode: "bypassPermissions", // only inside a sandbox
    settingSources: [],
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: "https://api.meta.ai",
      ANTHROPIC_AUTH_TOKEN: process.env.MODEL_API_KEY ?? "",
      ANTHROPIC_MODEL: "muse-wonder-1.0",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "muse-wonder-1.0",
      ANTHROPIC_DEFAULT_SONNET_MODEL: spark,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: spark,
      CLAUDE_CODE_SUBAGENT_MODEL: spark,
    },
  },
});

let result: string | undefined;
for await (const message of run) {
  if (message.type === "result") {
    result = "result" in message ? message.result : undefined;
    console.log(message.usage);
  }
}
if (!result) throw new Error("No result message: treat the run as failed.");
console.log(result);`,
        python: `import os

import anyio
from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage

spark = "muse-spark-1.3-contributor"
OPTIONS = ClaudeAgentOptions(
    model="muse-wonder-1.0", cwd="/path/to/workspace", allowed_tools=["Read", "Edit", "Bash"],
    permission_mode="bypassPermissions",  # only inside a sandbox
    setting_sources=[],
    env={**os.environ, "ANTHROPIC_BASE_URL": "https://api.meta.ai", "ANTHROPIC_AUTH_TOKEN": os.environ["MODEL_API_KEY"],
         "ANTHROPIC_MODEL": "muse-wonder-1.0", "ANTHROPIC_DEFAULT_OPUS_MODEL": "muse-wonder-1.0",
         "ANTHROPIC_DEFAULT_SONNET_MODEL": spark, "ANTHROPIC_DEFAULT_HAIKU_MODEL": spark, "CLAUDE_CODE_SUBAGENT_MODEL": spark},
)

async def main():
    result = None
    with anyio.fail_after(20 * 60):  # wall-clock cap
        async for message in query(prompt="Add input validation and run the tests.", options=OPTIONS):
            if isinstance(message, ResultMessage):
                result = message.result
                print(message.usage)
    if not result:
        raise RuntimeError("No result message: treat the run as failed.")
    print(result)

anyio.run(main)`,
        curl: `# What the SDK sends under the hood: a Messages call with tools. The agent loop
# runs each tool_use locally and answers with tool_result blocks in the next call.
curl -s https://api.meta.ai/v1/messages \\
  -H "Authorization: Bearer $MODEL_API_KEY" -H "Content-Type: application/json" \\
  -d '{
  "model": "muse-spark-1.3-contributor",
  "max_tokens": 1500,
  "system": "You are a coding agent. Make minimal, well-tested changes.",
  "tools": [{"name": "Read", "description": "Read a file",
    "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}}, "required": ["file_path"]}}],
  "messages": [{"role": "user", "content": "Summarize this repo."}]
}'`,
      },
    },
  },
};
