/**
 * scripts/devices/devicefarm.ts against a fake `aws` (canned Device Farm JSON, every call recorded and checked for the
 * profile, the region and JSON output) and a fake fetch (the presigned PUTs and the artifact downloads), with a fake
 * clock. The cache holds stand-in builds and a stand-in wheel, so nothing is downloaded and nothing calls AWS.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/devices/__tests__/devicefarm-cli.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import * as df from "@/lib/devices/devicefarm";
import { readResult } from "@/lib/devices/result";
import { SMOKE, llamaAsset, subjectById } from "@/lib/devices/subjects";
import type { Subject } from "@/lib/devices/types";
import {
  AwsLoginNeeded,
  DfClient,
  main,
  parseDfArgs,
  runCommand,
  shellQuote,
  type AwsExec,
  type DfDeps,
} from "@/scripts/devices/devicefarm";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "devices/devicefarm/fixtures/list-devices-android-phones.json"), "utf8"));
const ACCOUNT = "123456789012";
const PROJECT = `arn:aws:devicefarm:us-west-2:${ACCOUNT}:project:aaaaaaaa-0000-0000-0000-000000000000`;
const SIGNED = "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261028&X-Amz-Signature=fakesignature";
const FAKE_SECRETS = { AWS_SECRET_ACCESS_KEY: "fakeSecretKeyForCliTests0000000", HF_TOKEN: "hf_fakeTokenForCliTests000000000000" };
const T0 = Date.UTC(2026, 9, 28, 22, 15, 0);
const STAMP = "20261028T221500Z";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function write(file: string, data: string | Buffer) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

/** The files a finished Android kit run leaves for a subject (the kit contract's names and formats). */
function kitFolder(subject: Subject, answers: Record<string, string>, ramKb = 11_634_000): Record<string, string> {
  const steps = ["name=check backend=- prompt=- start=1793232001 seconds=1 limit=120 rc=0 end=ok why=-"];
  const files: Record<string, string> = {
    "run.txt":
      [
        "kit=1",
        `subject=${subject.id}`,
        "platform=android",
        "backends=cpu,gpu,npu",
        "prompts=capital,sum,color",
        "ctx=4096",
        "bench_prompt=128",
        "bench_gen=16",
        "bench_reps=2",
        "answer_tokens=64",
        "npu_sessions=1",
        "threads=",
        "started=1793232000",
        "layout_cpu=flat",
        "layout_gpu=bin-lib",
        "layout_npu=bin-lib",
        "finished=1793232100",
        "seconds=100",
        "status=done",
      ].join("\n") + "\n",
    "device.txt":
      `platform=android\nkernel=6.6.30\narch=aarch64\nram_kb=${ramKb}\ncores=8\ndisk_free_kb=180000000\nmanufacturer=samsung\n` +
      "model=SM-S942U1\nbrand=samsung\nandroid=16\nsdk=36\nsoc_manufacturer=QTI\nsoc_model=SM8850\nabi=arm64-v8a\n",
    "model.txt": `bytes_expected=${subject.bytes}\nbytes=${subject.bytes}\nsha256=${subject.sha256}\ncheck=ok\ntool=sha256sum\nseconds=1\nfetched=0\n`,
    "kit.log": "22:15:01 kit 1\n",
  };
  const speeds = { cpu: [250.5, 60.25], gpu: [400, 45.5], npu: [600, 30] } as const;
  for (const [backend, [pp, tg]] of Object.entries(speeds)) {
    files[`bench-${backend}.jsonl`] =
      `${JSON.stringify({ n_prompt: 128, n_gen: 0, avg_ts: pp, samples_ts: [pp, pp] })}\n` +
      `${JSON.stringify({ n_prompt: 0, n_gen: 16, avg_ts: tg, samples_ts: [tg, tg] })}\n`;
    files[`bench-${backend}.log`] = "load_tensors: offloaded 31/31 layers to GPU\n";
    files[`mem-bench-${backend}.txt`] = "t=0 avail_kb=9000000 hwm_kb=1000\nt=2 avail_kb=8800000 hwm_kb=120000 temp_mc=41000\n";
    steps.push(`name=bench backend=${backend} prompt=- start=1793232010 seconds=5 limit=180 rc=0 end=ok why=-`);
  }
  for (const backend of ["cpu", "gpu", "npu"]) {
    for (const [id, text] of Object.entries(answers)) {
      files[`answer-${backend}-${id}.txt`] = `${text}<|im_end|> [end of text]\n`;
      files[`answer-${backend}-${id}.log`] =
        "0.00.100.000 I common_perf_print:        load time =     120.00 ms\n" +
        "0.00.100.001 I common_perf_print: prompt eval time =      50.00 ms /    40 tokens (    1.25 ms per token,   800.00 tokens per second)\n" +
        "0.00.100.002 I common_perf_print:        eval time =      30.00 ms /     3 runs   (   10.00 ms per token,   100.00 tokens per second)\n";
      steps.push(`name=answer backend=${backend} prompt=${id} start=1793232050 seconds=2 limit=90 rc=0 end=ok why=-`);
    }
  }
  files["steps.txt"] = `${steps.join("\n")}\n`;
  files[`host-${subject.id}.txt`] =
    `subject=${subject.id}\nmem_total_kb=${ramKb}\nmin_ram_kb=1261000\nphone_free_kb=180000000\nhost_free_kb=90000000\n` +
    "download_seconds=3\nhost_sha256_seconds=0\nhost_sha256=ok\npush_seconds=4\ncopy=push\nkit_rc=0\nkit_seconds=100\nkit_finished=1\n";
  return files;
}

