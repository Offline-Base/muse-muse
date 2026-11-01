/**
 * {GATEWAY_URL}/files, /search and /datasets on a real Postgres (PGlite, migrated with drizzle/) with a fake Blob store:
 * tickets, done checks, quotas, each scope against each caller, signed read links, local uploads, search ranking and
 * citations, datasets by hash, the gateway's record (CAP_PROOF.files) and cleanup.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/files/__tests__/files.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";
import type { CapProduct, CapToken } from "@/lib/caps/gate";
import { BUILD_TEST_OWNER } from "@/lib/caps/principal";
import type { FilesBlob, FilesBlobMode } from "@/lib/caps/files/blob";
import type { Dataset } from "@/lib/caps/files/datasets";
import type { FilesRule } from "@/lib/caps/files/types";
import { mintTestUserSession, mintUserSession } from "@/lib/caps/data/identity";
import { mintOwnerSession } from "@/lib/tools/principal";

process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper-for-files";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;
type Handler = typeof import("../handler");
type Store = typeof import("../store");
type FilesDeps = import("../handler").FilesDeps;

/** A Blob store in memory, with the mode each test asks for. */
function fakeBlob(mode: FilesBlobMode = "public") {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const removed: string[] = [];
  const targets: Array<{ pathname: string; contentType: string; bytes: number }> = [];
  const blob: FilesBlob & { mode(): FilesBlobMode; setMode(m: FilesBlobMode): void } = {
    mode: () => mode,
    setMode: (m) => {
      mode = m;
    },
    async uploadTarget(pathname, contentType, bytes) {
      if (mode === "local") return null;
      targets.push({ pathname, contentType, bytes });
      return { url: `https://vercel.com/api/blob/?pathname=${encodeURIComponent(pathname)}&vercel-blob-signature=x`, method: "PUT", headers: { "x-content-type": contentType } };
    },
    async facts(pathname) {
      const o = objects.get(pathname);
      return o ? { bytes: o.body.length, contentType: o.contentType } : null;
    },
    async sha256(pathname) {
      return createHash("sha256").update(objects.get(pathname)!.body).digest("hex");
    },
    async readUrl(pathname, opts) {
      if (mode === "local") return null;
      return `https://store.public.blob.vercel-storage.com/${pathname}${opts.download ? "?download=1" : ""}`;
    },
    async localStream(pathname) {
      const o = objects.get(pathname);
      return o ? { stream: new Blob([new Uint8Array(o.body)]).stream(), bytes: o.body.length } : null;
    },
    async writeLocal(pathname, body, contentType) {
      objects.set(pathname, { body, contentType });
    },
    async remove(paths) {
      for (const p of paths) {
        objects.delete(p);
        removed.push(p);
      }
    },
  };
  return { blob, objects, removed, targets, put: (pathname: string, body: Buffer | string, contentType: string) => objects.set(pathname, { body: Buffer.from(body), contentType }) };
}

