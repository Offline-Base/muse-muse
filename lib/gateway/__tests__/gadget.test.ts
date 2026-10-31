import assert from "node:assert/strict";
import { test } from "node:test";
import { GADGET_ID, GADGET_LIMITS, handleGadgetCall, handleGadgetTools, SIMULATED_BOARD, type GadgetBoard, type GadgetDeps } from "@/lib/gateway/gadget";
import type { GatewayToken } from "@/lib/gateway/handler";

const LIVE = "mm_live_" + "a".repeat(30);
const BUILD = "mm_build_" + "b".repeat(30);

function token(scope: "build" | "live", allowedModels = ["muse-wonder-1.0", GADGET_ID]): GatewayToken {
  return { id: `tok-${scope}`, productId: "prod-1", scope, allowedModels, dailyBudgetUsd: 3 };
}

function deps(over: Partial<GadgetDeps> & { tokens?: Record<string, GatewayToken>; counts?: Record<string, number> } = {}): GadgetDeps & { calls: string[] } {
  const calls: string[] = [];
  const tokens = over.tokens ?? { [LIVE]: token("live"), [BUILD]: token("build") };
  const realBoard: GadgetBoard = {
    async listTools() {
      return [
        { name: "describe_device", inputSchema: {} },
        { name: "capture_image", inputSchema: {} },
        { name: "run_command", inputSchema: {} },
      ];
    },
    async callTool(name, args) {
      calls.push(`${name} ${JSON.stringify(args)}`);
      return { content: [{ type: "text", text: "real" }], isError: false };
    },
  };
  return {
    calls,
    findToken: async (t) => tokens[t] ?? null,
    productStatus: async () => "live",
    hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, over.counts?.[k] ?? 1])),
    board: () => realBoard,
    ...over,
  };
}

const call = (bearer: string | null, body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://mm.example/api/gateway/gadget", {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const list = (bearer: string) => new Request("https://mm.example/api/gateway/gadget", { headers: { authorization: `Bearer ${bearer}` } });
const code = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;

test("a live product reaches the connected board, for the product tools only", async () => {
  const d = deps();
  const res = await handleGadgetCall(call(LIVE, { tool: "capture_image", arguments: { width: 640 } }), d);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { content: [{ type: "text", text: "real" }], isError: false, simulated: false });
  assert.deepEqual(d.calls, ['capture_image {"width":640}']);
  const tools = (await (await handleGadgetTools(list(LIVE), d)).json()) as { tools: Array<{ name: string }> };
  assert.deepEqual(tools.tools.map((t) => t.name), ["describe_device", "capture_image"]);
});

test("a live product learns what a board has, not where it sits", async () => {
  const described = {
    hostname: "jetson-02",
    model: "Jetson Orin Nano",
    os: "Ubuntu 24.04",
    cameras: [{ device: "/dev/video0", name: "cam" }],
    microphones: [{ device: "plughw:1,0", name: "mic" }],
    usb_devices: ["Bus 001 Device 002: a private thing"],
    disk_gib: { total: 58, free: 2.9 },
  };
  const board: GadgetBoard = {
    listTools: async () => [],
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify(described) }], isError: false }),
  };
  const res = await handleGadgetCall(call(LIVE, { tool: "describe_device" }), deps({ board: () => board }));
  const body = (await res.json()) as { content: Array<{ text: string }>; simulated: boolean };
  assert.deepEqual(JSON.parse(body.content[0]!.text), { model: described.model, cameras: described.cameras, microphones: described.microphones });
  assert.equal(body.simulated, false);

  // A board's own failure still reads as it was sent.
  const failing: GadgetBoard = { listTools: async () => [], callTool: async () => ({ content: [{ type: "text", text: "No camera." }], isError: true }) };
  const failed = (await (await handleGadgetCall(call(LIVE, { tool: "describe_device" }), deps({ board: () => failing }))).json()) as { content: unknown };
  assert.deepEqual(failed.content, [{ type: "text", text: "No camera." }]);
});

