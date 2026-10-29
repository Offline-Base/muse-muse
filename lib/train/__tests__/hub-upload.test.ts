/**
 * Runs runner.py's ctx.hub_upload for real against a local HTTP server standing in for the platform's /hub route and
 * for the Hugging Face Hub's storage (presigned PUTs, multipart parts that answer ETags, the completion URL): the plan's
 * manifest with every file's sha256, the small files inline too, what stays behind (a link out of the folder included),
 * a skip and a refusal with the Hub's reason, a basic upload, a multipart one with each part read from disk on its own,
 * a 403 that gets one fresh plan (whose URLs the files not sent yet take too), retries on a 5xx and the give-up after
 * 3, a transfer cut off near the job's deadline, and every presigned URL kept out of the job's output and its callbacks. Then the glimmer-publish recipe end to end on a fake model cache. The Python
 * constants are checked against the platform's in lib/train/types.ts. Skipped when python3 is missing. Nothing here
 * reaches Lambda, the Hub or the network.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/hub-upload.test.ts
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { recipeById } from "@/lib/train/recipes";
import { GLIMMER_PY } from "@/lib/train/recipes/glimmer";
import { PUBLISH_PY } from "@/lib/train/recipes/publish";
import { RUNNER_PY } from "@/lib/train/recipes/runner";
import { glimmerHelpers } from "@/lib/train/recipes/serve";
import {
  HUB_CHECKED_NAMES,
  HUB_FILE_MAX_BYTES,
  HUB_FILE_NAMES,
  HUB_FILES_MAX,
  HUB_GGUF_FILE_MAX_BYTES,
  HUB_GGUF_SMALL_NAMES,
  HUB_SAMPLE_BYTES,
  HUB_SMALL_FILE_MAX_BYTES,
  HUB_SMALL_TOTAL_MAX_BYTES,
} from "@/lib/train/types";

const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const JOB_ID = "test-job";
const REPO = "muse-test/muse-glimmer-30b-briefs-lora-test-job";
const MODEL = "unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit";
const REVISION = /^MODEL_REVISION = "([0-9a-f]{40})"$/m.exec(GLIMMER_PY)![1]!;
const ADAPTER_JOB = "83d71f74-d84b-40bf-925a-cd36c90b6de5";

interface Hit {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface PlanFile {
  path: string;
  size: number;
  sha256: string;
  sample: string;
}

interface PlanBody {
  action: "plan";
  files: PlanFile[];
  small?: Record<string, string>;
  only?: string[];
}

type Upload = Record<string, unknown> & { path: string };

let server: Server;
let base = "";
let hits: Hit[] = [];
/** Every signature a presigned URL carried: none may ever show up in the job's output or a callback. */
let secrets: string[] = [];
/**
 * How the fake platform answers each plan in turn. Once they run out it does as the platform's route does when the
 * Hub's preupload marks every small file "regular": an upload, as `planMode` says, for every file not in small.
 */
let planAnswers: Array<(body: PlanBody) => { status: number; body: unknown }> = [];
/** The uploads each plan answered, in order. */
let planned: Upload[][] = [];
/** Files over multipartOver bytes go multipart in chunks of chunk; files in present are already on the Hub. */
let planMode: { multipartOver?: number; chunk?: number; present?: string[]; header?: Record<string, string> } = {};
/** Statuses the fake storage answers a path with in turn, before it takes the bytes. */
let storageFailures = new Map<string, number[]>();
/** What the fake storage took: a basic upload by "<oid>", a part by "<oid>/<n>", a completed multipart by "<oid>". */
let stored = new Map<string, Buffer>();
let doneStatus = 204;

const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A URL on the fake storage with a fresh signature in its query, as the Hub's presigned S3 URLs have. */
function signed(pathname: string, sig = randomBytes(24).toString("hex")): string {
  secrets.push(sig);
  return `${base}${pathname}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=900&X-Amz-Signature=${sig}`;
}

function uploadFor(f: PlanFile): Upload {
  const head = { path: f.path, oid: f.sha256, size: f.size };
  if (planMode.present?.includes(f.path)) return { ...head, transfer: "none" };
  if (planMode.multipartOver !== undefined && f.size > planMode.multipartOver) {
    const chunk = planMode.chunk!;
    const parts = Array.from({ length: Math.ceil(f.size / chunk) }, (_, i) => ({ partNumber: i + 1, url: signed(`/s3/${f.sha256}/${i + 1}`) }));
    return { ...head, transfer: "multipart", chunkSize: chunk, parts, completionUrl: signed(`/complete/${f.sha256}`) };
  }
  return { ...head, transfer: "basic", href: signed(`/s3/${f.sha256}`), header: planMode.header ?? {} };
}

function json(res: ServerResponse, status: number, body: unknown) {
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
      const job = `/api/train/jobs/${JOB_ID}`;
      if (hit.method === "POST" && hit.path === `${job}/events`) return void res.writeHead(204).end();
      if (hit.method === "POST" && hit.path === `${job}/hub`) {
        const body = JSON.parse(hit.body.toString("utf8")) as PlanBody | { action: "done" };
        if (body.action !== "plan") return void res.writeHead(doneStatus).end();
        const inline = body.small ?? {};
        const asked = body.files.filter((f) => !(f.path in inline) && (!body.only || body.only.includes(f.path)));
        const answer = planAnswers.shift()?.(body) ?? { status: 200, body: { repo: REPO, uploads: asked.map(uploadFor) } };
        const uploads = (answer.body as { uploads?: Upload[] } | null)?.uploads;
        if (Array.isArray(uploads)) planned.push(uploads);
        return json(res, answer.status, answer.body);
      }
      const failure = storageFailures.get(hit.path)?.shift();
      if (failure !== undefined) return json(res, failure, { error: "refused" });
      if (hit.method === "PUT" && hit.path.startsWith("/s3/")) {
        stored.set(hit.path.slice("/s3/".length), hit.body);
        return void res.writeHead(200, { etag: `"${md5(hit.body)}"` }).end();
      }
      if (hit.method === "POST" && hit.path.startsWith("/complete/")) {
        const oid = hit.path.slice("/complete/".length);
        const done = JSON.parse(hit.body.toString("utf8")) as { oid: string; parts: Array<{ partNumber: number; etag: string }> };
        const parts = done.parts.map((p) => stored.get(`${oid}/${p.partNumber}`));
        const ok = done.oid === oid && parts.every((b, i) => b && done.parts[i]!.etag === `"${md5(b)}"`);
        if (!ok) return json(res, 400, { error: "the parts don't match" });
        stored.set(oid, Buffer.concat(parts as Buffer[]));
        return json(res, 200, { success: true });
      }
      json(res, 404, { error: "not_found" });
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
  secrets = [];
  planAnswers = [];
  planned = [];
  planMode = {};
  storageFailures = new Map();
  stored = new Map();
  doneStatus = 204;
});

interface RunResult {
  code: number | null;
  output: string;
  token: string;
}

/**
 * Writes job.json, runner.py, recipe.py and `files` (paths relative to the job's folder, folders made as needed) to a
 * temp dir and runs the runner, like cloud-init does, with the Hub's retry wait cut to 10 ms.
 */
