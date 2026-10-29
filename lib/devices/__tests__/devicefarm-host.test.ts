/**
 * devices/devicefarm/host.sh, the host side of a Device Farm run, under bash with fakes on PATH: adb (a folder stands
 * in for the phone: /data/local/tmp and /proc in its commands point there), curl (serves files from a fake Hub), and
 * sha256sum, timeout and df where this Mac lacks them or a test needs other numbers. The kit on the "phone" is a
 * stand-in that leaves a finished kit folder (the real kit has its own tests). Each test runs the spec's phases in
 * order, as Device Farm does, and checks what lands in $DEVICEFARM_LOG_DIR.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/devices/__tests__/devicefarm-host.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import * as df from "@/lib/devices/devicefarm";
import type { Subject } from "@/lib/devices/types";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const HOST_SH = path.join(ROOT, "devices/devicefarm/host.sh");
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, "devices/devicefarm/fixtures/list-devices-android-phones.json"), "utf8"));
const STAMP = "20261028T221500Z";
const SERIAL = "R5CX12ABCDE";
const FAKE_SECRETS = { HF_TOKEN: "hf_fakeTokenForHostTests000000000000", AWS_SECRET_ACCESS_KEY: "fakeSecretAccessKeyForHostTests00" };

const FAKES = path.join(ROOT, "devices/devicefarm/tests/fakes");

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function bytesOf(seed: number, n: number): Buffer {
  return Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) % 256));
}

function tinySubject(id: string, data: Buffer): Subject {
  return {
    id,
    kind: "base",
    repo: "acme/tiny-GGUF",
    revision: "c".repeat(40),
    path: `${id}.gguf`,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    quant: "Q4_0",
    system: "You are a helpful AI assistant.\n\nReasoning strength: low.",
    note: "A tiny stand-in.",
  };
}

interface World {
  root: string;
  key: string;
  subjects: Subject[];
  logs: string;
  phone: string;
  env: Record<string, string>;
  phase: (name: string, extra?: Record<string, string | undefined>) => { status: number | null; out: string };
  read: (rel: string) => string;
  kv: (id: string) => Record<string, string>;
}

interface WorldOptions {
  /** The phone's MemTotal in kB. */
  memKb?: number;
  /** Bytes the fake Hub serves for each subject instead of the right ones. */
  hubOverride?: Record<string, Buffer>;
  copy?: df.CopyMode;
  /** Plans in the package besides the run's own. */
  extraPlans?: number;
}