const RIGHT = { capital: "Paris", sum: "17 + 25 = 42.", color: "Green" };

/** The customer artifact: $DEVICEFARM_LOG_DIR zipped under a folder of Device Farm's own. */
function customerZip(folders: Record<string, Record<string, string>>): Buffer {
  const prefix = "Host_Machine_Files/tmp/scratch/logs/mm";
  const entries: df.ZipEntry[] = [{ path: `${prefix}/host.log`, data: Buffer.from("[mm] test: done (status 0)\n") }];
  for (const [id, files] of Object.entries(folders)) {
    entries.push({ path: `${prefix}/${id}.console.txt`, data: Buffer.from("kit console\n") });
    for (const [name, text] of Object.entries(files)) entries.push({ path: `${prefix}/${id}/${name}`, data: Buffer.from(text) });
  }
  return df.zipBuild(entries);
}

interface FakeRun {
  arn: string;
  name: string;
  input: Record<string, unknown>;
  statuses: string[];
  result: string;
  stopped: boolean;
  folders: Record<string, Record<string, string>>;
  device: Record<string, string>;
}

/** Device Farm through a fake `aws`: canned answers in the shapes of the API reference, every call kept. */
class FakeDeviceFarm {
  calls: string[][] = [];
  projects: Array<{ arn: string; name: string }> = [];
  uploads = new Map<string, { name: string; type: string; polls: number; fail?: string }>();
  runs = new Map<string, FakeRun>();
  fail: Record<string, string> = {};
  /** The statuses each new run reports, one per GetRun, the last one repeating. */
  statuses = ["SCHEDULING", "RUNNING", "COMPLETED"];
  /** What each run's job leaves, by subject id; null leaves no customer artifact. */
  folders: (input: Record<string, unknown>) => Record<string, Record<string, string>> | null = () => ({
    [SMOKE.id]: kitFolder(SMOKE, RIGHT),
  });
  failUpload: string | null = null;
  onGetRun: (() => void) | null = null;

  exec: AwsExec = async (args) => {
    this.calls.push([...args]);
    assert.equal(args[0], "devicefarm");
    assert.deepEqual(args.slice(-6), ["--profile", "base-test", "--region", "us-west-2", "--output", "json"]);
    assert.ok(!args.includes("--debug"));
    const cmd = args[1];
    const arg = (flag: string) => args[args.indexOf(flag) + 1];
    const ok = (json: unknown) => ({ code: 0, stdout: JSON.stringify(json), stderr: "" });
    if (this.fail[cmd]) return { code: 255, stdout: "", stderr: this.fail[cmd] };
    switch (cmd) {
      case "list-devices":
        return ok(FIXTURE);
      case "get-account-settings":
        return ok({
          accountSettings: {
            awsAccountNumber: ACCOUNT,
            unmeteredDevices: { ANDROID: 0, IOS: 0 },
            trialMinutes: { total: 1000, remaining: 620.25 },
            maxJobTimeoutMinutes: 150,
          },
        });
      case "list-projects":
        return ok({ projects: this.projects });
      case "create-project": {
        const project = { arn: PROJECT, name: arg("--name") };
        this.projects.push(project);
        return ok({ project });
      }
      case "create-upload": {
        const arn = `arn:aws:devicefarm:us-west-2:${ACCOUNT}:upload:aaaaaaaa/${this.uploads.size + 1}`;
        this.uploads.set(arn, { name: arg("--name"), type: arg("--type"), polls: 0, fail: arg("--type") === this.failUpload ? "x" : undefined });
        return ok({ upload: { arn, name: arg("--name"), status: "INITIALIZED", url: `https://prod-us-west-2-uploads.s3.amazonaws.com/u${this.uploads.size}?${SIGNED}` } });
      }
      case "get-upload": {
        const u = this.uploads.get(arg("--arn"));
        assert.ok(u, "a known upload");
        u.polls++;
        if (u.fail) return ok({ upload: { arn: arg("--arn"), status: "FAILED", message: "Invalid package.", metadata: '{"errors":["no tests"]}' } });
        return ok({ upload: { arn: arg("--arn"), status: u.polls < 2 ? "PROCESSING" : "SUCCEEDED", url: `https://x/?${SIGNED}` } });
      }
      case "schedule-run": {
        const input = JSON.parse(arg("--cli-input-json")) as Record<string, unknown>;
        const arn = `arn:aws:devicefarm:us-west-2:${ACCOUNT}:run:aaaaaaaa/r${this.runs.size + 1}`;
        const deviceArn = ((input.deviceSelectionConfiguration as { filters: Array<{ values: string[] }> }).filters[0].values[0]);
        const raw = FIXTURE.devices.find((d: { arn: string }) => d.arn === deviceArn);
        this.runs.set(arn, {
          arn,
          name: String(input.name),
          input,
          statuses: [...this.statuses],
          result: "PASSED",
          stopped: false,
          folders: this.folders(input) ?? {},
          device: { arn: deviceArn, name: raw.name, manufacturer: raw.manufacturer, model: raw.model, os: raw.os },
        });
        return ok({ run: { arn, name: input.name, status: "SCHEDULING", result: "PENDING" } });
      }
      case "get-run": {
        this.onGetRun?.();
        const run = this.runs.get(arg("--arn"));
        assert.ok(run, "a known run");
        const status = run.stopped ? "COMPLETED" : run.statuses.length > 1 ? (run.statuses.shift() as string) : run.statuses[0];
        return ok({
          run: {
            arn: run.arn,
            name: run.name,
            status,
            result: status === "COMPLETED" ? (run.stopped ? "STOPPED" : run.result) : "PENDING",
            parsingResultUrl: `https://x/?${SIGNED}`,
            deviceMinutes: { total: 6.5, metered: 6.5, unmetered: 0 },
          },
        });
      }
      case "stop-run": {
        const run = this.runs.get(arg("--arn"));
        if (!run) return { code: 254, stdout: "", stderr: "An error occurred (NotFoundException) when calling the StopRun operation: no run" };
        run.stopped = true;
        return ok({ run: { arn: run.arn, name: run.name, status: "STOPPING", result: "STOPPED" } });
      }
      case "list-jobs": {
        const run = this.runs.get(arg("--arn"));
        assert.ok(run, "a known run");
        return ok({
          jobs: [{ arn: `${run.arn.replace(":run:", ":job:")}/00000`, status: "COMPLETED", result: run.result, device: run.device, deviceMinutes: { total: 6.5 } }],
        });
      }
      case "list-artifacts": {
        const job = arg("--arn");
        if (arg("--type") === "FILE") {
          const run = [...this.runs.values()].find((r) => job.startsWith(r.arn.replace(":run:", ":job:")));
          if (!run || Object.keys(run.folders).length === 0) return ok({ artifacts: [] });
          return ok({ artifacts: [{ arn: `${job}/a1`, name: "Customer Artifacts", type: "CUSTOMER_ARTIFACT", extension: "zip", url: `https://results.s3.amazonaws.com/${encodeURIComponent(job)}/customer.zip?${SIGNED}` }] });
        }
        return ok({ artifacts: [{ arn: `${job}/l1`, name: "TestSpec Output", type: "TESTSPEC_OUTPUT", extension: "txt", url: `https://results.s3.amazonaws.com/${encodeURIComponent(job)}/console.txt?${SIGNED}` }] });
      }
      case "list-suites":
        return ok({ suites: [] });
      default:
        return { code: 252, stdout: "", stderr: `fake aws: no ${cmd}` };
    }
  };

