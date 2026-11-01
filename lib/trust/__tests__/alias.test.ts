/**
 * A takedown's calls to Vercel (lib/trust/alias.ts) against a fake fetch: the project pause and unpause that block the
 * whole site, and the domain calls that back them up. No network.
 *
 *   npx tsx --test lib/trust/__tests__/alias.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productAlias } from "@/lib/trust/alias";

function fake(answer: (method: string, url: URL) => Response = () => new Response(null, { status: 200 })) {
  const calls: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.href, auth: new Headers(init?.headers).get("authorization"), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return answer(method, url);
  }) as typeof globalThis.fetch;
  return { calls, alias: productAlias({ token: "test-vercel-token", teamId: "team_1", fetch }) };
}

describe("a takedown's Vercel calls", () => {
  it("pause and unpause the whole project, in the team, with no body", async () => {
    const { calls, alias } = fake();
    await alias.pause("prj_1");
    await alias.unpause("prj_1");
    assert.deepEqual(calls, [
      { method: "POST", url: "https://api.vercel.com/v1/projects/prj_1/pause?teamId=team_1", auth: "Bearer test-vercel-token", body: undefined },
      { method: "POST", url: "https://api.vercel.com/v1/projects/prj_1/unpause?teamId=team_1", auth: "Bearer test-vercel-token", body: undefined },
    ]);
  });

  it("throws with Vercel's reason when pausing fails, so the takedown can fall back to the domain", async () => {
    const { alias } = fake(() => Response.json({ error: { message: "Project not found" } }, { status: 400 }));
    await assert.rejects(alias.pause("prj_1"), /Vercel API pausing the project failed \(400\): Project not found/);
    await assert.rejects(alias.unpause("prj_1"), /unpausing the project failed \(400\)/);
  });

  it("counts a domain that's already gone as removed and one that's already there as restored", async () => {
    const { calls, alias } = fake((method) => new Response(null, { status: method === "DELETE" ? 404 : 409 }));
    await alias.remove("prj_1", "musemuse-demo.vercel.app");
    await alias.restore("prj_1", "musemuse-demo.vercel.app");
    assert.equal(calls[0]!.url, "https://api.vercel.com/v9/projects/prj_1/domains/musemuse-demo.vercel.app?teamId=team_1");
    assert.deepEqual(calls[1]!.body, { name: "musemuse-demo.vercel.app" });
  });
});
