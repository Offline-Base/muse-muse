// gguf_emu against a scripted adb and a fake llama-server, and the Hub download against a fake fetch. No emulator, no model
// and no network: these check the order of commands, the numbers that come out and what gets refused.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fitProblem, freeKbOf, kbOf, readCompletion, runGgufEmu } from "../jobs/gguf_emu.mjs";
import { downloadHubFile, isHubHost } from "../lib/hub-download.mjs";
import { resultBody } from "../lib/execute.mjs";
import { validateJob } from "../lib/validate.mjs";
import { TOKEN } from "./helpers.mjs";

const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const tempRoot = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mm-gguf-"));
  roots.push(dir);
  return dir;
};

const GGUF = { repo: "someone/muse-glimmer-gguf-abc", commit: "b".repeat(40), name: "small-Q3_K_M.gguf", sha256: "c".repeat(64), bytes: 1024 ** 3 };
const job = (input = {}) => ({
  id: "job_1",
  kind: "gguf_emu",
  token: TOKEN,
  attempt: 1,
  runId: "run_1",
  input: { v: 1, limitSeconds: 900, adapterJobId: "a", gguf: GGUF, prompts: [{ id: "one", text: "Hi" }, { id: "two", text: "Hello" }], systemLine: "You are helpful.", maxTokens: 64, ...input },
});
const checked = (input) => validateJob(job(input), { lane: "mac" });

describe("gguf_emu input", () => {
  test("a good job passes, with no app or target", () => {
    const out = checked();
    assert.equal(out.ok, true, out.error);
    assert.equal(out.job.input.maxTokens, 64);
    assert.equal(out.job.input.target, undefined);
  });
  for (const [what, input] of [
    ["a repo with a path in it", { gguf: { ...GGUF, repo: "a/b/../c" } }],
    ["a commit that is a branch", { gguf: { ...GGUF, commit: "main" } }],
    ["a name that leaves the folder", { gguf: { ...GGUF, name: "../x.gguf" } }],
    ["a name that isn't a GGUF", { gguf: { ...GGUF, name: "x.sh" } }],
    ["no checksum", { gguf: { ...GGUF, sha256: undefined } }],
    ["no prompts", { prompts: [] }],
    ["a limit over the queue's", { limitSeconds: 901 }],
  ]) {
    test(`refuses ${what}`, () => assert.equal(checked(input).ok, false));
  }
  test("won't run on the Windows lane", () => assert.equal(validateJob(job(), { lane: "windows" }).ok, false));
});

describe("readings", () => {
  test("memory and disk", () => {
    assert.equal(kbOf("Name: x\nVmHWM:\t  1234 kB\n", "VmHWM"), 1234);
    assert.equal(kbOf("Name: x\n", "VmHWM"), null);
    assert.equal(freeKbOf("Filesystem 1K-blocks Used Available Use% Mounted\n/dev/x 8000 1000 7000 13% /data\n"), 7000);
  });
  test("a file bigger than RAM or the disk is refused, in numbers", () => {
    assert.match(fitProblem({ fileBytes: 14 * 1024 ** 3, memTotalKb: 4 * 1024 ** 2, diskFreeKb: 100 * 1024 ** 2 }), /memory/);
    assert.match(fitProblem({ fileBytes: 2 * 1024 ** 3, memTotalKb: 8 * 1024 ** 2, diskFreeKb: 2 * 1024 ** 2 }), /disk/);
    assert.equal(fitProblem({ fileBytes: 1024 ** 3, memTotalKb: 4 * 1024 ** 2, diskFreeKb: 6 * 1024 ** 2 }), null);
  });
  test("a completion without timings is counted by hand", () => {
    const out = readCompletion({ choices: [{ message: { content: " Hi " }, finish_reason: "stop" }], usage: { completion_tokens: 10 } }, 2000);
    assert.deepEqual([out.answer, out.tokens, out.tokensPerSecond], ["Hi", 10, 5]);
  });
  test("thinking with no final answer reads as no answer", () => {
    assert.equal(readCompletion({ choices: [{ message: { content: null, reasoning_content: "hmm" } }], timings: { predicted_n: 5, predicted_ms: 100, predicted_per_second: 50 } }, 100).answer, "");
  });
});

