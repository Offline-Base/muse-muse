// The SAM half of the outage drill kit: the fake board SAM service in edge-fake.mjs, the blackhole's 404 mode, and the
// photo drills (12 to 16) and drill 11 in edge-drill.mjs, end to end on loopback against tiny product servers that use
// lib/meta/edge.ts. Each drill passes for a product that follows the skill and fails, by name, for one that gets it
// wrong. No real model, no Meta call.
//   npx tsx --test template/scripts/__tests__/edge-sam-drill.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { z } from "zod";
import { CLOUD_DECLINED_MESSAGE, respondJsonOrEdge, segmentOrEdge } from "../../lib/meta/edge";
import { startBlackhole } from "../edge-blackhole.mjs";
import { DEFAULT_SAM_DRILL_IDS, runDrills, SAM_DOWN_PHRASE, samDrillTarget, SetupError, withSimulatedPhoto } from "../edge-drill.mjs";
import { photoSize, samReply, SIMULATED_PHOTO, SIMULATED_PHOTO_PLACEHOLDER, startEdgeFake, TAMPER_MARK, TRUNCATE_MARK } from "../edge-fake.mjs";
import { serveBoard } from "./edge-board-kit.mjs";

/** The product's sample photo, as public/samples/ serves it. */
const SAMPLE_PATH = "/samples/door-open.png";

const saved = { ...process.env };
after(() => {
  process.env = { ...saved };
});
const b64 = SIMULATED_PHOTO.split(",")[1];

