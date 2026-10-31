// The small modules: logging, the token, the API client, config and downloads.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { ApiError, createApi } from "../lib/api.mjs";
import { DEFAULT_PLATFORM, loadConfig } from "../lib/config.mjs";
import { downloadFile } from "../lib/download.mjs";
import { LabError, LAB_ERROR_CODES, RETRYABLE_CODES } from "../lib/errors.mjs";
import { createLogger, redactText } from "../lib/log.mjs";
import { readLabToken, ssmCliArgs, tokenParameterName } from "../lib/token.mjs";

describe("redaction", () => {
  test("hides named secrets and token shapes", () => {
    assert.equal(redactText("a my-secret b", ["my-secret"]), "a [hidden] b");
    assert.equal(redactText("authorization: Bearer abc.def"), "authorization: Bearer [hidden]");
    assert.equal(redactText("x?vercel-blob-delegation=abc&vercel-blob-signature=def"), "x?vercel-blob-delegation=[hidden]&vercel-blob-signature=[hidden]");
    assert.equal(redactText("musemuse-lab://check?url=a&token=abc123&platform=b"), "musemuse-lab://check?url=a&token=[hidden]&platform=b");
    assert.equal(redactText('"-museToken","abc123"'), '"-museToken","[hidden]"');
  });
  test("the logger keeps secrets out of its lines", () => {
    const lines = [];
    const log = createLogger({ write: (line) => lines.push(line), now: () => new Date(0) });
    log.addSecret("sekret-value");
    log.info("hello sekret-value", { token: "sekret-value" });
    assert.ok(!lines[0].includes("sekret-value"));
    assert.equal(JSON.parse(lines[0]).level, "info");
    log.removeSecret("sekret-value");
    log.info("sekret-value");
    assert.ok(lines[1].includes("sekret-value"));
  });
});

describe("errors", () => {
  test("an unknown code becomes internal", () => assert.equal(new LabError("nope", "m").code, "internal"));
  test("retryable codes are real codes", () => {
    for (const code of RETRYABLE_CODES) assert.ok(LAB_ERROR_CODES.includes(code));
    assert.ok(!RETRYABLE_CODES.includes("invalid_input"));
    assert.ok(!RETRYABLE_CODES.includes("canceled"));
  });
});

describe("the lab token", () => {
  const importNone = () => Promise.reject(new Error("no sdk"));
  test("the parameter name is per lane", () => {
    assert.equal(tokenParameterName("mac"), "/musemuse/lab/mac/token");
  });
  test("the CLI asks for the decrypted value only", () => {
    const argv = ssmCliArgs("/musemuse/lab/mac/token", "us-east-1");
    assert.ok(argv.includes("--with-decryption"));
    assert.equal(argv[argv.indexOf("--query") + 1], "Parameter.Value");
    assert.equal(argv[argv.indexOf("--region") + 1], "us-east-1");
  });
  test("uses the SDK when it's installed", async () => {
    class GetParameterCommand {
      constructor(input) {
        this.input = input;
      }
    }
    class SSMClient {
      async send(command) {
        assert.equal(command.input.Name, "/musemuse/lab/windows/token");
        assert.equal(command.input.WithDecryption, true);
        return { Parameter: { Value: " sdk-token\n" } };
      }
    }
    const token = await readLabToken({ lane: "windows", env: {}, importSdk: async () => ({ SSMClient, GetParameterCommand }), exec: () => assert.fail("no CLI") });
    assert.equal(token, "sdk-token");
  });
  test("falls back to the CLI", async () => {
    const token = await readLabToken({ lane: "mac", env: {}, importSdk: importNone, exec: async () => ({ code: 0, stdout: "cli-token\n" }) });
    assert.equal(token, "cli-token");
  });
  test("an error never quotes the tool's stdout", async () => {
    await assert.rejects(
      readLabToken({ lane: "mac", env: {}, importSdk: importNone, exec: async () => ({ code: 3, stdout: "leaky-value" }) }),
      (err) => !err.message.includes("leaky-value") && /exited with 3/.test(err.message),
    );
  });
  test("a local run can use a file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-token-"));
    writeFileSync(path.join(dir, "t"), "file-token\n");
    assert.equal(await readLabToken({ lane: "mac", env: { MUSE_LAB_TOKEN_FILE: path.join(dir, "t") } }), "file-token");
    rmSync(dir, { recursive: true, force: true });
  });
});