/** A context like lib/execute.mjs makes, with a scripted adb and a fake llama-server. */
function makeCtx({ meminfo = 4 * 1024 ** 2, freeKb = 7 * 1024 ** 2, chat, health = () => 200, serverExited = false, limitSeconds = 900 } = {}) {
  const root = tempRoot();
  const binary = path.join(root, "llama-server");
  writeFileSync(binary, "bin");
  const result = validateJob(job({ limitSeconds }), { lane: "mac" });
  assert.equal(result.ok, true);
  let clock = 1_000_000;
  const commands = [];
  const started = [];
  const requests = [];
  const reply = (over = {}) => ({ code: 0, stdout: "", stderr: "", ...over });
  const ctx = {
    job: result.job,
    input: result.job.input,
    config: { dataDir: root, android: { avd: "mm_pixel", deviceLabel: "Pixel 7", llamaServer: binary } },
    dir: root,
    signal: new AbortController().signal,
    logLine() {},
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    setPhase() {},
    throwIfAborted() {},
    redact: (t) => t,
    downloadHub: async () => "/cache/model",
    exec: async (argv) => {
      const text = argv.join(" ");
      commands.push(text);
      if (text.endsWith("devices")) return reply({ stdout: "List\nemulator-5554\tdevice\n" });
      if (text.includes("sys.boot_completed")) return reply({ stdout: "1\n" });
      if (text.includes("ro.build.version.release")) return reply({ stdout: "15\n" });
      if (text.includes("/proc/meminfo")) return reply({ stdout: `MemTotal:  ${meminfo} kB\n` });
      if (text.includes("df -k")) return reply({ stdout: `F B U A P M\n/dev/x 8000 1000 ${freeKb} 13% /data\n` });
      if (text.includes("/status")) return reply({ stdout: "VmHWM:\t 2000000 kB\nVmRSS:\t 1500000 kB\n" });
      return reply();
    },
    startProc: (argv) => {
      started.push(argv.join(" "));
      return { exited: serverExited, kill() {} };
    },
    fetch: async (url, init) => {
      if (String(url).endsWith("/health")) return new Response("", { status: health() });
      const body = JSON.parse(init.body);
      requests.push(body);
      clock += 1000;
      return chat ? chat(body) : Response.json({ choices: [{ message: { content: `Answer to ${body.messages.at(-1).content}` } }], timings: { predicted_n: 20, predicted_ms: 4000, predicted_per_second: 5 } });
    },
  };
  return { ctx, commands, started, requests };
}

