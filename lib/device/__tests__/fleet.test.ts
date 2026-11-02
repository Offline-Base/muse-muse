/**
 * The fleet's read-only client against a fake control plane, and Wonder's fleet tools with a scripted model: only safe fields
 * come back, a down fleet reveals nothing, and no write reaches the fleet. Nothing here has reached a real control plane.
 *
 *   npx tsx --test lib/device/__tests__/fleet.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { Response as ModelResponse, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { fleetConfig } from "@/lib/board-loop/boards";
import { runDeviceAgent, type DeviceAgentDeps } from "@/lib/device/agent";
import { cachedFleetBoards, FLEET_MAX_TOKENS, fleetAsk, fleetBoards, fleetChat, fleetConfigured, FleetError, FleetNotConfiguredError, resetFleetCache } from "@/lib/device/fleet";

const URL_VALUE = "https://fleet.example.com/admin/";
/** A test value, not a real token. */
const TOKEN_VALUE = "jpt_made_up_token";

/** A NodeSummary as docs/api.md and protocol.md give it, with the fields that must never come back. */
const NODE = {
  id: "nd_secret_id",
  name: "jetson-03",
  status: "online",
  maintenance: false,
  pool: "lab",
  labels: { room: "secret-room" },
  facts: { hostname: "secret-host", ip: "10.0.0.9", serial: "SECRETSERIAL" },
  agent_version: "1.2.3",
  capabilities: ["ollama"],
  enrolled_at: 1,
  last_seen: 2,
  connected_since: 3,
  metrics: { mem: { used_mb: 3456, total_mb: 7620 }, temps_c: { cpu: 52.1, gpu: 50.3, tj: 52.9 }, power_mw: { total: 7400 } },
  metrics_ts: 4,
  loaded_models: ["bolt", "other"],
  model_count: 2,
  containers_running: 1,
  open_alerts: 0,
};
const OFFLINE = { ...NODE, id: "nd_off", name: "jetson-01", status: "offline", metrics: null, loaded_models: [], pool: null };
const TREE = { ...NODE, id: "nd_tree", name: "decision-tree", capabilities: ["systemone"], loaded_models: ["d1-omni-600M"] };
/** jetson-05: it advertises systemone for its own d1, which isn't in its loaded models, and serves an ordinary model. */
const CHAT_AND_SYSTEMONE = { ...NODE, id: "nd_05", name: "jetson-05", capabilities: ["ollama", "systemone"], loaded_models: ["hf.co/LiquidAI/LFM2.5-VL-3B-GGUF:Q4_K_M"] };
const CHAT = { choices: [{ message: { role: "assistant", content: "Hello." }, finish_reason: "stop" }], usage: { completion_tokens: 2 } };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fake(routes: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return routes(url, init);
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}

