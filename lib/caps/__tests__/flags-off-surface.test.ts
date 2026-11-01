/**
 * With every flag off, a product with no caps gets the sandbox, deploy and judge it got before wave 3
 * (docs/CAPABILITIES.md, section 1, "byte-identical"). Each golden is the real surface, from the real code with the
 * sandbox, database, token store, deploy and model faked:
 *
 *   policy.json          the network policy provisionSandbox gives the sandbox (lockedPolicy), public and local runs
 *   provision.json       every file provisionSandbox writes and every command it runs, in order, for a sample
 *   env-local.txt        the .env.local provisioning writes, and the one a refinement's reopenSandbox writes
 *   steps.json           STEPS, the round and verify caps
 *   allowed-models.json  allowedModelsFor on the sample brief
 *   deploy-env.json      the env startDeployStep gives the product's Vercel project
 *   judge-content.json   the judge's instructions and content parts for a sample
 *
 * The goldens were written by this file run against d8ffec4 (wave 2) alone, which has none of wave 3's code. Only APIs
 * d8ffec4 has are used here, so it can be run there again:
 *
 *   UPDATE_GOLDEN=1 GOLDEN_DIR=<dir> npx tsx --test --experimental-test-module-mocks lib/caps/__tests__/flags-off-surface.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, beforeEach, describe, it, mock } from "node:test";
import { getTableName } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const GOLDEN = process.env.GOLDEN_DIR || join(import.meta.dirname, "golden");
const canMock = typeof (mock as { module?: unknown }).module === "function";

/** Every flag a unit of wave 2 or 3 reads, and the settings that change these surfaces. Cleared before each test. */
const FLAGS = [
  "TARGETS_ENABLED", "TARGET_PHONE", "TARGET_DESKTOP", "TARGET_VR", "TARGET_GLASSES", "TARGET_AGENT", "AGENTS_ENABLED",
  "COMPOSIO_PERSONAL_ENABLED", "GADGETS_ENABLED", "PRODUCT_OUTPUTS", "PROVE_IT", "STEERING_ENABLED", "MUSE_CODE_FULL",
  "ENGINE_CHECK_ON_TIMEOUT", "ENGINE_ROUND_SCALING", "ENGINE_ROUND_MAX_MINUTES", "ENGINE_MILESTONES", "ENGINE_LIVE_SMOKE",
  "ENGINE_EXACT_LOGIC", "ENGINE_FIT_OUTPUT", "TRUST_SIGNED_IN_CAPS", "TRUST_BUILDER_DAILY_USD", "TRUST_AGE_GATE", "TRUST_LEGAL_PAGES", "TRUST_GEO_BLOCK", "TRUST_GEO_COUNTRIES", "TRUST_REPORTS", "TRUST_SPARK_TO_WONDER", "DATA_ENABLED", "DATA_SIGN_IN", "FILES_ENABLED", "FILES_SEARCH", "FILES_DATASETS", "CONNECT_ENABLED",
  "JOBS_ENABLED", "LIVE_ENABLED", "MEDIA_ENABLED", "CODE_ENABLED", "RUNTIME_ENABLED", "HARDWARE_ENABLED",
  "NATIVE_EXTENSION", "NATIVE_GAME_ENGINES", "VERCEL", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_ENV",
];
const SETTINGS = { MODEL_API_KEY: "test-model-key", BUILDER_SNAPSHOT_ID: "snap_test", PLATFORM_URL: "https://musemuse.example" };

// ---------- fakes ----------

let ops: string[] = [];
let written: Record<string, string> = {};
let policies: unknown[] = [];
let tags: Record<string, string> | undefined;
let selects: Record<string, unknown[][]> = {};
let deployEnv: Record<string, string> | null = null;
let judged: { instructions: string; content: unknown; schemaName: string } | null = null;