  commands(): string[] {
    return this.calls.map((c) => c[1]);
  }
}

interface Fetched {
  method: string;
  url: string;
  bytes: number;
  contentType: string | null;
}

interface CliWorld {
  root: string;
  deps: DfDeps;
  aws: FakeDeviceFarm;
  lines: string[];
  fetched: Fetched[];
  interrupt: { handler: (() => Promise<void>) | null };
  /** Public Hub answers by URL, for --tuned. */
  hub: Map<string, string>;
  out: () => string;
}

function cliWorld(): CliWorld {
  const root = mkdtempSync(path.join(os.tmpdir(), "mm-df-cli-"));
  roots.push(root);
  const cache = path.join(root, "cache");
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const builds: Array<[Parameters<typeof llamaAsset>[0], string[]]> = [
    ["android-arm64", ["LICENSE", "llama-bench", "llama-completion", "libllama.so", "llama-server"]],
    ["android-arm64-snapdragon", ["LICENSE", "bin/llama-bench", "bin/llama-completion", "lib/libllama.so", "lib/libggml-htp-v81.so"]],
  ];
  for (const [build, files] of builds) {
    const dir = path.join(cache, "llama", "b11669", build);
    for (const f of files) write(path.join(dir, "llama-b11669", f), `stand-in ${f}\n`);
    write(path.join(dir, ".sha256"), `${llamaAsset(build).sha256}\n`);
  }
  const wheel = Buffer.from("a stand-in wheel\n");
  const wheels: df.CarrierWheel[] = [
    { name: "pytest", version: "8.4.2", file: "pytest-8.4.2-py3-none-any.whl", bytes: wheel.length, sha256: sha(wheel), url: "https://files.pythonhosted.org/packages/xx/pytest-8.4.2-py3-none-any.whl" },
  ];
  write(path.join(cache, "devicefarm", "wheels", wheels[0].file), wheel);

  const aws = new FakeDeviceFarm();
  const lines: string[] = [];
  const fetched: Fetched[] = [];
  const interrupt: CliWorld["interrupt"] = { handler: null };
  const hub = new Map<string, string>();
  let clock = T0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body as Uint8Array | undefined;
    fetched.push({ method, url, bytes: body?.byteLength ?? 0, contentType: headers.get("content-type") });
    if (method === "PUT") return new Response(null, { status: 200 });
    if (hub.has(url)) return new Response(hub.get(url));
    if (url.includes("/customer.zip?")) {
      const job = decodeURIComponent(url.split("/")[3]);
      const run = [...aws.runs.values()].find((r) => job.startsWith(r.arn.replace(":run:", ":job:")));
      return new Response(new Uint8Array(customerZip(run?.folders ?? {})), { status: 200 });
    }
    if (url.includes("/console.txt?")) {
      return new Response(`[DEVICEFARM] bash host.sh test\n[mm] uploaded to https://bucket.s3.amazonaws.com/x?${SIGNED}\n[mm] test: done\n`);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const deps: DfDeps = {
    aws: aws.exec,
    fetchImpl,
    repoRoot: repo,
    cache,
    env: { ...FAKE_SECRETS, HOME: "/Users/someone" },
    say: (line) => lines.push(line),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
    wheels,
    onInterrupt: (handler) => {
      interrupt.handler = handler;
      return () => {
        interrupt.handler = null;
      };
    },
  };
  return { root, deps, aws, lines, fetched, interrupt, hub, out: () => lines.join("\n") };
}

/** Every file under dir, as text. */
function allText(dir: string): string {
  if (!existsSync(dir)) return "";
  let text = "";
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) text += readFileSync(path.join(entry.parentPath, entry.name)).toString("latin1");
  }
  return text;
}

