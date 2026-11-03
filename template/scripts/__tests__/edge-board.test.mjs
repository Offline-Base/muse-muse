// The board status line (lib/meta/board-status.ts, app/api/board-status/route.ts, components/BoardStatus.tsx) and
// board-only calls (`boardOnly` in lib/meta/edge.ts). No network: fetch is a fake. No model is asked anywhere here.
//   npx tsx --test template/scripts/__tests__/edge-board.test.mjs
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import { boardStatus, NOT_CONNECTED_LINE, statusOf } from "../../lib/meta/board-status";
import { BOARD_DOWN_MESSAGE, NO_BOARD_MESSAGE, respondJsonOrEdge, segmentOrEdge } from "../../lib/meta/edge";
import { SIMULATED_PHOTO } from "../edge-fake.mjs";

globalThis.React = React;
const { BoardStatus } = await import("../../components/BoardStatus");
const { GET } = await import("../../app/api/board-status/route");

const saved = { ...process.env };
const realFetch = globalThis.fetch;
const GATEWAY = "https://platform.example/api/gateway";
const EDGE = "http://127.0.0.1:11435/v1";
const SAM = "http://127.0.0.1:8790";
let calls;

/** Routes fake calls by URL start: each handler gets (url, init). Anything unrouted is refused. */
function fake(routes) {
  calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, auth: init?.headers?.authorization ?? null, method: init?.method ?? "GET" });
    const hit = Object.entries(routes).find(([start]) => url.startsWith(start));
    if (!hit) throw new TypeError("fetch failed: ECONNREFUSED");
    return hit[1](url, init);
  };
}
const refused = () => {
  throw new TypeError("fetch failed: ECONNREFUSED");
};
/** Never answers until the caller gives up. AbortSignal.timeout doesn't hold the event loop open, so this timer does. */
const hung = (_, init) =>
  new Promise((_, reject) => {
    const keep = setTimeout(() => {}, 5_000);
    init.signal.addEventListener("abort", () => {
      clearTimeout(keep);
      reject(new Error("aborted"));
    });
  });

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("EDGE_") || k === "TEST_MODEL") delete process.env[k];
  process.env.GATEWAY_URL = GATEWAY;
  process.env.PRODUCT_TOKEN = "tok_made_up";
  process.env.EDGE_TIMEOUT_MS = "300";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...saved };
});

describe("boardStatus", () => {
  test("no board set up: not connected, and it asks nothing at all", async () => {
    fake({});
    const s = await boardStatus();
    assert.equal(s.connected, false);
    assert.equal(s.line, NOT_CONNECTED_LINE);
    assert.match(s.detail, /No board is set up/);
    assert.deepEqual(calls, []);
  });

  test("EDGE_URL answering its model list: connected, named by EDGE_BOARD, with the key when there is one", async () => {
    process.env.EDGE_URL = `${EDGE}/`;
    process.env.EDGE_BOARD = "jetson-02";
    process.env.EDGE_API_KEY = "made-up";
    fake({ [`${EDGE}/models`]: () => Response.json({ data: [] }) });
    const s = await boardStatus();
    assert.deepEqual([s.connected, s.line, s.detail], [true, "Connected to jetson-02", null]);
    assert.deepEqual(calls.map((c) => [c.url, c.auth]), [[`${EDGE}/models`, "Bearer made-up"]]);
  });

  test("EDGE_URL refused, erroring or hung: not connected, and says the board didn't answer", async () => {
    process.env.EDGE_URL = EDGE;
    process.env.EDGE_BOARD = "jetson-02";
    for (const answer of [refused, () => new Response("no", { status: 502 }), hung]) {
      fake({ [EDGE]: answer });
      const s = await boardStatus({ timeoutMs: 50 });
      assert.deepEqual([s.connected, s.line, s.detail], [false, NOT_CONNECTED_LINE, "jetson-02 didn't answer just now."]);
    }
  });

  test("looks checks the sam3 service's /health, and only with looks", async () => {
    process.env.EDGE_SAM_URL = `${SAM}/segment`;
    process.env.EDGE_SAM_BOARD = "jetson-04";
    fake({ [`${SAM}/health`]: () => Response.json({ ok: true }) });
    assert.equal((await boardStatus()).line, NOT_CONNECTED_LINE, "without looks the SAM board isn't checked");
    assert.deepEqual(calls, []);
    const s = await boardStatus({ looks: true });
    assert.deepEqual([s.connected, s.line], [true, "Connected to jetson-04"]);
    fake({ [`${SAM}/health`]: () => Response.json({ ok: false }) });
    assert.equal((await boardStatus({ looks: true })).connected, false, "a health reply that isn't ok is down");
  });

  test("one side up and one down is not connected, and says which", async () => {
    process.env.EDGE_URL = EDGE;
    process.env.EDGE_BOARD = "jetson-02";
    process.env.EDGE_SAM_URL = SAM;
    process.env.EDGE_SAM_BOARD = "jetson-04";
    fake({ [`${EDGE}/models`]: () => Response.json({ data: [] }) });
    const s = await boardStatus({ looks: true });
    assert.deepEqual([s.connected, s.line, s.detail], [false, NOT_CONNECTED_LINE, "jetson-04 didn't answer just now. jetson-02 did."]);
  });

  test("a hosted product asks Muse Muse's fleet status route with its token; 401, 403 and 404 mean no board is set up", async () => {
    for (const [answer, want] of [
      [() => Response.json({ connected: true }), [true, "Connected to an office Jetson", null]],
      [() => Response.json({ connected: false }), [false, NOT_CONNECTED_LINE, "an office Jetson didn't answer just now."]],
      [() => Response.json({ error: { code: "unknown_endpoint" } }, { status: 404 }), [false, NOT_CONNECTED_LINE, "No board is set up for this copy, so its answers come from the cloud."]],
      [() => Response.json({ error: { code: "sam_not_allowed" } }, { status: 403 }), [false, NOT_CONNECTED_LINE, "No board is set up for this copy, so its answers come from the cloud."]],
      [() => new Response("bad gateway", { status: 502 }), [false, NOT_CONNECTED_LINE, "an office Jetson didn't answer just now."]],
    ]) {
      fake({ [`${GATEWAY}/fleet/v1/segment/status`]: answer });
      const s = await boardStatus({ looks: true });
      assert.deepEqual([s.connected, s.line, s.detail], want);
      assert.deepEqual(calls.map((c) => [c.url, c.auth, c.method]), [[`${GATEWAY}/fleet/v1/segment/status`, "Bearer tok_made_up", "GET"]]);
    }
  });

  test("statusOf joins the names of every side that answered", () => {
    const s = statusOf([
      { kind: "answer", board: "jetson-02", state: "connected" },
      { kind: "look", board: "jetson-02", state: "connected" },
    ]);
    assert.equal(s.line, "Connected to jetson-02");
    assert.equal(statusOf([{ kind: "look", board: "a", state: "not_set" }]).connected, false);
  });

  test("the route answers the status, with ?looks=1 adding the SAM board, never cached", async () => {
    process.env.EDGE_SAM_URL = SAM;
    process.env.EDGE_SAM_BOARD = "jetson-04";
    fake({ [`${SAM}/health`]: () => Response.json({ ok: true }) });
    const plain = await GET(new Request("http://product.test/api/board-status"));
    assert.equal(plain.headers.get("cache-control"), "no-store");
    assert.equal((await plain.json()).line, NOT_CONNECTED_LINE);
    assert.equal((await (await GET(new Request("http://product.test/api/board-status?looks=1"))).json()).line, "Connected to jetson-04");
  });
});