const fleetOf = (nodes: unknown[], chat: Response | null = json(CHAT)) => fake((url) => (url.endsWith("/api/nodes") ? json(nodes) : chat!));
const bodyOf = (init: RequestInit) => JSON.parse(init.body as string);
const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe("the fleet client", () => {
  beforeEach(() => {
    process.env.BOARD_FLEET_URL = URL_VALUE;
    process.env.BOARD_FLEET_TOKEN = TOKEN_VALUE;
    delete process.env.BOARD_FLEET_NODE;
    resetFleetCache();
  });
  afterEach(() => {
    delete process.env.BOARD_FLEET_URL;
    delete process.env.BOARD_FLEET_TOKEN;
    mock.timers.reset();
  });

  it("needs an address and token, reads them inside each call, and doesn't need a node", async () => {
    assert.equal(fleetConfigured(), true);
    delete process.env.BOARD_FLEET_TOKEN;
    assert.equal(fleetConfigured(), false);
    const unused = fake(() => json([]));
    await assert.rejects(fleetBoards(unused.doFetch), FleetNotConfiguredError);
    assert.deepEqual(unused.calls, []);
  });

  it("leaves the board loop's own settings needing a node", () => {
    assert.equal(fleetConfig(), null);
    process.env.BOARD_FLEET_NODE = " jetson-03 ";
    assert.deepEqual(fleetConfig(), { url: URL_VALUE, token: TOKEN_VALUE, node: "jetson-03" });
    delete process.env.BOARD_FLEET_NODE;
  });

  it("won't send the token to an address that would expose it", async () => {
    for (const url of ["http://fleet.example.com/admin", "not a url"]) {
      process.env.BOARD_FLEET_URL = url;
      assert.equal(fleetConfigured(), false, url);
    }
    process.env.BOARD_FLEET_URL = "http://127.0.0.1:9000/admin";
    assert.equal(fleetConfigured(), true);
  });

  it("returns only what's safe to show", async () => {
    const f = fleetOf([NODE, OFFLINE]);
    const boards = await fleetBoards(f.doFetch);
    assert.equal(f.calls[0]!.url, "https://fleet.example.com/admin/api/nodes");
    assert.equal(headersOf(f.calls[0]!.init).authorization, `Bearer ${TOKEN_VALUE}`);
    assert.ok(f.calls[0]!.init.signal, "every call has a timeout");
    assert.deepEqual(boards, [
      { name: "jetson-03", status: "online", pool: "lab", maintenance: false, loadedModels: ["bolt", "other"], memUsedMb: 3456, memTotalMb: 7620, maxTempC: 52.9 },
      { name: "jetson-01", status: "offline", pool: null, maintenance: false, loadedModels: [], memUsedMb: null, memTotalMb: null, maxTempC: null },
    ]);
    assert.doesNotMatch(JSON.stringify(boards), /secret|SECRET|nd_|10\.0\.0\.9|1\.2\.3/);
  });

  it("takes the hottest sensor, whichever it is", async () => {
    const f = fleetOf([{ ...NODE, metrics: { temps_c: { cpu: 40, soc1: 71.5, gpu: null } } }]);
    const [board] = await fleetBoards(f.doFetch);
    assert.equal(board!.maxTempC, 71.5);
    assert.equal(board!.memUsedMb, null);
  });

  it("reveals nothing when the fleet is down", async () => {
    const leaky = new Error(`connect failed for ${URL_VALUE} with ${TOKEN_VALUE}`);
    const cases: Array<ReturnType<typeof fake>["doFetch"]> = [
      fake(() => {
        throw leaky;
      }).doFetch,
      fake(() => json({ detail: `${URL_VALUE} ${TOKEN_VALUE}` }, 401)).doFetch,
      fake(() => new Response(`<html>${URL_VALUE}</html>`)).doFetch,
      fake(() => json({ detail: "not a list" })).doFetch,
    ];
    for (const doFetch of cases) {
      await assert.rejects(fleetBoards(doFetch), (err: Error) => {
        assert.ok(err instanceof FleetError);
        assert.doesNotMatch(err.message, /fleet\.example|jpt_/);
        return true;
      });
    }
  });

  it("keeps the status of a refusal, and none for a fleet that didn't answer", async () => {
    for (const status of [401, 403, 404, 500]) {
      await assert.rejects(fleetBoards(fake(() => json({ detail: "no" }, status)).doFetch), (err: FleetError) => err.status === status);
    }
    const down = fake(() => {
      throw new Error("down");
    });
    await assert.rejects(fleetBoards(down.doFetch), (err: FleetError) => err instanceof FleetError && err.status === undefined);
  });

  it("shares one read of the list for a while, and a failure too", async () => {
    mock.timers.enable({ apis: ["Date"] });
    const f = fleetOf([NODE]);
    const [first, second] = await Promise.all([cachedFleetBoards(f.doFetch), cachedFleetBoards(f.doFetch)]);
    assert.deepEqual(first, second);
    await cachedFleetBoards(f.doFetch);
    mock.timers.tick(29_000);
    await cachedFleetBoards(f.doFetch);
    assert.equal(f.calls.length, 1);
    mock.timers.tick(1_000);
    await cachedFleetBoards(f.doFetch);
    assert.equal(f.calls.length, 2);

    resetFleetCache();
    const down = fake(() => json({}, 500));
    await assert.rejects(cachedFleetBoards(down.doFetch), FleetError);
    await assert.rejects(cachedFleetBoards(down.doFetch), FleetError);
    assert.equal(down.calls.length, 1);
  });

  it("doesn't share a read across a changed token, or once the fleet isn't set up", async () => {
    const f = fleetOf([NODE]);
    await cachedFleetBoards(f.doFetch);
    process.env.BOARD_FLEET_TOKEN = "jpt_another_made_up_token";
    await cachedFleetBoards(f.doFetch);
    assert.equal(f.calls.length, 2);
    delete process.env.BOARD_FLEET_TOKEN;
    await assert.rejects(cachedFleetBoards(f.doFetch), FleetNotConfiguredError);
    assert.equal(f.calls.length, 2);
  });

  it("reads the list fresh for an ask, so it can't pick a model that has since unloaded", async () => {
    let nodes: unknown[] = [NODE];
    const f = fake((url) => (url.endsWith("/api/nodes") ? json(nodes) : json(CHAT)));
    await cachedFleetBoards(f.doFetch);
    nodes = [{ ...NODE, loaded_models: [] }];
    await assert.rejects(fleetAsk({ prompt: "hi" }, f.doFetch), /No board has a chat model loaded/);
    assert.ok(f.calls.every((call) => call.url.endsWith("/api/nodes")));
  });

  it("makes one bounded, non-streaming chat, with the node header only when there's a node", async () => {
    const f = fake(() => json(CHAT));
    assert.deepEqual(await fleetChat({ model: "bolt", prompt: "hi" }, f.doFetch), { text: "Hello.", finish: "stop" });
    assert.equal(f.calls[0]!.url, "https://fleet.example.com/admin/v1/chat/completions");
    assert.equal(f.calls[0]!.init.method, "POST");
    assert.equal(headersOf(f.calls[0]!.init)["x-jcp-node"], undefined);
    assert.ok(f.calls[0]!.init.signal);
    assert.deepEqual(bodyOf(f.calls[0]!.init), { model: "bolt", messages: [{ role: "user", content: "hi" }], max_tokens: FLEET_MAX_TOKENS, stream: false });

    await fleetChat({ model: "bolt", prompt: "hi", nodeId: "nd_1", maxTokens: 1e9 }, f.doFetch);
    assert.equal(headersOf(f.calls[1]!.init)["x-jcp-node"], "nd_1");
    assert.equal(bodyOf(f.calls[1]!.init).max_tokens, FLEET_MAX_TOKENS);

    await fleetChat({ model: "bolt", prompt: "hi", maxTokens: -5 }, f.doFetch);
    assert.equal(bodyOf(f.calls[2]!.init).max_tokens, 1);
  });

  it("refuses an empty or huge prompt before the fleet", async () => {
    const f = fake(() => json(CHAT));
    await assert.rejects(fleetChat({ model: "bolt", prompt: "  " }, f.doFetch), FleetError);
    await assert.rejects(fleetChat({ model: "bolt", prompt: "x".repeat(8001) }, f.doFetch), FleetError);
    assert.deepEqual(f.calls, []);
  });

  it("gives its own words for a gateway error, not the fleet's", async () => {
    for (const status of [429, 503, 500]) {
      const f = fake(() => json({ error: { message: `no online node on nd_secret at ${URL_VALUE}` } }, status));
      await assert.rejects(fleetChat({ model: "bolt", prompt: "hi" }, f.doFetch), (err: Error) => {
        assert.ok(err instanceof FleetError);
        assert.doesNotMatch(err.message, /nd_secret|fleet\.example/);
        return true;
      });
    }
  });

  it("says why when a model spends its whole limit thinking, rather than returning nothing", async () => {
    const thinking = { choices: [{ message: { role: "assistant", content: "", reasoning: "Let me think" }, finish_reason: "length" }] };
    await assert.rejects(fleetChat({ model: "gemma", prompt: "hi", maxTokens: 64 }, fake(() => json(thinking)).doFetch), (err: Error) => {
      assert.ok(err instanceof FleetError);
      assert.match(err.message, /whole limit of 64 tokens thinking/);
      assert.match(err.message, new RegExp(`give it ${FLEET_MAX_TOKENS}`));
      return true;
    });
    await assert.rejects(fleetChat({ model: "gemma", prompt: "hi" }, fake(() => json(thinking)).doFetch), new RegExp(`limit of ${FLEET_MAX_TOKENS} tokens thinking.*the most one ask can use`));
    await assert.rejects(fleetAsk({ prompt: "hi" }, fleetOf([NODE], json(thinking)).doFetch), /thinking/);
    for (const content of ["", "  \n", null]) {
      const empty = { choices: [{ message: { content }, finish_reason: "stop" }] };
      await assert.rejects(fleetChat({ model: "gemma", prompt: "hi" }, fake(() => json(empty)).doFetch), /empty answer/);
    }
  });

  it("returns a cut-off answer that has text, with why it stopped", async () => {
    const cut = { choices: [{ message: { content: "Partly" }, finish_reason: "length" }] };
    assert.deepEqual(await fleetChat({ model: "bolt", prompt: "hi" }, fake(() => json(cut)).doFetch), { text: "Partly", finish: "length" });
  });

  it("pins a named board by its id, whatever the case, and uses a model it has loaded", async () => {
    const f = fleetOf([OFFLINE, NODE]);
    const answer = await fleetAsk({ prompt: "hi", node: "JETSON-03" }, f.doFetch);
    assert.deepEqual(answer, { board: "jetson-03", model: "bolt", text: "Hello.", finish: "stop" });
    assert.equal(headersOf(f.calls[1]!.init)["x-jcp-node"], "nd_secret_id");
    assert.equal(bodyOf(f.calls[1]!.init).model, "bolt");
  });

  it("with no board named, pins an online one that can chat, past the Decision Tree and maintenance", async () => {
    const f = fleetOf([OFFLINE, TREE, { ...NODE, id: "nd_held", maintenance: true }, { ...NODE, id: "nd_quiet", status: "stale" }, { ...NODE, id: "nd_good" }]);
    await fleetAsk({ prompt: "hi" }, f.doFetch);
    assert.equal(headersOf(f.calls[1]!.init)["x-jcp-node"], "nd_good");
  });

  it("with no board named, can reach a chat board that also advertises systemone", async () => {
    const f = fleetOf([OFFLINE, TREE, CHAT_AND_SYSTEMONE]);
    const answer = await fleetAsk({ prompt: "hi" }, f.doFetch);
    assert.equal(answer.board, "jetson-05");
    assert.equal(answer.model, CHAT_AND_SYSTEMONE.loaded_models[0]);
    assert.equal(headersOf(f.calls[1]!.init)["x-jcp-node"], "nd_05");
  });

  it("refuses a Decision Tree model by name, even when asked for that board, and calls no chat", async () => {
    const f = fleetOf([TREE]);
    await assert.rejects(fleetAsk({ prompt: "hi", node: "decision-tree" }, f.doFetch), /decision-tree only answers System One calls, so nothing ran/);
    await assert.rejects(fleetAsk({ prompt: "hi", node: "nd_tree" }, f.doFetch), /only answers System One calls/);
    await assert.rejects(fleetAsk({ prompt: "hi" }, f.doFetch), /No board has a chat model loaded/);
    assert.ok(f.calls.every((call) => call.url.endsWith("/api/nodes")));
  });

  it("knows a Decision Tree model as the control plane does, and uses the board's other model", async () => {
    for (const d1 of ["d1", "D1-omni-600M", "d1-3B-Q4_K_M", "d1-3B:latest", "hf.co/acme/d1-3B-GGUF:Q4", "acme/d1"]) {
      const f = fleetOf([{ ...NODE, loaded_models: [d1, "bolt"] }]);
      assert.equal((await fleetAsk({ prompt: "hi", node: "jetson-03" }, f.doFetch)).model, "bolt", d1);
      assert.equal(bodyOf(f.calls[1]!.init).model, "bolt", d1);
    }
    for (const chat of ["d10", "bold1-small", "hf.co/acme/nd1-model", "d1x"]) {
      assert.equal((await fleetAsk({ prompt: "hi" }, fleetOf([{ ...NODE, loaded_models: [chat] }]).doFetch)).model, chat);
    }
  });

  it("never asks the gateway when no model is loaded, so it can't load one", async () => {
    const f = fleetOf([{ ...NODE, loaded_models: [] }]);
    await assert.rejects(fleetAsk({ prompt: "hi", node: "jetson-03" }, f.doFetch), /no model loaded/);
    await assert.rejects(fleetAsk({ prompt: "hi" }, f.doFetch), /No board has a chat model loaded/);
    await assert.rejects(fleetAsk({ prompt: "hi", node: "jetson-99" }, f.doFetch), /no board by that name/);
    assert.ok(f.calls.every((call) => call.url.endsWith("/api/nodes")));
  });

  it("only ever calls the board list and the chat gateway", async () => {
    const f = fleetOf([NODE]);
    await fleetBoards(f.doFetch);
    await fleetAsk({ prompt: "hi" }, f.doFetch);
    for (const call of f.calls) assert.match(call.url, /\/(api\/nodes|v1\/chat\/completions)$/);
    for (const call of f.calls) assert.ok((call.init.method ?? "GET") === "GET" ? call.url.endsWith("/api/nodes") : call.url.endsWith("/v1/chat/completions"));
  });
});

