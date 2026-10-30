/**
 * The sandboxed-execution demo's project and shell: the harness's run mode is executed in a node:vm context standing
 * in for the iframe (messages go to a fake parent), to prove each task's tests fail at the base commit and pass with
 * the known fix. The shell planner answers the commands a fix needs. No network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-use-cases/__tests__/sandbox-exec.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import { harnessSources } from "@/components/docs/playgrounds/cookbook-use-cases/lib/harness";
import { SANDBOX_TASKS, passedTests, planCommand, shellWords, splitCommands, taskById, taskInstruction, testsEdited } from "@/components/docs/playgrounds/cookbook-use-cases/lib/sandbox-exec";

async function runHarness(files: Record<string, string>, entry: string, argv: string[] = []): Promise<{ code: number; out: string }> {
  const messages: Array<Record<string, unknown>> = [];
  const ctx: Record<string, unknown> = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout,
    parent: { postMessage: (m: Record<string, unknown>) => messages.push(m) },
    addEventListener() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(harnessSources.commonSource("n") + harnessSources.runSource(files, entry, argv), ctx);
  for (let i = 0; i < 100; i++) {
    const done = messages.find((m) => m.type === "done");
    if (done) {
      const out = messages.filter((m) => m.type === "console").map((m) => String(m.text)).join("\n");
      return { code: Number(done.code), out };
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the harness never finished");
}

const FIXES: Record<string, (files: Record<string, string>) => Record<string, string>> = {
  "requests-6028": (f) => ({
    ...f,
    "src/utils.js": f["src/utils.js"].replace('  if (port) netloc += ":" + port;', '  if (port) netloc += ":" + port;\n  if (parsed.auth) netloc = parsed.auth + "@" + netloc;'),
  }),
  slugify: (f) => ({ ...f, "src/slug.js": f["src/slug.js"].replace("[^a-z]+", "[^a-z0-9]+") }),
};

describe("sandbox tasks", () => {
  for (const task of SANDBOX_TASKS) {
    it(`${task.id}: fails at the base commit, passes with the fix`, async () => {
      const entry = /"test":\s*"node ([^"\s]+)/.exec(task.files["package.json"])![1];
      const base = await runHarness(task.files, entry);
      assert.equal(base.code, 1, base.out);
      const basePassed = passedTests(base.out);
      for (const t of task.failToPass) assert.equal(basePassed.has(t), false, `${t} should fail first`);
      for (const t of task.passToPass) assert.equal(basePassed.has(t), true, `${t} should already pass:\n${base.out}`);

      const fixed = await runHarness(FIXES[task.id](task.files), entry);
      assert.equal(fixed.code, 0, fixed.out);
      const fixedPassed = passedTests(fixed.out);
      for (const t of [...task.failToPass, ...task.passToPass]) assert.equal(fixedPassed.has(t), true, `${t}:\n${fixed.out}`);
      assert.match(fixed.out, new RegExp(`\\b${task.failToPass.length + task.passToPass.length} passed`));
    });
  }

  it("filters to one test id, like pytest node ids", async () => {
    const t = taskById("requests-6028");
    const r = await runHarness(t.files, "tests/test_utils.js", ["user@example.com"]);
    assert.match(r.out, /1 failed, 0 passed/);
  });

  it("reports a thrown error and a missing module with exit code 1", async () => {
    assert.equal((await runHarness({ "a.js": "throw new Error('boom')" }, "a.js")).code, 1);
    const missing = await runHarness({ "a.js": "require('./nope')" }, "a.js");
    assert.equal(missing.code, 1);
    assert.match(missing.out, /Cannot find module '\.\/nope'/);
  });

  it("builds the instruction from task.json", () => {
    const text = taskInstruction(taskById("requests-6028"));
    assert.match(text, /^Fix this bug in the `psf\/requests` repository\./);
    assert.match(text, /--- failing tests \(already in the repo; make them pass, do not edit them\) ---/);
    assert.match(text, /all inside \/testbed\.$/);
  });
});

describe("sandbox shell", () => {
  const task = taskById("requests-6028");
  const files = task.files;
  it("splits commands and words", () => {
    assert.deepEqual(splitCommands("cd /testbed && node tests/test_utils.js; git status"), ["cd /testbed", "node tests/test_utils.js", "git status"]);
    assert.deepEqual(splitCommands("echo 'a && b'"), ["echo 'a && b'"]);
    assert.deepEqual(shellWords(`grep -n "user pass" src/utils.js`), ["grep", "-n", "user pass", "src/utils.js"]);
  });
  it("answers file and git commands", () => {
    assert.deepEqual(planCommand("ls", files, files, task), { kind: "text", out: "README.md\npackage.json\nsrc/\ntests/", code: 0 });
    const cat = planCommand("cat src/utils.js", files, files, task);
    assert.ok(cat.kind === "text" && cat.out.includes("function prependSchemeIfNeeded"));
    const sed = planCommand("sed -n '1,2p' src/utils.js", files, files, task);
    assert.ok(sed.kind === "text" && sed.out.split("\n").length === 2);
    const grep = planCommand("grep -rn netloc src", files, files, task);
    assert.ok(grep.kind === "text" && grep.out.startsWith("src/utils.js:"));
    const log = planCommand("git log --oneline", files, files, task);
    assert.ok(log.kind === "text" && log.out.includes("ef59aa022 Use parse_url"));
    const show = planCommand("git show ef59aa0", files, files, task);
    assert.ok(show.kind === "text" && show.out.includes("+  const parsed = parseUrl(url);"));
    assert.equal(planCommand("git diff", files, files, task).kind === "text" && (planCommand("git diff", files, files, task) as { out: string }).out, "");
  });
  it("runs node and npm test in the sandbox, and refuses the rest plainly", () => {
    assert.deepEqual(planCommand("node tests/test_utils.js 2>&1 | tail -20", files, files, task), { kind: "node", entry: "tests/test_utils.js", args: [] });
    assert.deepEqual(planCommand("npm test", files, files, task), { kind: "node", entry: "tests/test_utils.js", args: [] });
    const py = planCommand("python -m pytest", files, files, task);
    assert.ok(py.kind === "text" && py.code === 127);
    const curl = planCommand("curl https://example.com", files, files, task);
    assert.ok(curl.kind === "text" && curl.code === 127 && /command not found/.test(curl.out));
  });
  it("notices edited tests", () => {
    assert.deepEqual(testsEdited(files, { ...files, "tests/test_utils.js": "x" }), ["tests/test_utils.js"]);
  });
});
