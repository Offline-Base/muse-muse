// segmentOrEdge: Meta SAM 3.1 in the cloud first, then the board's SAM service, one test per failure type. No network:
// fetch is a fake. The cloud's stream carries one record from a real SAM 3.1 stream
// (lib/gateway/__tests__/fixtures/sam-stream.sse in the Muse Muse repo); the board's replies come from the drill kit's
// fake, in the shape the board's sam3 service answers (scripts/edge/sam3/server.py).
//   npx tsx --test template/scripts/__tests__/edge-sam.test.mjs
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  CLOUD_DECLINED_MESSAGE,
  SAM_BAD_PHOTO_MESSAGE,
  SAM_BAD_PROMPT_MESSAGE,
  SAM_DOWN_MESSAGE,
  samBoard,
  samBoardLabel,
  samCloudLabel,
  segmentOrEdge,
} from "../../lib/meta/edge";
import { samReply, samTampered, samTruncated, SIMULATED_PHOTO, TAMPER_MARK } from "../edge-fake.mjs";

const saved = { ...process.env };
const realFetch = globalThis.fetch;
const GATEWAY = "https://platform.example/api/gateway";
const BOARD = "http://127.0.0.1:8790";
let calls;

/** A PNG header that says `w` x `h`: all segmentOrEdge reads of a photo is its size, and the fakes read nothing more. */
function pngOf(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return `data:image/png;base64,${b.toString("base64")}`;
}
const PHOTO = pngOf(256, 256);
/** An 8 x 6 JPEG made with Pillow. */
const JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCtRRRXWcp//9k=";

/** One object from a real SAM 3.1 stream: box 59 to 197 inclusive on a 256 x 256 photo, confidence 0.91. */
const REAL_RECORD = (id, c) =>
  `${id}<|box;x1=59;y1=59;x2=197;y2=197;w=256;h=256;c=${c}|><|mask;x=0;y=0;c=${c};data=139,139,!!!!#&CocUv){Z[ZJJxSLdYztm!rF=DD$5]AWiOUr?bC.j)qfZ5=VkdBgc&=PUvqgU+fe@Jg@nSihOM$G5ap:Jgxvu!l@bWCj^L5?+\`ULzUy]y-SGA1^!!|>`;

/** The cloud's SSE for one look: `text` as SAM's output text, then response.completed. */
function cloudStream(text) {
  const lane = { item_id: "msg_1", output_index: 0, content_index: 0 };
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const body =
    ev("response.created", { response: { id: "resp_1", object: "response", status: "in_progress", output: [] } }) +
    ev("response.output_text.delta", { ...lane, delta: text }) +
    ev("response.output_text.done", { ...lane, text }) +
    ev("response.completed", { response: { id: "resp_1", object: "response", status: "completed", output: [], usage: { images_processed: 1, input_tokens: 0, output_tokens: 0 } } });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
/** One object at 0.91 and one at 0.3, which the 0.5 threshold drops. */
const cloudOk = () => cloudStream(`<0f>${REAL_RECORD(0, 0.91)},${REAL_RECORD(1, 0.3)}\n`);

const boardOk = (init, body) => {
  const r = samReply(body);
  return Response.json(r.json, { status: r.status });
};
const refused = () => {
  throw new TypeError("fetch failed: ECONNREFUSED");
};
/** Never answers; rejects when the caller gives up, the way a hung socket does. */
const hang = (init) =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
  });

/** Routes fake calls: `cloud` for the gateway, `board` for the SAM service. Each gets (init, body). */
function fake({ cloud = refused, board = refused }) {
  calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
    const body = raw ? JSON.parse(String(raw)) : null;
    const side = url.startsWith(GATEWAY) ? "cloud" : url.startsWith(BOARD) ? "board" : "other";
    calls.push({ side, url, body });
    return (side === "cloud" ? cloud : board)(init, body);
  };
}

const look = (extra = {}) => segmentOrEdge({ image: PHOTO, prompt: "open door", ...extra });

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("EDGE_") || k === "TEST_MODEL") delete process.env[k];
  process.env.GATEWAY_URL = GATEWAY;
  process.env.PRODUCT_TOKEN = "tok_made_up";
  process.env.EDGE_SAM_URL = BOARD;
  process.env.EDGE_SAM_BOARD = "jetson-0X";
  process.env.EDGE_CLOUD_TIMEOUT_MS = "300";
  process.env.EDGE_SAM_TIMEOUT_MS = "300";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...saved };
});

