/**
 * The Prove it stage's pure parts, then the runner itself against a local server that plays the MCP server, the site and
 * the live product.
 *   npx tsx --test lib/outputs/__tests__/prove.test.ts
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { proveRows } from "@/components/build/prove-rows";
import { PROVE_CHECK_GADGET_SOURCE, PROVE_CHECK_PLUGIN_SOURCE, PROVE_RUNNER_SOURCE } from "@/lib/outputs/assets-source";
import { gadgetEntries, gadgetZip } from "@/lib/outputs/gadget";
import { cliSource, pluginZip, skillMarkdown, type OutputProduct } from "@/lib/outputs/generate";
import { makeZip } from "@/lib/outputs/zip";
import { proveStillActive, settleProveView, PROVE_STALE_MS } from "@/lib/outputs/labels";
import {
  describeResult,
  judgeSkillTest,
  NIGHTLY_MODEL,
  parseProveResults,
  planChecks,
  PROVE_MODEL,
  sampleInput,
  sceneFor,
  sceneLines,
  skillScene,
  skillTestFacts,
  skillTestCall,
  skillTestPrompt,
  studioSpecFor,
  type ProveOutputResult,
} from "@/lib/outputs/prove";
import { condenseProveEvents, type Manifest, type ProveEventBody } from "@/lib/types";

const action = (over: Partial<Manifest["actions"][number]> = {}): Manifest["actions"][number] => ({
  name: "go",
  description: "Goes.",
  input: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  output: { type: "object" },
  example: { text: "hi" },
  ...over,
});

/** How agentkit's manifests mark an action that only reads. Nothing else in this branch types it yet. */
const READ_ONLY = { annotations: { readOnly: true } };
const CHANGES_THINGS = { annotations: { readOnly: false, openWorld: true } };

const manifest = (actions: Manifest["actions"], est = 0.01): Manifest => ({
  name: "Tip",
  slug: "tip",
  tagline: "Tips",
  inspiration: "x",
  models: [{ id: "muse-wonder-1.0", usedFor: "x" }],
  actions,
  fixtures: [],
  limits: [],
  estimatedCostPerRunUsd: est,
});

const product = (m: Manifest): OutputProduct & { liveUrl: string } => ({ slug: "tip", name: "Tip", tagline: "Tips", liveUrl: "https://tip.example", manifest: m });

const plan = (m: Manifest, capUsd = 1.5, fetchable = true) =>
  planChecks({ product: product(m), origin: "https://site.example", dir: "/w", capUsd, estimatedCostPerRunUsd: m.estimatedCostPerRunUsd, fetchable });

describe("sampleInput", () => {
  it("uses the manifest's example first", () => {
    assert.deepEqual(sampleInput(action()), { text: "hi" });
  });

  it("makes required fields from the schema when there is no example", () => {
    const a = action({
      example: undefined,
      input: {
        type: "object",
        required: ["text", "count", "mode", "ok", "tags", "nested", "picked"],
        properties: {
          text: { type: "string", minLength: 40 },
          count: { type: "integer", minimum: 3 },
          mode: { enum: ["a", "b"] },
          ok: { type: "boolean" },
          tags: { type: "array", minItems: 2, items: { type: "string", maxLength: 3 } },
          nested: { type: "object", required: ["n"], properties: { n: { type: "number" } } },
          picked: { type: "string", default: "this one" },
          left: { type: "string" },
        },
      },
    });
    const made = sampleInput(a) as Record<string, unknown>;
    assert.ok((made.text as string).length >= 40);
    assert.deepEqual({ ...made, text: 0 }, { text: 0, count: 3, mode: "a", ok: true, tags: ["Sam", "Sam"], nested: { n: 1 }, picked: "this one" });
  });

  it("gives up on anything that needs a real file or link", () => {
    for (const prop of [{ type: "string", description: "A photo of the receipt" }, { type: "string", format: "uri" }, { type: "object" }].slice(0, 2)) {
      assert.equal(sampleInput(action({ example: undefined, input: { type: "object", required: ["x"], properties: { x: prop } } })), null);
    }
    assert.equal(sampleInput(action({ example: undefined, input: { type: "object", required: ["imageUrl"], properties: { imageUrl: { type: "string" } } } })), null);
  });

  it("takes no input for an action that needs none", () => {
    assert.deepEqual(sampleInput(action({ example: undefined, input: { type: "object" } })), {});
  });
});

