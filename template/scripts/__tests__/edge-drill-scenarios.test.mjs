// The scenario drills that --all adds to the text route (5 to 11; the photo drills are in edge-sam-drill.test.mjs), end
// to end on loopback against tiny product servers that use lib/meta/edge.ts. Each drill passes for a product that
// follows the skill and fails, by name, for one that gets it wrong. No real model, no Meta call, and no DNS query:
// drill 10's lookups fail in this process.
//   npx tsx --test --experimental-test-module-mocks template/scripts/__tests__/edge-drill-scenarios.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import dns from "node:dns";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { z } from "zod";
import { respondJsonOrEdge } from "../../lib/meta/edge";
import { startBlackhole } from "../edge-blackhole.mjs";
import { blockInvalidHosts, DEFAULT_DRILL_IDS, DNS_DRILL_HOST, noDnsImport, runDrills, SetupError } from "../edge-drill.mjs";
import { INJECT_MARK, injectionText, sampleWithText, startEdgeFake, truncatedText, TRUNCATE_MARK } from "../edge-fake.mjs";

const Status = z.object({
  status: z.enum(["normal", "warning", "alarm"]),
  trustController: z.boolean(),
  probeC: z.number().min(-40).max(60),
  likelyCause: z.string().min(3),
  actions: z.array(z.string()).min(1),
});
const jsonSchema = () => {
  const s = z.toJSONSchema(Status, { io: "output" });
  delete s.$schema;
  return s;
};

const saved = { ...process.env };
const target = { path: "/api/actions/status", method: "POST", body: { rows: "Simulated cold room rows" } };
const LIMITS = { hangMaxMs: 4000, cloudLimitMs: 500, edgeLimitMs: 2000, slowMs: 300 };

/** What a product that follows the skill does: the helper's answer with its fixed label, or its plain message. */
async function skillRoute() {
  const a = await respondJsonOrEdge({ schema: Status, schemaName: "status", input: "Simulated cold room rows" });
  return a.ok ? { status: 200, json: { ...a.data, by: a.by, label: a.label } } : { status: 503, json: { message: a.message } };
}

