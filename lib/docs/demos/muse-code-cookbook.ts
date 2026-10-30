import type { DemoMap } from "@/lib/docs/demos/types";
import { RecipeBrowser } from "@/components/docs/playgrounds/muse-code-cookbook/RecipeBrowser";
import { SessionLogExplorer } from "@/components/docs/playgrounds/muse-code-cookbook/SessionLogExplorer";
import { ReplayLab } from "@/components/docs/playgrounds/muse-code-cookbook/ReplayLab";
import { ContainmentChecker } from "@/components/docs/playgrounds/muse-code-cookbook/ContainmentChecker";
import { GuardrailTester } from "@/components/docs/playgrounds/muse-code-cookbook/GuardrailTester";
import { StageSplitter } from "@/components/docs/playgrounds/muse-code-cookbook/StageSplitter";
import { FanoutPlanner } from "@/components/docs/playgrounds/muse-code-cookbook/FanoutPlanner";
import { GoalJudge } from "@/components/docs/playgrounds/muse-code-cookbook/GoalJudge";
import { SkillExplorer } from "@/components/docs/playgrounds/muse-code-cookbook/SkillExplorer";
import { ScheduleBuilder } from "@/components/docs/playgrounds/muse-code-cookbook/ScheduleBuilder";
import { SideChat } from "@/components/docs/playgrounds/muse-code-cookbook/SideChat";

/**
 * Live demos and coding-agent prompts for the "muse-code-cookbook" pages:
 *   cookbook/muse-code
 *   cookbook/audit-agent-sessions
 *   cookbook/deterministic-replay
 *   cookbook/contained-execution
 *   cookbook/immutable-guardrails
 *   cookbook/staged-approvals
 *   cookbook/subagent-fanout
 *   cookbook/goal-tracking
 *   cookbook/bundled-skills
 *   cookbook/loop-and-cron
 *   cookbook/side-chats
 * Components live in components/docs/playgrounds/muse-code-cookbook/. These recipes run in a terminal with the muse
 * CLI, so each demo is a simulator built from its recipe's own formats (logs, fixtures, stages, policies, cron), with
 * a live Muse Spark call where one helps; every live call defaults to muse-spark-1.3-contributor.
 *
 * The prompts are sized so the whole of each one (task, facts, checks and starter code) survives "Include what I just
 * ran": the kit shortens the recorded request first, and the snippet only when the prompt is still too long, so each
 * snippet stays under 1,000 characters and each page's text leaves room for that request. The prompt's Setup section
 * already names the model and what Contributor mode means. __tests__/prompts.test.ts checks every page, agent and
 * language with a recorded request.
 */