describe("segmentOrEdge, when someone can look", () => {
  test("the cloud looks first with sam-3.1, and the board is never asked", async () => {
    fake({ cloud: cloudOk, board: boardOk });
    const res = await look();
    assert.equal(res.ok, true);
    assert.equal(res.by, "cloud");
    assert.equal(res.label, "Seen in the cloud by Meta SAM 3.1");
    assert.equal(res.count, 1, "the 0.3 match is under the threshold");
    assert.deepEqual(res.objects, [{ box: { left: 0.2305, top: 0.2305, right: 0.7734, bottom: 0.7734 }, score: 0.91 }]);
    assert.deepEqual(res.imageSize, { width: 256, height: 256 });
    assert.equal(res.overlay, null);
    assert.equal(res.fellBack, null);
    assert.deepEqual(calls.map((c) => c.side), ["cloud"]);
    const sent = calls[0].body;
    assert.equal(sent.model, "sam-3.1");
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.metadata, { mask_encoding: "one_bit", include_confidence: "true" });
    const parts = sent.input[0].content;
    assert.deepEqual(parts[0], { type: "input_text", text: "open door" });
    assert.equal(parts[1].type, "input_image");
    assert.ok(parts[1].image_url.startsWith("data:image/png;base64,"));
  });

  test("cloud refused: the board answers in its own shape, with its fixed label and fractions of the photo", async () => {
    fake({ board: boardOk });
    const res = await look();
    assert.equal(res.ok, true);
    assert.equal(res.by, "board");
    assert.equal(res.label, "Seen on jetson-0X by Meta SAM 3.1");
    assert.equal(res.fellBack.kind, "refused");
    assert.equal(res.count, 2);
    assert.deepEqual(res.objects[0], { box: { left: 0.1, top: 0.2, right: 0.4, bottom: 0.7 }, score: 0.91 });
    const sent = calls.find((c) => c.side === "board");
    assert.equal(sent.url, `${BOARD}/segment`);
    assert.deepEqual(Object.keys(sent.body).sort(), ["image_b64", "overlay", "prompt", "threshold"]);
    assert.equal(sent.body.prompt, "open door");
    assert.equal(sent.body.threshold, 0.5);
    assert.equal(sent.body.overlay, false);
    assert.ok(!sent.body.image_b64.startsWith("data:"), "the service takes bare base64");
  });

  test("cloud hung: the board answers once the cloud's deadline passes", async () => {
    fake({ cloud: (init) => hang(init), board: boardOk });
    const started = Date.now();
    const res = await look();
    assert.equal(res.by, "board");
    assert.equal(res.fellBack.kind, "timeout");
    assert.ok(Date.now() - started < 3000);
  });

  test("a cloud 5xx, a stream that ends early or fails, or records it can't read, falls back to the board", async () => {
    const lane = { item_id: "msg_1", output_index: 0, content_index: 0 };
    const sse = (...events) => () => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    const clouds = [
      () => Response.json({ error: { message: "upstream" } }, { status: 503 }),
      sse({ type: "response.created", response: { id: "r", status: "in_progress" } }, { type: "response.output_text.delta", ...lane, delta: `<0f>${REAL_RECORD(0, 0.91)}\n` }),
      sse({ type: "response.created", response: { id: "r", status: "in_progress" } }, { type: "response.failed", response: { id: "r", status: "failed", error: { message: "Simulated" } } }),
      () => cloudStream("<0f>0<|box;x1=59|>\n"),
    ];
    for (const [i, cloud] of clouds.entries()) {
      fake({ cloud, board: boardOk });
      const res = await look();
      assert.equal(res.by, "board", `cloud ${i}`);
    }
  });

  test("a cloud 404 model_not_found is a setup error, not a refusal: the board answers", async () => {
    fake({ cloud: () => Response.json({ error: { type: "invalid_request_error", code: "model_not_found", message: "Not for this product." } }, { status: 404 }), board: boardOk });
    const res = await look();
    assert.equal(res.by, "board");
    assert.equal(res.fellBack.kind, "setup");
  });

  test("no gateway at all: the board answers, and nothing goes to the cloud", async () => {
    delete process.env.GATEWAY_URL;
    fake({ board: boardOk });
    const res = await look();
    assert.equal(res.by, "board");
    assert.equal(res.fellBack.kind, "not_set");
    assert.deepEqual(calls.map((c) => c.side), ["board"]);
  });

  test("EDGE_FIRST=1 asks the board first, and the cloud only when the board fails", async () => {
    process.env.EDGE_FIRST = "1";
    fake({ cloud: cloudOk, board: boardOk });
    assert.equal((await look()).by, "board");
    assert.deepEqual(calls.map((c) => c.side), ["board"]);
    fake({ cloud: cloudOk, board: refused });
    const second = await look();
    assert.equal(second.by, "cloud");
    assert.equal(second.fellBack.kind, "refused");
  });

  test("with no board, the cloud gets its full time instead of the short deadline", async () => {
    delete process.env.EDGE_SAM_URL;
    fake({ cloud: () => new Promise((r) => setTimeout(() => r(cloudOk()), 600)) });
    const res = await look();
    assert.equal(res.by, "cloud", "600 ms is past EDGE_CLOUD_TIMEOUT_MS, which only holds when a board waits behind");
  });

  test("a JPEG's size is read, a big photo shrunk by the board still fits, and the board's picture comes back on request", async () => {
    fake({ board: boardOk });
    const jpeg = await segmentOrEdge({ image: JPEG_B64, prompt: "door", overlay: true });
    assert.equal(jpeg.by, "board");
    assert.deepEqual(jpeg.imageSize, { width: 8, height: 6 });
    assert.equal(jpeg.overlay, `data:image/jpeg;base64,${JPEG_B64}`);
    const big = await segmentOrEdge({ image: pngOf(3200, 2400), prompt: "door" });
    assert.equal(big.by, "board");
    assert.deepEqual(big.imageSize, { width: 1600, height: 1200 });
    assert.deepEqual(big.objects[1].box, { left: 0.55, top: 0.25, right: 0.9, bottom: 0.8 });
    const simulated = await segmentOrEdge({ image: SIMULATED_PHOTO, prompt: "door" });
    assert.deepEqual(simulated.imageSize, { width: 4, height: 3 });
  });

  test("a threshold the call gives is used on both sides", async () => {
    fake({ board: boardOk });
    const res = await look({ threshold: 0.9 });
    assert.equal(res.count, 1);
    assert.equal(calls.find((c) => c.side === "board").body.threshold, 0.9);
    fake({ cloud: cloudOk });
    assert.equal((await look({ threshold: 0.2 })).count, 2);
  });
});

