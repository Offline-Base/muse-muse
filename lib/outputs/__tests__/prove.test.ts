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
import { after, before, describe, it } from "node:test";
import { proveRows } from "@/components/build/prove-rows";
import { PROVE_CHECK_PLUGIN_SOURCE, PROVE_RUNNER_SOURCE } from "@/lib/outputs/assets-source";
import { cliSource, pluginZip, skillMarkdown, type OutputProduct } from "@/lib/outputs/generate";
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
    const spec = plan(manifest([action({ name: "a" }), action({ name: "b" })]));
    assert.deepEqual(spec.calls.map((c) => c.name), ["a", "b"]);
    assert.equal(spec.cliCall?.name, "a");
    assert.equal(spec.mcpUrl, "https://site.example/api/mcp/tip");
    assert.equal(spec.downloads?.cli, "https://site.example/p/tip/get/cli");
    assert.deepEqual(spec.notCalled, []);
  });

  it("stops calling at half the cap, counting the CLI's call, and says why", () => {
    const spec = plan(manifest([action({ name: "a" }), action({ name: "b" }), action({ name: "c" })], 0.2), 1);
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
    const many = Array.from({ length: 7 }, (_, i) => action({ name: `a${i}` }));
    const spec = plan(manifest([...many, action({ name: "photo", example: undefined, input: { type: "object", required: ["photo"], properties: { photo: { type: "string" } } } }), { ...action({ name: "mail" }), who: "owner" } as Manifest["actions"][number]], 0.001));
    assert.equal(spec.calls.length, 5);
    assert.deepEqual(spec.notCalled.map((n) => n.name), ["a5", "a6", "photo"]);
    assert.ok(!spec.actionNames.includes("mail"));
  });

  it("has no downloads when the site can't serve them", () => {
    assert.equal(plan(manifest([action()]), 1.5, false).downloads, null);
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
  let mode: { listOmits?: boolean; toolError?: boolean; actionFails?: boolean; badDownload?: boolean } = {};

  const m = manifest([action({ name: "go" }), action({ name: "photo", example: undefined, input: { type: "object", required: ["photo"], properties: { photo: { type: "string" } } } })]);

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
        const p: OutputProduct = { slug: "tip", name: "Tip", tagline: "Tips", liveUrl: base, manifest: m };
        if (url === "/p/tip/get/cli") return void res.end(mode.badDownload ? "oops" : cliSource(p, base));
        if (url === "/p/tip/get/skill") return void res.end(skillMarkdown(p, base));
        if (url === "/p/tip/get/claude-plugin") return void res.end(pluginZip(p, base));
        if (url === "/api/actions/go") return mode.actionFails ? json({ error: "no" }, 500) : json({ done: true });
        if (url === "/api/mcp/tip") {
          const rpc = JSON.parse(text) as { id: number; method: string; params?: { name: string } };
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
  });

  after(async () => {
    rmSync(dir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const runIt = async () => {
    const spec = planChecks({ product: { slug: "tip", name: "Tip", tagline: "Tips", liveUrl: base, manifest: m }, origin: base, dir, capUsd: 1.5, estimatedCostPerRunUsd: 0.01, fetchable: true });
    writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
    await new Promise<void>((resolve, reject) => {
      execFile("node", [path.join(dir, "prove-runner.mjs"), path.join(dir, "spec.json")], { timeout: 60_000 }, (err) => (err ? reject(err) : resolve()));
    });
    return parseProveResults(readFileSync(path.join(dir, "results.json"), "utf8"))!;
  };

  it("passes every output when all of it works, and logs real commands", async () => {
    mode = {};
    const results = await runIt();
    assert.ok(results.finishedAt);
    assert.deepEqual(Object.keys(results.outputs), ["mcp", "cli", "claude_plugin", "skill"]);
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
    assert.equal(results.outputs.skill!.facts.downloaded, true);
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

  it("says a run that stopped writing never finished", () => {
    const [row] = proveRows([ev("stage", "running"), ev("cli", "running")], new Date("2026-10-31T13:00:00.000Z").getTime());
    assert.equal(row!.state, "failed");
    assert.equal(row!.title, "Prove it didn't finish");
    assert.equal(row!.children![0]!.title, "CLI: the check never finished");
  });
});
