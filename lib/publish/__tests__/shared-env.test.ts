/**
 * Publishing with the owner's shared accounts (docs/BUILD_KEYS.md): the keys go on the product's project as sensitive
 * vars, names the build may not have are deleted, a platform var of the same name wins, and nothing is called when
 * there's nothing to do. Vercel's API is faked and every value is made up.
 *
 *   npx tsx --test lib/publish/__tests__/shared-env.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test, mock } from "node:test";
import { SHARED_ENV_COMMENT, syncSharedEnv } from "@/lib/publish/vercel";

const calls: Array<{ method: string; path: string; body: unknown }> = [];

before(() => {
  process.env.VERCEL_TOKEN = "fake-platform-vercel-token";
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (method === "GET" && url.pathname.endsWith("/env")) {
      return Response.json({ envs: [{ id: "env_gw", key: "GATEWAY_URL" }, { id: "env_aws", key: "AWS_SECRET_ACCESS_KEY" }, { id: "env_hf", key: "HF_TOKEN" }] });
    }
    return Response.json({});
  });
});
beforeEach(() => {
  calls.length = 0;
});
after(() => {
  mock.restoreAll();
  delete process.env.VERCEL_TOKEN;
});

test("sets the keys as sensitive vars with a comment, then deletes the shared names this build may not have", async () => {
  await syncSharedEnv("prj_1", { set: { HF_TOKEN: "hf_fakeShared0123456789abcdef" }, remove: ["HF_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/v10/projects/prj_1/env");
  assert.deepEqual(calls[0].body, [{ key: "HF_TOKEN", value: "hf_fakeShared0123456789abcdef", type: "sensitive", target: ["production", "preview"], comment: SHARED_ENV_COMMENT }]);
  assert.deepEqual(
    calls.slice(1).map((c) => `${c.method} ${c.path}`),
    ["GET /v9/projects/prj_1/env", "DELETE /v9/projects/prj_1/env/env_aws"],
    "HF_TOKEN is kept since it was just set, and a name that isn't there isn't deleted",
  );
});

test("a build that may not have them loses every shared name, and nothing else", async () => {
  await syncSharedEnv("prj_1", { set: {}, remove: ["HF_TOKEN", "AWS_SECRET_ACCESS_KEY", "GATEWAY_URL"] }, { GATEWAY_URL: "https://gw.example" });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ["GET /v9/projects/prj_1/env", "DELETE /v9/projects/prj_1/env/env_aws", "DELETE /v9/projects/prj_1/env/env_hf"],
    "a platform var of a shared name is never deleted",
  );
});

test("a platform var of the same name wins over a shared key, and nothing to do calls nothing", async () => {
  await syncSharedEnv("prj_1", { set: { GATEWAY_URL: "https://elsewhere.example" }, remove: [] }, { GATEWAY_URL: "https://gw.example" });
  assert.deepEqual(calls, []);
});