const fakeSandbox = {
  name: "product-bird-count-11111111",
  get tags() {
    return tags;
  },
  expiresAt: new Date(Date.now() + 24 * 3600_000),
  update: async (u: Record<string, unknown>) => {
    if (u.networkPolicy) {
      policies.push(u.networkPolicy);
      ops.push("update: networkPolicy");
    }
    if (u.tags) {
      tags = u.tags as Record<string, string>;
      ops.push("update: tags");
    }
  },
  extendTimeout: async () => undefined,
  runCommand: async (opts: { args: string[]; sudo?: boolean }) => {
    ops.push(`run${opts.sudo ? " (sudo)" : ""}: ${opts.args.slice(1).join(" ")}`);
    return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
  },
  writeFiles: async (batch: Array<{ path: string; content: string | Buffer }>) => {
    for (const f of batch) {
      written[f.path] = String(f.content);
      ops.push(`write: ${f.path} (${Buffer.byteLength(f.content)} bytes)`);
    }
  },
  readFileToBuffer: async ({ path }: { path: string }) => (path.endsWith("/builder.json") ? Buffer.from("{}") : null),
};

function thenable<T extends object>(q: T, result: () => unknown): T {
  return Object.assign(q, { then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve().then(result).then(ok, bad) });
}

const fakeDb = () => ({
  select: () => {
    let table = "";
    const q: Record<string, unknown> = {};
    for (const m of ["where", "orderBy", "limit"]) q[m] = () => q;
    q.from = (t: never) => {
      table = getTableName(t);
      return q;
    };
    return thenable(q, () => selects[table]?.shift() ?? []);
  },
  update: () => {
    const q: Record<string, unknown> = {};
    for (const m of ["set", "where", "returning"]) q[m] = () => q;
    return thenable(q, () => []);
  },
});

class FakeFatalError extends Error {}

let builder: typeof import("@/lib/sandbox/builder");
let steps: typeof import("@/lib/pipeline/build-steps");
let judge: typeof import("@/lib/judge");
let pipelineSteps: typeof import("@/lib/pipeline/steps");
let logic: typeof import("@/lib/pipeline/logic");

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function golden(name: string, text: string) {
  if (process.env.UPDATE_GOLDEN) writeFileSync(join(GOLDEN, name), text);
  assert.equal(text, readFileSync(join(GOLDEN, name), "utf8"), `${name} changed`);
}

const PROVISION = {
  buildId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  productId: "11111111-2222-4333-8444-555555555555",
  slug: "bird-count",
  references: [{ kind: "image", fileName: "feeder.jpg", url: "https://x.public.blob.vercel-storage.com/feeder.jpg", contentType: "image/jpeg", bytes: 1000 }],
  fixtures: [{ fileName: "birds.jpg", url: "https://x.public.blob.vercel-storage.com/birds.jpg" }],
  promptMarkdown: "# Build this product\n",
  buildToken: "mm_build_sample",
  gatewayUrl: "https://musemuse.example/api/gateway",
};