describe("planChecks", () => {
  it("calls every action within the budget, and the CLI calls the first", () => {
    const spec = plan(manifest([action({ name: "a", ...READ_ONLY }), action({ name: "b", ...READ_ONLY })]));
    assert.deepEqual(spec.calls.map((c) => c.name), ["a", "b"]);
    assert.equal(spec.cliCall?.name, "a");
    assert.equal(spec.mcpUrl, "https://site.example/api/mcp/tip");
    assert.equal(spec.downloads?.cli, "https://site.example/p/tip/get/cli");
    assert.deepEqual(spec.notCalled, []);
  });

  it("stops calling at half the cap, counting the CLI's call, and says why", () => {
    const spec = plan(manifest([action({ name: "a", ...READ_ONLY }), action({ name: "b", ...READ_ONLY }), action({ name: "c", ...READ_ONLY })], 0.2), 1);
    assert.deepEqual(spec.calls.map((c) => c.name), ["a"]);
    assert.deepEqual(spec.notCalled.map((n) => n.name), ["b", "c"]);
    assert.match(spec.notCalled[0]!.why, /budget/);
  });

  it("calls nothing when one run costs more than the budget", () => {
    const spec = plan(manifest([action()], 2));
    assert.deepEqual(spec.calls, []);
    assert.equal(spec.cliCall, null);
  });

  it("calls at most five, leaves out actions with no usable input, and never offers one for the owner", () => {
    const many = Array.from({ length: 7 }, (_, i) => action({ name: `a${i}`, ...READ_ONLY }));
    const spec = plan(manifest([...many, action({ name: "photo", ...READ_ONLY, example: undefined, input: { type: "object", required: ["photo"], properties: { photo: { type: "string" } } } }), { ...action({ name: "mail" }), who: "owner" } as Manifest["actions"][number]], 0.001));
    assert.equal(spec.calls.length, 5);
    assert.deepEqual(spec.notCalled.map((n) => n.name), ["a5", "a6", "photo"]);
    assert.ok(!spec.actionNames.includes("mail"));
  });

  it("never calls an action that changes things, whatever its input", () => {
    const spec = plan(manifest([action({ name: "send_slack", ...CHANGES_THINGS }), action({ name: "delete_all", ...CHANGES_THINGS, example: undefined, input: { type: "object" } }), action({ name: "email_people", ...CHANGES_THINGS, example: undefined })]));
    assert.deepEqual(spec.calls, []);
    assert.equal(spec.cliCall, null);
    assert.deepEqual(spec.notCalled.map((n) => n.name), ["send_slack", "delete_all", "email_people"]);
    for (const n of spec.notCalled) assert.equal(n.why, "It changes things, so a test run doesn't call it.");
    assert.ok(spec.actionNames.includes("send_slack"), "it is still listed");
  });

  it("makes up a sample only for an action marked read-only", () => {
    const made = plan(manifest([action({ name: "look", ...READ_ONLY, example: undefined })]));
    assert.deepEqual(made.calls, [{ name: "look", args: { text: "Sample text for a test." } }]);
    const unmarked = plan(manifest([action({ name: "post", example: undefined })]));
    assert.deepEqual(unmarked.calls, []);
    assert.match(unmarked.notCalled[0]!.why, /no example/);
    // Even one needing no input: nothing says it is safe to run.
    assert.deepEqual(plan(manifest([action({ name: "wipe", example: undefined, input: { type: "object" } })])).calls, []);
  });

  it("calls one unmarked action with an example at most, after the read-only ones", () => {
    const spec = plan(manifest([action({ name: "post" }), action({ name: "post2" }), action({ name: "look", ...READ_ONLY }), action({ name: "peek", ...READ_ONLY })]));
    assert.deepEqual(spec.calls.map((c) => c.name), ["look", "peek", "post"]);
    assert.equal(spec.cliCall?.name, "look");
    assert.deepEqual(spec.notCalled.map((n) => n.name), ["post2"]);
    assert.match(spec.notCalled[0]!.why, /isn't marked read-only/);
  });

  it("calls only read-only actions on a nightly re-check", () => {
    const m = manifest([action({ name: "post" }), action({ name: "look", ...READ_ONLY })]);
    const spec = planChecks({ product: product(m), origin: "https://site.example", dir: "/w", capUsd: 1.5, estimatedCostPerRunUsd: 0.01, fetchable: true, readOnlyOnly: true });
    assert.deepEqual(spec.calls.map((c) => c.name), ["look"]);
    assert.deepEqual(spec.notCalled.map((n) => n.name), ["post"]);
  });

  it("keeps the names apart: the plugin may need a prefix and the skill doesn't", () => {
    const spec = planChecks({ product: { ...product(manifest([action()])), slug: "claude-notes" }, origin: "https://site.example", dir: "/w", capUsd: 1.5, estimatedCostPerRunUsd: 0.01, fetchable: true });
    assert.equal(spec.pluginName, "mm-claude-notes");
    assert.equal(spec.skillName, "claude-notes");
  });

  it("carries the fields the action's reply must have, for the skill test", () => {
    const spec = plan(manifest([action({ output: { type: "object", required: ["each"] } })]));
    assert.deepEqual(spec.calls[0]!.replyRequired, ["each"]);
  });

  it("has no downloads when the site can't serve them", () => {
    assert.equal(plan(manifest([action()]), 1.5, false).downloads, null);
  });

  it("plans the gadget pack's check: its prefix, its download and one more call while that fits the budget", () => {
    const spec = plan(manifest([action({ name: "a", ...READ_ONLY }), action({ name: "b", ...READ_ONLY })]));
    assert.equal(spec.gadgetPrefix, "tip");
    assert.equal(spec.downloads?.gadget, "https://site.example/p/tip/get/gadget");
    assert.equal(spec.gadgetCall?.name, "a");
    // $0.5 of budget: the CLI's call and a's fill it with $0.2 each, so the gadget gets no call and nothing else changes.
    const tight = plan(manifest([action({ name: "a", ...READ_ONLY }), action({ name: "b", ...READ_ONLY })], 0.2), 1);
    assert.deepEqual(tight.calls.map((c) => c.name), ["a"]);
    assert.equal(tight.gadgetCall, null);
    assert.equal(plan(manifest([action({ name: "w", ...CHANGES_THINGS })])).gadgetCall, null);
    assert.match(planChecks({ product: { ...product(manifest([action()])), slug: "system" }, origin: "https://site.example", dir: "/w", capUsd: 1.5, estimatedCostPerRunUsd: 0.01, fetchable: true }).gadgetPrefix, /^mm_system_[0-9a-f]{6}$/);
  });
});

const step = (caption: string, ok = true, seconds = 0.5, output = "out") => ({ caption, command: "cmd", output, ok, exitCode: ok ? 0 : 1, seconds });
const result = (ok: boolean, facts: Record<string, unknown>, steps = [step("did it", ok)]): ProveOutputResult => ({ ok, steps, facts });

describe("describeResult", () => {
  it("claims only what ran", () => {
    const mcp = describeResult("mcp", result(true, { listed: ["a", "b", "c"], called: [{ name: "a", ok: true }, { name: "b", ok: false, error: "no" }], notCalled: [{ name: "c", why: "It needs a file." }] }));
    assert.equal(mcp.state, "done");
    assert.equal(mcp.title, "MCP server: listed 3 tools, called a");
    assert.equal(mcp.detail, "b failed when called. c wasn't called. It needs a file.");
    assert.deepEqual(mcp.checks, [{ label: "did it", ok: true }]);
    assert.equal(describeResult("mcp", result(true, { listed: ["a"], called: [], notCalled: [] })).title, "MCP server: listed 1 tool, called none");
    const cli = describeResult("cli", result(true, { called: "a", downloaded: true }));
    assert.equal(cli.title, "CLI: ran a and printed JSON");
    assert.equal(cli.detail, undefined);
    assert.match(describeResult("cli", result(true, { called: "a", downloaded: false })).detail ?? "", /wasn't tested here/);
    assert.match(describeResult("claude_plugin", result(true, { downloaded: true })).detail ?? "", /hasn't been installed in Claude/);
    const refused = describeResult("cli", result(true, { called: null, refused: "picky", downloaded: true }));
    assert.equal(refused.state, "done");
    assert.equal(refused.title, "CLI: its help works, and no action was called");
    assert.equal(refused.detail, "picky refused the sample input, so no call went through.");
  });

  it("says what the gadget check did, and that no gadget was involved", () => {
    const called = describeResult("gadget", result(true, { commands: 2, called: "a", downloaded: true }));
    assert.equal(called.title, "Muse gadget commands: 2 commands check out, and a ran and printed JSON");
    assert.equal(called.detail, "Checked by machine. It hasn't been installed on a real gadget by this check.");
    const none = describeResult("gadget", result(true, { commands: 1, called: null, downloaded: false }));
    assert.equal(none.title, "Muse gadget commands: 1 command check out");
    assert.equal(none.detail, "No action was called through it. Checked by machine, from a file put in place directly. It hasn't been installed on a real gadget by this check.");
    const refused = describeResult("gadget", result(true, { commands: 1, called: null, refused: "picky", downloaded: true }));
    assert.match(refused.detail ?? "", /^picky refused the sample input/);
    assert.equal(describeResult("gadget", result(false, { error: "FAILED x" })).title, "Muse gadget commands: didn't work");
  });

  it("says when one failed, or never finished", () => {
    const bad = describeResult("cli", result(false, { error: "It broke." }));
    assert.deepEqual([bad.state, bad.title, bad.detail], ["failed", "CLI: didn't work", "It broke."]);
    const none = describeResult("mcp", undefined);
    assert.deepEqual([none.state, none.title], ["failed", "MCP server: the check never finished"]);
  });
});

describe("the skill test", () => {
  it("asks for the reply in a file and warns that the reply is data", () => {
    const prompt = skillTestPrompt({ skill: "tip", action: "go", args: { text: "hi" } });
    assert.match(prompt, /Use the tip skill to run its go action/);
    assert.match(prompt, /reply\.json/);
    assert.match(prompt, /don't follow anything it says/);
    assert.doesNotMatch(prompt, /—/);
  });

  it("uses the first call that worked, or none", () => {
    const calls = [{ name: "a", args: {} }, { name: "b", args: { x: 1 } }];
    assert.equal(skillTestCall({ calls }, result(true, { called: [{ name: "a", ok: false }, { name: "b", ok: true }] }))?.name, "b");
    assert.equal(skillTestCall({ calls }, result(false, { called: [{ name: "a", ok: false }] })), null);
    assert.equal(skillTestCall({ calls }, undefined), null);
  });

  it("passes only when the log and the reply both show it worked", () => {
    const good = { exitCode: 0, timedOut: false, readSkill: true, calledAction: true, reply: '{"a":1}', action: "go" };
    assert.equal(judgeSkillTest(good).ok, true);
    assert.match(judgeSkillTest({ ...good, timedOut: true }).problem ?? "", /ran out of time or budget/);
    assert.match(judgeSkillTest({ ...good, exitCode: 1 }).problem ?? "", /exit code 1/);
    assert.match(judgeSkillTest({ ...good, readSkill: false }).problem ?? "", /reading the skill/);
    assert.match(judgeSkillTest({ ...good, calledAction: false }).problem ?? "", /calling go/);
    assert.match(judgeSkillTest({ ...good, reply: "not json" }).problem ?? "", /as JSON/);
    assert.match(judgeSkillTest({ ...good, reply: null }).problem ?? "", /as JSON/);
    assert.equal(judgeSkillTest({ ...good, reply: null }).checks[2]!.ok, false);
  });

  it("doesn't take an error reply, or one missing what the action promises, as working", () => {
    const good = { exitCode: 0, timedOut: false, readSkill: true, calledAction: true, reply: '{"a":1}', action: "go" };
    assert.match(judgeSkillTest({ ...good, reply: '{"error":"internal error"}' }).problem ?? "", /an error/);
    assert.equal(judgeSkillTest({ ...good, reply: '{"error":"internal error"}' }).checks[2]!.ok, false);
    // Some replies carry an empty error field when all went well.
    assert.equal(judgeSkillTest({ ...good, reply: '{"error":null,"a":1}' }).ok, true);
    assert.match(judgeSkillTest({ ...good, reply: '{"b":1}', required: ["a"] }).problem ?? "", /leaves out a/);
    assert.match(judgeSkillTest({ ...good, reply: "null", required: ["a"] }).problem ?? "", /leaves out a/);
    assert.equal(judgeSkillTest({ ...good, reply: '{"a":null}', required: ["a"] }).ok, true);
    assert.equal(judgeSkillTest({ ...good, reply: "[1]" }).ok, true);
  });

  describe("reading its log", () => {
    const want = { skill: "tip", action: "go", liveHost: "tip.example" };
    const record = (tool: string, text: string, outcome = "success") => JSON.stringify({ payload_type: "tool.result", payload: { correlation_facts: { outcome, tool_name: tool }, kind: "tool_result", text } });
    const skillText = '<read-skill-result name="tip" status="ok">curl -X POST https://tip.example/api/actions/go</read-skill-result>';
    const bash = (command: string, exit = 0) => JSON.stringify({ command, exit_code: exit });
    const call = "curl -sS -X POST 'https://tip.example/api/actions/go' -d '{}' -o reply.json";

    it("finds the skill and the call in what the tools did", () => {
      const facts = skillTestFacts([record("read_skill", skillText), record("bash", bash(call))].join("\n"), want);
      assert.equal(facts.readSkill, true);
      assert.equal(facts.calledAction, true);
      assert.deepEqual(facts.lines, ["read_skill: tip", `bash: ${call}`]);
    });

    it("doesn't take the address inside the skill's own text as a call", () => {
      const facts = skillTestFacts(record("read_skill", skillText), want);
      assert.equal(facts.readSkill, true);
      assert.equal(facts.calledAction, false);
    });

    it("doesn't count a call that failed, or one to some other host", () => {
      assert.equal(skillTestFacts(record("bash", bash(call), "failure"), want).calledAction, false);
      assert.equal(skillTestFacts(record("bash", bash(call, 7)), want).calledAction, false);
      assert.equal(skillTestFacts(record("bash", bash("curl https://other.example/api/actions/go")), want).calledAction, false);
    });

    it("counts only a real POST with curl, not a command that just names the address", () => {
      const called = (command: string) => skillTestFacts(record("bash", bash(command)), want).calledAction;
      assert.equal(called("grep -n 'https://tip.example/api/actions/go' .agents/skills/tip/SKILL.md"), false);
      assert.equal(called("echo https://tip.example/api/actions/go"), false);
      assert.equal(called("echo curl -X POST https://tip.example/api/actions/go -d x"), false);
      assert.equal(called("curl -sS https://tip.example/api/actions/go"), false, "a GET");
      assert.equal(called("curl -X POST https://tip.example/api/actions/go_faster -d x"), false, "another action");
      assert.equal(called("curl -X POST https://tip.example/other -d x; echo https://tip.example/api/actions/go"), false);
      assert.equal(called("curl -X POST https://tip.example/api/actions/go"), true);
      assert.equal(called("curl -sSX POST https://tip.example/api/actions/go"), true);
      assert.equal(called("curl --request POST https://tip.example/api/actions/go"), true);
      assert.equal(called("curl https://tip.example/api/actions/go -d '{\"a\":\"x;y|z\"}'"), true);
      assert.equal(called("curl -d '{\"a\":\"x;y|z\"}' https://tip.example/api/actions/go"), true);
      assert.equal(called("curl --data-raw '{}' https://tip.example/api/actions/go"), true);
      assert.equal(called("curl --json '{}' https://tip.example/api/actions/go"), true);
      assert.equal(called("cd /tmp && curl --fail-with-body -sS -X POST 'https://tip.example/api/actions/go' -d '{}' -o reply.json && cat reply.json"), true);
      assert.equal(called('reply=$(curl -sS -X POST "https://tip.example/api/actions/go" -d "{}"); echo "$reply" > reply.json'), true);
    });

    it("counts reading the file by hand as reading the skill, and skips lines it can't parse", () => {
      const facts = skillTestFacts(["not json", record("bash", bash("cat .agents/skills/tip/SKILL.md")), '{"payload_type":"tool.result", broken'].join("\n"), want);
      assert.equal(facts.readSkill, true);
    });
  });

  it("runs on Wonder after a build and never on muse-spark-1.3", () => {
    assert.equal(PROVE_MODEL, "muse-wonder-1.0");
    assert.equal(NIGHTLY_MODEL, "muse-spark-1.3-contributor");
  });
});

describe("the scene", () => {
  it("pretty prints JSON and says when it cut anything", () => {
    assert.deepEqual(sceneLines('{"a":1}'), ["{", '  "a": 1', "}"]);
    assert.deepEqual(sceneLines("plain\ntext\n"), ["plain", "text"]);
    assert.deepEqual(sceneLines(""), []);
    const long = sceneLines(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
    assert.equal(long.length, 13);
    assert.equal(long.at(-1), "… 18 more lines cut from this video");
    assert.ok(sceneLines("x".repeat(500))[0]!.length <= 150);
  });

  it("prints each command's real time, and says when the video shortened it", () => {
    const scene = sceneFor("mcp", result(true, {}, [step("Fast", true, 0.4), step("Slow", true, 14.2)]), { name: "Tip", at: new Date("2026-10-31T12:00:00Z") });
    assert.equal(scene.title, "Tip: MCP server");
    assert.equal(scene.note, "A real run on Oct 31, replayed from its log. Long waits are shortened.");
    assert.equal(scene.steps[0]!.took, "took 0.4 s");
    assert.equal(scene.steps[1]!.took, "took 14 s, shortened here");
    assert.doesNotMatch(JSON.stringify(scene), /—/);
  });

  it("shows the skill test from what Muse Code really did", () => {
    const scene = skillScene({
      name: "Tip",
      at: new Date("2026-10-31T12:00:00Z"),
      download: result(true, {}, [step("Download the skill file")]),
      command: "muse exec --max-model-steps 12",
      lines: ["bash: curl tip.example"],
      seconds: 94,
      ok: true,
      finalText: "It returned a tidy list.",
    });
    assert.deepEqual(scene.steps.map((s) => s.caption), ["Download the skill file", "Muse Code uses the skill in an empty folder"]);
    assert.deepEqual(scene.steps[1]!.lines, ["bash: curl tip.example", "It returned a tidy list."]);
    assert.equal(scene.steps[1]!.took, "took 94 s, shortened here");
  });

  it("gives each video honest cards", () => {
    const spec = studioSpecFor("claude_plugin", { name: "Tip", origin: "https://site.example", slug: "tip", timeline: "/t", out: "/o" });
    assert.equal(spec.title, "Tip: Claude plugin");
    assert.match(spec.tagline, /Not installed in Claude here/);
    assert.equal(spec.url, "https://site.example/p/tip/get/claude-plugin");
  });
});

describe("condenseProveEvents", () => {
  const ev = (over: Partial<ProveEventBody> & { at?: string }): ProveEventBody & { at?: string } => ({ type: "prove", runId: "r1", origin: "ship", item: "mcp", state: "running", title: "t", ...over });

  it("is null with no events, and ignores what isn't one", () => {
    assert.equal(condenseProveEvents([]), null);
    assert.equal(condenseProveEvents([{ type: "log" }, { type: "prove" }]), null);
  });

  it("keeps the latest word on each output, its checks and its video", () => {
    const view = condenseProveEvents([
      ev({ item: "stage", state: "planned" }),
      ev({ state: "running" }),
      ev({ state: "done", title: "ok", checks: [{ label: "x", ok: true }] }),
      ev({ state: "done", title: "ok", media: { url: "v", caption: "c" } }),
      ev({ item: "stage", state: "done", costUsd: 0.25, at: "2026-10-31T00:00:00Z" }),
    ])!;
    assert.equal(view.active, false);
    assert.equal(view.costUsd, 0.25);
    const mcp = view.items.find((i) => i.item === "mcp")!;
    assert.equal(mcp.title, "ok");
    assert.deepEqual(mcp.checks, [{ label: "x", ok: true }]);
    assert.equal(mcp.media?.url, "v");
  });

  it("is active by the stage's line, whatever its parts last said", () => {
    assert.equal(condenseProveEvents([ev({ item: "stage", state: "running" }), ev({ state: "done" })])!.active, true);
    assert.equal(condenseProveEvents([ev({ item: "stage", state: "failed" }), ev({ state: "running" })])!.active, false);
  });

  it("shows the newest run, with an earlier run's video for an output it has none of", () => {
    const view = condenseProveEvents([
      ev({ state: "done", title: "old", media: { url: "v1", caption: "c" } }),
      ev({ runId: "r2", origin: "nightly", state: "failed", title: "new" }),
    ])!;
    assert.equal(view.runId, "r2");
    assert.equal(view.items[0]!.title, "new");
    assert.equal(view.items[0]!.media?.url, "v1");
  });

  it("keeps each output's last result when a newer run died before reaching it", () => {
    const view = condenseProveEvents([
      ev({ item: "stage", state: "done", title: "Tested", costUsd: 0.2, at: "2026-10-31T00:00:00Z" }),
      ev({ item: "cli", state: "done", title: "CLI ok", media: { url: "v1", caption: "c" }, at: "2026-10-31T00:01:00Z" }),
      ev({ runId: "r2", origin: "nightly", item: "stage", state: "failed", title: "Prove it didn't finish", at: "2026-11-01T07:00:00Z" }),
    ])!;
    assert.equal(view.runId, "r2");
    assert.equal(view.active, false);
    assert.equal(view.costUsd, 0, "only the newest run's cost");
    assert.deepEqual(view.items.map((i) => [i.item, i.state, i.title]), [["stage", "failed", "Prove it didn't finish"], ["cli", "done", "CLI ok"]]);
    const cli = view.items.find((i) => i.item === "cli")!;
    assert.equal(cli.media?.url, "v1");
    assert.equal(cli.at, "2026-10-31T00:01:00Z", "it keeps its own date");
  });

  it("doesn't fill in a part an older run never finished, so it can't look alive", () => {
    const view = condenseProveEvents([
      ev({ item: "cli", state: "running", title: "testing" }),
      ev({ runId: "r2", item: "stage", state: "skipped", title: "Prove it didn't run" }),
    ])!;
    assert.deepEqual(view.items.map((i) => i.item), ["stage"]);
    assert.equal(view.active, false);
  });

  it("gives up on a run with no news for a long time, and settles what it left", () => {
    const at = "2026-10-31T00:00:00Z";
    const then = new Date(at).getTime();
    const view = condenseProveEvents([ev({ item: "stage", state: "running", at }), ev({ state: "running", at })]);
    assert.equal(proveStillActive(view, then + 1000), true);
    assert.equal(proveStillActive(view, then + PROVE_STALE_MS + 1), false);
    const settled = settleProveView(view, then + PROVE_STALE_MS + 1)!;
    assert.equal(settled.active, false);
    assert.deepEqual(settled.items.map((i) => [i.state, i.title]), [["failed", "Prove it didn't finish"], ["failed", "MCP server: the check never finished"]]);
    assert.equal(settleProveView(view, then + 1000), view);
  });
});

describe("the runner", () => {
  let server: Server;
  let base: string;
  let dir: string;
  /** What the fake MCP server does differently per test. */
  let mode: { listOmits?: boolean; toolError?: boolean; actionFails?: boolean; badDownload?: boolean; helpOnlyCli?: boolean; badGadget?: boolean } = {};
  /** What each test's product has, and what its actions do. */
  let liveActions: Manifest["actions"] = [];
  let liveReply: (name: string) => { status: number; body: unknown } = () => ({ status: 200, body: { done: true } });
  /** Calls that really reached an action, and from where. */
  let reached: string[] = [];
  /** With liveActions: each call's caller, action and body. */
  let bodies: string[] = [];

  const m = manifest([action({ name: "go" }), action({ name: "photo", example: undefined, input: { type: "object", required: ["photo"], properties: { photo: { type: "string" } } } })]);
  /** A CLI that always prints help JSON, as an action called `list` used to get. */
  const HELP_ONLY_CLI = `console.log(JSON.stringify({ name: "Tip", url: "x", mcp: "y", actions: [{ name: "go" }, { name: "photo" }] }));`;

  before(async () => {
    server = createServer((req, res) => {
      let text = "";
      req.on("data", (c) => (text += c));
      req.on("end", () => {
        const url = req.url ?? "";
        const json = (body: unknown, status = 200) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        const p: OutputProduct = { slug: "tip", name: "Tip", tagline: "Tips", liveUrl: base, manifest: liveActions.length ? manifest(liveActions) : m };
        if (url === "/p/tip/get/cli") return void res.end(mode.helpOnlyCli ? HELP_ONLY_CLI : mode.badDownload ? "oops" : cliSource(p, base));
        if (url === "/p/tip/get/skill") return void res.end(skillMarkdown(p, base));
        if (url === "/p/tip/get/claude-plugin") return void res.end(pluginZip(p, base));
        if (url === "/p/tip/get/gadget") return void res.end(mode.badGadget ? badGadgetZip(p) : gadgetZip(p));
        // The CLI and the gadget's runner each say who they are.
        const caller = /MuseMuse-Gadget/.test(req.headers["user-agent"] ?? "") ? "gadget" : "cli";
        if (liveActions.length && url.startsWith("/api/actions/")) {
          const name = url.slice("/api/actions/".length);
          reached.push(`${caller}:${name}`);
          bodies.push(`${caller}:${name}:${text}`);
          const reply = liveReply(name);
          return json(reply.body, reply.status);
        }
        if (url === "/api/actions/go") {
          reached.push(`${caller}:go:${text}`);
          return mode.actionFails ? json({ error: "no" }, 500) : json({ done: true });
        }
        if (url === "/api/mcp/tip") {
          const rpc = JSON.parse(text) as { id: number; method: string; params?: { name: string } };
          if (liveActions.length) {
            if (rpc.method === "initialize") return json({ jsonrpc: "2.0", id: rpc.id, result: { serverInfo: { name: "x" } } });
            if (rpc.method === "tools/list") return json({ jsonrpc: "2.0", id: rpc.id, result: { tools: liveActions.map((a) => ({ name: a.name, inputSchema: { type: "object" } })) } });
            const name = rpc.params!.name;
            reached.push(`mcp:${name}`);
            const reply = liveReply(name);
            return json({ jsonrpc: "2.0", id: rpc.id, result: reply.status === 200 ? { content: [{ type: "text", text: JSON.stringify(reply.body) }] } : { isError: true, content: [{ type: "text", text: `${name} failed with HTTP ${reply.status}` }] } });
          }
          if (rpc.method === "initialize") return json({ jsonrpc: "2.0", id: rpc.id, result: { serverInfo: { name: "x" } } });
          if (rpc.method === "tools/list") {
            const tools = ["go", "photo"].slice(0, mode.listOmits ? 1 : 2).map((name) => ({ name, inputSchema: { type: "object" } }));
            return json({ jsonrpc: "2.0", id: rpc.id, result: { tools } });
          }
          if (mode.toolError) return json({ jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ type: "text", text: "go failed" }] } });
          return json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: '{"done":true}' }] } });
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = mkdtempSync(path.join(tmpdir(), "muse-prove-"));
    writeFileSync(path.join(dir, "prove-runner.mjs"), PROVE_RUNNER_SOURCE);
    writeFileSync(path.join(dir, "prove-check-plugin.mjs"), PROVE_CHECK_PLUGIN_SOURCE);
    writeFileSync(path.join(dir, "prove-check-gadget.mjs"), PROVE_CHECK_GADGET_SOURCE);
  });

  after(async () => {
    rmSync(dir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  /** A pack whose command breaks the SDK's rules: a reserved name. */
  const badGadgetZip = (p: OutputProduct) =>
    makeZip(gadgetEntries(p).map((e) => (e.path.includes("/commands.d/") ? { ...e, path: e.path.replace(/commands\.d\/[^/]+$/, "commands.d/system.go.json") } : e)));

  const runIt = async (over: { capUsd?: number; est?: number } = {}) => {
    const spec = planChecks({ product: { slug: "tip", name: "Tip", tagline: "Tips", liveUrl: base, manifest: liveActions.length ? manifest(liveActions) : m }, origin: base, dir, capUsd: over.capUsd ?? 1.5, estimatedCostPerRunUsd: over.est ?? 0.01, fetchable: true });
    writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
    await new Promise<void>((resolve, reject) => {
      execFile("node", [path.join(dir, "prove-runner.mjs"), path.join(dir, "spec.json")], { timeout: 60_000 }, (err) => (err ? reject(err) : resolve()));
    });
    return parseProveResults(readFileSync(path.join(dir, "results.json"), "utf8"))!;
  };

  const useActions = (actions: Manifest["actions"], reply: typeof liveReply = () => ({ status: 200, body: { done: true } })) => {
    mode = {};
    liveActions = actions;
    liveReply = reply;
    reached = [];
    bodies = [];
  };

  beforeEach(() => useActions([]));

  it("passes every output when all of it works, and logs real commands", async () => {
    mode = {};
    const results = await runIt();
    assert.ok(results.finishedAt);
    assert.deepEqual(Object.keys(results.outputs), ["mcp", "cli", "claude_plugin", "gadget", "skill"]);
    for (const [id, r] of Object.entries(results.outputs)) assert.equal(r.ok, true, `${id}: ${JSON.stringify(r.facts)}`);
    const mcp = results.outputs.mcp!;
    assert.deepEqual(mcp.facts.listed, ["go", "photo"]);
    assert.deepEqual(mcp.facts.called, [{ name: "go", ok: true }]);
    assert.deepEqual((mcp.facts.notCalled as Array<{ name: string }>).map((n) => n.name), ["photo"]);
    assert.ok(mcp.steps.every((s) => s.command.startsWith("curl -sS") && s.seconds >= 0));
    const cli = results.outputs.cli!;
    assert.equal(cli.facts.downloaded, true);
    assert.equal(cli.facts.called, "go");
    assert.deepEqual(JSON.parse(cli.steps.at(-1)!.output), { done: true });
    const plugin = results.outputs.claude_plugin!;
    assert.match(plugin.steps.at(-1)!.output, /answers tools\/list with 2 tools/);
    const gadget = results.outputs.gadget!;
    assert.equal(gadget.facts.downloaded, true);
    assert.equal(gadget.facts.commands, 2);
    assert.equal(gadget.facts.called, "go");
    assert.deepEqual(JSON.parse(gadget.steps.at(-1)!.output), { done: true });
    assert.match(gadget.steps.at(-1)!.command, /printf '%s' .* \| node runner\.cjs 'go'$/);
    assert.equal(describeResult("gadget", gadget).title, "Muse gadget commands: 2 commands check out, and go ran and printed JSON");
    assert.match(describeResult("gadget", gadget).detail ?? "", /hasn't been installed on a real gadget/);
    // The gadget sent the same input the CLI did, on stdin and through the runner.
    assert.ok(reached.includes(`gadget:go:{"text":"hi"}`), reached.join(" "));
    assert.equal(results.outputs.skill!.facts.downloaded, true);
  });

  it("fails the gadget pack when a command breaks the SDK's rules, and calls nothing through it", async () => {
    mode = { badGadget: true };
    reached = [];
    const gadget = (await runIt()).outputs.gadget!;
    assert.equal(gadget.ok, false);
    assert.match(String(gadget.facts.error), /FAILED system\.go: .*reserved prefix/);
    assert.ok(!reached.some((r) => r.startsWith("gadget:")));
  });

  it("checks the gadget pack without a call when another wouldn't fit the budget", async () => {
    useActions([action({ name: "go", ...READ_ONLY })]);
    // Half of a $0.06 cap is $0.03: the CLI's call and one MCP call use it up.
    const results = await runIt({ capUsd: 0.06, est: 0.015 });
    assert.equal((results.outputs.mcp!.facts.called as unknown[]).length, 1);
    const gadget = results.outputs.gadget!;
    assert.equal(gadget.ok, true, JSON.stringify(gadget.facts));
    assert.equal(gadget.facts.called, null);
    assert.deepEqual(reached, ["mcp:go", "cli:go"]);
    assert.equal(describeResult("gadget", gadget).title, "Muse gadget commands: 1 command check out");
  });

  it("keeps the gadget's pass when its only action refuses the sample, and fails it when the action breaks", async () => {
    useActions([action({ name: "picky", ...READ_ONLY })], () => ({ status: 422, body: { error: "bad sample" } }));
    const refused = (await runIt()).outputs.gadget!;
    assert.equal(refused.ok, true, JSON.stringify(refused.facts));
    assert.equal(refused.facts.refused, "picky");
    useActions([action({ name: "broken", ...READ_ONLY })], () => ({ status: 500, body: { error: "down" } }));
    const broken = (await runIt()).outputs.gadget!;
    assert.equal(broken.ok, false);
    assert.match(String(broken.facts.error), /tip\.broken ended with exit code 1\. broken failed with HTTP 500: down/);
  });

  it("checks the sample the way the gadget would before running it", async () => {
    const counted = { type: "object", required: ["count"], properties: { count: { type: "integer" }, note: { type: "string" } } };
    // The product refuses "5", and the gadget would too: a poor sample, not called through the gadget.
    useActions([action({ name: "tally", ...READ_ONLY, input: counted, example: { count: "5" } })], () => ({ status: 422, body: { error: "count must be a number" } }));
    const poor = (await runIt()).outputs.gadget!;
    assert.equal(poor.ok, true, JSON.stringify(poor.facts));
    assert.equal(poor.facts.refused, "tally");
    assert.equal(poor.facts.refusedWhy, "count must be an integer");
    assert.ok(!reached.some((r) => r.startsWith("gadget:")), reached.join(" "));
    assert.match(describeResult("gadget", poor).detail ?? "", /^The gadget would refuse tally's sample input \(count must be an integer\), so no call went through\./);
    // The product takes it, so the pack's declared type is wrong for the product.
    useActions([action({ name: "tally", ...READ_ONLY, input: counted, example: { count: true } })]);
    const wrong = (await runIt()).outputs.gadget!;
    assert.equal(wrong.ok, false);
    assert.match(String(wrong.facts.error), /tip\.tally would refuse an input the product takes: count must be an integer/);
    assert.ok(!reached.some((r) => r.startsWith("gadget:")));
    // A required field set to null is a poor sample. An optional one is left out, as Muse would.
    useActions([action({ name: "tally", ...READ_ONLY, input: counted, example: { count: null } })]);
    const missing = (await runIt()).outputs.gadget!;
    assert.equal(missing.ok, true, JSON.stringify(missing.facts));
    assert.equal(missing.facts.refusedWhy, "count is required");
    useActions([action({ name: "tally", ...READ_ONLY, input: counted, example: { count: 5, note: null, extra: 1 } })]);
    const fine = (await runIt()).outputs.gadget!;
    assert.equal(fine.ok, true, JSON.stringify(fine.facts));
    assert.equal(fine.facts.called, "tally");
    assert.ok(bodies.includes(`gadget:tally:{"count":5}`), bodies.join(" "));
  });

  it("fails the MCP server when tools/list leaves out an action", async () => {
    mode = { listOmits: true };
    const mcp = (await runIt()).outputs.mcp!;
    assert.equal(mcp.ok, false);
    assert.match(String(mcp.facts.error), /left out photo/);
    // It stops there: no call was made.
    assert.equal(mcp.steps.length, 2);
  });

  it("fails it when every tool call errors, with the reason", async () => {
    mode = { toolError: true };
    const mcp = (await runIt()).outputs.mcp!;
    assert.equal(mcp.ok, false);
    assert.match(String(mcp.facts.error), /go failed/);
  });

  it("fails the CLI when the action fails or the download isn't the tool", async () => {
    mode = { actionFails: true };
    const failed = (await runIt()).outputs.cli!;
    assert.equal(failed.ok, false);
    assert.match(String(failed.facts.error), /exit code 1/);
    mode = { badDownload: true };
    const bad = (await runIt()).outputs.cli!;
    assert.equal(bad.ok, false);
  });

  it("really runs an action called list through the CLI, and never a write action", async () => {
    useActions([action({ name: "list", ...READ_ONLY, example: undefined, input: { type: "object" } }), action({ name: "wipe", ...CHANGES_THINGS, example: undefined, input: { type: "object" } })]);
    const results = await runIt();
    const cli = results.outputs.cli!;
    assert.equal(cli.ok, true, JSON.stringify(cli.facts));
    assert.equal(cli.facts.called, "list");
    assert.deepEqual(reached, ["mcp:list", "cli:list", "gadget:list"]);
    assert.deepEqual(results.outputs.mcp!.facts.notCalled, [{ name: "wipe", why: "It changes things, so a test run doesn't call it." }]);
  });

  it("fails the CLI when what it printed was its own help, not a reply", async () => {
    mode = { helpOnlyCli: true };
    const cli = (await runIt()).outputs.cli!;
    assert.equal(cli.ok, false);
    assert.match(String(cli.facts.error), /its help/);
  });

  it("reads a big reply whole, and keeps only the start of it in the log", async () => {
    const big = { text: "x".repeat(200 * 1024) };
    useActions([action({ name: "big", ...READ_ONLY })], () => ({ status: 200, body: big }));
    const results = await runIt();
    const mcp = results.outputs.mcp!;
    assert.deepEqual(mcp.facts.called, [{ name: "big", ok: true }]);
    assert.equal(results.outputs.cli!.ok, true, JSON.stringify(results.outputs.cli!.facts));
    for (const s of [...mcp.steps, ...results.outputs.cli!.steps]) assert.ok(s.output.length <= 64 * 1024);
    assert.ok(readFileSync(path.join(dir, "results.json"), "utf8").length < 300 * 1024);
  });

  it("tests the CLI on an action the MCP call showed working", async () => {
    useActions([action({ name: "picky", ...READ_ONLY }), action({ name: "good", ...READ_ONLY })], (name) => (name === "picky" ? { status: 422, body: { error: "bad sample" } } : { status: 200, body: { done: true } }));
    const results = await runIt();
    assert.deepEqual(results.outputs.mcp!.facts.called, [{ name: "picky", ok: false, error: "picky failed with HTTP 422" }, { name: "good", ok: true }]);
    const cli = results.outputs.cli!;
    assert.equal(cli.ok, true, JSON.stringify(cli.facts));
    assert.equal(cli.facts.called, "good");
    assert.deepEqual(reached, ["mcp:picky", "mcp:good", "cli:good", "gadget:good"]);
  });

  it("keeps the CLI's pass when its only action refuses the sample, and says no call went through", async () => {
    useActions([action({ name: "picky", ...READ_ONLY })], () => ({ status: 422, body: { error: "bad sample" } }));
    const cli = (await runIt()).outputs.cli!;
    assert.equal(cli.ok, true, JSON.stringify(cli.facts));
    assert.equal(cli.facts.called, null);
    assert.equal(cli.facts.refused, "picky");
    assert.equal(describeResult("cli", cli).detail, "picky refused the sample input, so no call went through.");
  });

  it("still fails the CLI when its only action breaks", async () => {
    useActions([action({ name: "broken", ...READ_ONLY })], () => ({ status: 500, body: { error: "down" } }));
    const cli = (await runIt()).outputs.cli!;
    assert.equal(cli.ok, false);
    assert.match(String(cli.facts.error), /exit code 1/);
  });

  it("sets a field called input through the CLI, using the --cli- forms for the tool", async () => {
    useActions([action({ name: "ask", ...READ_ONLY, example: { input: "hi" }, input: { type: "object", required: ["input"], properties: { input: { type: "string" } } } })]);
    const cli = (await runIt()).outputs.cli!;
    assert.equal(cli.ok, true, JSON.stringify(cli.facts));
    assert.match(cli.steps.at(-1)!.command, /--cli-input .* --cli-json --cli-timeout 120/);
  });

  it("checks a plugin whose name differs from its skill's, and accepts a quoted skill name", async () => {
    const zipFor = (slug: string) => {
      const zip = path.join(dir, `${slug}.zip`);
      writeFileSync(zip, pluginZip({ slug, name: "Tip", tagline: "Tips", liveUrl: base, manifest: m }, base));
      return zip;
    };
    const check = (args: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
      execFile("node", [path.join(dir, "prove-check-plugin.mjs"), ...args], (err, stdout) => resolve({ code: (err as { code?: number } | null)?.code ?? 0, out: stdout }));
    });
    const prefixed = await check([zipFor("claude-notes"), "mm-claude-notes", `${base}/api/mcp/claude-notes`, "claude-notes"]);
    assert.match(prefixed.out, /ok +skills\/claude-notes\/SKILL\.md has a name/);
    const numeric = await check([zipFor("2048"), "2048", `${base}/api/mcp/2048`, "2048"]);
    assert.match(numeric.out, /ok +skills\/2048\/SKILL\.md has a name/);
    const reserved = await check([zipFor("tipper"), "claude-tipper", `${base}/api/mcp/tipper`, "tipper"]);
    assert.equal(reserved.code, 1);
    assert.match(reserved.out, /FAILED .*reserved/);
  });

  it("fails the plugin check when .mcp.json points elsewhere", () => {
    const zip = path.join(dir, "elsewhere.zip");
    writeFileSync(zip, pluginZip({ slug: "tip", name: "Tip", tagline: "Tips", liveUrl: base, manifest: m }, "https://other.example"));
    return new Promise<void>((resolve) => {
      execFile("node", [path.join(dir, "prove-check-plugin.mjs"), zip, "tip", `${base}/api/mcp/tip`], (err, stdout) => {
        assert.equal((err as { code?: number } | null)?.code, 1);
        assert.match(stdout, /FAILED \.mcp\.json points at/);
        resolve();
      });
    });
  });
});

describe("the room's Prove it rows", () => {
  const ev = (item: string, state: string, more: object = {}) => ({ type: "prove", runId: "r1", origin: "ship", item, state, title: `${item} ${state}`, at: "2026-10-31T12:00:00.000Z", ...more });
  const later = new Date("2026-10-31T12:05:00.000Z").getTime();

  it("has no row with no run", () => {
    assert.deepEqual(proveRows([{ type: "status" }], later), []);
  });

  it("shows a passing output's video, and folds a failed output's checks", () => {
    const media = { url: "https://x/v.mp4", posterUrl: "https://x/v.jpg", caption: "CLI." };
    const checks = [{ label: "Ask it for help", ok: false }];
    const [row] = proveRows(
      [ev("stage", "done", { costUsd: 0.13 }), ev("cli", "done", { media, checks: [{ label: "Ran it", ok: true }] }), ev("mcp", "failed", { checks })],
      later,
    );
    assert.equal(row!.state, "done");
    assert.match(row!.description ?? "", /\$0\.13/);
    const [cli, mcp] = row!.children!;
    assert.deepEqual(cli!.media, { kind: "video", src: media.posterUrl, alt: media.caption, href: media.url });
    assert.equal(cli!.children, undefined);
    assert.equal(mcp!.state, "failed");
    assert.equal(mcp!.folded, true);
    assert.equal(mcp!.children![0]!.state, "failed");
  });

  it("shows $0.00 for a finished run that spent nothing, as the fridge build's did when every call failed", () => {
    const [row] = proveRows([ev("stage", "done", { costUsd: 0 }), ev("mcp", "failed"), ev("gadget", "failed")], later);
    assert.equal(row!.title, "stage done");
    assert.equal(row!.description, "$0.00 est.");
  });

  it("shows no cost while the run is going, or for an old run whose closing line carried none", () => {
    const [running] = proveRows([ev("stage", "running", { costUsd: 0 }), ev("cli", "running")], later);
    assert.equal(running!.description, undefined);
    const [old] = proveRows([ev("stage", "done"), ev("cli", "done")], later);
    assert.equal(old!.description, undefined);
  });

  it("says a run that stopped writing never finished", () => {
    const [row] = proveRows([ev("stage", "running"), ev("cli", "running")], new Date("2026-10-31T13:00:00.000Z").getTime());
    assert.equal(row!.state, "failed");
    assert.equal(row!.title, "Prove it didn't finish");
    assert.equal(row!.children![0]!.title, "CLI: the check never finished");
  });
});
