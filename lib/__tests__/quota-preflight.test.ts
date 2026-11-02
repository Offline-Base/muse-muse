/**
 * The build preflight in checkBuildAllowed (lib/quota.ts): no_model_key with an empty MODEL_API_KEY, no_sandbox when
 * Vercel Sandbox would find no credentials, and a pass with both, as on production (VERCEL=1). The usage table and the
 * database are faked; nothing calls Meta or Vercel.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/__tests__/quota-preflight.test.ts
 *
 * Without the flag, node:test has no mock.module and the checkBuildAllowed part skips.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const savedEnv = { ...process.env };
const ADMIN = { id: "admin-1", email: "a@x", isAdmin: true };
/** Stand-ins, not real credentials. */
const FAKE_KEY = "test-value-not-a-key";
const FAKE_OIDC = "header.payload.signature-not-a-token";

/** A folder with no .vercel anywhere above it that we control: a fresh temp dir. */
function bareDir(): string {
  return mkdtempSync(path.join(tmpdir(), "quota-preflight-"));
}

function linkedDir(withProject: boolean): string {
  const root = bareDir();
  mkdirSync(path.join(root, ".vercel"));
  if (withProject) writeFileSync(path.join(root, ".vercel", "project.json"), JSON.stringify({ projectId: "prj_fake", orgId: "team_fake" }));
  const nested = path.join(root, "app", "deep");
  mkdirSync(nested, { recursive: true });
  return nested;
}

let quota: typeof import("@/lib/quota");
let spendCalls = 0;

before(async () => {
  if (canMock) {
    mock.module(new URL("../usage.ts", import.meta.url).href, {
      namedExports: {
        platformSpendToday: async () => {
          spendCalls++;
          return 0;
        },
      },
    });
    mock.module(new URL("../db/client.ts", import.meta.url).href, {
      namedExports: {
        db: () => {
          throw new Error("no database in this test");
        },
        schema: {},
      },
    });
  }
  quota = await import("@/lib/quota");
});
after(() => {
  mock.restoreAll();
  process.env = savedEnv;
});

describe("buildSetupRefusal", () => {

  it("refuses with no_model_key first, whatever else is set", () => {
    assert.deepEqual(quota.buildSetupRefusal({ VERCEL: "1" }, bareDir()), { ok: false, status: 503, error: "no_model_key" });
    assert.deepEqual(quota.buildSetupRefusal({ MODEL_API_KEY: "  ", VERCEL_OIDC_TOKEN: FAKE_OIDC }, bareDir())?.error, "no_model_key");
  });

  it("refuses with no_sandbox when the SDK would find no credentials", (t) => {
    const dir = bareDir();
    // tmpdir() itself could sit under a folder with .vercel on some machines; the check is only meaningful when it doesn't.
    if (quota.sandboxCredentialsAvailable({}, dir)) return t.skip("the temp folder sits under a linked Vercel project");
    assert.deepEqual(quota.buildSetupRefusal({ MODEL_API_KEY: FAKE_KEY }, dir), { ok: false, status: 503, error: "no_sandbox" });
    // The packager's token triple is not what builds use, so it doesn't count.
    assert.equal(
      quota.buildSetupRefusal({ MODEL_API_KEY: FAKE_KEY, VERCEL_TOKEN: "t", VERCEL_TEAM_ID: "team_x", VERCEL_PROJECT_ID: "prj_x" }, dir)?.error,
      "no_sandbox",
    );
    // A .vercel folder with no project.json is where the SDK's refresh stops, so it doesn't count either.
    assert.equal(quota.buildSetupRefusal({ MODEL_API_KEY: FAKE_KEY }, linkedDir(false))?.error, "no_sandbox");
  });

  it("passes with a key and any source the SDK reads", () => {
    const dir = bareDir();
    assert.equal(quota.buildSetupRefusal({ MODEL_API_KEY: FAKE_KEY, VERCEL: "1" }, dir), null, "on Vercel, as production");
    assert.equal(quota.buildSetupRefusal({ MODEL_API_KEY: FAKE_KEY, VERCEL_OIDC_TOKEN: FAKE_OIDC }, dir), null);
    assert.equal(quota.buildSetupRefusal({ MODEL_API_KEY: FAKE_KEY, VERCEL_OIDC_TOKEN_FILE: "/run/oidc" }, dir), null);
    assert.equal(quota.buildSetupRefusal({ MODEL_API_KEY: FAKE_KEY }, linkedDir(true)), null, "npx vercel link");
  });

  it("reads the request's x-vercel-oidc-token header the way @vercel/oidc does", () => {
    const key = Symbol.for("@vercel/request-context");
    const g = globalThis as Record<symbol, unknown>;
    const before = g[key];
    g[key] = { get: () => ({ headers: { "x-vercel-oidc-token": FAKE_OIDC } }) };
    try {
      assert.equal(quota.buildSetupRefusal({ MODEL_API_KEY: FAKE_KEY }, bareDir()), null);
    } finally {
      g[key] = before;
    }
  });
});

describe("checkBuildAllowed's preflight", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  beforeEach(() => {
    spendCalls = 0;
    for (const k of ["MODEL_API_KEY", "VERCEL", "VERCEL_OIDC_TOKEN", "VERCEL_OIDC_TOKEN_FILE", "BLOB_READ_WRITE_TOKEN", "TRUST_REPORTS", "TRUST_AGE_GATE", "TRUST_SIGNED_IN_CAPS"]) {
      delete process.env[k];
    }
    process.env.BLOB_STORE_ID = "store_test";
  });

  it("refuses with 503 no_model_key before reading today's spend", async () => {
    process.env.VERCEL = "1";
    assert.deepEqual(await quota.checkBuildAllowed(ADMIN), { ok: false, status: 503, error: "no_model_key" });
    assert.equal(spendCalls, 0, "nothing past the preflight ran");
  });

  it("refuses with 503 no_sandbox off Vercel with no OIDC token", async (t) => {
    if (quota.sandboxCredentialsAvailable(process.env)) return t.skip("this checkout is linked to a Vercel project (.vercel/project.json)");
    process.env.MODEL_API_KEY = FAKE_KEY;
    assert.deepEqual(await quota.checkBuildAllowed(ADMIN), { ok: false, status: 503, error: "no_sandbox" });
    assert.equal(spendCalls, 0);
  });

  it("lets a build through with both, as production has them", async () => {
    process.env.MODEL_API_KEY = FAKE_KEY;
    process.env.VERCEL = "1";
    assert.deepEqual(await quota.checkBuildAllowed(ADMIN), { ok: true });
    delete process.env.VERCEL;
    process.env.VERCEL_OIDC_TOKEN = FAKE_OIDC;
    assert.deepEqual(await quota.checkBuildAllowed(ADMIN), { ok: true }, "a local run after npx vercel env pull");
    assert.ok(spendCalls >= 2, "the spend cap is still checked after the preflight");
  });

  it("still says no_storage first when there is no file storage on Vercel", async () => {
    delete process.env.BLOB_STORE_ID;
    process.env.VERCEL = "1";
    assert.deepEqual(await quota.checkBuildAllowed(ADMIN), { ok: false, status: 503, error: "no_storage" });
  });
});
