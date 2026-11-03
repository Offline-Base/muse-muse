/**
 * lib/sandbox/builder.ts with SANDBOX_HOST=modal and the Modal host faked: Muse Code gets the platform's Meta proxy as
 * its endpoint and a proxy token as its key (never the real key or the Vercel placeholder), on exec and on the bridge;
 * the preview URL is the tunnel's; a local platform and dry runs are refused. With the flag unset nothing of this shows.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/sandbox/host/__tests__/builder-modal.scenario.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { bridgeConfigPath, type BridgeConfig } from "@/lib/sandbox/bridge-protocol";
import { verifySandboxMetaToken } from "@/lib/sandbox/host/meta-proxy";
import { placeholderKey } from "@/lib/sandbox/policy";

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const KEY = "test-model-key";
const NAME = "product-bird-finder-3f2a9c1e";
const PROBE = '"kind":"bridge","event":"turn"';

let files: Record<string, string> = {};
let commands: string[] = [];
let opened: string[] = [];

const fakeSandbox = {
  name: NAME,
  status: "running",
  expiresAt: undefined,
  tags: { app: "musemuse", role: "product", product: "p1" },
  update: async () => {},
  extendTimeout: async () => {},
  writeFiles: async (batch: Array<{ path: string; content: string | Buffer }>) => {
    for (const f of batch) files[f.path] = String(f.content);
  },
  readFileToBuffer: async ({ path }: { path: string }) => (path in files ? Buffer.from(files[path]!) : null),
  runCommand: async (opts: { cmd: string; args: string[]; detached?: boolean }) => {
    const script = opts.args[0] === "-c" ? opts.args[1]! : opts.args[0]!;
    commands.push(script);
    if (opts.detached) return { cmdId: `mmc_${String(commands.length).padStart(24, "0")}` };
    const stdout = script.includes(PROBE) ? "turn\n" : script.includes("curl") ? "200" : "";
    return { exitCode: 0, stdout: async () => stdout, stderr: async () => "" };
  },
  getCommand: async () => ({ cmdId: "x", exitCode: 0, wait: async () => ({ exitCode: 0 }), kill: async () => {} }),
  domain: async (port: number) => `https://tunnel-${port}.modal.host`,
  stop: async () => {},
  delete: async () => {},
};

const canMock = typeof (mock as { module?: unknown }).module === "function";
let builder: typeof import("../../builder");

const ENV = ["SANDBOX_HOST", "MUSE_ENGINE", "MUSE_FULL", "PLATFORM_URL", "GATEWAY_TOKEN_PEPPER", "MODEL_API_KEY", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

before(async () => {
  if (!canMock) return;
  // The Vercel SDK must never be called with the flag on.
  const refuse = async () => {
    throw new Error("Vercel Sandbox was called on SANDBOX_HOST=modal");
  };
  mock.module("@vercel/sandbox", { namedExports: { APIError: class extends Error {}, Sandbox: { get: refuse, getOrCreate: refuse, fork: refuse } } });
  mock.module(new URL("../modal.ts", import.meta.url).href, {
    namedExports: {
      loadModalSdk: async () => ({}),
      createModalHost: () => ({
        name: "modal",
        get: async ({ name }: { name: string }) => (opened.push(name), fakeSandbox),
        getOrCreate: async ({ name }: { name: string }) => (opened.push(name), fakeSandbox),
        fork: async () => fakeSandbox,
        isNotFound: () => false,
      }),
    },
  });
  mock.module(new URL("../../../storage.ts", import.meta.url).href, {
    namedExports: { putFile: async () => "https://blob/x", fetchBytes: async () => Buffer.alloc(0) },
  });
  builder = await import("../../builder");
});

after(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  files = {};
  commands = [];
  opened = [];
  for (const k of ENV) delete process.env[k];
  process.env.SANDBOX_HOST = "modal";
  process.env.MODEL_API_KEY = KEY;
  process.env.GATEWAY_TOKEN_PEPPER = "test-pepper";
  process.env.PLATFORM_URL = "https://muse-muse.vercel.app";
});

const start = () =>
  builder.startMuse({ sandboxName: NAME, sessionId: SESSION, promptFile: "brief.md", images: [], model: "muse-wonder-1.0", maxModelSteps: 200, round: 0 });

const ENDPOINT = `endpoint_transport={"base_url":"https://muse-muse.vercel.app/api/sandbox-meta/v1","auth":"bearer"}`;

/** The META_API_KEY a runner script exports. */
function exportedKey(script: string): string {
  const m = /export META_API_KEY='([^']+)'/.exec(script);
  assert.ok(m, "the runner exports META_API_KEY");
  return m[1]!;
}

describe("builder on SANDBOX_HOST=modal", { skip: !canMock }, () => {
  it("exec: Muse Code's endpoint is the proxy, telemetry is off, and its key is a proxy token for this sandbox", async () => {
    const res = await start();
    assert.equal(res.engine, "exec");
    assert.deepEqual(opened, [NAME]);
    const runner = files["/vercel/musemuse/run/muse-r0.sh"] ?? "";
    assert.ok(runner.includes(`'--config' '${ENDPOINT}'`), runner);
    assert.ok(runner.includes(`'--config' 'telemetry.enabled=false'`));
    const key = exportedKey(runner);
    assert.notEqual(key, KEY);
    assert.notEqual(key, placeholderKey(KEY, NAME), "not the Vercel firewall's placeholder");
    assert.deepEqual(verifySandboxMetaToken(KEY, key), { sandboxName: NAME });
    assert.ok(!Object.values(files).some((f) => f.includes(KEY)), "the real key is in no file");
  });

  it("serve: the bridge's settings carry the proxy endpoint and telemetry off", async () => {
    process.env.MUSE_ENGINE = "serve";
    const res = await start();
    assert.equal(res.engine, "serve");
    const config = JSON.parse(files[bridgeConfigPath(0)] ?? "{}") as BridgeConfig;
    assert.deepEqual(config.settings.slice(-2), [ENDPOINT, "telemetry.enabled=false"]);
    assert.deepEqual(verifySandboxMetaToken(KEY, exportedKey(files["/vercel/musemuse/run/muse-r0.sh"] ?? "")), { sandboxName: NAME });
  });

  it("the preview URL is the tunnel's", async () => {
    assert.deepEqual(await builder.startPreview(NAME), { url: "https://tunnel-3000.modal.host" });
  });

  it("refuses a local platform and dry runs", async () => {
    process.env.PLATFORM_URL = "http://localhost:3000";
    await assert.rejects(
      () => builder.reopenSandbox({ sandboxName: NAME, productId: "p1", buildToken: "t", gatewayUrl: "http://localhost:3000/api/gateway", newReferences: [] }),
      /public PLATFORM_URL/,
    );
    await assert.rejects(() => builder.forkForDryRun(NAME), /Dry runs need Vercel Sandbox/);
  });
});
