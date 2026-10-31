/**
 * The gateway's trust check and the Spark switch (docs/CAPABILITIES.md, section 7), through the real handler with the
 * gateway's fakes. No database and no Meta call.
 *
 *   npx tsx --test lib/trust/__tests__/gateway.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeGateway, gatewayRequest, json } from "@/lib/gateway/__tests__/helpers";
import { handleGateway } from "@/lib/gateway/handler";
import { trustCheck, type ProductTrust, type TrustGatewayDeps } from "@/lib/trust/gateway";

const JSON_CT = { "content-type": "application/json" };
const reply = (model: string) =>
  async () =>
    new Response(JSON.stringify({ id: "resp_1", model, output_text: "hi", usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 500 } }), {
      headers: { "content-type": "application/json" },
    });

const OWNER: ProductTrust = { takenDownAt: null, ownerId: "u1", ownerEmail: "maker@example.com", ownerIsAdmin: false, ownerBannedAt: null };

function trustDeps(over: Partial<TrustGatewayDeps> & { product?: Partial<ProductTrust> | null; spent?: number } = {}): TrustGatewayDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    productTrust: async (id) => {
      reads.push(`product:${id}`);
      return over.product === null ? null : { ...OWNER, ...over.product };
    },
    builderSpendToday: async (id) => {
      reads.push(`spend:${id}`);
      return over.spent ?? 0;
    },
    signedInCaps: over.signedInCaps ?? false,
    builderDailyUsd: over.builderDailyUsd ?? 5,
    adminEmails: over.adminEmails ?? ["admin@example.com"],
  };
}

async function call(deps: ReturnType<typeof fakeGateway>["deps"], model = "muse-spark-1.3") {
  const res = await handleGateway(gatewayRequest("responses", json({ model, input: "hi" }), JSON_CT), ["responses"], deps);
  const body = res.ok ? null : ((await res.json()) as { error: { code: string; message: string } }).error;
  return { res, body };
}

describe("trustCheck", () => {
  it("refuses a taken-down product and a banned owner's product with 403 product_disabled", async () => {
    for (const product of [{ takenDownAt: new Date() }, { ownerBannedAt: new Date() }]) {
      const res = await trustCheck({ productId: "p1", scope: "live" }, trustDeps({ product }));
      assert.equal(res?.status, 403);
      const err = ((await res!.json()) as { error: { code: string } }).error;
      assert.equal(err.code, "product_disabled");
      assert.equal(res!.headers.get("x-should-retry"), "false");
    }
  });

  it("refuses a signed-in builder's live token once their products spent the day's dollars, with 429 budget_exceeded", async () => {
    const over = await trustCheck({ productId: "p1", scope: "live" }, trustDeps({ signedInCaps: true, spent: 5 }));
    assert.equal(over?.status, 429);
    const err = ((await over!.json()) as { error: { code: string; message: string } }).error;
    assert.equal(err.code, "budget_exceeded");
    assert.match(err.message, /\$5\.00 daily Meta budget across their products/);
    assert.equal(await trustCheck({ productId: "p1", scope: "live" }, trustDeps({ signedInCaps: true, spent: 4.99 })), null);
  });

  it("pauses them at 0, and leaves build tokens, admins, the guest and the flag off alone", async () => {
    assert.equal((await trustCheck({ productId: "p1", scope: "live" }, trustDeps({ signedInCaps: true, builderDailyUsd: 0 })))?.status, 429);
    const reads = trustDeps({ signedInCaps: true, spent: 100 });
    assert.equal(await trustCheck({ productId: "p1", scope: "build" }, reads), null);
    assert.ok(!reads.reads.some((r) => r.startsWith("spend:")), "a build token's spend isn't read");
    assert.equal(await trustCheck({ productId: "p1", scope: "live" }, trustDeps({ signedInCaps: true, spent: 100, product: { ownerEmail: "admin@example.com", ownerIsAdmin: true } })), null);
    assert.equal(await trustCheck({ productId: "p1", scope: "live" }, trustDeps({ signedInCaps: true, spent: 100, product: { ownerEmail: "guest@musemuse.invalid" } })), null);
    assert.equal(await trustCheck({ productId: "p1", scope: "live" }, trustDeps({ signedInCaps: false, spent: 100 })), null);
    // An is_admin row whose email isn't in ADMIN_EMAILS any more is an ordinary builder.
    assert.equal((await trustCheck({ productId: "p1", scope: "live" }, trustDeps({ signedInCaps: true, spent: 100, product: { ownerIsAdmin: true } })))?.status, 429);
  });
});

describe("the handler with the trust check wired", () => {
  it("answers 403 for a banned owner's token before anything is forwarded or counted", async () => {
    const g = fakeGateway({ fetch: reply("muse-spark-1.3-contributor") });
    const t = trustDeps({ product: { ownerBannedAt: new Date() } });
    g.deps.trustCheck = (token) => trustCheck(token, t);
    const { res, body } = await call(g.deps);
    assert.equal(res.status, 403);
    assert.equal(body?.code, "product_disabled");
    assert.equal(g.upstreamCalls.length, 0);
    assert.equal(g.rateKeys.length, 0, "refused before the rate limits");
  });

  it("with no check wired (every trust flag off), runs as today", async () => {
    const g = fakeGateway({ fetch: reply("muse-spark-1.3-contributor") });
    assert.equal(g.deps.trustCheck, undefined);
    assert.equal((await call(g.deps)).res.status, 200);
  });
});

describe("TRUST_SPARK_TO_WONDER", () => {
  const upstreamModel = (g: ReturnType<typeof fakeGateway>) =>
    (JSON.parse(new TextDecoder().decode(g.upstreamCalls[0]!.init?.body as Uint8Array)) as { model: string }).model;

  it("runs a live token's Spark 1.3 call on Muse Wonder, says so, and meters it at Wonder's price", async () => {
    const g = fakeGateway({ fetch: reply("muse-wonder-1.0") });
    g.deps.sparkToWonder = true;
    const { res } = await call(g.deps);
    assert.equal(res.status, 200);
    await g.settled();
    assert.equal(upstreamModel(g), "muse-wonder-1.0");
    assert.match(res.headers.get("x-musemuse-note") ?? "", /Ran on muse-wonder-1\.0: muse-spark-1\.3 is retired/);
    assert.equal(g.usage[0]!.items[0]!.model, "muse-wonder-1.0");
    // Wonder: $4 per million input and $20 per million output, against Contributor's $0.10 and $0.20.
    assert.ok(Math.abs(g.usage[0]!.items[0]!.costUsd - (1000 * 4 + 500 * 20) / 1e6) < 1e-9, String(g.usage[0]!.items[0]!.costUsd));
  });

  it("keeps a build token on Contributor, flag or not, so test builds never run on Wonder for it", async () => {
    const g = fakeGateway({ token: { scope: "build" }, fetch: reply("muse-spark-1.3-contributor") });
    g.deps.sparkToWonder = true;
    assert.equal((await call(g.deps)).res.status, 200);
    assert.equal(upstreamModel(g), "muse-spark-1.3-contributor");
  });

  it("keeps a live token on Contributor with the flag off, with no note", async () => {
    const g = fakeGateway({ fetch: reply("muse-spark-1.3-contributor") });
    const { res } = await call(g.deps);
    assert.equal(upstreamModel(g), "muse-spark-1.3-contributor");
    assert.equal(res.headers.get("x-musemuse-note"), null);
  });

  it("estimates the Wonder call at Wonder's price, so the daily budget refuses what it can't cover", async () => {
    const g = fakeGateway({ tokenSpend: 2.99, fetch: reply("muse-wonder-1.0") });
    g.deps.sparkToWonder = true;
    const res = await handleGateway(gatewayRequest("responses", json({ model: "muse-spark-1.3", input: "hi", max_output_tokens: 4000 }), JSON_CT), ["responses"], g.deps);
    assert.equal(res.status, 429);
    assert.equal(g.upstreamCalls.length, 0);
  });
});
