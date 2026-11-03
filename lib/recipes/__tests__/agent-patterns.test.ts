import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import vm from "node:vm";
import { recipeExtraFiles } from "@/lib/recipes/registry";
import { digestOf, makeAlertFeed, makeAlerts, numberCheck, parseAlertFeed, unknownIds, type FeedOptions } from "../skills/recipe-agent-patterns/helpers/alert-feed";
import { unifiedDiff } from "../skills/recipe-agent-patterns/helpers/diff";
import { applyEdit, jsSyntaxProblem } from "../skills/recipe-agent-patterns/helpers/edits";
import { ApprovalScope, byteCount, decide, digestOf as sha, ledgerLeaks, ledgerRow, outboundProblem } from "../skills/recipe-agent-patterns/helpers/egress-gate";
import { guardStop, isEmptyTurn, outcome, runTotals, traceText, type LoopTurn } from "../skills/recipe-agent-patterns/helpers/loop-guards";
import { allGreen, RUNNER_SOURCE, type TestReport } from "../skills/recipe-agent-patterns/helpers/test-worker";

const ID = "recipe-agent-patterns";
const SKILL = readFileSync(join(import.meta.dirname, "..", "skills", ID, "SKILL.md"), "utf8");

type Suite = (files: Record<string, string>, only: string | null, perTestMs: number) => Promise<TestReport>;
const runSuite = vm.runInNewContext(`${RUNNER_SOURCE}\n;runSuite`, { setTimeout, clearTimeout }) as Suite;

const OPTS: FeedOptions = {
  components: ["Ovens", "Tills", "Delivery", "Loyalty", "Menu", "Printers", "Wifi"].map((name) => ({ name, recurring: `${name} check failing`, oneOff: [`${name} restarted`, `${name} config changed`] as [string, string] })),
  owners: ["rina", "tomas", "ade", "lu"],
  domain: "crumbco.example",
};

beforeEach(() => {
  for (const flag of ["RECIPES_ENABLED", "AGENT_LONG_RUNS"]) delete process.env[flag];
});

