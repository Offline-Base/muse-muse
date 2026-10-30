/**
 * The shared pieces of the cookbook-use-cases demos: strict JSON recovery, the virtual file tree and its tools, the
 * agent loop (driven by a fake runtime, so nothing reaches the network), and the sandbox harness (compiled, never run).
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-use-cases/__tests__/foundation.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStrictJson, firstBalancedObject } from "@/components/docs/playgrounds/cookbook-use-cases/lib/strict-json";
import { diffStats, exactEdit, globFiles, grepFiles, listDir, readNumbered, treeDiff, unifiedDiff } from "@/components/docs/playgrounds/cookbook-use-cases/lib/vfs";
import { agentBase, runAgentLoop, type AgentDef, type LoopRuntime } from "@/components/docs/playgrounds/cookbook-use-cases/lib/agent";
import { commentaryText, functionCalls, responseText } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import { extractHtml, harnessSources, readCapture, runPage, wrapPage } from "@/components/docs/playgrounds/cookbook-use-cases/lib/harness";

describe("strict JSON", () => {
  it("parses plain JSON without recovery", () => {
    assert.deepEqual(parseStrictJson('{"a":1}'), { ok: true, value: { a: 1 }, recovered: null });
  });
  it("strips markdown fences, then takes the first balanced object", () => {
    const fenced = parseStrictJson('Here you go:\n```json\n{"a": [1, 2]}\n```');
    assert.equal(fenced.ok && fenced.recovered, "fences");
    const prose = parseStrictJson('Sure! {"text": "a } in a string", "n": {"m": 2}} trailing');
    assert.ok(prose.ok);
    assert.equal(prose.ok && prose.recovered, "balanced");
    assert.deepEqual(prose.ok && prose.value, { text: "a } in a string", n: { m: 2 } });
  });
  it("reports unbalanced JSON", () => {
    const r = parseStrictJson('{"a": 1');
    assert.equal(r.ok, false);
    assert.equal(firstBalancedObject('x {"a": "b"'), null);
  });
});

describe("virtual files", () => {
  const vfs = { "src/a.js": "one\ntwo\nthree", "src/lib/b.ts": "const x = 1;\nexport { x };", "README.md": "# Hi" };
  it("reads with line numbers, lists, globs and greps", () => {
    assert.equal(readNumbered(vfs, "./src/a.js", 2, 1), "    2\ttwo");
    assert.equal(readNumbered(vfs, "missing"), null);
    assert.deepEqual(listDir(vfs, ""), ["README.md", "src/"]);
    assert.deepEqual(listDir(vfs, "src"), ["a.js", "lib/"]);
    assert.deepEqual(globFiles(vfs, "**/*.{ts,js}"), ["src/a.js", "src/lib/b.ts"]);
    assert.deepEqual(globFiles(vfs, "*.md"), ["README.md"]);
    assert.deepEqual(grepFiles(vfs, "export", { include: "*.ts" }), ["src/lib/b.ts:2:export { x };"]);
  });
  it("edits only when oldString matches once", () => {
    assert.deepEqual(exactEdit("a b a", "b", "c"), { ok: true, content: "a c a" });
    assert.equal(exactEdit("a b a", "a", "c").ok, false);
    assert.equal(exactEdit("a b a", "z", "c").ok, false);
    assert.deepEqual(exactEdit("a b a", "a", "c", true), { ok: true, content: "c b c" });
    assert.deepEqual(exactEdit("price $1", "$1", "$2"), { ok: true, content: "price $2" }, "no $ patterns");
  });
  it("writes unified diffs", () => {
    const d = unifiedDiff("f.txt", "a\nb\nc\nd", "a\nB\nc\nd\ne");
    assert.match(d, /^--- a\/f\.txt\n\+\+\+ b\/f\.txt\n@@ -1,4 \+1,5 @@/);
    assert.match(d, /\n-b\n\+B\n/);
    assert.match(d, /\n\+e$/);
    assert.equal(unifiedDiff("f", "x", "x"), "");
    assert.match(unifiedDiff("new.txt", undefined, "hi"), /^--- \/dev\/null\n\+\+\+ b\/new\.txt\n@@ -0,0 \+1,1 @@\n\+hi$/);
    const patch = treeDiff({ a: "1" }, { a: "2", b: "3" });
    assert.deepEqual(diffStats(patch), { added: 2, removed: 1 });
  });
});