describe("with every flag off, a product with no caps", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const at = (rel: string) => new URL(rel, import.meta.url).href;
    mock.module("@vercel/sandbox", {
      namedExports: {
        APIError: class APIError extends Error {},
        Sandbox: {
          get: async () => fakeSandbox,
          getOrCreate: async (opts: { networkPolicy?: unknown }) => {
            policies.push(opts.networkPolicy);
            ops.push("getOrCreate");
            return fakeSandbox;
          },
        },
      },
    });
    mock.module(at("../../storage.ts"), {
      namedExports: {
        fetchBytes: async () => Buffer.alloc(1000, 1),
        putFile: async (prefix: string, key: string) => `https://blob/${prefix}/${key}`,
        blobAuth: () => ({}),
      },
    });
    mock.module(at("../../db/client.ts"), { namedExports: { db: fakeDb, schema: realSchema } });
    mock.module(at("../../gateway/tokens.ts"), {
      namedExports: {
        mintToken: async (opts: { scope: string }) => ({ id: `tok-${opts.scope}`, token: `mm_${opts.scope}_sample` }),
        revokeTokens: async () => undefined,
        revokeLiveTokensExcept: async () => undefined,
        hashToken: (t: string) => t,
        findToken: async () => null,
      },
    });
    mock.module(at("../../publish/vercel.ts"), {
      namedExports: {
        startDeployFromSandbox: async (input: { env: Record<string, string> }) => {
          deployEnv = input.env;
          return { projectId: "prj_1", deploymentId: "dpl_1", url: "https://musemuse-bird-count.vercel.app" };
        },
        pollDeploy: async () => ({}),
        projectNameFor: (slug: string) => `musemuse-${slug}`,
      },
    });
    mock.module(at("../../brief/structured.ts"), {
      namedExports: {
        respondStructured: async (opts: { instructions: string; content: unknown; schemaName: string }) => {
          judged = { instructions: opts.instructions, content: opts.content, schemaName: opts.schemaName };
          return { data: { pass: true, reasons: ["It works."], mismatches: [] }, usage: [], issues: [] };
        },
        StructuredOutputError: class StructuredOutputError extends Error {},
      },
    });
    mock.module("workflow", { namedExports: { FatalError: FakeFatalError, RetryableError: FakeFatalError, getStepMetadata: () => ({ attempt: 1 }), sleep: async () => undefined } });
    builder = await import("@/lib/sandbox/builder");
    steps = await import("@/lib/pipeline/build-steps");
    judge = await import("@/lib/judge");
    pipelineSteps = await import("@/lib/pipeline/steps");
    logic = await import("@/lib/pipeline/logic");
  });

  beforeEach(() => {
    for (const flag of FLAGS) delete process.env[flag];
    Object.assign(process.env, SETTINGS);
    ops = [];
    written = {};
    policies = [];
    tags = undefined;
    selects = {};
    deployEnv = null;
    judged = null;
  });

  it("gets the same network policy, files, commands and .env.local at provision and on a change", async () => {
    await builder.provisionSandbox(PROVISION as never);
    const provisioned = { ops, envLocal: written["/vercel/app/.env.local"] };
    const publicPolicies = policies;

    ops = [];
    written = {};
    policies = [];
    await builder.reopenSandbox({ sandboxName: fakeSandbox.name, productId: PROVISION.productId, buildToken: "mm_build_sample", gatewayUrl: PROVISION.gatewayUrl, newReferences: [] });
    const reopened = written["/vercel/app/.env.local"];
    const reopenPolicy = policies;

    // A local run: the platform is on localhost, so the product calls Meta directly with the placeholder key.
    process.env.PLATFORM_URL = "http://localhost:3000";
    policies = [];
    written = {};
    await builder.provisionSandbox({ ...PROVISION, gatewayUrl: "http://localhost:3000/api/gateway" } as never);
    const localPolicies = policies;
    const localEnv = written["/vercel/app/.env.local"]!.replace(/PRODUCT_TOKEN=\S+/, "PRODUCT_TOKEN=<sandbox placeholder>");

    golden("policy.json", json({ provision: publicPolicies, reopen: reopenPolicy, localProvision: localPolicies }));
    golden("provision.json", json(provisioned.ops));
    golden("env-local.txt", `## provision\n${provisioned.envLocal}## reopen\n${reopened}## local provision\n${localEnv}`);
  });

  it("gets the same round caps and token allowlist", () => {
    golden("steps.json", json(pipelineSteps.STEPS));
    golden("allowed-models.json", json(logic.allowedModelsFor(BRIEF)));
  });

  it("deploys with the same env", async () => {
    selects = {
      builds: [[{ id: PROVISION.buildId, brief: BRIEF, inspirationId: "i1" }]],
      products: [[{ id: PROVISION.productId, slug: "bird-count", name: "Bird Count", vercelProjectId: null }]],
    };
    await steps.startDeployStep({ buildId: PROVISION.buildId, productId: PROVISION.productId, sandboxName: fakeSandbox.name });
    golden("deploy-env.json", json(deployEnv));
  });

  it("is judged with the same instructions and content", async () => {
    await judge.judgeBuild({
      brief: BRIEF,
      references: [{ kind: "image", fileName: "feeder.jpg", url: "https://x.public.blob.vercel-storage.com/feeder.jpg", contentType: "image/jpeg", bytes: 1000 } as never],
      screenshots: [
        { url: "https://x.public.blob.vercel-storage.com/01-start.png", caption: "Start" },
        { url: "https://x.public.blob.vercel-storage.com/02-result.png", caption: "Result" },
      ],
    });
    golden("judge-content.json", json(judged));
  });
});
