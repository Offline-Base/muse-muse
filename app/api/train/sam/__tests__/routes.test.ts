/**
 * The SAM 3.1 tune routes (SAM_TUNE): the admin routes under /api/train/sam and the office board's worker routes under
 * /api/train/sam/worker/. Auth, the run store, the worker auth and the spend counters are faked in memory, so this
 * checks the routes' own rules: every route is a 404 with the flag off, a wrong worker secret or job token is a 401,
 * the upload caps hold, a signed-out visitor sees only a shown run's report, and the board can't write the verdict.
 *
 *   npx tsx --experimental-test-module-mocks --test app/api/train/sam/__tests__/routes.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import type { SamReport, SamReportIn, SamRunView, SamSettingScore } from "@/lib/train/sam/types";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const savedEnv = { ...process.env };
const root = new URL("../../../../../", import.meta.url);
const at = (path: string) => new URL(path, root).href;

const RUN_ID = "0b6f2a8e-1c1d-4e5f-9a7b-1234567890ab";
const OTHER_ID = "1c7f3b9f-2d2e-4f60-8b8c-234567890abc";
const SECRET = "test-worker-secret-not-a-real-one";
const JOB_TOKEN = "test-job-token-not-a-real-one";
const BLOB = "https://abc123.public.blob.vercel-storage.com";

class FakeAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}
/** lib/http's own HttpError, loaded after auth is faked (lib/http imports it), so route() maps it to its status. */
let HttpError: typeof import("@/lib/http").HttpError;

type Who = "admin" | "visitor";
let who: Who = "admin";
let runs: Map<string, SamRunView>;
let uploads: Map<string, number>;
let calls: string[];
let dayCount: number;
let finished: SamReport | null;
/** Every URL the fake store's saveUpload handed out: the only links U1's validateReportIn lets a report use. */
let saved: string[];

function view(over: Partial<SamRunView> = {}): SamRunView {
  return {
    id: RUN_ID,
    word: "muse",
    generic: "plush toy",
    data: "builtin-muse",
    status: "draft",
    stage: null,
    queueAhead: 0,
    boardSeenAt: null,
    report: null,
    costUsd: 0,
    maxUsd: 1,
    shown: false,
    createdAt: "2026-11-03T20:00:00.000Z",
    photos: [],
    distractors: [],
    ...over,
  };
}

const score = (ap: number, fired: number): SamSettingScore => ({
  B: { n: 30, found: 28, top: 20, only: 10, otherBoxes: 40, ap, ap50: ap + 0.1 },
  A: { n: 30, firedPhotos: fired, boxes: fired * 2 },
  medianScore: 0.6,
  medianBestOther: 0.4,
});

function reportIn(over: Partial<SamReportIn> = {}): SamReportIn {
  return {
    version: 1,
    word: "muse",
    generic: "plush toy",
    seed: 7,
    setsSource: "nov3",
    settings: { meta_word: score(0.1, 2), meta_generic: score(0.5, 25), meta_toy: score(0.45, 20), tuned_word: score(0.62, 22) },
    truck: { meta: { truck: 1, wheel: 4 }, tuned: { truck: 1, wheel: 4 } },
    images: [
      {
        url: `${BLOB}/samtune/${RUN_ID}/report/ab12-sbs1.jpg`,
        rule: "tuned_top",
        caption: "The tune is perfect and tells Muse apart from every toy.",
        credit: "Photo by someone on Flickr, CC BY 2.0",
        license: "Attribution License",
      },
    ],
    files: { scores: `${BLOB}/samtune/${RUN_ID}/report/cd34-scores.json`, perImage: `${BLOB}/samtune/${RUN_ID}/report/ef56-per_image.json` },
    deltaSha256: "a".repeat(64),
    workerId: "jetson-03",
    apFrom: 0.05,
    timings: { train: 1200 },
    ...over,
  };
}

const ctx = (id = RUN_ID) => ({ params: Promise.resolve({ id }) });

