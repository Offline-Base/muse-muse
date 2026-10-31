/**
 * The real lab agent, as a process, against the real routes on a local HTTP server with PGlite. On a real desktop_mac job it
 * claims, downloads, unzips, checks a real signature, runs the app, composes with the real ffmpeg, uploads through the
 * local plain-PUT slots and finishes, and the rows and files are checked afterwards. The app is a small signed stand-in that
 * writes what native/shell-desktop/src/selftest.js writes, so no window opens and no page loads.
 *
 * Then what a real box has to survive: a job the platform cancels while it runs, and one the sweep re-queues under it,
 * whose old run has to find itself shut out and whose retry has to pass.
 *
 * It needs a Mac with ffmpeg, and it spends nothing. AWS is never called: no box has an instance id here.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/native/__tests__/agent-routes.e2e.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import { macInput, pruneStoredFolders, type Seeded, type TestDb } from "./helpers";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(HERE, "..", "..", "..", "native", "lab", "agent.mjs");
/** The version the agent reports is its package's. */
const AGENT_VERSION = (JSON.parse(readFileSync(path.join(path.dirname(AGENT), "package.json"), "utf8")) as { version: string }).version;
const TOOLS_OK =
  process.platform === "darwin" &&
  spawnSync("ffmpeg", ["-version"]).status === 0 &&
  spawnSync("ditto", ["-h"]).error === undefined &&
  spawnSync("codesign", ["-h"]).error === undefined;
const SAVED = { ...process.env };
const LAB_TOKEN = "mmlab_e2e-lab-token-abcdefghijkl";
const TARGET = "https://demo-product.vercel.app";

/** A signed stand-in for the desktop shell. It waits as long as the file at `waitFile` says, then reports. */
function buildApp(dir: string, waitFile: string): Buffer {
  const app = path.join(dir, "Demo.app");
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Demo</string><key>CFBundleIdentifier</key><string>ai.musemuse.e2e</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
  );
  const frames = path.join(app, "Contents", "Resources");
  for (const [i, color] of ["red", "green", "blue"].entries()) {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=640x400:d=0.04,drawbox=c=${color}:t=fill:w=60:h=60`, "-frames:v", "1", path.join(frames, `f${i}.jpg`)]);
  }
  const exe = path.join(app, "Contents", "MacOS", "Demo");
  writeFileSync(
    exe,
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in --muse-selftest=*) dir="\${arg#--muse-selftest=}" ;; esac
done
sleep "$(cat '${waitFile}')"
res="$(dirname "$0")/../Resources"
mkdir -p "$dir/frames" "$dir/stills"
cp "$res/f0.jpg" "$dir/frames/00001.jpg"
sleep 1
cp "$res/f1.jpg" "$dir/frames/00002.jpg"
sleep 1
cp "$res/f2.jpg" "$dir/frames/00003.jpg"
cp "$res/f2.jpg" "$dir/stills/01.jpg"
cat > "$dir/selftest.json" <<JSON
{"v":1,"ok":true,"finalUrl":"${TARGET}/","httpStatus":200,"loadMs":1500,"textLength":300,"handshake":true,"frames":3,"stills":1,"consoleErrors":["a console warning"],"crashed":false,"loadError":null}
JSON
`,
  );
  chmodSync(exe, 0o755);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "ignore" });
  const zip = path.join(dir, "Demo.zip");
  execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip]);
  return readFileSync(zip);
}

