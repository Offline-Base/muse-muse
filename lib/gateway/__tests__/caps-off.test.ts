/**
 * With every wave 3 flag off, every wave 3 gateway route answers 404 unknown_endpoint and touches no dependency
 * (docs/CAPABILITIES.md, section 1). Each unit adds its routes to ROUTES.
 *
 *   npx tsx --test lib/gateway/__tests__/caps-off.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAPS_PROOF_PER_MINUTE, handleCapsProof, type CapsProofDeps } from "@/lib/caps/proof";
import { CAP_FLAG, CAP_IDS } from "@/lib/caps/ids";
import { handleFetch, handleSend, handleVault, type ConnectDeps } from "@/lib/caps/connect/handler";
import { handleHook, handleJobs, type HookDeps, type JobsDeps } from "@/lib/caps/jobs/handler";
import { handleLive, type LiveDeps } from "@/lib/caps/live/handler";
import { handleData, handleIdentityUser, handleIdentityUserLink, handleIdentityUserTest, type DataDeps } from "@/lib/caps/data/handler";
import { handlePasskey, type PasskeyDeps } from "@/lib/caps/data/passkeys";
import { handleAsset, type AssetsDeps } from "@/lib/caps/media/assets";
import { handleDatasets, handleFiles, handleSearch, type FilesDeps } from "@/lib/caps/files/handler";
import { handleBrowse, handleExec, type CodeDeps } from "@/lib/caps/code/handler";
import { handleCodeSessions, type MuseCodeDeps } from "@/lib/caps/code/musecode/handler";
import { handleGlimmerChat, type GlimmerDeps } from "@/lib/caps/gpu/handler";
import { env } from "@/lib/env";
import { handleGadgetCall, PRODUCT_GADGET_TOOLS, type GadgetDeps } from "@/lib/gateway/gadget";

/** A dependency that fails the test if anything calls it. */
const untouched = <T extends (...args: never[]) => unknown>(name: string) =>
  ((..._args: never[]) => {
    throw new Error(`${name} was called with its flag off`);
  }) as unknown as T;

/** Unit 3's deps with the real flags and every other dependency failing the test if it's touched. */
const dataOff = (): DataDeps => ({
  servedCaps: () => env.servedCaps,
  signInOn: () => env.dataSignIn,
  findToken: untouched<DataDeps["findToken"]>("findToken"),
  product: untouched<DataDeps["product"]>("product"),
  adminEmails: [],
  hitRateLimits: untouched<DataDeps["hitRateLimits"]>("hitRateLimits"),
  reserveCounter: untouched<DataDeps["reserveCounter"]>("reserveCounter"),
  store: new Proxy({} as DataDeps["store"], { get: (_t, k) => untouched(`store.${String(k)}`) }),
  quotas: untouched<DataDeps["quotas"]>("quotas"),
  rules: untouched<DataDeps["rules"]>("rules"),
  platformUrl: "https://platform.example",
  productSlug: untouched<DataDeps["productSlug"]>("productSlug"),
});

/** Unit 4's deps with the real flags and every other dependency failing the test if it's touched. */
const filesOff = (): FilesDeps => ({
  servedCaps: () => env.servedCaps,
  searchOn: () => env.filesSearch,
  datasetsOn: () => env.filesDatasets,
  findToken: untouched<FilesDeps["findToken"]>("findToken"),
  product: untouched<FilesDeps["product"]>("product"),
  adminEmails: [],
  hitRateLimits: untouched<FilesDeps["hitRateLimits"]>("hitRateLimits"),
  store: new Proxy({} as FilesDeps["store"], { get: (_t, k) => untouched(`store.${String(k)}`) }),
  blob: new Proxy({} as FilesDeps["blob"], { get: (_t, k) => untouched(`blob.${String(k)}`) }),
  quotas: untouched<FilesDeps["quotas"]>("quotas"),
  rule: untouched<FilesDeps["rule"]>("rule"),
  fileById: untouched<FilesDeps["fileById"]>("fileById"),
  datasets: untouched<FilesDeps["datasets"]>("datasets"),
  gatewayUrl: "https://platform.example/api/gateway",
});