function makeWorld(options: WorldOptions = {}): World {
  const root = mkdtempSync(path.join(os.tmpdir(), "mm-df-host-"));
  roots.push(root);
  const dir = (...p: string[]) => {
    const d = path.join(root, ...p);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const exe = (file: string, text: string) => {
    writeFileSync(file, text);
    chmodSync(file, 0o755);
  };
  const bin = dir("bin");
  for (const name of ["adb", "curl", "timeout", "sha256sum", "df"]) exe(path.join(bin, name), readFileSync(path.join(FAKES, "host", name), "utf8"));
  const phonebin = dir("phonebin");
  for (const name of ["df", "stat", "svc", "pkill"]) exe(path.join(phonebin, name), readFileSync(path.join(FAKES, "phone", name), "utf8"));
  const phone = dir("phone");
  dir("phone", "data", "local", "tmp");
  writeFileSync(path.join(dir("phone", "proc"), "meminfo"), `MemTotal:       ${options.memKb ?? 11_634_000} kB\nMemFree: 100 kB\n`);

  const data = { "tiny-a": bytesOf(1, 3000), "tiny-b": bytesOf(2, 5000) };
  const subjects = [tinySubject("tiny-a", data["tiny-a"]), tinySubject("tiny-b", data["tiny-b"])];
  const hub = dir("hub");
  for (const s of subjects) writeFileSync(path.join(hub, s.path), options.hubOverride?.[s.id] ?? data[s.id as "tiny-a" | "tiny-b"]);

  const galaxy = df.namedPhones(df.androidPhones(FIXTURE).map((d) => df.phoneFor(d)), ["Samsung Galaxy S25"]);
  const batch = df.planBatch(galaxy, { stamp: STAMP, subjects, copy: options.copy ?? "auto" });
  const run = batch.runs[0];
  const pkg = dir("pkg");
  cpSync(HOST_SH, path.join(dir("pkg", "mm"), "host.sh"));
  exe(path.join(dir("pkg", "mm", "kit"), "run.sh"), readFileSync(path.join(FAKES, "kit", "run.sh"), "utf8"));
  writeFileSync(path.join(dir("pkg", "mm", "kit", "prompts"), "sum.txt"), "What is 17 + 25? Answer with the number only.");
  for (const f of ["llama-bench", "llama-completion"]) exe(path.join(dir("pkg", "mm", "llama-android"), f), "#!/bin/sh\n");
  writeFileSync(path.join(dir("pkg", "mm", "llama-android"), "libllama.so"), "lib");
  for (const f of ["llama-bench", "llama-completion"]) exe(path.join(dir("pkg", "mm", "llama-snapdragon", "bin"), f), "#!/bin/sh\n");
  writeFileSync(path.join(dir("pkg", "mm", "llama-snapdragon", "lib"), "libggml-htp-v81.so"), "lib");
  for (const f of df.planFiles(run, batch.copy)) {
    mkdirSync(path.dirname(path.join(pkg, f.path)), { recursive: true });
    writeFileSync(path.join(pkg, f.path), f.text);
  }
  for (let i = 0; i < (options.extraPlans ?? 0); i++) dir("pkg", "mm", "plan", `${STAMP}-9${i}`);
  const logs = dir("logs");
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: dir("home"),
    LANG: "C",
    FAKE_ROOT: root,
    DEVICEFARM_TEST_PACKAGE_PATH: pkg,
    DEVICEFARM_LOG_DIR: logs,
    DEVICEFARM_DEVICE_UDID: SERIAL,
    MM_PLAN: run.key,
    MM_HOST_DIR: dir("host"),
    MM_POLL_SECONDS: "1",
    MM_RETRY_SECONDS: "0",
    ...FAKE_SECRETS,
  };
  const phase = (name: string, extra: Record<string, string | undefined> = {}) => {
    const merged: Record<string, string> = { ...env };
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
    const res = spawnSync("/bin/bash", [path.join(pkg, "mm", "host.sh"), name], {
      env: merged as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: res.status, out: `${res.stdout}${res.stderr}` };
  };
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
  const kv = (id: string) => df.readKeyValues(read(`logs/mm/${id}/host-${id}.txt`));
  return { root, key: run.key, subjects, logs, phone, env, phase, read, kv };
}

/** Every file under dir, as text. */
function allText(dir: string): string {
  if (!existsSync(dir)) return "";
  let text = "";
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) text += readFileSync(path.join(entry.parentPath, entry.name), "utf8");
  }
  return text;
}

const model = (w: World, s: Subject) => path.join(w.phone, "data/local/tmp/mm/model", s.path);

