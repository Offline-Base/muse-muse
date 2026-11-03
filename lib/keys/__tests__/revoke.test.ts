/**
 * The kill switch (lib/keys/revoke.ts, scripts/keys/revoke-shared.ts): a dry run changes nothing, --apply removes only
 * shared names from product projects, one failing project doesn't stop the rest, and the Vercel calls page through
 * every project. Vercel is faked.
 *
 *   npx tsx --test lib/keys/__tests__/revoke.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { revokeShared, vercelRevokeApi, type RevokeApi } from "@/lib/keys/revoke";

function fakeApi() {
  const env: Record<string, Array<{ id: string; key: string }>> = {
    p1: [
      { id: "e1", key: "GATEWAY_URL" },
      { id: "e2", key: "PRODUCT_TOKEN" },
      { id: "e3", key: "HF_TOKEN" },
      { id: "e4", key: "AWS_SECRET_ACCESS_KEY" },
    ],
    p2: [{ id: "e5", key: "GATEWAY_URL" }],
    p3: [{ id: "e6", key: "VERCEL_TOKEN" }],
    other: [{ id: "e7", key: "HF_TOKEN" }],
    broken: [],
  };
  const deleted: string[] = [];
  const api: RevokeApi = {
    listProjects: async () => [
      { id: "p1", name: "musemuse-one" },
      { id: "p2", name: "musemuse-two" },
      { id: "broken", name: "musemuse-broken" },
      { id: "p3", name: "musemuse-three" },
      { id: "other", name: "muse-muse" },
    ],
    listEnv: async (id) => {
      if (id === "broken") throw new Error("Vercel API GET /v9/projects/broken/env failed (500)");
      return env[id] ?? [];
    },
    deleteEnv: async (projectId, envId) => {
      deleted.push(`${projectId}/${envId}`);
    },
  };
  return { api, deleted };
}

test("a dry run lists the shared vars on product projects and removes nothing", async () => {
  const { api, deleted } = fakeApi();
  const lines: string[] = [];
  const result = await revokeShared(api, { apply: false, log: (l) => lines.push(l) });
  assert.deepEqual(deleted, []);
  assert.equal(result.checked, 4, "only musemuse-* projects, never the platform's own");
  assert.deepEqual(lines, ["would remove HF_TOKEN, AWS_SECRET_ACCESS_KEY from musemuse-one", "would remove VERCEL_TOKEN from musemuse-three"]);
  assert.deepEqual(result.failed.map((f) => f.project), ["musemuse-broken"]);
});

test("--apply removes exactly the shared names and goes on past a failing project", async () => {
  const { api, deleted } = fakeApi();
  const result = await revokeShared(api, { apply: true });
  assert.deepEqual(deleted, ["p1/e3", "p1/e4", "p3/e6"]);
  assert.equal(result.removed, 3);
  assert.equal(result.failed.length, 1);
});

test("named projects only", async () => {
  const { api, deleted } = fakeApi();
  await revokeShared(api, { apply: true, only: ["musemuse-three"] });
  assert.deepEqual(deleted, ["p3/e6"]);
});

test("the Vercel calls page through projects, send the team, and read only ids and names", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}?${url.searchParams.toString()}`);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer fake-platform-token");
    if (url.pathname === "/v10/projects") {
      return url.searchParams.get("from") === "tok2"
        ? Response.json({ projects: [{ id: "p2", name: "musemuse-two", env: [{ value: "never read" }] }], pagination: { next: null } })
        : Response.json({ projects: [{ id: "p1", name: "musemuse-one" }], pagination: { next: "tok2" } });
    }
    if (url.pathname.endsWith("/env")) return Response.json({ envs: [{ id: "e1", key: "HF_TOKEN", value: "encrypted-fake" }] });
    return new Response("", { status: 200 });
  }) as typeof fetch;
  const api = vercelRevokeApi("fake-platform-token", "team_fake", fetcher);
  assert.deepEqual(await api.listProjects(), [
    { id: "p1", name: "musemuse-one" },
    { id: "p2", name: "musemuse-two" },
  ]);
  assert.deepEqual(await api.listEnv("p1"), [{ id: "e1", key: "HF_TOKEN" }]);
  await api.deleteEnv("p1", "e1");
  assert.ok(calls.every((c) => c.includes("teamId=team_fake")));
  assert.ok(calls.some((c) => c.startsWith("DELETE /v9/projects/p1/env/e1")));
});

test("an API error names the call and status, not a value", async () => {
  const fetcher = (async () => Response.json({ error: { message: "Not authorized" } }, { status: 403 })) as typeof fetch;
  await assert.rejects(vercelRevokeApi("fake", null, fetcher).listEnv("p1"), /GET \/v9\/projects\/p1\/env failed \(403\): Not authorized/);
});