/** Unit 5's deps with the real flags and every other dependency failing the test if it's touched. */
const connectOff = (): ConnectDeps => ({
  servedCaps: () => env.servedCaps,
  vaultOn: () => env.connectVault,
  sendsOn: () => env.connectSends,
  findToken: untouched<ConnectDeps["findToken"]>("findToken"),
  product: untouched<ConnectDeps["product"]>("product"),
  adminEmails: [],
  hitRateLimits: untouched<ConnectDeps["hitRateLimits"]>("hitRateLimits"),
  reserveCounter: untouched<ConnectDeps["reserveCounter"]>("reserveCounter"),
  recordUsage: untouched<ConnectDeps["recordUsage"]>("recordUsage"),
  store: new Proxy({} as ConnectDeps["store"], { get: (_t, k) => untouched(`store.${String(k)}`) }),
  keyring: untouched<ConnectDeps["keyring"]>("keyring"),
  rules: untouched<ConnectDeps["rules"]>("rules"),
  fetch: untouched<ConnectDeps["fetch"]>("fetch"),
  userAgent: "test",
});

/** Unit 9's deps with the real flags and every other dependency failing the test if it's touched. */
const codeOff = (): CodeDeps => ({
  servedCaps: () => env.servedCaps,
  execOn: () => env.codeExec,
  browseOn: () => env.codeBrowse,
  visitorsOn: () => env.codeExecVisitors,
  findToken: untouched<CodeDeps["findToken"]>("findToken"),
  product: untouched<CodeDeps["product"]>("product"),
  adminEmails: [],
  hitRateLimits: untouched<CodeDeps["hitRateLimits"]>("hitRateLimits"),
  reserveCounter: untouched<CodeDeps["reserveCounter"]>("reserveCounter"),
  adjustCounter: untouched<CodeDeps["adjustCounter"]>("adjustCounter"),
  execDailyUsd: untouched<CodeDeps["execDailyUsd"]>("execDailyUsd"),
  browseDailyUsd: untouched<CodeDeps["browseDailyUsd"]>("browseDailyUsd"),
  spendToday: untouched<CodeDeps["spendToday"]>("spendToday"),
  execSnapshotId: untouched<CodeDeps["execSnapshotId"]>("execSnapshotId"),
  browseSnapshotId: untouched<CodeDeps["browseSnapshotId"]>("browseSnapshotId"),
  launch: untouched<CodeDeps["launch"]>("launch"),
  recordRun: untouched<CodeDeps["recordRun"]>("recordRun"),
  lookupHost: untouched<CodeDeps["lookupHost"]>("lookupHost"),
});

/** Muse Code sessions' deps with the real flags and everything else failing the test if it's touched. */
const museCodeOff = (): MuseCodeDeps =>
  new Proxy({ servedCaps: () => env.servedCaps, museCodeOn: () => env.museCodeEnabled, visitorsOn: () => env.museCodeVisitors } as unknown as MuseCodeDeps, {
    get: (t, k) => (k in t ? t[k as keyof MuseCodeDeps] : untouched(String(k))),
  });
const liveOff = (): LiveDeps => ({
  servedCaps: () => env.servedCaps,
  updatesOn: () => env.liveUpdates,
  findToken: untouched<LiveDeps["findToken"]>("findToken"),
  product: untouched<LiveDeps["product"]>("product"),
  adminEmails: [],
  hitRateLimits: untouched<LiveDeps["hitRateLimits"]>("hitRateLimits"),
  acquireInFlight: untouched<LiveDeps["acquireInFlight"]>("acquireInFlight"),
  releaseInFlight: untouched<LiveDeps["releaseInFlight"]>("releaseInFlight"),
  adjustCounter: untouched<LiveDeps["adjustCounter"]>("adjustCounter"),
  rules: untouched<LiveDeps["rules"]>("rules"),
  changes: untouched<LiveDeps["changes"]>("changes"),
  buildPreviewOrigin: untouched<LiveDeps["buildPreviewOrigin"]>("buildPreviewOrigin"),
});

