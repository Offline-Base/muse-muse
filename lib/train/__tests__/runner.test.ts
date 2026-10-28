/**
 * Compiles every Python string with python3 -m py_compile, then runs runner.py for real against a local HTTP server
 * standing in for the platform (and for the Vercel Blob API): the smoke recipe with allowNoGpu, a failing recipe,
 * uploads through the simple and multipart Blob protocols, dataset paging, eval callbacks, the cache folder, and the
 * glimmer-lora recipe with dryRun. Skipped when python3 is missing. Nothing here reaches Lambda.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/runner.test.ts
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { RECIPES } from "@/lib/train/recipes";
import { TRAIN_UPLOAD_TYPES } from "@/lib/train/types";
import { GLIMMER_PY } from "@/lib/train/recipes/glimmer";
import { RUNNER_PY } from "@/lib/train/recipes/runner";
import { SMOKE_PY } from "@/lib/train/recipes/smoke";

const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const JOB_ID = "test-job";
const BLOB_TOKEN = "vercel_blob_client_storeABC_c2lnbmVkLnBheWxvYWQ";

interface Hit {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

let server: Server;
let base = "";
let hits: Hit[] = [];
/** How the fake platform answers POST .../upload. With `location`, it answers a redirect there instead. */
let uploadAnswer: { status: number; body?: unknown; location?: string } = { status: 503, body: { error: "no_storage" } };
/** Grant bodies the fake platform answers in turn (status 200), before falling back to uploadAnswer. */
let grantBodies: unknown[] = [];
/** Answers the fake Blob API gives simple PUTs in turn, before it stores the file. */
let putAnswers: Array<{ status: number; body: unknown }> = [];
/** The pages GET .../dataset serves for each part. A part with no pages answers 404, as for a job with no dataset. */
let datasetPages: Record<string, Array<{ items: unknown[]; nextPage: number | null }>> = {};
/** How GET .../dataset answers instead of serving a page, the first `times` times. */
let datasetFailures: Array<{ status: number; location?: string }> = [];

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const hit: Hit = { method: req.method ?? "", path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks) };
      hits.push(hit);
      const jobBase = `/api/train/jobs/${JOB_ID}`;
      if (hit.method === "POST" && hit.path === `${jobBase}/events`) {
        res.writeHead(204).end();
      } else if (hit.method === "GET" && hit.path === `${jobBase}/dataset`) {
        const failure = datasetFailures.shift();
        const page = datasetPages[url.searchParams.get("part") ?? ""]?.[Number(url.searchParams.get("page"))];
        if (failure?.location) res.writeHead(failure.status, { location: failure.location }).end();
        else if (failure) json(res, failure.status, { error: "nope" });
        else if (page) json(res, 200, page);
        else json(res, 404, { error: "no_dataset" });
      } else if (hit.method === "POST" && hit.path === `${jobBase}/upload`) {
        if (grantBodies.length) json(res, 200, grantBodies.shift());
        else if (uploadAnswer.location) res.writeHead(uploadAnswer.status, { location: uploadAnswer.location }).end();
        else json(res, uploadAnswer.status, uploadAnswer.body ?? {});
      } else if (hit.method === "PUT" && hit.path === "/blob/") {
        const pathname = url.searchParams.get("pathname");
        const answer = putAnswers.shift();
        if (answer) json(res, answer.status, answer.body);
        else json(res, 200, { url: `https://storeabc.public.blob.vercel-storage.com/${pathname}`, pathname });
      } else if (hit.method === "POST" && hit.path === "/blob/mpu") {
        const action = req.headers["x-mpu-action"];
        if (action === "create") json(res, 200, { key: "models/test job/key", uploadId: "upload-1" });
        else if (action === "upload") json(res, 200, { etag: `etag-${req.headers["x-mpu-part-number"]}` });
        else json(res, 200, { url: `https://storeabc.public.blob.vercel-storage.com/${url.searchParams.get("pathname")}` });
      } else {
        json(res, 404, { error: "not_found" });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits = [];
  uploadAnswer = { status: 503, body: { error: "no_storage" } };
  grantBodies = [];
  putAnswers = [];
  datasetPages = {};
  datasetFailures = [];
});