describe("files on a database", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let handler: Handler;
  let store: Store;
  let productId = "";
  let buildId = "";
  let otherBuild = "";
  const NOW = new Date();
  const dir = mkdtempSync(path.join(tmpdir(), "mm-files-"));
  const penguinsCsv = "species,island\nAdelie,Torgersen\n";
  const DATASETS: Dataset[] = [
    {
      id: "penguins",
      title: "Penguins",
      why: "Made-up rows for a test.",
      license: { spdx: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
      source: { name: "Test", url: "https://example.org" },
      attribution: "Test data (CC0)",
      files: [
        { name: "penguins.csv", contentType: "text/csv", bytes: Buffer.byteLength(penguinsCsv), sha256: createHash("sha256").update(penguinsCsv).digest("hex"), download: "https://example.org/p.csv", mirror: null },
        { name: "mirrored.csv", contentType: "text/csv", bytes: 4, sha256: "a".repeat(64), download: "https://example.org/m.csv", mirror: "https://store.public.blob.vercel-storage.com/datasets/penguins/mirrored.csv" },
      ],
    },
  ];
  writeFileSync(path.join(dir, "penguins.csv"), penguinsCsv);

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
    (testDb as unknown as { batch: (q: PromiseLike<unknown>[]) => Promise<unknown[]> }).batch = async (queries) => {
      const out: unknown[] = [];
      for (const q of queries) out.push(await q);
      return out;
    };
    mock.module(new URL("../../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    handler = await import("../handler");
    store = await import("../store");
    const [user] = await testDb.insert(realSchema.users).values({ email: "maker@example.com" }).returning();
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: user!.id }).returning();
    const [product] = await testDb.insert(realSchema.products).values({ slug: "notes", name: "Notes", ownerId: user!.id, status: "live" }).returning();
    const brief = { files: { holds: "Field notes", scope: "shared", uploads: "anyone", search: true, datasets: ["palmer-penguins"] } } as never;
    const [build] = await testDb.insert(realSchema.builds).values({ inspirationId: muse!.id, userId: user!.id, productId: product!.id, brief }).returning();
    const [old] = await testDb.insert(realSchema.builds).values({ inspirationId: muse!.id, userId: user!.id, productId: product!.id, brief }).returning();
    productId = product!.id;
    buildId = build!.id;
    otherBuild = old!.id;
  });
  after(() => {
    client?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let fake = fakeBlob();
  const counters = new Map<string, number>();
  beforeEach(async () => {
    await client.exec("delete from product_files; delete from product_search_docs; delete from product_dataset_reads;");
    fake = fakeBlob();
    counters.clear();
  });

  const live = (): CapToken => ({ id: "tok-live", productId, scope: "live", allowedModels: ["cap:files"], dailyBudgetUsd: 3, buildId: null });
  const buildTok = (id = buildId): CapToken => ({ id: `tok-build-${id}`, productId, scope: "build", allowedModels: ["cap:files"], dailyBudgetUsd: 10, buildId: id });
  const product = (over: Partial<CapProduct> = {}): CapProduct => ({ status: "live", manifest: { caps: ["files"] }, liveUrl: "https://notes.example", takenDownAt: null, ownerId: "u1", ownerEmail: "maker@example.com", ownerIsAdmin: false, ownerBannedAt: null, ...over });
  let rule: FilesRule = { scope: "shared", uploads: "owner", search: true, datasets: ["penguins"] };

  function deps(tok: CapToken = live(), over: Partial<FilesDeps> = {}): FilesDeps {
    return {
      servedCaps: () => ["files"],
      findToken: async () => tok,
      product: async () => product(),
      adminEmails: [],
      hitRateLimits: async (keys, w) => Object.fromEntries(keys.map((k) => [k, counters.set(`${k}@${w.toISOString()}`, (counters.get(`${k}@${w.toISOString()}`) ?? 0) + 1).get(`${k}@${w.toISOString()}`)!])),
      store: store.filesStore,
      blob: fake.blob,
      quotas: () => ({ productBytes: 500 * 1024 * 1024, maxFileBytes: 25 * 1024 * 1024 }),
      searchOn: () => true,
      datasetsOn: () => true,
      rule: async () => rule,
      fileById: store.fileById,
      datasets: () => DATASETS,
      localDatasetPath: (_id, file) => (file === "penguins.csv" ? path.join(dir, file) : null),
      gatewayUrl: "https://musemuse.example/api/gateway",
      now: () => NOW,
      ...over,
    };
  }

  const VISITOR_A = "visitor_aaaaaaaaaaaaaaaa";
  const VISITOR_B = "visitor_bbbbbbbbbbbbbbbb";
  const ownerPass = () => mintOwnerSession({ productId, subject: "owner_subject" }, NOW).session;
  const as = (who: { visitor?: string; owner?: boolean | string; user?: string; ip?: string }) => ({
    ...(who.visitor ? { "x-musemuse-visitor": who.visitor } : {}),
    ...(who.owner ? { "x-musemuse-owner": typeof who.owner === "string" ? who.owner : ownerPass() } : {}),
    ...(who.user ? { "x-musemuse-user": who.user } : {}),
    ...(who.ip ? { "x-musemuse-client-ip": who.ip } : {}),
  });

  async function call(route: "files" | "search" | "datasets", method: string, sub: string, opts: { body?: unknown; headers?: Record<string, string>; deps?: FilesDeps; raw?: BodyInit } = {}) {
    const url = `https://musemuse.example/api/gateway/${route}${sub ? `/${sub}` : ""}`;
    const req = new Request(url, {
      method,
      headers: { authorization: "Bearer mm_live_sample", ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...opts.headers },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : opts.raw !== undefined ? { body: opts.raw } : {}),
    });
    const parts = sub.split("?")[0]!.split("/").filter(Boolean);
    const d = opts.deps ?? deps();
    const res = route === "files" ? await handler.handleFiles(req, parts, d) : route === "search" ? await handler.handleSearch(req, parts, d) : await handler.handleDatasets(req, parts, d);
    const json = (await res.clone().json().catch(() => null)) as (Record<string, unknown> & { error?: { code: string; message: string } }) | null;
    return { status: res.status, json: json ?? {}, code: json?.error?.code, res };
  }

  /** Ticket, put the bytes where the ticket says, done. */
  async function upload(name: string, body: string, contentType = "text/plain", headers: Record<string, string> = as({ owner: true }), d?: FilesDeps) {
    const t = await call("files", "POST", "ticket", { body: { name, contentType, bytes: Buffer.byteLength(body) }, headers, deps: d });
    assert.equal(t.status, 201, JSON.stringify(t.json));
    const target = fake.targets.at(-1)!;
    fake.put(target.pathname, body, contentType);
    const done = await call("files", "POST", `${t.json.id}/done`, { body: {}, headers, deps: d });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    return done.json as { id: string; url: string; sha256: string; bytes: number; name: string };
  }

  it("keeps a file: a ticket, the bytes at Blob, the done check with its sha256, then listed and read by a signed link", async () => {
    const kept = await upload("field-notes.txt", "Herons nest by the reservoir.");
    assert.equal(kept.sha256, createHash("sha256").update("Herons nest by the reservoir.").digest("hex"));
    assert.equal(kept.bytes, 29);
    assert.ok(!JSON.stringify(kept).includes("caps/files/"), "the Blob path never leaves the platform");
    assert.match(kept.url, /^https:\/\/musemuse\.example\/api\/gateway\/files\/[0-9a-f-]{36}\/content\?exp=\d+&download=1&sig=/);
    const target = fake.targets[0]!;
    assert.match(target.pathname, new RegExp(`^caps/files/${productId}/live/${kept.id}-[0-9a-f]{32}$`), "an unguessable suffix");
    assert.equal(target.contentType, "text/plain");
    assert.equal(target.bytes, 29);
    const list = await call("files", "GET", "");
    assert.deepEqual((list.json.items as Array<{ id: string }>).map((f) => f.id), [kept.id], "shared files are listed for anyone on the product");
    // The signed link redirects to the blob, as an attachment for text, with no bearer.
    const content = await handler.handleFiles(new Request(kept.url), [kept.id, "content"], deps());
    assert.equal(content.status, 302);
    assert.match(content.headers.get("location")!, /download=1$/);
    assert.equal(content.headers.get("x-content-type-options"), "nosniff");
    const one = await call("files", "GET", kept.id);
    assert.equal(one.json.name, "field-notes.txt");
  });

  it("refuses a ticket for a type it can't serve safely, a file over the limit, and unknown fields", async () => {
    const h = as({ owner: true });
    assert.equal((await call("files", "POST", "ticket", { body: { name: "page.html", contentType: "text/html", bytes: 10 }, headers: h })).code, "invalid_arguments");
    assert.equal((await call("files", "POST", "ticket", { body: { name: "logo.svg", contentType: "image/svg+xml", bytes: 10 }, headers: h })).code, "invalid_arguments");
    assert.equal((await call("files", "POST", "ticket", { body: { name: "big.mp4", contentType: "video/mp4", bytes: 26 * 1024 * 1024 }, headers: h })).code, "invalid_arguments");
    assert.equal((await call("files", "POST", "ticket", { body: { name: "a.txt", contentType: "text/plain", bytes: 1, path: "x" }, headers: h })).code, "invalid_arguments");
    const named = await call("files", "POST", "ticket", { body: { name: "../../etc/passwd", contentType: "text/plain", bytes: 1 }, headers: h });
    assert.equal(named.status, 201);
    const [row] = await testDb.select().from(realSchema.productFiles);
    assert.equal(row!.name, "passwd", "no path in a name");
  });

  it("the done check: nothing uploaded is 409, a wrong size or type is removed, and a done file is done once", async () => {
    const h = as({ owner: true });
    const t = await call("files", "POST", "ticket", { body: { name: "a.png", contentType: "image/png", bytes: 10 }, headers: h });
    assert.equal((await call("files", "POST", `${t.json.id}/done`, { body: {}, headers: h })).code, "not_uploaded");
    fake.put(fake.targets[0]!.pathname, "not a png at all, too long", "image/png");
    assert.equal((await call("files", "POST", `${t.json.id}/done`, { body: {}, headers: h })).code, "invalid_arguments");
    assert.deepEqual(fake.removed, [fake.targets[0]!.pathname]);
    assert.equal((await testDb.select().from(realSchema.productFiles)).length, 0, "its row went with it");
    const t2 = await call("files", "POST", "ticket", { body: { name: "b.png", contentType: "image/png", bytes: 10 }, headers: h });
    fake.put(fake.targets[1]!.pathname, "12345", "image/jpeg");
    assert.equal((await call("files", "POST", `${t2.json.id}/done`, { body: {}, headers: h })).code, "invalid_arguments", "the type must be the ticket's");
  });

  it("shared uploads follow the product's rule; only the owner deletes shared files", async () => {
    rule = { scope: "shared", uploads: "owner", search: true, datasets: [] };
    const t = await call("files", "POST", "ticket", { body: { name: "a.txt", contentType: "text/plain", bytes: 3 }, headers: as({ visitor: VISITOR_A }) });
    assert.equal(t.code, "sign_in_required");
    rule = { ...rule, uploads: "anyone" };
    const kept = await upload("a.txt", "abc", "text/plain", as({ visitor: VISITOR_A }));
    assert.equal((await call("files", "DELETE", kept.id, { headers: as({ visitor: VISITOR_A }) })).code, "sign_in_required");
    rule = { ...rule, uploads: "signed_in" };
    assert.equal((await call("files", "POST", "ticket", { body: { name: "b.txt", contentType: "text/plain", bytes: 3 }, headers: as({ visitor: VISITOR_A }) })).code, "sign_in_required");
    const session = mintUserSession({ productId, subject: "subj_ana" }, NOW).session;
    assert.equal((await call("files", "POST", "ticket", { body: { name: "b.txt", contentType: "text/plain", bytes: 3 }, headers: as({ user: session }) })).status, 201);
    const gone = await call("files", "DELETE", kept.id, { headers: as({ owner: true }) });
    assert.equal(gone.json.deleted, true);
    assert.ok(fake.removed.some((p) => p.includes(kept.id)), "the blob went first");
    assert.equal((await call("files", "GET", kept.id)).status, 404);
    rule = { scope: "shared", uploads: "owner", search: true, datasets: ["penguins"] };
  });

  it("visitor files stay with one browser, user files with one person, owner files with the owner", async () => {
    rule = { scope: "visitor", uploads: "owner", search: true, datasets: [] };
    assert.equal((await call("files", "POST", "ticket", { body: { name: "a.txt", contentType: "text/plain", bytes: 3 } })).code, "sign_in_required", "no visitor id");
    const mine = await upload("mine.txt", "abc", "text/plain", as({ visitor: VISITOR_A }));
    assert.equal(((await call("files", "GET", "", { headers: as({ visitor: VISITOR_A }) })).json.items as unknown[]).length, 1);
    assert.equal(((await call("files", "GET", "", { headers: as({ visitor: VISITOR_B }) })).json.items as unknown[]).length, 0);
    assert.equal((await call("files", "GET", mine.id, { headers: as({ visitor: VISITOR_B }) })).status, 404);
    assert.equal((await call("files", "DELETE", mine.id, { headers: as({ visitor: VISITOR_B }) })).json.deleted, false);
    assert.equal((await call("files", "GET", "?scope=shared", { headers: as({ visitor: VISITOR_A }) })).code, "cap_not_allowed", "one scope per product");
    rule = { scope: "user", uploads: "owner", search: true, datasets: [] };
    const ana = mintUserSession({ productId, subject: "subj_ana" }, NOW).session;
    const bo = mintUserSession({ productId, subject: "subj_bo" }, NOW).session;
    await upload("ana.txt", "abc", "text/plain", as({ user: ana }));
    assert.equal(((await call("files", "GET", "", { headers: as({ user: bo }) })).json.items as unknown[]).length, 0);
    assert.equal(((await call("files", "GET", "", { headers: as({ user: ana }) })).json.items as unknown[]).length, 1);
    rule = { scope: "owner", uploads: "owner", search: true, datasets: [] };
    assert.equal((await call("files", "GET", "", { headers: as({ visitor: VISITOR_A }) })).code, "sign_in_required");
    assert.equal((await call("files", "GET", "", { headers: as({ owner: true }) })).status, 200);
    rule = { scope: "shared", uploads: "owner", search: true, datasets: ["penguins"] };
  });

  it("quotas: the product's bytes and files, a person's 50 MB, and a build's own smaller space", async () => {
    const h = as({ owner: true });
    const small = deps(live(), { quotas: () => ({ productBytes: 10, maxFileBytes: 25 * 1024 * 1024 }) });
    assert.equal((await call("files", "POST", "ticket", { body: { name: "a.txt", contentType: "text/plain", bytes: 8 }, headers: h, deps: small })).status, 201);
    const over = await call("files", "POST", "ticket", { body: { name: "b.txt", contentType: "text/plain", bytes: 3 }, headers: h, deps: small });
    assert.equal(over.code, "quota_exceeded");
    assert.match(over.json.error!.message, /0 MB|as much as it can/);
    rule = { scope: "visitor", uploads: "owner", search: true, datasets: [] };
    const mb = 1024 * 1024;
    assert.equal((await call("files", "POST", "ticket", { body: { name: "a.mp4", contentType: "video/mp4", bytes: 25 * mb }, headers: as({ visitor: VISITOR_A }) })).status, 201);
    assert.equal((await call("files", "POST", "ticket", { body: { name: "b.mp4", contentType: "video/mp4", bytes: 25 * mb }, headers: as({ visitor: VISITOR_A }) })).status, 201);
    const third = await call("files", "POST", "ticket", { body: { name: "c.mp4", contentType: "video/mp4", bytes: 1 }, headers: as({ visitor: VISITOR_A }) });
    assert.equal(third.code, "quota_exceeded", "a person keeps 50 MB");
    assert.match(third.json.error!.message, /one person/);
    assert.equal((await call("files", "POST", "ticket", { body: { name: "c.mp4", contentType: "video/mp4", bytes: 1 }, headers: as({ visitor: VISITOR_B }) })).status, 201, "another person has their own");
    rule = { scope: "shared", uploads: "owner", search: true, datasets: ["penguins"] };
    // A build's files are in b:<buildId>, never in live, and the build has its own 50 MB.
    const b = deps(buildTok());
    await upload("test.txt", "test file", "text/plain", {}, b);
    const rows = await testDb.select().from(realSchema.productFiles);
    assert.ok(rows.every((r) => r.namespace === "live" || r.namespace === `b:${buildId}`));
    assert.ok(fake.targets.at(-1)!.pathname.includes(`/b-${buildId}/`));
    assert.equal(((await call("files", "GET", "", { deps: b })).json.items as unknown[]).length, 1, "the build sees only its own");
  });

  it("the signed link: a bad or old signature, a product taken down, or the cap off serve nothing; pictures are inline", async () => {
    const pic = await upload("bird.png", "png-bytes", "image/png");
    assert.doesNotMatch(pic.url, /download=1/, "a picture shows in place");
    const ok = await handler.handleFiles(new Request(pic.url), [pic.id, "content"], deps());
    assert.equal(ok.status, 302);
    assert.doesNotMatch(ok.headers.get("location")!, /download=1/);
    const tampered = pic.url.replace(/sig=[^&]+/, "sig=AAAA");
    assert.equal((await handler.handleFiles(new Request(tampered), [pic.id, "content"], deps())).status, 403);
    const asDownload = pic.url.replace("&sig", "&download=1&sig");
    assert.equal((await handler.handleFiles(new Request(asDownload), [pic.id, "content"], deps())).status, 403, "the download choice is signed too");
    const later = deps(live(), { now: () => new Date(NOW.getTime() + 2 * 3_600_000) });
    assert.equal((await handler.handleFiles(new Request(pic.url), [pic.id, "content"], later)).status, 403, "an hour old link is no good");
    const down = deps(live(), { product: async () => product({ takenDownAt: new Date() }) });
    assert.equal((await handler.handleFiles(new Request(pic.url), [pic.id, "content"], down)).status, 404);
    const off = deps(live(), { servedCaps: () => [] });
    assert.equal(((await (await handler.handleFiles(new Request(pic.url), [pic.id, "content"], off)).json()) as { error: { code: string } }).error.code, "unknown_endpoint");
  });

  it("a local run: the ticket's URL is the gateway's own signed upload, and the link streams the bytes", async () => {
    fake.blob.setMode("local");
    const h = as({ owner: true });
    const t = await call("files", "POST", "ticket", { body: { name: "n.txt", contentType: "text/plain", bytes: 5 }, headers: h });
    const upload = (t.json.upload as { url: string }).url;
    assert.match(upload, /\/files\/[0-9a-f-]{36}\/upload\?exp=\d+&sig=/);
    const put = (body: string, type = "text/plain", url = upload) => handler.handleFiles(new Request(url, { method: "PUT", headers: { "content-type": type }, body }), [String(t.json.id), "upload"], deps());
    assert.equal((await put("hello", "text/html")).status, 400, "the ticket's type only");
    assert.equal((await put("hello world")).status, 400, "at most the ticket's size");
    assert.equal((await put("hello", "text/plain", upload.replace(/sig=[^&]+/, "sig=x"))).status, 403);
    assert.equal((await put("hello")).status, 200);
    const done = await call("files", "POST", `${t.json.id}/done`, { body: {}, headers: h });
    assert.equal(done.status, 200);
    const read = await handler.handleFiles(new Request(String(done.json.url)), [String(t.json.id), "content"], deps());
    assert.equal(read.status, 200);
    assert.equal(await read.text(), "hello");
    assert.match(read.headers.get("content-disposition")!, /^attachment/);
    assert.equal(read.headers.get("content-security-policy"), "sandbox; default-src 'none'");
    fake.blob.setMode("public");
    assert.equal((await put("hello")).status, 404, "on Vercel the gateway takes no bytes itself");
  });

  it("search: a file's text is indexed in chunks, found by words and by the start of a word, with its citation", async () => {
    const kept = await upload("field-notes.txt", "x");
    const text = `${"Filler about the weather and the light. ".repeat(150)}\n\nHerons nest by the reservoir in April.\n\n${"More filler. ".repeat(50)}`;
    const idx = await call("search", "POST", "index", { body: { source: { fileId: kept.id }, text }, headers: as({ owner: true }) });
    assert.equal(idx.status, 201);
    assert.ok((idx.json.chunks as number) >= 2, "a long text is split");
    const q = await call("search", "POST", "query", { body: { q: "heron reservoir" } });
    const hits = q.json.hits as Array<{ title: string; snippet: string; citation: { name: string; offset: number; source: { fileId: string } } }>;
    assert.equal(hits[0]!.title, "field-notes.txt", "a file's text is titled with its name");
    assert.match(hits[0]!.snippet, /Herons nest by the reservoir/);
    assert.ok(!hits[0]!.snippet.includes("<<"), "a plain snippet");
    assert.deepEqual(hits[0]!.citation.source, { fileId: kept.id });
    assert.equal(text.slice(hits[0]!.citation.offset, hits[0]!.citation.offset + 6).toLowerCase(), "herons", "the offset points at the match");
    const prefix = await call("search", "POST", "query", { body: { q: "reserv" } });
    assert.equal((prefix.json.hits as unknown[]).length, 1, "the start of a word finds it");
    assert.equal(((await call("search", "POST", "query", { body: { q: "penguin" } })).json.hits as unknown[]).length, 0);
    // An item's text needs a title; indexing the same source again replaces it.
    assert.equal((await call("search", "POST", "index", { body: { source: { collection: "notes", docId: "n1" }, text: "Kingfisher by the bridge" }, headers: as({ owner: true }) })).code, "invalid_arguments");
    await call("search", "POST", "index", { body: { source: { collection: "notes", docId: "n1" }, title: "Bridge walk", text: "Kingfisher by the bridge" }, headers: as({ owner: true }) });
    await call("search", "POST", "index", { body: { source: { collection: "notes", docId: "n1" }, title: "Bridge walk", text: "Dipper by the bridge" }, headers: as({ owner: true }) });
    assert.equal(((await call("search", "POST", "query", { body: { q: "kingfisher" } })).json.hits as unknown[]).length, 0);
    assert.equal(((await call("search", "POST", "query", { body: { q: "dipper" } })).json.hits as unknown[]).length, 1);
    // Deleting the file takes its text out.
    await call("files", "DELETE", kept.id, { headers: as({ owner: true }) });
    assert.equal(((await call("search", "POST", "query", { body: { q: "heron" } })).json.hits as unknown[]).length, 0);
    assert.equal((await call("search", "POST", "remove", { body: { source: { collection: "notes", docId: "n1" } }, headers: as({ owner: true }) })).json.removed, true);
  });

  it("search follows the scope: one visitor never finds another's text, and only the right people index a shared space", async () => {
    assert.equal((await call("search", "POST", "index", { body: { source: { collection: "notes", docId: "a" }, title: "A", text: "secret plan" }, headers: as({ visitor: VISITOR_A }) })).code, "sign_in_required", "shared uploads are the owner's here");
    rule = { scope: "visitor", uploads: "owner", search: true, datasets: [] };
    await call("search", "POST", "index", { body: { source: { collection: "notes", docId: "a" }, title: "A", text: "secret plan" }, headers: as({ visitor: VISITOR_A }) });
    assert.equal(((await call("search", "POST", "query", { body: { q: "secret" }, headers: as({ visitor: VISITOR_A }) })).json.hits as unknown[]).length, 1);
    assert.equal(((await call("search", "POST", "query", { body: { q: "secret" }, headers: as({ visitor: VISITOR_B }) })).json.hits as unknown[]).length, 0);
    // A file's text must be one of this space's own files.
    const other = await upload("b.txt", "x", "text/plain", as({ visitor: VISITOR_B }));
    assert.equal((await call("search", "POST", "index", { body: { source: { fileId: other.id }, text: "stolen" }, headers: as({ visitor: VISITOR_A }) })).status, 404);
    rule = { scope: "shared", uploads: "owner", search: true, datasets: ["penguins"] };
    // Off with FILES_SEARCH.
    assert.equal((await call("search", "POST", "query", { body: { q: "x" }, deps: deps(live(), { searchOn: () => false }) })).code, "unknown_endpoint");
    assert.equal((await call("search", "POST", "query", { body: { q: "x".repeat(201) } })).code, "invalid_arguments");
    assert.equal((await call("search", "POST", "query", { body: { q: "x", limit: 11 } })).code, "invalid_arguments");
  });

  it("the index holds at most its documents, and a build's at most 200", async () => {
    const b = deps(buildTok());
    for (let i = 0; i < 200; i++) await store.filesStore.indexDoc({ productId, namespace: `b:${buildId}`, scope: "shared", ownerKey: null }, { source: { collection: "n", docId: `d${i}` }, sourceKey: `item:n:d${i}`, title: "t", chunks: [{ body: "word", offset: 0 }] }, 200);
    const full = await call("search", "POST", "index", { body: { source: { collection: "notes", docId: "x" }, title: "X", text: "one more" }, deps: b });
    assert.equal(full.code, "quota_exceeded");
    const again = await call("search", "POST", "index", { body: { source: { collection: "n", docId: "d3" }, title: "X", text: "replacing one is fine" }, deps: b });
    assert.equal(again.status, 201, "replacing a document doesn't need room for another");
  });

  it("datasets: the list, a file read by hash on a local run, the mirror's redirect, and the build's record", async () => {
    const list = await call("datasets", "GET", "");
    const d = (list.json.datasets as Array<{ id: string; files: Array<{ url: string; sha256: string; download?: string; mirror?: string }> }>)[0]!;
    assert.equal(d.id, "penguins");
    assert.equal(d.files[0]!.url, "https://musemuse.example/api/gateway/datasets/penguins/penguins.csv");
    assert.ok(!("download" in d.files[0]!) && !("mirror" in d.files[0]!), "no source or mirror address goes out");
    const read = await call("datasets", "GET", "penguins/penguins.csv");
    assert.equal(read.status, 200);
    assert.equal(await read.res.text(), penguinsCsv);
    assert.equal(read.res.headers.get("x-dataset-license"), "CC0-1.0");
    const mirrored = await call("datasets", "GET", "penguins/mirrored.csv");
    assert.equal(mirrored.status, 302);
    assert.equal(mirrored.res.headers.get("location"), DATASETS[0]!.files[1]!.mirror);
    assert.equal((await call("datasets", "GET", "penguins/nope.csv")).status, 404);
    assert.equal((await call("datasets", "GET", "../etc")).code, "unknown_endpoint");
    assert.equal((await call("datasets", "GET", "", { deps: deps(live(), { datasetsOn: () => false }) })).code, "unknown_endpoint");
    assert.equal((await testDb.select().from(realSchema.productDatasetReads)).length, 0, "a live product's reads aren't recorded");
    const unmirrored = deps(buildTok(), { localDatasetPath: () => null });
    assert.equal((await call("datasets", "GET", "penguins/penguins.csv", { deps: unmirrored })).code, "dataset_unavailable");
    assert.equal((await testDb.select().from(realSchema.productDatasetReads)).length, 0, "a read that wasn't served isn't recorded");
    await call("datasets", "GET", "penguins/penguins.csv", { deps: deps(buildTok()) });
    const [rec] = await testDb.select().from(realSchema.productDatasetReads);
    assert.equal(rec!.namespace, `b:${buildId}`);
    assert.equal(rec!.datasetId, "penguins");
  });

  it("the gateway's record of a build counts what happened since, and names the brief's choices", async () => {
    const env = { FILES_SEARCH: process.env.FILES_SEARCH, FILES_DATASETS: process.env.FILES_DATASETS };
    try {
      Object.assign(process.env, { FILES_SEARCH: "1", FILES_DATASETS: "1" });
      const b = deps(buildTok());
      const before = await store.filesProof(buildId, { since: null });
      assert.equal(before.uploaded, 0);
      assert.equal(before["brief:scope:shared"], 1);
      assert.equal(before["brief:uploads:anyone"], 1);
      assert.equal(before["brief:search"], 1);
      assert.equal(before["brief:dataset:palmer-penguins"], 1);
      const kept = await upload("t.txt", "heron", "text/plain", {}, b);
      await call("search", "POST", "index", { body: { source: { fileId: kept.id }, text: "heron" }, deps: b });
      await call("datasets", "GET", "penguins/penguins.csv", { deps: b });
      const p = await store.filesProof(buildId, { since: new Date(Date.now() - 60_000) });
      assert.equal(p.uploaded, 1);
      assert.equal(p.indexed, 1);
      assert.equal(p.datasetReads, 1);
      assert.equal(p["dataset:penguins"], 1);
      const later = await store.filesProof(buildId, { since: new Date(Date.now() + 60_000) });
      assert.equal(later.uploaded, 0, "an earlier round's upload doesn't pass a later check");
      assert.equal(later.files, 1);
      delete process.env.FILES_SEARCH;
      delete process.env.FILES_DATASETS;
      const off = await store.filesProof(buildId, { since: null });
      assert.equal(off["brief:search"], undefined, "a switch that is off isn't asked for");
      assert.equal(off["brief:dataset:palmer-penguins"], undefined);
    } finally {
      for (const [k, v] of Object.entries(env)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
    }
  });

  it("cleanup: a build's files go when it ends, the sweep finishes stale tickets, crashed builds and half deletes", async () => {
    await upload("live.txt", "keep me");
    await upload("b.txt", "build file", "text/plain", {}, deps(buildTok()));
    await store.clearFilesBuild(buildId, fake.blob.remove);
    const left = await testDb.select().from(realSchema.productFiles);
    assert.deepEqual(left.map((r) => r.namespace), ["live"]);
    assert.ok(fake.removed.some((p) => p.includes(`/b-${buildId}/`)));
    // A ticket never finished, an old crashed build's file, and a delete that stopped half way.
    const old = new Date(Date.now() - 25 * 3_600_000);
    await testDb.insert(realSchema.productFiles).values([
      { productId, namespace: "live", scope: "shared", name: "stale", contentType: "text/plain", bytes: 1, blobPath: "caps/files/stale", createdAt: old },
      { productId, namespace: `b:${otherBuild}`, scope: "shared", name: "crashed", contentType: "text/plain", bytes: 1, blobPath: "caps/files/crashed", status: "ready", createdAt: old },
      { productId, namespace: "live", scope: "shared", name: "half", contentType: "text/plain", bytes: 1, blobPath: "caps/files/half", status: "ready", deletedAt: new Date() },
    ]);
    const removed = await store.sweepFiles(new Date(), fake.blob.remove);
    assert.equal(removed, 3);
    assert.deepEqual((await testDb.select().from(realSchema.productFiles)).map((r) => r.name), ["live.txt"]);
    for (const p of ["caps/files/stale", "caps/files/crashed", "caps/files/half"]) assert.ok(fake.removed.includes(p), p);
    // A takedown removes the live files.
    assert.equal(await store.clearLiveFiles(productId, fake.blob.remove), 1);
    assert.equal((await testDb.select().from(realSchema.productFiles)).length, 0);
  });

  it("a build's test owner pass makes a browser the owner, and a made-up person is a user, only on the build's token", async () => {
    rule = { scope: "shared", uploads: "owner", search: true, datasets: [] };
    const b = deps(buildTok());
    assert.equal((await call("files", "POST", "ticket", { body: { name: "a.txt", contentType: "text/plain", bytes: 1 }, headers: as({ visitor: VISITOR_A }), deps: b })).code, "sign_in_required", "a test's browser is a visitor");
    assert.equal((await call("files", "POST", "ticket", { body: { name: "a.txt", contentType: "text/plain", bytes: 1 }, headers: as({ visitor: VISITOR_A, owner: BUILD_TEST_OWNER }), deps: b })).status, 201);
    assert.equal((await call("files", "POST", "ticket", { body: { name: "a.txt", contentType: "text/plain", bytes: 1 }, headers: as({ owner: BUILD_TEST_OWNER }) })).code, "sign_in_required", "no pass on a live token");
    rule = { scope: "user", uploads: "owner", search: true, datasets: [] };
    const made = mintTestUserSession({ productId, buildId, subject: "test_ana" }, NOW).session;
    assert.equal((await call("files", "POST", "ticket", { body: { name: "a.txt", contentType: "text/plain", bytes: 1 }, headers: as({ user: made }), deps: b })).status, 201);
    assert.equal((await call("files", "POST", "ticket", { body: { name: "a.txt", contentType: "text/plain", bytes: 1 }, headers: as({ user: made }) })).code, "sign_in_required", "a made-up person isn't anyone live");
    rule = { scope: "shared", uploads: "owner", search: true, datasets: ["penguins"] };
  });
});