type Route = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** A plain HTTP server that does what Next's router does for these routes: match, then call the route's own export. */
async function mountRoutes(zip: Buffer) {
  const route = async (file: string, method: string) => ((await import(at(`../../../app/api/native/${file}/route.ts`))) as Record<string, Route>)[method]!;
  const claim = await route("agent/claim", "POST");
  const jobRoutes: Record<string, Route> = {
    heartbeat: await route("agent/jobs/[id]/heartbeat", "POST"),
    upload: await route("agent/jobs/[id]/upload", "POST"),
    selftest: await route("agent/jobs/[id]/selftest", "POST"),
    finish: await route("agent/jobs/[id]/finish", "POST"),
  };
  const files = await route("agent/jobs/[id]/files/[name]", "PUT");
  const seen: string[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      seen.push(`${req.method} ${url.pathname}`);
      try {
        if (url.pathname === "/app.zip") {
          res.end(zip);
          return;
        }
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
        const body = Buffer.concat(chunks);
        const request = new Request(url, { method: req.method, headers, ...(body.length ? { body } : {}) });
        const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
        const job = /^\/api\/native\/agent\/jobs\/([^/]+)\/(heartbeat|upload|selftest|finish)$/.exec(url.pathname);
        const file = /^\/api\/native\/agent\/jobs\/([^/]+)\/files\/([^/]+)$/.exec(url.pathname);
        let answer: Response;
        if (url.pathname === "/api/native/agent/claim") answer = await claim(request, params({}));
        else if (job) answer = await jobRoutes[job[2]!]!(request, params({ id: job[1]! }));
        else if (file && req.method === "PUT") answer = await files(request, params({ id: file[1]!, name: file[2]! }));
        else answer = new Response("{}", { status: 404 });
        res.statusCode = answer.status;
        answer.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(Buffer.from(await answer.arrayBuffer()));
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, seen, origin: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}` };
}

describe("the real agent against the real routes", { skip: !canMock ? "needs --experimental-test-module-mocks" : !TOOLS_OK ? "needs a Mac with ffmpeg" : false, timeout: 240_000 }, () => {
  let dir: string;
  let waitFile: string;
  let testDb: TestDb;
  let closeDb: () => Promise<void>;
  let server: Server;
  let origin: string;
  let seen: string[];
  let zipSha: string;
  let zipBytes: number;
  let agent: ChildProcess;
  let agentOutput = "";
  let queue: typeof import("@/lib/native/queue");
  let seed: () => Promise<Seeded>;
  const stored: string[] = [];

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-lab-e2e-"));
    waitFile = path.join(dir, "wait-seconds");
    writeFileSync(waitFile, "0");
    const zip = buildApp(dir, waitFile);
    zipSha = createHash("sha256").update(zip).digest("hex");
    zipBytes = zip.length;
    const helpers = await import("./helpers");
    ({ db: testDb, close: closeDb } = await helpers.makeTestDb());
    seed = () => helpers.seedRun(testDb);
    mock.module(at("../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    for (const key of ["BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "VERCEL", "NATIVE_WINDOWS_INSTANCE_ID", "NATIVE_MAC_INSTANCE_ID"]) delete process.env[key];
    process.env.NATIVE_LAB = "1";
    process.env.GATEWAY_TOKEN_PEPPER = "test-pepper-for-the-e2e";
    ({ server, origin, seen } = await mountRoutes(zip));
    process.env.PLATFORM_URL = origin;
    queue = await import(at("../queue.ts"));
    const { hashLabToken } = await import("@/lib/native/lab-token");
    await testDb.insert(realSchema.nativeLabs).values({ lane: "mac", tokenHash: hashLabToken(LAB_TOKEN) });

    const tokenFile = path.join(dir, "token");
    writeFileSync(tokenFile, LAB_TOKEN);
    agent = spawn(process.execPath, [AGENT], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "test",
        MUSE_LAB_LANE: "mac",
        MUSE_LAB_ROOT: path.join(dir, "lab"),
        MUSE_LAB_PLATFORM: origin,
        MUSE_LAB_ALLOW_INSECURE: "1",
        MUSE_LAB_TOKEN_FILE: tokenFile,
        MUSE_LAB_KINDS: "desktop_mac",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    agent.stdout?.on("data", (c) => (agentOutput += c));
    agent.stderr?.on("data", (c) => (agentOutput += c));
  });

  after(async () => {
    agent?.kill("SIGTERM");
    if (agent && agent.exitCode === null) await new Promise((resolve) => agent.once("exit", resolve));
    await new Promise((resolve) => server?.close(resolve));
    await closeDb?.();
    rmSync(dir, { recursive: true, force: true });
    const { localFilePaths } = await import("@/lib/storage");
    for (const key of stored) {
      const { file, type } = localFilePaths(key);
      rmSync(file, { force: true });
      rmSync(type, { force: true });
      pruneStoredFolders({ file, type });
    }
    process.env = { ...SAVED };
  });

  const jobRow = async (id: string) => (await testDb.select().from(realSchema.nativeJobs).where(eq(realSchema.nativeJobs.id, id)))[0]!;

  async function enqueue(tier: "ship" | "agent", wait = 0) {
    writeFileSync(waitFile, String(wait));
    const s = await seed();
    const input = macInput({
      limitSeconds: 180,
      selftestSeconds: 8,
      shots: 1,
      target: { url: `${TARGET}/` },
      app: { kind: "mac_zip", variant: "product", version: "1.0.0", url: `${origin}/app.zip`, sha256: zipSha, bytes: zipBytes },
    });
    const job = await queue.enqueueJob({ runId: s.runId, buildId: s.buildId, productId: s.productId, kind: "desktop_mac", tier, input });
    assert.ok(job.ok, JSON.stringify(job));
    return { id: job.jobId, ...s };
  }

  async function until<T>(what: string, check: () => Promise<T | false | null | undefined>, ms = 90_000): Promise<T> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = await check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for ${what}. Agent said:\n${agentOutput}`);
  }

  it("claims, uploads and finishes a desktop_mac job for real", async () => {
    const { id, buildId, runId } = await enqueue("ship");
    const job = await until("the job to finish", async () => {
      const row = await jobRow(id);
      return row.status !== "queued" && row.status !== "claimed" && row;
    });
    assert.equal(job.status, "done", JSON.stringify(job.result, null, 2));
    assert.equal(job.tokenHash, null);
    assert.equal(job.attempts, 1);
    const result = job.result!;
    assert.equal(result.outcome, "passed");
    assert.match(result.summary, /^Checked on a Mac in the AWS device lab \(macOS [\d.]+\): opened in 1\.5 s\.$/);
    assert.deepEqual(result.warnings, ["Console error: a console warning"]);
    assert.equal(result.agentVersion, AGENT_VERSION);
    const checks = result.checks as Array<{ id: string; ok: boolean | null }>;
    assert.equal(checks.find((c) => c.id === "codesign")?.ok, true);

    const artifacts = await testDb.select().from(realSchema.nativeArtifacts).where(eq(realSchema.nativeArtifacts.jobId, id));
    const kinds = artifacts.map((a) => a.kind).sort();
    assert.ok(kinds.includes("clip") && kinds.includes("poster") && kinds.includes("shot") && kinds.includes("report") && kinds.includes("log"), kinds.join());
    const { localFilePaths } = await import("@/lib/storage");
    for (const artifact of artifacts) {
      stored.push(artifact.pathname);
      assert.match(artifact.pathname, new RegExp(`^native/runs/${runId}/${id}/1/`));
      assert.equal(artifact.check, "passed");
      assert.ok(artifact.url.startsWith(`${origin}/api/files/native/runs/`), artifact.url);
      const { file } = localFilePaths(artifact.pathname);
      assert.ok(existsSync(file), artifact.pathname);
      const bytes = readFileSync(file);
      assert.equal(artifact.bytes, statSync(file).size);
      assert.equal(artifact.sha256, createHash("sha256").update(bytes).digest("hex"), "what landed is what the agent hashed");
    }
    const clip = artifacts.find((a) => a.kind === "clip")!;
    const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", localFilePaths(clip.pathname).file], { encoding: "utf8" });
    assert.equal(probe.stdout.trim(), "1920,1080", "a real composed clip");
    assert.match(clip.caption ?? "", /Mac/);

    const [lab] = await testDb.select().from(realSchema.nativeLabs).where(eq(realSchema.nativeLabs.lane, "mac"));
    assert.ok(lab!.lastSeenAt, "the box's presence was noted");
    assert.equal(lab!.version, AGENT_VERSION);
    assert.ok(Array.isArray(lab!.state?.kinds), "and what it can run");
    assert.ok(lab!.state?.capabilities, "and its tools");

    const { condenseNativeEvents } = await import("@/lib/types");
    const events = await testDb.select().from(realSchema.buildEvents).where(eq(realSchema.buildEvents.buildId, buildId));
    const views = condenseNativeEvents(events.map((e) => e.payload as { type: string }));
    assert.equal(views[0]!.items[0]!.state, "done");
    assert.equal(views[0]!.items[0]!.media?.[0]?.kind, "video");

    for (const route of ["claim", "heartbeat", "upload", "finish"]) assert.ok(seen.some((s) => s.includes(route)), `the agent called ${route}`);
    assert.ok(seen.some((s) => s.startsWith("PUT ") && s.endsWith("/clip.mp4")));
    assert.ok(!agentOutput.includes(LAB_TOKEN), "the lab token stays out of the agent's log");
  });

  it("a job canceled while it runs stops at its next heartbeat, and its finish changes nothing", async () => {
    const { id, buildId } = await enqueue("agent", 40);
    await until("the agent to take it", async () => (await jobRow(id)).status === "claimed");
    const beatsBefore = seen.filter((s) => s.endsWith(`/${id}/heartbeat`)).length;
    assert.equal(await queue.cancelAgentJobs(buildId), 1);
    const refused = await until("the old run's next heartbeat", async () => seen.filter((s) => s.endsWith(`/${id}/heartbeat`)).length > beatsBefore, 30_000);
    assert.ok(refused);
    await until("the agent to be free again", async () => {
      const [lab] = await testDb.select().from(realSchema.nativeLabs).where(eq(realSchema.nativeLabs.lane, "mac"));
      return (lab!.state?.running ?? []).length === 0;
    }, 30_000);
    const job = await jobRow(id);
    assert.equal(job.status, "canceled");
    assert.equal(job.result, null);
    assert.equal((await testDb.select().from(realSchema.nativeArtifacts).where(eq(realSchema.nativeArtifacts.jobId, id))).length, 0);
  });

  it("a job the sweep re-queues under a live run shuts the old run out, and its retry passes", async () => {
    const { id, runId } = await enqueue("ship", 40);
    await until("the agent to take it", async () => (await jobRow(id)).status === "claimed");
    const first = await jobRow(id);
    await testDb.update(realSchema.nativeJobs).set({ heartbeatAt: new Date(Date.now() - 100_000) }).where(eq(realSchema.nativeJobs.id, id));
    assert.deepEqual(await queue.requeueSilentJobs(), { requeued: 1, failed: 0 });
    assert.equal((await jobRow(id)).tokenHash, null);
    // The retry is quick, so the test proves the second attempt is what passed.
    writeFileSync(waitFile, "0");
    const finished = await until("the retry to finish", async () => {
      const row = await jobRow(id);
      return (row.status === "done" || row.status === "failed") && row;
    }, 120_000);
    assert.equal(finished.status, "done", JSON.stringify(finished.result, null, 2));
    assert.equal(finished.attempts, 2);
    assert.ok(finished.claimedAt!.getTime() > first.claimedAt!.getTime());
    const artifacts = await testDb.select().from(realSchema.nativeArtifacts).where(eq(realSchema.nativeArtifacts.jobId, id));
    for (const artifact of artifacts) stored.push(artifact.pathname);
    assert.ok(artifacts.every((a) => a.runId === runId));
    assert.equal(artifacts.filter((a) => a.kind === "clip").length, 1, "one clip, from the attempt that owned the job");
  });
});