/** Unit 11's deps with the real flag and every other dependency failing the test if it's touched. */
const glimmerOff = (): GlimmerDeps => ({
  on: () => env.gpuGlimmerShared,
  paused: untouched<GlimmerDeps["paused"]>("paused"),
  allProducts: untouched<GlimmerDeps["allProducts"]>("allProducts"),
  adminEmails: [],
  findToken: untouched<GlimmerDeps["findToken"]>("findToken"),
  product: untouched<GlimmerDeps["product"]>("product"),
  hitRateLimits: untouched<GlimmerDeps["hitRateLimits"]>("hitRateLimits"),
  openWindow: untouched<GlimmerDeps["openWindow"]>("openWindow"),
  ownModel: untouched<GlimmerDeps["ownModel"]>("ownModel"),
  startingFor: untouched<GlimmerDeps["startingFor"]>("startingFor"),
  backend: untouched<GlimmerDeps["backend"]>("backend"),
  recordUsage: untouched<GlimmerDeps["recordUsage"]>("recordUsage"),
});

/** The jobs cap's deps with the real flags and everything else failing the test if it's touched. */
const jobsOff = (): JobsDeps =>
  new Proxy({ servedCaps: () => env.servedCaps, webhooksOn: () => env.jobsWebhooks } as unknown as JobsDeps, {
    get: (t, k) => (k in t ? t[k as keyof JobsDeps] : untouched(String(k))),
  });
const hooksOff = (): HookDeps =>
  new Proxy({ servedCaps: () => env.servedCaps, webhooksOn: () => env.jobsWebhooks } as unknown as HookDeps, {
    get: (t, k) => (k in t ? t[k as keyof HookDeps] : untouched(String(k))),
  });

