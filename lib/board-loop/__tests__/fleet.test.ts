/**
 * The fleet driver against a fake control plane: what it asks a real board to run, and how it reads the answers. Nothing here
 * has reached a real fleet (docs/JETSON_TODO.md).
 *
 *   npx tsx --test lib/board-loop/__tests__/fleet.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aliasFor, BoardBusyError, BoardOfflineError, type BoardFile } from "@/lib/board-loop/driver";
import { fleetBoard, installCommand, serveCommand } from "@/lib/board-loop/fleet";
import { testPassed, newData } from "@/lib/board-loop/logic";

const SHA = "a".repeat(64);
const FILE: BoardFile = { url: "https://huggingface.co/OfflineBase/x-GGUF/resolve/abc/muse-glimmer-30b-x-IQ1_S.gguf", name: "muse-glimmer-30b-x-IQ1_S.gguf", bytes: 7e9, sha256: SHA, alias: aliasFor("OfflineBase/x-GGUF", "IQ1_S"), standIn: false };
const NODE = { id: "nd_1", name: "jetson-03", status: "online", maintenance: false, loaded_models: [], metrics: { mem: { used_mb: 7000, total_mb: 7620 }, temps_c: { tj: 61.5 }, power_mw: { total: 12000 } } };
const config = { url: "https://fleet.example.com/admin/", token: "jpt_made_up_token", node: "jetson-03" };

function fake(routes: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return routes(url, init);
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe("the fleet driver", () => {
  it("downloads to a partial name and checks the checksum twice before it counts", () => {
    const c = installCommand(FILE);
    assert.equal(c.match(/sha256sum -c -/g)?.length, 2);
    assert.ok(c.indexOf("drop_caches") > c.indexOf("sha256sum"));
    assert.ok(c.indexOf("mv ") > c.lastIndexOf("sha256sum"));
    assert.match(c, /mm-board-install/);
  });

  it("refuses anything odd before it can reach a shell", () => {
    assert.throws(() => installCommand({ ...FILE, name: "x'; reboot #.gguf" }));
    assert.throws(() => installCommand({ ...FILE, sha256: "$(reboot)" }));
    assert.throws(() => installCommand({ ...FILE, url: "https://evil.example.com/x.gguf" }));
  });

  it("serves under systemd-run with one chat and a short context, as fleet.md says", () => {
    const c = serveCommand(FILE, "https://fleet.example.com/admin");
    assert.match(c, /systemd-run --unit=mm-board-serve/);
    assert.match(c, /--parallel 1 --ctx-per-chat 2048/);
    assert.match(c, /--mmproj-url ''/);
    assert.ok(c.includes(`--alias '${FILE.alias}'`));
  });

  it("sends its token only as a header, and goes into maintenance before changing the model", async () => {
    const { doFetch, calls } = fake((url, init) => {
      if (url.endsWith("/api/nodes")) return json([NODE]);
      if (init.method === "PATCH") return json(NODE);
      return json({ id: "jb_1", status: "running", tasks: [] });
    });
    const handle = await fleetBoard(config, "fleet", doFetch).serve(FILE);
    assert.equal(handle, "jb_1");
    assert.equal(calls[0]!.url, "https://fleet.example.com/admin/api/nodes");
    assert.ok(calls.some((c) => c.init.method === "PATCH" && JSON.parse(c.init.body as string).maintenance === true));
    assert.ok(!calls.some((c) => c.url.includes(config.token)));
    assert.ok(calls.every((c) => (c.init.headers as Record<string, string>).authorization === `Bearer ${config.token}`));
  });

  it("treats a non-zero exit as a failure, though the job says ok", async () => {
    const { doFetch } = fake(() => json({ id: "jb", status: "succeeded", tasks: [{ status: "succeeded", error: null, result: { exit_code: 1 } }] }));
    const work = await fleetBoard(config, "fleet", doFetch).workState("jb");
    assert.equal(work.state, "failed");
  });

  it("reads memory, temperature and power from the node's metrics", async () => {
    const { doFetch } = fake(() => json([NODE]));
    assert.deepEqual(await fleetBoard(config, "fleet", doFetch).metrics(), { memUsedMb: 7000, memTotalMb: 7620, tempC: 61.5, powerW: 12 });
  });

  it("says offline for no such board and a fleet that can't be reached, with no address in the words", async () => {
    const none = fake(() => json([]));
    assert.equal((await fleetBoard(config, "fleet", none.doFetch).status()).online, false);
    const gone = fleetBoard(config, "fleet", (async () => {
      throw new Error("ECONNREFUSED fleet.example.com");
    }) as unknown as typeof fetch);
    assert.equal((await gone.status()).online, false);
    await assert.rejects(gone.metrics(), (err: Error) => err instanceof BoardOfflineError && !err.message.includes("example.com"));
  });

  it("reads a stream, pins the node, and times generation; a full fleet is busy", async () => {
    const sse = ['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', 'data: {"choices":[{"delta":{"content":" there"},"finish_reason":"stop"}],"usage":{"completion_tokens":2}}\n\n', "data: [DONE]\n\n"].join("");
    const { doFetch, calls } = fake((url) => (url.endsWith("/api/nodes") ? json([NODE]) : new Response(sse)));
    const answer = await fleetBoard(config, "fleet", doFetch).ask({ alias: FILE.alias, messages: [{ role: "user", content: "Hi" }], maxTokens: 8 });
    assert.equal(answer.text, "Hi there");
    assert.equal(answer.tokens, 2);
    assert.equal(answer.finish, "stop");
    assert.equal((calls.at(-1)!.init.headers as Record<string, string>)["x-jcp-node"], "nd_1");
    const busy = fake((url) => (url.endsWith("/api/nodes") ? json([NODE]) : json({}, 429, { "retry-after": "5" })));
    await assert.rejects(fleetBoard(config, "fleet", busy.doFetch).ask({ alias: "x", messages: [], maxTokens: 1 }), BoardBusyError);
  });

  it("a real board's set passes only with its memory under the board's own", () => {
    const runs = Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, prompt: "p", answer: "a", tokens: 3, tokensPerSecond: 9, firstTokenMs: 1, ms: 9, error: null }));
    const test = { ...newData("t").test, runs };
    assert.equal(testPassed("fleet", test), false, "no memory reported");
    assert.equal(testPassed("fleet", { ...test, peakMemMb: 8000, memTotalMb: 7620 }), false);
    assert.equal(testPassed("fleet", { ...test, peakMemMb: 7000, memTotalMb: 7620 }), true);
    assert.equal(testPassed("simulated", test), true);
  });
});
