/**
 * The live cap end to end, with nothing in the middle stood in except the sandbox: a product folder with the live overlay,
 * its real routes on a real HTTP server, the gateway's real handlers on PGlite on another origin, the template's real
 * Playwright config launching Chromium with the fake microphone, the real tests/caps/live.ts helpers in the real test
 * runner, a real EventSource across origins, then the real fixed checks against the gateway's own record.
 *
 * Meta is a stand-in here, unless LIVE_E2E_META=1 and MODEL_API_KEY are set, when the pieces go to the real Muse Voice
 * Transcribe (about $0.0005) and the fixture's words must come back.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/live/__tests__/e2e.scenario.test.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import * as realSchema from "@/lib/db/schema";
import { fakeGateway, TEST_TOKEN } from "@/lib/gateway/__tests__/helpers";

process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper-for-live";
process.env.LIVE_UPDATES = "1";

const ROOT = new URL("../../../../", import.meta.url).pathname;
const TEMPLATE = path.join(ROOT, "template");
const MODULES = path.join(TEMPLATE, "node_modules");
const realMeta = process.env.LIVE_E2E_META === "1" && Boolean(process.env.MODEL_API_KEY);
const canMock = typeof (mock as { module?: unknown }).module === "function";
const skip = !canMock ? "needs --experimental-test-module-mocks" : !existsSync(MODULES) ? "needs template/node_modules" : false;

const PAGE = `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CAPTIONS_NOTICE, useCaptions } from "@/lib/platform/captions";
import { useLive } from "@/lib/platform/live";

function App() {
  const { text, status, start, stop } = useCaptions();
  const live = useLive("scores", "shared");
  const [team, setTeam] = useState("");
  return (
    <main>
      <h1>Rowing day</h1>
      <p>{CAPTIONS_NOTICE}</p>
      <button onClick={start}>Start captions</button>
      <button onClick={stop}>Stop</button>
      <p>{status}</p>
      <p>{text}</p>
      <label>Team <input aria-label="Team" value={team} onChange={(e) => setTeam(e.target.value)} /></label>
      <button onClick={() => fetch("/api/actions/add", { method: "POST", body: JSON.stringify({ team }) })}>Add</button>
      <ul>{live.items.map((i) => <li key={i.id}>{i.data.team}</li>)}</ul>
    </main>
  );
}
createRoot(document.getElementById("root")).render(<App />);
`;

const SERVER = `
import http from "node:http";
import { readFileSync } from "node:fs";
import { POST as caption } from "./app/api/musemuse/live-caption/route.ts";
import { POST as ticket } from "./app/api/musemuse/live-ticket/route.ts";

const send = async (res, reply) => {
  const headers = {};
  reply.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(reply.status, headers);
  res.end(Buffer.from(await reply.arrayBuffer()));
};
const server = http.createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", async () => {
    const url = new URL(req.url, "http://localhost:" + server.address().port);
    const body = Buffer.concat(parts);
    const request = new Request(url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) });
    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<!doctype html><html lang="en"><title>Rowing</title><div id="root"></div><script src="/app.js"></script></html>'); }
    if (url.pathname === "/app.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(readFileSync("app.js")); }
    if (url.pathname === "/api/musemuse/live-caption") return send(res, await caption(request));
    if (url.pathname === "/api/musemuse/live-ticket") return send(res, await ticket(request));
    if (url.pathname === "/api/actions/add") {
      const saved = await fetch(process.env.GATEWAY_URL + "/data/scores?scope=shared", { method: "POST", headers: { authorization: "Bearer " + process.env.PRODUCT_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ data: JSON.parse(body.toString()) }) });
      res.writeHead(saved.status, { "content-type": "application/json" });
      return res.end(await saved.text());
    }
    res.writeHead(404);
    res.end();
  });
});
server.listen(0, "127.0.0.1", () => console.log("PORT " + server.address().port));
`;

const SPEC = `
import { test } from "@playwright/test";
import { checkCaptions, checkLiveUpdate } from "./caps/live";

test("captions and a shared board", async ({ page }) => {
  await page.goto("/");
  await checkCaptions(page, { start: "Start captions", stop: "Stop" });
  await checkLiveUpdate(page, {
    change: async (first) => {
      await first.getByLabel("Team").fill("Team Heron");
      await first.getByRole("button", { name: "Add" }).click();
    },
    shows: "Team Heron",
  });
});
`;

describe("the live cap, end to end", { skip }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let dir = "";
  let gateway: http.Server;
  let product: ReturnType<typeof spawn> | null = null;
  let productUrl = "";
  let gatewayUrl = "";
  let buildId = "";
  const transcripts: string[] = [];
  const hits: Record<string, number> = {};

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    const testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: path.join(ROOT, "drizzle") });
    (testDb as unknown as { batch: (q: PromiseLike<unknown>[]) => Promise<unknown[]> }).batch = async (queries) => {
      const out: unknown[] = [];
      for (const q of queries) out.push(await q);
      return out;
    };
    mock.module(new URL("../../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    const { handleLive } = await import("../handler");
    const { buildPreviewOrigin, liveChanges, liveProof } = await import("../store");
    const { handleData } = await import("@/lib/caps/data/handler");
    const { dataStore } = await import("@/lib/caps/data/store");
    const { handleCapsProof } = await import("@/lib/caps/proof");
    const { handleGateway } = await import("@/lib/gateway/handler");
    const store = await import("@/lib/gateway/store");
    const data = { collections: [{ name: "scores", scope: "shared", writes: "anyone" }], signIn: "none" };
    const [user] = await testDb.insert(realSchema.users).values({ email: "maker@example.com" }).returning();
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: user!.id }).returning();
    const [row] = await testDb.insert(realSchema.products).values({ slug: "rowing", name: "Rowing", ownerId: user!.id, status: "building" }).returning();
    const [build] = await testDb.insert(realSchema.builds).values({ inspirationId: muse!.id, userId: user!.id, productId: row!.id, brief: { data, live: { captions: true, updates: { collection: "scores" } } } as never }).returning();
    buildId = build!.id;
    const token = { id: "00000000-0000-4000-8000-00000000000b", productId: row!.id, scope: "build", allowedModels: ["muse-voice-transcribe-1.0", "cap:live", "cap:data"], dailyBudgetUsd: 10, buildId };
    const capProduct = { status: "building" as const, manifest: null, liveUrl: null, takenDownAt: null, ownerId: user!.id, ownerEmail: user!.email, ownerIsAdmin: false, ownerBannedAt: null };
    const gate = {
      servedCaps: () => ["data", "live"] as ("data" | "live")[],
      findToken: async (t: string) => (t === TEST_TOKEN ? token : null),
      product: async () => capProduct,
      adminEmails: [],
      hitRateLimits: store.hitRateLimits,
      acquireInFlight: store.acquireInFlight,
      releaseInFlight: store.releaseInFlight,
      rules: async () => data.collections as never,
    };
    const liveDeps = { ...gate, adjustCounter: store.adjustCounter, updatesOn: () => true, changes: liveChanges, buildPreviewOrigin };
    const dataDeps = { ...gate, reserveCounter: store.reserveCounter, store: dataStore, quotas: () => ({ productRows: 1000, productBytes: 1_000_000, dailyWrites: 1000 }), signInOn: () => false, platformUrl: "https://platform.example", productSlug: async () => "rowing" };
    const meta = fakeGateway({
      token: token as never,
      productStatus: "building",
      fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
        if (!realMeta) return Response.json({ transcript: `sample words ${transcripts.push("x")} here`, audioDurationMs: 2900 });
        const res = await fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${process.env.MODEL_API_KEY}` } });
        const body = (await res.json()) as { transcript?: string };
        transcripts.push(body.transcript ?? "");
        return Response.json(body, { status: res.status });
      }) as typeof fetch,
    });
    meta.deps.liveCaptions = { minutesPerDay: 10 };
    meta.deps.hitRateLimits = store.hitRateLimits;

    gateway = http.createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", async () => {
        const url = new URL(req.url!, gatewayUrl);
        const body = Buffer.concat(parts);
        const controller = new AbortController();
        res.on("close", () => controller.abort());
        const request = new Request(url, { method: req.method, headers: req.headers as Record<string, string>, signal: controller.signal, ...(body.length ? { body } : {}) });
        const rest = url.pathname.replace(/^\/api\/gateway\//, "").split("/").filter(Boolean);
        hits[rest[0]!] = (hits[rest[0]!] ?? 0) + 1;
        const reply =
          rest[0] === "live"
            ? await handleLive(request, rest.slice(1), liveDeps)
            : rest[0] === "data"
              ? await handleData(request, rest.slice(1), dataDeps as never)
              : rest[0] === "v1"
                ? await handleGateway(request, rest.slice(1), meta.deps)
                : rest[0] === "caps"
                  ? await handleCapsProof(request, { enabledCaps: () => ["live"], findToken: gate.findToken, productStatus: async () => "building", hitRateLimits: store.hitRateLimits, counters: { live: liveProof } })
                  : new Response("no", { status: 404 });
        const headers: Record<string, string> = {};
        reply.headers.forEach((v, k) => (headers[k] = v));
        res.writeHead(reply.status, headers);
        if (!reply.body) return res.end();
        const reader = reply.body.getReader();
        res.on("close", () => void reader.cancel().catch(() => undefined));
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done) break;
          res.write(Buffer.from(value!));
        }
        res.end();
      });
    });
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
    gatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}/api/gateway`;

    // The product folder, as provisioning lays it out.
    dir = mkdtempSync(path.join(tmpdir(), "mm-live-e2e-"));
    for (const f of ["tsconfig.json", "package.json", "playwright.config.ts"]) cpSync(path.join(TEMPLATE, f), path.join(dir, f));
    for (const d of ["lib", "tests"]) cpSync(path.join(TEMPLATE, d), path.join(dir, d), { recursive: true });
    cpSync(path.join(TEMPLATE, "caps/core/files"), dir, { recursive: true });
    cpSync(path.join(TEMPLATE, "caps/live/files"), dir, { recursive: true });
    symlinkSync(MODULES, path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "musemuse.caps.json"), JSON.stringify({ caps: ["live"], overlays: ["core", "live"] }));
    writeFileSync(path.join(dir, "tests/smoke.spec.ts"), SPEC);
    writeFileSync(path.join(dir, "server.mts"), SERVER);
    const esbuild = await import("esbuild");
    await esbuild.build({
      stdin: { contents: PAGE, loader: "tsx", resolveDir: dir, sourcefile: "page.tsx" },
      absWorkingDir: dir,
      bundle: true,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      outfile: path.join(dir, "app.js"),
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"development"' },
      alias: { "@": dir },
      plugins: [
        {
          name: "at",
          setup(b) {
            b.onResolve({ filter: /^@\// }, (args) => {
              for (const ext of [".ts", ".tsx"]) {
                const file = path.join(dir, args.path.slice(2) + ext);
                if (existsSync(file)) return { path: file };
              }
              return null;
            });
          },
        },
      ],
    });
    const tsx = new URL("../../../../node_modules/tsx/dist/esm/index.mjs", import.meta.url).pathname;
    product = spawn(process.execPath, ["--import", pathToFileURL(tsx).href, "server.mts"], { cwd: dir, env: { ...process.env, GATEWAY_URL: gatewayUrl, PRODUCT_TOKEN: TEST_TOKEN }, stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise<string>((resolve, reject) => {
      product!.stdout!.on("data", (c: Buffer) => {
        const m = c.toString().match(/PORT (\d+)/);
        if (m) resolve(m[1]!);
      });
      product!.on("exit", (code) => reject(new Error(`the product's server stopped (${code})`)));
    });
    productUrl = `http://localhost:${port}`;
  });

  after(async () => {
    product?.removeAllListeners("exit");
    product?.kill();
    gateway?.closeAllConnections?.();
    gateway?.close();
    await client?.close();
    delete process.env.LIVE_UPDATES;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("passes the real helpers and the real fixed checks", { timeout: 240_000 }, async (t) => {
    const since = new Date(Date.now() - 1000);
    const run = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(path.join(MODULES, ".bin/playwright"), ["test", "--project=smoke", "--reporter=line"], { cwd: dir, env: { ...process.env, MUSEMUSE_BASE_URL: productUrl, MUSEMUSE_SCREEN_CHECK: "warn" } });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      child.stderr.on("data", (c: Buffer) => (out += c.toString()));
      child.on("close", (code) => resolve({ code, out }));
    });
    if (/Executable doesn't exist/.test(run.out)) return t.skip("Chromium isn't installed");
    assert.equal(run.code, 0, run.out.slice(-3000));

    const record = JSON.parse(readFileSync(path.join(dir, "test-results/caps/live.json"), "utf8")) as { checks: Array<{ id: string; ok: boolean; detail?: string }> };
    assert.deepEqual(record.checks.map((c) => [c.id, c.ok]), [["notice", true], ["chunks", true], ["shown", true], ["live-update", true]]);
    assert.ok(existsSync(path.join(dir, "test-results/judge/10-captions.png")));
    assert.ok(existsSync(path.join(dir, "test-results/judge/11-second-browser-live.png")));
    const ms = Number(record.checks.find((c) => c.id === "live-update")!.detail!.match(/(\d+) ms/)![1]);
    assert.ok(ms < 5000, `${ms} ms`);
    console.log(`[live e2e] ${record.checks.map((c) => c.detail).join(" | ")}`);

    // The gateway's own record, read the way verify's caps step reads it, then the real checker.
    const res = await fetch(`${gatewayUrl}/caps/proof?since=${encodeURIComponent(since.toISOString())}`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    assert.equal(res.status, 200);
    const proof = (await res.json()) as { caps: { live: Record<string, number> } };
    console.log(`[live e2e] proof ${JSON.stringify(proof.caps.live)}`);
    assert.ok(proof.caps.live.chunks! >= 2 && proof.caps.live.chunks! <= 6, JSON.stringify(proof.caps.live));
    assert.ok(proof.caps.live.streams! >= 1);
    assert.ok(proof.caps.live.events! >= 1);
    const checker = (await import(pathToFileURL(path.join(dir, "scripts/caps/live.mjs")).href)) as { check(args: unknown): Promise<Array<{ id: string; ok: boolean; detail?: string }>> };
    const checks = await checker.check({ record, proof: proof.caps.live, root: dir });
    assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
    assert.deepEqual(checks.map((c) => c.id), ["notice", "chunks", "chunk-limit", "shown", "live-update"]);
    if (realMeta) {
      console.log(`[live e2e] real transcripts ${JSON.stringify(transcripts)}`);
      assert.match(transcripts.join(" ").toLowerCase(), /morning|welcome|lecture|rivers?|land|water/, "the fixture's own words came back");
    }
  });
});