function resultFiles(repo: string): string[] {
  const dir = path.join(repo, "devices", "results", "devicefarm");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name === "result.json")
    .map((e) => path.join(e.parentPath, e.name));
}

/** A passed Device Farm smoke result in the repo, so a run of large files may go. */
function seedSmokePass(w: CliWorld) {
  const dir = path.join(w.deps.repoRoot, "devices/results/devicefarm/samsung-galaxy-s26-12gb", SMOKE.id, "20261027T000000Z");
  write(
    path.join(dir, "result.json"),
    JSON.stringify({
      schema: 1,
      kit: 1,
      cloud: "devicefarm",
      runId: "arn:x",
      stamp: "20261027T000000Z",
      device: { cloud: "devicefarm", slug: "samsung-galaxy-s26-12gb", name: "Samsung Galaxy S26", cloudId: "arn:aws:devicefarm:us-west-2::device:C2F2BF5633994E75942BE2EB246C2709", ramBytes: 11_634_000 * 1024, marketedRamGiB: 12 },
      subject: SMOKE,
      status: "done",
      backends: [{ backend: "cpu", loaded: true }],
      completions: [],
      verdict: { rating: "usable", backend: "cpu", genTps: 60, promptTps: 250, answersRight: 3, answersTotal: 3, reasons: [] },
      notes: [],
    }),
  );
}

describe("devicefarm.ts arguments", () => {
  it("reads commands and flags, and refuses what it can't use", () => {
    const a = parseDfArgs(["run", "--smoke", "--device", "Samsung Galaxy S25", "--device", "x", "--max-devices", "2", "--copy", "stream", "--yes"]);
    assert.equal(a.command, "run");
    assert.deepEqual(a.devices, ["Samsung Galaxy S25", "x"]);
    assert.equal(a.maxDevices, 2);
    assert.equal(a.copy, "stream");
    assert.equal(parseDfArgs(["plan", "--probe"]).smoke, true);
    const run = `arn:aws:devicefarm:us-west-2:${ACCOUNT}:run:aaaaaaaa/r1`;
    assert.deepEqual(parseDfArgs(["fetch", run, "--wait"]).arns, [run]);
    assert.throws(() => parseDfArgs(["fetch"]), /needs a run ARN/);
    assert.throws(() => parseDfArgs(["stop", "arn:aws:devicefarm:us-east-1:1:run:x"]), /Not a Device Farm run ARN/);
    assert.throws(() => parseDfArgs(["run", "--max-devices", "6"]), /from 1 to 5/);
    assert.throws(() => parseDfArgs(["run", "--backends", "cpu,tpu"]), /cpu, gpu and npu/);
    assert.throws(() => parseDfArgs(["run", "--smoke", "--subjects", "bartowski-iq2_m"]), /drop --subjects/);
    assert.throws(() => parseDfArgs(["run", "--debug"]), /Unknown flag --debug/);
    assert.throws(() => parseDfArgs(["deploy"]), /Unknown command deploy/);
  });

  it("prints the exact command with the phones pinned by ARN, quoted for a shell", () => {
    assert.equal(shellQuote("arn:aws:devicefarm:us-west-2::device:ABC"), "arn:aws:devicefarm:us-west-2::device:ABC");
    assert.equal(shellQuote("Samsung Galaxy S25"), "'Samsung Galaxy S25'");
    assert.equal(shellQuote("it's"), `'it'\\''s'`);
    const phones = df.androidPhones(FIXTURE).map((d) => df.phoneFor(d));
    const batch = df.planBatch(df.chooseProbes(phones, { maxDevices: 2 }), { stamp: STAMP, smoke: true });
    const args = parseDfArgs(["plan", "--probe", "--max-usd", "20"]);
    const command = runCommand(args, batch, { maxDevices: 3, maxUsd: 20 });
    assert.match(command, /^npx tsx scripts\/devices\/devicefarm\.ts run --yes --smoke --device arn:aws:devicefarm:us-west-2::device:\w+ --device arn:\S+ --max-devices 3 --max-usd 20$/);
  });
});

