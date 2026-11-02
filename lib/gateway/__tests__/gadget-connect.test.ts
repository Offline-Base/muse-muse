/**
 * GADGET_CONNECT on {GATEWAY_URL}/gadget: who reaches a board's model and robot, what a build gets, and that a product can't confirm
 * its own action. Fake boards only.
 *
 *   npx tsx --test lib/gateway/__tests__/gadget-connect.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleGadgetCall, handleGadgetTools, type GadgetDeps, type LinkedBoard } from "@/lib/gateway/gadget";
import { readRobotRequest } from "@/lib/caps/hardware/robot";
import { OWNER_HEADER } from "@/lib/gateway/policy";
import { mintOwnerSession, ownerSubject } from "@/lib/tools/principal";

process.env.GATEWAY_TOKEN_PEPPER ||= "test-pepper-test-pepper-test-pepper-1";

const OWNER = "11111111-1111-1111-1111-111111111111";
const PRODUCT = "22222222-2222-2222-2222-222222222222";
const MODELS = ["cap:hardware", "board-tools"];

const token = (scope: "build" | "live", id = "tok") => ({ id, productId: PRODUCT, scope, allowedModels: MODELS, buildId: "b" }) as never;

function deps(link: LinkedBoard | null, over: Partial<GadgetDeps> = {}): GadgetDeps & { stops: string[] } {
  const stops: string[] = [];
  return {
    stops,
    findToken: async (t) => (t === "build" ? token("build", `tok-${Math.random()}`) : t === "live" ? token("live") : null),
    productStatus: async () => "live",
    hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 1])),
    board: () => null,
    linkedBoard: async () => link,
    boardTools: true,
    connect: { siteUrl: "https://mm.example", setStopped: async (id) => void stops.push(id) },
    ...over,
  } as GadgetDeps & { stops: string[] };
}

const facts = { target: "muse-glimmer-30b-IQ1_S", targetLabel: "Muse Glimmer, one bit", simulated: true, robot: true, stopped: false };

function link(over: Partial<LinkedBoard> = {}, ask: (r: { model: string }) => unknown = () => ({ kind: "answer", text: "from the board" })): LinkedBoard & { asked: Array<{ model: string }>; tools: string[] } {
  const asked: Array<{ model: string }> = [];
  const tools: string[] = [];
  return {
    asked,
    tools,
    ownerUserId: OWNER,
    visitors: false,
    boardId: "board-1",
    facts,
    open: async () => ({
      listTools: async () => [],
      callTool: async (name: string) => {
        tools.push(name);
        return { isError: false, content: [{ type: "text", text: "{}" }] };
      },
      ask: async (r: { model: string }) => {
        asked.push(r);
        return ask(r) as never;
      },
    }),
    ...over,
  };
}

const post = (bearer: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://mm.example/api/gateway/gadget", { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const MESSAGES = [{ role: "user", content: "soil 22" }];

/** The header a product forwards for its verified owner. */
const ownerHeaders = () => ({ [OWNER_HEADER]: mintOwnerSession({ productId: PRODUCT, subject: ownerSubject(OWNER) }, new Date()).session });

const reply = async (res: Response) => JSON.parse(((await res.json()) as { content: Array<{ text: string }> }).content[0].text) as Record<string, unknown>;
const code = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;