const ROUTES: Array<{ path: string; call(req: Request): Promise<Response> }> = [
  // Unit 3: saved data, its sign-in, and the platform's passkey routes.
  { path: "data", call: (req) => handleData(req, [], dataOff()) },
  { path: "data/items", call: (req) => handleData(req, ["items"], dataOff()) },
  { path: "data/items/query", call: (req) => handleData(req, ["items", "query"], dataOff()) },
  { path: "data/items/a1", call: (req) => handleData(req, ["items", "a1"], dataOff()) },
  { path: "identity/user", call: (req) => handleIdentityUser(req, dataOff()) },
  { path: "identity/user/test", call: (req) => handleIdentityUserTest(req, dataOff()) },
  { path: "identity/user/link", call: (req) => handleIdentityUserLink(req, dataOff()) },
  // Unit 4: kept files, their signed links and local uploads, search, and the vetted datasets.
  { path: "files", call: (req) => handleFiles(req, [], filesOff()) },
  { path: "files/ticket", call: (req) => handleFiles(req, ["ticket"], filesOff()) },
  { path: "files/0b9a3c2e-1d4f-4a6b-8c7d-9e0f1a2b3c4d", call: (req) => handleFiles(req, ["0b9a3c2e-1d4f-4a6b-8c7d-9e0f1a2b3c4d"], filesOff()) },
  { path: "files/0b9a3c2e-1d4f-4a6b-8c7d-9e0f1a2b3c4d/done", call: (req) => handleFiles(req, ["0b9a3c2e-1d4f-4a6b-8c7d-9e0f1a2b3c4d", "done"], filesOff()) },
  { path: "files/0b9a3c2e-1d4f-4a6b-8c7d-9e0f1a2b3c4d/content", call: (req) => handleFiles(req, ["0b9a3c2e-1d4f-4a6b-8c7d-9e0f1a2b3c4d", "content"], filesOff()) },
  { path: "search/index", call: (req) => handleSearch(req, ["index"], filesOff()) },
  { path: "search/query", call: (req) => handleSearch(req, ["query"], filesOff()) },
  { path: "search/remove", call: (req) => handleSearch(req, ["remove"], filesOff()) },
  { path: "datasets", call: (req) => handleDatasets(req, [], filesOff()) },
  { path: "datasets/palmer-penguins/penguins.csv", call: (req) => handleDatasets(req, ["palmer-penguins", "penguins.csv"], filesOff()) },
  // Unit 5: public APIs, the key vault and its calls, and sends.
  { path: "fetch", call: (req) => handleFetch(req, connectOff()) },
  { path: "vault", call: (req) => handleVault(req, [], connectOff()) },
  { path: "vault/call", call: (req) => handleVault(req, ["call"], connectOff()) },
  { path: "vault/github", call: (req) => handleVault(new Request(req.url, { method: req.method === "GET" ? "DELETE" : "POST", headers: req.headers }), ["github"], connectOff()) },
  { path: "send", call: (req) => handleSend(req, connectOff()) },
  // Unit 6: background jobs and the webhooks that start them.
  { path: "jobs/verify", call: (req) => handleJobs(new Request(req.url, { method: "POST", headers: req.headers }), ["verify"], jobsOff()) },
  { path: "jobs/checkpoint", call: (req) => handleJobs(new Request(req.url, { method: "POST", headers: req.headers }), ["checkpoint"], jobsOff()) },
  { path: "jobs/enqueue", call: (req) => handleJobs(new Request(req.url, { method: "POST", headers: req.headers }), ["enqueue"], jobsOff()) },
  { path: "jobs/notify", call: (req) => handleJobs(new Request(req.url, { method: "POST", headers: req.headers }), ["notify"], jobsOff()) },
  { path: "jobs/test-fire", call: (req) => handleJobs(new Request(req.url, { method: "POST", headers: req.headers }), ["test-fire"], jobsOff()) },
  { path: "hooks/p1/digest", call: (req) => handleHook(new Request(req.url, { method: "POST", headers: req.headers }), ["p1", "digest"], hooksOff()) },
  // Unit 9: running code on the platform, and opening a page the person typed.
  { path: "exec", call: (req) => handleExec(req, codeOff()) },
  { path: "browse", call: (req) => handleBrowse(req, codeOff()) },
  // Unit 9, 15b: Muse Code sessions.
  { path: "code/sessions", call: (req) => handleCodeSessions(req, [], museCodeOff()) },
  { path: "code/sessions/a1/events", call: (req) => handleCodeSessions(req, ["a1", "events"], museCodeOff()) },
  { path: "code/sessions/a1/steer", call: (req) => handleCodeSessions(req, ["a1", "steer"], museCodeOff()) },
  { path: "code/sessions/a1/stop", call: (req) => handleCodeSessions(req, ["a1", "stop"], museCodeOff()) },
  { path: "code/sessions/a1/result", call: (req) => handleCodeSessions(req, ["a1", "result"], museCodeOff()) },
  // Unit 11: the shared Glimmer endpoint.
  { path: "glimmer/v1/chat/completions", call: (req) => handleGlimmerChat(req, glimmerOff()) },
  // Unit 2: what the gateway saw for a build's namespace.
  {
    path: "caps/proof",
    call: (req) =>
      handleCapsProof(req, {
        enabledCaps: () => env.enabledCaps,
        findToken: untouched<CapsProofDeps["findToken"]>("findToken"),
        productStatus: untouched<CapsProofDeps["productStatus"]>("productStatus"),
        hitRateLimits: untouched<CapsProofDeps["hitRateLimits"]>("hitRateLimits"),
        counters: {},
      }),
  },
  // Unit 7: live updates' read tickets and streams.
  { path: "live/ticket", call: (req) => handleLive(req, ["ticket"], liveOff()) },
  { path: "live/stream", call: (req) => handleLive(req, ["stream"], liveOff()) },
  // Unit 8: vetted large files for products' pages, by sha256.
  {
    path: "assets/407375255d220d8ddf81e9a06d4100f80f870f8446e77d4f20951d2a4c08a156",
    call: (req) =>
      handleAsset(req, "407375255d220d8ddf81e9a06d4100f80f870f8446e77d4f20951d2a4c08a156", {
        enabledCaps: () => env.servedCaps,
        hitRateLimits: untouched<AssetsDeps["hitRateLimits"]>("hitRateLimits"),
        localPath: untouched<NonNullable<AssetsDeps["localPath"]>>("localPath"),
      }),
  },
];