async function runJob(recipe: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}, files: Record<string, string | Buffer> = {}): Promise<RunResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "muse-hub-"));
  const token = `tok_${randomBytes(32).toString("base64url")}`;
  try {
    const job = {
      jobId: JOB_ID,
      callbackBase: `${base}/api/train/jobs/${JOB_ID}`,
      token,
      params,
      maxMinutes: 5,
      recipe: "glimmer-lora",
      heartbeatSeconds: 1,
      hubRetrySeconds: 0.01,
      ...extra,
    };
    await writeFile(path.join(dir, "job.json"), JSON.stringify(job));
    await writeFile(path.join(dir, "runner.py"), RUNNER_PY);
    await writeFile(path.join(dir, "recipe.py"), recipe);
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), content);
    }
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

/**
 * A recipe that uploads the job folder's adapter/ and prints what hub_upload returned. params.links makes links in
 * adapter/ first ({name: target, relative to the job's folder}).
 */
const UPLOAD_RECIPE = String.raw`import json, os
HERE = os.path.dirname(os.path.abspath(__file__))


def run(ctx):
    for name, target in (ctx.params.get("links") or {}).items():
        os.symlink(os.path.join(HERE, target), os.path.join(HERE, "adapter", name))
    out = ctx.hub_upload(os.path.join(HERE, "adapter"), for_job=ctx.params.get("forJob"))
    print("HUB_RESULT " + json.dumps(out, sort_keys=True), flush=True)
    return {"uploaded": out["uploaded"]}
`;

interface HubResult {
  uploaded: number;
  skipped: string | null;
  failed: Array<{ path: string; error: string }>;
  repo: string | null;
  files: number;
  bytes: number;
}

/** What hub_upload returned, without its "sha256" map of the files' digests (digestsOf has it). */
function resultOf(r: RunResult): HubResult {
  const { sha256: _digests, ...rest } = digestsOf(r);
  return rest;
}

function digestsOf(r: RunResult): HubResult & { sha256: Record<string, string> } {
  const line = r.output.split("\n").find((l) => l.startsWith("HUB_RESULT "));
  assert.ok(line, r.output.replaceAll(r.token, "[token]"));
  return JSON.parse(line.slice("HUB_RESULT ".length)) as HubResult & { sha256: Record<string, string> };
}

const events = () => hits.filter((h) => h.path.endsWith("/events")).map((h) => JSON.parse(h.body.toString("utf8")) as Record<string, unknown>);
const hubCalls = () => hits.filter((h) => h.path.endsWith("/hub")).map((h) => JSON.parse(h.body.toString("utf8")) as Record<string, unknown>);
const plans = () => hubCalls().filter((b) => b.action === "plan") as unknown as PlanBody[];
const dones = () => hubCalls().filter((b) => b.action === "done");
const storageHits = () => hits.filter((h) => h.path.startsWith("/s3/") || h.path.startsWith("/complete/"));

/** The job token went only to the platform, and nothing that reached the storage carried a credential. */
function assertCredentials(r: RunResult) {
  for (const h of hits.filter((x) => x.path.startsWith("/api/"))) assert.equal(h.headers.authorization, `Bearer ${r.token}`, h.path);
  for (const h of storageHits()) {
    assert.equal(h.headers.authorization, undefined, `${h.method} ${h.path} carries no credential`);
    assert.ok(!JSON.stringify(h.headers).includes(r.token) && !h.body.includes(r.token), "the job token never reaches the storage");
  }
  assert.ok(!r.output.includes(r.token), "the token never shows in stdout or stderr");
}

/** No signature of a presigned URL shows up in the job's output, a callback or a report to the platform. */
function assertNoSecrets(r: RunResult) {
  assert.ok(secrets.length > 0, "the plan had presigned URLs");
  const told = hits.filter((h) => h.path.startsWith("/api/")).map((h) => h.body.toString("utf8")).join("\n");
  for (const secret of secrets) {
    assert.ok(!r.output.includes(secret), "a presigned URL's signature is in the job's output");
    assert.ok(!told.includes(secret), "a presigned URL's signature reached the platform");
  }
}

