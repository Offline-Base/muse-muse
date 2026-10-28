/**
 * Runs writeFixScreenshots in lib/sandbox/builder.ts with the sandbox and Blob downloads faked: the four-screenshot
 * cap, the 2 MB cap (downscaled in the sandbox, or left out), downloads that fail, and a downscale that fails.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/sandbox/__tests__/builder.scenario.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

const MB = 1024 * 1024;
const DIR = "/vercel/app/.muse-fix";

/** Bytes each URL downloads as, or an error to throw. */
let downloads: Record<string, number | Error> = {};
let fetched: Array<{ url: string; signal?: AbortSignal }> = [];
let scripts: string[] = [];
let written: Array<{ path: string; bytes: number }> = [];
/** What the downscale script prints (the files that now fit), or an error for the command itself. */
let shrinkResult: ((script: string) => string) | Error = () => "";

const fakeSandbox = {
  runCommand: async (opts: { args: string[] }) => {
    const script = opts.args[1] ?? "";
    scripts.push(script);
    const isShrink = script.includes("ffmpeg");
    if (isShrink && shrinkResult instanceof Error) throw shrinkResult;
    const stdout = isShrink && typeof shrinkResult === "function" ? shrinkResult(script) : "";
    return { exitCode: 0, stdout: async () => stdout, stderr: async () => "" };
  },
  writeFiles: async (files: Array<{ path: string; content: string | Buffer }>) => {
    for (const f of files) written.push({ path: f.path, bytes: Buffer.byteLength(f.content) });
  },
};

const canMock = typeof (mock as { module?: unknown }).module === "function";
let builder: typeof import("../builder");

const shot = (url: string) => ({ url, caption: url });

describe("writeFixScreenshots", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module("@vercel/sandbox", {
      namedExports: { APIError: class APIError extends Error {}, Sandbox: { get: async () => fakeSandbox } },
    });
    mock.module(new URL("../../storage.ts", import.meta.url).href, {
      namedExports: {
        putFile: async () => "https://blob/x",
        fetchBytes: (url: string, opts: { signal?: AbortSignal } = {}) => {
          fetched.push({ url, signal: opts.signal });
          const d = downloads[url];
          if (d instanceof Error) return Promise.reject(d);
          return Promise.resolve(Buffer.alloc(d ?? 1000, 1));
        },
      },
    });
    builder = await import("../builder");
  });

  beforeEach(() => {
    downloads = {};
    fetched = [];
    scripts = [];
    written = [];
    shrinkResult = () => "";
  });

  it("attaches at most four, skips a failed download and numbers the rest in order", async () => {
    downloads = { "https://b/2.png": new Error("Download failed (404)") };
    const out = await builder.writeFixScreenshots("sb", 1, [1, 2, 3, 4, 5].map((n) => shot(`https://b/${n}.png`)));
    assert.deepEqual(
      fetched.map((f) => f.url),
      ["https://b/1.png", "https://b/2.png", "https://b/3.png", "https://b/4.png"],
    );
    assert.ok(fetched.every((f) => f.signal instanceof AbortSignal && !f.signal.aborted), "every download has a deadline");
    assert.deepEqual(out, [".muse-fix/round-1-1.png", ".muse-fix/round-1-2.png", ".muse-fix/round-1-3.png"]);
    assert.deepEqual(
      written.map((w) => w.path),
      [`${DIR}/.gitignore`, `${DIR}/round-1-1.png`, `${DIR}/round-1-2.png`, `${DIR}/round-1-3.png`],
    );
    // Earlier copies of this round, downscale leftovers included, go first. Nothing needed downscaling.
    assert.match(scripts[0]!, /rm -f '\/vercel\/app\/\.muse-fix'\/round-1-\*$/);
    assert.equal(scripts.length, 1);
  });

  it("downscales a screenshot over 2 MB in the sandbox, and leaves it out when that doesn't get it under", async () => {
    downloads = { "https://b/big.png": 3 * MB, "https://b/huge.png": 40 * MB, "https://b/edge.png": 2 * MB };
    // The downscale gets big.png under 2 MB but not huge.png. edge.png is exactly 2 MB, so it goes as it is.
    shrinkResult = (script) => (script.includes("round-2-2.png") ? `${DIR}/round-2-2.png\n` : "");
    const shots = ["small", "big", "huge", "edge"].map((name) => shot(`https://b/${name}.png`));
    const out = await builder.writeFixScreenshots("sb", 2, shots);
    assert.deepEqual(
      written.map((w) => w.path),
      [`${DIR}/.gitignore`, `${DIR}/round-2-1.png`, `${DIR}/round-2-2.png.big`, `${DIR}/round-2-3.png.big`, `${DIR}/round-2-4.png`],
    );
    assert.equal(scripts.length, 2);
    assert.match(scripts[1]!, /for f in '\/vercel\/app\/\.muse-fix\/round-2-2\.png' '\/vercel\/app\/\.muse-fix\/round-2-3\.png'; do/);
    assert.match(scripts[1]!, new RegExp(`-le ${2 * MB} \\]`));
    assert.deepEqual(out, [".muse-fix/round-2-1.png", ".muse-fix/round-2-2.png", ".muse-fix/round-2-4.png"]);
  });

  it("goes on without the oversized ones when downscaling fails outright", async () => {
    downloads = { "https://b/big.png": 3 * MB };
    shrinkResult = new Error("Sandbox command timed out");
    const out = await builder.writeFixScreenshots("sb", 3, [shot("https://b/a.png"), shot("https://b/big.png")]);
    assert.deepEqual(out, [".muse-fix/round-3-1.png"]);
  });
});
