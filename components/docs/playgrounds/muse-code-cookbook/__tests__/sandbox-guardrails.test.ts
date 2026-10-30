/**
 * The containment and guardrail simulators against the contained-execution and immutable-guardrails recipes: the
 * three boundaries with the recipe's exact error lines, the probe that must pass, the launch flags, which guardrail
 * paths each of the two checks covers, and each workspace's own files: what ls, cat and git status answer, what a
 * run writes, and the note the model gets for a command the simulator can't answer.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/muse-code-cookbook/__tests__/sandbox-guardrails.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEdit, contractSteps, initialTree, resolvePath, runCommand, SANDBOX_DEMO, startupLine, toolResult, writeVerdict } from "@/components/docs/playgrounds/muse-code-cookbook/logic/sandbox";
import { DEMO_AGENTS_MD, GUARDRAIL_DEMO, guardrailOutcome, mediatedCheck, sandboxCheck } from "@/components/docs/playgrounds/muse-code-cookbook/logic/guardrails";
import { STAGED_DEMO } from "@/components/docs/playgrounds/muse-code-cookbook/logic/approvals";

/** The JSON the model gets back for a command in a workspace, on a working tree when one is given. */
function tool(command: string, ws = GUARDRAIL_DEMO, tree = initialTree(ws), launch: Parameters<typeof runCommand>[1] = "default") {
  return JSON.parse(toolResult(runCommand(command, launch, "enforcing", ws, tree))) as { stdout: string; stderr: string; exit_code: number; note?: string };
}

describe("contained execution", () => {
  it("runs the build script with enforcement on", () => {
    const r = runCommand("./build_info.sh", "disable-approval", "enforcing");
    assert.equal(r.probe, "enforcing");
    assert.equal(r.stdout, "GRISHNOK-BUILD-FINGERPRINT=QX7-vellum-2291");
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.denials, []);
  });

  it("blocks the recipe's three boundaries with its exact errors", () => {
    const home = runCommand("echo pwned > $HOME/sandbox_escape_probe.txt", "disable-approval", "enforcing");
    assert.equal(home.stderr, "/bin/bash: line 1: /home/you/sandbox_escape_probe.txt: Read-only file system");
    assert.equal(home.exitCode, 1);
    const git = runCommand("echo hacked > .git/config", "disable-approval", "enforcing");
    assert.equal(git.stderr, "/bin/bash: line 1: .git/config: Read-only file system");
    assert.equal(git.exitCode, 1);
    const net = runCommand("curl -sS --max-time 8 https://example.com", "disable-approval", "enforcing");
    assert.equal(net.stderr, "curl: (56) Received HTTP code 502 from proxy after CONNECT");
    assert.equal(net.exitCode, 56);
    assert.equal(net.denials[0].op, "network");
  });

  it("lets writes land in the workspace and the temp root", () => {
    assert.deepEqual(runCommand("echo ok > notes.txt", "default", "enforcing").landed.map((e) => e.path), ["/tmp/sandbox_demo/notes.txt"]);
    assert.equal(runCommand("touch /tmp/scratch.txt", "default", "enforcing").exitCode, 0);
    assert.equal(writeVerdict("/tmp/sandbox_demo/.muse/approval-policy.json", SANDBOX_DEMO).writable, false);
    assert.equal(resolvePath("~/x/../y", SANDBOX_DEMO), "/home/you/y");
  });

  it("follows && and || like bash", () => {
    const r = runCommand("mkdir $HOME/x && echo after", "default", "enforcing");
    assert.equal(r.stages[1].ran, false);
    assert.equal(r.stderr, "mkdir: cannot create directory '/home/you/x': Read-only file system");
    const fallback = runCommand("false || echo fallback", "default", "enforcing");
    assert.equal(fallback.stdout, "fallback");
    assert.equal(fallback.exitCode, 0);
  });

  it("refuses to run anything when the probe fails", () => {
    for (const host of ["missing-kernel", "swapped-helper", "changed-path"] as const) {
      const r = runCommand("./build_info.sh", "default", host);
      assert.equal(r.refused, true);
      assert.equal(r.stderr, "sandbox enforcement unavailable");
      assert.equal(JSON.parse(toolResult(r)).ran, false);
    }
    const steps = contractSteps(runCommand("ls", "default", "missing-kernel"), "default", "missing-kernel");
    assert.deepEqual(steps.map((s) => s.state), ["done", "failed", "failed", "skipped", "done"]);
  });

  it("skips the probe with --yolo and --disable-sandbox, and nothing is contained", () => {
    const r = runCommand("echo pwned > $HOME/sandbox_escape_probe.txt", "yolo", "missing-kernel");
    assert.equal(r.probe, "skipped");
    assert.equal(r.exitCode, 0);
    assert.equal(r.landed.length, 1);
    assert.equal(startupLine("yolo"), "approval disabled · sandbox disabled");
    assert.equal(startupLine("default"), "approval normal · sandbox normal");
    assert.equal(startupLine("disable-approval"), "approval disabled · sandbox normal");
    assert.equal(startupLine("disable-sandbox"), "approval normal · sandbox disabled");
  });
});