describe("segmentOrEdge, when nobody can look", () => {
  test("a cloud 4xx is the answer: the board is never asked around it", async () => {
    for (const status of [400, 401, 403, 429]) {
      fake({ cloud: () => Response.json({ error: { message: "no", code: "made_up" } }, { status }), board: boardOk });
      const res = await look();
      assert.equal(res.ok, false, `status ${status}`);
      assert.equal(res.message, CLOUD_DECLINED_MESSAGE);
      assert.equal(res.reasons.board.kind, "skipped");
      assert.deepEqual(calls.map((c) => c.side), ["cloud"]);
    }
  });

  test("both down: the plain can't-see message, and no count", async () => {
    for (const board of [refused, (init) => hang(init)]) {
      fake({ board });
      const res = await look();
      assert.equal(res.ok, false);
      assert.equal(res.by, null);
      assert.equal(res.message, SAM_DOWN_MESSAGE);
      assert.ok(SAM_DOWN_MESSAGE.startsWith("Can't see right now"));
      assert.equal("count" in res || "objects" in res, false);
    }
    assert.equal((await look()).reasons.board.kind, "timeout");
  });

  test("a board reply that is malformed, tampered or doesn't add up is the board being down", async () => {
    const good = (body) => samReply(body).json;
    const cases = [
      ["garbage", () => new Response("<html>502</html> looks shut", { headers: { "content-type": "text/html" } })],
      ["garbage", (init, body) => new Response(samTruncated(good(body)), { headers: { "content-type": "application/json" } })],
      ["schema", () => Response.json({ error: "out of GPU memory, try a smaller image" })],
      ["schema", () => Response.json(samTampered())],
      ["schema", (init, body) => Response.json({ ...good(body), count: 5 })],
      ["schema", (init, body) => Response.json({ ...good(body), prompt: "closed door" })],
      ["schema", (init, body) => Response.json({ ...good(body), image_size: [256, 100] })],
      ["schema", (init, body) => Response.json({ ...good(body), image_size: [512, 512] })],
      ["schema", (init, body) => Response.json({ ...good(body), objects: [{ box: [10, 10, 900, 20], score: 0.9 }], count: 1 })],
      ["schema", (init, body) => Response.json({ ...good(body), objects: [{ box: [10, 10, 20, 20], score: 0.1 }], count: 1 })],
      ["schema", (init, body) => Response.json({ ...good(body), objects: [{ box: [10, 10, 20, 20], score: "0.9" }], count: 1 })],
      ["http", () => Response.json({ error: "out of GPU memory, try a smaller image" }, { status: 503 })],
      ["http", () => Response.json({ error: "bad request" }, { status: 400 })],
    ];
    for (const [kind, board] of cases) {
      fake({ board });
      const res = await look();
      assert.equal(res.ok, false, String(board));
      assert.equal(res.message, SAM_DOWN_MESSAGE);
      assert.equal(res.reasons.board.kind, kind, String(board));
      assert.ok(!JSON.stringify(res).includes(TAMPER_MARK));
    }
    fake({ board: (init, body) => Response.json({ ...good(body), overlay_jpeg_b64: "PGh0bWw+" }) });
    const picture = await look({ overlay: true });
    assert.equal(picture.ok, false, "a picture that isn't a JPEG");
  });

  test("a photo it can't read, or no prompt, asks nobody", async () => {
    fake({ cloud: cloudOk, board: boardOk });
    for (const image of ["", "not base64 at all!", "data:image/gif;base64,R0lGODlhAQABAAAAACw=", Buffer.from("plain text").toString("base64"), null]) {
      const res = await segmentOrEdge({ image, prompt: "door" });
      assert.equal(res.ok, false);
      assert.equal(res.message, SAM_BAD_PHOTO_MESSAGE);
      assert.equal(res.reasons.cloud.kind, "input");
    }
    for (const prompt of ["", "   ", "x".repeat(201)]) {
      const res = await segmentOrEdge({ image: PHOTO, prompt });
      assert.equal(res.message, SAM_BAD_PROMPT_MESSAGE);
    }
    assert.deepEqual(calls, []);
  });
});