describe("wave 3 gateway routes with every flag off", () => {
  for (const flag of CAP_IDS.map((id) => CAP_FLAG[id])) delete process.env[flag];
  delete process.env.GPU_GLIMMER_SHARED;

  for (const route of ROUTES) {
    it(`/${route.path} answers 404 unknown_endpoint, whatever the method and token`, async () => {
      for (const method of ["GET", "POST"]) {
        const req = new Request(`https://platform.example/api/gateway/${route.path}`, {
          method,
          headers: { authorization: "Bearer mm_build_anything_anything_anything" },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        const res = await route.call(req);
        assert.equal(res.status, 404, method);
        const body = (await res.json()) as { error: { code: string; type: string } };
        assert.equal(body.error.code, "unknown_endpoint");
        assert.equal(body.error.type, "not_found_error");
      }
    });
  }
});

describe("unit 4's other methods with every flag off", () => {
  const ID = "0b9a3c2e-1d4f-4a6b-8c7d-9e0f1a2b3c4d";
  for (const [method, path, parts] of [
    ["DELETE", `files/${ID}`, [ID]],
    ["PUT", `files/${ID}/upload`, [ID, "upload"]],
    ["HEAD", `files/${ID}/content`, [ID, "content"]],
    ["HEAD", "datasets/palmer-penguins/penguins.csv", null],
  ] as const) {
    it(`${method} /${path} answers 404 unknown_endpoint`, async () => {
      for (const flag of CAP_IDS.map((id) => CAP_FLAG[id])) delete process.env[flag];
      const req = new Request(`https://platform.example/api/gateway/${path}`, { method, headers: { authorization: "Bearer mm_build_anything_anything_anything" }, ...(method === "PUT" ? { body: "x" } : {}) });
      const res = parts ? await handleFiles(req, parts, filesOff()) : await handleDatasets(req, ["palmer-penguins", "penguins.csv"], filesOff());
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "unknown_endpoint");
    });
  }
});

describe("unit 13's routes with every flag off", () => {
  const HARDWARE_FLAGS = ["HARDWARE_ENABLED", "HARDWARE_BOARD_TOOLS", "HARDWARE_BOARD_REGISTRY", "HARDWARE_BOARD_KEY", "HARDWARE_GADGET_OWNER_CHECK"];
  const ID = "0b9a3c2e-1d4f-4a6b-8c7d-9e0f1a2b3c4d";

  it("the registry's routes answer 404 before asking who you are", async () => {
    for (const flag of HARDWARE_FLAGS) delete process.env[flag];
    const boards = await import("@/app/api/boards/route");
    const oneBoard = await import("@/app/api/boards/[id]/route");
    const productBoard = await import("@/app/api/products/[slug]/board/route");
    const req = (path: string, method: string) => new Request(`https://platform.example${path}`, { method, ...(method === "POST" ? { body: "{}" } : {}) });
    const slug = { params: Promise.resolve({ slug: "demo" }) };
    for (const res of [
      await boards.GET(),
      await boards.POST(req("/api/boards", "POST")),
      await oneBoard.DELETE(req(`/api/boards/${ID}`, "DELETE"), { params: Promise.resolve({ id: ID }) }),
      await productBoard.POST(req("/api/products/demo/board", "POST"), slug),
      await productBoard.DELETE(req("/api/products/demo/board", "DELETE"), slug),
    ]) {
      assert.equal(res.status, 404);
    }
  });

  it("/gadget stays what it was: three tools, DEVICE_MCP_URL's board, and no board tools", async () => {
    for (const flag of HARDWARE_FLAGS) delete process.env[flag];
    assert.equal(env.hardwareBoardTools, false);
    assert.equal(env.hardwareBoardToolsUsable, false);
    assert.equal(env.hardwareBoardRegistry, false);
    assert.equal(env.hardwareGadgetOwnerCheck, false);
    const called: string[] = [];
    const deps: GadgetDeps = {
      findToken: async () => ({ id: "t", productId: "p", scope: "live", allowedModels: ["muse-gadget"], dailyBudgetUsd: 3 }) as never,
      productStatus: async () => "live",
      hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 1])),
      board: () => ({ listTools: async () => [], callTool: async (name) => (called.push(name), { content: [], isError: false }) }),
    };
    const post = (tool: string) => new Request("https://platform.example/api/gateway/gadget", { method: "POST", headers: { authorization: "Bearer x" }, body: JSON.stringify({ tool }) });
    assert.equal((await handleGadgetCall(post("capture_image"), deps)).status, 200);
    assert.equal((await handleGadgetCall(post("read_sensor"), deps)).status, 400);
    assert.deepEqual(called, ["capture_image"]);
    assert.deepEqual([...PRODUCT_GADGET_TOOLS], ["describe_device", "capture_image", "record_audio"]);
  });
});