/** Runs `fn` with some env set, then puts it back. */
async function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("the new fake modes", () => {
  test("truncate never parses and carries its mark; inject is schema-valid with the planted text in free fields only", () => {
    const cut = truncatedText(jsonSchema());
    assert.throws(() => JSON.parse(cut));
    assert.ok(cut.includes(TRUNCATE_MARK));
    const planted = sampleWithText(jsonSchema(), injectionText("http://127.0.0.1:1"));
    assert.equal(Status.safeParse(planted).success, true, JSON.stringify(planted));
    assert.equal(planted.status, "normal");
    assert.ok(planted.likelyCause.startsWith(INJECT_MARK));
    assert.ok(planted.actions[0].includes("<script>"));
  });

  test("slow answers only after its delay, and a mode change ends a reply still waiting", async () => {
    const fake = await startEdgeFake({ port: 0, log: null });
    const chat = (signal) =>
      fetch(`${fake.url}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "m", messages: [], response_format: { type: "json_schema", json_schema: { name: "status", schema: jsonSchema() } } }),
        signal,
      });
    try {
      fake.setMode("slow", { delayMs: 300 });
      const t = Date.now();
      const ok = await (await chat()).json();
      assert.ok(Date.now() - t >= 280);
      assert.equal(Status.safeParse(JSON.parse(ok.choices[0].message.content)).success, true);
      const waiting = chat();
      await new Promise((r) => setTimeout(r, 50));
      fake.setMode("ok");
      await assert.rejects(waiting);
    } finally {
      await fake.close();
    }
  });
});

describe("the gateway stand-in's answer modes", () => {
  test("slow answers schema-valid JSON after its delay; flap goes 503, OK, 503; refuse and hang still never answer", async () => {
    const hole = await startBlackhole({ port: 0, log: null });
    const call = (signal) =>
      fetch(`${hole.url}/v1/responses`, {
        method: "POST",
        body: JSON.stringify({ model: "muse-wonder-1.0", input: "Simulated", text: { format: { type: "json_schema", name: "status", schema: jsonSchema() } } }),
        signal,
      });
    try {
      hole.setMode("slow", { delayMs: 200 });
      const t = Date.now();
      const slow = await (await call()).json();
      assert.ok(Date.now() - t >= 180);
      assert.equal(Status.safeParse(JSON.parse(slow.output_text)).success, true);
      hole.setMode("flap");
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await call()).status);
      assert.deepEqual(statuses, [503, 200, 503]);
      assert.equal(hole.answered, 2);
      hole.setMode("refuse");
      await assert.rejects(call());
      hole.setMode("hang");
      await assert.rejects(call(AbortSignal.timeout(200)));
    } finally {
      await hole.close();
    }
  });
});

describe("the no-DNS preload", () => {
  test("fails only .invalid lookups, with ENOTFOUND, and undoes cleanly", async () => {
    const undo = blockInvalidHosts(dns);
    try {
      const err = await fetch(`http://${DNS_DRILL_HOST}:18436/v1/responses`).catch((e) => e);
      assert.equal(err.cause?.code, "ENOTFOUND");
      await assert.rejects(dns.promises.lookup(DNS_DRILL_HOST), { code: "ENOTFOUND" });
      assert.ok((await dns.promises.lookup("localhost")).address);
    } finally {
      undo();
    }
    assert.match(noDnsImport(), /^--import=data:text\/javascript;base64,[A-Za-z0-9+/=]+$/);
  });

  test("a .invalid fetch goes through the patch and never reaches the resolver underneath", async () => {
    const real = dns.lookup;
    let reached = 0;
    let reported = 0;
    dns.lookup = function () {
      reached++;
      return real.apply(this, arguments);
    };
    const undo = blockInvalidHosts(dns, () => reported++);
    try {
      const err = await fetch(`http://${DNS_DRILL_HOST}:18436/v1/responses`).catch((e) => e);
      assert.equal(err.cause?.code, "ENOTFOUND");
      assert.equal(reached, 0, "the lookup reached the resolver");
      assert.equal(reported, 1);
    } finally {
      undo();
      dns.lookup = real;
    }
  });

  test("as a preload in another process, it fails the lookup and reports the host", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "edge-drill-dns-"));
    const report = path.join(dir, "dns.log");
    try {
      const child = `import dns from "node:dns"; const e = await fetch("http://${DNS_DRILL_HOST}:18436/x").catch((x) => x); console.log(e.cause?.code, dns.lookup.name === "");`;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", child], { env: { PATH: process.env.PATH, NODE_OPTIONS: noDnsImport(report) }, encoding: "utf8", timeout: 20_000 });
      assert.equal(r.stdout.trim(), "ENOTFOUND true", r.stderr);
      assert.equal(readFileSync(report, "utf8"), `${DNS_DRILL_HOST}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runDrills: the six scenarios", () => {
  let fake;
  let hole;
  let product;
  let dnsProduct;
  let baseUrl;
  let dnsUrl;
  let undoDns;
  /** Lookups of a .invalid host made in this process, as drill 10's preload reports them in a product. */
  let lookups = 0;
  /** What the product route does with the helper's answer. Swapped per test. */
  let route;

  before(async () => {
    undoDns = blockInvalidHosts(dns, () => lookups++);
    fake = await startEdgeFake({ port: 0, log: null });
    hole = await startBlackhole({ port: 0, log: null });
    for (const k of Object.keys(process.env)) if (k.startsWith("EDGE_") || k === "TEST_MODEL") delete process.env[k];
    process.env.GATEWAY_URL = hole.url;
    process.env.PRODUCT_TOKEN = "drill";
    process.env.EDGE_URL = fake.url;
    process.env.EDGE_BOARD = "jetson-0X";
    process.env.EDGE_MODEL_NAME = "Simulated model";
    process.env.EDGE_CLOUD_TIMEOUT_MS = String(LIMITS.cloudLimitMs);
    process.env.EDGE_TIMEOUT_MS = String(LIMITS.edgeLimitMs);
    const serve = (gateway) =>
      createServer(async (req, res) => {
        const out = await withEnv(gateway ? { GATEWAY_URL: gateway } : {}, () => route());
        res.writeHead(out.status, { "content-type": out.type ?? "application/json" });
        res.end(out.type?.includes("html") ? out.body : JSON.stringify(out.json));
      });
    product = serve(null);
    // Drill 10's product: the same route, with a gateway host that can't be resolved.
    dnsProduct = serve(`http://${DNS_DRILL_HOST}:${hole.port}`);
    await new Promise((r) => product.listen(0, "127.0.0.1", r));
    await new Promise((r) => dnsProduct.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${product.address().port}`;
    dnsUrl = `http://127.0.0.1:${dnsProduct.address().port}`;
  });
  after(async () => {
    await fake.close();
    await hole.close();
    await new Promise((r) => product.close(r));
    await new Promise((r) => dnsProduct.close(r));
    undoDns();
    process.env = { ...saved };
  });

  const dnsLookups = () => lookups;
  const drill = (only, extra = {}) => runDrills({ baseUrl, target, fake, hole, ...LIMITS, dnsBase: async () => dnsUrl, dnsLookups, only, ...extra });

  test("without --all only the default four run; with it all eleven text drills pass for a product that follows the skill", async () => {
    route = skillRoute;
    assert.deepEqual(DEFAULT_DRILL_IDS, [1, 2, 3, 4]);
    const plain = await runDrills({ baseUrl, target, fake, hole, ...LIMITS, dnsBase: async () => dnsUrl });
    assert.deepEqual(plain.map((r) => r.id), [1, 2, 3, 4]);
    const results = await runDrills({ baseUrl, target, fake, hole, ...LIMITS, dnsBase: async () => dnsUrl, dnsLookups, all: true });
    assert.deepEqual(results.map((r) => [r.id, r.pass, r.why]), [
      [1, true, null],
      [2, true, null],
      [3, true, null],
      [4, true, null],
      [5, true, null],
      [6, true, null],
      [7, true, null],
      [8, true, null],
      [9, true, null],
      [11, true, null],
      [10, true, null],
    ]);
    for (const r of results.slice(4)) {
      assert.ok(r.name && r.about?.startsWith("Simulated: "), `drill ${r.id} has a name and a one-line description`);
      assert.ok(!r.about.includes("\n") && !r.about.includes("\u2014"));
    }
    for (const r of results.slice(0, 4)) assert.equal("about" in r, false, "the default four's results keep their shape");
    assert.ok(results[4].ms >= LIMITS.slowMs - 20, "the slow drill waited for the cloud");
  });

  test("5. a product that gives the cloud less time than it takes falls back and fails", async () => {
    route = skillRoute;
    const [r] = await withEnv({ EDGE_CLOUD_TIMEOUT_MS: "100" }, () => drill([5]));
    assert.equal(r.pass, false);
    assert.match(r.why, /fell back to the edge although the cloud answered inside its limit/);
  });

  test("6. a product that keeps the first answer's label fails the flapping drill on answer 2", async () => {
    let first = null;
    route = async () => {
      const out = await skillRoute();
      if (out.status === 200) out.json.label = first ??= out.json.label;
      return out;
    };
    const [r] = await drill([6]);
    assert.equal(r.pass, false);
    assert.match(r.why, /^answer 2 of 3 came from the cloud but its label doesn't say so/);
  });

  test("7. a product that waits too long on the edge shows the late answer and fails", async () => {
    route = skillRoute;
    const [r] = await withEnv({ EDGE_TIMEOUT_MS: "20000" }, () => drill([7]));
    assert.equal(r.pass, false);
    assert.match(r.why, /waited past its edge limit and showed the late answer/);
  });

  test("8. a product that shows the raw edge text when it doesn't parse fails the truncated drill", async () => {
    route = async () => {
      const res = await fetch(`${fake.url}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [], response_format: { type: "json_schema", json_schema: { name: "status", schema: jsonSchema() } } }) });
      const text = (await res.json()).choices[0].message.content;
      try {
        return { status: 200, json: { ...JSON.parse(text), label: "Answered on jetson-0X, Simulated model" } };
      } catch {
        return { status: 200, json: { text, label: "Answered on jetson-0X, Simulated model" } };
      }
    };
    const [r] = await drill([8]);
    assert.equal(r.pass, false);
    assert.match(r.why, /truncated reply reached the page/);
  });

  test("9. a product that follows the planted text, lets it write the label, or puts it in HTML unescaped fails", async () => {
    const answer = async () => respondJsonOrEdge({ schema: Status, schemaName: "status", input: "Simulated cold room rows" });
    route = async () => {
      const a = await answer();
      // Follows links in the model's text.
      for (const url of JSON.stringify(a.data).match(/http:\/\/127\.0\.0\.1:\d+\/__injected/g) ?? []) await fetch(url);
      return { status: 200, json: { ...a.data, label: a.label } };
    };
    const [followed] = await drill([9]);
    assert.match(followed.why ?? "", /fetched the URL the injected text asked for/);
    route = async () => {
      const a = await answer();
      return { status: 200, json: { ...a.data, label: a.data.likelyCause } };
    };
    const [relabeled] = await drill([9]);
    assert.match(relabeled.why ?? "", /label no longer says the edge answered/);
    route = async () => {
      const a = await answer();
      return { status: 200, type: "text/html", body: `<p>${a.label}</p><p>${a.data.actions[0]}</p>` };
    };
    const [unescaped] = await drill([9]);
    assert.match(unescaped.why ?? "", /<script> tag reached the page unescaped/);
    route = async () => {
      const a = await answer();
      const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return { status: 200, type: "text/html", body: `<p>${esc(a.label)}</p><p>${esc(a.data.actions[0])}</p>` };
    };
    const [escaped] = await drill([9]);
    assert.equal(escaped.pass, true, escaped.why);
  });

  test("10. a product with no backup set up fails when the gateway host isn't found, and the drill says when it can't run", async () => {
    route = () => withEnv({ EDGE_URL: "" }, skillRoute);
    const [r] = await drill([10]);
    assert.equal(r.pass, false);
    assert.match(r.why, /status 503/);
    route = skillRoute;
    const [noDns] = await drill([10], { dnsBase: null });
    assert.equal(noDns.pass, false);
    assert.match(noDns.why, /run with --start, or set EDGE_DRILL_DNS_BASE_URL/);
    const [wrongProduct] = await drill([10], { dnsBase: async () => baseUrl });
    assert.match(wrongProduct.why ?? "", /the host name did resolve/);
  });

  test("10. a product that asks the edge first never tries the gateway's name and fails", async () => {
    route = () => withEnv({ EDGE_FIRST: "1" }, skillRoute);
    const [r] = await drill([10]);
    assert.equal(r.pass, false);
    assert.match(r.why, /never tried the cloud first/);
  });

  test("an --only with no known drill is a setup error, not 0 of 0 passed", async () => {
    route = skillRoute;
    for (const only of [[17], [Number.NaN], []]) await assert.rejects(drill(only), SetupError);
  });
});