describe("agent loop", () => {
  const agent: AgentDef = {
    name: "t",
    model: "muse-spark-1.3-contributor",
    instructions: "Be brief.",
    tools: [{ name: "add", description: "Adds", parameters: { type: "object", properties: {} } }],
    effort: "low",
    maxOutputTokens: 400,
  };
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "add", arguments: '{"a":1}' };
  const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "3" }] };

  it("builds the base body", () => {
    assert.deepEqual(agentBase(agent), {
      model: "muse-spark-1.3-contributor",
      instructions: "Be brief.",
      tools: [{ type: "function", name: "add", description: "Adds", parameters: { type: "object", properties: {} } }],
      reasoning: { effort: "low" },
      max_output_tokens: 400,
    });
  });

  it("chains with previous_response_id and function_call_output", async () => {
    const bodies: Record<string, unknown>[] = [];
    const replies = [{ id: "resp_1", output: [{ type: "message", phase: "commentary", content: [{ type: "output_text", text: "Adding." }] }, call] }, { id: "resp_2", output: [answer] }];
    const rt: LoopRuntime = {
      stopped: () => false,
      async callModel(_a, body) {
        bodies.push(body);
        return { ok: true, json: replies[bodies.length - 1], error: null, aborted: false };
      },
      async runTool(_a, c) {
        assert.equal(c.name, "add");
        return { output: "3" };
      },
    };
    const r = await runAgentLoop(agent, "1+2?", rt);
    assert.equal(r.stoppedBy, "answer");
    assert.equal(r.text, "3");
    assert.equal(bodies[0].input, "1+2?");
    assert.equal(bodies[1].previous_response_id, "resp_1");
    assert.deepEqual(bodies[1].input, [{ type: "function_call_output", call_id: "call_1", output: "3" }]);
    assert.equal(commentaryText(replies[0]), "Adding.");
    assert.equal(functionCalls(replies[0])[0].callId, "call_1");
  });

  it("replays the history with store false and encrypted reasoning", async () => {
    const bodies: Record<string, unknown>[] = [];
    const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "x", status: "completed" };
    const replies = [{ id: "r1", output: [reasoning, call] }, { id: "r2", output: [answer] }];
    const rt: LoopRuntime = {
      stopped: () => false,
      async callModel(_a, body) {
        bodies.push(structuredClone(body));
        return { ok: true, json: replies[bodies.length - 1], error: null, aborted: false };
      },
      async runTool() {
        return { output: [{ type: "input_text", text: "ok" }], after: [{ role: "user", content: "next" }] };
      },
    };
    await runAgentLoop({ ...agent, state: "replay" }, "go", rt);
    assert.equal(bodies[1].store, false);
    assert.deepEqual(bodies[1].include, ["reasoning.encrypted_content"]);
    assert.deepEqual(bodies[1].input, [
      { role: "user", content: "go" },
      { type: "reasoning", id: "rs_1", encrypted_content: "x" },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "add", arguments: '{"a":1}' },
      { type: "function_call_output", call_id: "call_1", output: [{ type: "input_text", text: "ok" }] },
      { role: "user", content: "next" },
    ]);
  });

  it("stops at the call limit and on errors", async () => {
    const rt: LoopRuntime = {
      stopped: () => false,
      async callModel() {
        return { ok: true, json: { id: "r", output: [call] }, error: null, aborted: false };
      },
      async runTool() {
        return { output: "again" };
      },
    };
    assert.equal((await runAgentLoop({ ...agent, maxCalls: 2 }, "x", rt)).stoppedBy, "limit");
    const failing: LoopRuntime = { ...rt, callModel: async () => ({ ok: false, json: null, error: { message: "no" }, aborted: false }) };
    assert.equal((await runAgentLoop(agent, "x", failing)).stoppedBy, "error");
    assert.equal(responseText({ output: [answer] }), "3");
  });
});

describe("sandbox harness", () => {
  it("compiles", () => {
    for (const src of [harnessSources.commonSource("n"), harnessSources.pageSource(), harnessSources.runSource({ "a.js": "x" }, "a.js", [])]) {
      assert.doesNotThrow(() => new Function(src));
    }
  });
  it("goes in before the page's own scripts", () => {
    const page = wrapPage("<!doctype html><html><head><title>x</title><script>game()</script></head><body></body></html>", "abc");
    assert.ok(page.indexOf('var __N = "abc"') < page.indexOf("game()"));
    assert.match(wrapPage("<canvas></canvas>", "n"), /^<!doctype html><html><head><script>/);
    assert.match(runPage({ "x.js": "console.log('</script>')" }, "x.js", [], "n"), /\\u003c\/script>/);
  });
  it("finds the HTML in a reply", () => {
    assert.equal(extractHtml("Here:\n```html\n<!DOCTYPE html><html><body>hi</body></html>\n```\nEnjoy"), "<!DOCTYPE html><html><body>hi</body></html>");
    assert.equal(extractHtml("<!doctype html><html><p>x</p></html> trailing"), "<!doctype html><html><p>x</p></html>");
    assert.equal(extractHtml("no html here"), null);
  });
  it("accepts only image data URLs as screenshots", () => {
    assert.equal(readCapture({ type: "capture-result", screenshot: "javascript:alert(1)", snapshot: "s" })?.screenshot, null);
    assert.equal(readCapture({ type: "capture-result", screenshot: "data:image/jpeg;base64,AAAA" })?.screenshot, "data:image/jpeg;base64,AAAA");
    assert.equal(readCapture({ type: "console" }), null);
  });
});