describe("unit 3's routes with the data cap served but DATA_SIGN_IN off", () => {
  it("the sign-in routes and the platform's passkey routes answer 404 and touch nothing", async () => {
    const on: DataDeps = { ...dataOff(), servedCaps: () => ["data"], signInOn: () => false };
    for (const call of [handleIdentityUser, handleIdentityUserTest, handleIdentityUserLink]) {
      const res = await call(new Request("https://platform.example/api/gateway/identity/user", { method: "POST", headers: { authorization: "Bearer mm_live_x" }, body: "{}" }), on);
      assert.equal(res.status, 404);
    }
    const passkeys = { enabled: () => false } as unknown as PasskeyDeps;
    for (const [kind, step] of [["register", "options"], ["register", "verify"], ["login", "options"], ["login", "verify"]] as const) {
      const res = await handlePasskey(new Request(`https://platform.example/api/u/passkey/${kind}/${step}`, { method: "POST", body: "{}" }), kind, step, passkeys);
      assert.equal(res.status, 404, `${kind}/${step}`);
    }
  });
});

describe("unit 4's routes with the files cap served but FILES_SEARCH and FILES_DATASETS off", () => {
  it("/search and /datasets answer 404 and touch nothing, and a local upload is refused on Vercel's storage", async () => {
    const on: FilesDeps = { ...filesOff(), servedCaps: () => ["files"], searchOn: () => false, datasetsOn: () => false };
    for (const [path, call] of [["query", () => handleSearch(new Request("https://platform.example/api/gateway/search/query", { method: "POST", headers: { authorization: "Bearer mm_live_x" }, body: "{}" }), ["query"], on)], ["datasets", () => handleDatasets(new Request("https://platform.example/api/gateway/datasets", { headers: { authorization: "Bearer mm_live_x" } }), [], on)]] as const) {
      const res = await call();
      assert.equal(res.status, 404, path);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "unknown_endpoint");
    }
    const upload = await handleFiles(new Request("https://platform.example/api/gateway/files/0b9a3c2e-1d4f-4a6b-8c7d-9e0f1a2b3c4d/upload", { method: "PUT", body: "x" }), ["0b9a3c2e-1d4f-4a6b-8c7d-9e0f1a2b3c4d", "upload"], { ...on, blob: { ...on.blob, mode: () => "public" } as FilesDeps["blob"] });
    assert.equal(upload.status, 404);
  });
});

describe("unit 9's routes with the code cap served but CODE_EXEC and CODE_BROWSE off", () => {
  it("/exec and /browse answer 404 and touch nothing", async () => {
    const on: CodeDeps = { ...codeOff(), servedCaps: () => ["code"], execOn: () => false, browseOn: () => false };
    for (const [path, call] of [["exec", handleExec], ["browse", handleBrowse]] as const) {
      const res = await call(new Request(`https://platform.example/api/gateway/${path}`, { method: "POST", headers: { authorization: "Bearer mm_live_x" }, body: "{}" }), on);
      assert.equal(res.status, 404, path);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "unknown_endpoint");
    }
  });
});