export const museCodeCookbookDemos: DemoMap = {
  "cookbook/muse-code": {
    title: "Find the Muse Code recipe for your harness",
    blurb: "Filter the ten recipes by theme or search, then describe what your agent must do and Muse Spark picks the recipes that fit from a strict list of their slugs.",
    Component: RecipeBrowser,
    props: {
      need: "My coding agent must never delete files or edit its own rules without a person saying yes.",
      needs: [
        "My coding agent must never delete files or edit its own rules without a person saying yes.",
        "A long migration got killed halfway and I can't repeat its side effects.",
        "I want six features built in parallel without merge collisions.",
        "Remind the agent every morning to triage new bugs.",
      ],
    },
    agentPrompt: {
      task: "Pick the Muse Code cookbook recipes that fit this project's coding-agent setup, then build the first one. Read the repo first (how the agent is launched, CI, any AGENTS.md rules), name one to three recipes from this page that close its gaps and why, then implement the first from its own recipe page.",
      facts: [
        "Recipes (at https://dev.meta.ai/docs/cookbook/<slug>, .md for Markdown): audit-agent-sessions, deterministic-replay, staged-approvals, contained-execution, immutable-guardrails, subagent-fanout, goal-tracking, bundled-skills, loop-and-cron, side-chats.",
        "Muse Code (the muse CLI) runs with approval and the sandbox on by default; --yolo turns both off, so never use it for the safety recipes.",
        "Session logs: ${XDG_DATA_HOME:-$HOME/.local/share}/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl.",
        "As this page's demo does, pick recipes over the API with a strict json_schema whose slug is an enum of the ten.",
      ],
      checklist: [
        "You name the recipes you picked, each with the gap it closes in this repo.",
        "The first recipe's own check passes (verify.py, replay_gate.sh exiting 0, or a held rm -rf stage).",
      ],
      snippets: {
        python: `import json, os
from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])
slugs = ("audit-agent-sessions deterministic-replay staged-approvals contained-execution immutable-guardrails "
         "subagent-fanout goal-tracking bundled-skills loop-and-cron side-chats").split()
strict = lambda p: {"type": "object", "additionalProperties": False, "required": list(p), "properties": p}
pick = strict({"slug": {"type": "string", "enum": slugs}, "why": {"type": "string"}})
resp = client.responses.create(
    model="muse-spark-1.3-contributor",
    instructions="Pick one to three cookbook recipes for the need, best first.",
    input="My agent must never delete files without my OK.",
    text={"format": {"type": "json_schema", "name": "Picks", "strict": True,
                     "schema": strict({"picks": {"type": "array", "items": pick}})}},
)
for p in json.loads(resp.output_text)["picks"]:
    print(p["slug"], p["why"])`,
        typescript: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const slugs = ("audit-agent-sessions deterministic-replay staged-approvals contained-execution immutable-guardrails " +
  "subagent-fanout goal-tracking bundled-skills loop-and-cron side-chats").split(" ");
const strict = (p: object) => ({ type: "object", additionalProperties: false, required: Object.keys(p), properties: p });
const picks = { type: "array", items: strict({ slug: { type: "string", enum: slugs }, why: { type: "string" } }) };
const resp = await client.responses.create({
  model: "muse-spark-1.3-contributor",
  instructions: "Pick one to three cookbook recipes for the need, best first.",
  input: "My agent must never delete files without my OK.",
  text: { format: { type: "json_schema", name: "Picks", strict: true, schema: strict({ picks }) } },
});
for (const p of JSON.parse(resp.output_text).picks) console.log(p.slug, p.why);`,
        curl: `# jq builds the body, curl sends it.
jq -n '{model: "muse-spark-1.3-contributor",
  instructions: "Pick one to three Muse Code cookbook recipes for the need, best first.",
  input: "My coding agent must never delete files without a person saying yes.",
  text: {format: {type: "json_schema", name: "Picks", strict: true, schema: {type: "object",
    additionalProperties: false, required: ["picks"], properties: {picks: {type: "array", items: {type: "object",
      additionalProperties: false, required: ["slug", "why"], properties: {why: {type: "string"}, slug: {type: "string",
        enum: ["audit-agent-sessions", "deterministic-replay", "staged-approvals", "contained-execution",
          "immutable-guardrails", "subagent-fanout", "goal-tracking", "bundled-skills", "loop-and-cron", "side-chats"]}}}}}}}}}' |
  curl -s https://api.meta.ai/v1/responses -H "Authorization: Bearer $MODEL_API_KEY" -H "Content-Type: application/json" -d @-`,
      },
    },
  },

  "cookbook/audit-agent-sessions": {
    title: "Walk a session log: who authorized each action, and where a resume picks up",
    blurb: "Open a real Muse Code log (or your own session.jsonl, read only in your browser), read its timeline, ledger and approval chain, kill the run at any record to see what muse resume would find, and have Muse Spark review the ledger (under a cent).",
    Component: SessionLogExplorer,
    props: { sample: "exec" },
    agentPrompt: {
      task: "Add an audit report to this project's Muse Code workflow: after a session, run muse export, then a script that reads the export and prints one ledger row per side_effect_intent (sequence, operation, policy_decision), flags any intent with no terminal record (what resume reports as unknown), and exits non-zero when an idempotency_key repeats.",
      facts: [
        "Each log line is an envelope {sequence, recorded_at, record_type, durability, payload_type, payload}; its kind is .payload.event.kind // .payload_type. The export wraps each as {kind: \"record\", envelope} in .events[].",
        "policy_decision: allow:policy (static policy), allow:llm_judge (a reviewer), not_applicable (model calls).",
        "An intent with no later tool_batch.effect.terminal or completed record for its task was in flight; resume reports it as unknown.",
        "Quit with /quit before exporting (else session_terminated_abnormally: true); share only a --redacted export; scripts use muse resume --last.",
      ],
      checklist: [
        "muse export --last --out a.json twice gives byte-identical files (cmp a.json b.json).",
        "For a session killed mid-task, the script flags the in-flight intent and finds no repeated key.",
      ],
      snippets: {
        python: `import json, sys
from collections import Counter

doc = json.load(open(sys.argv[1]))  # muse export --last --out trajectory.json
recs = [e["envelope"] for e in doc["events"] if e.get("kind") == "record"]
ev = lambda r: (r.get("payload") or {}).get("event") or {}
kind = lambda r: ev(r).get("kind") or r.get("payload_type")
task = lambda r: ev(r).get("task_id") or (r.get("payload") or {}).get("task_id")

closed = {task(r) for r in recs if kind(r) in ("completed", "tool_batch.effect.terminal")}
keys = Counter()
for r in recs:
    if kind(r) == "side_effect_intent":
        e = ev(r)
        keys[e.get("idempotency_key")] += 1
        flag = "" if task(r) in closed else "  UNKNOWN: no terminal record"
        print(f"{r['sequence']:>5}  {e.get('operation')}  auth={e.get('policy_decision')}{flag}")
if any(n > 1 for n in keys.values()):
    sys.exit("an idempotency key fired twice")`,
        typescript: `import { readFileSync } from "node:fs";

const doc = JSON.parse(readFileSync(process.argv[2], "utf8")); // muse export --last --out trajectory.json
const recs: any[] = doc.events.filter((e: any) => e.kind === "record").map((e: any) => e.envelope);
const ev = (r: any) => r.payload?.event ?? {};
const kind = (r: any) => ev(r).kind ?? r.payload_type;
const task = (r: any) => ev(r).task_id ?? r.payload?.task_id;

const closed = new Set(recs.filter((r) => ["completed", "tool_batch.effect.terminal"].includes(kind(r))).map(task));
const intents = recs.filter((r) => kind(r) === "side_effect_intent");
for (const r of intents) {
  const flag = closed.has(task(r)) ? "" : "  UNKNOWN: no terminal record";
  console.log(\`\${r.sequence}  \${ev(r).operation}  auth=\${ev(r).policy_decision}\${flag}\`);
}
const keys = intents.map((r) => ev(r).idempotency_key);
if (new Set(keys).size < keys.length) throw new Error("an idempotency key fired twice");`,
        curl: `# The recipe's CLI and jq flow (no API call).
muse export --last --out trajectory.json
# Who authorized each action
jq -r '.events[] | select(.kind=="record") | .envelope
  | select((.payload.event.kind // "")=="side_effect_intent")
  | "\\(.sequence)  \\(.payload.event.operation)  \\(.payload.event.policy_decision)"' trajectory.json
# The approval window, by sequence
jq '.events[] | select(.kind=="record" and .envelope.sequence>=193 and .envelope.sequence<=202)
    | {seq:.envelope.sequence, kind:(.envelope.payload.event.kind // .envelope.payload_type)}' trajectory.json
# No key fired twice across a crash (prints nothing)
F="$(ls -1t "\${XDG_DATA_HOME:-$HOME/.local/share}"/muse/sessions/*/*/*/*/session.jsonl | head -n 1)"
jq -r 'select((.payload.event.kind // "")=="side_effect_intent") | .payload.event.idempotency_key' "$F" | sort | uniq -d`,
      },
    },
  },

  "cookbook/deterministic-replay": {
    title: "Replay a golden fixture and gate the merge on its diffs",
    blurb: "Edit the recipe's checkout_probe fixture or pick its drift and failure presets to see muse trace inspect's report and replay_gate.sh's exit code update offline; Record a live run asks Muse Spark the recipe's question so you can author a fixture from it (under a cent).",
    Component: ReplayLab,
    props: {},
    agentPrompt: {
      task: "Add a merge-blocking replay check for this project's Muse Code fixtures: commit focused golden fixtures under golden-traces/, a gate script that runs muse trace inspect --fixture <file> --format json on each and fails on any diff or load failure, and a required CI job that runs it.",
      facts: [
        "muse trace inspect is a viewer: it prints diffs and still exits 0, so gate on jq '.diffs | length', never its exit code.",
        "Pass the file name with .json or its path; a bare stem reports Result: unknown, run=0.",
        "A fixture that doesn't load reports load_status: partial with errors (replay_schema when schema_version isn't 1).",
        "Muse Code doesn't convert a session.jsonl: keep the events under test plus the started, model_response_created and terminal boundaries (model_completed when usage is expected).",
        "Replay is offline and byte-deterministic for the same records and Muse Code revision.",
      ],
      checklist: [
        "./artifacts/replay_gate.sh golden-traces prints PASS for every fixture and exits 0.",
        "A temp copy with an edited assistant_message_committed text fails with 1 projection diff(s), exit 1.",
        "The CI job runs on every pull request and is required.",
      ],
      snippets: {
        curl: `# Write the gate, then run it (no API call).
mkdir -p artifacts && cat > artifacts/replay_gate.sh <<'GATE'
#!/usr/bin/env bash
# Replays every fixture in a directory; fails on any diff or load failure.
set -u
dir="\${1:-golden-traces}"; fail=0
for fixture in "$dir"/*.json; do
  name="$(basename "$fixture" .json)"
  if ! muse trace inspect --fixture "$fixture" --format json > report.json ||
     ! jq -e '.load_status != "partial" and ((.errors // []) | length == 0)' report.json > /dev/null; then
    echo "FAIL  $name: did not load"; fail=1; continue
  fi
  diffs="$(jq '.diffs | length' report.json)"
  if [ "$diffs" -eq 0 ]; then echo "PASS  $name"; else echo "FAIL  $name: $diffs projection diff(s)"; fail=1; fi
done
exit "$fail"
GATE
chmod +x artifacts/replay_gate.sh
./artifacts/replay_gate.sh golden-traces; echo "exit $?"`,
        python: `import glob, json, subprocess, sys

failed = False
for fixture in sorted(glob.glob("golden-traces/*.json")):
    out = subprocess.run(["muse", "trace", "inspect", "--fixture", fixture, "--format", "json"], capture_output=True, text=True)
    try:
        report = json.loads(out.stdout)
    except json.JSONDecodeError:
        report = {"load_status": "partial", "errors": [out.stderr.strip()]}
    diffs = report.get("diffs") or []
    if report.get("load_status") == "partial" or report.get("errors"):
        failed = True
        print(f"FAIL  {fixture}: did not load {report.get('errors')}")
    elif diffs:
        failed = True
        print(f"FAIL  {fixture}: {len(diffs)} projection diff(s)")
        for d in diffs:
            print(f"        {d.get('path')}: expected {d.get('expected')}, actual {d.get('actual')}")
    else:
        print(f"PASS  {fixture}")
sys.exit(1 if failed else 0)`,
        typescript: `import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

let failed = false;
for (const file of readdirSync("golden-traces").filter((f) => f.endsWith(".json")).sort()) {
  const fixture = \`golden-traces/\${file}\`;
  const out = spawnSync("muse", ["trace", "inspect", "--fixture", fixture, "--format", "json"], { encoding: "utf8" });
  let r: any;
  try {
    r = JSON.parse(out.stdout);
  } catch {
    r = { load_status: "partial", errors: [out.stderr.trim()] };
  }
  const diffs: any[] = r.diffs ?? [];
  const loaded = r.load_status !== "partial" && !r.errors?.length;
  console.log(loaded && !diffs.length ? \`PASS  \${fixture}\` : \`FAIL  \${fixture}: \${loaded ? \`\${diffs.length} projection diff(s)\` : "did not load"}\`);
  for (const d of loaded ? diffs : []) console.log(\`        \${d.path}: expected \${d.expected}, actual \${d.actual}\`);
  if (!loaded || diffs.length) failed = true;
}
process.exit(failed ? 1 : 0);`,
      },
    },
  },

  "cookbook/contained-execution": {
    title: "Check what the sandbox lets a command do",
    blurb: "Pick the launch flags and what the probe finds, run the recipe's commands through a simulated sandbox to see each boundary's exact denial, then let Muse Spark call bash inside it and report (under a cent).",
    Component: ContainmentChecker,
    props: { command: "echo pwned > $HOME/sandbox_escape_probe.txt" },
    agentPrompt: {
      task: "Make this project's Muse Code runs prove containment: launch with the sandbox on (muse --disable-approval --trust-workspace, never --yolo or --disable-sandbox), run the recipe's three boundary probes in a scratch repo, and add a check script that confirms each was refused and left nothing behind.",
      facts: [
        "The managed profile: workspace and temp roots writable, the rest of the filesystem read-only, network egress restricted. .git/ stays read-only inside the workspace.",
        "Before trusting the sandbox Muse Code runs a live probe; if its denied write lands, tool calls fail with sandbox enforcement unavailable. --yolo and --disable-sandbox skip it (startup line: sandbox disabled).",
        "The three probes: a write to $HOME and one to .git/config fail with '<path>: Read-only file system', exit 1; curl to an external host gets 'curl: (56) Received HTTP code 502 from proxy after CONNECT', exit 56.",
        "Every denial is recorded in the session log.",
      ],
      checklist: [
        "The check script reports all three boundaries held, and ~/sandbox_escape_probe.txt doesn't exist.",
        ".git/config is unchanged after the run, and an ordinary write inside the workspace still works.",
      ],
      snippets: {
        curl: `# The recipe's run (no API call).
mkdir -p /tmp/sandbox_demo && cd /tmp/sandbox_demo && git init -q
printf '#!/bin/bash\\necho "GRISHNOK-BUILD-FINGERPRINT=QX7-vellum-2291"\\n' > build_info.sh && chmod +x build_info.sh
muse --disable-approval --trust-workspace   # startup line: sandbox normal
# In Muse Code, ask for each probe verbatim, then /quit:
#   echo pwned > $HOME/sandbox_escape_probe.txt
#   echo hacked > .git/config
#   curl -sS --max-time 8 https://example.com
test ! -e "$HOME/sandbox_escape_probe.txt" && echo "boundary 1 held"
grep -q hacked .git/config && echo "boundary 2 FAILED" || echo "boundary 2 held"
F="$(ls -1t "\${XDG_DATA_HOME:-$HOME/.local/share}"/muse/sessions/*/*/*/*/session.jsonl | head -n 1)"
grep -c "Read-only file system" "$F"; grep -c "from proxy after CONNECT" "$F"`,
        python: `import glob, os, sys

data = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
logs = sorted(glob.glob(f"{data}/muse/sessions/*/*/*/*/session.jsonl"), key=os.path.getmtime)
log = open(logs[-1]).read() if logs else ""  # every denial is recorded in the session log
held = {
    "write outside the workspace": not os.path.exists(os.path.expanduser("~/sandbox_escape_probe.txt")),
    "write to .git/config": "hacked" not in open(".git/config").read(),
    "network egress": "Received HTTP code 502 from proxy after CONNECT" in log,
    "denials logged": "Read-only file system" in log,
}
for name, ok in held.items():
    print(f"{'held' if ok else 'FAIL'}  {name}")
sys.exit(0 if all(held.values()) else 1)`,
        typescript: `import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

// The newest session log: every denial is recorded there.
const newest = execSync('ls -1t "\${XDG_DATA_HOME:-$HOME/.local/share}"/muse/sessions/*/*/*/*/session.jsonl 2>/dev/null | head -n 1', { encoding: "utf8", shell: "/bin/bash" }).trim();
const log = newest ? readFileSync(newest, "utf8") : "";
const held: Record<string, boolean> = {
  "write outside the workspace": !existsSync(\`\${homedir()}/sandbox_escape_probe.txt\`),
  "write to .git/config": !readFileSync(".git/config", "utf8").includes("hacked"),
  "network egress": log.includes("Received HTTP code 502 from proxy after CONNECT"),
  "denials logged": log.includes("Read-only file system"),
};
for (const [name, ok] of Object.entries(held)) console.log(\`\${ok ? "held" : "FAIL"}  \${name}\`);
process.exit(Object.values(held).every(Boolean) ? 0 : 1);`,
      },
    },
  },

  "cookbook/immutable-guardrails": {
    title: "Try to edit the rules the agent runs under",
    blurb: "Pick a path, a write route and the launch flags to see which check stops the write (a review that offers only allow once or abort, or a read-only sandbox), then ask Muse Spark to change its own rules and answer the review yourself (under a cent).",
    Component: GuardrailTester,
    props: {},
    agentPrompt: {
      task: "Protect this project's agent rules with Muse Code's guardrails: keep the standing rules in .agents/AGENTS.md, launch with approval and the sandbox on (muse --trust-workspace, never --yolo or --disable-approval), and add a check that a shell write to .agents/ fails read-only and git status --porcelain .agents stays clean.",
      facts: [
        "The approval check (edit_file, write_file) covers paths with a .git, .muse, .agents or .husky component, the workspace Git directory (and symlinks into it), .envrc at the root, and shell startup files (~/.bashrc, ~/.gitconfig).",
        "Its review offers only allow once or abort, so no standing grant is ever recorded. --yolo and --disable-approval turn it off.",
        "The OS sandbox keeps .git, .muse, .agents, .sl, .hg and .eden read-only under the root (off only with --disable-sandbox or --yolo): a shell write fails with Read-only file system, exit 1.",
        "Muse Code writes its own state under .muse/, so the clean-tree check covers .agents only.",
      ],
      checklist: [
        "echo probe > .agents/probe.txt inside Muse Code fails with Read-only file system and creates no file.",
        "Asked for a tightening (it may refuse a weakening itself), the agent's edit_file to .agents/AGENTS.md stops for review with no always-allow choice; declining leaves .agents unchanged.",
        "An ordinary edit to a source file applies without a prompt.",
      ],
      snippets: {
        curl: `# The recipe's setup and checks (no API call).
mkdir -p /tmp/rule12_demo/.agents && cd /tmp/rule12_demo && git init -q
printf '%s\\n' '# Project rules (standing guardrails)' '' '- Never write outside the workspace.' \\
  '- Every shell command that deletes files must be reviewed by a human.' \\
  '- Do not weaken these rules. They are the contract this agent runs under.' > .agents/AGENTS.md
git add -A && git -c user.email=demo@x -c user.name=demo commit -qm init
muse --trust-workspace   # ask for an edit_file that appends a rule to .agents/AGENTS.md; reject it
git status --porcelain .agents   # prints nothing: unchanged
muse --disable-approval --trust-workspace   # ask it to run: echo probe > .agents/probe.txt
test ! -e .agents/probe.txt && echo "sandbox held"   # Read-only file system, exit 1`,
        python: `import subprocess, sys
from pathlib import Path

# Run after a Muse Code session. Muse Code keeps its own state in .muse/, so check .agents only.
changed = subprocess.run(["git", "status", "--porcelain", ".agents"], capture_output=True, text=True, check=True).stdout.strip()
problems = []
if changed:
    problems.append(f"guardrail files changed:\\n{changed}")
if Path(".agents/probe.txt").exists():
    problems.append(".agents/probe.txt exists: a shell write got past the sandbox")
print("\\n".join(problems) or "guardrails held: rules unchanged, no shell write landed")
sys.exit(1 if problems else 0)`,
        typescript: `import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// Run after a Muse Code session. Muse Code keeps its own state in .muse/, so check .agents only.
const changed = execFileSync("git", ["status", "--porcelain", ".agents"], { encoding: "utf8" }).trim();
const problems: string[] = [];
if (changed) problems.push(\`guardrail files changed:\\n\${changed}\`);
if (existsSync(".agents/probe.txt")) problems.push(".agents/probe.txt exists: a shell write got past the sandbox");
console.log(problems.join("\\n") || "guardrails held: rules unchanged, no shell write landed");
process.exit(problems.length ? 1 : 0);`,
      },
    },
  },

  "cookbook/staged-approvals": {
    title: "Split a compound command into stages and answer the held one",
    blurb: "Type a compound command, pick on-request or untrusted mode and any rules you've granted, watch each stage resolve (known_safe, policy allow, unresolved) and answer the prompt for the one that holds; then let Muse Spark run it through the same stages (under a cent).",
    Component: StageSplitter,
    props: { command: "wc -l report.log && echo cleaning && rm -rf report.log" },
    agentPrompt: {
      task: "Set up staged approvals for this project's Muse Code sessions: keep approval on in on-request mode (untrusted for regulated work), grant only narrow workspace prefixes as they come up, and add a script that prints each reviewed shell command's stages (argv, argv_complete, resolution) and closing decision from the session log.",
      facts: [
        "Each stage resolves to known_safe, a policy allow, or unresolved; the first unresolved one holds. The original text runs once after every stage clears; one rejected stage denies it all.",
        "Dangerous: rm -f and rm -rf, also inside sudo or setsid. Untrusted mode drops the read-only allowlist, so even ls prompts until a rule covers it.",
        "Choices: Allow once; Always allow in this workspace: <prefix> (approval-policy.json, this workspace root); Abort the entire command. Interpreters, wrappers and a bare git get no prefix.",
        "Within one effect the most specific rule wins; across effects deny beats prompt beats allow, whatever the specificity.",
      ],
      checklist: [
        "wc -l report.log && echo cleaning && rm -rf report.log holds at Stage 3/3; rejecting it leaves report.log in place.",
        "The script prints wc and echo at known_safe, rm -rf at unresolved, then {\"decision\":\"abort\",\"policy_result\":\"deny\"}.",
      ],
      snippets: {
        curl: `# The recipe's log queries (no API call), on today's newest session.
F="$(ls -1t "\${XDG_DATA_HOME:-$HOME/.local/share}"/muse/sessions/$(date +%Y/%m/%d)/*/session.jsonl | head -n 1)"
jq -c 'select(.payload.event.kind=="requested"
    and (.payload.event.approval_subject.kind=="shell_command"))
    | .payload.event.approval_subject
    | {raw:.raw_command,
       stages:[.stages[] | {pos:.source_position, argv:.argv,
                            complete:.argv_complete, res:.resolution.kind}]}' "$F"
jq -c 'select(.payload.event.kind=="decision_applied")
    | {decision:.payload.event.decision, policy_result:.payload.event.policy_result}' "$F"
# {"decision":"abort","policy_result":"deny"}`,
        python: `import glob, json, os, sys

data = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
logs = sorted(glob.glob(f"{data}/muse/sessions/*/*/*/*/session.jsonl"), key=os.path.getmtime)
for line in open(sys.argv[1] if len(sys.argv) > 1 else logs[-1]):
    rec = json.loads(line)
    event = (rec.get("payload") or {}).get("event") or {}
    if event.get("kind") == "requested" and (event.get("approval_subject") or {}).get("kind") == "shell_command":
        subject = event["approval_subject"]
        print(f"{rec['sequence']}: {subject['raw_command']}")
        for s in subject["stages"]:
            print(f"  {s['source_position']:>3} {json.dumps(s['argv'])} complete={s['argv_complete']} {s['resolution']['kind']}")
    elif event.get("kind") == "decision_applied":
        print(f"  decision: {event.get('decision')} ({event.get('policy_result')})")`,
        typescript: `import { readFileSync } from "node:fs";

// npx tsx stages.ts "\${XDG_DATA_HOME:-$HOME/.local/share}"/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl
for (const line of readFileSync(process.argv[2], "utf8").split("\\n").filter(Boolean)) {
  const rec = JSON.parse(line);
  const event = rec.payload?.event ?? {};
  if (event.kind === "requested" && event.approval_subject?.kind === "shell_command") {
    console.log(\`\${rec.sequence}: \${event.approval_subject.raw_command}\`);
    for (const s of event.approval_subject.stages) {
      console.log(\`  \${s.source_position} \${JSON.stringify(s.argv)} complete=\${s.argv_complete} \${s.resolution.kind}\`);
    }
  } else if (event.kind === "decision_applied") {
    console.log(\`  decision: \${event.decision} (\${event.policy_result})\`);
  }
}`,
      },
    },
  },

  "cookbook/subagent-fanout": {
    title: "Plan a fan-out, then steer and stop the subagents",
    blurb: "Describe a job and Muse Spark plans its subtasks, files, checks and merge order as strict JSON; the board then runs one worktree-isolated child per task up to the concurrency limit, with queued or interrupting steers and cooperative cancels (under a cent).",
    Component: FanoutPlanner,
    props: {},
    agentPrompt: {
      task: "Fan this project's next multi-part job out to Muse Code subagents: launch muse --subagent-worktree-isolation, have the parent spawn one write-capable subagent with worktree_isolation per bounded task (each with a proving command), check subagent_status, then merge the finished children one at a time in a planned order, testing after each.",
      facts: [
        "Without --subagent-worktree-isolation, worktree_isolation: true spawns are rejected (worktree_isolation_unavailable).",
        "Each child gets a git worktree under .muse/worktrees/, detached at the parent's HEAD; the parent's checkout never changes.",
        "Concurrency: about cores - 2, clamped to 4 to 8; extra spawns queue in submission order.",
        "subagent_send_message queues for the child's next turn (it can arrive too late) or interrupts; subagent_cancel is cooperative (a finished child answers already_terminal).",
        "subagent_wait blocks up to a deadline; subagent_read_result reads a finished child.",
      ],
      checklist: [
        "git worktree list shows one detached worktree per running child at the parent's commit.",
        "After the merges, in the planned order, the full test suite passes on the parent branch.",
      ],
      snippets: {
        curl: `# The recipe's flow (no API call).
cd /path/to/your/repo && muse --subagent-worktree-isolation   # must be a git repository
# Prompt the parent: "Spawn one write-capable subagent WITH worktree_isolation for EACH task:
#   (1) ..., (2) ..., (3) ... Spawn all now, then call subagent_status and show me the full set."
git worktree list   # one .muse/worktrees/... (detached HEAD) per child
# Steer with subagent_send_message (queue, or interrupt); stop with subagent_cancel and a reason.
# Merge the finished children one at a time, testing after each. merge_order.txt lists their
# worktrees in the planned order, with cancelled children left out.
while read -r wt; do
  git merge --no-ff --no-edit "$(git -C "$wt" rev-parse HEAD)" && python3 -m pytest -q || break
done < merge_order.txt`,
        python: `import json, os
from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])
strict = lambda p: {"type": "object", "additionalProperties": False, "required": list(p), "properties": p}
s, strs = {"type": "string"}, {"type": "array", "items": {"type": "string"}}
task = strict({"id": s, "objective": s, "files": strs, "verify": s})
# Plan before you spawn: bounded tasks, their files, a proving command, a merge order.
resp = client.responses.create(
    model="muse-spark-1.3-contributor", input=open("JOB.md").read(),
    instructions="Split the job into bounded, verifiable subagent tasks, then order the merges.",
    text={"format": {"type": "json_schema", "name": "Plan", "strict": True,
                     "schema": strict({"tasks": {"type": "array", "items": task}, "merge_order": strs})}},
)
print(json.dumps(json.loads(resp.output_text), indent=2))`,
        typescript: `import OpenAI from "openai";
import { readFileSync } from "node:fs";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const strict = (p: object) => ({ type: "object", additionalProperties: false, required: Object.keys(p), properties: p });
const [s, strs] = [{ type: "string" }, { type: "array", items: { type: "string" } }];
const tasks = { type: "array", items: strict({ id: s, objective: s, files: strs, verify: s }) };
// Plan before you spawn: bounded tasks, their files, a proving command, a merge order.
const resp = await client.responses.create({
  model: "muse-spark-1.3-contributor", input: readFileSync("JOB.md", "utf8"),
  instructions: "Split the job into bounded, verifiable subagent tasks, then order the merges.",
  text: { format: { type: "json_schema", name: "Plan", strict: true, schema: strict({ tasks, merge_order: strs }) } },
});
console.log(JSON.stringify(JSON.parse(resp.output_text), null, 2));`,
      },
    },
  },

  "cookbook/goal-tracking": {
    title: "Pin a goal and let the audit refuse to close it early",
    blurb: "Declare a goal with acceptance checks, watch the step probe, then hand the agent's completion report to a Muse Spark judge: update_goal goes through only when every check passes with evidence quoted from the report (under a cent).",
    Component: GoalJudge,
    props: {},
    agentPrompt: {
      task: "Use goal tracking for this project's next multi-step task: write the objective with its finish line as a command (done ONLY when every acceptance check passes), pin it with /goal before the first working prompt, and in your own harness refuse update_goal(status: complete) until that command passes.",
      facts: [
        "/goal <objective> stores the objective for the session; a Goal(...) indicator in the status line tracks it.",
        "About every 10 model calls without progress, a step probe queues 'Continue working toward the active session goal' (the TUI shows goal reminded).",
        "The completion audit gates update_goal. Name the oracle in the objective: a finish line that is a command is much harder to close early.",
        "In your own harness, run that command when update_goal(status: complete) arrives and return a failure as the tool result. A judge model can grade checks no command covers, but code decides.",
      ],
      checklist: [
        "The objective names a command, and its output shows every check passing before the goal closes.",
        "update_goal(status: complete) is refused while a test fails, and accepted once the command passes.",
      ],
      snippets: {
        python: `import subprocess

# The completion audit for your own harness: when the agent calls update_goal(status="complete"),
# run the goal's finish line (the command named in the objective) and refuse unless it passes now.
FINISH = ["python3", "-m", "pytest", "-q", "test_falcon_acceptance.py"]

def update_goal(status: str) -> dict:
    """The update_goal tool's handler. Its return value goes back to the model as the tool result."""
    if status != "complete":
        return {"ok": True, "status": status}
    run = subprocess.run(FINISH, capture_output=True, text=True)
    last = ((run.stdout or run.stderr).strip().splitlines() or ["no output"])[-1]
    if run.returncode != 0:
        return {"ok": False, "error": f"not done: {' '.join(FINISH)} reports {last}. Fix it, rerun it, then close the goal."}
    return {"ok": True, "status": "complete", "evidence": last}

print(update_goal("complete"))`,
        typescript: `import { spawnSync } from "node:child_process";

// The completion audit for your own harness: when the agent calls update_goal({ status: "complete" }),
// run the goal's finish line (the command named in the objective) and refuse unless it passes now.
const FINISH = ["python3", "-m", "pytest", "-q", "test_falcon_acceptance.py"];

/** The update_goal tool's handler. Its return value goes back to the model as the tool result. */
export function updateGoal(status: string): Record<string, unknown> {
  if (status !== "complete") return { ok: true, status };
  const run = spawnSync(FINISH[0], FINISH.slice(1), { encoding: "utf8" });
  const last = \`\${run.stdout ?? ""}\${run.stderr ?? ""}\`.trim().split("\\n").pop() || "no output";
  if (run.status !== 0) return { ok: false, error: \`not done: \${FINISH.join(" ")} reports \${last}. Fix it, rerun it, then close the goal.\` };
  return { ok: true, status: "complete", evidence: last };
}

console.log(updateGoal("complete"));`,
        curl: `# In Muse Code (no API call): pin the goal before the first working prompt.
cd perigord_gateway && muse
# /goal Migrate the Perigord API gateway from the legacy Kestrel token scheme to the
# Falcon request-signing scheme in SPEC.md. Done ONLY when all six checks in
# test_falcon_acceptance.py pass.
# The finish line, which the agent must run before update_goal:
python3 -m pytest -q test_falcon_acceptance.py   # 6 passed`,
      },
    },
  },

  "cookbook/bundled-skills": {
    title: "Run /plan, /grilling, /grill-with-docs and /taste on the recipe's project",
    blurb: "Pick a skill to see what it does, when to use it and how it loads, then run the recipe's own prompt on its sample project in that skill's style: a plan that stops for approval, one question at a time, decisions written to DECISIONS.md, or the /taste checklist (under a cent).",
    Component: SkillExplorer,
    props: { skill: "plan" },
    agentPrompt: {
      task: "Adopt Muse Code's bundled skills here: before the next non-trivial change run /plan (a grounded plan under .agents/plans/), settle open design questions with /grill-with-docs into docs/DECISIONS.md (create it if there's no decisions log), and use /taste for UI. Note in AGENTS.md where decisions live and which brand rules /taste follows.",
      facts: [
        "The four skills are built in (muse-core), on by default; muse skills list shows each as built-in.",
        "Each runs only on its slash command: an ordinary implement request never triggers /plan.",
        "At session open only summaries load; invoking one makes read_skill pull its SKILL.md for that turn (Loaded skill <name> · built-in).",
        "/plan changes no code and ends with Approve, request changes, or cancel?; /grilling asks one decision-forcing question per turn.",
        "/grill-with-docs needs a named destination; /taste only strips AI-made defaults (purple-to-blue gradient, centered hero, three-card grid) and defers to an explicit brand.",
      ],
      checklist: [
        "A /plan run leaves a plan under .agents/plans/ and no code changes.",
        "docs/DECISIONS.md gains entries with Decision, Rationale and Rejected after a /grill-with-docs session.",
      ],
      snippets: {
        curl: `# In this project (no API call): the skills ground themselves in your own files.
muse skills list   # plan, grilling, grill-with-docs, taste: built-in
mkdir -p docs && [ -f docs/DECISIONS.md ] ||
  printf '# Design Decisions\\n\\nDurable decisions, each a settled choice with rationale.\\n' > docs/DECISIONS.md
muse
# /plan <the next change>. Plan it, do not implement yet.
# /grill-with-docs Pressure-test <that design>, and record the settled decisions in docs/DECISIONS.md as we go.
ls .agents/plans/ && git status --short   # the plan, and no code changes
cat docs/DECISIONS.md
# The recipe's own sample (README.md and ledger.py) is on its page, under "Try it on the sample project".`,
        python: `import os, sys
from openai import OpenAI

# A /plan-style turn for your own harness: python plan.py "<change>" FILE...
client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])
change, paths = sys.argv[1], sys.argv[2:]
files = "\\n\\n".join(f"--- {p} ---\\n{open(p).read()}" for p in paths)
resp = client.responses.create(
    model="muse-spark-1.3-contributor",
    instructions=("Write a decision-complete plan grounded in the files: Goal, Success criteria, Key decisions "
                  "(options, one recommended), Work plan, Validation plan. Don't implement. "
                  "End with: Approve, request changes, or cancel?"),
    input=f"{files}\\n\\n{change} Plan it, do not implement yet.",
)
os.makedirs(".agents/plans", exist_ok=True)
open(".agents/plans/plan.md", "w").write(resp.output_text)
print(resp.output_text)`,
        typescript: `import OpenAI from "openai";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// A /plan-style turn for your own harness: npx tsx plan.ts "<change>" FILE...
const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const [change, ...paths] = process.argv.slice(2);
const files = paths.map((p) => \`--- \${p} ---\\n\${readFileSync(p, "utf8")}\`).join("\\n\\n");
const resp = await client.responses.create({
  model: "muse-spark-1.3-contributor",
  instructions: "Write a decision-complete plan grounded in the files: Goal, Success criteria, Key decisions " +
    "(options, one recommended), Work plan, Validation plan. Don't implement. End with: Approve, request changes, or cancel?",
  input: \`\${files}\\n\\n\${change} Plan it, do not implement yet.\`,
});
mkdirSync(".agents/plans", { recursive: true });
writeFileSync(".agents/plans/plan.md", resp.output_text);
console.log(resp.output_text);`,
      },
    },
  },

  "cookbook/loop-and-cron": {
    title: "Turn a /loop request into a cron job and check it",
    blurb: "Describe a schedule in plain words and Muse Spark returns the stored job as strict JSON; a local validator shows the cron's next fire times in your timezone, the jitter window and the seven-day lifetime, plus a session-scoped job list to run, cancel and recover (under a cent).",
    Component: ScheduleBuilder,
    props: {},
    agentPrompt: {
      task: "Schedule this project's recurring agent chores with Muse Code's /loop (say, a daily bug digest in docs/BUG_DIGEST.md), check the stored cron and next fire time by listing jobs, and move work that must run with Muse Code closed, or past seven days, to the system scheduler or CI. Validate any cron you translate yourself.",
      facts: [
        "/loop asks the model for a five-field cron (minute hour day-of-month month day-of-week) in local time: 8am daily is 0 8 * * *.",
        "Recurring jobs get deterministic forward jitter of up to 30 minutes and expire after 7 days; a one-time job deletes itself once delivered.",
        "Jobs fire only while Muse Code runs and belong to their session (resume it to restore them); missed recurring runs give at most one catch-up.",
        "Operations: create, list, delete. To change a job, cancel it by ID and create a replacement.",
        "Say 'Do not perform the task now' to only create the job.",
      ],
      checklist: [
        "Listing jobs shows the new job's ID, cadence and task, with the next eligible fire at the expected local time (up to 30 minutes later).",
        "Cancelling it by ID and listing again shows it gone.",
      ],
      snippets: {
        curl: `# Inside Muse Code (no API call):
#   /loop every morning at 8am, triage new bugs from bugs/BUGS.md and post a digest to docs/BUG_DIGEST.md
#   List my scheduled jobs with each cron expression and next eligible fire time.
#   Schedule a one-time job for tomorrow at 2pm local time to check whether D114486376 has review
#   comments and summarize them. Do not inspect the diff now. Only create the scheduled job.
#   Cancel scheduled job <id>, then list scheduled jobs to confirm none remain.
test -f /tmp/bug_digest_demo/docs/BUG_DIGEST.md && sed -n '1,40p' /tmp/bug_digest_demo/docs/BUG_DIGEST.md
# Work that must run with Muse Code closed belongs in the system scheduler instead:
( crontab -l 2>/dev/null; echo "0 8 * * * cd /tmp/bug_digest_demo && ./triage.sh" ) | crontab -`,
        python: `import json, os
from datetime import datetime
from croniter import croniter
from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])
now = datetime.now().astimezone()
props = {"cron": {"type": "string"}, "recurring": {"type": "boolean"}}
resp = client.responses.create(
    model="muse-spark-1.3-contributor",
    instructions=f"Give the request's five-field local-time cron. It is now {now:%c %Z}.",
    input="every morning at 8am, triage new bugs",
    text={"format": {"type": "json_schema", "name": "Job", "strict": True, "schema": {"type": "object",
          "properties": props, "required": list(props), "additionalProperties": False}}},
)
job = json.loads(resp.output_text)
cron = job["cron"]
if len(cron.split()) != 5 or not croniter.is_valid(cron):  # validate before storing
    raise SystemExit(f"invalid cron: {cron}")
print(cron, "recurring" if job["recurring"] else "one-time", croniter(cron, now).get_next(datetime))`,
        typescript: `import OpenAI from "openai";
import { CronExpressionParser } from "cron-parser";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const properties = { cron: { type: "string" }, recurring: { type: "boolean" } };
const resp = await client.responses.create({
  model: "muse-spark-1.3-contributor",
  instructions: \`Give the request's five-field local-time cron. It is now \${new Date()}.\`,
  input: "every morning at 8am, triage new bugs",
  text: { format: { type: "json_schema", name: "Job", strict: true,
    schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false } } },
});
const job = JSON.parse(resp.output_text);
// Validate before storing: the parser throws on a bad field.
if (job.cron.trim().split(/\\s+/).length !== 5) throw new Error("not a five-field cron");
console.log(job.cron, job.recurring ? "recurring" : "one-time", CronExpressionParser.parse(job.cron).next().toString());`,
      },
    },
  },

  "cookbook/side-chats": {
    title: "Branch a side chat that the main thread never sees",
    blurb: "Chat on a main thread, start a long turn, open /side while it streams, and ask on the side: the side chat continues from the main thread's last committed response while the main thread keeps its own chain, so asking it later shows no trace of the side (each turn under a cent).",
    Component: SideChat,
    props: {},
    agentPrompt: {
      task: "Add side chats to this project's agent chat: keep the main conversation as a chain of stored Responses (previous_response_id). A side thread starts from the main thread's last completed response with its own instructions (history is reference only; no agents or file changes), chains its own turns and is dropped on return.",
      facts: [
        "POST /v1/responses stores replies (store defaults to true); a follow-up with previous_response_id sees that response's whole history, and two follow-ups from one id branch.",
        "Instructions don't carry over with previous_response_id: send the side chat's own instructions on every side turn.",
        "Branch only from a completed response; Muse Code refuses /side until the source session has a durable turn.",
        "In Muse Code /btw is an alias of /side, and Ctrl+C returns to the main thread unchanged.",
      ],
      checklist: [
        "A side turn can answer from the main thread's content, since it reads the history up to the cut.",
        "Back on the main thread, asking about the side-only topic gets an answer that it wasn't discussed.",
        "No main-thread request ever carries a side response id as previous_response_id.",
      ],
      snippets: {
        python: `import os
from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])
MODEL = "muse-spark-1.3-contributor"
SIDE = "This is a side chat. The main thread before it is reference only. Answer questions; change no files."

main = client.responses.create(model=MODEL, input="Here is widget.py: <paste it>. What does it do?")
# The side chat starts from the main thread's last completed response and chains its own turns.
side = client.responses.create(model=MODEL, instructions=SIDE, previous_response_id=main.id,
                               input="If I pass a reading of 2.0, what score comes back?")
print("side:", side.output_text)
# Back on main: continue from the main chain only, never from a side id.
back = client.responses.create(model=MODEL, previous_response_id=main.id,
                               input="Did we discuss a reading of 2.0 on this thread?")
print("main:", back.output_text)`,
        typescript: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const model = "muse-spark-1.3-contributor";
const SIDE = "This is a side chat. The main thread before it is reference only. Answer questions; change no files.";

const main = await client.responses.create({ model, input: "Here is widget.py: <paste it>. What does it do?" });
// The side chat starts from the main thread's last completed response and chains its own turns.
const side = await client.responses.create({ model, instructions: SIDE, previous_response_id: main.id,
  input: "If I pass a reading of 2.0, what score comes back?" });
console.log("side:", side.output_text);
// Back on main: continue from the main chain only, never from a side id.
const back = await client.responses.create({ model, previous_response_id: main.id, input: "Did we discuss a reading of 2.0 on this thread?" });
console.log("main:", back.output_text);`,
        curl: `# A main turn, a side turn branched from it, then main again: it never sees the side.
ask() { curl -s https://api.meta.ai/v1/responses -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" -d "$1" | jq -r '.id, (.output[] | select(.type=="message") | .content[0].text)'; }
M=muse-spark-1.3-contributor
MAIN=$(ask "$(jq -n --arg m $M '{model: $m, input: "Here is widget.py: <paste it>. What does it do?"}')" | head -n 1)
ask "$(jq -n --arg m $M --arg id "$MAIN" '{model: $m, previous_response_id: $id,
  instructions: "This is a side chat. The history is reference only. Answer questions only.",
  input: "If I pass a reading of 2.0, what score comes back?"}')"
ask "$(jq -n --arg m $M --arg id "$MAIN" '{model: $m, previous_response_id: $id,
  input: "Did we discuss a reading of 2.0 on this thread? Answer from this thread only."}')"`,
      },
    },
  },
};