describe("recipe-agent-patterns reaches the build", () => {
  it("ships the skill and every helper with recipes on", () => {
    process.env.RECIPES_ENABLED = "1";
    const paths = recipeExtraFiles({ recipes: [ID] }).map((f) => f.path);
    for (const f of ["SKILL.md", "helpers/test-worker.ts", "helpers/edits.ts", "helpers/diff.ts", "helpers/loop-guards.ts", "helpers/alert-feed.ts", "helpers/egress-gate.ts"]) {
      assert.ok(paths.includes(`.agents/skills/${ID}/${f}`), f);
    }
  });

  it("keeps the rules the audits asked for", () => {
    assert.match(SKILL, /Never 9 clean lines/);
    assert.match(SKILL, /Never trust the model's "done"/);
    assert.match(SKILL, /never holds the question or the answer/);
    assert.match(SKILL, /hidden instruction/);
    assert.match(SKILL, /anchor appears twice/);
  });
});

describe("test worker runner", () => {
  const files = {
    "src/fees.js": "exports.lateFee = (days) => (days > 3 ? (days - 3) * 0.25 : 0);",
    "tests/fees.test.js": "const assert = require('assert'); const { lateFee } = require('../src/fees');\ntest('none on day 3', () => assert.strictEqual(lateFee(3), 0));\ntest('a quarter a day after', () => assert.strictEqual(lateFee(5), 0.5));",
  };

  it("runs a green suite", async () => {
    const report = await runSuite(files, null, 1000);
    assert.equal(report.passed, 2);
    assert.ok(allGreen(report));
  });

  it("reports a planted bug as a failure, not a pass", async () => {
    const report = await runSuite({ ...files, "src/fees.js": "exports.lateFee = (days) => (days > 3 ? (days - 2) * 0.25 : 0);" }, null, 1000);
    assert.equal(report.failed, 1);
    assert.ok(!allGreen(report));
  });
});

describe("exact-once edits", () => {
  const files = { "a.js": "const x = 1;\nfunction f() { return 1; }\nfunction g() { return 1; }\n" };
  it("applies one match, rejects zero and two", () => {
    assert.ok(applyEdit(files, { tool: "edit", filePath: "a.js", oldString: "const x = 1;", newString: "const x = 2;" }).ok);
    const none = applyEdit(files, { tool: "edit", filePath: "a.js", oldString: "const  x = 1;", newString: "y" });
    assert.ok(!none.ok && none.problem === "no_match");
    const two = applyEdit(files, { tool: "edit", filePath: "a.js", oldString: "return 1;", newString: "return 2;" });
    assert.ok(!two.ok && two.problem === "ambiguous");
  });
  it("finds a broken edit without running it, and diffs", () => {
    assert.equal(jsSyntaxProblem("module.exports = 1;"), null);
    assert.match(jsSyntaxProblem("function (") ?? "", /SyntaxError/);
    assert.match(unifiedDiff("a.js", "a\nb\n", "a\nc\n"), /-b\n\+c/);
  });
});

describe("loop guards", () => {
  const call = (name: string, args: unknown, tokens = 100): LoopTurn => ({ turn: 0, tokens, call: { name, arguments: JSON.stringify(args) }, result: "ok" });
  const guards = { maxTurns: 5, tokenBudget: 1000, repeatLimit: 3 };

  it("stops on a repeated call, in any key order", () => {
    const turns = [call("read_file", { path: "a", n: 1 }), call("read_file", { n: 1, path: "a" }), call("read_file", { path: "a", n: 1 })];
    assert.equal(guardStop(turns, guards)?.kind, "stuck");
  });
  it("stops at the cap and the budget, and continues otherwise", () => {
    assert.equal(guardStop([call("a", 1), call("b", 2)], guards), null);
    assert.equal(guardStop([1, 2, 3, 4, 5].map((n) => call("t", n)), guards)?.kind, "turn_cap");
    assert.equal(guardStop([call("a", 1, 600), call("b", 2, 600)], guards)?.kind, "token_budget");
    assert.equal(guardStop([], guards, true)?.kind, "cancelled");
  });
  it("counts done as success only with green tests", () => {
    const stop = guardStop([{ turn: 1, tokens: 10, call: null, answer: "Fixed the off-by-one." }], guards)!;
    assert.equal(stop.kind, "done");
    assert.ok(outcome(stop, true).success);
    assert.ok(!outcome(stop, false).success);
    assert.equal(guardStop([{ turn: 1, tokens: 10, call: null, answer: "I can't fix this without the API docs." }], guards)?.kind, "gave_up");
  });
  it("traces each turn and spots an empty one", () => {
    const turns: LoopTurn[] = [{ ...call("read_file", { path: "tests/a.js" }), turn: 1, think: "Read the test first.", reasoningTokens: 40 }];
    const text = traceText(turns, null);
    assert.match(text, /\[Turn 1\] THINK \(40 tok\): Read the test first\./);
    assert.match(text, /ACT: {3}read_file/);
    assert.ok(isEmptyTurn([{ type: "message", content: [{ text: " " }] }]));
    assert.ok(!isEmptyTurn([{ type: "function_call" }]));
    assert.deepEqual(runTotals(turns), { turns: 1, toolCalls: 1, reasoningTokens: 40, totalTokens: 100 });
  });
});

describe("alert feed", () => {
  it("bakes the known counts", () => {
    const d = digestOf(makeAlerts(OPTS));
    assert.deepEqual([d.total, d.recurring, d.silenced, d.night, d.owners[0]], [42, 28, 3, 28, ["rina", 31]]);
    assert.ok(d.components.every(([, n]) => n === 6));
  });
  it("is noisy, and the parser drops and reports the noise", () => {
    const parsed = parseAlertFeed(makeAlertFeed(OPTS));
    assert.equal(parsed.rows.length, 42);
    assert.equal(parsed.duplicates.length, 4);
    assert.equal(parsed.skipped.length, 1);
    assert.ok(parsed.reordered);
    assert.equal(digestOf(parsed.rows).recurring, 28);
  });
  it("rejects invented ids and flags invented numbers", () => {
    const rows = makeAlerts(OPTS);
    assert.deepEqual(unknownIds(["ALR-1000", "ALR-9999"], rows), ["ALR-9999"]);
    const check = numberCheck("28 of 42 recur (66.7%) and ALR-1004 fires at 02:30, but 35 are at night.", digestOf(rows));
    assert.deepEqual(check.filter((c) => !c.grounded).map((c) => c.text), ["35"]);
  });
});

describe("egress gate", () => {
  it("sends only the approved text", async () => {
    const text = "How does a 30 day notice period usually work for a flat lease?";
    const digest = await sha(text);
    assert.equal(await outboundProblem(text, digest), null);
    assert.match((await outboundProblem(`${text} Also my notes.`, digest)) ?? "", /isn't the one you approved/);
    assert.equal(byteCount("é"), 2);
  });
  it("scopes approvals to one text and treats no answer as a denial", async () => {
    const scope = new ApprovalScope();
    scope.record("aaa", "session");
    assert.ok(scope.isPreApproved("aaa") && !scope.isPreApproved("bbb"));
    assert.deepEqual(await decide(() => new Promise(() => {}), 20), { choice: "deny", outcome: "timeout" });
    assert.equal((await decide(() => Promise.reject(new Error("x")), 1000)).outcome, "gate error");
  });
  it("keeps content out of the ledger", async () => {
    const question = "What is the usual grace period for rent in a made-up town?";
    const row = await ledgerRow({ text: question, event: "sent", model: "muse-wonder-1.0", ms: 812.4, reply: "About five days." });
    assert.equal(row.digest.length, 16);
    assert.deepEqual(ledgerLeaks([row], [question, "About five days."]), []);
  });
});