describe("/caps/proof with a cap on", () => {
  const NOW = new Date("2026-10-31T18:00:00Z");
  const token = (over: Partial<{ scope: string; buildId: string | null }> = {}) => ({ id: "tok-1", scope: "build", buildId: "11111111-1111-4111-8111-111111111111", productId: "p1", ...over });
  const get = (auth?: string, query = "") => new Request(`https://platform.example/api/gateway/caps/proof${query}`, { headers: auth ? { authorization: auth } : {} });
  let windows: Array<Date | null> = [];
  let hits = 0;
  const deps = (t: ReturnType<typeof token> | null, over: Partial<CapsProofDeps> = {}): CapsProofDeps => ({
    enabledCaps: () => ["data"],
    findToken: async () => t,
    productStatus: async () => "building",
    hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, ++hits])),
    counters: {
      data: async (buildId, { since }) => {
        windows.push(since);
        return { rows: buildId.length > 0 ? 3 : 0 };
      },
    },
    now: () => NOW,
    ...over,
  });

  it("answers a build token tied to its build with the counters for its namespace", async () => {
    const res = await handleCapsProof(get("Bearer mm_build_x"), deps(token()));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { buildId: "11111111-1111-4111-8111-111111111111", namespace: "b:11111111-1111-4111-8111-111111111111", since: null, caps: { data: { rows: 3 } } });
  });

  it("counts only from since, the time a verify started, so an earlier round's rows never pass a later verify", async () => {
    windows = [];
    const res = await handleCapsProof(get("Bearer x", "?since=2026-10-31T17:50:00.000Z"), deps(token()));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { since: string }).since, "2026-10-31T17:50:00.000Z");
    assert.deepEqual(windows, [new Date("2026-10-31T17:50:00.000Z")]);
    for (const bad of ["?since=yesterday", "?since=2026-11-01T18:00:00Z", "?since=2026-10-20T00:00:00Z"]) {
      const refused = await handleCapsProof(get("Bearer x", bad), deps(token()));
      assert.equal(refused.status, 400, bad);
      assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "invalid_arguments");
    }
  });

  it("refuses no token, a live token, a build token with no build, and a product that is off", async () => {
    assert.equal((await handleCapsProof(get(), deps(token()))).status, 401);
    assert.equal((await handleCapsProof(get("Bearer x"), deps(null))).status, 401);
    assert.equal((await handleCapsProof(get("Bearer x"), deps(token({ scope: "live" })))).status, 403);
    assert.equal((await handleCapsProof(get("Bearer x"), deps(token({ buildId: null })))).status, 403);
    for (const status of ["disabled", "failed", null] as const) {
      const res = await handleCapsProof(get("Bearer x"), deps(token(), { productStatus: async () => status }));
      assert.equal(res.status, 403, String(status));
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "product_disabled");
    }
  });

  it("rate limits one token's reads", async () => {
    hits = CAPS_PROOF_PER_MINUTE;
    const res = await handleCapsProof(get("Bearer x"), deps(token()));
    assert.equal(res.status, 429);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "rate_limited");
    hits = 0;
  });

  it("answers 405 to a POST and 502 when a counter fails", async () => {
    const post = new Request("https://platform.example/api/gateway/caps/proof", { method: "POST", headers: { authorization: "Bearer x" } });
    assert.equal((await handleCapsProof(post, deps(token()))).status, 405);
    const failing: CapsProofDeps = { ...deps(token()), counters: { data: async () => { throw new Error("db down"); } } };
    const res = await handleCapsProof(get("Bearer x"), failing);
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "cap_failed");
  });
});

describe("unit 5's routes with the connect cap served but CONNECT_VAULT and CONNECT_SENDS off", () => {
  it("/vault, /vault/call and /send answer 404 and touch nothing, and sends stay off on production without the owner's switch", async () => {
    const on: ConnectDeps = { ...connectOff(), servedCaps: () => ["connect"], vaultOn: () => false, sendsOn: () => false };
    const post = (path: string) => new Request(`https://platform.example/api/gateway/${path}`, { method: "POST", headers: { authorization: "Bearer mm_live_x" }, body: "{}" });
    for (const res of [await handleVault(post("vault"), [], on), await handleVault(post("vault/call"), ["call"], on), await handleSend(post("send"), on)]) {
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "unknown_endpoint");
    }
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { CONNECT_VAULT: "1", CONNECT_SENDS: "1", VERCEL_ENV: "production" });
      delete process.env.CONNECT_SENDS_PRODUCTION;
      assert.equal(env.connectSends, false, "off on production");
      process.env.VERCEL_ENV = "preview";
      assert.equal(env.connectSends, true, "on elsewhere");
      delete process.env.CONNECT_VAULT;
      assert.equal(env.connectSends, false, "sends need the vault");
      Object.assign(process.env, { CONNECT_VAULT: "1", VERCEL_ENV: "production", CONNECT_SENDS_PRODUCTION: "1" });
      assert.equal(env.connectSends, true, "the owner's switch");
    } finally {
      for (const k of ["CONNECT_VAULT", "CONNECT_SENDS", "CONNECT_SENDS_PRODUCTION", "VERCEL_ENV"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
