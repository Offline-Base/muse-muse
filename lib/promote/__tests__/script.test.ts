/**
 * scripts/promote-local.ts's promote() for one product, read from PGlite with the repo's migrations and the fixture's
 * rows, its files in a temp folder, with the live site (fetch) and the Blob upload faked. The live site checks the
 * bundle before any file is uploaded, so one it refuses uploads nothing. The files go up only once it would take the
 * bundle, and before the rows that point at them are sent. A product it already has gets nothing uploaded and is
 * published again only with --republish. A dry run makes no calls. Nothing reaches the network or Blob.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/promote/__tests__/script.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";
import { findLocalFileUrls, localFileKeyOf, toBundle, type LocalRows } from "../local";
import { LOCAL, sampleRows, STORE } from "./fixtures";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const TO = "https://muse.example.com";
const AUTOMATION = "automation-secret-for-tests";

type Script = typeof import("../../../scripts/promote-local");
type Answer = { status: number; body: unknown };

let client: import("@electric-sql/pglite").PGlite;
let local: import("../../../scripts/promote-local").LocalDb;
let script: Script;
let filesDir = "";
let rows: LocalRows;
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };

/** What the faked live site has and answers. */
let live: { product: { status: string; liveUrl: string | null } | null; check: Answer; import: Answer; republish: Answer };
/** Everything the script did, in order: "GET", "POST check", "upload <key>", "POST import" and so on. */
let log: string[] = [];
/** The bundles it POSTed, in order. */
let sent: unknown[] = [];

const opts = (over: Partial<import("../../../scripts/promote-local").Options> = {}) => ({
  db: ".data/pglite",
  slugs: ["bird-count"],
  to: TO,
  files: filesDir,
  storeId: "store_8A701wVtiqVp1x3e",
  republish: false,
  dryRun: false,
  ...over,
});

/** The keys of the files the rows point at, written under `dir` the way a local run stores them. */
async function writeFiles(r: LocalRows, dir: string): Promise<string[]> {
  const keys = findLocalFileUrls(toBundle(r)).map((url) => localFileKeyOf(url)!);
  for (const key of keys) {
    for (const [part, text] of [
      ["data", `the bytes of ${key}`],
      ["types", key.endsWith(".mp4") ? "video/mp4" : "application/octet-stream"],
    ] as const) {
      await mkdir(path.dirname(path.join(dir, part, key)), { recursive: true });
      await writeFile(path.join(dir, part, key), text);
    }
  }
  return keys;
}

