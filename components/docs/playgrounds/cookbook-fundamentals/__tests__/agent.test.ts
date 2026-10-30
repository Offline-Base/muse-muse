/**
 * The agent demos' engine without a browser: the test runner (the exact source the page's worker runs, evaluated in a
 * node:vm context), the two sample projects (their planted bugs fail, the fixes pass, a half-done migration breaks a
 * caller), the project tools, the guards and the recipes' trace formats, and the recipe catalog's integrity (every
 * page exists, every core call is a request the docs proxy forwards, every sample is real).
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-fundamentals/__tests__/agent.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";
import {
  callbackReport,
  callKey,
  guardStop,
  interleavedTrace,
  loopTools,
  loopTrace,
  migrationTools,
  oracleFiles,
  ProjectFs,
  resultSummary,
  shortCall,
  turnsOf,
} from "@/components/docs/playgrounds/cookbook-fundamentals/agent";
import { AGENT_LOOP_TARGET, CALLBACK_TARGET, callbackSpots, RETRY_ASYNC_TEST } from "@/components/docs/playgrounds/cookbook-fundamentals/projects";
import { allGreen, formatReport, networkLoads, runNonce, RUNNER_SOURCE, WORKER_SOURCE, type TestReport } from "@/components/docs/playgrounds/cookbook-fundamentals/sandbox";
import { shouldRetryReference } from "@/components/docs/playgrounds/cookbook-fundamentals/useToolLoop";
import { filterRecipes, findRecipe, RECIPE_SECTIONS, sectionsById } from "@/components/docs/playgrounds/cookbook-fundamentals/recipes";
import { collectReply } from "@/lib/docs/client/stream";
import { runToolCall } from "@/lib/docs/client/tools";
import type { LoopStep, ModelStep } from "@/lib/docs/client/toolloop";
import { isAllowedEndpoint } from "@/lib/docs/client/endpoints";
import { jsonGet } from "@/lib/docs/client/pointer";
import { sampleById } from "@/lib/docs/media/samples";
import { DOCS_MODELS } from "@/lib/docs/proxy/policy";
import { docsPage } from "@/lib/docs/pages";

type Suite = (files: Record<string, string>, only: string | null, perTestMs: number) => Promise<TestReport>;
const vmSuite = vm.runInNewContext(`${RUNNER_SOURCE}\n;runSuite`, { setTimeout, clearTimeout }) as Suite;
// Reports come from the vm's realm; a JSON round trip makes them plain objects of this one, for deepEqual.
const runSuite: Suite = async (files, only, perTestMs) => JSON.parse(JSON.stringify(await vmSuite(files, only, perTestMs))) as TestReport;
const runTests = (files: Record<string, string>, only?: string | null) => runSuite(files, only ?? null, 300);

const failing = (r: TestReport) => r.results.filter((x) => !x.ok).map((x) => `${x.file}: ${x.name}`);

describe("the test runner", () => {
  it("runs the agent-loop project: the planted bugs fail, the rest pass", async () => {
    const r = await runTests(AGENT_LOOP_TARGET.files);
    assert.equal(r.passed, 9);
    assert.deepEqual(failing(r), [
      "tests/test_async_counter.js: 50 concurrent increments all count",
      "tests/test_grades.js: exactly 90 is an A",
      "tests/test_grades.js: exactly 80 is a B",
      "tests/test_normalize.js: a list of zeros stays zeros",
      "tests/test_pagination.js: keeps the final partial page",
      "tests/test_pagination.js: a page bigger than the list is one page",
    ]);
    assert.match(formatReport(r), /FAIL  a list of zeros stays zeros: Expected \[0,0,0\], got \[NaN,NaN,NaN\]/);
    assert.match(formatReport(r), /9 passed, 6 failed$/);
  });

  it("passes each task's test once its bug is fixed", async () => {
    const f = AGENT_LOOP_TARGET.files;
    const fixes: Record<string, [string, string]> = {
      "tests/test_pagination.js": [
        "src/pagination.js",
        f["src/pagination.js"].replace(/const numPages[\s\S]*?\n  }\n/, "for (let i = 0; i < items.length; i += pageSize) {\n    pages.push(items.slice(i, i + pageSize));\n  }\n"),
      ],
      "tests/test_grades.js": ["src/grades.js", f["src/grades.js"].replace(/score > (\d0)/g, "score >= $1")],
      "tests/test_normalize.js": ["src/normalize.js", f["src/normalize.js"].replace("v / max", "(max === 0 ? 0 : v / max)")],
      "tests/test_async_counter.js": [
        "src/async_counter.js",
        f["src/async_counter.js"].replace("const current = this.value;\n", "").replace("this.value = current + 1;", "this.value += 1;"),
      ],
    };
    for (const task of AGENT_LOOP_TARGET.tasks) {
      const [path, fixed] = fixes[task.test!];
      assert.notEqual(fixed, f[path], `the ${task.id} fix changes the file`);
      const r = await runTests({ ...f, [path]: fixed }, task.test);
      assert.ok(allGreen(r), `${task.id}: ${formatReport(r)}`);
    }
  });

  it("times out a test that never settles, reports load errors, and refuses outside modules", async () => {
    const r = await runSuite(
      {
        "tests/a.js": 'test("hangs", () => new Promise(() => {}));\ntest("throws", () => { throw new TypeError("boom"); });',
        "tests/b.js": "this is not javascript",
        "tests/c.js": 'require("fs");',
      },
      null,
      50,
    );
    assert.match(r.results[0].error ?? "", /Timed out after 50 ms/);
    assert.equal(r.results[1].error, "TypeError: boom");
    assert.equal(r.loadErrors.length, 2);
    assert.match(r.loadErrors[0].error, /^SyntaxError/);
    assert.match(r.loadErrors[1].error, /only the project's own files/);
    assert.equal(allGreen(r), false);
  });

  it("offers util.promisify and assert.rejects, and keeps console output", async () => {
    const r = await runTests({
      "src/cb.js": "module.exports = (x, cb) => setTimeout(() => (x ? cb(null, x * 2) : cb(new Error('no'))), 1);",
      "tests/t.js": [
        'const { promisify } = require("util");',
        'const assert = require("node:assert/strict");',
        'const p = promisify(require("../src/cb"));',
        'test("resolves", async () => { console.log("hi", { a: 1 }); assert.strictEqual(await p(2), 4); });',
        'test("rejects", () => assert.rejects(() => p(0)));',
      ].join("\n"),
    });
    assert.equal(r.passed, 2, formatReport(r));
    assert.deepEqual(r.logs, ['hi {"a":1}']);
  });

  it("runs project code in the worker with the network taken away", async () => {
    // A stand-in for the worker's global: fetch and friends live on the prototype, as on WorkerGlobalScope.
    class FakeWorkerScope {
      fetch() {
        return "network!";
      }
      importScripts() {}
      XMLHttpRequest() {}
    }
    const posted: unknown[] = [];
    const self = Object.create(FakeWorkerScope.prototype) as Record<string, unknown>;
    self.postMessage = (m: unknown) => posted.push(JSON.parse(JSON.stringify(m)));
    self.addEventListener = () => {};
    vm.runInNewContext(WORKER_SOURCE, { self, setTimeout, clearTimeout });
    assert.equal(self.fetch, undefined);
    assert.equal((FakeWorkerScope.prototype as unknown as Record<string, unknown>).fetch, undefined);
    (self.onmessage as (e: { data: unknown }) => void)({
      data: {
        files: {
          "tests/net.js":
            'const assert = require("assert");\ntest("no fetch", () => { assert.strictEqual(typeof fetch, "undefined"); assert.strictEqual(typeof self.importScripts, "undefined"); });',
        },
        perTestMs: 200,
        nonce: "n-1",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const msg = posted[0] as { nonce: string; ok: boolean; report: TestReport };
    assert.equal(msg.nonce, "n-1", "the report carries the run's nonce");
    assert.equal(msg.ok, true);
    assert.equal(msg.report.passed, 1, formatReport(msg.report));
  });

  it("keeps the verdict out of project code's hands: a posted fake report lacks the nonce, and assert can't be patched", async () => {
    const posted: Array<{ nonce?: string; ok?: boolean; report?: TestReport }> = [];
    const self: Record<string, unknown> = { addEventListener: () => {} };
    self.postMessage = (m: unknown) => posted.push(JSON.parse(JSON.stringify(m)));
    vm.runInNewContext(WORKER_SOURCE, { self, setTimeout, clearTimeout });
    (self.onmessage as (e: { data: unknown }) => void)({
      data: {
        files: {
          // Code under test that tries both shortcuts: a green report of its own, and a no-op strictEqual.
          "src/cheat.js": [
            'self.postMessage({ ok: true, report: { results: [], passed: 9, failed: 0, loadErrors: [], logs: [], timedOut: false, ms: 0 } });',
            'const assert = require("assert");',
            "assert.strictEqual = () => {};",
            "module.exports = { add: (a, b) => a - b };",
          ].join("\n"),
          "tests/add.js": 'const assert = require("assert");\nconst { add } = require("../src/cheat");\ntest("adds", () => assert.strictEqual(add(2, 2), 4));',
        },
        perTestMs: 200,
        nonce: "n-2",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(posted.length, 2);
    assert.equal(posted[0].nonce, undefined, "the fake report has no nonce, so the page ignores it");
    const real = posted.find((m) => m.nonce === "n-2")!;
    assert.equal(real.report?.failed, 1, "the frozen assert still fails the test");
    assert.match(runNonce(), /^[0-9a-f]{32}$/);
    assert.notEqual(runNonce(), runNonce());
  });

  it("runs the project's original tests against the agent's code, whatever it did to the tests", () => {
    const original = AGENT_LOOP_TARGET.files;
    const fixedSrc = original["src/grades.js"].replace(/score > (\d0)/g, "score >= $1");
    const cheated = { ...original, "src/grades.js": fixedSrc, "tests/test_grades.js": 'test("trivially", () => {});', "tests/extra.js": "test('x', () => {});" };
    const { files, changedTests } = oracleFiles(original, cheated);
    assert.equal(files["tests/test_grades.js"], original["tests/test_grades.js"]);
    assert.equal(files["src/grades.js"], fixedSrc);
    assert.equal("tests/extra.js" in files, false);
    assert.deepEqual(changedTests, ["tests/extra.js", "tests/test_grades.js"]);
    assert.deepEqual(oracleFiles(original, original).changedTests, []);
  });

  it("checks the retry migration with its own tests for the new Promise API, since the task rewrites the old ones", async () => {
    const files = CALLBACK_TARGET.files;
    const task = CALLBACK_TARGET.tasks[0];
    assert.deepEqual(Object.keys(task.oracleTests ?? {}), ["tests/callbackUtils.test.js"]);
    const migrated = {
      ...files,
      "src/lib/callbackUtils.js":
        "async function retry(operation, times) {\n  let last;\n  for (let i = 0; i < times; i++) {\n    try {\n      return await operation();\n    } catch (err) {\n      last = err;\n    }\n  }\n  throw last;\n}\n\nmodule.exports = { retry };\n",
      // The agent's own rewrite of the unit test, which the oracle sets aside.
      "tests/callbackUtils.test.js": 'test("anything", () => {});',
    };
    const good = oracleFiles(files, migrated, task.oracleTests);
    assert.equal(good.files["tests/callbackUtils.test.js"], RETRY_ASYNC_TEST);
    assert.deepEqual(good.changedTests, [], "the task asked for this rewrite");
    assert.ok(allGreen(await runTests(good.files)), formatReport(await runTests(good.files)));
    // Left unmigrated, the callback version faces the same tests. (Not run here: its promise rejections go unhandled,
    // which node's test runner counts against this test; the page's worker reports them as console output.)
    assert.equal(oracleFiles(files, files, task.oracleTests).files["tests/callbackUtils.test.js"], RETRY_ASYNC_TEST);
  });

  it("retries Meta's 'referenced response not found' once, and nothing else", () => {
    const notFound = { status: 400, error: { message: "Referenced response not found or expired" } };
    assert.equal(shouldRetryReference(notFound, { previous_response_id: "resp_1" }), true);
    assert.equal(shouldRetryReference(notFound, {}), false, "only a call that references a response");
    assert.equal(shouldRetryReference({ status: 400, error: { message: "tool_choice must be auto" } }, { previous_response_id: "resp_1" }), false);
    assert.equal(shouldRetryReference({ status: 200, error: null }, { previous_response_id: "resp_1" }), false);
  });

  it("puts the network lockdown in the worker and catches code that loads at run time", () => {
    assert.match(WORKER_SOURCE, /"fetch", "XMLHttpRequest", "WebSocket"/);
    assert.ok(WORKER_SOURCE.indexOf("self.onmessage") < WORKER_SOURCE.indexOf("delete target[names[i]]"), "the handler is set before the lockdown");
    assert.deepEqual(networkLoads({ "a.js": "const m = await import('https://x');", "b.js": "importScripts('x')", "c.js": "require('./a')" }), ["a.js", "b.js"]);
  });
});

const ROUTES_U1 = `const assert = require("assert");
const { getUserRoute } = require("../src/routes/users");

test("GET /users/u1", async () => {
  const res = await getUserRoute({ params: { id: "u1" } });
  assert.deepStrictEqual(res, { status: 200, body: { id: "u1", name: "Ada" } });
});
`;

describe("the callback project", () => {
  const files = CALLBACK_TARGET.files;
  const task3 = CALLBACK_TARGET.tasks[2];

  it("starts green, with the callback style the migration checks for", async () => {
    assert.ok(allGreen(await runTests(files)));
    assert.match(callbackReport(files, task3.migrate!), /Callback-style code left \(5\)/);
    assert.deepEqual(callbackSpots(files["src/db/store.js"]).length, 2, "the store keeps its callback API");
  });

  const USER = `const { promisify } = require("util");
const store = require("../db/store");
const findUser = promisify(store.findUser);

async function getUser(id) {
  const user = await findUser(id);
  return { id: user.id, name: user.name };
}

module.exports = { getUser };
`;

  it("breaks a caller when getUser goes async alone (the recipe's incomplete migration)", async () => {
    // routes/users.js still hands getUser a callback that is never called, so the route never answers. (Only the
    // u1 case runs here: the missing-user case also leaves a rejected promise unhandled, which node's test runner
    // counts against this test; the page's worker reports it in the console output instead.)
    const only = "tests/u1.test.js";
    const u1 = ROUTES_U1;
    const r = await runTests({ ...files, "src/repositories/userRepository.js": USER, [only]: u1 }, only);
    assert.deepEqual(failing(r), ["tests/u1.test.js: GET /users/u1"]);
    assert.match(formatReport(r), /Timed out/);
  });

  it("stays green with no callbacks left once the order is right", async () => {
    const migrated = {
      ...files,
      "src/repositories/userRepository.js": USER,
      "src/repositories/orderRepository.js": `const { promisify } = require("util");
const store = require("../db/store");
const { getUser } = require("./userRepository");
const findOrdersByUser = promisify(store.findOrdersByUser);

async function getOrdersForUser(userId) {
  const user = await getUser(userId);
  const orders = await findOrdersByUser(user.id);
  return { user, orders, total: orders.reduce((sum, o) => sum + o.total, 0) };
}

module.exports = { getOrdersForUser };
`,
      "src/routes/users.js": `const { getUser } = require("../repositories/userRepository");

async function getUserRoute(req) {
  try {
    return { status: 200, body: await getUser(req.params.id) };
  } catch (err) {
    return { status: 404, body: { error: err.message } };
  }
}

module.exports = { getUserRoute };
`,
      "src/routes/orders.js": `const { getOrdersForUser } = require("../repositories/orderRepository");

async function getOrdersRoute(req) {
  try {
    return { status: 200, body: await getOrdersForUser(req.params.id) };
  } catch (err) {
    return { status: 404, body: { error: err.message } };
  }
}

module.exports = { getOrdersRoute };
`,
    };
    const r = await runTests(migrated);
    assert.ok(allGreen(r), formatReport(r));
    assert.equal(callbackReport(migrated, task3.migrate!), `No callback-style code left in ${task3.migrate!.join(", ")}.`);
  });
});

describe("project tools", () => {
  it("lists, reads, writes and tests the project", async () => {
    const fs = new ProjectFs(AGENT_LOOP_TARGET.files);
    const tools = loopTools(fs, runTests);
    assert.deepEqual(tools.map((t) => t.def.name), ["list_files", "read_file", "write_file", "run_tests"]);
    const list = await runToolCall(tools, "list_files", "{}");
    assert.equal(list.output.split("\n").length, 8);
    const read = await runToolCall(tools, "read_file", '{"path":"./src/grades.js"}');
    assert.equal(read.output, AGENT_LOOP_TARGET.files["src/grades.js"]);
    const missing = await runToolCall(tools, "read_file", '{"path":"src/nope.js"}');
    assert.equal(missing.ok, false);
    assert.match(resultSummary("read_file", missing.output, missing.ok), /^error: No such file/);
    const wrote = await runToolCall(tools, "write_file", JSON.stringify({ path: "src/grades.js", content: AGENT_LOOP_TARGET.files["src/grades.js"].replace(/> (\d0)/g, ">= $1") }));
    assert.equal(wrote.output, "Wrote src/grades.js: +4 / -4 lines.");
    assert.deepEqual(fs.changed(), ["src/grades.js"]);
    const tested = await runToolCall(tools, "run_tests", '{"path":"tests/test_grades.js"}');
    assert.match(tested.output, /5 passed, 0 failed$/);
    assert.equal(resultSummary("run_tests", tested.output, true), "5 passed, 0 failed");
  });

  it("greps, edits exactly once and checks a migration", async () => {
    const fs = new ProjectFs(CALLBACK_TARGET.files);
    const tools = migrationTools(fs, runTests, () => ["src/lib/callbackUtils.js"]);
    assert.deepEqual(tools.map((t) => t.def.name), ["list_files", "read_file", "grep", "edit_file", "write_file", "run_checks"]);
    const grep = await runToolCall(tools, "grep", '{"pattern":"getUser("}');
    assert.match(grep.output, /src\/routes\/users\.js:6:/);
    const ambiguous = await runToolCall(tools, "edit_file", JSON.stringify({ path: "src/db/store.js", old_string: "later(", new_string: "soon(" }));
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.output, /matches 3 times/);
    const checks = await runToolCall(tools, "run_checks", "{}");
    assert.match(checks.output, /6 passed, 0 failed\nCallback-style code left \(2\):/);
    assert.match(resultSummary("run_checks", checks.output, true), /^6 passed, 0 failed; Callback-style code left \(2\)$/);
  });
});

describe("guards and traces", () => {
  const fn = (name: string, args: string, id: string) => ({ id, callId: id, name, arguments: args, done: true, kind: "function" as const });
  const model = (call: number, calls: ReturnType<typeof fn>[], text = "", usage = { input_tokens: 1000, output_tokens: 200, output_tokens_details: { reasoning_tokens: 150 }, total_tokens: 1200 }): ModelStep => ({
    kind: "model",
    call,
    body: {},
    collected: { ...collectReply("responses", { object: "response", status: "completed", output: [] }), text, toolCalls: calls, usage, done: true },
  });
  const tools = (calls: ReturnType<typeof fn>[], outputs: string[]): LoopStep => ({
    kind: "tools",
    results: calls.map((call, i) => ({ call, run: { ok: true, output: outputs[i], value: outputs[i], ms: 1 } })),
  });

  const read = fn("read_file", '{"path":"tests/test_pagination.js"}', "c1");
  const steps: LoopStep[] = [
    model(1, [read], "I'll start by reading the pagination test."),
    tools([read], ["line\nline\nline"]),
    model(2, [], "Fixed the off-by-one. Tests pass."),
  ];

  it("groups steps into turns with their tokens and thoughts", () => {
    const t = turnsOf(steps);
    assert.equal(t.length, 2);
    assert.equal(t[0].reasoningTokens, 150);
    assert.equal(t[0].thought, "I'll start by reading the pagination test.");
    assert.equal(t[0].calls[0].output, "line\nline\nline");
    assert.equal(t[1].final, true);
  });

  it("prints the basic loop's trace", () => {
    assert.equal(
      loopTrace(steps),
      [
        "[Turn 1] THINK: I'll start by reading the pagination test.",
        "         ACT:   read_file(tests/test_pagination.js)",
        "         RESULT: (file read, 3 lines)",
        "         EVAL:  continue",
        "",
        "[Turn 2] ANSWER: Fixed the off-by-one. Tests pass.",
        "         EVAL:  done",
      ].join("\n"),
    );
    assert.match(loopTrace(steps, "Stuck: x"), /\n\nSTOPPED: Stuck: x$/);
  });

  it("prints the interleaved trace with each turn's reasoning tokens", () => {
    assert.equal(
      interleavedTrace(steps),
      "◇ turn 1 · thought (150 tok): I'll start by reading the pagination test.\n     → read_file(tests/test_pagination.js)\n◇ turn 2 · thought (150 tok)\n     ✓ Fixed the off-by-one. Tests pass.",
    );
  });

  it("stops on a token budget and on the same call three times", () => {
    assert.equal(guardStop(steps, { tokenBudget: 10_000, repeats: 3 }), null);
    assert.match(guardStop(steps, { tokenBudget: 2_000 }) ?? "", /^Token budget spent: 2,400 of 2,000 tokens\.$/);
    const again = fn("read_file", '{ "path": "tests/test_pagination.js" }', "c2");
    const third = fn("read_file", '{"path":"tests/test_pagination.js"}', "c3");
    const stuck: LoopStep[] = [model(1, [read]), tools([read], ["x"]), model(2, [again]), tools([again], ["x"]), model(3, [third]), tools([third], ["x"])];
    assert.match(guardStop(stuck, { repeats: 3 }) ?? "", /^Stuck: read_file\(tests\/test_pagination\.js\) ran 3 times/);
    assert.equal(callKey("a", '{"x": 1}'), callKey("a", '{"x":1}'));
    assert.equal(shortCall("run_tests", "{}"), "run_tests()");
    assert.equal(shortCall("grep", '{"pattern":"onceShipped"}'), 'grep("onceShipped")');
  });
});

describe("the recipe catalog", () => {
  const all = RECIPE_SECTIONS.flatMap((s) => s.recipes);

  it("lists every recipe the cookbook page lists, each a real docs page", () => {
    const md = readFileSync(new URL("../../../../../content/meta-docs/pages/cookbook.md", import.meta.url), "utf8");
    const listed = [...md.matchAll(/\]\(https:\/\/dev\.meta\.ai\/docs\/(cookbook\/[a-z0-9-]+)\)/g)].map((m) => m[1]);
    assert.deepEqual(new Set(all.map((r) => r.slug)), new Set(listed));
    for (const r of all) assert.ok(docsPage(r.slug), `${r.slug} is a mirrored page`);
    assert.deepEqual(
      sectionsById(["api-fundamentals"])[0].recipes.map((r) => r.slug),
      [...readFileSync(new URL("../../../../../content/meta-docs/pages/cookbook/api-fundamentals.md", import.meta.url), "utf8").matchAll(/docs\/(cookbook\/[a-z0-9-]+)\)/g)].map((m) => m[1]),
      "the category page's order",
    );
  });

  it("makes every core call a request the docs proxy forwards, on a model it allows", () => {
    for (const r of all) {
      if (!r.call) {
        assert.ok(r.command && r.where, `${r.slug} says where it runs`);
        continue;
      }
      const c = r.call;
      assert.ok(isAllowedEndpoint("POST", c.path), `${r.slug}: POST ${c.path}`);
      const model = c.body?.model ?? (c.form ? JSON.parse(c.form.find((p) => p.name === "request")!.value!).model : null);
      const allowed: readonly string[] =
        c.path === "responses" ? DOCS_MODELS.responses : c.path === "asr/transcribe" ? DOCS_MODELS.voice : DOCS_MODELS.text;
      assert.ok(allowed.includes(model), `${r.slug}: ${model} on ${c.path}`);
      assert.notEqual(model, "muse-spark-1.3", "never the retired Spark");
      for (const f of c.fills ?? []) {
        assert.equal(jsonGet(c.body, f.pointer), "", `${r.slug}: ${f.pointer} is a placeholder`);
        assert.ok(sampleById(f.sampleId), `${r.slug}: sample ${f.sampleId}`);
      }
      for (const p of c.form ?? []) if (p.sampleId) assert.ok(sampleById(p.sampleId), `${r.slug}: sample ${p.sampleId}`);
      assert.ok(c.look.length > 20);
    }
  });

  it("has no em dashes and filters by every word", () => {
    assert.equal(JSON.stringify(RECIPE_SECTIONS).includes(String.fromCharCode(0x2014)), false);
    const found = filterRecipes(RECIPE_SECTIONS, "web search").flatMap((s) => s.recipes.map((r) => r.slug));
    assert.deepEqual(found, ["cookbook/search-grounding", "cookbook/search-grounded-image-generation"]);
    assert.deepEqual(filterRecipes(RECIPE_SECTIONS, "SLIDES").flatMap((s) => s.recipes.map((r) => r.slug)), ["cookbook/generating-slides"]);
    assert.equal(filterRecipes(RECIPE_SECTIONS, "zzz nothing").length, 0);
    assert.equal(findRecipe("cookbook/long-context")?.call?.path, "responses/input_tokens");
  });
});