test("a product never gets a shell, or any tool not on the list", async () => {
  const d = deps();
  for (const tool of ["run_command", "system.run", "", 7]) {
    const res = await handleGadgetCall(call(LIVE, { tool }), d);
    assert.equal(res.status, 400, String(tool));
    assert.equal(await code(res), "unknown_tool");
  }
  assert.deepEqual(d.calls, []);
});

test("builds always get the simulated board, with a real photo and recording", async () => {
  const d = deps();
  const photo = (await (await handleGadgetCall(call(BUILD, { tool: "capture_image" }), d)).json()) as { content: Array<{ type: string; data: string; mimeType: string }>; simulated: boolean };
  assert.equal(photo.simulated, true);
  assert.equal(photo.content[0].mimeType, "image/jpeg");
  assert.equal(Buffer.from(photo.content[0].data, "base64").subarray(0, 3).toString("hex"), "ffd8ff");
  const audio = (await (await handleGadgetCall(call(BUILD, { tool: "record_audio" }), d)).json()) as { content: Array<{ type: string; data?: string }> };
  const wav = Buffer.from(audio.content.find((c) => c.type === "audio")?.data ?? "", "base64");
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.deepEqual(d.calls, [], "the real board is never touched by a build");
  const tools = (await (await handleGadgetTools(list(BUILD), d)).json()) as { simulated: boolean };
  assert.equal(tools.simulated, true);
});

test("only products whose brief picked a gadget may call one", async () => {
  const d = deps({ tokens: { [LIVE]: token("live", ["muse-wonder-1.0"]) } });
  const res = await handleGadgetCall(call(LIVE, { tool: "capture_image" }), d);
  assert.equal(res.status, 403);
  assert.equal(await code(res), "gadget_not_allowed");
});

test("auth, a turned-off product, bad bodies and no board", async () => {
  assert.equal((await handleGadgetCall(call(null, { tool: "capture_image" }), deps())).status, 401);
  assert.equal((await handleGadgetCall(call("mm_live_unknown_token_value_123", { tool: "capture_image" }), deps())).status, 401);
  const off = await handleGadgetCall(call(LIVE, { tool: "capture_image" }), deps({ productStatus: async () => "disabled" }));
  assert.equal(await code(off), "product_disabled");
  assert.equal(await code(await handleGadgetCall(call(LIVE, "{nope"), deps())), "invalid_body");
  assert.equal(await code(await handleGadgetCall(call(LIVE, { tool: "capture_image", arguments: [1] }), deps())), "invalid_arguments");
  const none = await handleGadgetCall(call(LIVE, { tool: "capture_image" }), deps({ board: () => null }));
  assert.equal(none.status, 503);
  assert.equal(await code(none), "gadget_offline");
});

test("a board that doesn't answer is a 502, and a tool's own failure comes back for the product to show", async () => {
  const broken = await handleGadgetCall(call(LIVE, { tool: "capture_image" }), deps({ board: () => ({ listTools: async () => [], callTool: async () => { throw new Error("ECONNREFUSED 10.0.0.5"); } }) }));
  assert.equal(broken.status, 502);
  const text = await broken.text();
  assert.match(text, /gadget_unavailable/);
  assert.doesNotMatch(text, /10\.0\.0\.5/, "the board's address never reaches a product");
  const failed = await handleGadgetCall(call(BUILD, { tool: "describe_device" }), deps({}));
  assert.equal(failed.status, 200);
  assert.equal((await SIMULATED_BOARD.callTool("nope", {})).isError, true);
});

test("calls are rate limited per product and per visitor", async () => {
  const tooMany = { [`gadget:token:tok-live`]: GADGET_LIMITS.perTokenPerMinute + 1 };
  const res = await handleGadgetCall(call(LIVE, { tool: "capture_image" }), deps({ counts: tooMany }));
  assert.equal(res.status, 429);
  assert.ok(res.headers.get("retry-after"));
  const perIp = { [`gadget:ip:prod-1:203.0.113.9`]: GADGET_LIMITS.perIpPerMinute + 1 };
  const byIp = await handleGadgetCall(call(LIVE, { tool: "capture_image" }, { "x-musemuse-client-ip": "203.0.113.9" }), deps({ counts: perIp }));
  assert.equal(byIp.status, 429);
});