describe("promote-local", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    local = drizzle({ client, schema: realSchema });
    await migrate(local, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    filesDir = await mkdtemp(path.join(tmpdir(), "promote-local-"));
    process.env.AUTOMATION_SECRET = AUTOMATION;

    // Uploads go through the live site's presigned URLs: each asks its upload route with the automation secret.
    const realClient = await import("@vercel/blob/client");
    mock.module("@vercel/blob/client", {
      namedExports: {
        ...realClient,
        uploadPresigned: async (pathname: string, _body: unknown, o: { access: string; handleUploadUrl: string; headers?: Record<string, string> }) => {
          assert.equal(o.access, "public");
          assert.equal(o.handleUploadUrl, `${TO}/api/admin/import-product/upload`);
          assert.equal(o.headers?.authorization, `Bearer ${AUTOMATION}`);
          log.push(`upload ${pathname}`);
          return { url: `${STORE}/${pathname}`, pathname };
        },
      },
    });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.origin, TO);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${AUTOMATION}`);
      if ((init?.method ?? "GET") === "GET") {
        log.push("GET");
        return live.product
          ? Response.json({ productId: rows.product.id, slug: rows.product.slug, latestBuildId: rows.product.latestBuildId, ...live.product })
          : Response.json({ error: "not_found" }, { status: 404 });
      }
      const mode = url.searchParams.get("check") === "1" ? "check" : url.searchParams.get("republish") === "1" ? "republish" : "import";
      log.push(`POST ${mode}`);
      sent.push(JSON.parse(String(init?.body)));
      return Response.json(live[mode].body, { status: live[mode].status });
    }) as typeof fetch;
    // The script reports each upload as it goes.
    mock.method(console, "log", () => undefined);
    script = await import(at("../../../scripts/promote-local.ts"));
  });

  after(async () => {
    mock.restoreAll();
    globalThis.fetch = realFetch;
    process.env = savedEnv;
    await client?.close();
    await rm(filesDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of [realSchema.buildEvents, realSchema.builds, realSchema.products, realSchema.inspirations]) await local.delete(table);
    rows = sampleRows();
    await local.insert(realSchema.users).values({ id: rows.product.ownerId, email: `${rows.product.ownerId}@example.com` });
    await local.insert(realSchema.inspirations).values(rows.inspirations);
    await local.insert(realSchema.products).values(rows.product);
    await local.insert(realSchema.builds).values(rows.builds);
    await local.insert(realSchema.buildEvents).values(rows.events);
    await rm(filesDir, { recursive: true, force: true });
    await writeFiles(rows, filesDir);
    live = {
      product: null,
      check: { status: 200, body: { productId: rows.product.id, slug: "bird-count", status: "ready" } },
      import: { status: 201, body: { productId: rows.product.id, slug: "bird-count", status: "imported", publishing: true, runId: "run-1" } },
      republish: { status: 200, body: { productId: rows.product.id, slug: "bird-count", status: "already", publishing: true, runId: "run-2" } },
    };
    log = [];
    sent = [];
  });

  it("asks the live site before uploading, and uploads nothing for a bundle it refuses", async () => {
    for (const [answer, status, note] of [
      [{ status: 409, body: { error: "slug_taken", slug: "bird-count" } }, "skipped", "409: slug_taken (bird-count)"],
      [{ status: 400, body: { error: "product.slug is empty.", field: "product.slug" } }, "skipped", "400: product.slug is empty. (product.slug)"],
      [{ status: 503, body: { error: "publish_off", reason: "VERCEL_TOKEN isn't set" } }, "failed", "503: publish_off: VERCEL_TOKEN isn't set"],
    ] as const) {
      log = [];
      live.check = answer;
      const row = await script.promote(local, "bird-count", opts());
      assert.equal(row.status, status);
      assert.equal(row.note, `nothing uploaded: the live site answered ${note}`);
      assert.deepEqual([row.files, row.bytes, row.waitFor], [0, 0, undefined]);
      assert.deepEqual(log, ["GET", "POST check"], "no upload and no import");
    }
    // What it checked is the bundle as the live site would get it: every file at its link in the live store.
    const checked = JSON.stringify(sent[0]);
    assert.equal(checked.includes(LOCAL), false);
    assert.ok(checked.includes(`${STORE}/demos/${rows.product.latestBuildId}/demo-1a2b3c4d.mp4`));
  });

  it("uploads every file once the live site would take the bundle, then sends the rows that point at them", async () => {
    const keys = findLocalFileUrls(toBundle(rows)).map((url) => localFileKeyOf(url)!);
    const row = await script.promote(local, "bird-count", opts());
    assert.equal(row.status, "imported");
    assert.equal(row.note, "publishing");
    assert.equal(row.files, keys.length);
    assert.equal(row.bytes, keys.reduce((sum, key) => sum + Buffer.byteLength(`the bytes of ${key}`), 0));
    assert.deepEqual(row.waitFor, { productId: rows.product.id, buildId: rows.product.latestBuildId });
    assert.deepEqual(log.slice(0, 2), ["GET", "POST check"]);
    assert.deepEqual(log.slice(2, -1).sort(), keys.map((key) => `upload ${key}`).sort());
    assert.equal(log.at(-1), "POST import");
    const imported = JSON.stringify(sent[1]);
    assert.equal(imported.includes(LOCAL), false);
    for (const key of keys) assert.ok(imported.includes(`${STORE}/${key}`), key);
  });

  it("reports a product the live site has, and publishes it again only with --republish, uploading nothing", async () => {
    live.product = { status: "live", liveUrl: null };
    const waiting = await script.promote(local, "bird-count", opts());
    assert.deepEqual([waiting.status, waiting.note], ["already", "it's there without a link of its own yet; --republish publishes it again"]);
    assert.deepEqual(log, ["GET"]);

    log = [];
    const again = await script.promote(local, "bird-count", opts({ republish: true }));
    assert.deepEqual([again.status, again.note], ["already", "publishing it again"]);
    assert.deepEqual(again.waitFor, { productId: rows.product.id, buildId: rows.product.latestBuildId });
    assert.deepEqual(log, ["GET", "POST republish"], "its files went up with its import");

    log = [];
    live.republish = { status: 409, body: { error: "publish_running" } };
    const running = await script.promote(local, "bird-count", opts({ republish: true }));
    assert.deepEqual([running.status, running.note], ["already", "the live site is publishing it now"]);
    assert.ok(running.waitFor, "it waits for the link that publish brings");

    log = [];
    live.product = { status: "live", liveUrl: "https://musemuse-bird-count.vercel.app" };
    const linked = await script.promote(local, "bird-count", opts({ republish: true }));
    assert.deepEqual([linked.status, linked.link, linked.note], ["already", "https://musemuse-bird-count.vercel.app", "nothing uploaded or sent again"]);
    live.product = { status: "disabled", liveUrl: null };
    const off = await script.promote(local, "bird-count", opts({ republish: true }));
    assert.equal(off.note, "it is disabled on the live site, so it isn't published again");
    assert.deepEqual(log, ["GET", "GET"]);
  });

  it("makes no calls at all in a dry run", async () => {
    const row = await script.promote(local, "bird-count", opts({ dryRun: true }));
    assert.equal(row.status, "dry run");
    assert.deepEqual(log, []);
  });
});