describe("BoardStatus", () => {
  test("renders a status line the drill can find before its check comes back", () => {
    const html = renderToStaticMarkup(React.createElement(BoardStatus, { looks: true }));
    assert.match(html, /data-board-status="checking"/);
    assert.match(html, /role="status"/);
    assert.match(html, /Checking for a board/);
    assert.match(html, /Check again/);
  });
});

describe("boardOnly", () => {
  const Reading = z.object({ status: z.enum(["normal", "warning", "alarm"]) });
  const ask = () => respondJsonOrEdge({ schema: Reading, schemaName: "reading", input: "Simulated reading", boardOnly: true });
  const chatOk = (text) => Response.json({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });

  test("with no board it says so, and never asks the cloud", async () => {
    fake({ [GATEWAY]: () => assert.fail("the cloud was asked") });
    const a = await ask();
    assert.deepEqual([a.ok, a.message, a.reasons.cloud.kind, a.reasons.edge.kind], [false, NO_BOARD_MESSAGE, "skipped", "not_set"]);
    const s = await segmentOrEdge({ image: SIMULATED_PHOTO, prompt: "open door", boardOnly: true, client: undefined });
    // A hosted product's look board is Muse Muse's fleet route: refused here, so the board is down, and the cloud isn't asked.
    assert.deepEqual([s.ok, s.message], [false, BOARD_DOWN_MESSAGE]);
    assert.ok(calls.every((c) => !c.url.startsWith(`${GATEWAY}/v1`)), "no cloud model call");
    process.env.EDGE_SAM_VIA_GATEWAY = "0";
    const none = await segmentOrEdge({ image: SIMULATED_PHOTO, prompt: "open door", boardOnly: true });
    assert.deepEqual([none.ok, none.message], [false, NO_BOARD_MESSAGE]);
  });

  test("with a board it answers from the board with the board's label, and a failing board is BOARD_DOWN_MESSAGE", async () => {
    process.env.EDGE_URL = EDGE;
    process.env.EDGE_BOARD = "jetson-02";
    process.env.EDGE_MODEL_NAME = "Muse Glimmer 30B one-bit";
    fake({ [GATEWAY]: () => assert.fail("the cloud was asked"), [EDGE]: () => chatOk(JSON.stringify({ status: "normal" })) });
    const a = await ask();
    assert.deepEqual(a, { ok: true, data: { status: "normal" }, by: "edge", label: "Answered on jetson-02, Muse Glimmer 30B one-bit", fellBack: null });
    fake({ [GATEWAY]: () => assert.fail("the cloud was asked"), [EDGE]: refused });
    const down = await ask();
    assert.deepEqual([down.ok, down.message, down.reasons.edge.kind], [false, BOARD_DOWN_MESSAGE, "refused"]);
  });
});