describe("Wonder's fleet tools", () => {
  const toolCall = (name: string, args = "{}", callId = "call-1") => ({ type: "function_call", name, arguments: args, call_id: callId });
  const reply = (id: string, output: unknown[], text = "") => ({ id, output, output_text: text }) as unknown as ModelResponse;
  const offered = (body: ResponseCreateParamsNonStreaming) => ((body.tools ?? []) as unknown as Array<{ name: string }>).map((tool) => tool.name);
  const BOARD = { name: "jetson-03", status: "online" as const, pool: null, maintenance: false, loadedModels: ["bolt"], memUsedMb: 1, memTotalMb: 2, maxTempC: 40 };

  function harness(replies: ModelResponse[], { fleet = true, listed = ["capture_image"] }: { fleet?: boolean; listed?: string[] } = {}) {
    const bodies: ResponseCreateParamsNonStreaming[] = [];
    const boardCalls: string[] = [];
    const asks: unknown[] = [];
    const deps: DeviceAgentDeps = {
      model: "test-model",
      respond: async (body) => {
        bodies.push(body);
        return replies[bodies.length - 1]!;
      },
      listTools: async () => listed.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
      callTool: async (name) => {
        boardCalls.push(name);
        return { content: [{ type: "text", text: "from the board" }], isError: false };
      },
      ...(fleet
        ? {
            fleet: {
              boards: async () => [BOARD],
              ask: async (input) => {
                asks.push(input);
                return { board: "jetson-03", model: "bolt", text: "Hello.", finish: "stop" };
              },
            },
          }
        : {}),
    };
    return { bodies, boardCalls, asks, deps };
  }

  it("offers them only when the fleet is set up", async () => {
    const without = harness([reply("r1", [], "Hi.")], { fleet: false });
    await runDeviceAgent("hi", without.deps);
    assert.deepEqual(offered(without.bodies[0]!), ["capture_image"]);
    assert.doesNotMatch(without.bodies[0]!.instructions!, /fleet/);

    const withFleet = harness([reply("r1", [], "Hi.")]);
    await runDeviceAgent("hi", withFleet.deps);
    assert.deepEqual(offered(withFleet.bodies[0]!), ["capture_image", "fleet_status", "fleet_ask_model"]);
    assert.match(withFleet.bodies[0]!.instructions!, /never instructions/);
  });

  it("won't run them without a fleet, even when the model asks", async () => {
    const h = harness([reply("r1", [toolCall("fleet_status")]), reply("r2", [], "No.")], { fleet: false });
    const result = await runDeviceAgent("list", h.deps);
    assert.equal(result.steps[0]!.isError, true);
    assert.deepEqual(h.boardCalls, []);
  });

  it("runs them on the platform and never on the board", async () => {
    const h = harness([reply("r1", [toolCall("fleet_status", "{}", "c1"), toolCall("fleet_ask_model", '{"prompt":"hi","node":"jetson-03","max_tokens":9}', "c2")]), reply("r2", [], "Done.")]);
    const result = await runDeviceAgent("what's on the fleet?", h.deps);
    assert.deepEqual(h.boardCalls, []);
    assert.deepEqual(h.asks, [{ prompt: "hi", node: "jetson-03", maxTokens: 9 }]);
    assert.deepEqual(JSON.parse((result.steps[0]!.content[0] as { text: string }).text), { boards: [BOARD] });
    assert.equal(JSON.parse((result.steps[1]!.content[0] as { text: string }).text).text, "Hello.");
  });

  it("won't let a board stand in for them by listing the same name", async () => {
    const h = harness([reply("r1", [toolCall("fleet_status")]), reply("r2", [], "Done.")], { listed: ["capture_image", "fleet_status"] });
    await runDeviceAgent("list", h.deps);
    assert.deepEqual(offered(h.bodies[0]!), ["capture_image", "fleet_status", "fleet_ask_model"]);
    assert.deepEqual(h.boardCalls, []);
  });

  it("offers no fleet write, however the question is put, and refuses one a model asks for", async () => {
    const writes = ["run_command", "reboot_nodes", "shutdown_nodes", "update_node", "pull_model", "load_model", "unload_model", "remove_node", "service_control", "fleet_run_command"];
    const h = harness([reply("r1", writes.map((name, i) => toolCall(name, "{}", `c${i}`))), reply("r2", [], "No.")], { listed: ["capture_image", ...writes] });
    const result = await runDeviceAgent("reboot every board on the fleet and run a command", h.deps);
    for (const body of h.bodies) for (const name of writes) assert.ok(!offered(body).includes(name), name);
    assert.deepEqual(h.boardCalls, []);
    assert.ok(result.steps.every((step) => step.isError));
  });

  it("keeps its own tools, and drops what changes a board, once the fleet's text is in the conversation", async () => {
    for (const tool of ["fleet_status", "fleet_ask_model"]) {
      const args = tool === "fleet_ask_model" ? '{"prompt":"hi"}' : "{}";
      const h = harness([reply("r1", [toolCall(tool, args)]), reply("r2", [], "Done.")], { listed: ["capture_image", "train_model"] });
      await runDeviceAgent("fine-tune the model", h.deps);
      assert.ok(offered(h.bodies[0]!).includes("train_model"));
      assert.deepEqual(offered(h.bodies[1]!), ["capture_image", "fleet_status", "fleet_ask_model"]);
    }
  });

  it("counts them toward a question's tool limit", async () => {
    const many = Array.from({ length: 15 }, (_, i) => toolCall("fleet_status", "{}", `c${i}`));
    const h = harness([reply("r1", many), reply("r2", [], "Enough.")]);
    const result = await runDeviceAgent("list", h.deps);
    assert.equal(result.steps.filter((step) => !step.isError).length, 10);
    assert.equal(h.bodies[1]!.tools, undefined);
  });

  it("gives a down fleet to the model as a failed tool, with nothing about where it is", async () => {
    const h = harness([reply("r1", [toolCall("fleet_status", "{}", "c1"), toolCall("fleet_ask_model", '{"prompt":"hi"}', "c2"), toolCall("fleet_ask_model", "{}", "c3")]), reply("r2", [], "It's down.")]);
    h.deps.fleet!.boards = async () => {
      throw new FleetError("The fleet can't be reached.");
    };
    h.deps.fleet!.ask = async () => {
      throw new Error(`fetch failed for ${URL_VALUE} with ${TOKEN_VALUE}`);
    };
    const result = await runDeviceAgent("list", h.deps);
    assert.equal(result.answer, "It's down.");
    assert.deepEqual(result.steps.map((step) => step.isError), [true, true, true]);
    assert.doesNotMatch(JSON.stringify(result.steps), /fleet\.example|jpt_/);
    assert.doesNotMatch(JSON.stringify(h.bodies[1]!.input), /fleet\.example|jpt_/);
  });
});