interface RunResult {
  code: number | null;
  output: string;
  token: string;
}

/** Writes job.json, runner.py and recipe.py to a temp dir and runs the runner, like cloud-init does. */
async function runJob(recipe: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}, files: Record<string, string | Buffer> = {}): Promise<RunResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "muse-runner-"));
  const token = `tok_${randomBytes(32).toString("base64url")}`;
  try {
    const job = {
      jobId: JOB_ID,
      callbackBase: `${base}/api/train/jobs/${JOB_ID}`,
      token,
      params,
      maxMinutes: 5,
      recipe: "smoke",
      heartbeatSeconds: 1,
      ...extra,
    };
    await writeFile(path.join(dir, "job.json"), JSON.stringify(job));
    await writeFile(path.join(dir, "runner.py"), RUNNER_PY);
    await writeFile(path.join(dir, "recipe.py"), recipe);
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content);
    const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn("python3", ["-u", "runner.py", "job.json"], {
        cwd: dir,
        env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
      });
      let output = "";
      child.stdout.on("data", (c: Buffer) => (output += c.toString()));
      child.stderr.on("data", (c: Buffer) => (output += c.toString()));
      const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
    return { ...result, token };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function events(): Array<Record<string, unknown>> {
  return hits.filter((h) => h.path.endsWith("/events")).map((h) => JSON.parse(h.body.toString("utf8")));
}

function assertAuthorized(token: string) {
  const platformHits = hits.filter((h) => h.path.startsWith("/api/"));
  assert.ok(platformHits.length > 0);
  for (const h of platformHits) assert.equal(h.headers.authorization, `Bearer ${token}`, `${h.path} has the job token`);
  for (const h of hits.filter((x) => x.path.startsWith("/blob"))) {
    assert.ok(!JSON.stringify(h.headers).includes(token), "the job token never goes to Blob");
  }
}

function assertTokenNotPrinted(r: RunResult) {
  assert.ok(!r.output.includes(r.token), "the token never shows in stdout or stderr");
}