describe("hub constants", () => {
  it("match the platform's in lib/train/types.ts", () => {
    const py = (name: string) => new RegExp(`^${name} = (.+)$`, "m").exec(RUNNER_PY)?.[1];
    assert.equal(py("HUB_SAMPLE_BYTES"), String(HUB_SAMPLE_BYTES));
    assert.equal(py("HUB_SMALL_BYTES"), "1024 * 1024");
    assert.equal(1024 * 1024, HUB_SMALL_FILE_MAX_BYTES);
    assert.equal(py("HUB_SMALL_TOTAL_BYTES"), "3 * 1024 * 1024");
    assert.equal(3 * 1024 * 1024, HUB_SMALL_TOTAL_MAX_BYTES);
    assert.equal(py("HUB_FILES_MAX"), String(HUB_FILES_MAX));
    assert.equal(py("HUB_FILE_MAX_BYTES"), "10 * 1024 ** 3");
    assert.equal(10 * 1024 ** 3, HUB_FILE_MAX_BYTES);
    const tuple = (name: string) => [...(new RegExp(`^${name} = \\(\\n([\\s\\S]*?)\\n\\)$`, "m").exec(RUNNER_PY)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(tuple("HUB_NAMES"), [...HUB_FILE_NAMES], "the same names, exactly");
    assert.deepEqual(tuple("HUB_CHECKED"), [...HUB_CHECKED_NAMES]);
    assert.ok(HUB_CHECKED_NAMES.every((n) => HUB_FILE_NAMES.includes(n)));
    // A glimmer-quantize job's GGUF folder: its small files, its builds' cap, and builds never inline.
    assert.deepEqual(tuple("HUB_GGUF_SMALL"), [...HUB_GGUF_SMALL_NAMES]);
    assert.equal(py("HUB_GGUF_FILE_MAX_BYTES"), "32 * 1024 ** 3");
    assert.equal(32 * 1024 ** 3, HUB_GGUF_FILE_MAX_BYTES);
    assert.equal(py("HUB_GGUF_RECIPE"), '"glimmer-quantize"');
    assert.match(py("HUB_LFS_SUFFIXES") ?? "", /"\.gguf"/);
  });

  it("registers glimmer-publish on glimmer-lora's helpers, and glimmer-lora's publish and why params", () => {
    const publish = recipeById("glimmer-publish");
    assert.ok(publish);
    assert.equal(publish.script, PUBLISH_PY);
    assert.ok(PUBLISH_PY.includes(glimmerHelpers(GLIMMER_PY)), "every glimmer helper, unchanged");
    assert.ok(PUBLISH_PY.startsWith('"""Muse Glimmer publish:'));
    assert.ok(!PUBLISH_PY.includes('if __name__ == "__main__":'), "nothing runs it but the runner");
    assert.ok(!PUBLISH_PY.includes("${") && !PUBLISH_PY.includes("`") && !PUBLISH_PY.includes("\u2014"));
    assert.equal(publish.usesCache, true, "it mounts the cache that holds the adapter");
    assert.equal(publish.defaultMaxMinutes, 20);
    assert.ok(publish.defaultMaxUsd > 0 && publish.defaultMaxUsd <= 1, `${publish.defaultMaxUsd}`);
    assert.deepEqual(
      publish.params.map((f) => [f.key, f.kind, f.required ?? false]),
      [["adapterJobId", "adapter", true]],
    );
    const glimmerGpus = new Set(recipeById("glimmer-lora")!.gpus.map((g) => g.instanceType));
    assert.equal(publish.gpus[0]?.instanceType, "gpu_1x_rtx6000", "the cheapest first");
    assert.ok(!publish.gpus.some((g) => g.instanceType.includes("h100")), "no H100: it never uses the GPU");
    assert.ok(publish.gpus.some((g) => glimmerGpus.has(g.instanceType)), "one glimmer-lora trains on too, so any adapter's region may have it");
    // $1 never stops a 20-minute job before its time limit on the priciest of them ($1.99 an hour).
    assert.ok((publish.defaultMaxUsd * 100 * 60) / 199 > publish.defaultMaxMinutes);

    const lora = recipeById("glimmer-lora")!;
    const field = (key: string) => lora.params.find((f) => f.key === key);
    assert.deepEqual([field("publish")?.kind, field("publish")?.default, field("publish")?.min, field("publish")?.max], ["number", 1, 0, 1]);
    assert.deepEqual([field("why")?.kind, field("why")?.default, field("why")?.required], ["text", undefined, undefined]);
  });
});

describe("ctx.hub_upload against a fake platform and storage", { skip: hasPython ? false : "python3 is missing", timeout: 240_000 }, () => {
  it("plans every file with its sha256, size and first 512 bytes, sends the small ones inline too, and leaves the rest behind", async () => {
    const weights = randomBytes(300_000);
    const tokenizer = Buffer.from(`{"vocab": "${"x".repeat(1_200_000)}"}`);
    const spm = randomBytes(40);
    const config = Buffer.from(JSON.stringify({ r: 16, revision: REVISION }));
    const small = {
      "adapter_config.json": config,
      "chat_template.jinja": Buffer.from("{{ bos_token }}{% for m in messages %}{{ m.content }}{% endfor %}"),
      "tokenizer_config.json": Buffer.from('{"model_max_length": 2048}'),
    };
    const left = {
      "adapter/README.md": "# PEFT's own card",
      "adapter/optimizer.pt": "pickle",
      "adapter/scheduler.pt": "pickle",
      "adapter/rng_state_0.pth": "pickle",
      "adapter/training_args.bin": "pickle",
      "adapter/adapter_model.bin": "a pickled adapter",
      "adapter/checkpoint-10/adapter_model.safetensors": "an old checkpoint",
      "adapter/.hidden.json": "{}",
      "adapter/muse_muse_run.json": "{}",
      "adapter/notes.md": "notes",
      "adapter/LICENSE": "a license",
      "adapter/config.json": '{"auto_map": {"AutoModel": "someone--code.X"}}',
      "adapter/model.safetensors": "a full model's weights",
      "adapter/requirements.txt": "something==1.0",
      "adapter/Muse_Muse_Run.json": "{}",
    };
    planMode = { present: ["adapter_model.safetensors", "tokenizer.json", "tokenizer.model"] };
    const r = await runJob(
      UPLOAD_RECIPE,
      // A link to a file outside the folder (here the job's own job.json, with its token) is never followed.
      { forJob: ADAPTER_JOB, links: { "job.json": "job.json" } },
      {},
      {
        "adapter/adapter_model.safetensors": weights,
        "adapter/tokenizer.json": tokenizer,
        "adapter/tokenizer.model": spm,
        ...Object.fromEntries(Object.entries(small).map(([k, v]) => [`adapter/${k}`, v])),
        ...left,
      },
    );
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assertCredentials(r);

    assert.equal(plans().length, 1);
    const plan = plans()[0]!;
    assert.deepEqual(Object.keys(plan).sort(), ["action", "files", "small"]);
    const entry = (name: string, b: Buffer) => ({ path: name, size: b.length, sha256: sha256(b), sample: b.subarray(0, 512).toString("base64") });
    const large = [entry("adapter_model.safetensors", weights), entry("tokenizer.json", tokenizer), entry("tokenizer.model", spm)];
    const all = [...large, ...Object.entries(small).map(([k, v]) => entry(k, v))].sort((a, b) => (a.path < b.path ? -1 : 1));
    assert.deepEqual(plan.files, all, "every file, sorted by name, as the platform's route checks small files against them");
    assert.deepEqual(plan.small, Object.fromEntries(Object.entries(small).map(([k, v]) => [k, v.toString("base64")])), "and the small ones whole");
    assert.ok(!("job.json" in (plan.small ?? {})) && !plan.files.some((f) => f.path === "job.json"), "the link to job.json was never followed");

    // Every large file was already on the Hub: nothing went to the storage, and the report says the Hub has all three.
    assert.equal(storageHits().length, 0);
    assert.deepEqual(dones(), [
      {
        action: "done",
        uploaded: large.map((f) => ({ path: f.path, oid: f.sha256, size: f.size })),
        failed: [],
      },
    ]);
    const total = weights.length + tokenizer.length + spm.length + Object.values(small).reduce((s, b) => s + b.length, 0);
    assert.deepEqual(resultOf(r), { uploaded: 3, skipped: null, failed: [], repo: REPO, files: 6, bytes: total });
    assert.deepEqual(digestsOf(r).sha256, Object.fromEntries(all.map((f) => [f.path, f.sha256])), "and each file's digest, for the recipe");
    assert.match(r.output, new RegExp(`Hub upload for job ${ADAPTER_JOB}: 6 files`), "the job it uploads for, in the log");
  });

  it("sends small files inline up to 1 MB each and 3 MB in all, the configs the platform checks first, then smallest first", async () => {
    const files: Record<string, Buffer> = {
      "adapter/tokenizer_config.json": Buffer.alloc(900_000, "a"),
      "adapter/special_tokens_map.json": Buffer.alloc(900_001, "b"),
      "adapter/preprocessor_config.json": Buffer.alloc(900_002, "c"),
      "adapter/added_tokens.json": Buffer.alloc(1024 * 1024 + 1, "e"),
      "adapter/vocab.json": Buffer.alloc(500_000, "v"),
      "adapter/chat_template.jinja": Buffer.from("{}"),
    };
    planMode = { present: ["added_tokens.json", "vocab.json"] };
    const r = await runJob(UPLOAD_RECIPE, {}, {}, files);
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    const plan = plans()[0]!;
    assert.deepEqual(Object.keys(plan.small ?? {}).sort(), ["chat_template.jinja", "preprocessor_config.json", "special_tokens_map.json", "tokenizer_config.json"]);
    assert.deepEqual(plan.files.map((f) => f.path), [
      "added_tokens.json",
      "chat_template.jinja",
      "preprocessor_config.json",
      "special_tokens_map.json",
      "tokenizer_config.json",
      "vocab.json",
    ]);
    assert.deepEqual(planned[0]!.map((u) => u.path), ["added_tokens.json", "vocab.json"], "over 1 MB, and past the 3 MB once the checked configs are in, so uploaded instead");
    assert.equal(resultOf(r).uploaded, 2);
  });

  it("returns the platform's skip reason, or its refusal, and uploads nothing", async () => {
    planAnswers = [() => ({ status: 200, body: { skip: "HF_TOKEN isn't set" } })];
    const files = { "adapter/adapter_model.safetensors": randomBytes(1000), "adapter/adapter_config.json": "{}" };
    let r = await runJob(UPLOAD_RECIPE, {}, {}, files);
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assert.deepEqual(resultOf(r), { uploaded: 0, skipped: "HF_TOKEN isn't set", failed: [], repo: null, files: 2, bytes: 1002 });
    assert.equal(storageHits().length + dones().length, 0, "no upload and no report");

    hits = [];
    planAnswers = [() => ({ status: 400, body: { error: "files: tokenizer.bin isn't a name the Hub takes." } })];
    r = await runJob(UPLOAD_RECIPE, {}, {}, files);
    assert.equal(r.code, 0);
    assert.equal(resultOf(r).skipped, "the platform answered HTTP 400 to the upload plan: files: tokenizer.bin isn't a name the Hub takes.");
    assert.equal(hubCalls().length, 1, "a 400 isn't asked again");

    // A refusal of the Hub's, which the platform saved on the job, is logged with its reason and not asked again.
    hits = [];
    const refusal = "Hugging Face: creating the repo failed (POST /api/repos/create): HTTP 403, You don't have the rights. Check that HF_TOKEN can write repos under HF_NAMESPACE.";
    planAnswers = [() => ({ status: 409, body: { error: "hub_refused", message: refusal } })];
    r = await runJob(UPLOAD_RECIPE, {}, {}, files);
    assert.equal(resultOf(r).skipped, `the platform answered HTTP 409 to the upload plan: hub_refused: ${refusal}`);
    assert.equal(hubCalls().length, 1);

    hits = [];
    r = await runJob(UPLOAD_RECIPE, {}, {}, { "adapter/README.md": "# card", "adapter/optimizer.pt": "x" });
    assert.equal(resultOf(r).skipped, "the folder has no files to publish");
    assert.equal(hubCalls().length, 0);

    // Only HUB_FILE_NAMES go, so a folder of other shards has nothing to publish (never more than the HUB_FILES_MAX a plan takes).
    const many = Object.fromEntries(Array.from({ length: HUB_FILES_MAX + 1 }, (_, i) => [`adapter/shard-${i}.safetensors`, "x"]));
    r = await runJob(UPLOAD_RECIPE, {}, {}, many);
    assert.equal(resultOf(r).skipped, "the folder has no files to publish");
    assert.equal(hubCalls().length, 0);
  });

  it("uploads a basic file as one streaming PUT with no credential and no Content-Type, then reports it", async () => {
    const weights = randomBytes(200_000);
    planMode = { header: { "x-amz-meta-origin": "muse", "Content-Length": "1" } };
    const r = await runJob(UPLOAD_RECIPE, {}, {}, { "adapter/adapter_model.safetensors": weights, "adapter/adapter_config.json": "{}" });
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assertCredentials(r);
    assertNoSecrets(r);
    const puts = storageHits();
    assert.equal(puts.length, 1);
    const put = puts[0]!;
    assert.equal(put.method, "PUT");
    assert.equal(put.path, `/s3/${sha256(weights)}`);
    assert.equal(put.query.get("X-Amz-Signature"), secrets[0], "the URL exactly as the plan gave it");
    assert.deepEqual(put.body, weights);
    assert.equal(put.headers["content-length"], String(weights.length), "the plan's header can't change the length");
    assert.equal(put.headers["content-type"], undefined, "nothing the storage didn't sign");
    assert.equal(put.headers["x-amz-meta-origin"], "muse", "the plan's own header goes along");
    assert.equal(put.headers["transfer-encoding"], undefined);
    assert.deepEqual(dones(), [{ action: "done", uploaded: [{ path: "adapter_model.safetensors", oid: sha256(weights), size: weights.length }], failed: [] }]);
    assert.deepEqual(resultOf(r), { uploaded: 1, skipped: null, failed: [], repo: REPO, files: 2, bytes: weights.length + 2 });
  });

  it("uploads a file bigger than the chunk size part by part, each range read from disk on its own, then completes it with the ETags", async () => {
    const chunk = 256 * 1024;
    const weights = randomBytes(chunk * 2 + chunk / 2);
    planMode = { multipartOver: 100_000, chunk };
    const recipe = String.raw`import json, os
import __main__ as runner

HERE = os.path.dirname(os.path.abspath(__file__))
READS = []
FileRange = runner.FileRange


class Watched(FileRange):
    """The runner's FileRange, noting where each part starts and how much each read got."""

    def __init__(self, path, offset, length):
        FileRange.__init__(self, path, offset, length)
        self.seen = {"offset": offset, "length": length, "reads": []}
        READS.append(self.seen)

    def read(self, size=-1):
        data = FileRange.read(self, size)
        self.seen["reads"].append(len(data))
        return data


def run(ctx):
    runner.FileRange = Watched
    runner.HUB_BLOCK_BYTES = 64 * 1024
    out = ctx.hub_upload(os.path.join(HERE, "adapter"))
    print("HUB_RESULT " + json.dumps(out, sort_keys=True), flush=True)
    print("READS " + json.dumps(READS), flush=True)
    return {}
`;
    const r = await runJob(recipe, {}, {}, { "adapter/adapter_model.safetensors": weights, "adapter/adapter_config.json": "{}" });
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assertCredentials(r);
    assertNoSecrets(r);
    const oid = sha256(weights);

    const parts = storageHits().filter((h) => h.method === "PUT");
    assert.deepEqual(parts.map((h) => h.path), [1, 2, 3].map((n) => `/s3/${oid}/${n}`));
    parts.forEach((h, i) => {
      assert.deepEqual(h.body, weights.subarray(i * chunk, (i + 1) * chunk), `part ${i + 1} is its own range`);
      assert.equal(h.headers["content-length"], String(h.body.length));
      assert.equal(h.headers["content-type"], undefined);
    });
    // Each part was read from its own offset, 64 KB at a time, never the file or a whole part at once.
    const reads = JSON.parse(r.output.split("\n").find((l) => l.startsWith("READS "))!.slice("READS ".length)) as Array<{ offset: number; length: number; reads: number[] }>;
    assert.deepEqual(reads.map((x) => [x.offset, x.length]), [[0, chunk], [chunk, chunk], [chunk * 2, chunk / 2]]);
    for (const x of reads) {
      assert.ok(Math.max(...x.reads) <= 64 * 1024, `${x.reads}`);
      assert.equal(x.reads.reduce((s, n) => s + n, 0), x.length);
    }

    const completion = storageHits().find((h) => h.path.startsWith("/complete/"))!;
    assert.equal(completion.method, "POST");
    assert.equal(completion.headers["content-type"], "application/vnd.git-lfs+json");
    assert.equal(completion.headers.accept, "application/vnd.git-lfs+json");
    assert.deepEqual(JSON.parse(completion.body.toString("utf8")), {
      oid,
      parts: parts.map((h, i) => ({ partNumber: i + 1, etag: `"${md5(h.body)}"` })),
    });
    assert.deepEqual(stored.get(oid), weights, "the storage put the parts back together into the file");
    assert.deepEqual(dones()[0]?.uploaded, [{ path: "adapter_model.safetensors", oid, size: weights.length }]);
    assert.equal(resultOf(r).uploaded, 1);
  });

  it("asks for a fresh plan for a file once when its URL answers 403, and fails it when the fresh one is refused too", async () => {
    const weights = randomBytes(50_000);
    const oid = sha256(weights);
    const files = { "adapter/adapter_model.safetensors": weights, "adapter/adapter_config.json": '{"r": 16}' };
    storageFailures.set(`/s3/${oid}`, [403]);
    let r = await runJob(UPLOAD_RECIPE, {}, {}, files);
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assertNoSecrets(r);
    assert.equal(plans().length, 2);
    const [first, again] = plans();
    assert.deepEqual(first!.files.map((f) => f.path), ["adapter_config.json", "adapter_model.safetensors"]);
    assert.deepEqual(again, first, "the whole plan again, which the platform's route takes in place of the first");
    const puts = storageHits();
    assert.equal(puts.length, 2);
    assert.notEqual(puts[0]!.query.get("X-Amz-Signature"), puts[1]!.query.get("X-Amz-Signature"), "the second PUT used the fresh URL");
    assert.deepEqual(stored.get(oid), weights);
    assert.deepEqual(resultOf(r), { uploaded: 1, skipped: null, failed: [], repo: REPO, files: 2, bytes: weights.length + 9 });

    // A multipart file whose second part's URL expired starts over on the fresh plan's URLs.
    hits = [];
    stored = new Map();
    const big = randomBytes(300_000);
    const bigOid = sha256(big);
    planMode = { multipartOver: 100_000, chunk: 128 * 1024 };
    storageFailures.set(`/s3/${bigOid}/2`, [403]);
    r = await runJob(UPLOAD_RECIPE, {}, {}, { "adapter/adapter_model.safetensors": big });
    assert.equal(r.code, 0);
    assert.equal(plans().length, 2);
    assert.deepEqual(storageHits().map((h) => h.path.replace(bigOid, "oid")), ["/s3/oid/1", "/s3/oid/2", "/s3/oid/1", "/s3/oid/2", "/s3/oid/3", "/complete/oid"]);
    assert.deepEqual(stored.get(bigOid), big);
    assert.equal(resultOf(r).uploaded, 1);

    // With two files, the one not sent yet when the first one's URL expired goes up on the fresh plan's URL too.
    hits = [];
    planned = [];
    planMode = {};
    const second = randomBytes(30_000);
    storageFailures.set(`/s3/${oid}`, [403]);
    r = await runJob(UPLOAD_RECIPE, {}, {}, { "adapter/adapter_model.safetensors": weights, "adapter/tokenizer.model": second });
    assert.equal(r.code, 0);
    assert.equal(planned.length, 2);
    const puts2 = storageHits().filter((h) => h.path === `/s3/${sha256(second)}`);
    const freshUrl = new URL(String(planned[1]!.find((u) => u.path === "tokenizer.model")!.href));
    assert.equal(puts2.length, 1);
    assert.equal(puts2[0]!.query.get("X-Amz-Signature"), freshUrl.searchParams.get("X-Amz-Signature"), "the fresh plan's URL, not the first one's");
    assert.equal(resultOf(r).uploaded, 2);

    // Refused again on the fresh URL: one fresh plan only, then the file fails and the report says why.
    hits = [];
    planMode = {};
    storageFailures.set(`/s3/${oid}`, [403, 403, 403]);
    r = await runJob(UPLOAD_RECIPE, {}, {}, files);
    assert.equal(r.code, 0);
    assert.equal(plans().length, 2, "no third plan");
    const failed = [{ path: "adapter_model.safetensors", error: "the Hub's storage refused its upload URLs again after a fresh plan (HTTP 403)" }];
    assert.deepEqual(resultOf(r), { uploaded: 0, skipped: null, failed, repo: REPO, files: 2, bytes: weights.length + 9 });
    assert.deepEqual(dones(), [{ action: "done", uploaded: [], failed }]);
  });

  it("retries a 5xx from the storage, and gives up on a request after 3 tries", async () => {
    const weights = randomBytes(40_000);
    const oid = sha256(weights);
    const files = { "adapter/adapter_model.safetensors": weights };
    storageFailures.set(`/s3/${oid}`, [500]);
    let r = await runJob(UPLOAD_RECIPE, {}, {}, files);
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assert.equal(storageHits().length, 2);
    assert.deepEqual(stored.get(oid), weights, "the second try took it");
    assert.equal(plans().length, 1, "a 5xx is retried, not planned again");
    assert.match(r.output, /retrying adapter_model\.safetensors after HTTP 500 in 0\.01 s/);
    assert.equal(resultOf(r).uploaded, 1);

    hits = [];
    stored = new Map();
    storageFailures.set(`/s3/${oid}`, [500, 503, 502]);
    r = await runJob(UPLOAD_RECIPE, {}, {}, files);
    assert.equal(r.code, 0);
    assert.equal(storageHits().length, 3, "3 tries, no more");
    assert.equal(stored.size, 0);
    const failed = [{ path: "adapter_model.safetensors", error: "adapter_model.safetensors failed 3 times, the last with HTTP 502" }];
    assert.deepEqual(resultOf(r).failed, failed);
    assert.deepEqual(dones(), [{ action: "done", uploaded: [], failed }]);

    // A part whose storage never answers fails the file after 3 tries, and the completion is never sent.
    hits = [];
    const big = randomBytes(200_000);
    const bigOid = sha256(big);
    planMode = { multipartOver: 100_000, chunk: 128 * 1024 };
    storageFailures.set(`/s3/${bigOid}/2`, [500, 500, 500]);
    r = await runJob(UPLOAD_RECIPE, {}, {}, { "adapter/adapter_model.safetensors": big });
    assert.deepEqual(storageHits().map((h) => h.path.replace(bigOid, "oid")), ["/s3/oid/1", "/s3/oid/2", "/s3/oid/2", "/s3/oid/2"]);
    assert.deepEqual(resultOf(r).failed, [{ path: "adapter_model.safetensors", error: "part 2 of adapter_model.safetensors failed 3 times, the last with HTTP 500" }]);

    // The report the platform refuses is the reason nothing was published.
    hits = [];
    planMode = {};
    doneStatus = 409;
    r = await runJob(UPLOAD_RECIPE, {}, {}, files);
    assert.equal(resultOf(r).skipped, "the platform answered HTTP 409 to the upload report");
    assert.equal(resultOf(r).uploaded, 1);
  });

  it("cuts off a transfer still sending near the job's deadline, so the job reports back before its time limit", async () => {
    const weights = randomBytes(200_000);
    // As though the deadline were already within a minute: the first block of the PUT is never sent.
    const recipe = String.raw`import json, os
import __main__ as runner

HERE = os.path.dirname(os.path.abspath(__file__))


def run(ctx):
    runner.HUB_ABORT_SECONDS = 10 ** 6
    out = ctx.hub_upload(os.path.join(HERE, "adapter"))
    print("HUB_RESULT " + json.dumps(out, sort_keys=True), flush=True)
    return {}
`;
    const r = await runJob(recipe, {}, { deadlineEpoch: Math.floor(Date.now() / 1000) + 3600 }, {
      "adapter/adapter_model.safetensors": weights,
      "adapter/adapter_config.json": "{}",
    });
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    const failed = resultOf(r).failed;
    assert.equal(failed.length, 1);
    assert.match(failed[0]!.error, /^adapter_model\.safetensors failed 3 times, the last with a network error \(TimeoutError: cut off, the job's time limit is near\)$/);
    assert.equal(stored.size, 0, "nothing reached the storage whole");
    assert.deepEqual(dones()[0]?.failed, failed, "and the report says so");
  });

  it("keeps every presigned URL out of the log, the callbacks and the report, even when a recipe echoes one or an error quotes it", async () => {
    const weights = randomBytes(30_000);
    const spm = randomBytes(20_000);
    const vocab = Buffer.from(`{"v": "${"y".repeat(1_100_000)}"}`);
    // Known before the run, so the recipe can echo them: one that works, one the runner can't send (a space in its
    // query, so the error quotes it), and one on a port nobody listens on.
    const good = signed(`/s3/${sha256(weights)}`);
    const spaced = signed(`/s3/${sha256(spm)}`, `spaced ${randomBytes(16).toString("hex")}`);
    const refused = `http://127.0.0.1:9/s3/${sha256(vocab)}?X-Amz-Signature=${randomBytes(20).toString("hex")}`;
    secrets.push(refused.split("=").at(-1)!);
    const urls: Record<string, string> = { "adapter_model.safetensors": good, "tokenizer.model": spaced, "tokenizer.json": refused };
    planAnswers = [
      (body) => ({
        status: 200,
        body: { repo: REPO, uploads: body.files.map((f) => ({ path: f.path, oid: f.sha256, size: f.size, transfer: "basic", href: urls[f.path], header: {} })) },
      }),
    ];
    const recipe = String.raw`import json, os
HERE = os.path.dirname(os.path.abspath(__file__))


def run(ctx):
    out = ctx.hub_upload(os.path.join(HERE, "adapter"))
    # A recipe that has a URL some other way still can't show it: the runner hid each one when the plan came.
    for url in ctx.params["urls"]:
        ctx.log("echoed " + url)
        ctx.run("echo " + json.dumps(url))
        ctx.progress(message="progress " + url)
    print("HUB_RESULT " + json.dumps(out, sort_keys=True), flush=True)
    return {"url": ctx.params["urls"][0], "failed": out["failed"]}
`;
    const r = await runJob(recipe, { urls: Object.values(urls) }, {}, {
      "adapter/adapter_model.safetensors": weights,
      "adapter/tokenizer.model": spm,
      "adapter/tokenizer.json": vocab,
    });
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assertNoSecrets(r);
    for (const url of Object.values(urls)) assert.ok(!r.output.includes(url.split("?")[1]!), "not even a query");

    const failed = resultOf(r).failed;
    assert.deepEqual(failed.map((f) => f.path), ["tokenizer.json", "tokenizer.model"]);
    assert.match(failed[0]!.error, /^tokenizer\.json failed 3 times, the last with a network error \(ConnectionRefusedError/);
    assert.match(failed[1]!.error, /^tokenizer\.model failed 3 times, the last with a network error \(InvalidURL: .*\[presigned URL\]/);
    assert.match(r.output, /retrying tokenizer\.model after a network error \(InvalidURL: .*\[presigned URL\]/);
    assert.deepEqual(stored.get(sha256(weights)), weights, "the good URL still worked");

    const evs = events();
    const logs = evs.filter((e) => e.type === "log").map((e) => String(e.text));
    assert.equal(logs.filter((t) => t === "echoed [presigned URL]").length, 3);
    assert.equal(logs.filter((t) => t.includes('$ echo "[presigned URL]"\n[presigned URL]')).length, 3, "the command and its output");
    assert.equal(evs.filter((e) => e.type === "progress" && e.message === "progress [presigned URL]").length, 3);
    const done = evs.at(-1) as { type: string; metrics: Record<string, unknown> };
    assert.equal(done.type, "done");
    assert.equal(done.metrics.url, "[presigned URL]");
    assert.deepEqual(dones()[0]?.failed, failed, "the report has the same redacted errors");
  });
});

/** A model cache holding one adapter at models/<ADAPTER_JOB>/, as glimmer-lora left it. Returns the cache's path. */
async function cacheWith(files: Record<string, string | Buffer>): Promise<string> {
  const cache = await mkdtemp(path.join(tmpdir(), "muse-hub-cache-"));
  const dir = path.join(cache, "models", ADAPTER_JOB);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content);
  return cache;
}

/** An adapter_config.json as PEFT's save_pretrained writes it, before glimmer-lora filled in the revision. */
function peftConfig(over: Record<string, unknown> = {}): string {
  const config: Record<string, unknown> = {
    alpha_pattern: {},
    base_model_name_or_path: MODEL,
    lora_alpha: 16,
    peft_type: "LORA",
    r: 16,
    rank_pattern: { "model.layers.1": 8, "model.layers.0": 4 },
    revision: null,
    target_modules: ["q_proj", "v_proj"],
    ...over,
  };
  return JSON.stringify(Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b))), null, 2);
}

describe("ctx.hub_upload of a glimmer-quantize job's GGUF folder", { skip: hasPython ? false : "python3 is missing", timeout: 240_000 }, () => {
  const gguf = (level: string) => `adapter/muse-glimmer-30b-brief-writer-${level}.gguf`;
  const folder = (): Record<string, string | Buffer> => ({
    [gguf("Q3_K_M")]: Buffer.concat([Buffer.from("GGUF"), randomBytes(60_000)]),
    [gguf("Q4_K_M")]: Buffer.concat([Buffer.from("GGUF"), randomBytes(70_000)]),
    [gguf("Q6_K")]: Buffer.concat([Buffer.from("GGUF"), randomBytes(80_000)]),
    "adapter/system": "You are Muse Muse's brief writer.\n\nReasoning strength: low.",
    "adapter/params": '{\n  "temperature": 0\n}\n',
    "adapter/tuned.jinja": "{{- bos_token -}}",
  });

  it("sends only the job's builds and their small files, inline, and leaves the rest behind", async () => {
    const r = await runJob(UPLOAD_RECIPE, {}, { recipe: "glimmer-quantize" }, {
      ...folder(),
      "adapter/muse-glimmer-30b-brief-writer-Q8_0.gguf": "GGUF the reference",
      "adapter/bf16.gguf": "GGUF the conversion",
      "adapter/adapter_model.safetensors": "an adapter's weights don't belong here",
      "adapter/notes.md": "notes",
    });
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    const plan = plans()[0]!;
    assert.deepEqual(plan.files.map((f) => f.path).sort(), ["muse-glimmer-30b-brief-writer-Q3_K_M.gguf", "muse-glimmer-30b-brief-writer-Q4_K_M.gguf", "muse-glimmer-30b-brief-writer-Q6_K.gguf", "params", "system", "tuned.jinja"]);
    assert.deepEqual(Object.keys(plan.small ?? {}).sort(), ["params", "system", "tuned.jinja"], "a build is never inline");
    assert.equal(plan.only, undefined, "the whole plan first");
    assert.deepEqual(resultOf(r), { uploaded: 3, skipped: null, failed: [], repo: REPO, files: 6, bytes: plan.files.reduce((n, f) => n + f.size, 0) });
  });

  it("takes builds up to 32 GB, and refuses a bigger one before reading it", async () => {
    // Sparse files: their sizes are what counts, and nothing reads them, since the plan refuses them first.
    const recipe = String.raw`import json, os
HERE = os.path.dirname(os.path.abspath(__file__))


def run(ctx):
    folder = os.path.join(HERE, "adapter")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, ctx.params["name"]), "wb") as f:
        f.write(b"GGUF")
        f.truncate(int(ctx.params["size"]))
    out = ctx.hub_upload(folder)
    print("HUB_RESULT " + json.dumps(out, sort_keys=True), flush=True)
    return {}
`;
    let r = await runJob(recipe, { name: "muse-glimmer-30b-brief-writer-Q6_K.gguf", size: HUB_GGUF_FILE_MAX_BYTES + 1 }, { recipe: "glimmer-quantize" }, { "adapter/system": "x" });
    assert.equal(r.code, 0, r.output);
    assert.equal(resultOf(r).skipped, "muse-glimmer-30b-brief-writer-Q6_K.gguf is over 34359.7 MB, more than one plan takes");
    assert.equal(hubCalls().length, 0);
    // An adapter's file keeps the adapter's 10 GB cap, and a .gguf in an adapter's folder isn't one of its names.
    r = await runJob(recipe, { name: "adapter_model.safetensors", size: HUB_FILE_MAX_BYTES + 1 }, { recipe: "glimmer-lora" }, {});
    assert.equal(resultOf(r).skipped, "adapter_model.safetensors is over 10737.4 MB, more than one plan takes");
    r = await runJob(recipe, { name: "muse-glimmer-30b-brief-writer-Q4_K_M.gguf", size: 10 }, { recipe: "glimmer-lora" }, {});
    assert.equal(resultOf(r).skipped, "the folder has no files to publish");
  });

  it("plans one file at a time when the platform says the whole answer is too large, and fails only a file still too large alone", async () => {
    planMode = { multipartOver: 50_000, chunk: 30_000 };
    planAnswers = [() => ({ status: 413, body: { error: "plan_too_large", perFile: true, message: "Plan one file at a time." } })];
    const files = folder();
    let r = await runJob(UPLOAD_RECIPE, {}, { recipe: "glimmer-quantize" }, files);
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assertCredentials(r);
    assertNoSecrets(r);
    const all = plans();
    assert.equal(all.length, 7, "the whole plan, then one for each of the six files");
    assert.deepEqual(all.slice(1).map((p) => p.only), [["muse-glimmer-30b-brief-writer-Q3_K_M.gguf"], ["muse-glimmer-30b-brief-writer-Q4_K_M.gguf"], ["muse-glimmer-30b-brief-writer-Q6_K.gguf"], ["params"], ["system"], ["tuned.jinja"]]);
    for (const p of all) assert.equal(p.files.length, 6, "each plan still names the whole folder");
    assert.deepEqual(planned.map((u) => u.map((x) => x.path)), [["muse-glimmer-30b-brief-writer-Q3_K_M.gguf"], ["muse-glimmer-30b-brief-writer-Q4_K_M.gguf"], ["muse-glimmer-30b-brief-writer-Q6_K.gguf"], [], [], []]);
    assert.equal(dones().length, 1, "one report at the end");
    assert.deepEqual((dones()[0]!.uploaded as Array<{ path: string }>).map((u) => u.path), ["muse-glimmer-30b-brief-writer-Q3_K_M.gguf", "muse-glimmer-30b-brief-writer-Q4_K_M.gguf", "muse-glimmer-30b-brief-writer-Q6_K.gguf"]);
    assert.deepEqual(resultOf(r).failed, []);
    for (const level of ["Q3_K_M", "Q4_K_M", "Q6_K"]) {
      const sent = files[gguf(level)] as Buffer;
      assert.ok(stored.get(sha256(sent))?.equals(sent), `${level} reached the storage whole`);
    }
    assert.match(r.output, /each file gets a plan of its own/);

    // One file whose own answer is still too large fails alone; the others still go.
    hits = [];
    planned = [];
    stored = new Map();
    planAnswers = [
      () => ({ status: 413, body: { error: "plan_too_large", perFile: true } }),
      () => ({ status: 413, body: { error: "plan_too_large", path: "muse-glimmer-30b-brief-writer-Q3_K_M.gguf", parts: 40000, message: "one file's parts can't be paged yet." } }),
    ];
    r = await runJob(UPLOAD_RECIPE, {}, { recipe: "glimmer-quantize" }, folder());
    assert.equal(r.code, 0);
    const failed = resultOf(r).failed;
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.path, "muse-glimmer-30b-brief-writer-Q3_K_M.gguf");
    assert.match(failed[0]!.error, /^its own upload plan is still too large for one reply: the platform answered HTTP 413 to the upload plan: plan_too_large: one file's parts can't be paged yet\.$/);
    assert.equal(resultOf(r).uploaded, 2);
    assert.deepEqual((dones()[0]!.failed as Array<{ path: string }>).map((f) => f.path), ["muse-glimmer-30b-brief-writer-Q3_K_M.gguf"], "and the report says so");

    // A skip while planning one by one ends it with the platform's reason.
    hits = [];
    planAnswers = [() => ({ status: 413, body: { error: "plan_too_large", perFile: true } }), () => ({ status: 200, body: { skip: "It is being published right now." } })];
    r = await runJob(UPLOAD_RECIPE, {}, { recipe: "glimmer-quantize" }, folder());
    assert.equal(resultOf(r).skipped, "It is being published right now.");
    assert.equal(dones().length, 0);
  });
});

describe("the glimmer-publish recipe", { skip: hasPython ? false : "python3 is missing", timeout: 240_000 }, () => {
  it("sends a cached adapter with its revision filled in on a copy, and never changes the cache", async () => {
    const weights = randomBytes(150_000);
    const original = peftConfig();
    const template = "{{ bos_token }}{% for m in messages %}{{ m.content }}{% endfor %}";
    const cache = await cacheWith({
      "adapter_model.safetensors": weights,
      "adapter_config.json": original,
      "chat_template.jinja": template,
      "README.md": "# PEFT's own card",
      "training_args.bin": "pickle",
    });
    try {
      const r = await runJob(PUBLISH_PY, { adapterJobId: ADAPTER_JOB.toUpperCase() }, { recipe: "glimmer-publish", cacheDir: cache });
      assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
      assertCredentials(r);
      assertNoSecrets(r);

      const plan = plans()[0]!;
      assert.deepEqual(plan.files.map((f) => f.path), ["adapter_config.json", "adapter_model.safetensors", "chat_template.jinja"]);
      assert.deepEqual(
        plan.files.filter((f) => f.path === "adapter_model.safetensors").map((f) => [f.size, f.sha256]),
        [[weights.length, sha256(weights)]],
      );
      assert.deepEqual(Object.keys(plan.small ?? {}).sort(), ["adapter_config.json", "chat_template.jinja"]);
      const sent = Buffer.from(plan.small!["adapter_config.json"]!, "base64").toString("utf8");
      const listed = plan.files.find((f) => f.path === "adapter_config.json")!;
      assert.deepEqual([listed.size, listed.sha256], [Buffer.byteLength(sent), sha256(Buffer.from(sent))], "files lists the copy that goes");
      const want = { ...(JSON.parse(original) as Record<string, unknown>), revision: REVISION };
      assert.equal(sent, JSON.stringify(want, null, 2), "the copy has the revision, and is otherwise PEFT's file");
      assert.deepEqual(Object.keys((JSON.parse(sent) as { rank_pattern: object }).rank_pattern), ["model.layers.1", "model.layers.0"]);
      assert.equal(Buffer.from(plan.small!["chat_template.jinja"]!, "base64").toString("utf8"), template);
      assert.deepEqual(stored.get(sha256(weights)), weights, "the weights went from the cache, through the staged link");

      const dir = path.join(cache, "models", ADAPTER_JOB);
      assert.equal(await readFile(path.join(dir, "adapter_config.json"), "utf8"), original, "the cache's config is as it was saved");
      const done = events().at(-1) as { type: string; summary: string; metrics: Record<string, unknown> };
      assert.equal(done.type, "done");
      assert.deepEqual(done.metrics, {
        adapter_job_id: ADAPTER_JOB,
        hub_uploaded: "yes",
        hub_repo: REPO,
        hub_files: 1,
        adapter_mb: Math.round((weights.length + Buffer.byteLength(sent) + template.length) / 1e5) / 10,
        config_fixed: "revision",
      });
      assert.equal(done.summary, `Sent the adapter of job ${ADAPTER_JOB.slice(0, 8)} to the Hugging Face Hub's storage for ${REPO}: 1 large file, ${done.metrics.adapter_mb} MB in all. The platform commits them with the model card.`);
      assert.ok(
        events().some((e) => e.type === "log" && e.text === `Sending the adapter of job ${ADAPTER_JOB} from ${dir} to the Hugging Face Hub, with revision filled in on a copy of its adapter_config.json`),
      );
      assert.match(r.output, new RegExp(`Hub upload for job ${ADAPTER_JOB}:`));
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("sends an adapter that has its revision straight from the cache, and fixes a local base model path on a copy", async () => {
    const weights = randomBytes(20_000);
    const pinned = peftConfig({ revision: REVISION });
    let cache = await cacheWith({ "adapter_model.safetensors": weights, "adapter_config.json": pinned });
    try {
      const r = await runJob(PUBLISH_PY, { adapterJobId: ADAPTER_JOB }, { recipe: "glimmer-publish", cacheDir: cache });
      assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
      assert.equal(Buffer.from(plans()[0]!.small!["adapter_config.json"]!, "base64").toString("utf8"), pinned, "sent as it is");
      assert.equal((events().at(-1) as { metrics: Record<string, unknown> }).metrics.config_fixed, "none");
    } finally {
      await rm(cache, { recursive: true, force: true });
    }

    hits = [];
    const local = peftConfig({ revision: REVISION, base_model_name_or_path: "/lambda/nfs/muse-muse-cache-us-east-1/hf/hub/snapshots/x" });
    cache = await cacheWith({ "adapter_model.safetensors": weights, "adapter_config.json": local });
    try {
      const r = await runJob(PUBLISH_PY, { adapterJobId: ADAPTER_JOB }, { recipe: "glimmer-publish", cacheDir: cache });
      assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
      const sent = JSON.parse(Buffer.from(plans()[0]!.small!["adapter_config.json"]!, "base64").toString("utf8")) as Record<string, unknown>;
      assert.equal(sent.base_model_name_or_path, MODEL, "loading it from the Hub finds the base");
      assert.equal(sent.revision, REVISION);
      assert.equal((events().at(-1) as { metrics: Record<string, unknown> }).metrics.config_fixed, "base_model_name_or_path");
      assert.equal(await readFile(path.join(cache, "models", ADAPTER_JOB, "adapter_config.json"), "utf8"), local);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("fails clearly without a usable id, the cache, the adapter, its weights, a plan or every file uploaded", async () => {
    const weights = randomBytes(10_000);
    const cache = await cacheWith({ "adapter_model.safetensors": weights, "adapter_config.json": peftConfig() });
    const failure = async (params: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      hits = [];
      const r = await runJob(PUBLISH_PY, params, { recipe: "glimmer-publish", cacheDir: cache, ...extra });
      assert.equal(r.code, 1, r.output.replaceAll(r.token, "[token]"));
      const last = events().at(-1) as { type: string; error: string };
      assert.equal(last.type, "failed");
      return last.error;
    };
    try {
      assert.match(await failure({ adapterJobId: "../../etc" }), /ValueError: adapterJobId must be the id of a glimmer-lora job, not "\.\.\/\.\.\/etc"/);
      assert.match(
        await failure({ adapterJobId: ADAPTER_JOB }, { cacheDir: path.join(cache, "not-mounted"), cacheWaitSeconds: 1 }),
        /The model cache isn't mounted, so the adapter of job 83d71f74-d84b-40bf-925a-cd36c90b6de5 can't be read/,
      );
      const other = "00000000-0000-4000-8000-000000000000";
      assert.match(await failure({ adapterJobId: other }), new RegExp(`There is no adapter in the cache at .*models/${other}: job ${other} saved none in this region`));
      const dir = path.join(cache, "models", other);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "adapter_config.json"), JSON.stringify({ dry_run: true }));
      assert.match(await failure({ adapterJobId: other }), /is a dry run's stand-in, not a trained adapter/);
      await writeFile(path.join(dir, "adapter_config.json"), peftConfig());
      await writeFile(path.join(dir, "adapter_model.bin"), "a pickled adapter");
      assert.match(await failure({ adapterJobId: other }), /has no adapter_model\.safetensors/);
      assert.equal(hubCalls().length, 0, "none of these asked the platform for a plan");

      planAnswers = [() => ({ status: 200, body: { skip: "HF_NAMESPACE isn't set" } })];
      assert.match(await failure({ adapterJobId: ADAPTER_JOB }), /The adapter of job 83d71f74-d84b-40bf-925a-cd36c90b6de5 wasn't sent to the Hugging Face Hub: HF_NAMESPACE isn't set/);

      storageFailures.set(`/s3/${sha256(weights)}`, [500, 500, 500]);
      const error = await failure({ adapterJobId: ADAPTER_JOB });
      assert.match(error, /1 file of the adapter of job 83d71f74-d84b-40bf-925a-cd36c90b6de5 didn't reach the Hugging Face Hub's storage:\nadapter_model\.safetensors: adapter_model\.safetensors failed 3 times, the last with HTTP 500/);
      assert.equal(dones().length, 1, "the platform still got the report");
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
});