describe("immutable guardrails", () => {
  it("covers the recipe's mediated-write paths", () => {
    for (const p of [".agents/AGENTS.md", ".muse/approval-policy.json", ".git/config", ".husky/pre-commit", ".envrc", "~/.zshrc", "~/.bashrc", "~/.gitconfig", "docs/git-config-link", "sub/.agents/notes.md"]) {
      assert.equal(mediatedCheck(p).protected, true, p);
    }
    for (const p of ["billing.py", "docs/notes.md", "sub/.envrc", ".hg/hgrc"]) assert.equal(mediatedCheck(p).protected, false, p);
    assert.match(mediatedCheck("docs/git-config-link").reasons.join(" "), /symlink/);
  });

  it("keeps the sandbox's guardrail directories read-only, and only those inside the workspace", () => {
    for (const p of [".git/config", ".muse/x", ".agents/probe.txt", ".sl/x", ".hg/hgrc", ".eden/x"]) assert.equal(sandboxCheck(p).protected, true, p);
    assert.equal(sandboxCheck(".husky/pre-commit").protected, false, ".husky is the approval check's, not the sandbox's");
    assert.equal(sandboxCheck("billing.py").protected, false);
    assert.equal(sandboxCheck("~/.zshrc").protected, true, "outside the workspace, the managed profile is read-only");
  });

  it("holds a guardrail edit for review with no standing grant, and lets an ordinary edit apply", () => {
    const held = guardrailOutcome(".agents/AGENTS.md", "edit_file", "default");
    assert.equal(held.kind, "held");
    assert.deepEqual(held.kind === "held" ? held.choices : null, ["allow_once", "abort"]);
    assert.equal(guardrailOutcome("billing.py", "edit_file", "default").kind, "applies");
    assert.equal(guardrailOutcome(".agents/AGENTS.md", "write_file", "disable-sandbox").kind, "held", "the review doesn't need the sandbox");
    assert.equal(guardrailOutcome(".agents/AGENTS.md", "edit_file", "disable-approval").kind, "unguarded");
    assert.equal(guardrailOutcome(".agents/AGENTS.md", "edit_file", "yolo").kind, "unguarded");
  });

  it("blocks the recipe's shell write at the sandbox", () => {
    const blocked = guardrailOutcome(".agents/probe.txt", "shell", "disable-approval");
    assert.equal(blocked.kind, "blocked");
    assert.equal(blocked.kind === "blocked" ? blocked.stderr : "", "/bin/sh: line 1: .agents/probe.txt: Read-only file system");
    assert.equal(guardrailOutcome(".agents/probe.txt", "shell", "yolo").kind, "unguarded");
    assert.equal(guardrailOutcome(".husky/pre-commit", "shell", "disable-approval").kind, "applies");
  });
});