function fakeFetch(replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status ?? 200, headers: reply.headers });
  };
  return Object.assign(fn, { calls });
}

describe("the API client", () => {
  const make = (replies, extra = {}) => {
    const doFetch = fakeFetch(replies);
    return { doFetch, api: createApi({ platform: "https://p.app/", getLabToken: async () => "lab", fetch: doFetch, ...extra }) };
  };
  test("claim sends the lab token, and 204 means nothing to do", async () => {
    const { api, doFetch } = make([{ status: 204 }]);
    assert.equal(await api.claim({ lane: "mac", kinds: [], waitSeconds: 0 }), null);
    assert.equal(doFetch.calls[0].url, "https://p.app/api/native/agent/claim");
    assert.equal(doFetch.calls[0].headers.authorization, "Bearer lab");
    assert.equal(doFetch.calls[0].redirect, "error");
  });
  test("claim returns the job", async () => {
    const { api } = make([{ body: { job: { id: "j" } } }]);
    assert.deepEqual(await api.claim({}), { id: "j" });
  });
  test("a 401 reads the token again once", async () => {
    const { api, doFetch } = make([{ status: 401 }, { status: 204 }], { refreshLabToken: async () => "new" });
    assert.equal(await api.claim({}), null);
    assert.equal(doFetch.calls[1].headers.authorization, "Bearer new");
  });
  test("a 429 carries its retry time", async () => {
    const { api } = make([{ status: 429, headers: { "retry-after": "30" }, body: { error: "rate_limited" } }]);
    await assert.rejects(api.claim({}), (err) => err instanceof ApiError && err.retryAfterMs === 30_000 && err.code === "rate_limited");
  });
  test("heartbeat: a job the platform no longer knows counts as canceled", async () => {
    for (const status of [401, 404, 410]) {
      const { api } = make([{ status }]);
      assert.deepEqual(await api.heartbeat("j", "t", {}), { cancel: true });
    }
    const { api, doFetch } = make([{ body: { cancel: false } }]);
    assert.deepEqual(await api.heartbeat("j/1", "t", {}), { cancel: false });
    assert.equal(doFetch.calls[0].url, "https://p.app/api/native/agent/jobs/j%2F1/heartbeat");
    assert.equal(doFetch.calls[0].headers.authorization, "Bearer t");
  });
  test("heartbeat: trouble on the platform isn't a cancel", async () => {
    const { api } = make([{ status: 500 }]);
    await assert.rejects(api.heartbeat("j", "t", {}));
  });
  test("finish retries until it lands", async () => {
    const { api, doFetch } = make([{ status: 500 }, new Error("network"), { body: {} }]);
    assert.equal(await api.finish("j", "t", { outcome: "passed" }, { wait: async () => {} }), true);
    assert.equal(doFetch.calls.length, 3);
  });
  test("finish stops when the job's gone", async () => {
    const { api } = make([{ status: 409 }]);
    assert.equal(await api.finish("j", "t", {}, { wait: async () => {} }), false);
  });
  test("finish gives up in the end", async () => {
    const { api } = make([{ status: 500 }, { status: 500 }]);
    await assert.rejects(api.finish("j", "t", {}, { wait: async () => {}, attempts: 2 }));
  });
  test("fetchSelftest gives the report, or null for anything else", async () => {
    const { api, doFetch } = make([{ body: { report: { finalUrl: "https://a.b" } } }, { status: 404 }, { body: { report: null } }]);
    assert.deepEqual(await api.fetchSelftest("j", "t"), { finalUrl: "https://a.b" });
    assert.equal(doFetch.calls[0].url, "https://p.app/api/native/agent/jobs/j/selftest");
    assert.equal(doFetch.calls[0].headers.authorization, "Bearer t");
    assert.equal(await api.fetchSelftest("j", "t"), null);
    assert.equal(await api.fetchSelftest("j", "t"), null);
  });
  test("requestUploads returns the slots", async () => {
    const { api } = make([{ body: { uploads: [{ name: "a" }] } }]);
    assert.deepEqual(await api.requestUploads("j", "t", [{ name: "a" }]), [{ name: "a" }]);
  });
});

