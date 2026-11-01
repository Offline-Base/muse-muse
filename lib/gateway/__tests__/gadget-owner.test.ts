/**
 * Wave 3, unit 13 on the gadget route (docs/CAPABILITIES.md, section 19): the owner check, which closes the release review's
 * high finding, and read_sensor and show_text. Every board here is a fake.
 *
 *   npx tsx --test lib/gateway/__tests__/gadget-owner.test.ts
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { handleGadgetCall, handleGadgetTools, GADGET_ID, type GadgetBoard, type GadgetDeps, type LinkedBoard } from "@/lib/gateway/gadget";
import { hardwareProofKey } from "@/lib/caps/hardware/limits";
import { OWNER_HEADER, VISITOR_HEADER } from "@/lib/gateway/policy";
import { mintOwnerSession } from "@/lib/tools/principal";

const LIVE = "mm_live_" + "a".repeat(30);
const OTHER = "mm_live_" + "c".repeat(30);
const BUILD = "mm_build_" + "b".repeat(30);
const NOW = new Date("2026-11-03T15:00:00Z");
const MODELS = [GADGET_ID, "cap:hardware"];
const tok = (id: string, scope: string, productId = "prod-1", allowedModels = MODELS, buildId?: string) => ({ id, productId, scope, allowedModels, dailyBudgetUsd: 3, buildId });

function fixture(over: Partial<GadgetDeps> & { link?: LinkedBoard | null; legacy?: GadgetBoard | null; check?: boolean; tools?: boolean; counts?: Record<string, number> } = {}) {
  const calls: string[] = [];
  const hits: string[] = [];
  const legacyCalls: string[] = [];
  const realBoard: GadgetBoard = {
    async listTools() {
      return ["describe_device", "capture_image", "record_audio", "read_sensor", "show_text", "run_command", "install_model"].map((name) => ({ name, inputSchema: {} }));
    },
    async callTool(name, args) {
      calls.push(`${name} ${JSON.stringify(args)}`);
      return { content: [{ type: "text", text: "{}" }], isError: false };
    },
  };
  const legacy: GadgetBoard = {
    listTools: async () => {
      legacyCalls.push("list");
      return [];
    },
    callTool: async (name) => {
      legacyCalls.push(name);
      return { content: [], isError: false };
    },
  };
  const tokens: Record<string, ReturnType<typeof tok>> = { [LIVE]: tok("live", "live"), [OTHER]: tok("other", "live", "prod-2"), [BUILD]: tok("build", "build", "prod-1", MODELS, "build-1") };
  const deps: GadgetDeps = {
    findToken: async (t) => (tokens[t] ?? null) as never,
    productStatus: async () => "live",
    hitRateLimits: async (keys) => {
      hits.push(...keys);
      return Object.fromEntries(keys.map((k) => [k, over.counts?.[k] ?? 1]));
    },
    board: () => (over.legacy === null ? null : legacy),
    now: () => NOW,
    ...(over.check === false ? {} : { linkedBoard: async () => (over.link === undefined ? { board: realBoard, visitors: false } : over.link) }),
    boardTools: over.tools !== false,
    ...over,
  };
  return { deps, calls, hits, legacyCalls, realBoard };
}

const post = (bearer: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://mm.example/api/gateway/gadget", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, ...headers }, body: JSON.stringify(body) });
const get = (bearer: string, headers: Record<string, string> = {}) => new Request("https://mm.example/api/gateway/gadget", { headers: { authorization: `Bearer ${bearer}`, ...headers } });
const errorCode = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;
const READ = { tool: "read_sensor", arguments: {} };

let ownerHeaders: Record<string, string>;
let otherProductOwner: Record<string, string>;

before(() => {
  process.env.TOOLS_SIGNING_SECRET = "made-up-secret-for-the-gadget-owner-check-0123456789";
  const session = (productId: string) => mintOwnerSession({ productId, subject: "owner-1" }, NOW).session;
  ownerHeaders = { [OWNER_HEADER]: session("prod-1") };
  otherProductOwner = { [OWNER_HEADER]: session("prod-2") };
});

describe("with the owner check on", () => {
  it("the owner's pass reaches the linked board, and DEVICE_MCP_URL's board is never touched", async () => {
    const f = fixture();
    const res = await handleGadgetCall(post(LIVE, READ, ownerHeaders), f.deps);
    assert.equal(res.status, 200);
    assert.deepEqual(f.calls, ["read_sensor {}"]);
    assert.deepEqual(f.legacyCalls, []);
  });

  it("a visitor, or a product's server naming nobody, gets gadget_offline while visitors are off", async () => {
    const f = fixture();
    for (const req of [post(LIVE, READ, { [VISITOR_HEADER]: "v".repeat(24) }), post(LIVE, READ)]) {
      const res = await handleGadgetCall(req, f.deps);
      assert.equal(res.status, 503);
      assert.equal(await errorCode(res), "gadget_offline");
    }
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.legacyCalls, []);
  });

  it("a forged pass, or another product's pass, is nobody", async () => {
    const f = fixture();
    for (const headers of [{ [OWNER_HEADER]: "os1.prod-1.owner-1.9999999999.forged" }, otherProductOwner]) {
      assert.equal((await handleGadgetCall(post(LIVE, READ, headers), f.deps)).status, 503);
    }
    assert.deepEqual(f.calls, []);
  });

  it("visitors reach it only when the link says so", async () => {
    const open = fixture();
    const link = { board: open.realBoard, visitors: true };
    const res = await handleGadgetCall(post(LIVE, READ, { [VISITOR_HEADER]: "v".repeat(24) }), { ...open.deps, linkedBoard: async () => link });
    assert.equal(res.status, 200);
    assert.deepEqual(open.calls, ["read_sensor {}"]);
  });

  it("no link is gadget_offline for everyone, owner included, with the same answer", async () => {
    const f = fixture({ link: null });
    const owner = await handleGadgetCall(post(LIVE, READ, ownerHeaders), f.deps);
    const visitor = await handleGadgetCall(post(LIVE, READ), fixture().deps);
    assert.equal(owner.status, 503);
    assert.equal(visitor.status, 503);
    assert.deepEqual(await owner.json(), await visitor.json());
    assert.deepEqual(f.legacyCalls, []);
  });

  it("each product asks for its own link", async () => {
    const asked: string[] = [];
    const f = fixture();
    await handleGadgetCall(post(OTHER, READ, otherProductOwner), { ...f.deps, linkedBoard: async (id) => (asked.push(id), null) });
    assert.deepEqual(asked, ["prod-2"]);
  });

  it("the tool list goes through the same check", async () => {
    const f = fixture();
    assert.equal((await handleGadgetTools(get(LIVE), f.deps)).status, 503);
    const res = await handleGadgetTools(get(LIVE, ownerHeaders), f.deps);
    assert.equal(res.status, 200);
    const { tools } = (await res.json()) as { tools: Array<{ name: string }> };
    assert.deepEqual(tools.map((t) => t.name), ["describe_device", "capture_image", "record_audio", "read_sensor", "show_text"]);
  });

  it("run_command and install_model never reach a board, whoever asks", async () => {
    const f = fixture();
    for (const tool of ["run_command", "install_model", "export_model"]) {
      const res = await handleGadgetCall(post(LIVE, { tool, arguments: {} }, ownerHeaders), f.deps);
      assert.equal(res.status, 400);
      assert.equal(await errorCode(res), "unknown_tool");
    }
    assert.deepEqual(f.calls, []);
  });

  it("builds still get the simulated board, with no link at all", async () => {
    const f = fixture({ link: null });
    const res = await handleGadgetCall(post(BUILD, READ), f.deps);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { simulated: boolean }).simulated, true);
  });
});

describe("with the owner check off", () => {
  it("every live product reaches the one connected board, as today", async () => {
    const f = fixture({ check: false });
    assert.equal((await handleGadgetCall(post(LIVE, { tool: "describe_device" }), f.deps)).status, 200);
    assert.deepEqual(f.legacyCalls, ["describe_device"]);
  });
});

describe("the board tools", () => {
  it("are refused with their flag off, and aren't listed", async () => {
    const f = fixture({ tools: false });
    const res = await handleGadgetCall(post(LIVE, READ, ownerHeaders), f.deps);
    assert.equal(res.status, 400);
    assert.equal(await errorCode(res), "unknown_tool");
    const list = (await (await handleGadgetTools(get(BUILD), f.deps)).json()) as { tools: Array<{ name: string }> };
    assert.deepEqual(list.tools.map((t) => t.name), ["describe_device", "capture_image", "record_audio"]);
  });

  it("are refused for a gadget product whose brief didn't ask for the hardware cap", async () => {
    const plain = "mm_live_" + "d".repeat(30);
    const f = fixture();
    const deps = { ...f.deps, findToken: async () => tok("plain", "live", "prod-1", [GADGET_ID]) as never };
    const res = await handleGadgetCall(post(plain, READ, ownerHeaders), deps);
    assert.equal(await errorCode(res), "unknown_tool");
  });

  it("the simulated board answers both, and the gateway keeps its own record", async () => {
    const f = fixture();
    const read = (await (await handleGadgetCall(post(BUILD, READ), f.deps)).json()) as { content: Array<{ text: string }>; simulated: boolean };
    assert.equal(read.simulated, true);
    assert.deepEqual(JSON.parse(read.content[0]!.text).sensors[0].value, 41.5);
    const shown = (await (await handleGadgetCall(post(BUILD, { tool: "show_text", arguments: { text: "Hello" } }), f.deps)).json()) as { content: Array<{ text: string }> };
    assert.equal(JSON.parse(shown.content[0]!.text).shown, "Hello");
    assert.ok(f.hits.includes(hardwareProofKey("read_sensor", "build-1")));
    assert.ok(f.hits.includes(hardwareProofKey("show_text", "build-1")));
  });

  it("a live call leaves no proof", async () => {
    const f = fixture();
    await handleGadgetCall(post(LIVE, READ, ownerHeaders), f.deps);
    assert.equal(f.hits.some((k) => k.startsWith("hardware-proof:")), false);
  });

  it("show_text takes up to 200 plain characters", async () => {
    const f = fixture();
    const send = (args: unknown) => handleGadgetCall(post(LIVE, { tool: "show_text", arguments: args }, ownerHeaders), f.deps);
    for (const bad of [{ text: "x".repeat(201) }, { text: "" }, { text: "   " }, { text: "two\nlines" }, { text: 5 }, {}, { text: "ok", extra: 1 }]) {
      const res = await send(bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(await errorCode(res), "invalid_arguments");
    }
    assert.deepEqual(f.calls, []);
    assert.equal((await send({ text: "x".repeat(200) })).status, 200);
  });

  it("show_text is limited to 6 a minute for each product, and read_sensor isn't", async () => {
    const seventh = fixture({ counts: { "gadget:show:prod-1": 7 } });
    const res = await handleGadgetCall(post(LIVE, { tool: "show_text", arguments: { text: "Hi" } }, ownerHeaders), seventh.deps);
    assert.equal(res.status, 429);
    assert.deepEqual(seventh.calls, []);
    assert.equal((await handleGadgetCall(post(LIVE, READ, ownerHeaders), seventh.deps)).status, 200);
    const sixth = fixture({ counts: { "gadget:show:prod-1": 6 } });
    assert.equal((await handleGadgetCall(post(LIVE, { tool: "show_text", arguments: { text: "Hi" } }, ownerHeaders), sixth.deps)).status, 200);
  });

  it("read_sensor takes only a sensor's name", async () => {
    const f = fixture();
    for (const bad of [{ path: "/etc/passwd" }, { sensor: 5 }, { sensor: "" }, { sensor: "s".repeat(65) }]) {
      assert.equal((await handleGadgetCall(post(LIVE, { tool: "read_sensor", arguments: bad }, ownerHeaders), f.deps)).status, 400);
    }
    assert.deepEqual(f.calls, []);
  });
});