describe("the SAM board's settings and labels", () => {
  test("EDGE_SAM_URL takes a base URL or the /segment URL, and only http or https", () => {
    process.env.EDGE_SAM_URL = "http://127.0.0.1:8790/";
    assert.equal(samBoard().url, "http://127.0.0.1:8790/segment");
    process.env.EDGE_SAM_URL = "http://127.0.0.1:8790/segment";
    assert.equal(samBoard().url, "http://127.0.0.1:8790/segment");
    for (const bad of ["ftp://127.0.0.1/", "not a url", ""]) {
      process.env.EDGE_SAM_URL = bad;
      assert.equal(samBoard(), null, bad);
    }
  });

  test("an EDGE_SAM_URL that isn't a URL is named as such, and the cloud still looks", async () => {
    process.env.EDGE_SAM_URL = "ftp://nowhere";
    fake({});
    const res = await look();
    assert.equal(res.reasons.board.kind, "not_set");
    assert.match(res.reasons.board.detail, /not an http or https URL/);
  });

  test("the label's names come from EDGE_SAM_BOARD, then EDGE_BOARD, then a plain default", () => {
    assert.equal(samBoardLabel(samBoard()), "Seen on jetson-0X by Meta SAM 3.1");
    delete process.env.EDGE_SAM_BOARD;
    process.env.EDGE_BOARD = "a simulated board";
    process.env.EDGE_SAM_MODEL_NAME = "a fake SAM service";
    assert.equal(samBoardLabel(samBoard()), "Seen on a simulated board by a fake SAM service");
    delete process.env.EDGE_BOARD;
    delete process.env.EDGE_SAM_MODEL_NAME;
    assert.equal(samBoardLabel(samBoard()), "Seen on the board by Meta SAM 3.1");
    assert.equal(samCloudLabel(), "Seen in the cloud by Meta SAM 3.1");
  });

  test("nothing it writes has an em dash", () => {
    for (const s of [SAM_DOWN_MESSAGE, SAM_BAD_PHOTO_MESSAGE, SAM_BAD_PROMPT_MESSAGE, samCloudLabel()]) assert.equal(s.includes("—"), false);
  });
});