describe("the model on the owner's board", () => {
  it("off, the tools aren't there", async () => {
    const d = deps(link(), { connect: undefined });
    assert.equal(await code(await handleGadgetCall(post("live", { tool: "ask_board", arguments: { messages: MESSAGES } }), d)), "unknown_tool");
  });

  it("a build gets the simulator, labeled so", async () => {
    const res = await handleGadgetCall(post("build", { tool: "ask_board", arguments: { messages: MESSAGES } }), deps(null));
    const body = (await res.clone().json()) as { simulated: boolean };
    assert.equal(body.simulated, true);
    const out = await reply(res);
    assert.match(String(out.text), /^\[simulated muse-glimmer-30b-IQ1_S\].*pump/);
  });

  it("a visitor doesn't reach an owner-only board, with the same answer as no board", async () => {
    const l = link();
    const res = await handleGadgetCall(post("live", { tool: "ask_board", arguments: { messages: MESSAGES } }), deps(l));
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "gadget_offline");
    assert.match(body.error.message, /Your board isn't connected/);
    assert.equal(l.asked.length, 0);
    const none = await handleGadgetCall(post("live", { tool: "ask_board", arguments: { messages: MESSAGES } }), deps(null));
    assert.equal(((await none.json()) as { error: { message: string } }).error.message, body.error.message);
  });

  it("with visitors on, sends the model the board's kind picked", async () => {
    const l = link({ visitors: true });
    const res = await handleGadgetCall(post("live", { tool: "ask_board", arguments: { messages: MESSAGES } }), deps(l));
    assert.equal(res.status, 200);
    assert.equal((await reply(res)).text, "from the board");
    assert.equal(l.asked[0].model, "muse-glimmer-30b-IQ1_S");
  });

  it("a board that's on with no model says so, and one that throws looks offline with nothing about where it is", async () => {
    const noModel = link({ visitors: true }, () => ({ kind: "no_model" }));
    assert.equal(await code(await handleGadgetCall(post("live", { tool: "ask_board", arguments: { messages: MESSAGES } }), deps(noModel))), "gadget_no_model");
    const down = link({ visitors: true }, () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:8765");
    });
    const res = await handleGadgetCall(post("live", { tool: "ask_board", arguments: { messages: MESSAGES } }), deps(down));
    const text = await res.text();
    assert.equal(res.status, 503);
    assert.doesNotMatch(text, /10\.0\.0\.5/);
  });

  it("asks only a Meta model: a board picked a small Llama is refused before it's opened, and one running another model before the prompt goes", async () => {
    let opened = 0;
    const llama = link({ visitors: true, facts: { ...facts, simulated: false, target: "Llama-3.2-3B-Q4_K_M", targetLabel: "Llama 3.2 3B" }, open: async () => (opened++, null) });
    const res = await handleGadgetCall(post("live", { tool: "ask_board", arguments: { messages: MESSAGES } }), deps(llama));
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "board_model_not_meta");
    assert.match(body.error.message, /isn't a Meta model, so it wasn't asked/);
    assert.equal(opened, 0, "the board was never opened");
    const bolt = link({ visitors: true, facts: { ...facts, simulated: false } }, () => ({ kind: "not_meta" }));
    assert.equal(await code(await handleGadgetCall(post("live", { tool: "ask_board", arguments: { messages: MESSAGES } }), deps(bolt))), "board_model_not_meta");
  });

  it("a board added by hand has no known model", async () => {
    assert.equal(await code(await handleGadgetCall(post("live", { tool: "ask_board", arguments: { messages: MESSAGES } }), deps(link({ visitors: true, facts: null })))), "board_not_paired");
  });

  it("checks its arguments", async () => {
    for (const args of [{}, { messages: [] }, { messages: [{ role: "tool", content: "x" }] }, { messages: MESSAGES, max_tokens: 100000 }, { messages: MESSAGES, url: "x" }, { messages: [{ role: "user", content: "x".repeat(24001) }] }]) {
      assert.equal(await code(await handleGadgetCall(post("build", { tool: "ask_board", arguments: args }), deps(null))), "invalid_arguments", JSON.stringify(args).slice(0, 60));
    }
  });

  it("lists the tools only with connect on", async () => {
    const list = (d: GadgetDeps) => handleGadgetTools(new Request("https://mm.example/api/gateway/gadget", { headers: { authorization: "Bearer build" } }), d);
    const names = async (r: Response) => ((await r.json()) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    assert.ok((await names(await list(deps(null)))).includes("ask_board"));
    assert.ok(!(await names(await list(deps(null, { connect: undefined })))).includes("ask_board"));
  });
});