describe("python sources", { skip: hasPython ? false : "python3 is missing" }, () => {
  it("compiles runner.py and every recipe script", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "muse-pycompile-"));
    try {
      const sources: Record<string, string> = { "runner.py": RUNNER_PY, "smoke.py": SMOKE_PY, "glimmer.py": GLIMMER_PY };
      for (const r of RECIPES) sources[`recipe_${r.id.replace(/-/g, "_")}.py`] = r.script;
      for (const [name, source] of Object.entries(sources)) {
        const file = path.join(dir, name);
        await writeFile(file, source);
        const out = spawnSync("python3", ["-m", "py_compile", file], { encoding: "utf8" });
        assert.equal(out.status, 0, `${name}: ${out.stderr}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("has no em dashes", () => {
    for (const source of [RUNNER_PY, ...RECIPES.map((r) => r.script)]) assert.ok(!source.includes("\u2014"));
  });

  it("keeps glimmer's install pins, model and ATEM markers as Unsloth's guide and notebook have them", () => {
    for (const pin of [
      '"unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit"',
      "--index-url https://download.pytorch.org/whl/cu128",
      "'torchao>=0.16.0'",
      '"transformers==5.15.0"',
      '"--no-deps trl==0.22.2"',
      'INSTRUCTION_PART = "<|start|>user<|message|>"',
      'RESPONSE_PART = "<|start|>assistant to=user<|message|>"',
      'loss_type="nll"',
      'use_gradient_checkpointing="unsloth"',
    ]) {
      assert.ok(GLIMMER_PY.includes(pin), pin);
    }
  });

  it("declares exactly the media types the upload route takes", () => {
    const tuple = /^UPLOAD_TYPES = \(\n([\s\S]*?)\n\)$/m.exec(RUNNER_PY)?.[1] ?? "";
    const types = [...tuple.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(types, [...TRAIN_UPLOAD_TYPES]);
  });
});

describe("runner.py against a fake platform", { skip: hasPython ? false : "python3 is missing", timeout: 240_000 }, () => {
  it("runs the smoke recipe: heartbeat, progress, log, then done with metrics", async () => {
    const r = await runJob(SMOKE_PY, { allowNoGpu: true, tickSeconds: 1 });
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assertAuthorized(r.token);
    assertTokenNotPrinted(r);

    const evs = events();
    const types = evs.map((e) => e.type);
    assert.equal(types[0], "heartbeat");
    assert.equal(types.at(-1), "done");
    assert.ok(types.filter((t) => t === "heartbeat").length >= 2, `the heartbeat thread ran: ${types.join(",")}`);
    assert.equal(types.filter((t) => t === "progress").length, 3);
    assert.ok(types.includes("log"));
    assert.ok(types.indexOf("heartbeat") < types.indexOf("progress"));
    assert.ok(types.lastIndexOf("progress") < types.indexOf("done"));
    assert.equal(types.filter((t) => t === "done").length, 1);
    assert.ok(!types.includes("failed"));

    const steps = evs.filter((e) => e.type === "progress").map((e) => e.step);
    assert.deepEqual(steps, [1, 2, 3]);
    for (const e of evs.filter((x) => x.type === "progress")) assert.equal(e.totalSteps, 3);

    const done = evs.at(-1) as { summary?: string; metrics: Record<string, unknown> };
    assert.equal(typeof done.summary, "string");
    assert.ok(!("summary" in done.metrics), "summary is lifted out of the metrics");
    for (const key of ["missing", "disk_free_gb", "disk_total_gb", "gpu_count", "torch", "net_huggingface_co", "net_pypi_org"]) {
      assert.ok(key in done.metrics, `metrics has ${key}`);
    }
    for (const v of Object.values(done.metrics)) assert.ok(typeof v === "string" || typeof v === "number");
    assert.ok(typeof done.metrics.disk_free_gb === "number" && done.metrics.disk_free_gb > 0);
  });

  it("posts failed with the end of the traceback when the recipe raises", async () => {
    const recipe = [
      "def run(ctx):",
      "    ctx.progress(step=1, total_steps=2, message='about to fail')",
      "    raise ValueError('boom ' + 'x' * 5000)",
      "",
    ].join("\n");
    const r = await runJob(recipe, {});
    assert.equal(r.code, 1);
    assertAuthorized(r.token);
    assertTokenNotPrinted(r);
    const evs = events();
    const types = evs.map((e) => e.type);
    assert.equal(types[0], "heartbeat");
    assert.equal(types.at(-1), "failed");
    assert.ok(!types.includes("done"));
    const error = String(evs.at(-1)?.error);
    assert.ok(error.includes("ValueError"));
    assert.ok(Buffer.byteLength(error, "utf8") <= 3072);
  });

  it("posts failed when recipe.py has no run(ctx)", async () => {
    const r = await runJob("VALUE = 1\n", {});
    assert.equal(r.code, 1);
    assertTokenNotPrinted(r);
    const last = events().at(-1);
    assert.equal(last?.type, "failed");
    assert.ok(String(last?.error).includes("has no run(ctx)"));
  });

  it("blanks the token when a recipe logs it, runs a command with it or returns it", async () => {
    const recipe = [
      "import json, os",
      "def run(ctx):",
      "    here = os.path.dirname(os.path.abspath(__file__))",
      "    token = json.load(open(os.path.join(here, 'job.json')))['token']",
      "    ctx.log('log ' + token)",
      "    out = ctx.run('echo ' + token)",
      "    ctx.progress(message='progress ' + token)",
      "    return {'t': token, 'exit': out.returncode, 'summary': 'summary ' + token}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {});
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assertTokenNotPrinted(r);
    const evs = events();
    assert.ok(!JSON.stringify(evs).includes(r.token));
    assert.ok(evs.some((e) => e.type === "log" && String(e.text).includes("[job token]")));
    const done = evs.at(-1) as { summary: string; metrics: Record<string, unknown> };
    assert.deepEqual(done.metrics, { t: "[job token]", exit: 0 });
    assert.equal(done.summary, "summary [job token]");
  });

  it("returns None and logs when the platform has no storage", async () => {
    const recipe = [
      "import os",
      "def run(ctx):",
      "    p = os.path.join(ctx.work_dir, 'a.bin')",
      "    open(p, 'wb').write(b'abc')",
      "    url = ctx.upload(p, 'a.bin', 'adapter')",
      "    return {'uploaded': 'no' if url is None else 'yes'}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {});
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    const evs = events();
    assert.ok(evs.some((e) => e.type === "log" && String(e.text).includes("storage not configured")));
    assert.ok(!evs.some((e) => e.type === "artifact"));
    assert.deepEqual((evs.at(-1) as { metrics: unknown }).metrics, { uploaded: "no" });
    assert.equal(hits.filter((h) => h.path.endsWith("/upload")).length, 1, "a 503 from /upload is not retried");
  });

  it("never follows a redirect, so the job token can't be sent anywhere else", async () => {
    uploadAnswer = { status: 302, location: "/stolen" };
    const recipe = [
      "import os",
      "def run(ctx):",
      "    p = os.path.join(ctx.work_dir, 'a.bin')",
      "    open(p, 'wb').write(b'abc')",
      "    ctx.upload(p, 'a.bin', 'adapter')",
      "    return {}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {});
    assert.equal(r.code, 1, "the upload fails, so the job fails");
    assert.equal(hits.filter((h) => h.path === "/stolen").length, 0, "the redirect was not followed");
    assert.equal(hits.filter((h) => h.path.endsWith("/upload")).length, 1, "a redirect is not retried");
    const failed = events().at(-1) as { type: string; error: string };
    assert.equal(failed.type, "failed");
    assert.match(failed.error, /HTTP 302/);
    assertTokenNotPrinted(r);
  });

  it("uploads like @vercel/blob put() with a client token, simple and multipart", async () => {
    uploadAnswer = { status: 200, body: { clientToken: BLOB_TOKEN, pathname: "models/test-job/adapter.safetensors" } };
    const small = Buffer.from("small adapter bytes");
    const big = randomBytes(10_000);
    const recipe = [
      "import os, shutil",
      "def run(ctx):",
      "    here = os.path.dirname(os.path.abspath(__file__))",
      "    a = ctx.upload(os.path.join(here, 'small.bin'), 'adapter.safetensors', 'adapter')",
      "    b = ctx.upload(os.path.join(here, 'big.bin'), 'checkpoint.bin', 'checkpoint')",
      "    return {'a': a, 'b': b}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {}, { blobApiUrl: `${base}/blob`, multipartOverBytes: 1024, partBytes: 4096 }, { "small.bin": small, "big.bin": big });
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assertAuthorized(r.token);
    assertTokenNotPrinted(r);
    assert.ok(!r.output.includes(BLOB_TOKEN), "the Blob client token isn't printed either");

    const grants = hits.filter((h) => h.path.endsWith("/upload")).map((h) => JSON.parse(h.body.toString("utf8")));
    assert.deepEqual(grants[0], { name: "adapter.safetensors", bytes: small.length, contentType: "application/octet-stream" });
    assert.deepEqual(grants[1], { name: "checkpoint.bin", bytes: big.length, contentType: "application/octet-stream" });

    const blobHits = hits.filter((h) => h.path.startsWith("/blob"));
    for (const h of blobHits) {
      assert.equal(h.headers.authorization, `Bearer ${BLOB_TOKEN}`);
      assert.equal(h.headers["x-api-version"], "13");
      assert.equal(h.headers["x-vercel-blob-access"], "public");
      assert.equal(h.headers["x-vercel-blob-store-id"], "storeABC");
      assert.equal(h.headers["x-content-type"], "application/octet-stream");
      assert.match(String(h.headers["x-api-blob-request-id"]), /^storeABC:\d+:[0-9a-f]+$/);
      assert.equal(h.headers["x-api-blob-request-attempt"], "0");
      assert.equal(h.query.get("pathname"), "models/test-job/adapter.safetensors");
    }

    const put = blobHits.find((h) => h.method === "PUT");
    assert.ok(put);
    assert.equal(put.path, "/blob/");
    assert.deepEqual(put.body, small);

    const mpu = blobHits.filter((h) => h.path === "/blob/mpu");
    const actions = mpu.map((h) => h.headers["x-mpu-action"]);
    assert.deepEqual(actions, ["create", "upload", "upload", "upload", "complete"]);
    const parts = mpu.filter((h) => h.headers["x-mpu-action"] === "upload");
    assert.deepEqual(parts.map((h) => h.headers["x-mpu-part-number"]), ["1", "2", "3"]);
    for (const h of [...parts, mpu.at(-1)!]) {
      assert.equal(h.headers["x-mpu-upload-id"], "upload-1");
      assert.equal(h.headers["x-mpu-key"], encodeURIComponent("models/test job/key"));
    }
    assert.deepEqual(Buffer.concat(parts.map((h) => h.body)), big);
    const complete = mpu.at(-1)!;
    assert.equal(complete.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(complete.body.toString("utf8")), [
      { partNumber: 1, etag: "etag-1" },
      { partNumber: 2, etag: "etag-2" },
      { partNumber: 3, etag: "etag-3" },
    ]);

    const artifacts = events().filter((e) => e.type === "artifact").map((e) => e.artifact);
    const url = "https://storeabc.public.blob.vercel-storage.com/models/test-job/adapter.safetensors";
    assert.deepEqual(artifacts, [
      { name: "adapter.safetensors", kind: "adapter", url, bytes: small.length },
      { name: "checkpoint.bin", kind: "checkpoint", url, bytes: big.length },
    ]);
    assert.deepEqual((events().at(-1) as { metrics: unknown }).metrics, { a: url, b: url });
  });
  it("declares a media type the platform takes, and octet-stream for any other", async () => {
    grantBodies = ["a", "b", "c", "d"].map((n) => ({ clientToken: BLOB_TOKEN, pathname: `models/test-job/${n}` }));
    const recipe = [
      "import os",
      "def run(ctx):",
      "    for name in ['notes.txt', 'scores.tsv', 'bundle.tar.gz', 'page.pdf']:",
      "        p = os.path.join(ctx.work_dir, name)",
      "        open(p, 'wb').write(b'abc')",
      "        ctx.upload(p, name, 'other')",
      "    return {}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {}, { blobApiUrl: `${base}/blob` });
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    const declared = hits.filter((h) => h.path.endsWith("/upload")).map((h) => JSON.parse(h.body.toString("utf8")).contentType);
    assert.deepEqual(declared, ["text/plain", "application/octet-stream", "application/octet-stream", "application/octet-stream"]);
    const sent = hits.filter((h) => h.method === "PUT").map((h) => h.headers["x-content-type"]);
    assert.deepEqual(sent, declared, "Blob gets the type the grant allows");
  });

  it("uploads once more under a fresh grant when Blob refuses a retried put", async () => {
    grantBodies = [
      { clientToken: BLOB_TOKEN, pathname: "models/test-job/first-a.bin" },
      { clientToken: BLOB_TOKEN, pathname: "models/test-job/second-a.bin" },
    ];
    // The first put may have stored the file before its 500; the retry finds the pathname taken.
    putAnswers = [
      { status: 500, body: { error: { code: "service_unavailable", message: "try again" } } },
      { status: 400, body: { error: { code: "bad_request", message: "This blob already exists" } } },
    ];
    const recipe = [
      "import os",
      "def run(ctx):",
      "    p = os.path.join(ctx.work_dir, 'a.bin')",
      "    open(p, 'wb').write(b'abc')",
      "    return {'url': ctx.upload(p, 'a.bin', 'adapter')}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {}, { blobApiUrl: `${base}/blob` });
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assert.equal(hits.filter((h) => h.path.endsWith("/upload")).length, 2, "one fresh grant");
    const puts = hits.filter((h) => h.method === "PUT");
    assert.deepEqual(
      puts.map((h) => [h.query.get("pathname"), h.headers["x-api-blob-request-attempt"]]),
      [
        ["models/test-job/first-a.bin", "0"],
        ["models/test-job/first-a.bin", "1"],
        ["models/test-job/second-a.bin", "0"],
      ],
    );
    const url = "https://storeabc.public.blob.vercel-storage.com/models/test-job/second-a.bin";
    assert.deepEqual(events().filter((e) => e.type === "artifact").map((e) => (e.artifact as { url: string }).url), [url]);
    assertTokenNotPrinted(r);
    assert.ok(!r.output.includes(BLOB_TOKEN));
  });

  it("fails the upload, with no second grant, when Blob refuses the first put", async () => {
    grantBodies = [{ clientToken: BLOB_TOKEN, pathname: "models/test-job/a.bin" }];
    putAnswers = [{ status: 400, body: { error: { code: "bad_request", message: "Content type mismatch" } } }];
    const recipe = [
      "import os",
      "def run(ctx):",
      "    p = os.path.join(ctx.work_dir, 'a.bin')",
      "    open(p, 'wb').write(b'abc')",
      "    ctx.upload(p, 'a.bin', 'adapter')",
      "    return {}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {}, { blobApiUrl: `${base}/blob` });
    assert.equal(r.code, 1);
    assert.equal(hits.filter((h) => h.path.endsWith("/upload")).length, 1);
    const failed = events().at(-1) as { type: string; error: string };
    assert.equal(failed.type, "failed");
    assert.match(failed.error, /Vercel Blob refused the upload \(HTTP 400, bad_request\)/);
  });

  it("pages the dataset with the job token, retries a 503 and refuses a redirect", async () => {
    datasetPages = {
      train: [
        { items: [{ n: 1 }, { n: 2 }], nextPage: 1 },
        { items: [{ n: 3 }], nextPage: null },
      ],
      eval: [{ items: [], nextPage: null }],
    };
    datasetFailures = [{ status: 503 }];
    const recipe = [
      "def run(ctx):",
      "    train = ctx.dataset('train')",
      "    evals = ctx.dataset('eval')",
      "    try:",
      "        ctx.get_json('/dataset?part=none&page=0')",
      "        missing = 'none'",
      "    except Exception as e:",
      "        missing = type(e).__name__ + ' ' + str(getattr(e, 'status', ''))",
      "    try:",
      "        ctx.dataset('test')",
      "        bad = 'none'",
      "    except ValueError:",
      "        bad = 'ValueError'",
      "    return {'train': ','.join(str(i['n']) for i in train), 'evals': len(evals), 'missing': missing, 'bad': bad}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {});
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assertAuthorized(r.token);
    assertTokenNotPrinted(r);
    const gets = hits.filter((h) => h.method === "GET");
    assert.deepEqual(
      gets.map((h) => `${h.query.get("part")}:${h.query.get("page")}`),
      ["train:0", "train:0", "train:1", "eval:0", "none:0"],
      "the 503 was retried, then each page asked for once",
    );
    assert.deepEqual((events().at(-1) as { metrics: unknown }).metrics, { train: "1,2,3", evals: 0, missing: "PlatformError 404", bad: "ValueError" });

    hits = [];
    datasetFailures = [{ status: 302, location: "/stolen" }];
    const again = await runJob("def run(ctx):\n    return {'n': len(ctx.dataset('train'))}\n", {});
    assert.equal(again.code, 1);
    assert.equal(hits.filter((h) => h.path === "/stolen").length, 0, "the redirect was not followed");
    assert.match(String((events().at(-1) as { error: string }).error), /HTTP 302 to GET \/dataset$/m);
  });

  it("posts eval items with each field cut to 3,500 characters, at most 60 a job", async () => {
    const recipe = [
      "def run(ctx):",
      "    ok = ctx.eval(0, 'p' * 5000, 'r', 'b' * 10, 't' * 3500)",
      "    sent = 1",
      "    for i in range(1, 70):",
      "        if ctx.eval(i, 'p', 'r', 'b', 't'):",
      "            sent += 1",
      "    big = ctx.eval(99, 'é' * 3500, 'é' * 3500, 'é' * 3500, 'é' * 3500)",
      "    return {'first': 'yes' if ok else 'no', 'sent': sent, 'big': 'yes' if big else 'no'}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {});
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    const evs = events().filter((e) => e.type === "eval") as Array<{ index: number; prompt: string; reference: string; base: string; tuned: string }>;
    assert.equal(evs.length, 60);
    assert.deepEqual(evs[0], { type: "eval", index: 0, prompt: "p".repeat(3500), reference: "r", base: "b".repeat(10), tuned: "t".repeat(3500) });
    assert.deepEqual(evs.map((e) => e.index), [...Array(60).keys()]);
    assert.deepEqual((events().at(-1) as { metrics: unknown }).metrics, { first: "yes", sent: 60, big: "no" });
    for (const h of hits.filter((x) => x.path.endsWith("/events"))) assert.ok(h.body.length <= 16 * 1024);
  });

  it("keeps eval bodies under the callback limit when the text is multibyte", async () => {
    const recipe = "def run(ctx):\n    return {'ok': 'yes' if ctx.eval(3, 'é' * 3500, '中' * 3500, 'b' * 3500, 't' * 3500) else 'no'}\n";
    const r = await runJob(recipe, {});
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    const hit = hits.find((h) => h.path.endsWith("/events") && JSON.parse(h.body.toString("utf8")).type === "eval");
    assert.ok(hit && hit.body.length <= 15000);
    const body = JSON.parse(hit.body.toString("utf8"));
    assert.equal(body.index, 3);
    for (const key of ["prompt", "reference", "base", "tuned"]) assert.ok(body[key].length <= 3500 && body[key].length > 0, key);
  });

  it("runs commands with extra env and hands each line to on_line, which can't break the run", async () => {
    const recipe = [
      "def run(ctx):",
      "    seen = []",
      "    def on_line(line):",
      "        if line == 'boom':",
      "            raise ValueError('bad line')",
      "        seen.append(line)",
      "    out = ctx.run('echo one; echo boom; echo \"two $MUSE_TEST_VALUE\"', env={'MUSE_TEST_VALUE': 'x1'}, on_line=on_line)",
      "    return {'seen': '|'.join(seen), 'exit': out.returncode}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {});
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assert.deepEqual((events().at(-1) as { metrics: unknown }).metrics, { seen: "one|two x1", exit: 0 });
    assert.match(r.output, /on_line failed: ValueError/);
  });

  it("sets ctx.cache_dir to the mounted cacheDir, and to None when it is missing or not mounted", async () => {
    const cache = await mkdtemp(path.join(tmpdir(), "muse-cache-"));
    try {
      const recipe = "def run(ctx):\n    return {'cache': str(ctx.cache_dir)}\n";
      const metrics = async (extra: Record<string, unknown>) => {
        hits = [];
        const r = await runJob(recipe, {}, extra);
        assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
        return (events().at(-1) as { metrics: { cache: string } }).metrics.cache;
      };
      assert.equal(await metrics({}), "None");
      assert.equal(await metrics({ cacheDir: cache }), cache);
      assert.equal(await metrics({ cacheDir: path.join(cache, "not-mounted"), cacheWaitSeconds: 1 }), "None");
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("runs the glimmer-lora recipe with dryRun: dataset pages, progress, eval items, then done", async () => {
    const train = Array.from({ length: 5 }, (_, i) => ({
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: `Question ${i}` },
        { role: "assistant", content: `Answer ${i}` },
      ],
    }));
    const evalItems = Array.from({ length: 3 }, (_, i) => ({ prompt: `Held-out prompt ${i}`, reference: `Reference ${i}` }));
    datasetPages = {
      train: [
        { items: train.slice(0, 3), nextPage: 1 },
        { items: [...train.slice(3), { messages: "not a list" }], nextPage: null },
      ],
      eval: [
        { items: evalItems.slice(0, 2), nextPage: 1 },
        { items: evalItems.slice(2), nextPage: null },
      ],
    };
    const cache = await mkdtemp(path.join(tmpdir(), "muse-cache-"));
    try {
      const params = { datasetId: "ds-1", maxSteps: 30, learningRate: 0.0002, loraRank: 8, dryRun: 1 };
      const r = await runJob(GLIMMER_PY, params, { recipe: "glimmer-lora", cacheDir: cache });
      assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
      assertAuthorized(r.token);
      assertTokenNotPrinted(r);

      const gets = hits.filter((h) => h.method === "GET").map((h) => `${h.query.get("part")}:${h.query.get("page")}`);
      assert.deepEqual(gets, ["train:0", "train:1", "eval:0", "eval:1"]);

      const evs = events();
      const types = evs.map((e) => e.type);
      assert.equal(types[0], "heartbeat");
      assert.equal(types.at(-1), "done");
      assert.ok(!types.includes("failed"));
      const steps = evs.filter((e) => e.type === "progress" && e.step !== undefined);
      assert.deepEqual(steps.map((e) => e.step), [10, 20, 30]);
      for (const e of steps) {
        assert.equal(e.totalSteps, 30);
        assert.equal(typeof e.loss, "number");
      }

      const evals = evs.filter((e) => e.type === "eval") as Array<{ index: number; prompt: string; reference: string; base: string; tuned: string }>;
      assert.deepEqual(evals.map((e) => [e.index, e.prompt, e.reference]), evalItems.map((e, i) => [i, e.prompt, e.reference]));
      for (const e of evals) {
        assert.match(e.base, new RegExp(`^Dry run base answer ${e.index} \\([0-9a-f]{8}\\)$`));
        assert.match(e.tuned, new RegExp(`^Dry run tuned answer ${e.index} \\([0-9a-f]{8}\\)$`));
        assert.notEqual(e.base, e.tuned);
      }
      assert.ok(types.lastIndexOf("eval") < types.indexOf("done"), "eval items go before done");
      assert.ok(types.indexOf("eval") > types.lastIndexOf("progress") - 1);

      const done = evs.at(-1) as { summary: string; metrics: Record<string, unknown> };
      assert.match(done.summary, /^Dry run: LoRA r=8 on Muse Glimmer 30B, 30 steps, final loss [\d.]+, 3 eval items\.$/);
      for (const key of ["train_loss_final", "steps", "train_seconds", "peak_vram_gb", "eval_items", "cached_weights"]) {
        assert.ok(key in done.metrics, `metrics has ${key}`);
      }
      assert.equal(done.metrics.steps, 30);
      assert.equal(done.metrics.eval_items, 3);
      assert.equal(done.metrics.train_examples, 5, "the malformed conversation was skipped");
      const logs = evs.filter((e) => e.type === "log").map((e) => (e as { text: string }).text);
      assert.ok(
        logs.some((t) => t.includes("5 training conversations, 3 eval prompts, answered under the dataset's system message")),
        "the eval prompts are answered under the system message training saw",
      );
      assert.equal(done.metrics.cached_weights, "no");
      assert.equal(done.metrics.dry_run, "yes");
      assert.equal(done.metrics.cache_used, "yes");
      assert.equal(done.metrics.adapter_uploaded, "no", "the fake platform has no storage");
      assert.equal(done.metrics.adapter_dir, path.join(cache, "models", JOB_ID));
      assert.equal(hits.filter((h) => h.path.endsWith("/upload")).length, 1, "the adapter archive was offered for upload");

      // The same answers on a second run: the fakes are deterministic.
      const first = evals.map((e) => [e.base, e.tuned]);
      hits = [];
      const again = await runJob(GLIMMER_PY, params, { recipe: "glimmer-lora", cacheDir: cache });
      assert.equal(again.code, 0);
      assert.deepEqual(events().filter((e) => e.type === "eval").map((e) => [e.base, e.tuned]), first);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("fails the glimmer-lora recipe clearly when the job has no dataset", async () => {
    const r = await runJob(GLIMMER_PY, { datasetId: "ds-1", dryRun: 1 }, { recipe: "glimmer-lora" });
    assert.equal(r.code, 1);
    const failed = events().at(-1) as { type: string; error: string };
    assert.equal(failed.type, "failed");
    assert.match(failed.error, /PlatformError: The platform answered HTTP 404 to GET \/dataset$/m);
    assert.ok(!events().some((e) => e.type === "eval"));
  });
});
