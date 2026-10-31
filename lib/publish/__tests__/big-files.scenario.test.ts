/**
 * The deploy's big-file fix (wave 3, unit 1, decision 1; docs/CAPABILITIES.md, section 7): a file over 10 MB deploys,
 * and one over Vercel's per-file limit fails the deploy by name. Nothing is ever left out without a word. The collect
 * script is real (node on a temporary folder); the sandbox and Vercel's API are faked.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/publish/__tests__/big-files.scenario.test.ts
 *
 * Without the flag, node:test has no mock.module and the deploy part skips.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const MB = 1024 * 1024;

let dir = "";
let vercel: typeof import("../vercel");
/** What the fake sandbox's collect run left in its out folder, keyed by the sandbox path the platform reads. */
let collected = new Map<string, Buffer>();

function runCollect(root: string, out: string): { files: Array<{ file: string; size: number; sha: string }>; skipped: Array<{ file: string; size: number }> } {
  const script = path.join(dir, "collect.cjs");
  writeFileSync(script, vercel.COLLECT_SCRIPT);
  const res = spawnSync("node", [script, root, out, String(vercel.MAX_FILE_BYTES), ...vercel.DEPLOY_EXCLUDE_DIRS], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(readFileSync(path.join(out, "files.json"), "utf8"));
}

/** A product folder with package.json, an 11 MB model file and, when asked, a file just over the limit (sparse, so cheap). */
function product(name: string, opts: { tooBig?: boolean } = {}): string {
  const root = path.join(dir, name);
  mkdirSync(path.join(root, "public", "models"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{"name":"p"}\n');
  writeFileSync(path.join(root, "public", "models", "tiny.onnx"), Buffer.alloc(11 * MB, 7));
  if (opts.tooBig) {
    const big = path.join(root, "public", "models", "huge.bin");
    writeFileSync(big, "");
    truncateSync(big, 100 * MB + 1);
  }
  return root;
}

describe("big files", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let root = "";

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "big-files-"));
    process.env.VERCEL_TOKEN = "test-vercel-token";
    const fakeSandbox = {
      writeFiles: async () => {},
      // The collect command runs the real script on `root`, writing where the platform then reads.
      runCommand: async () => {
        const out = path.join(dir, "out");
        rmSync(out, { recursive: true, force: true });
        runCollect(root, out);
        collected = new Map([
          ["files.json", readFileSync(path.join(out, "files.json"))],
          ["files.bin", readFileSync(path.join(out, "files.bin"))],
        ]);
        return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
      },
      readFileToBuffer: async ({ path: file }: { path: string }) => collected.get(path.basename(file)) ?? null,
    };
    mock.module("@vercel/sandbox", { namedExports: { Sandbox: { get: async () => fakeSandbox } } });
    vercel = await import("../vercel");
    mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ? "(bytes)" : undefined;
      calls.push({ method, url, body });
      if (url.includes("/v9/projects/") && method === "GET" && !url.includes("/domains")) return Response.json({ id: "prj_1", name: "musemuse-demo" });
      if (url.includes("/v13/deployments") && method === "POST") return Response.json({ id: "dpl_1", url: "musemuse-demo-abc.vercel.app" });
      if (url.includes("/domains")) return Response.json({ domains: [{ name: "musemuse-demo.vercel.app" }] });
      return Response.json({});
    });
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.VERCEL_TOKEN;
  });

  it("the collect script keeps an 11 MB file and lists one over the limit as skipped", () => {
    const out = runCollect(product("collect", { tooBig: true }), path.join(dir, "collect-out"));
    const tiny = out.files.find((f) => f.file === "public/models/tiny.onnx");
    assert.equal(tiny?.size, 11 * MB);
    assert.deepEqual(out.skipped, [{ file: "public/models/huge.bin", size: 100 * MB + 1 }]);
    assert.equal(vercel.MAX_FILE_BYTES, 100 * MB);
  });

  it("deploys an 11 MB file: it is in the deployment's file list with its real size and digest", async () => {
    root = product("fits");
    calls.length = 0;
    const started = await vercel.startDeployFromSandbox({ sandboxName: "sb", slug: "demo", productName: "Demo", env: {}, projectId: "prj_1" });
    assert.equal(started.deploymentId, "dpl_1");
    const create = calls.find((c) => c.method === "POST" && c.url.includes("/v13/deployments"));
    const files = (create?.body as { files: Array<{ file: string; sha: string; size: number }> }).files;
    const tiny = files.find((f) => f.file === "public/models/tiny.onnx");
    assert.equal(tiny?.size, 11 * MB);
    assert.equal(tiny?.sha, createHash("sha1").update(Buffer.alloc(11 * MB, 7)).digest("hex"));
  });

  it("fails a deploy with a file over the limit, by name, before any deployment is made", async () => {
    root = product("too-big", { tooBig: true });
    calls.length = 0;
    await assert.rejects(
      vercel.startDeployFromSandbox({ sandboxName: "sb", slug: "demo", productName: "Demo", env: {}, projectId: "prj_1" }),
      (err: unknown) => {
        assert.ok(err instanceof vercel.DeployFilesTooBigError);
        assert.equal((err as Error).name, "FatalError", "the step doesn't retry it, and the build room shows the sentence");
        assert.match((err as Error).message, /public\/models\/huge\.bin \(100\.0 MB\)/);
        assert.match((err as Error).message, /over Vercel's 100\.0 MB limit for one file/);
        return true;
      },
    );
    assert.ok(!calls.some((c) => c.url.includes("/v13/deployments")), "no deployment was created");
  });
});
