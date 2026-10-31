import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { LabError } from "../lib/errors.mjs";
import { executeJob, labErrorBody, pruneCache, resultBody } from "../lib/execute.mjs";
import { makeJob, memoryLogger, SELFTEST_TOKEN, TOKEN } from "./helpers.mjs";

const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function setup({ runner, api: apiOverrides = {}, heartbeat } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "mm-exec-"));
  roots.push(root);
  const config = { ...loadConfig({ env: { MUSE_LAB_ROOT: root }, platform: "darwin" }), heartbeatSeconds: 0.01 };
  const finishes = [];
  const uploadRequests = [];
  const uploaded = [];
  const beats = [];
  const log = memoryLogger();
  const api = {
    heartbeat: async (id, token, body) => {
      beats.push({ id, token, body });
      return heartbeat ? heartbeat(beats.length) : { cancel: false };
    },
    requestUploads: async (id, token, files) => {
      uploadRequests.push({ id, token, files });
      return files.map((file) => ({ name: file.name, method: "put", pathname: `p/${file.name}`, url: `https://upload.test/${file.name}` }));
    },
    finish: async (id, token, body) => {
      finishes.push({ id, token, body });
      return true;
    },
    ...apiOverrides,
  };
  const doFetch = async (url, init) => {
    uploaded.push({ url, bytes: init.body.length, text: init.body.toString() });
    return new Response(JSON.stringify({ url, pathname: new URL(url).pathname.slice(1) }));
  };
  const deps = {
    config,
    api,
    log,
    fetch: doFetch,
    exec: async (argv) => ({ code: 0, stdout: argv.includes("-filters") ? "drawtext" : "", stderr: "" }),
    runners: { desktop_mac: runner ?? goodRunner, ios_sim: runner ?? goodRunner, android_emu: runner ?? goodRunner, glasses_sim: runner ?? goodRunner },
  };
  return { deps, finishes, uploadRequests, uploaded, beats, log, config };
}

const evaluationPass = { passed: true, informational: false, checks: [{ id: "launched", ok: true, detail: "x" }], reasons: [], warnings: [] };

async function goodRunner(ctx) {
  const shot = path.join(ctx.dir, "shot-1.jpg");
  writeFileSync(shot, "jpeg-bytes");
  return {
    evaluation: evaluationPass,
    device: { name: "Pixel 7", os: "15" },
    files: [{ path: shot, name: "shot-1.jpg", role: "shot" }],
    warnings: [],
    captionBurned: true,
    facts: { report: { loadMs: 2100 } },
  };
}