describe("each workspace's own files", () => {
  it("answers ls and cat from the guardrail recipe's workspace, not the sandbox recipe's", () => {
    assert.equal(tool("ls").stdout, "billing.py\ndocs");
    assert.equal(tool("cat .agents/AGENTS.md").stdout, DEMO_AGENTS_MD);
    const probe = tool('cat .agents/AGENTS.md; echo "---END---"; ls -R');
    assert.equal(probe.stdout, `${DEMO_AGENTS_MD}\n---END---\n.:\nbilling.py\ndocs\n\n./docs:\ngit-config-link`, "the review's first call, answered");
    assert.match(tool("ls -la .agents").stdout, /AGENTS\.md$/);
    assert.equal(tool("python3 billing.py").stdout, "47.1");
    assert.equal(tool("git status --porcelain .agents/AGENTS.md").stdout, "", "committed and unchanged");
    assert.equal(tool("ls", SANDBOX_DEMO).stdout, "build_info.sh");
    assert.match(tool("cat build_info.sh", SANDBOX_DEMO).stdout, /GRISHNOK-BUILD-FINGERPRINT=QX7-vellum-2291/);
    assert.equal(tool("git status --porcelain", SANDBOX_DEMO).stdout, "?? build_info.sh", "git init, never committed");
  });

  it("says so in the tool result when it has no output for a command", () => {
    const unknown = tool("git diff");
    assert.equal(unknown.stdout, "");
    assert.match(unknown.note ?? "", /^simulated sandbox: git ran inside the sandbox; the simulator has no output for it\.$/);
    assert.match(tool("echo $(whoami)").note ?? "", /command substitutions/);
    assert.equal(tool("ls").note, undefined, "a command it answers carries no note");
    assert.equal(tool("cat nope.txt").stderr, "cat: nope.txt: No such file or directory");
    assert.equal(tool("cat nope.txt").exit_code, 1);
  });

  it("keeps what a run writes for the run's next command", () => {
    const tree = initialTree(GUARDRAIL_DEMO);
    assert.equal(tool("echo ok > notes.txt && cat notes.txt", GUARDRAIL_DEMO, tree).stdout, "ok");
    assert.equal(tool("git status --porcelain", GUARDRAIL_DEMO, tree).stdout, "?? notes.txt");
    assert.deepEqual(applyEdit(tree, GUARDRAIL_DEMO, "billing.py", "", "# end of file\n"), { ok: true });
    assert.equal(tool("tail -n 1 billing.py", GUARDRAIL_DEMO, tree).stdout, "# end of file");
    assert.equal(tool("git status --porcelain", GUARDRAIL_DEMO, tree).stdout, " M billing.py\n?? notes.txt");
    assert.deepEqual(applyEdit(tree, GUARDRAIL_DEMO, "billing.py", "no such text", "x"), { ok: false, error: "old_text was not found in billing.py" });
    assert.equal(tool("cat notes.txt").stderr, "cat: notes.txt: No such file or directory", "a run without the tree starts fresh");
  });

  it("blocks a write through a symlink into .git, and leaves .agents as it was", () => {
    const tree = initialTree(GUARDRAIL_DEMO);
    assert.equal(tool("echo hi > docs/git-config-link", GUARDRAIL_DEMO, tree).stderr, "/bin/bash: line 1: docs/git-config-link: Read-only file system");
    assert.match(tool("cat docs/git-config-link", GUARDRAIL_DEMO, tree).stdout, /^\[core\]/);
    assert.equal(tool("echo probe > .agents/probe.txt; test -e .agents/probe.txt; echo $?", GUARDRAIL_DEMO, tree, "disable-approval").stdout, "1");
    assert.equal(tool("ls .agents", GUARDRAIL_DEMO, tree).stdout, "AGENTS.md");
  });

  it("runs the staged recipe's command in its own workspace once every stage cleared", () => {
    const tree = initialTree(STAGED_DEMO);
    const ran = tool("wc -l report.log && echo cleaning && rm -rf report.log", STAGED_DEMO, tree);
    assert.deepEqual([ran.stdout, ran.exit_code], ["1 report.log\ncleaning", 0]);
    assert.equal(tool("ls", STAGED_DEMO, tree).stdout, "quota_tool.py", "report.log is gone");
    assert.equal(tool("python3 quota_tool.py", STAGED_DEMO, tree).stdout, "9.65");
  });

  it("pipes and redirects like bash", () => {
    assert.equal(tool("cat .agents/AGENTS.md | grep -c Never").stdout, "1");
    assert.equal(tool("echo err 2>&1 1>/dev/null").stdout, "", "stdout went to /dev/null after stderr was pointed at the old stdout");
    assert.equal(tool("ls nope 2>/dev/null; echo code=$?").stdout, "code=2");
    assert.equal(tool("cd docs && pwd").stdout, "/tmp/rule12_demo/docs");
  });
});
