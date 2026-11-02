// The outage drill kit: the fake edge server, the blackhole gateway and the drill runner, end to end on loopback
// against a tiny product server that uses lib/meta/edge.ts. No real model, no Meta call.
//   npx tsx --test template/scripts/__tests__/edge-drill.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { z } from "zod";
import { respondJsonOrEdge } from "../../lib/meta/edge";
import { startBlackhole } from "../edge-blackhole.mjs";
import { drillTarget, runDrills, SetupError } from "../edge-drill.mjs";
import { sampleFromSchema, startEdgeFake, tamper, TAMPER_MARK } from "../edge-fake.mjs";

const Status = z.object({
  status: z.enum(["normal", "warning", "alarm"]),
  trustController: z.boolean(),
  probeC: z.number().min(-40).max(60),
  likelyCause: z.string().min(3),
  actions: z.array(z.string()).min(1),
  escalate: z.boolean().optional(),
});
const jsonSchema = () => {
  const s = z.toJSONSchema(Status, { io: "output" });
  delete s.$schema;
  return s;
};

const saved = { ...process.env };
after(() => {
  process.env = { ...saved };
});

describe("the fake edge's replies", () => {
  test("a sample from the schema passes zod, and its tampered copy never does", () => {
    const sample = sampleFromSchema(jsonSchema());
    assert.equal(Status.safeParse(sample).success, true, JSON.stringify(sample));
    const bad = tamper(sample);
    assert.equal(Status.safeParse(bad).success, false);
    assert.ok(JSON.stringify(bad).includes(TAMPER_MARK));
  });

  test("each mode answers the way it says", async () => {
    const fake = await startEdgeFake({ port: 0, log: null });
    const chat = (signal) =>
      fetch(`${fake.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "Simulated" }], response_format: { type: "json_schema", json_schema: { name: "status", schema: jsonSchema() } } }),
        signal,
      });
    try {
      const ok = await (await chat()).json();
      assert.equal(Status.safeParse(JSON.parse(ok.choices[0].message.content)).success, true);
      fake.setMode("garbage");
      const garbage = (await (await chat()).json()).choices[0].message.content;
      assert.throws(() => JSON.parse(garbage));
      fake.setMode("refuse");
      await assert.rejects(chat());
      fake.setMode("hang");
      await assert.rejects(chat(AbortSignal.timeout(200)));
      const mode = await fetch(fake.url.replace(/\/v1$/, "/__mode"), { method: "POST", body: JSON.stringify({ mode: "ok" }) });
      assert.equal((await mode.json()).mode, "ok");
      assert.deepEqual(fake.requests.map((r) => r.outcome), ["answered", "garbage", "dropped", "hung"]);
      assert.equal(fake.requests[0].schemaName, "status");
    } finally {
      await fake.close();
    }
  });

  test("the fake writes its log where it is told", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "edge-fake-"));
    const log = path.join(dir, "caps/edge.json");
    const fake = await startEdgeFake({ port: 0, log });
    await fetch(`${fake.url}/responses`, { method: "POST", body: JSON.stringify({ model: "m", input: "Simulated" }) });
    await fake.close();
    const { readFileSync } = await import("node:fs");
    assert.equal(JSON.parse(readFileSync(log, "utf8"))[0].path, "/v1/responses");
  });
});

describe("the blackhole gateway", () => {
  test("refuses or hangs, and counts the attempts", async () => {
    const hole = await startBlackhole({ port: 0, log: null });
    try {
      await assert.rejects(fetch(`${hole.url}/v1/responses`, { method: "POST", body: "{}" }));
      hole.setMode("hang");
      await assert.rejects(fetch(`${hole.url}/v1/responses`, { method: "POST", body: "{}", signal: AbortSignal.timeout(200) }));
      assert.equal(hole.connections, 2);
    } finally {
      await hole.close();
    }
  });
});

describe("drillTarget", () => {
  test("reads env first, then edge-drill.json, and fails plainly with neither", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "edge-drill-"));
    assert.throws(() => drillTarget({}, dir), SetupError);
    writeFileSync(path.join(dir, "edge-drill.json"), JSON.stringify({ path: "/api/actions/status", body: { rows: "Simulated" } }));
    assert.deepEqual(drillTarget({}, dir), { path: "/api/actions/status", method: "POST", body: { rows: "Simulated" } });
    assert.equal(drillTarget({ EDGE_DRILL_PATH: "/api/x", EDGE_DRILL_BODY: "{\"a\":1}" }, dir).path, "/api/x");
  });
});

describe("runDrills against a product", () => {
  let fake;
  let hole;
  let product;
  let baseUrl;
  /** What the product route does with the helper's answer. Swapped per test. */
  let route;

  before(async () => {
    fake = await startEdgeFake({ port: 0, log: null });
    hole = await startBlackhole({ port: 0, log: null });
    for (const k of Object.keys(process.env)) if (k.startsWith("EDGE_") || k === "TEST_MODEL") delete process.env[k];
    process.env.GATEWAY_URL = hole.url;
    process.env.PRODUCT_TOKEN = "drill";
    process.env.EDGE_URL = fake.url;
    process.env.EDGE_BOARD = "jetson-0X";
    process.env.EDGE_MODEL_NAME = "Simulated model";
    process.env.EDGE_CLOUD_TIMEOUT_MS = "500";
    process.env.EDGE_TIMEOUT_MS = "2000";
    product = createServer(async (req, res) => {
      const out = await route();
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

  const target = { path: "/api/actions/status", method: "POST", body: { rows: "Simulated cold room rows" } };

  test("all four drills pass for a product that follows the skill", async () => {
    route = async () => {
      const a = await respondJsonOrEdge({ schema: Status, schemaName: "status", input: "Simulated cold room rows" });
      return a.ok ? { status: 200, json: { ...a.data, by: a.by, label: a.label } } : { status: 503, json: { message: a.message } };
    };
    const results = await runDrills({ baseUrl, target, fake, hole, hangMaxMs: 4000 });
    assert.deepEqual(results.map((r) => [r.name, r.pass, r.why]), [
      ["cloud refused", true, null],
      ["cloud hung", true, null],
      ["both down", true, null],
      ["tampered reply rejected", true, null],
    ]);
    assert.ok(results[1].ms >= 450, "the hung drill waited for the cloud deadline");
    assert.ok(hole.connections >= 3, "the product tried the cloud");
  });

  test("a product that shows no label or crashes fails by name", async () => {
    route = async () => ({ status: 500, json: { error: "TypeError: x is undefined" } });
    const results = await runDrills({ baseUrl, target, fake, hole, hangMaxMs: 4000 });
    assert.equal(results.every((r) => !r.pass), true);
    assert.match(results[0].why, /status 500/);
    assert.match(results[2].why, /no plain both-down message/);
  });

  test("a product that passes the edge reply through unchecked fails the tamper drill", async () => {
    route = async () => {
      const r = await fetch(`${fake.url}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [], response_format: { type: "json_schema", json_schema: { name: "status", schema: jsonSchema() } } }) }).catch(() => null);
      const text = r ? (await r.json()).choices[0].message.content : null;
      return text ? { status: 200, json: { ...JSON.parse(text), label: "Answered on jetson-0X, Simulated model" } } : { status: 503, json: { message: "Neither the cloud model nor the backup model answered just now." } };
    };
    const [tamperResult] = await runDrills({ baseUrl, target, fake, hole, only: [4] });
    assert.equal(tamperResult.pass, false);
    assert.match(tamperResult.why, /tampered reply reached the page/);
  });

  test("server error lines fail the both-down drill", async () => {
    route = async () => ({ status: 503, json: { message: "Neither the cloud model nor the backup model answered just now. Try again in a minute." } });
    const lines = [];
    const [both] = await runDrills({
      baseUrl,
      target,
      fake,
      hole,
      only: [3],
      product: {
        errors: () => {
          // The server prints its error while answering.
          if (lines.length === 0) setTimeout(() => lines.push("Error: Connection error."), 50);
          return lines;
        },
      },
    });
    assert.equal(both.pass, false);
    assert.match(both.why, /printed an error/);
  });
});