describe("the fake board SAM service", () => {
  test("answers in the board service's shape, sized to the photo, and every mode does what it says", async () => {
    const fake = await startEdgeFake({ port: 0, log: null });
    const segment = (body, signal) => fetch(`${fake.samUrl}/segment`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const ask = { image_b64: b64, prompt: "open door", threshold: 0.5 };
    try {
      const ok = await (await segment(ask)).json();
      assert.deepEqual(Object.keys(ok).sort(), ["count", "image_size", "ms", "objects", "prompt", "simulated"]);
      assert.equal(ok.prompt, "open door");
      assert.equal(ok.count, ok.objects.length);
      assert.deepEqual(ok.image_size, [4, 3]);
      assert.equal((await segment({ ...ask, threshold: 0.9 }).then((r) => r.json())).count, 1);
      assert.equal((await segment({ ...ask, image_b64: "bm90IGEgcGhvdG8=" })).status, 400);
      assert.equal((await segment({ ...ask, prompt: " " })).status, 400);
      fake.setMode("tamper");
      assert.ok((await (await segment(ask)).text()).includes(TAMPER_MARK));
      fake.setMode("garbage");
      assert.match(await (await segment(ask)).text(), /^<html>/);
      fake.setMode("truncate");
      const cut = await (await segment(ask)).text();
      assert.ok(cut.includes(TRUNCATE_MARK));
      assert.throws(() => JSON.parse(cut));
      fake.setMode("refuse");
      await assert.rejects(segment(ask));
      fake.setMode("hang");
      await assert.rejects(segment(ask, AbortSignal.timeout(200)));
      assert.deepEqual(fake.requests.map((r) => r.path), Array(9).fill("/segment"));
      assert.ok(fake.requests.every((r) => !JSON.stringify(r).includes(b64)), "the image is never logged");
    } finally {
      await fake.close();
    }
  });

  test("reads a PNG's size (edge-sam.test.mjs reads a JPEG's), and shrinks a big photo the way the board does", () => {
    assert.deepEqual(photoSize(Buffer.from(b64, "base64")), { width: 4, height: 3 });
    assert.equal(photoSize(Buffer.from("plain text")), null);
    const big = Buffer.from(b64, "base64");
    big.writeUInt32BE(3200, 16);
    big.writeUInt32BE(2400, 20);
    assert.deepEqual(samReply({ image_b64: big.toString("base64"), prompt: "door" }).json.image_size, [1600, 1200]);
  });
});

describe("the blackhole's notfound mode", () => {
  test("answers every request the way the gateway answers a model the token doesn't list", async () => {
    const hole = await startBlackhole({ port: 0, log: null, mode: "notfound" });
    try {
      const res = await fetch(`${hole.url}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "muse-wonder-1.0" }) });
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, "model_not_found");
      assert.equal(hole.requests, 1);
      assert.equal(hole.answered, 0, "a 404 isn't an answer");
    } finally {
      await hole.close();
    }
  });
});

describe("samDrillTarget", () => {
  test("reads env first, then edge-drill.json's sam, puts the Simulated photo in, and is null without either", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "edge-sam-drill-"));
    assert.equal(samDrillTarget({}, dir), null);
    writeFileSync(path.join(dir, "edge-drill.json"), JSON.stringify({ sam: { path: "/api/actions/look", body: { photo: SIMULATED_PHOTO_PLACEHOLDER, prompt: "open door", more: [SIMULATED_PHOTO_PLACEHOLDER] } } }));
    assert.deepEqual(samDrillTarget({}, dir), { path: "/api/actions/look", method: "POST", body: { photo: SIMULATED_PHOTO, prompt: "open door", more: [SIMULATED_PHOTO] }, sample: null });
    writeFileSync(path.join(dir, "edge-drill.json"), JSON.stringify({ sam: { path: "/api/actions/look", sample: "/samples/door-open.jpg" } }));
    assert.equal(samDrillTarget({}, dir).sample, "/samples/door-open.jpg");
    assert.equal(samDrillTarget({ EDGE_DRILL_SAM_SAMPLE: "/samples/other.png" }, dir).sample, "/samples/other.png");
    assert.equal(samDrillTarget({ EDGE_DRILL_SAM_PATH: "/api/x", EDGE_DRILL_SAM_BODY: '{"image":"SIMULATED_PHOTO"}' }, dir).body.image, SIMULATED_PHOTO);
    assert.equal(withSimulatedPhoto("SIMULATED_PHOTO_NOT"), "SIMULATED_PHOTO_NOT", "only the exact string");
  });
});

describe("the photo drills and drill 11, against a product", () => {
  let fake;
  let hole;
  let product;
  let baseUrl;
  /** What the product's routes do. Swapped per test. */
  let routes;

  before(async () => {
    fake = await startEdgeFake({ port: 0, log: null });
    hole = await startBlackhole({ port: 0, log: null });
    for (const k of Object.keys(process.env)) if (k.startsWith("EDGE_") || k === "TEST_MODEL") delete process.env[k];
    process.env.GATEWAY_URL = hole.url;
    process.env.PRODUCT_TOKEN = "drill";
    process.env.EDGE_URL = fake.url;
    process.env.EDGE_SAM_URL = fake.samUrl;
    process.env.EDGE_BOARD = "jetson-0X";
    process.env.EDGE_MODEL_NAME = "Simulated model";
    process.env.EDGE_SAM_MODEL_NAME = "simulated SAM";
    process.env.EDGE_CLOUD_TIMEOUT_MS = "500";
    process.env.EDGE_TIMEOUT_MS = "2000";
    process.env.EDGE_SAM_TIMEOUT_MS = "2000";
    product = createServer(async (req, res) => {
      if (req.url === SAMPLE_PATH) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from(SIMULATED_PHOTO.split(",")[1], "base64"));
        return;
      }
      if (req.url?.startsWith("/samples/") || req.url?.startsWith("/fixtures/")) {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      if (await serveBoard(req, res)) return;
      let raw = "";
      for await (const c of req) raw += c;
      const out = await (req.url === "/api/actions/look" ? routes.look : routes.status)(raw ? JSON.parse(raw) : {});
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
    await new Promise((r) => product.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${product.address().port}`;
  });
  after(async () => {
    await fake.close();
    await hole.close();
    await new Promise((r) => product.close(r));
  });

  const Status = z.object({ status: z.enum(["normal", "watch", "alert"]), actions: z.array(z.string()).min(1) });
  const target = { path: "/api/actions/status", method: "POST", body: {} };
  const samTarget = { path: "/api/actions/look", method: "POST", body: { photo: SIMULATED_PHOTO, prompt: "open door" }, sample: SAMPLE_PATH };
  /** What a product that follows the skill does with each helper. */
  const skill = {
    status: async () => {
      const a = await respondJsonOrEdge({ schema: Status, schemaName: "status", input: "Simulated cold room rows" });
      return a.ok ? { status: 200, json: { ...a.data, by: a.by, label: a.label } } : { status: 503, json: { message: a.message } };
    },
    look: async (body) => {
      const s = await segmentOrEdge({ image: body.photo, prompt: body.prompt });
      return s.ok ? { status: 200, json: { count: s.count, objects: s.objects, by: s.by, label: s.label } } : { status: 503, json: { message: s.message } };
    },
  };
  const opts = (extra) => ({ baseUrl, target, samTarget, fake, hole, hangMaxMs: 4000, ...extra });

  test("a product that follows the skill passes the four text drills, the four photo drills and the board and sample drills, in that order", async () => {
    routes = skill;
    const results = await runDrills(opts({}));
    assert.deepEqual(results.map((r) => [r.id, r.pass, r.why]), [
      [1, true, null],
      [2, true, null],
      [3, true, null],
      [4, true, null],
      [12, true, null],
      [13, true, null],
      [14, true, null],
      [15, true, null],
      [17, true, null],
      [18, true, null],
      [19, true, null],
    ]);
    assert.ok(results.find((r) => r.id === 13).ms >= 450, "the hung drill waited for the cloud deadline");
  });

  test("drills 11 and 16 pass with --all for the same product, and a product with no SAM route runs no photo drill", async () => {
    routes = skill;
    const picked = await runDrills(opts({ only: [11, 16] }));
    assert.deepEqual(picked.map((r) => [r.id, r.pass, r.why]), [
      [11, true, null],
      [16, true, null],
    ]);
    const textOnly = await runDrills(opts({ samTarget: null, only: undefined }));
    assert.deepEqual(textOnly.map((r) => r.id), [1, 2, 3, 4, 17, 18]);
  });

  test("the sample photo drill fails by name when edge-drill.json names none, it is outside public/samples/, or it isn't served", async () => {
    routes = skill;
    const why = async (sample) => (await runDrills(opts({ samTarget: { ...samTarget, sample }, only: [19] })))[0].why;
    assert.match(await why(null), /names no sample photo: add "sample": "\/samples\/<file>\.jpg" under "sam"/);
    assert.match(await why("/fixtures/door-open.png"), /isn't in public\/samples\//);
    assert.match(await why("/samples/missing.png"), /\/samples\/missing\.png: status 404/);
  });

  test("a product that only looks runs the photo drills alone", async () => {
    routes = skill;
    const results = await runDrills(opts({ target: null }));
    assert.deepEqual(results.map((r) => r.id), [...DEFAULT_SAM_DRILL_IDS, 17, 18, 19]);
    assert.ok(results.every((r) => r.pass));
  });

  test("picking a drill whose route the product doesn't name is a setup error, said plainly", async () => {
    await assert.rejects(runDrills(opts({ samTarget: null, only: [12] })), (err) => err instanceof SetupError && /photo route/.test(err.message));
    await assert.rejects(runDrills(opts({ target: null, only: [1] })), (err) => err instanceof SetupError && /a route/.test(err.message));
  });

  test("a product that treats a cloud 404 model_not_found as the cloud saying no fails drill 11 by name", async () => {
    routes = { ...skill, status: async () => ({ status: 503, json: { message: CLOUD_DECLINED_MESSAGE } }) };
    const [r] = await runDrills(opts({ only: [11] }));
    assert.equal(r.pass, false);
    assert.match(r.why, /setup error/);
  });

  test("a product that passes the board's reply through unchecked fails the tamper drill", async () => {
    routes = {
      ...skill,
      look: async (body) => {
        const r = await fetch(`${fake.samUrl}/segment`, { method: "POST", body: JSON.stringify({ image_b64: body.photo.split(",")[1], prompt: body.prompt }) }).catch(() => null);
        const json = r ? await r.json().catch(() => null) : null;
        return json ? { status: 200, json: { ...json, label: "Seen on jetson-0X by simulated SAM" } } : { status: 503, json: { message: `${SAM_DOWN_PHRASE}.` } };
      },
    };
    const [r] = await runDrills(opts({ only: [15] }));
    assert.equal(r.pass, false);
    assert.match(r.why, /tampered board reply reached the page/);
  });

  test("a product with no label, a made-up count, or a crash fails the photo drills by name", async () => {
    routes = { ...skill, look: async () => ({ status: 200, json: { count: 1 } }) };
    const results = await runDrills(opts({ only: [12, 14] }));
    assert.deepEqual(results.map((r) => r.pass), [false, false]);
    assert.match(results[0].why, /no "Seen on" label/);
    assert.match(results[1].why, /Can't see right now/);
    routes = { ...skill, look: async () => ({ status: 500, json: { error: "TypeError" } }) };
    const [crash] = await runDrills(opts({ only: [13] }));
    assert.match(crash.why, /status 500/);
  });

  test("a product that skips the cloud and asks only the board fails the two cloud drills", async () => {
    process.env.EDGE_FIRST = "1";
    try {
      routes = skill;
      const results = await runDrills(opts({ only: [12, 13] }));
      assert.deepEqual(results.map((r) => r.pass), [false, false]);
      for (const r of results) assert.match(r.why, /never tried the cloud/);
    } finally {
      delete process.env.EDGE_FIRST;
    }
  });
});