describe("devicefarm.ts without --yes", () => {
  it("dry-runs with no AWS call: the plan, the package and the spec, and no secret in either", async () => {
    const w = cliWorld();
    const code = await main(["plan", "--dry-run"], w.deps);
    assert.equal(code, 0, w.out());
    assert.deepEqual(w.aws.calls, []);
    assert.match(w.out(), /Device Farm plan 20261028T221500Z: 3 runs on 3 phones/);
    assert.match(w.out(), /No AWS call was made\./);
    assert.match(w.out(), /To run it: npx tsx scripts\/devices\/devicefarm\.ts run --yes --device arn:aws:devicefarm:us-west-2::device:092D78E7B4694568812D5FF0711CD346 /);
    const dir = path.join(w.deps.cache, "devicefarm", STAMP);
    const zip = readFileSync(path.join(dir, `mm-devices-${STAMP}.zip`));
    const names = df.zipRead(zip).map((e) => e.path);
    for (const p of ["requirements.txt", "tests/test_carrier.py", "wheelhouse/pytest-8.4.2-py3-none-any.whl", "mm/host.sh", "mm/kit/run.sh", "mm/llama-android/llama-bench", "mm/llama-snapdragon/bin/llama-bench", `mm/plan/${STAMP}-02/bartowski-iq2_m.env`]) {
      assert.ok(names.includes(p), p);
    }
    assert.ok(!names.includes("mm/llama-android/llama-server"), "trimmed by keepLlamaFile");
    assert.equal(readFileSync(path.join(dir, `mm-devices-${STAMP}.yml`), "utf8"), df.testSpecYaml());
    const bytes = zip.toString("latin1");
    for (const v of Object.values(FAKE_SECRETS)) assert.ok(!bytes.includes(v), "no secret value in the package");
    for (const e of df.zipRead(zip).filter((x) => x.path.startsWith("mm/plan/"))) {
      assert.deepEqual(df.secretHits(Buffer.from(e.data).toString("utf8")), [], e.path);
    }
  });

  it("refuses to build a package that would carry a secret value", async () => {
    const w = cliWorld();
    w.deps.env = { ...w.deps.env, SOME_API_KEY: "You are a helpful AI assistant." };
    await assert.rejects(main(["plan", "--dry-run"], w.deps), /holds the value of SOME_API_KEY: not building the package/);
  });

  it("plans with Device Farm's live phone list and account, and schedules nothing", async () => {
    const w = cliWorld();
    assert.equal(await main(["plan"], w.deps), 0, w.out());
    assert.deepEqual(w.aws.commands(), ["list-devices", "get-account-settings"]);
    assert.match(w.out(), /620\.25 trial minutes left, which cover the worst case/);
    assert.match(w.out(), /Nothing was scheduled\. To run it: npx tsx scripts\/devices\/devicefarm\.ts run --yes /);
    const filters = JSON.parse(w.aws.calls[0][w.aws.calls[0].indexOf("--filters") + 1]);
    assert.deepEqual(filters, [
      { attribute: "PLATFORM", operator: "EQUALS", values: ["ANDROID"] },
      { attribute: "FORM_FACTOR", operator: "EQUALS", values: ["PHONE"] },
    ]);
    assert.equal(await main(["run"], w.deps), 0, "run without --yes only plans");
    assert.ok(!w.aws.commands().includes("schedule-run"));
  });

  it("refuses a plan over the caps before any upload", async () => {
    const w = cliWorld();
    assert.equal(await main(["run", "--yes", "--max-usd", "40"], w.deps), 1);
    assert.match(w.out(), /Refusing to schedule this plan:\n {2}The worst case costs \$50\.15, over --max-usd 40\./);
    assert.deepEqual(w.aws.commands(), ["list-devices", "get-account-settings"]);
  });

  it("refuses large files until a Device Farm smoke run has passed", async () => {
    const w = cliWorld();
    assert.equal(await main(["run", "--yes"], w.deps), 1);
    assert.match(w.out(), /Refusing to schedule large files before a Device Farm smoke run has passed/);
    assert.ok(!w.aws.commands().some((c) => c.startsWith("create-") || c === "schedule-run"));
  });

  it("lists phones by RAM tier and names the ones to probe", async () => {
    const w = cliWorld();
    assert.equal(await main(["devices"], w.deps), 0);
    assert.match(w.out(), /^16 GB \(\d+\):\n {2}Google Pixel 10 Pro XL, Android 16, 16 GB \(spec sheet\), Tensor G5, backends cpu/m);
    assert.match(w.out(), /RAM only reported, so measured by a smoke run first \(run --smoke --probe --yes\): .*Samsung Galaxy S26/);
    assert.match(w.out(), /more phones have under 12 GB and run nothing\./);
  });

  it("stops at once with the login command when the SSO session has expired", async () => {
    const w = cliWorld();
    w.aws.fail["list-devices"] = "Error when retrieving token from sso: Token has expired and refresh failed";
    const err = await main(["plan"], w.deps).catch((e: unknown) => e);
    assert.ok(err instanceof AwsLoginNeeded);
    assert.match((err as Error).message, /aws sso login --profile base-test/);
    assert.deepEqual(w.aws.commands(), ["list-devices"]);
  });

  it("never puts a secret value on the aws command line", async () => {
    const client = new DfClient(async () => ({ code: 0, stdout: "{}", stderr: "" }), [{ name: "HF_TOKEN", value: "hf_secretvalue123" }]);
    await assert.rejects(client.call("get-run", ["--arn", "hf_secretvalue123"]), /Refusing to put the value of HF_TOKEN/);
    const failing = new DfClient(async () => ({ code: 255, stdout: `{"url":"https://x/?${SIGNED}"}`, stderr: `An error occurred: see https://s3/x?${SIGNED}` }));
    const e = await failing.call("get-run", ["--arn", "x"]).catch((x: Error) => x);
    assert.ok(!String(e).includes("Signature") && !String(e).includes("AKIA"), String(e));
  });
});