describe("the robot", () => {
  const action = { action: "pump_run", args: { seconds: 3 } };

  it("in a build, asks first, runs on its card once, and refuses what isn't on the list or over its limit", async () => {
    const used = new Set<string>();
    const d = deps(null, {
      findToken: async () => token("build", "steady"),
      hitRateLimits: async (keys) =>
        Object.fromEntries(
          keys.map((k) => {
            const seen = used.has(k);
            used.add(k);
            return [k, k.startsWith("tool-approval:") && seen ? 2 : 1];
          }),
        ),
    });
    const first = await reply(await handleGadgetCall(post("build", { tool: "robot_action", arguments: action }), d));
    assert.equal(first.code, "needs_confirmation");
    const id = (first.approval as { id: string }).id;
    const done = await reply(await handleGadgetCall(post("build", { tool: "robot_action", arguments: action, approval: id }), d));
    assert.equal(done.ok, true);
    const again = await reply(await handleGadgetCall(post("build", { tool: "robot_action", arguments: action, approval: id }), d));
    assert.equal(again.code, "needs_confirmation", "a card works once");
    const other = await reply(await handleGadgetCall(post("build", { tool: "robot_action", arguments: { action: "pump_run", args: { seconds: 1 } }, approval: id }), d));
    assert.equal(other.code, "needs_confirmation", "a card covers its exact arguments");
    for (const args of [{ action: "flamethrower", args: {} }, { action: "pump_run", args: { seconds: 6 } }, { action: "pump_run", args: { seconds: 1.5 } }, { action: "constructor", args: {} }]) {
      assert.equal(await code(await handleGadgetCall(post("build", { tool: "robot_action", arguments: args }), d)), "invalid_arguments", JSON.stringify(args));
    }
  });

  it("in a build, the hard stop holds, and one build's stop doesn't touch another's", async () => {
    const d = deps(null, { findToken: async () => token("build", "stops") });
    const stopped = await reply(await handleGadgetCall(post("build", { tool: "hard_stop" }), d));
    assert.equal(stopped.stopped, true);
    const first = await reply(await handleGadgetCall(post("build", { tool: "robot_action", arguments: action }), d));
    const id = (first.approval as { id: string }).id;
    const refused = await reply(await handleGadgetCall(post("build", { tool: "robot_action", arguments: action, approval: id }), d));
    assert.equal(refused.code, "stopped");
    const other = deps(null, { findToken: async () => token("build", "not-stopped") });
    assert.equal((await reply(await handleGadgetCall(post("build", { tool: "robot_status" }), other))).stopped, false);
  });

  it("live, a visitor can't ask for an action even with the board open to them, and nothing moves", async () => {
    const l = link({ visitors: true });
    const res = await handleGadgetCall(post("live", { tool: "robot_action", arguments: action }), deps(l));
    assert.equal(await code(res), "gadget_offline");
    assert.deepEqual(l.tools, []);
  });

  it("live, a board that refused the stop isn't reported as reached", async () => {
    const d = deps(link({ open: async () => ({ listTools: async () => [], callTool: async () => ({ isError: true, content: [{ type: "text", text: "no" }] }) }) }));
    const res = await reply(await handleGadgetCall(post("live", { tool: "hard_stop" }, ownerHeaders()), d));
    assert.equal(res.stopped, true);
    assert.equal(res.reachedBoard, false);
  });

  it("a simulated answer's target says no model ran, and a real board's says what it's running", async () => {
    const sim = await reply(await handleGadgetCall(post("live", { tool: "ask_board", arguments: { messages: MESSAGES } }, ownerHeaders()), deps(link())));
    assert.match(String(sim.target), /no model ran/);
    const real = { ...facts, simulated: false, robot: false };
    const picked = await reply(await handleGadgetCall(post("live", { tool: "ask_board", arguments: { messages: MESSAGES } }, ownerHeaders()), deps(link({ facts: real }, () => ({ kind: "answer", text: "x", running: "muse-glimmer-30b-IQ1_S" })))));
    assert.equal(picked.target, "Muse Glimmer, one bit");
    // Another Meta build than the picked one; anything that isn't Meta's never gets this far (askOnBoard).
    const other = await reply(await handleGadgetCall(post("live", { tool: "ask_board", arguments: { messages: MESSAGES } }, ownerHeaders()), deps(link({ facts: real }, () => ({ kind: "answer", text: "x", running: "muse-glimmer-30b-bakery-helper-IQ1_S" })))));
    assert.equal(other.target, "muse-glimmer-30b-bakery-helper-IQ1_S");
  });

  it("live, a visitor let in can hard stop, and it's saved even if the board is gone", async () => {
    const d = deps(link({ visitors: true, open: async () => null }));
    const res = await reply(await handleGadgetCall(post("live", { tool: "hard_stop" }), d));
    assert.deepEqual(res, { stopped: true, reachedBoard: false });
    assert.deepEqual(d.stops, ["board-1"]);
  });

  it("live, a real board refuses every robot tool", async () => {
    const real = link({ visitors: true, facts: { ...facts, simulated: false, robot: false } });
    for (const tool of ["robot_status", "hard_stop"]) {
      assert.equal(await code(await handleGadgetCall(post("live", { tool }), deps(real))), "robot_real_board_off", tool);
    }
    assert.deepEqual(real.tools, []);
  });

  it("a live product's own call never moves anything: it only gets a link, and an approval it makes up does nothing", async () => {
    const OWNER_PASS = await ownerPass();
    const l = link();
    const res = await reply(await handleGadgetCall(post("live", { tool: "robot_action", arguments: action, approval: "ap1.made.up.value" }, OWNER_PASS), deps(l)));
    assert.equal(res.code, "needs_confirmation");
    assert.deepEqual(l.tools, []);
    const request = readRobotRequest(decodeURIComponent(String(res.confirmUrl).split("r=")[1]), new Date());
    assert.equal(request?.ownerUserId, OWNER);
    assert.equal(request?.boardId, "board-1");
    assert.equal(request?.productId, PRODUCT);
    assert.match(String(res.confirmUrl), /^https:\/\/mm\.example\/gadgets\/confirm\?r=/);
  });
});

async function ownerPass(): Promise<Record<string, string>> {
  return ownerHeaders();
}