function req(path: string, init: { body?: unknown; headers?: Record<string, string>; method?: string } = {}): Request {
  const raw = init.body;
  const body = raw === undefined ? undefined : raw instanceof Uint8Array || typeof raw === "string" ? raw : JSON.stringify(raw);
  return new Request(`https://muse.example.com${path}`, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: body as BodyInit | undefined,
  });
}
const worker = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${SECRET}`, ...extra });

type Handler = (req: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>;
const R: Record<string, Handler> = {};

describe("SAM tune routes", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module(at("lib/auth.ts"), {
      namedExports: {
        AuthError: FakeAuthError,
        requireAdminOrAutomation: async () => {
          if (who !== "admin") throw new FakeAuthError("Sign in first.", 401);
          return { id: "admin-1", email: "a@x", isAdmin: true };
        },
      },
    });
    ({ HttpError } = await import(at("lib/http.ts")));
    const { validateReportIn, finishReport } = await import(at("lib/train/sam/logic.ts"));
    const live = (id: string) => {
      const r = runs.get(id);
      return r && (r.status === "claimed" || r.status === "running") ? r : null;
    };
    // U1's worker-auth: 404 with the flag off, 401 for a wrong secret, 404 for a wrong job token or an ended run.
    const requireWorker = (r: Request) => {
      if (process.env.SAM_TUNE !== "1") throw new HttpError(404, "not_found");
      if (r.headers.get("authorization") !== `Bearer ${SECRET}`) throw new HttpError(401, "unauthorized");
    };
    mock.module(at("lib/train/sam/worker-auth.ts"), {
      namedExports: {
        JOB_TOKEN_HEADER: "x-job-token",
        requireWorker,
        requireRunToken: async (r: Request, id: string, token: unknown) => {
          requireWorker(r);
          if (!live(id) || token !== JOB_TOKEN) throw new HttpError(404, "not_found");
          return runs.get(id);
        },
      },
    });
    mock.module(at("lib/gateway/store.ts"), {
      namedExports: {
        reserveCounter: async (key: string, _w: Date, amount: number, limit: number) => {
          calls.push(`reserve:${key}:${amount}:${limit}`);
          if (dayCount + amount > limit) return null;
          dayCount += amount;
          return dayCount;
        },
        adjustCounter: async (key: string, _w: Date, delta: number) => {
          calls.push(`adjust:${key}:${delta}`);
          dayCount = Math.max(0, dayCount + delta);
        },
      },
    });
    // U1's store (lib/train/sam/store.ts), in memory, with U1's signatures. finish runs U1's real validateReportIn and
    // finishReport, so the done route is checked against the rules the real store applies.
    mock.module(at("lib/train/sam/store.ts"), {
      namedExports: {
        createRun: async (input: { word: string; generic: string; data: SamRunView["data"]; maxUsd?: number }) => {
          calls.push(`create:${input.maxUsd}`);
          if (input.data === "builtin-muse" && input.word !== "muse") return { ok: false, problem: "The built-in photos teach the name muse." };
          const r = view({ word: input.word, generic: input.generic, data: input.data, maxUsd: input.maxUsd ?? 1 });
          runs.set(r.id, r);
          return { ok: true, run: r };
        },
        getRunView: async (id: string, opts: { full?: boolean } = {}) => {
          const r = runs.get(id);
          if (!r) return null;
          if (opts.full) return r;
          const { photos: _p, distractors: _d, ...rest } = r;
          return rest;
        },
        queueRun: async (id: string) => {
          const r = runs.get(id);
          if (!r || r.status !== "draft") return false;
          r.status = "queued";
          return true;
        },
        claimNext: async (input: { workerId: string }) => {
          calls.push(`claim:${input.workerId}`);
          const r = [...runs.values()].find((x) => x.status === "queued");
          if (!r) return null;
          r.status = "claimed";
          return { id: r.id, word: r.word, generic: r.generic, data: r.data, photos: [], distractors: [], seed: 7, epochs: 3, jobToken: JOB_TOKEN };
        },
        progress: async (id: string, token: unknown, p: { stage: string }) => {
          const r = live(id);
          if (!r || token !== JOB_TOKEN) return null;
          r.status = "running";
          calls.push(`progress:${p.stage}`);
          return { stop: (r as SamRunView & { stopRequested?: boolean }).stopRequested === true };
        },
        saveUpload: async (id: string, token: unknown, name: string, _type: string, _bytes: Uint8Array) => {
          if (!live(id) || token !== JOB_TOKEN) return { ok: false, status: 404, error: "not_found" };
          const n = (uploads.get(id) ?? 0) + 1;
          if (n > 10) return { ok: false, status: 429, error: "too_many_files" };
          uploads.set(id, n);
          const url = `${BLOB}/samtune/${id}/report/r${n}-${name}`;
          saved.push(url);
          return { ok: true, url };
        },
        finish: async (id: string, token: unknown, body: unknown, byteLength?: number) => {
          const r = live(id);
          if (!r || token !== JOB_TOKEN) return { ok: false, status: 404, error: "not_found" };
          const checked = validateReportIn(body, { word: r.word, generic: r.generic, seed: 7, data: r.data, workerId: "jetson-03", uploads: saved }, byteLength);
          if (!checked.ok) return { ok: false, status: checked.problem === "report_too_large" ? 413 : 400, error: checked.problem };
          const report = finishReport(checked.report);
          finished = report;
          r.status = "done";
          r.report = report;
          return { ok: true, report };
        },
        fail: async (id: string, token: unknown, _reason: unknown) => {
          const r = live(id);
          if (!r || token !== JOB_TOKEN) return null;
          r.status = (r as SamRunView & { stopRequested?: boolean }).stopRequested ? "stopped" : "failed";
          return r.status;
        },
        requestStop: async (id: string) => {
          const r = runs.get(id);
          if (!r || ["done", "failed", "stopped"].includes(r.status)) return null;
          if (r.status === "draft" || r.status === "queued") r.status = "stopped";
          else (r as SamRunView & { stopRequested?: boolean }).stopRequested = true;
          return r.status;
        },
        markShown: async (id: string, shown: boolean) => {
          const r = runs.get(id);
          if (!r || r.status !== "done") return false;
          r.shown = shown;
          return true;
        },
      },
    });
    const load = async (path: string) => (await import(at(`app/api/train/sam/${path}`))).POST as Handler;
    R.create = await load("route.ts");
    R.get = (await import(at("app/api/train/sam/[id]/route.ts"))).GET as Handler;
    R.start = await load("[id]/start/route.ts");
    R.stop = await load("[id]/stop/route.ts");
    R.shown = await load("[id]/shown/route.ts");
    R.next = await load("worker/next/route.ts");
    R.progress = await load("worker/[id]/progress/route.ts");
    R.upload = await load("worker/[id]/upload/route.ts");
    R.done = await load("worker/[id]/done/route.ts");
    R.fail = await load("worker/[id]/fail/route.ts");
  });

  after(() => {
    mock.restoreAll();
    process.env = savedEnv;
  });

  beforeEach(() => {
    process.env.SAM_TUNE = "1";
    process.env.SAM_TUNE_DAILY_USD = "5";
    process.env.SAM_TUNE_MAX_USD = "1";
    who = "admin";
    runs = new Map();
    uploads = new Map();
    calls = [];
    dayCount = 0;
    finished = null;
    saved = [reportIn().files.scores, reportIn().files.perImage, reportIn().images[0]!.url];
  });

  it("every route is a 404 with SAM_TUNE off, before any auth or store call", async () => {
    delete process.env.SAM_TUNE;
    runs.set(RUN_ID, view({ status: "done", shown: true, report: { ...reportIn(), verdict: { code: "mixed", text: "x" }, caveats: [] } }));
    const all: [string, Request][] = [
      ["create", req("/api/train/sam", { body: { word: "muse", generic: "plush toy", data: "builtin-muse" } })],
      ["get", req(`/api/train/sam/${RUN_ID}`, { method: "GET" })],
      ["start", req(`/api/train/sam/${RUN_ID}/start`)],
      ["stop", req(`/api/train/sam/${RUN_ID}/stop`)],
      ["shown", req(`/api/train/sam/${RUN_ID}/shown`, { body: {} })],
      ["next", req("/api/train/sam/worker/next", { headers: worker(), body: { workerId: "jetson-03", freeMemMb: 7000, freeDiskMb: 900 } })],
      ["progress", req(`/api/train/sam/worker/${RUN_ID}/progress`, { headers: worker(), body: { jobToken: JOB_TOKEN, stage: "training" } })],
      ["upload", req(`/api/train/sam/worker/${RUN_ID}/upload?name=a.json`, { headers: worker({ "content-type": "application/json", "x-job-token": JOB_TOKEN }), body: "{}" })],
      ["done", req(`/api/train/sam/worker/${RUN_ID}/done`, { headers: worker(), body: { jobToken: JOB_TOKEN, report: reportIn() } })],
      ["fail", req(`/api/train/sam/worker/${RUN_ID}/fail`, { headers: worker(), body: { jobToken: JOB_TOKEN, reason: "x" } })],
    ];
    for (const flag of [undefined, "0"]) {
      if (flag) process.env.SAM_TUNE = flag;
      for (const [name, r] of all) {
        const res = await R[name](r.clone(), ctx());
        assert.equal(res.status, 404, `${name} with SAM_TUNE=${flag}`);
        assert.deepEqual(await res.json(), { error: "not_found" });
      }
    }
    assert.deepEqual(calls, []);
  });

  it("a wrong or missing worker secret is a 401 on every worker route", async () => {
    runs.set(RUN_ID, view({ status: "running" }));
    for (const authorization of [undefined, "Bearer wrong", `Basic ${SECRET}`, SECRET]) {
      const h: Record<string, string> = authorization ? { authorization } : {};
      const list: [string, Request][] = [
        ["next", req("/api/train/sam/worker/next", { headers: h, body: { workerId: "jetson-03", freeMemMb: 7000, freeDiskMb: 900 } })],
        ["progress", req(`/api/train/sam/worker/${RUN_ID}/progress`, { headers: h, body: { jobToken: JOB_TOKEN, stage: "training" } })],
        ["upload", req(`/api/train/sam/worker/${RUN_ID}/upload?name=a.json`, { headers: { ...h, "content-type": "application/json", "x-job-token": JOB_TOKEN }, body: "{}" })],
        ["done", req(`/api/train/sam/worker/${RUN_ID}/done`, { headers: h, body: { jobToken: JOB_TOKEN, report: reportIn() } })],
        ["fail", req(`/api/train/sam/worker/${RUN_ID}/fail`, { headers: h, body: { jobToken: JOB_TOKEN, reason: "x" } })],
      ];
      for (const [name, r] of list) assert.equal((await R[name](r, ctx())).status, 401, `${name} ${authorization}`);
    }
    assert.equal(runs.get(RUN_ID)!.status, "running");
    assert.deepEqual(calls, []);
  });

  it("the id routes need the run's own job token too (404, as U1's requireRunToken answers)", async () => {
    runs.set(RUN_ID, view({ status: "running" }));
    for (const jobToken of [undefined, "", "wrong"]) {
      assert.equal((await R.progress(req(`/x`, { headers: worker(), body: { jobToken, stage: "training" } }), ctx())).status, 404);
      assert.equal((await R.done(req(`/x`, { headers: worker(), body: { jobToken, report: reportIn() } }), ctx())).status, 404);
      assert.equal((await R.fail(req(`/x`, { headers: worker(), body: { jobToken, reason: "x" } }), ctx())).status, 404);
      const h = worker({ "content-type": "application/json", ...(jobToken === undefined ? {} : { "x-job-token": jobToken }) });
      assert.equal((await R.upload(req(`/x?name=a.json`, { headers: h, body: "{}" }), ctx())).status, 404);
    }
    assert.equal(runs.get(RUN_ID)!.status, "running");
  });

  it("the whole loop: create, start, claim, progress, upload, done, show, and a visitor reads the report", async () => {
    let res = await R.create(req("/api/train/sam", { body: { word: "muse", generic: " plush   toy ", data: "builtin-muse", maxUsd: 9 } }));
    assert.equal(res.status, 201);
    assert.deepEqual(calls, ["create:1"], "maxUsd is held to SAM_TUNE_MAX_USD and the generic word is tidied");
    assert.equal(runs.get(RUN_ID)!.generic, "plush toy");

    assert.equal((await R.next(req("/w", { headers: worker(), body: { workerId: "jetson-03", freeMemMb: 7000, freeDiskMb: 900 } }))).status, 204);

    res = await R.start(req("/s"), ctx());
    assert.equal(res.status, 200);
    assert.equal(runs.get(RUN_ID)!.status, "queued");

    res = await R.next(req("/w", { headers: worker(), body: { workerId: "jetson-03", freeMemMb: 7000, freeDiskMb: 900 } }));
    assert.equal(res.status, 200);
    const claim = ((await res.json()) as { run: { id: string; jobToken: string } }).run;
    assert.equal(claim.id, RUN_ID);
    assert.equal(claim.jobToken, JOB_TOKEN);
    assert.equal(res.headers.get("cache-control"), "no-store");

    res = await R.progress(req("/p", { headers: worker(), body: { jobToken: JOB_TOKEN, stage: "training", step: 3, steps: 40, line: "x".repeat(900) } }), ctx());
    assert.deepEqual(await res.json(), { stop: false });

    res = await R.upload(req("/u?name=sbs1.jpg", { headers: worker({ "content-type": "image/jpeg", "x-job-token": JOB_TOKEN }), body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]) }), ctx());
    assert.equal(res.status, 200);
    assert.match(((await res.json()) as { url: string }).url, new RegExp(`/samtune/${RUN_ID}/report/`));

    const boardSays = { ...reportIn(), verdict: { code: "better", text: "Perfect, tells Muse apart from every toy." }, caveats: [] };
    res = await R.done(req("/d", { headers: worker(), body: { jobToken: JOB_TOKEN, report: boardSays } }), ctx());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "done" });
    assert.ok(finished);
    assert.doesNotMatch(finished!.verdict.text, /Perfect|apart/, "the verdict is the server's, not the board's");
    assert.ok(finished!.caveats.length >= 4, "the server writes the caveats");
    assert.doesNotMatch(finished!.images[0].caption, /perfect|apart/, "the board's caption is replaced by the server's");
    assert.match(finished!.images[0].caption, /"muse".*"plush toy"/);
    assert.equal(finished!.images[0].license, "CC BY 2.0", "COCO's license name is kept in the short form");

    who = "visitor";
    assert.equal((await R.get(req(`/g`, { method: "GET" }), ctx())).status, 404, "not shown yet");
    assert.equal((await R.shown(req("/sh", { body: {} }), ctx())).status, 401, "only admins show a run");
    who = "admin";
    res = await R.shown(req("/sh", { body: {} }), ctx());
    assert.equal(res.status, 200);
    assert.equal(runs.get(RUN_ID)!.shown, true);

    who = "visitor";
    res = await R.get(req(`/g`, { method: "GET" }), ctx());
    assert.equal(res.status, 200);
    const pub = ((await res.json()) as { run: Record<string, unknown> & { report: Record<string, unknown> } }).run;
    assert.deepEqual(Object.keys(pub).sort(), ["costUsd", "createdAt", "generic", "id", "report", "status", "word"]);
    assert.equal(pub.report.workerId, undefined);
    assert.equal((pub.report.verdict as { text: string }).text, finished!.verdict.text);
    for (const key of ["photos", "distractors", "maxUsd", "boardSeenAt", "stage", "queueAhead"]) assert.equal(key in pub, false, key);
  });

  it("a signed-out GET of an unshown, unknown or unfinished run is a 404; an admin sees the whole view", async () => {
    who = "visitor";
    runs.set(RUN_ID, view({ status: "done", report: { ...reportIn(), verdict: { code: "mixed", text: "x" }, caveats: [] } }));
    runs.set(OTHER_ID, view({ id: OTHER_ID, status: "running", shown: true }));
    for (const id of [RUN_ID, OTHER_ID, "2d8f4c0a-3e3f-4071-9c9d-34567890abcd", "not-a-uuid"]) {
      const res = await R.get(req(`/g`, { method: "GET" }), ctx(id));
      assert.equal(res.status, 404, id);
    }
    who = "admin";
    const res = await R.get(req(`/g`, { method: "GET" }), ctx(RUN_ID));
    assert.equal(res.status, 200);
    const full = ((await res.json()) as { run: SamRunView }).run;
    assert.equal(full.maxUsd, 1);
    assert.deepEqual(full.photos, []);
  });

  it("admin routes refuse visitors and bad input", async () => {
    who = "visitor";
    assert.equal((await R.create(req("/c", { body: { word: "muse", generic: "plush toy", data: "builtin-muse" } }))).status, 401);
    runs.set(RUN_ID, view());
    assert.equal((await R.start(req("/s"), ctx())).status, 401);
    assert.equal((await R.stop(req("/s"), ctx())).status, 401);
    assert.equal(runs.get(RUN_ID)!.status, "draft");
    who = "admin";
    for (const body of [
      { word: "Muse", generic: "plush toy", data: "builtin-muse" },
      { word: "muse", generic: "1toy", data: "builtin-muse" },
      { word: "muse", generic: "plush toy", data: "elsewhere" },
      { word: "toy", generic: "toy", data: "uploads" },
      { word: "muse", generic: "plush toy", data: "builtin-muse", maxUsd: -1 },
    ]) {
      assert.equal((await R.create(req("/c", { body }))).status, 400, JSON.stringify(body));
    }
  });

  it("Start: a draft only, ready photos for an upload run, and the run and daily caps", async () => {
    runs.set(RUN_ID, view({ status: "queued" }));
    assert.equal((await R.start(req("/s"), ctx())).status, 409);

    runs.set(RUN_ID, view({ data: "uploads" }));
    const res = await R.start(req("/s"), ctx());
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { message: string }).message, /labeled photos/);

    runs.set(RUN_ID, view({ costUsd: 1.5, maxUsd: 1 }));
    assert.equal((await R.start(req("/s"), ctx())).status, 402);

    runs.set(RUN_ID, view());
    process.env.SAM_TUNE_DAILY_USD = "0";
    dayCount = 1;
    assert.equal((await R.start(req("/s"), ctx())).status, 402);
    assert.equal(runs.get(RUN_ID)!.status, "draft");
    assert.equal((await R.start(req("/s"), ctx(OTHER_ID))).status, 404);
  });

  it("Stop: a queued run stops at once, a running one is told at its next progress call and ends stopped", async () => {
    runs.set(RUN_ID, view({ status: "queued" }));
    assert.equal((await R.stop(req("/s"), ctx())).status, 200);
    assert.equal(runs.get(RUN_ID)!.status, "stopped");
    assert.equal((await R.stop(req("/s"), ctx())).status, 409, "already ended");
    assert.equal((await R.stop(req("/s"), ctx(OTHER_ID))).status, 404);

    runs.set(RUN_ID, view({ status: "running" }));
    assert.equal((await R.stop(req("/s"), ctx())).status, 200);
    const res = await R.progress(req("/p", { headers: worker(), body: { jobToken: JOB_TOKEN, stage: "training", step: 4 } }), ctx());
    assert.deepEqual(await res.json(), { stop: true });
    const failed = await R.fail(req("/f", { headers: worker(), body: { jobToken: JOB_TOKEN, reason: "stopped by the room" } }), ctx());
    assert.deepEqual(await failed.json(), { status: "stopped" });
  });

  it("upload: the 400 KB cap, the 10 files cap, names and types", async () => {
    runs.set(RUN_ID, view({ status: "running" }));
    const up = (name: string, body: Uint8Array | string, type: string, extra: Record<string, string> = {}) =>
      R.upload(req(`/u?name=${encodeURIComponent(name)}`, { headers: worker({ "content-type": type, "x-job-token": JOB_TOKEN, ...extra }), body }), ctx());
    const jpeg = (n: number) => {
      const b = new Uint8Array(n);
      b.set([0xff, 0xd8, 0xff]);
      return b;
    };

    assert.equal((await up("big.jpg", jpeg(400_001), "image/jpeg")).status, 413);
    assert.equal((await up("big.jpg", jpeg(10), "image/jpeg", { "content-length": "400001" })).status, 413, "a declared length over the cap");
    assert.equal((await up("ok.jpg", jpeg(400_000), "image/jpeg")).status, 200, "exactly 400 KB is fine");
    assert.equal((await up("../x.jpg", jpeg(10), "image/jpeg")).status, 400);
    assert.equal((await up("x.png", jpeg(10), "image/png")).status, 400);
    assert.equal((await up("x.jpg", jpeg(10), "application/json")).status, 415);
    assert.equal((await up("x.jpg", new Uint8Array([1, 2, 3, 4]), "image/jpeg")).status, 415, "not JPEG bytes");
    assert.equal((await up("x.json", "{nope", "application/json")).status, 415);
    assert.equal((await up("x.json", "", "application/json")).status, 400);
    for (let i = 2; i <= 10; i++) assert.equal((await up(`s${i}.json`, "{}", "application/json")).status, 200, `file ${i}`);
    assert.equal((await up("s11.json", "{}", "application/json")).status, 429);

    runs.set(OTHER_ID, view({ id: OTHER_ID, status: "done" }));
    assert.equal((await R.upload(req(`/u?name=a.json`, { headers: worker({ "content-type": "application/json", "x-job-token": JOB_TOKEN }), body: "{}" }), ctx(OTHER_ID))).status, 404);
  });

  it("done: refuses links to anything but this run's uploads, another word, unshowable photos and big reports", async () => {
    runs.set(RUN_ID, view({ status: "running" }));
    const done = (report: unknown) => R.done(req("/d", { headers: worker(), body: { jobToken: JOB_TOKEN, report } }), ctx());
    const img = reportIn().images[0];
    const bad: unknown[] = [
      { ...reportIn(), version: 2 },
      reportIn({ files: { scores: "https://evil.example.com/s.json", perImage: reportIn().files.perImage } }),
      reportIn({ files: { scores: `${BLOB}/samtune/${OTHER_ID}/report/s.json`, perImage: reportIn().files.perImage } }),
      reportIn({ images: [{ ...img, url: `${BLOB}/samtune/${RUN_ID}/photos/a.jpg` }] }),
      reportIn({ images: [{ ...img, url: `${BLOB}/samtune/${RUN_ID}/report/a.jpg?x=1` }] }),
      reportIn({ word: "bear" }),
      reportIn({ images: [{ ...img, license: "No known copyright restrictions" }] }),
      reportIn({ images: [{ ...img, license: null }] }),
      reportIn({ images: [{ ...img, credit: null }] }),
    ];
    for (const report of bad) assert.equal((await done(report)).status, 400, JSON.stringify(report).slice(0, 200));
    assert.equal((await done(reportIn({ timings: { pad: 1, ...Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`k${i}`, i])) } }))).status, 413);
    assert.equal(runs.get(RUN_ID)!.status, "running");
    assert.equal(finished, null);

    runs.set(RUN_ID, view({ status: "queued" }));
    assert.equal((await done(reportIn())).status, 404, "a run that wasn't claimed");
  });

  it("next and progress check their fields", async () => {
    for (const body of [{}, { workerId: "Jetson 03", freeMemMb: 1, freeDiskMb: 1 }, { workerId: "jetson-03", freeMemMb: -1, freeDiskMb: 1 }, { workerId: "jetson-03", freeMemMb: 1.5, freeDiskMb: 1 }]) {
      assert.equal((await R.next(req("/n", { headers: worker(), body }))).status, 400, JSON.stringify(body));
    }
    runs.set(RUN_ID, view({ status: "running" }));
    for (const extra of [{ stage: "dancing" }, { stage: "training", step: -1 }, { stage: "training", steps: "40" }, { stage: "training", line: 5 }]) {
      assert.equal((await R.progress(req("/p", { headers: worker(), body: { jobToken: JOB_TOKEN, ...extra } }), ctx())).status, 400, JSON.stringify(extra));
    }
    runs.set(RUN_ID, view({ status: "failed" }));
    assert.equal((await R.progress(req("/p", { headers: worker(), body: { jobToken: JOB_TOKEN, stage: "training" } }), ctx())).status, 404);
    assert.equal((await R.fail(req("/f", { headers: worker(), body: { jobToken: JOB_TOKEN, reason: "x" } }), ctx())).status, 404);
  });

  it("the cleanup sweep deletes old samtune uploads and keeps every report/ file", async () => {
    const { deleteSamTuneUploads, isSamReportPath } = await import(at("lib/train/sam/cleanup.ts"));
    const old = new Date("2026-10-01T00:00:00Z");
    const fresh = new Date("2026-11-03T00:00:00Z");
    const pages = [
      {
        blobs: [
          { url: "u1", pathname: `samtune/${RUN_ID}/photos/a.jpg`, uploadedAt: old },
          { url: "u2", pathname: `samtune/${RUN_ID}/report/sbs1.jpg`, uploadedAt: old },
        ],
        cursor: "c1",
        hasMore: true,
      },
      { blobs: [{ url: "u3", pathname: `samtune/${RUN_ID}/look/b.jpg`, uploadedAt: fresh }, { url: "u4", pathname: `samtune/${OTHER_ID}/c.jpg`, uploadedAt: old }], hasMore: false },
    ];
    const deleted: string[] = [];
    let page = 0;
    const count = await deleteSamTuneUploads(new Date("2026-10-27T00:00:00Z"), {
      list: async () => pages[page++],
      del: async (urls: string[]) => void deleted.push(...urls),
    });
    assert.equal(count, 2);
    assert.deepEqual(deleted, ["u1", "u4"]);
    assert.equal(isSamReportPath(`/samtune/${RUN_ID}/report/x.json`), true);
    assert.equal(isSamReportPath(`samtune/report/x.json`), false);
  });
});