describe("loadConfig", () => {
  test("defaults per platform", () => {
    const mac = loadConfig({ env: {}, platform: "darwin" });
    assert.equal(mac.lane, "mac");
    assert.equal(mac.platformUrl, DEFAULT_PLATFORM);
    assert.equal(mac.idleShutdownMinutes, 0, "the Mac never stops itself");
    const windows = loadConfig({ env: {}, platform: "win32" });
    assert.equal(windows.lane, "windows");
    assert.equal(windows.idleShutdownMinutes, 20);
    assert.equal(windows.root, "C:\\MuseLab");
  });
  test("polls every 10 s and heartbeats every 15 s", () => {
    const config = loadConfig({ env: {}, platform: "darwin" });
    assert.equal(config.pollSeconds, 10);
    assert.equal(config.heartbeatSeconds, 15);
  });
  test("refuses plain http to a real host, even when asked", () => {
    assert.throws(() => loadConfig({ env: { MUSE_LAB_PLATFORM: "http://muse-muse.vercel.app" } }));
    assert.throws(() => loadConfig({ env: { MUSE_LAB_PLATFORM: "http://muse-muse.vercel.app", MUSE_LAB_ALLOW_INSECURE: "1" } }));
    assert.equal(loadConfig({ env: { MUSE_LAB_PLATFORM: "http://127.0.0.1:3000", MUSE_LAB_ALLOW_INSECURE: "1" } }).allowInsecure, true);
    assert.equal(loadConfig({ env: {} }).allowInsecure, false);
  });
  test("bad values are refused", () => {
    assert.throws(() => loadConfig({ env: { MUSE_LAB_LANE: "linux" } }));
    assert.throws(() => loadConfig({ env: { MUSE_LAB_SLOTS: "3" } }));
  });
  test("kinds can be narrowed, and unknown ones are dropped", () => {
    assert.deepEqual(loadConfig({ env: { MUSE_LAB_KINDS: "ios_sim, nope" } }).kinds, ["ios_sim"]);
  });
});

describe("downloadFile", () => {
  const bytes = Buffer.from("hello lab");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const url = "https://x.public.blob.vercel-storage.com/a";
  const dirs = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-dl-"));
    return { dir, opts: { cacheDir: path.join(dir, "cache"), tempDir: path.join(dir, "tmp") } };
  };
  const ok = async () => new Response(bytes);

  test("checks the checksum and caches by it", async () => {
    const { dir, opts } = dirs();
    let calls = 0;
    const counted = async () => (calls++, new Response(bytes));
    const first = await downloadFile({ url, sha256: sha }, { ...opts, fetch: counted });
    assert.equal(first, path.join(opts.cacheDir, sha));
    assert.equal(await downloadFile({ url, sha256: sha }, { ...opts, fetch: counted }), first);
    assert.equal(calls, 1);
    rmSync(dir, { recursive: true, force: true });
  });
  test("refuses a wrong checksum and leaves nothing behind", async () => {
    const { dir, opts } = dirs();
    await assert.rejects(downloadFile({ url, sha256: "b".repeat(64) }, { ...opts, fetch: ok }), (err) => err.code === "checksum_mismatch");
    assert.ok(!existsSync(path.join(opts.cacheDir, "b".repeat(64))));
    rmSync(dir, { recursive: true, force: true });
  });
  test("refuses a host it doesn't trust, and redirects", async () => {
    const { dir, opts } = dirs();
    await assert.rejects(downloadFile({ url: "https://evil.example/a" }, { ...opts, fetch: ok }), (err) => err.code === "download_failed");
    let seen;
    await downloadFile({ url }, { ...opts, fetch: async (_, init) => ((seen = init), new Response(bytes)) });
    assert.equal(seen.redirect, "error");
    rmSync(dir, { recursive: true, force: true });
  });
  test("a wrong size or a bad answer fails", async () => {
    const { dir, opts } = dirs();
    await assert.rejects(downloadFile({ url, bytes: 3 }, { ...opts, fetch: ok }), (err) => err.code === "download_failed");
    await assert.rejects(downloadFile({ url }, { ...opts, fetch: async () => new Response("no", { status: 404 }) }), /404/);
    rmSync(dir, { recursive: true, force: true });
  });
});