describe("devicefarm.ts run --yes", () => {
  it("runs the smoke model on one phone: project, uploads, schedule, poll, artifacts, result", async () => {
    const w = cliWorld();
    const code = await main(["run", "--smoke", "--yes"], w.deps);
    assert.equal(code, 0, w.out());
    assert.deepEqual(w.aws.commands(), [
      "list-devices",
      "get-account-settings",
      "list-projects",
      "create-project",
      "create-upload",
      "get-upload",
      "get-upload",
      "create-upload",
      "get-upload",
      "get-upload",
      "schedule-run",
      "get-run",
      "get-run",
      "get-run",
      "list-jobs",
      "list-artifacts",
      "list-artifacts",
    ]);
    const createProject = w.aws.calls[3];
    assert.deepEqual(createProject.slice(2, 6), ["--name", "muse-muse-devices", "--default-job-timeout-minutes", "150"]);
    const uploads = w.aws.calls.filter((c) => c[1] === "create-upload").map((c) => [c[c.indexOf("--name") + 1], c[c.indexOf("--type") + 1], c[c.indexOf("--content-type") + 1]]);
    assert.deepEqual(uploads, [
      [`mm-devices-${STAMP}.zip`, "APPIUM_WEB_PYTHON_TEST_PACKAGE", "application/octet-stream"],
      [`mm-devices-${STAMP}.yml`, "APPIUM_WEB_PYTHON_TEST_SPEC", "application/octet-stream"],
    ]);
    const puts = w.fetched.filter((f) => f.method === "PUT");
    assert.equal(puts.length, 2);
    assert.ok(puts.every((p) => p.contentType === "application/octet-stream"));
    const zipFile = path.join(w.deps.cache, "devicefarm", STAMP, `mm-devices-${STAMP}.zip`);
    assert.equal(puts[0].bytes, readFileSync(zipFile).length);

    const [run] = w.aws.runs.values();
    assert.deepEqual(run.input.deviceSelectionConfiguration, {
      filters: [{ attribute: "ARN", operator: "IN", values: ["arn:aws:devicefarm:us-west-2::device:C2F2BF5633994E75942BE2EB246C2709"] }],
      maxDevices: 1,
    });
    assert.equal(run.name, `mm ${STAMP}-01 Samsung Galaxy S26`);
    assert.deepEqual(run.input.test, {
      type: "APPIUM_WEB_PYTHON",
      testPackageArn: `arn:aws:devicefarm:us-west-2:${ACCOUNT}:upload:aaaaaaaa/1`,
      testSpecArn: `arn:aws:devicefarm:us-west-2:${ACCOUNT}:upload:aaaaaaaa/2`,
    });
    assert.deepEqual(run.input.configuration, { billingMethod: "METERED", environmentVariables: [{ name: "MM_PLAN", value: `${STAMP}-01` }] });
    assert.deepEqual(run.input.executionConfiguration, { jobTimeoutMinutes: 27, videoCapture: false });
    assert.equal(run.input.appArn, undefined);

    const [file] = resultFiles(w.deps.repoRoot);
    assert.ok(file, w.out());
    assert.equal(
      path.relative(w.deps.repoRoot, path.dirname(file)),
      `devices/results/devicefarm/samsung-galaxy-s26-12gb/${SMOKE.id}/${STAMP}`,
    );
    const result = readResult(file);
    assert.equal(result.cloud, "devicefarm");
    assert.equal(result.runId, run.arn);
    assert.equal(result.device.name, "Samsung Galaxy S26");
    assert.equal(result.device.cloudId, "arn:aws:devicefarm:us-west-2::device:C2F2BF5633994E75942BE2EB246C2709");
    assert.equal(result.device.marketedRamGiB, 12);
    assert.equal(result.device.soc, "SM8850");
    assert.equal(result.status, "done");
    assert.deepEqual(result.backends.map((b) => [b.backend, b.genTps]), [["cpu", 60.25], ["gpu", 45.5], ["npu", 30]]);
    assert.equal(result.verdict.rating, "usable");
    assert.ok(result.notes.some((n) => /downloaded the file in 3 s, checked its sha256 and pushed it with adb in 4 s/.test(n)));
    assert.ok(existsSync(path.join(path.dirname(file), `host-${SMOKE.id}.txt`)));
    assert.match(w.out(), /Samsung Galaxy S26, 12 GB, smoke-smollm2-135m-q4_0: usable, 60\.3 tokens a second on cpu, 3 of 3 answers right\./);
    assert.match(w.out(), /PASSED, 6\.5 device minutes\./);

    const record = df.readBatchRecord(JSON.parse(readFileSync(path.join(w.deps.cache, "devicefarm", STAMP, "batch.json"), "utf8")));
    assert.equal(record.runs[0].arn, run.arn);
    assert.equal(record.packageArn, `arn:aws:devicefarm:us-west-2:${ACCOUNT}:upload:aaaaaaaa/1`);
    const consoleFile = readdirSync(path.join(w.deps.cache, "devicefarm", STAMP), { recursive: true }).find((f) => String(f).endsWith("console.txt"));
    assert.ok(consoleFile);
    const consoleText = readFileSync(path.join(w.deps.cache, "devicefarm", STAMP, String(consoleFile)), "utf8");
    assert.match(consoleText, /\[presigned URL removed\]/);

    const everything = w.out() + allText(w.deps.repoRoot) + allText(path.join(w.deps.cache, "devicefarm", STAMP));
    assert.ok(!everything.includes("X-Amz-Signature") && !everything.includes("AKIAIOSFODNN7EXAMPLE"), "no presigned URL is printed or written");
    for (const v of Object.values(FAKE_SECRETS)) assert.ok(!everything.includes(v));
    assert.equal(w.interrupt.handler, null, "the Ctrl-C handler is removed once the runs are done");
  });

  it("runs the picked files once a smoke run has passed, and files each result by phone and subject", async () => {
    const w = cliWorld();
    seedSmokePass(w);
    w.aws.projects.push({ arn: PROJECT, name: "muse-muse-devices" });
    w.aws.folders = (input): Record<string, Record<string, string>> => {
      const plan = (input.configuration as { environmentVariables: Array<{ value: string }> }).environmentVariables[0].value;
      if (plan.endsWith("-02")) return { "bartowski-iq2_m": kitFolder(subjectById("bartowski-iq2_m") as Subject, RIGHT, 15_600_000) };
      return { "bartowski-iq2_xxs": kitFolder(subjectById("bartowski-iq2_xxs") as Subject, { capital: "Lyon", sum: "41", color: "Green" }) };
    };
    const code = await main(["run", "--yes", "--max-devices", "2"], w.deps);
    assert.equal(code, 0, w.out());
    assert.ok(!w.aws.commands().includes("create-project"), "the project is reused");
    assert.deepEqual([...w.aws.runs.values()].map((r) => (r.input.executionConfiguration as { jobTimeoutMinutes: number }).jobTimeoutMinutes), [75, 145]);
    // The smoke run measured the S26's MemTotal, so it now counts as a 12 GB phone and, being newest, leads the tier.
    assert.match(w.out(), /1\. Samsung Galaxy S26, Android 16, 12 GB \(measured\)/);
    const files = resultFiles(w.deps.repoRoot).map((f) => path.relative(w.deps.repoRoot, path.dirname(f))).sort();
    assert.deepEqual(files, [
      `devices/results/devicefarm/google-pixel-10-pro-xl-16gb/bartowski-iq2_m/${STAMP}`,
      `devices/results/devicefarm/samsung-galaxy-s26-12gb/bartowski-iq2_xxs/${STAMP}`,
      `devices/results/devicefarm/samsung-galaxy-s26-12gb/${SMOKE.id}/20261027T000000Z`,
    ]);
    assert.match(w.out(), /Google Pixel 10 Pro XL, bartowski-iq2_xxs: not tested: the artifacts have nothing for it/);
    const galaxy = readResult(path.join(w.deps.repoRoot, `devices/results/devicefarm/samsung-galaxy-s26-12gb/bartowski-iq2_xxs/${STAMP}/result.json`));
    assert.equal(galaxy.verdict.rating, "unusable", "one answer of three right on every backend");
  });

  it("stops the scheduled runs when anything fails after scheduling, so nothing keeps billing", async () => {
    const w = cliWorld();
    w.aws.onGetRun = () => {
      w.aws.fail["get-run"] = "An error occurred (ServiceAccountException) when calling the GetRun operation: account problem";
    };
    await assert.rejects(main(["run", "--smoke", "--yes"], w.deps), /aws devicefarm get-run failed \(exit 255\): An error occurred \(ServiceAccountException\)/);
    assert.deepEqual(w.aws.commands().slice(-2), ["get-run", "stop-run"]);
    assert.equal([...w.aws.runs.values()][0].stopped, true);
    assert.match(w.out(), /Stopping 1 unfinished run after an error/);
  });

  it("stops the runs on Ctrl-C", async () => {
    const w = cliWorld();
    w.aws.statuses = ["RUNNING", "RUNNING", "COMPLETED"];
    let interrupted = false;
    w.aws.onGetRun = () => {
      if (!interrupted && w.interrupt.handler) {
        interrupted = true;
        void w.interrupt.handler();
      }
    };
    assert.equal(await main(["run", "--smoke", "--yes"], w.deps), 0);
    assert.ok(w.aws.commands().includes("stop-run"));
    assert.match(w.out(), /Interrupted: stopping the unfinished runs/);
  });

  it("stops a run far past its job timeout, then still reads what it left", async () => {
    const w = cliWorld();
    w.aws.statuses = ["RUNNING"];
    assert.equal(await main(["run", "--smoke", "--yes"], w.deps), 0, w.out());
    const stops = w.aws.calls.filter((c) => c[1] === "stop-run");
    assert.equal(stops.length, 1);
    assert.match(w.out(), /Stopped mm 20261028T221500Z-01 Samsung Galaxy S26 \(it ran 48 minutes, past its 27-minute job timeout\)/);
    assert.match(w.out(), /STOPPED, 6\.5 device minutes/);
    assert.equal(resultFiles(w.deps.repoRoot).length, 1);
  });

  it("schedules nothing when Device Farm refuses the package", async () => {
    const w = cliWorld();
    w.aws.failUpload = "APPIUM_WEB_PYTHON_TEST_PACKAGE";
    await assert.rejects(main(["run", "--smoke", "--yes"], w.deps), /Device Farm refused mm-devices-20261028T221500Z\.zip: Invalid package\. \{"errors":\["no tests"\]\}/);
    assert.ok(!w.aws.commands().includes("schedule-run"));
    assert.ok(!w.aws.commands().includes("stop-run"));
  });

  it("schedules and returns with --detach, printing how to fetch and stop", async () => {
    const w = cliWorld();
    assert.equal(await main(["run", "--smoke", "--yes", "--detach"], w.deps), 0);
    assert.ok(!w.aws.commands().includes("get-run"));
    assert.match(w.out(), /npx tsx scripts\/devices\/devicefarm\.ts fetch arn:aws:devicefarm:us-west-2:123456789012:run:aaaaaaaa\/r1 --wait/);
    assert.match(w.out(), /To stop them: npx tsx scripts\/devices\/devicefarm\.ts stop arn:/);
  });
});