describe("host.sh on a Device Farm host", () => {
  it("installs, pushes the kit and builds, copies each file, runs the kit and keeps its folder", () => {
    const w = makeWorld();
    const install = w.phase("install", { FAKE_ADB_NOISY: "1" });
    assert.equal(install.status, 0, install.out);
    const host = df.readKeyValues(w.read("logs/mm/host.txt"));
    assert.equal(host.plan, w.key);
    assert.equal(host.subjects, "tiny-a,tiny-b");
    assert.match(host.adb_version, /Android Debug Bridge/);

    const pre = w.phase("pre_test", { FAKE_ADB_NOISY: "1" });
    assert.equal(pre.status, 0, pre.out);
    const dev = path.join(w.phone, "data/local/tmp/mm");
    for (const f of ["kit/run.sh", "llama-android/llama-bench", "llama-snapdragon/bin/llama-completion", `plan/${w.key}/tiny-a.env`]) {
      assert.ok(existsSync(path.join(dev, f)), f);
    }
    assert.match(w.read("phone/svc.log"), /svc power stayon true/);

    const test = w.phase("test", { FAKE_ADB_NOISY: "1" });
    assert.equal(test.status, 0, test.out);
    for (const s of w.subjects) {
      const kv = w.kv(s.id);
      assert.equal(kv.copy, "push", s.id);
      assert.equal(kv.host_sha256, "ok");
      assert.equal(kv.kit_rc, "0");
      assert.equal(kv.kit_finished, "1");
      assert.equal(kv.mem_total_kb, "11634000");
      assert.ok(Number(kv.phone_free_kb) > 0);
      assert.match(w.read(`logs/mm/${s.id}/run.txt`), /status=done/);
      assert.equal(df.readKeyValues(w.read(`logs/mm/${s.id}/model.txt`)).bytes, String(s.bytes));
      assert.ok(!existsSync(model(w, s)), "the model is deleted from the phone after its run");
      assert.ok(existsSync(path.join(w.logs, "mm", `${s.id}.console.txt`)));
    }
    assert.deepEqual(readdirSync(path.join(w.root, "host", "mm-host")).filter((f) => f.endsWith(".part")), []);

    const post = w.phase("post_test");
    assert.equal(post.status, 0, post.out);
    assert.ok(!existsSync(dev), "post_test deletes /data/local/tmp/mm");
    assert.match(w.read("phone/svc.log"), /svc power stayon false/);
    assert.ok(!existsSync(path.join(w.root, "host", "mm-host")));
  });

  it("never writes or prints the phone's serial, a token, or a signed URL", () => {
    const w = makeWorld();
    const outs = ["install", "pre_test", "test", "post_test"].map((p) => w.phase(p, { FAKE_ADB_NOISY: "1" }).out);
    const everything = outs.join("\n") + allText(w.logs);
    assert.ok(everything.length > 0);
    assert.ok(!everything.includes(SERIAL), "the serial never shows");
    assert.match(everything, /\[device\]/, "adb's own messages are kept with the serial replaced");
    for (const v of Object.values(FAKE_SECRETS)) assert.ok(!everything.includes(v));
    const adbLines = w.read("adb.log");
    for (const v of Object.values(FAKE_SECRETS)) assert.ok(!adbLines.includes(v), "no secret goes to the phone");
    assert.ok(!/HF_TOKEN|AWS_/.test(allText(path.join(w.root, "pkg/mm/plan"))));
    assert.ok(w.read("curl.log").split("\n").filter(Boolean).every((l) => l.startsWith("hf_token=unset ")), "curl never sees HF_TOKEN");
  });

  it("streams from the Hub when the host lacks the disk, resuming after a cut", () => {
    const w = makeWorld();
    const extra = { FAKE_HOST_FREE_KB: "10", FAKE_CURL_CUT: "1000" };
    for (const p of ["install", "pre_test"]) assert.equal(w.phase(p, extra).status, 0);
    const test = w.phase("test", extra);
    assert.equal(test.status, 0, test.out);
    const a = w.kv("tiny-a");
    assert.equal(a.copy, "stream");
    assert.equal(a.host_sha256, "skipped");
    assert.equal(a.stream_attempts, "2", "the first try was cut at 1,000 bytes, the second resumed");
    assert.equal(df.readKeyValues(w.read("logs/mm/tiny-a/model.txt")).bytes, "3000");
    assert.match(w.read("curl.log"), /-C 1000/);
    assert.equal(w.kv("tiny-b").copy, "stream");
    assert.equal(w.kv("tiny-b").stream_attempts, "1");
  });

  it("follows the plan's copy mode over the host's free disk", () => {
    const w = makeWorld({ copy: "stream" });
    for (const p of ["install", "pre_test"]) assert.equal(w.phase(p).status, 0);
    assert.equal(w.phase("test").status, 0);
    assert.equal(w.kv("tiny-a").copy, "stream");
  });

  it("copies nothing to a phone with too little RAM, and lets the kit record the skip", () => {
    const w = makeWorld({ memKb: 900_000 });
    for (const p of ["install", "pre_test"]) assert.equal(w.phase(p).status, 0);
    const test = w.phase("test");
    assert.equal(test.status, 0, test.out);
    const kv = w.kv("tiny-a");
    assert.equal(kv.copy, "ram_skip");
    assert.equal(kv.mem_total_kb, "900000");
    assert.equal(kv.min_ram_kb, String(Math.ceil((3000 + 1_200_000_000) / 1024)));
    assert.match(w.read("logs/mm/tiny-a/run.txt"), /status=skipped\nwhy=ram/);
    assert.ok(!existsSync(path.join(w.root, "curl.log")), "nothing was downloaded");
  });

  it("skips a file the phone has no room for, and says how much room there was", () => {
    const w = makeWorld();
    for (const p of ["install", "pre_test"]) assert.equal(w.phase(p).status, 0);
    const test = w.phase("test", { FAKE_PHONE_FREE_KB: "1000" });
    assert.equal(test.status, 1, "a subject that couldn't run fails the test phase");
    const kv = w.kv("tiny-a");
    assert.equal(kv.copy, "no_space");
    assert.equal(kv.phone_free_kb, "1000");
    assert.equal(kv.kit_rc, undefined, "the kit didn't run");
    assert.ok(!existsSync(path.join(w.logs, "mm/tiny-a/run.txt")));
    assert.match(df.notTestedReason(kv), /had 0\.0 GB free/);
  });

  it("refuses a download whose sha256 is wrong before it reaches the phone, and goes on to the next file", () => {
    const w = makeWorld({ hubOverride: { "tiny-a": bytesOf(9, 3000) } });
    for (const p of ["install", "pre_test"]) assert.equal(w.phase(p).status, 0);
    const test = w.phase("test");
    assert.equal(test.status, 1);
    const a = w.kv("tiny-a");
    assert.equal(a.copy, "failed");
    assert.equal(a.copy_why, "sha256");
    assert.equal(a.host_sha256, "mismatch");
    assert.ok(!existsSync(model(w, w.subjects[0])) && !existsSync(`${model(w, w.subjects[0])}.part`));
    const pushes = w.read("adb.log").split("\n").filter((l) => l.startsWith("push "));
    assert.ok(!pushes.some((l) => l.includes("tiny-a.gguf")), "nothing was pushed");
    assert.ok(pushes.some((l) => l.includes("tiny-b.gguf")));
    assert.equal(w.kv("tiny-b").copy, "push");
    assert.match(w.read("logs/mm/tiny-b/run.txt"), /status=done/);
  });

  it("records a failed download without the signed URL curl printed", () => {
    const w = makeWorld();
    for (const p of ["install", "pre_test"]) assert.equal(w.phase(p).status, 0);
    const test = w.phase("test", { FAKE_CURL_FAIL: "1" });
    assert.equal(test.status, 1);
    assert.equal(w.kv("tiny-a").copy, "failed");
    assert.equal(w.kv("tiny-a").copy_why, "download");
    assert.equal(w.kv("tiny-a").download_rc, "22");
    const log = w.read("logs/mm/host.log");
    assert.match(log, /curl: \(22\) The requested URL returned error: 404 for \[url\]/);
    assert.ok(!test.out.includes("X-Amz-Signature") && !log.includes("X-Amz-Signature"));
  });

  it("waits for the kit's run.txt when the adb session drops while the kit runs", () => {
    const w = makeWorld();
    for (const p of ["install", "pre_test"]) assert.equal(w.phase(p).status, 0);
    const test = w.phase("test", { FAKE_ADB_DROP: "1", FAKE_KIT_SLEEP: "2" });
    assert.equal(test.status, 0, test.out);
    const kv = w.kv("tiny-a");
    assert.equal(kv.adb_dropped, "1");
    assert.equal(kv.kit_rc, "-");
    assert.equal(kv.kit_finished, "1");
    assert.match(w.read("logs/mm/tiny-a/run.txt"), /status=done/);
    assert.match(df.hostNotes(kv).join(" "), /adb session dropped/);
  });

  it("uses the package's one plan when MM_PLAN doesn't reach the host, and refuses to guess between several", () => {
    const w = makeWorld();
    const one = w.phase("install", { MM_PLAN: undefined });
    assert.equal(one.status, 0, one.out);
    assert.match(one.out, new RegExp(`using the package's one plan, ${w.key}`));
    const many = makeWorld({ extraPlans: 1 });
    const res = many.phase("install", { MM_PLAN: undefined });
    assert.equal(res.status, 1);
    assert.match(res.out, /doesn't have exactly one plan/);
  });

  it("cleans the phone in post_test even when the plan can't be read", () => {
    const w = makeWorld();
    assert.equal(w.phase("pre_test").status, 0);
    const post = w.phase("post_test", { MM_PLAN: "nope" });
    assert.equal(post.status, 0, post.out);
    assert.match(post.out, /no mm\/plan\/nope\/run\.env; cleaning up anyway/);
    assert.ok(!existsSync(path.join(w.phone, "data/local/tmp/mm")));
  });

  it("pulls in post_test what a stopped test left on the phone", () => {
    const w = makeWorld();
    assert.equal(w.phase("pre_test").status, 0);
    const left = path.join(w.phone, "data/local/tmp/mm/out/tiny-a");
    mkdirSync(left, { recursive: true });
    writeFileSync(path.join(left, "run.txt"), "kit=1\nsubject=tiny-a\n");
    assert.equal(w.phase("post_test").status, 0);
    assert.equal(w.read("logs/mm/tiny-a/run.txt"), "kit=1\nsubject=tiny-a\n");
    assert.equal(w.kv("tiny-a").pulled_in, "post_test");
  });

  it("refuses an unknown phase, and a run without the Device Farm variables", () => {
    const w = makeWorld();
    assert.equal(w.phase("deploy").status, 2);
    const res = w.phase("install", { DEVICEFARM_DEVICE_UDID: undefined });
    assert.equal(res.status, 1);
    assert.match(res.out, /DEVICEFARM_DEVICE_UDID isn't set/);
  });
});