describe("runGgufEmu", () => {
  test("loads, asks every prompt under the system line, measures, and takes everything off the emulator", async () => {
    const h = makeCtx();
    const out = await runGgufEmu(h.ctx);
    assert.equal(out.evaluation.passed, true);
    assert.equal(out.simTune.runs.length, 2);
    assert.equal(out.simTune.runs[0].answer, "Answer to Hi");
    assert.equal(out.simTune.runs[0].tokensPerSecond, 5);
    assert.equal(out.simTune.memory.peakKb, 2000000);
    assert.equal(out.simTune.memory.totalKb, 4 * 1024 ** 2);
    assert.equal(h.requests[0].messages[0].content, "You are helpful.");
    assert.equal(h.requests[0].max_tokens, 64);
    assert.match(h.started[0], /llama-server -m model\.gguf .*--host 127\.0\.0\.1/);
    assert.ok(h.commands.at(-1).includes("rm -rf /data/local/tmp/mm-sim"));
    const pushIndex = h.commands.findIndex((c) => c.includes("/cache/model"));
    assert.ok(pushIndex > 0);
    const body = resultBody({ job: h.ctx.job, config: { version: "1" }, result: out, artifacts: [], warnings: [], durationMs: 1 });
    assert.equal(body.simTune.runs.length, 2);
    assert.match(body.summary, /Android emulator \(Pixel 7, Android 15\): the model loaded in/);
  });
  test("a file too big for the emulator fails plainly and is never copied", async () => {
    const h = makeCtx({ meminfo: 1024 });
    const out = await runGgufEmu(h.ctx);
    assert.equal(out.evaluation.passed, false);
    assert.match(out.evaluation.reasons[0], /memory/);
    assert.ok(!h.commands.some((c) => c.includes("/cache/model")));
    assert.equal(h.started.length, 0);
  });
  test("a server that dies while loading fails, and still cleans up", async () => {
    const h = makeCtx({ serverExited: true });
    const out = await runGgufEmu(h.ctx);
    assert.match(out.evaluation.reasons[0], /didn't load/);
    assert.ok(h.commands.at(-1).includes("rm -rf"));
  });
  test("an empty final answer doesn't pass, and its numbers are kept", async () => {
    const h = makeCtx({ chat: () => Response.json({ choices: [{ message: { content: "" } }], timings: { predicted_n: 9, predicted_ms: 900, predicted_per_second: 10 } }) });
    const out = await runGgufEmu(h.ctx);
    assert.equal(out.evaluation.passed, false);
    assert.equal(out.simTune.runs[1].tokensPerSecond, 10);
  });
  test("a job out of time stops sending prompts and says so", async () => {
    const h = makeCtx({ limitSeconds: 61 });
    const out = await runGgufEmu(h.ctx);
    assert.equal(out.simTune.stoppedEarly, true);
    assert.equal(out.evaluation.passed, false);
  });
  test("no llama-server is the box's problem, not the model's", async () => {
    const h = makeCtx();
    h.ctx.config.android.llamaServer = "/nowhere/llama-server";
    await assert.rejects(runGgufEmu(h.ctx), (err) => err.code === "tool_missing");
  });
});

describe("downloadHubFile", () => {
  const content = Buffer.from("gguf bytes");
  const spec = { repo: "a/b", commit: "b".repeat(40), name: "x.gguf", sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length };
  const dirs = () => {
    const root = tempRoot();
    mkdirSync(path.join(root, "cache"));
    return { cacheDir: path.join(root, "cache"), tempDir: path.join(root, "tmp") };
  };
  test("only the Hub's hosts count", () => {
    assert.ok(isHubHost("cas-bridge.xethub.hf.co"));
    assert.ok(isHubHost("huggingface.co"));
    assert.ok(!isHubHost("evilhf.co"));
    assert.ok(!isHubHost("huggingface.co.evil.com"));
  });
  test("follows a Hub redirect, sends no token, checks, caches by checksum", async () => {
    const d = dirs();
    const seen = [];
    const doFetch = async (url, init) => {
      seen.push([url, init.headers]);
      if (url.startsWith("https://huggingface.co/")) return new Response(null, { status: 302, headers: { location: "https://cdn.hf.co/file" } });
      return new Response(content);
    };
    const file = await downloadHubFile(spec, { ...d, fetch: doFetch });
    assert.equal(readFileSync(file, "utf8"), "gguf bytes");
    assert.equal(seen[0][0], `https://huggingface.co/a/b/resolve/${spec.commit}/x.gguf`);
    assert.ok(seen.every(([, headers]) => headers === undefined));
    assert.equal(await downloadHubFile(spec, { ...d, fetch: () => assert.fail("cached") }), file);
  });
  test("a redirect off the Hub is refused before it is fetched", async () => {
    const seen = [];
    const doFetch = async (url) => {
      seen.push(url);
      return new Response(null, { status: 302, headers: { location: "https://evil.example/x" } });
    };
    await assert.rejects(downloadHubFile(spec, { ...dirs(), fetch: doFetch }), (err) => err.code === "download_failed");
    assert.equal(seen.length, 1);
  });
  test("a wrong checksum or size leaves nothing behind", async () => {
    const d = dirs();
    await assert.rejects(downloadHubFile({ ...spec, sha256: "d".repeat(64) }, { ...d, fetch: async () => new Response(content) }), (err) => err.code === "checksum_mismatch");
    await assert.rejects(downloadHubFile({ ...spec, bytes: 3 }, { ...d, fetch: async () => new Response(content) }), (err) => err.code === "download_failed");
    assert.ok(!existsSync(path.join(d.cacheDir, spec.sha256)));
  });
});