describe("executeJob", () => {
  test("a passing job uploads, reports and cleans up", async () => {
    const h = setup();
    const result = await executeJob(makeJob("android_emu"), h.deps);
    assert.deepEqual(result, { jobId: "job_1", outcome: "passed", finished: true });

    const { id, token, body } = h.finishes[0];
    assert.equal(id, "job_1");
    assert.equal(token, TOKEN);
    assert.equal(body.outcome, "passed");
    assert.equal(body.summary, "Checked on an Android emulator (Pixel 7, Android 15): opened in 2.1 s.");
    assert.equal(body.loadMs, 2100);
    assert.equal(body.error, null);
    assert.deepEqual(body.artifacts.map((a) => a.role).sort(), ["log", "report", "shot"]);
    const shot = body.artifacts.find((a) => a.role === "shot");
    assert.equal(shot.bytes, 10);
    assert.match(shot.sha256, /^[a-f0-9]{64}$/);
    assert.equal(shot.contentType, "image/jpeg");

    assert.equal(h.uploadRequests[0].token, TOKEN);
    assert.ok(h.beats.length >= 1);
    assert.equal(h.beats[0].token, TOKEN);
    assert.ok(!existsSync(path.join(h.config.dataDir, "jobs", "job_1")), "the job's folder is gone");
  });

  test("a failing check is a result, not a lab error", async () => {
    const h = setup({
      runner: async () => ({
        evaluation: { ...evaluationPass, passed: false, reasons: ["The screen stayed blank."] },
        device: {},
        files: [],
        warnings: ["w"],
        facts: {},
      }),
    });
    const result = await executeJob(makeJob("android_emu"), h.deps);
    assert.equal(result.outcome, "failed");
    const { body } = h.finishes[0];
    assert.equal(body.outcome, "failed");
    assert.match(body.summary, /Didn't pass.*blank/);
    assert.deepEqual(body.warnings, ["w"]);
  });

  test("an invalid job finishes with invalid_input and runs nothing", async () => {
    let ran = false;
    const h = setup({ runner: async () => ((ran = true), {}) });
    const result = await executeJob(makeJob("android_emu", { input: { limitSeconds: 1 } }), h.deps);
    assert.equal(ran, false);
    assert.equal(result.outcome, "lab_error");
    assert.equal(h.finishes[0].body.error.code, "invalid_input");
  });

  test("a job for the wrong lane is refused", async () => {
    const h = setup();
    await executeJob(makeJob("desktop_windows"), h.deps);
    assert.equal(h.finishes[0].body.error.code, "invalid_input");
  });

  test("a job with no id or token can't be answered", async () => {
    const h = setup();
    const result = await executeJob({ kind: "ios_sim" }, h.deps);
    assert.deepEqual(result, { jobId: null, outcome: "lab_error", finished: false });
    assert.equal(h.finishes.length, 0);
  });

  test("a lab error keeps its code and uploads the log", async () => {
    const h = setup({
      runner: async (ctx) => {
        ctx.logLine("something the owner should read");
        throw new LabError("simulator_failed", "The iPhone simulator didn't start.");
      },
    });
    const result = await executeJob(makeJob("ios_sim"), h.deps);
    assert.equal(result.outcome, "lab_error");
    const { body } = h.finishes[0];
    assert.deepEqual(body.error, { code: "simulator_failed", message: "The iPhone simulator didn't start." });
    assert.match(body.summary, /Not checked on an iPhone simulator/);
    assert.deepEqual(body.artifacts.map((a) => a.role), ["log"]);
    assert.match(h.uploaded[0].text, /something the owner should read/);
  });

  test("an unexpected error doesn't leak its message", async () => {
    const h = setup({
      runner: async () => {
        throw new Error("secret internals at /Users/x");
      },
    });
    await executeJob(makeJob("ios_sim"), h.deps);
    assert.equal(h.finishes[0].body.error.code, "internal");
    assert.ok(!JSON.stringify(h.finishes[0].body).includes("secret internals"));
  });

  test("the platform's cancel stops the runner, and nothing is uploaded", async () => {
    const h = setup({
      heartbeat: () => ({ cancel: true }),
      runner: async (ctx) => {
        while (!ctx.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
        ctx.throwIfAborted();
      },
    });
    const result = await executeJob(makeJob("android_emu"), h.deps);
    assert.equal(result.outcome, "lab_error");
    assert.equal(h.finishes[0].body.error.code, "canceled");
    assert.equal(h.uploadRequests.length, 0);
  });

  test("the time limit stops the runner", async () => {
    const h = setup({
      runner: async (ctx) => {
        await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
        ctx.throwIfAborted();
      },
    });
    const job = makeJob("android_emu", { input: { limitSeconds: 30 } });
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms === 30_000 ? 5 : ms, ...rest);
    try {
      await executeJob(job, h.deps);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.equal(h.finishes[0].body.error.code, "timeout");
  });

  test("the agent stopping ends the job as restarted", async () => {
    const stop = new AbortController();
    const h = setup({
      runner: async (ctx) => {
        stop.abort();
        ctx.throwIfAborted();
      },
    });
    await executeJob(makeJob("android_emu"), { ...h.deps, stopSignal: stop.signal });
    assert.equal(h.finishes[0].body.error.code, "agent_restarted");
  });

  test("no ffmpeg is a tool problem", async () => {
    const h = setup();
    h.deps.exec = async () => ({ code: 127, stdout: "", stderr: "" });
    await executeJob(makeJob("android_emu"), h.deps);
    assert.equal(h.finishes[0].body.error.code, "tool_missing");
  });

  test("a failed upload loses the file, not the check", async () => {
    const h = setup();
    h.deps.fetch = async () => new Response("no", { status: 403 });
    const result = await executeJob(makeJob("android_emu"), h.deps);
    assert.equal(result.outcome, "passed");
    assert.equal(h.finishes[0].body.artifacts.length, 0);
    assert.ok(h.finishes[0].body.warnings.some((w) => /shot-1\.jpg didn't upload/.test(w)));
  });

  test("no upload slots loses the files, not the check", async () => {
    const h = setup({
      api: {
        requestUploads: async () => {
          throw new Error("500");
        },
      },
    });
    const result = await executeJob(makeJob("android_emu"), h.deps);
    assert.equal(result.outcome, "passed");
    assert.ok(h.finishes[0].body.warnings[0].includes("couldn't upload"));
  });

  test("tokens never reach logs or uploaded files", async () => {
    const h = setup({
      runner: async (ctx) => {
        ctx.logLine(`launch with -museToken ${SELFTEST_TOKEN} and job ${TOKEN}`);
        ctx.log.info(`job token ${TOKEN}`);
        return {
          evaluation: evaluationPass,
          device: {},
          files: [],
          facts: { note: `selftest ${SELFTEST_TOKEN}` },
        };
      },
    });
    await executeJob(makeJob("android_emu"), h.deps);
    for (const text of [...h.log.lines, ...h.uploaded.map((u) => u.text)]) {
      assert.ok(!text.includes(TOKEN), text);
      assert.ok(!text.includes(SELFTEST_TOKEN), text);
    }
  });

  test("a recorder left running is killed", async () => {
    let killed = false;
    const h = setup({
      runner: async (ctx) => {
        ctx.startProc(["recorder"]);
        throw new LabError("internal", "x");
      },
    });
    h.deps.startProc = () => ({ exited: false, kill: () => (killed = true) });
    await executeJob(makeJob("android_emu"), h.deps);
    assert.equal(killed, true);
  });

  test("a detached emulator is left alone", async () => {
    let killed = false;
    const h = setup({
      runner: async (ctx) => {
        ctx.startProc(["emulator"], { detach: true });
        throw new LabError("internal", "x");
      },
    });
    h.deps.startProc = () => ({ exited: false, kill: () => (killed = true) });
    await executeJob(makeJob("android_emu"), h.deps);
    assert.equal(killed, false);
  });
});

describe("the finish bodies", () => {
  const config = { version: "1.2.3" };
  test("resultBody marks the glasses check informational", () => {
    const body = resultBody({
      job: { kind: "glasses_sim", attempt: 2 },
      config,
      result: { evaluation: { passed: false, informational: true, checks: [], reasons: ["r"], warnings: [], loadMs: 900 }, device: {}, facts: {} },
      artifacts: [],
      warnings: [],
      durationMs: 5,
    });
    assert.equal(body.informational, true);
    assert.equal(body.outcome, "failed");
    assert.equal(body.loadMs, 900);
    assert.equal(body.attempt, 2);
    assert.equal(body.agentVersion, "1.2.3");
  });
  test("labErrorBody", () => {
    const body = labErrorBody({ job: { kind: "ios_sim" }, config, code: "timeout", message: "m", durationMs: 1 });
    assert.equal(body.outcome, "lab_error");
    assert.deepEqual(body.error, { code: "timeout", message: "m" });
    assert.equal(body.attempt, 1);
  });
});

describe("pruneCache", () => {
  test("removes the oldest first, down to the limit", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-cache-"));
    roots.push(dir);
    for (const [i, name] of ["old", "mid", "new"].entries()) {
      const file = path.join(dir, name);
      writeFileSync(file, "x".repeat(100));
      utimesSync(file, 1000 + i, 1000 + i);
    }
    await pruneCache(dir, 150);
    assert.deepEqual(["old", "mid", "new"].map((n) => existsSync(path.join(dir, n))), [false, false, true]);
    assert.equal(readFileSync(path.join(dir, "new"), "utf8").length, 100);
  });
  test("a missing folder is fine", async () => {
    await pruneCache("/nonexistent/mm-cache");
  });
});