describe("devicefarm.ts with a tuned repo", () => {
  it("plans a tuned repo's files from the public Hub, with its system message and template on the phone", async () => {
    const w = cliWorld();
    const repo = "acme/muse-glimmer-30b-pirate-gguf-8f1d2c3b";
    const rev = "d".repeat(40);
    const file = (level: string, bytes: number, n: string) => ({ type: "file", path: `muse-glimmer-30b-pirate-${level}.gguf`, size: bytes, lfs: { oid: n.repeat(64) } });
    w.hub.set(`https://huggingface.co/api/models/${repo}`, JSON.stringify({ sha: rev }));
    w.hub.set(
      `https://huggingface.co/api/models/${repo}/tree/${rev}?recursive=true`,
      JSON.stringify([
        file("Q3_K_M", 13_680_000_000, "1"),
        file("Q4_K_M", 16_940_000_000, "2"),
        file("Q6_K", 22_870_000_000, "3"),
        { type: "file", path: "system", size: 40 },
        { type: "file", path: "tuned.jinja", size: 20 },
      ]),
    );
    w.hub.set(`https://huggingface.co/${repo}/resolve/${rev}/system`, "You are a pirate.\n\nReasoning strength: low.");
    w.hub.set(`https://huggingface.co/${repo}/resolve/${rev}/tuned.jinja`, "{{ pirate template }}");
    assert.equal(await main(["plan", "--dry-run", "--tuned", repo, "--device", "Google Pixel 10 Pro XL", "--device", "Samsung Galaxy S25"], w.deps), 0, w.out());
    assert.match(w.out(), /Tuned files of acme\/muse-glimmer-30b-pirate-gguf-8f1d2c3b at dddddddddddd: tuned-8f1d2c3b-q3_k_m, tuned-8f1d2c3b-q4_k_m, tuned-8f1d2c3b-q6_k\./);
    assert.match(w.out(), /tuned-8f1d2c3b-q3_k_m, 13\.68 GB: the proof/);
    assert.match(w.out(), /Not run: Samsung Galaxy S25: no file's run fits its 12 GB of RAM\./);
    assert.match(w.out(), /--tuned acme\/muse-glimmer-30b-pirate-gguf-8f1d2c3b/);
    const zip = df.zipRead(readFileSync(path.join(w.deps.cache, "devicefarm", STAMP, `mm-devices-${STAMP}.zip`)));
    const plan = (name: string) => Buffer.from(zip.find((e) => e.path === `mm/plan/${STAMP}-01/${name}`)?.data ?? []).toString();
    assert.equal(plan("tuned-8f1d2c3b-q3_k_m.system"), "You are a pirate.\n\nReasoning strength: low.");
    assert.equal(plan("tuned-8f1d2c3b-q3_k_m.jinja"), "{{ pirate template }}");
    assert.match(plan("tuned-8f1d2c3b-q3_k_m.env"), new RegExp(`^MM_TEMPLATE_FILE=/data/local/tmp/mm/plan/${STAMP}-01/tuned-8f1d2c3b-q3_k_m\\.jinja$`, "m"));
    assert.equal(plan("tuned-8f1d2c3b-q3_k_m.url"), `https://huggingface.co/${repo}/resolve/${rev}/muse-glimmer-30b-pirate-Q3_K_M.gguf\n`);
    assert.deepEqual(w.aws.calls, []);
  });
});

describe("devicefarm.ts fetch and stop", () => {
  it("fetches a finished run with its batch record, or from its job alone", async () => {
    const w = cliWorld();
    assert.equal(await main(["run", "--smoke", "--yes", "--detach"], w.deps), 0);
    const [run] = w.aws.runs.values();
    w.aws.calls = [];
    assert.equal(await main(["fetch", run.arn], w.deps), 0, w.out());
    assert.match(w.out(), /is SCHEDULING\. Fetch it again once it is COMPLETED, or add --wait\./);
    assert.equal(await main(["fetch", run.arn, "--wait"], w.deps), 0, w.out());
    assert.equal(resultFiles(w.deps.repoRoot).length, 1);

    rmSync(path.join(w.deps.cache, "devicefarm", STAMP, "batch.json"));
    rmSync(path.join(w.deps.repoRoot, "devices"), { recursive: true });
    assert.equal(await main(["fetch", run.arn], w.deps), 0, w.out());
    assert.match(w.out(), /No batch record for .* in the cache: reading the phone from its job\./);
    const [file] = resultFiles(w.deps.repoRoot);
    assert.equal(readResult(file).device.name, "Samsung Galaxy S26");
  });

  it("stops runs by ARN, and says how when it can't", async () => {
    const w = cliWorld();
    assert.equal(await main(["run", "--smoke", "--yes", "--detach"], w.deps), 0);
    const [run] = w.aws.runs.values();
    const missing = `arn:aws:devicefarm:us-west-2:${ACCOUNT}:run:aaaaaaaa/nope`;
    assert.equal(await main(["stop", run.arn, missing], w.deps), 0);
    assert.equal(run.stopped, true);
    assert.match(w.out(), /Stopped mm 20261028T221500Z-01 Samsung Galaxy S26 \(asked\): STOPPING\./);
    assert.match(w.out(), /Couldn't stop .*nope: .*NotFoundException.* Stop it with: npx tsx scripts\/devices\/devicefarm\.ts stop/);
  });
});
