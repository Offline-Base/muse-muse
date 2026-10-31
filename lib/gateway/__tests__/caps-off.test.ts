/**
 * With every wave 3 flag off, every wave 3 gateway route answers 404 unknown_endpoint and touches no dependency
 * (docs/CAPABILITIES.md, section 1). Each unit adds its routes to ROUTES.
 *
 *   npx tsx --test lib/gateway/__tests__/caps-off.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleCapsProof, type CapsProofDeps } from "@/lib/caps/proof";
import { CAP_FLAG, CAP_IDS } from "@/lib/caps/ids";
import { env } from "@/lib/env";

/** A dependency that fails the test if anything calls it. */
const untouched = <T extends (...args: never[]) => unknown>(name: string) =>
  ((..._args: never[]) => {
    throw new Error(`${name} was called with its flag off`);
  }) as unknown as T;

const ROUTES: Array<{ path: string; call(req: Request): Promise<Response> }> = [
  // Unit 2: what the gateway saw for a build's namespace.
  {
    path: "caps/proof",
    call: (req) => handleCapsProof(req, { enabledCaps: () => env.enabledCaps, findToken: untouched<CapsProofDeps["findToken"]>("findToken"), counters: {} }),
  },
];

describe("wave 3 gateway routes with every flag off", () => {
  for (const flag of CAP_IDS.map((id) => CAP_FLAG[id])) delete process.env[flag];

  for (const route of ROUTES) {
    it(`/${route.path} answers 404 unknown_endpoint, whatever the method and token`, async () => {
      for (const method of ["GET", "POST"]) {
        const req = new Request(`https://platform.example/api/gateway/${route.path}`, {
          method,
          headers: { authorization: "Bearer mm_build_anything_anything_anything" },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        const res = await route.call(req);
        assert.equal(res.status, 404, method);
        const body = (await res.json()) as { error: { code: string; type: string } };
        assert.equal(body.error.code, "unknown_endpoint");
        assert.equal(body.error.type, "not_found_error");
      }
    });
  }
});

describe("/caps/proof with a cap on", () => {
  const token = (over: Partial<{ scope: string; buildId: string | null }> = {}) => ({ scope: "build", buildId: "11111111-1111-4111-8111-111111111111", productId: "p1", ...over });
  const get = (auth?: string) => new Request("https://platform.example/api/gateway/caps/proof", { headers: auth ? { authorization: auth } : {} });
  const deps = (t: ReturnType<typeof token> | null): CapsProofDeps => ({
    enabledCaps: () => ["data"],
    findToken: async () => t,
    counters: { data: async (buildId) => ({ rows: buildId.length > 0 ? 3 : 0 }) },
  });

  it("answers a build token tied to its build with the counters for its namespace", async () => {
    const res = await handleCapsProof(get("Bearer mm_build_x"), deps(token()));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { buildId: "11111111-1111-4111-8111-111111111111", namespace: "b:11111111-1111-4111-8111-111111111111", caps: { data: { rows: 3 } } });
  });

  it("refuses no token, a live token and a build token with no build", async () => {
    assert.equal((await handleCapsProof(get(), deps(token()))).status, 401);
    assert.equal((await handleCapsProof(get("Bearer x"), deps(null))).status, 401);
    assert.equal((await handleCapsProof(get("Bearer x"), deps(token({ scope: "live" })))).status, 403);
    assert.equal((await handleCapsProof(get("Bearer x"), deps(token({ buildId: null })))).status, 403);
  });

  it("answers 405 to a POST and 502 when a counter fails", async () => {
    const post = new Request("https://platform.example/api/gateway/caps/proof", { method: "POST", headers: { authorization: "Bearer x" } });
    assert.equal((await handleCapsProof(post, deps(token()))).status, 405);
    const failing: CapsProofDeps = { ...deps(token()), counters: { data: async () => { throw new Error("db down"); } } };
    const res = await handleCapsProof(get("Bearer x"), failing);
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "cap_failed");
  });
});
