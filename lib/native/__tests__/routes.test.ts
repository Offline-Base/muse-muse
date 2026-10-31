/**
 * The lab's routes (docs/NATIVE_LAB.md) on PGlite with the real queue. With NATIVE_LAB off, every one of them is a 404 that
 * touches nothing. With it on: lab tokens, job tokens that need status='claimed' and the matching hash or answer 410, what a
 * claim hands over against the agent's own validator, upload slots pinned to the job's folder, and a finish call whose
 * links are treated as claims. Blob's token call is faked; the presigning is @vercel/blob's own.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/native/__tests__/routes.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import { macInput, type Seeded, type TestDb } from "./helpers";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const SAVED = { ...process.env };
const ORIGIN = "https://platform.example.com";
const LAB_TOKEN = "mmlab_test-token-for-the-mac-lane-only";
const WINDOWS_TOKEN = "mmlab_test-token-for-the-windows-lane";
const CRON = "cron-secret-for-tests";

type IdCtx = { params: Promise<{ id: string }> };
type Handler = (req: Request, ctx: IdCtx) => Promise<Response>;
type FileHandler = (req: Request, ctx: { params: Promise<{ id: string; name: string }> }) => Promise<Response>;

function post(path: string, token: string | null, body: unknown = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const ctx = (id: string): IdCtx => ({ params: Promise.resolve({ id }) });

describe("the lab's routes", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let testDb: TestDb;
  let close: () => Promise<void>;
  let seed: () => Promise<Seeded>;
  let dbTouched = 0;
  let issued: Array<Record<string, unknown>> = [];
  let claimRoute: (req: Request) => Promise<Response>;
  let heartbeatRoute: Handler;
  let uploadRoute: Handler;
  let selftestPollRoute: Handler;
  let finishRoute: Handler;
  let filesRoute: FileHandler;
  let selftestRoute: (req: Request) => Promise<Response>;
  let cronRoute: (req: Request) => Promise<Response>;
  let queue: typeof import("@/lib/native/queue");
  let tokens: typeof import("@/lib/native/lab-token");
  let validateJob: (job: unknown, opts: { lane: string; platformOrigin: string }) => { ok: true } | { ok: false; error: string };

  before(async () => {
    ({ validateJob } = await import(at("../../../native/lab/lib/validate.mjs")));
    const helpers = await import("./helpers");
    ({ db: testDb, close } = await helpers.makeTestDb());
    seed = () => helpers.seedRun(testDb);
    mock.module(at("../../db/client.ts"), {
      namedExports: {
        db: () => {
          dbTouched += 1;
          return testDb;
        },
        schema: realSchema,
      },
    });
    const realBlob = await import("@vercel/blob");
    mock.module("@vercel/blob", {
      namedExports: {
        ...realBlob,
        issueSignedToken: async (opts: Record<string, unknown>) => {
          issued.push(opts);
          const { pathname, operations, validUntil, allowedContentTypes, maximumSizeInBytes } = opts;
          const scope = { storeId: "teststore", pathname, operations, validUntil, allowedContentTypes, maximumSizeInBytes };
          return { delegationToken: `${Buffer.from(JSON.stringify(scope)).toString("base64url")}.sig`, clientSigningToken: "test-signing-key", validUntil: opts.validUntil };
        },
      },
    });
    process.env.GATEWAY_TOKEN_PEPPER = "test-pepper-for-lab-routes";
    process.env.PLATFORM_URL = ORIGIN;
    process.env.CRON_SECRET = CRON;
    delete process.env.VERCEL;
    claimRoute = (await import(at("../../../app/api/native/agent/claim/route.ts"))).POST;
    heartbeatRoute = (await import(at("../../../app/api/native/agent/jobs/[id]/heartbeat/route.ts"))).POST;
    uploadRoute = (await import(at("../../../app/api/native/agent/jobs/[id]/upload/route.ts"))).POST;
    selftestPollRoute = (await import(at("../../../app/api/native/agent/jobs/[id]/selftest/route.ts"))).POST;
    finishRoute = (await import(at("../../../app/api/native/agent/jobs/[id]/finish/route.ts"))).POST;
    filesRoute = (await import(at("../../../app/api/native/agent/jobs/[id]/files/[name]/route.ts"))).PUT;
    selftestRoute = (await import(at("../../../app/api/native/selftest/route.ts"))).POST;
    cronRoute = (await import(at("../../../app/api/cron/native-sweep/route.ts"))).GET;
    queue = await import(at("../queue.ts"));
    tokens = await import("@/lib/native/lab-token");
  });
  after(async () => {
    await close();
    process.env = { ...SAVED };
  });
  beforeEach(async () => {
    process.env.NATIVE_LAB = "1";
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_teststore_notarealtoken";
    delete process.env.BLOB_STORE_ID;
    issued = [];
    await testDb.delete(realSchema.nativeArtifacts);
    await testDb.delete(realSchema.nativeJobs);
    await testDb.delete(realSchema.nativeLabs);
    await testDb.insert(realSchema.nativeLabs).values([
      { lane: "mac", tokenHash: tokens.hashLabToken(LAB_TOKEN) },
      { lane: "windows", tokenHash: tokens.hashLabToken(WINDOWS_TOKEN) },
    ]);
  });

  const claimBody = (over: Record<string, unknown> = {}) => ({
    lane: "mac",
    version: "0.1.0",
    kinds: ["desktop_mac", "ios_sim"],
    slots: 1,
    running: [],
    capabilities: { ffmpeg: { ok: true, drawtext: true } },
    waitSeconds: 10,
    ...over,
  });
  const jobRow = async (id: string) => (await testDb.select().from(realSchema.nativeJobs).where(eq(realSchema.nativeJobs.id, id)))[0]!;
  const labRow = async (lane: "mac" | "windows") => (await testDb.select().from(realSchema.nativeLabs).where(eq(realSchema.nativeLabs.lane, lane)))[0]!;

  async function enqueue(s: Seeded, over: Partial<import("@/lib/native/queue").EnqueueInput> = {}) {
    const job = await queue.enqueueJob(
      { runId: s.runId, buildId: s.buildId, productId: s.productId, kind: "desktop_mac", tier: "ship", input: macInput(), ...over },
      { wakeWindows: async () => ({ started: true, reason: "started" }) },
    );
    assert.ok(job.ok);
    return job.jobId;
  }
  /** A job claimed through the real route. */
  async function claimed(s: Seeded, over: Partial<import("@/lib/native/queue").EnqueueInput> = {}) {
    const id = await enqueue(s, over);
    const res = await claimRoute(post("/api/native/agent/claim", LAB_TOKEN, claimBody({ kinds: [over.kind ?? "desktop_mac"] })));
    assert.equal(res.status, 200);
    const { job } = (await res.json()) as { job: { id: string; token: string; runId: string } };
    assert.equal(job.id, id);
    return job;
  }

  describe("with NATIVE_LAB off", () => {
    it("every route is a 404 that touches nothing", async () => {
      const s = await seed();
      const id = await enqueue(s);
      process.env.NATIVE_LAB = "";
      const before = dbTouched;
      const good = LAB_TOKEN;
      const answers = await Promise.all([
        claimRoute(post("/api/native/agent/claim", good, claimBody())),
        heartbeatRoute(post("/x", good), ctx(id)),
        uploadRoute(post("/x", good, { files: [] }), ctx(id)),
        selftestPollRoute(post("/x", good), ctx(id)),
        finishRoute(post("/x", good, { outcome: "passed" }), ctx(id)),
        filesRoute(new Request(`${ORIGIN}/x`, { method: "PUT", body: "x", headers: { authorization: `Bearer ${good}` } }), { params: Promise.resolve({ id, name: "log.txt" }) }),
        selftestRoute(post("/api/native/selftest", tokens.selftestToken(id, new Date(Date.now() + 60_000)), { at: "x" })),
        cronRoute(new Request(`${ORIGIN}/api/cron/native-sweep`, { headers: { authorization: `Bearer ${CRON}` } })),
      ]);
      assert.deepEqual(answers.map((r) => r.status), [404, 404, 404, 404, 404, 404, 404, 404]);
      assert.equal(dbTouched, before, "not one query");
    });

    it("the queue refuses to take a job", async () => {
      const s = await seed();
      process.env.NATIVE_LAB = "";
      const refused = await queue.enqueueJob({ runId: s.runId, buildId: s.buildId, productId: s.productId, kind: "desktop_mac", tier: "ship", input: macInput() });
      assert.equal(refused.ok === false && refused.reason, "lab_off");
    });
  });

  describe("POST /api/native/agent/claim", () => {
    it("wants a lab token, for its own lane", async () => {
      assert.equal((await claimRoute(post("/c", null, claimBody()))).status, 401);
      assert.equal((await claimRoute(post("/c", "mmlab_nobody", claimBody()))).status, 401);
      assert.equal((await claimRoute(post("/c", WINDOWS_TOKEN, claimBody()))).status, 403);
      assert.equal((await labRow("windows")).lastSeenAt, null, "a refused call isn't presence");
      assert.equal((await claimRoute(post("/c", LAB_TOKEN, "not json"))).status, 400);
    });

    it("counts every call as presence, and a busy box's empty kinds gets a 204 at once", async () => {
      const s = await seed();
      const id = await enqueue(s);
      const res = await claimRoute(post("/c", LAB_TOKEN, claimBody({ kinds: [], running: ["job_x"] })));
      assert.equal(res.status, 204);
      const lab = await labRow("mac");
      assert.ok(lab.lastSeenAt);
      assert.equal(lab.version, "0.1.0");
      assert.deepEqual(lab.state?.running, ["job_x"]);
      assert.deepEqual(lab.state?.capabilities, { ffmpeg: { ok: true, drawtext: true } });
      assert.equal((await jobRow(id)).status, "queued", "and it takes no job");
    });

    it("answers 204 with nothing to do", async () => {
      assert.equal((await claimRoute(post("/c", LAB_TOKEN, claimBody()))).status, 204);
    });

    it("hands over a job the agent's own validator accepts, with the token in plain text only here", async () => {
      const s = await seed();
      const id = await enqueue(s, { kind: "ios_sim", selftest: true, input: macInput({ app: { kind: "ios_sim_app", variant: "lab", version: "1", url: "https://x.blob.vercel-storage.com/a.tgz", sha256: "a".repeat(64), bundleId: "ai.musemuse.lab" } }) });
      const res = await claimRoute(post("/c", LAB_TOKEN, claimBody({ kinds: ["ios_sim"] })));
      assert.equal(res.status, 200);
      const { job } = (await res.json()) as { job: Record<string, unknown> & { token: string } };
      assert.equal(job.id, id);
      assert.equal(job.kind, "ios_sim");
      assert.equal(job.attempt, 1);
      assert.equal(job.runId, s.runId);
      const checked = validateJob(job, { lane: "mac", platformOrigin: ORIGIN });
      assert.equal(checked.ok, true, checked.ok ? "" : checked.error);
      const row = await jobRow(id);
      assert.equal(row.tokenHash, tokens.hashLabToken(job.token));
      assert.ok(!JSON.stringify(row).includes(job.token), "the plain token isn't stored");
      assert.equal(verify(job), id);
    });
    const verify = (job: Record<string, unknown>) => tokens.verifySelftestToken(((job.input as { selftest: { token: string } }).selftest).token);

    it("won't give a box another lane's job", async () => {
      await enqueue(await seed(), { kind: "desktop_windows" });
      assert.equal((await claimRoute(post("/c", LAB_TOKEN, claimBody({ kinds: ["desktop_windows"] })))).status, 204);
    });
  });

  describe("what a job token covers", () => {
    const routes = (id: string, token: string | null) => [
      ["heartbeat", () => heartbeatRoute(post("/x", token, { phase: "record", attempt: 1 }), ctx(id))],
      ["upload", () => uploadRoute(post("/x", token, { files: [] }), ctx(id))],
      ["selftest", () => selftestPollRoute(post("/x", token), ctx(id))],
      ["finish", () => finishRoute(post("/x", token, { outcome: "passed", summary: "x" }), ctx(id))],
    ] as const;

    it("no token is a 401, a wrong token or a stranger's job a 410", async () => {
      const s = await seed();
      const job = await claimed(s);
      for (const [name, call] of routes(job.id, null)) assert.equal((await call()).status, 401, name);
      for (const [name, call] of routes(job.id, "mmjob_not-this-jobs-token")) assert.equal((await call()).status, 410, name);
      for (const [name, call] of routes("00000000-0000-4000-8000-000000000000", job.token)) assert.equal((await call()).status, 410, name);
      for (const [name, call] of routes("../etc/passwd", job.token)) assert.equal((await call()).status, 410, name);
      assert.equal((await jobRow(job.id)).status, "claimed");
    });

    it("the lab token isn't a job token", async () => {
      const job = await claimed(await seed());
      for (const [name, call] of routes(job.id, LAB_TOKEN)) assert.equal((await call()).status, 410, name);
    });

    it("another job's token isn't this job's", async () => {
      const s = await seed();
      const job = await claimed(s, { kind: "desktop_mac" });
      const other = await claimed(s, { kind: "ios_sim" });
      for (const [name, call] of routes(job.id, other.token)) assert.equal((await call()).status, 410, name);
    });

    it("a re-queued job answers 410 to its old run on every route, before and after its retry claims it", async () => {
      const s = await seed();
      const job = await claimed(s);
      assert.equal((await heartbeatRoute(post("/x", job.token), ctx(job.id))).status, 200);
      await testDb.update(realSchema.nativeJobs).set({ heartbeatAt: new Date(Date.now() - 100_000) }).where(eq(realSchema.nativeJobs.id, job.id));
      await queue.requeueSilentJobs();
      assert.equal((await jobRow(job.id)).tokenHash, null);
      for (const [name, call] of routes(job.id, job.token)) assert.equal((await call()).status, 410, `${name}, queued`);
      assert.equal((await jobRow(job.id)).status, "queued", "and it's still queued");

      const retry = await claimRoute(post("/c", LAB_TOKEN, claimBody({ kinds: ["desktop_mac"] })));
      const { job: second } = (await retry.json()) as { job: { token: string; attempt: number } };
      assert.equal(second.attempt, 2);
      for (const [name, call] of routes(job.id, job.token)) assert.equal((await call()).status, 410, `${name}, reclaimed`);
      assert.equal((await heartbeatRoute(post("/x", second.token), ctx(job.id))).status, 200);
    });

    it("a finished job answers 410 too", async () => {
      const job = await claimed(await seed());
      assert.equal((await finishRoute(post("/x", job.token, { outcome: "passed", summary: "x" }), ctx(job.id))).status, 200);
      for (const [name, call] of routes(job.id, job.token)) assert.equal((await call()).status, 410, name);
    });
  });

  describe("heartbeat", () => {
    it("updates heartbeat_at and answers cancel false, and a canceled job reads as a cancel to the agent", async () => {
      const s = await seed();
      const job = await claimed(s);
      await testDb.update(realSchema.nativeJobs).set({ heartbeatAt: new Date(Date.now() - 60_000) }).where(eq(realSchema.nativeJobs.id, job.id));
      const res = await heartbeatRoute(post("/x", job.token, { phase: "record", attempt: 1 }), ctx(job.id));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { cancel: false });
      assert.ok(Date.now() - (await jobRow(job.id)).heartbeatAt!.getTime() < 5000);

      await testDb.update(realSchema.nativeJobs).set({ status: "canceled", tokenHash: null }).where(eq(realSchema.nativeJobs.id, job.id));
      assert.equal((await heartbeatRoute(post("/x", job.token), ctx(job.id))).status, 410);
    });
  });

  describe("upload", () => {
    const file = (name: string, contentType: string, bytes = 100) => ({ name, contentType, bytes, sha256: "a".repeat(64) });
    const allFiles = [
      file("shot-1.jpg", "image/jpeg"),
      file("shot-4.jpg", "image/jpeg"),
      file("clip.mp4", "video/mp4", 4_200_000),
      file("poster.jpg", "image/jpeg"),
      file("report.json", "application/json"),
      file("log.txt", "text/plain"),
      file("logcat.txt", "text/plain"),
    ];

    it("gives Blob slots pinned to the job's folder, limited by size and type, with no random suffix", async () => {
      const job = await claimed(await seed());
      const res = await uploadRoute(post("/x", job.token, { files: allFiles }), ctx(job.id));
      assert.equal(res.status, 200);
      const { uploads } = (await res.json()) as { uploads: Array<Record<string, unknown>> };
      assert.deepEqual(uploads.map((u) => u.name), allFiles.map((f) => f.name));
      for (const slot of uploads) {
        assert.equal(slot.method, "blob");
        assert.equal(slot.pathname, `native/runs/${job.runId}/${job.id}/${slot.name}`);
        assert.equal(slot.multipart, false);
        const payload = slot.presignedUrlPayload as { delegationToken: string; signature: string; params: Record<string, string> };
        assert.ok(payload.delegationToken && payload.signature);
        assert.ok(!Object.hasOwn(slot, "url"));
      }
      const clip = issued.find((o) => String(o.pathname).endsWith("clip.mp4"))!;
      assert.deepEqual(clip.operations, ["put"]);
      assert.deepEqual(clip.allowedContentTypes, ["video/mp4"]);
      assert.equal(clip.maximumSizeInBytes, 16 * 1024 * 1024);
      assert.ok(Math.abs((clip.validUntil as number) - (Date.now() + 15 * 60_000)) < 10_000);
      const clipParams = (uploads.find((u) => u.name === "clip.mp4")!.presignedUrlPayload as { params: Record<string, string> }).params;
      assert.equal(clipParams["vercel-blob-add-random-suffix"], "false");
      assert.equal(clipParams["vercel-blob-allow-overwrite"], "true");
      assert.equal(clipParams["vercel-blob-allowed-content-types"], "video/mp4");
      assert.ok(issued.every((o) => String(o.pathname).startsWith(`native/runs/${job.runId}/${job.id}/`)));
    });

    it("gives no slot for a file it doesn't allow, while the rest still go", async () => {
      const job = await claimed(await seed());
      const res = await uploadRoute(
        post("/x", job.token, {
          files: [
            file("clip.mp4", "video/mp4"),
            file("clip.mp4", "video/mp4"),
            file("../../evil.mp4", "video/mp4"),
            file("native/runs/other/clip.mp4", "video/mp4"),
            file("shot-5.jpg", "image/jpeg"),
            file("poster.jpg", "text/html"),
            file("shot-1.jpg", "image/jpeg", 2 * 1024 * 1024 + 1),
            file("constructor", "image/jpeg"),
          ],
        }),
        ctx(job.id),
      );
      const { uploads } = (await res.json()) as { uploads: Array<{ name: string }> };
      assert.deepEqual(uploads.map((u) => u.name), ["clip.mp4"]);
    });

    it("on a local run with no Blob store, gives plain slots that its own route takes", async () => {
      delete process.env.BLOB_READ_WRITE_TOKEN;
      const job = await claimed(await seed());
      const res = await uploadRoute(post("/x", job.token, { files: [file("log.txt", "text/plain")] }), ctx(job.id));
      const { uploads } = (await res.json()) as { uploads: Array<{ method: string; url: string; headers: Record<string, string>; pathname: string }> };
      assert.equal(uploads[0]!.method, "put");
      assert.equal(uploads[0]!.url, `${ORIGIN}/api/native/agent/jobs/${job.id}/files/log.txt`);
      assert.equal(uploads[0]!.headers.authorization, `Bearer ${job.token}`);
      const put = (name: string, token: string | null, body: string | Uint8Array<ArrayBuffer> = "a log") =>
        filesRoute(new Request(uploads[0]!.url, { method: "PUT", body, headers: token ? { authorization: `Bearer ${token}` } : {} }), { params: Promise.resolve({ id: job.id, name }) });
      assert.equal((await put("log.txt", null)).status, 401);
      assert.equal((await put("log.txt", "nope")).status, 410);
      assert.equal((await put("evil.txt", job.token)).status, 404);
      assert.equal((await put("poster.jpg", job.token, new Uint8Array(2 * 1024 * 1024 + 1))).status, 413);
      const ok = await put("log.txt", job.token);
      assert.equal(ok.status, 200);
      const stored = (await ok.json()) as { url: string; pathname: string };
      assert.equal(stored.pathname, uploads[0]!.pathname);
      const { rm } = await import("node:fs/promises");
      const { localFilePaths } = await import("@/lib/storage");
      const { readFile } = await import("node:fs/promises");
      const paths = localFilePaths(stored.pathname);
      assert.equal(await readFile(paths.file, "utf8"), "a log");
      await rm(paths.file);
      await rm(paths.type);
    });

    it("the plain upload route doesn't exist once there's a Blob store, or on Vercel", async () => {
      const job = await claimed(await seed());
      const put = () =>
        filesRoute(new Request(`${ORIGIN}/x`, { method: "PUT", body: "x", headers: { authorization: `Bearer ${job.token}` } }), { params: Promise.resolve({ id: job.id, name: "log.txt" }) });
      assert.equal((await put()).status, 404);
      delete process.env.BLOB_READ_WRITE_TOKEN;
      process.env.VERCEL = "1";
      assert.equal((await put()).status, 404);
      delete process.env.VERCEL;
    });
  });

  describe("the shell's report", () => {
    it("goes in with the selftest token, as sent, and comes back to the agent", async () => {
      const s = await seed();
      const job = await claimed(s, { kind: "ios_sim", selftest: true });
      const row = await jobRow(job.id);
      const token = (row.input.selftest as { token: string }).token;
      const before = await selftestPollRoute(post("/x", job.token), ctx(job.id));
      assert.deepEqual(await before.json(), { report: null });
      const report = { v: 1, ok: true, at: "2026-11-01T12:00:00.123Z", finalUrl: "https://demo-product.vercel.app/", errors: ["e"] };
      const res = await selftestRoute(post("/api/native/selftest", token, report));
      assert.equal(res.status, 200);
      const after = await selftestPollRoute(post("/x", job.token), ctx(job.id));
      assert.deepEqual(await after.json(), { report });
    });

    it("a retry starts with no report, so it can't pass on the last attempt's", async () => {
      const s = await seed();
      const job = await claimed(s, { kind: "ios_sim", selftest: true });
      const token = ((await jobRow(job.id)).input.selftest as { token: string }).token;
      await selftestRoute(post("/api/native/selftest", token, { at: "old" }));
      await testDb.update(realSchema.nativeJobs).set({ heartbeatAt: new Date(Date.now() - 100_000) }).where(eq(realSchema.nativeJobs.id, job.id));
      await queue.requeueSilentJobs();
      assert.equal((await selftestRoute(post("/api/native/selftest", token, { at: "from the old run" }))).status, 410, "nothing is waiting while it's queued");
      const claim = await claimRoute(post("/c", LAB_TOKEN, claimBody({ kinds: ["ios_sim"] })));
      const { job: second } = (await claim.json()) as { job: { token: string; input: { selftest: { token: string } } } };
      assert.equal(second.input.selftest.token, token, "a retry keeps its selftest token");
      assert.deepEqual(await (await selftestPollRoute(post("/x", second.token), ctx(job.id))).json(), { report: null });
    });

    it("needs a real selftest token, and a body that's a small object", async () => {
      const s = await seed();
      const job = await claimed(s, { kind: "ios_sim", selftest: true });
      const token = ((await jobRow(job.id)).input.selftest as { token: string }).token;
      assert.equal((await selftestRoute(post("/s", null, { at: "x" }))).status, 401);
      assert.equal((await selftestRoute(post("/s", job.token, { at: "x" }))).status, 401, "a job token isn't a selftest token");
      assert.equal((await selftestRoute(post("/s", tokens.selftestToken(job.id, new Date(Date.now() - 1000)), { at: "x" }))).status, 401, "expired");
      assert.equal((await selftestRoute(post("/s", token, "[1]"))).status, 400);
      assert.equal((await selftestRoute(post("/s", token, "nope"))).status, 400);
      assert.equal((await selftestRoute(post("/s", token, { pad: "x".repeat(129 * 1024) }))).status, 400);
      assert.equal((await jobRow(job.id)).selftest, null);
    });

    it("a token for a job that doesn't exist changes nothing", async () => {
      const token = tokens.selftestToken("00000000-0000-4000-8000-000000000000", new Date(Date.now() + 60_000));
      assert.equal((await selftestRoute(post("/s", token, { at: "x" }))).status, 410);
    });
  });

  describe("finish", () => {
    const passed = (job: { id: string; runId: string }, over: Record<string, unknown> = {}) => ({
      outcome: "passed",
      informational: false,
      summary: "Checked on a Mac in the AWS device lab (macOS 15.5): opened in 1.5 s.",
      device: { name: "Mac", os: "macOS 15.5" },
      checks: [{ id: "loaded", ok: true, detail: "The page answered with HTTP 200." }, { id: "gatekeeper", ok: null }],
      reasons: [],
      warnings: ["Console error: a"],
      captionBurned: true,
      loadMs: 1500,
      durationMs: 58_000,
      attempt: 1,
      agentVersion: "0.1.0",
      artifacts: [artifact(job, "clip.mp4"), artifact(job, "poster.jpg"), artifact(job, "shot-1.jpg"), artifact(job, "report.json"), artifact(job, "log.txt")],
      error: null,
      ...over,
    });
    const artifact = (job: { id: string; runId: string }, name: string, over: Record<string, unknown> = {}) => ({
      name,
      role: "x",
      url: `https://teststore.public.blob.vercel-storage.com/native/runs/${job.runId}/${job.id}/${name}`,
      pathname: `native/runs/${job.runId}/${job.id}/${name}`,
      bytes: 1234,
      sha256: "b".repeat(64),
      contentType: "video/mp4",
      caption: "On a Mac in the AWS device lab",
      ...over,
    });
    const artifactsOf = (id: string) => testDb.select().from(realSchema.nativeArtifacts).where(eq(realSchema.nativeArtifacts.jobId, id));

    it("closes the job, keeps the result and adds an artifact row per file", async () => {
      const s = await seed();
      const job = await claimed(s);
      const res = await finishRoute(post("/x", job.token, passed(job)), ctx(job.id));
      assert.equal(res.status, 200);
      const row = await jobRow(job.id);
      assert.equal(row.status, "done");
      assert.equal(row.tokenHash, null);
      assert.ok(row.finishedAt);
      assert.equal(row.result?.outcome, "passed");
      assert.equal(row.result?.summary, passed(job).summary);
      assert.equal(row.result?.loadMs, 1500);
      const rows = await artifactsOf(job.id);
      assert.deepEqual(rows.map((a) => a.kind).sort(), ["clip", "log", "poster", "report", "shot"]);
      const clip = rows.find((a) => a.kind === "clip")!;
      assert.equal(clip.check, "passed");
      assert.equal(clip.bytes, 1234);
      assert.equal(clip.sha256, "b".repeat(64));
      assert.equal(clip.caption, "On a Mac in the AWS device lab");
      assert.equal(clip.productId, s.productId);
      assert.equal(clip.platform, "desktop_mac");
      assert.equal(clip.device, "Mac, macOS 15.5");
    });

    it("treats each link as a claim: only this job's folder, on the real store, and only allowed names", async () => {
      const s = await seed();
      const other = await claimed(s, { kind: "ios_sim" });
      const job = await claimed(s, { kind: "desktop_mac" });
      const warn = mock.method(console, "warn", () => {});
      const res = await finishRoute(
        post(
          "/x",
          job.token,
          passed(job, {
            artifacts: [
              artifact(job, "clip.mp4"),
              artifact(other, "poster.jpg"),
              artifact(job, "shot-1.jpg", { pathname: `native/products/${s.productId}/x/${"a"}.apk` }),
              artifact(job, "shot-2.jpg", { url: "https://evil.example.com/native/shot-2.jpg" }),
              artifact(job, "shot-3.jpg", { url: `http://teststore.public.blob.vercel-storage.com/native/runs/${job.runId}/${job.id}/shot-3.jpg` }),
              artifact(job, "shot-4.jpg", { url: `https://teststore.public.blob.vercel-storage.com/native/runs/${job.runId}/${job.id}/other.jpg` }),
              artifact(job, "evil.exe"),
              "not even an object",
            ],
          }),
        ),
        ctx(job.id),
      );
      warn.mock.restore();
      assert.equal(res.status, 200);
      const rows = await artifactsOf(job.id);
      assert.deepEqual(rows.map((a) => a.pathname), [`native/runs/${job.runId}/${job.id}/clip.mp4`]);
      const stored = (await jobRow(job.id)).result?.artifacts as unknown[];
      assert.equal(stored.length, 1, "the stored result only names what was kept");
    });

    it("keeps the check when a field is wrong, since refusing it would waste the whole run", async () => {
      const job = await claimed(await seed());
      const res = await finishRoute(
        post("/x", job.token, { outcome: "failed", summary: 7, checks: "nope", warnings: [1, 2], reasons: ["x".repeat(1000)], loadMs: "fast", device: 3, artifacts: "none", extra: "ignored" }),
        ctx(job.id),
      );
      assert.equal(res.status, 200);
      const result = (await jobRow(job.id)).result!;
      assert.equal(result.outcome, "failed");
      assert.equal(result.summary, "This check didn't pass.");
      assert.deepEqual(result.checks, []);
      assert.deepEqual(result.warnings, []);
      assert.equal((result.reasons as string[])[0]!.length, 500);
      assert.equal(result.loadMs, null);
      assert.equal("extra" in result, false);
    });

    it("needs a real outcome, and a body of a sensible size", async () => {
      const job = await claimed(await seed());
      assert.equal((await finishRoute(post("/x", job.token, { summary: "no outcome" }), ctx(job.id))).status, 400);
      assert.equal((await finishRoute(post("/x", job.token, { outcome: "won" }), ctx(job.id))).status, 400);
      assert.equal((await finishRoute(post("/x", job.token, { outcome: "passed", pad: "x".repeat(257 * 1024) }), ctx(job.id))).status, 400);
      assert.equal((await jobRow(job.id)).status, "claimed", "and the agent can try again");
    });

    it("re-queues a retryable lab error with its token gone, and fails others", async () => {
      const s = await seed();
      const job = await claimed(s);
      const retry = await finishRoute(post("/x", job.token, { outcome: "lab_error", summary: "Not checked.", error: { code: "timeout", message: "x" } }), ctx(job.id));
      assert.equal(retry.status, 200);
      assert.deepEqual(await retry.json(), { ok: true, state: "retrying", status: "queued" });
      assert.equal((await jobRow(job.id)).status, "queued");
      assert.equal((await finishRoute(post("/x", job.token, { outcome: "passed", summary: "late" }), ctx(job.id))).status, 410);

      await testDb.delete(realSchema.nativeJobs);
      const other = await claimed(await seed());
      await finishRoute(post("/x", other.token, { outcome: "lab_error", summary: "Not checked.", error: { code: "tool_missing", message: "x" }, informational: true }), ctx(other.id));
      const row = await jobRow(other.id);
      assert.equal(row.status, "failed");
      assert.equal(row.result?.informational, false, "a box can't make its own check informational");
    });

    it("marks only a glasses check informational, whatever the box says", async () => {
      const job = await claimed(await seed(), { kind: "glasses_sim" });
      await finishRoute(post("/x", job.token, { outcome: "failed", summary: "No result.", informational: false }), ctx(job.id));
      assert.equal((await jobRow(job.id)).result?.informational, true);
    });

    it("keeps a link only on this platform's own store, for either credential", async () => {
      const job = await claimed(await seed(), { kind: "desktop_mac" });
      const warn = mock.method(console, "warn", () => {});
      const pathOf = (name: string) => `native/runs/${job.runId}/${job.id}/${name}`;
      await finishRoute(
        post("/x", job.token, passed(job, { artifacts: [artifact(job, "clip.mp4"), artifact(job, "poster.jpg", { url: `https://attacker.public.blob.vercel-storage.com/${pathOf("poster.jpg")}` })] })),
        ctx(job.id),
      );
      warn.mock.restore();
      assert.deepEqual((await artifactsOf(job.id)).map((a) => a.kind), ["clip"]);

      const saved = process.env.BLOB_READ_WRITE_TOKEN;
      delete process.env.BLOB_READ_WRITE_TOKEN;
      process.env.BLOB_STORE_ID = "store_AbC123";
      try {
        const { artifactLinkHolds } = await import("@/lib/native/agent-http");
        const pathname = pathOf("clip.mp4");
        assert.equal(artifactLinkHolds(job, "clip.mp4", pathname, `https://abc123.public.blob.vercel-storage.com/${pathname}`), true);
        assert.equal(artifactLinkHolds(job, "clip.mp4", pathname, `https://teststore.public.blob.vercel-storage.com/${pathname}`), false);
      } finally {
        delete process.env.BLOB_STORE_ID;
        process.env.BLOB_READ_WRITE_TOKEN = saved;
      }
    });

    it("lets a local run's links through only for its own files", async () => {
      delete process.env.BLOB_READ_WRITE_TOKEN;
      const job = await claimed(await seed());
      const folder = `native/runs/${job.runId}/${job.id}`;
      const res = await finishRoute(
        post("/x", job.token, passed(job, {
          artifacts: [
            artifact(job, "log.txt", { url: `${ORIGIN}/api/files/${folder}/log.txt` }),
            artifact(job, "clip.mp4", { url: `https://teststore.public.blob.vercel-storage.com/${folder}/clip.mp4` }),
          ],
        })),
        ctx(job.id),
      );
      assert.equal(res.status, 200);
      assert.deepEqual((await artifactsOf(job.id)).map((a) => a.kind), ["log"]);
    });
  });

  describe("the sweep's cron", () => {
    const cron = (token: string | null) => cronRoute(new Request(`${ORIGIN}/api/cron/native-sweep`, token ? { headers: { authorization: `Bearer ${token}` } } : {}));

    it("needs the cron secret", async () => {
      assert.equal((await cron(null)).status, 401);
      assert.equal((await cron("nope")).status, 401);
    });

    it("works with no boxes set up: only the queue and the ledger have anything to do", async () => {
      delete process.env.NATIVE_WINDOWS_INSTANCE_ID;
      delete process.env.NATIVE_MAC_INSTANCE_ID;
      const res = await cron(CRON);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; windows: { value: { did: string } }; mac: { value: { did: string } } };
      assert.equal(body.ok, true);
      assert.equal(body.windows.value.did, "skipped");
      assert.equal(body.mac.value.did, "skipped");
    });

    it("a sweep's failed AWS call shows as a 500 that names the task and carries no secret", async () => {
      process.env.NATIVE_WINDOWS_INSTANCE_ID = "i-0windows";
      delete process.env.AWS_ROLE_ARN;
      const logged = mock.method(console, "error", () => {});
      const res = await cron(CRON);
      logged.mock.restore();
      delete process.env.NATIVE_WINDOWS_INSTANCE_ID;
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.match(text, /AWS_ROLE_ARN/);
      assert.ok(!text.includes(CRON));
    });
  });
});
