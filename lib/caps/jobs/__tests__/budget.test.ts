/**
 * Job tokens, who they make the caller, and a job's dollars in the gateway's real model route, with Meta faked. All made-up
 * data, and no model call.
 *   npx tsx --test lib/caps/jobs/__tests__/budget.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mintJobToken, readJobToken } from "@/lib/caps/jobs/token";
import { resolveCapCaller } from "@/lib/caps/principal";
import { mintOwnerSession } from "@/lib/tools/principal";
import { fakeGateway, TEST_TOKEN } from "@/lib/gateway/__tests__/helpers";
import { handleGateway } from "@/lib/gateway/handler";
import { holdRun, type RunCounters } from "@/lib/gateway/runs";

process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper-for-jobs";

const NOW = new Date("2026-11-02T12:00:00Z");

describe("job tokens", () => {
  const productId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  const expiresAt = new Date(NOW.getTime() + 600_000);

  it("are good for their product until they expire, and name their run", () => {
    const t = mintJobToken({ productId, runId, tick: 1, attempt: 1, expiresAt });
    assert.match(t, /^jr1\./);
    assert.equal(t.split(".").length, 7);
    assert.deepEqual([readJobToken(t, { productId }, NOW)?.tick, readJobToken(t, { productId }, NOW)?.attempt], [1, 1]);
    assert.equal(readJobToken(t, { productId }, NOW)?.runId, runId);
    assert.equal(readJobToken(t, { productId }, new Date(expiresAt.getTime() + 1)), null, "expired");
    assert.equal(readJobToken(t, { productId: runId }, NOW), null, "another product");
  });

  it("refuse a forged one, a changed run or expiry, and junk", () => {
    const t = mintJobToken({ productId, runId, tick: 1, attempt: 1, expiresAt });
    const bits = t.split(".");
    assert.equal(readJobToken([...bits.slice(0, 6), "AAAA"].join("."), { productId }, NOW), null);
    assert.equal(readJobToken(["jr1", productId, "another-run", ...bits.slice(3)].join("."), { productId }, NOW), null);
    assert.equal(readJobToken(["jr1", productId, runId, "2", ...bits.slice(4)].join("."), { productId }, NOW), null, "another tick");
    assert.equal(readJobToken(["jr1", productId, runId, bits[3], "2", ...bits.slice(5)].join("."), { productId }, NOW), null, "another try");
    assert.equal(readJobToken(["jr1", productId, runId, bits[3], bits[4], String(expiresAt.getTime() + 999_999), bits[6]].join("."), { productId }, NOW), null);
    for (const junk of ["", null, undefined, "jr1", "jr1.a.b.c", t.replace("jr1", "os1")]) assert.equal(readJobToken(junk, { productId }, NOW), null);
  });

  it("from a build never pass on a live token, or on another build's", () => {
    const build = mintJobToken({ productId, runId, tick: 1, attempt: 1, buildId: "build-a", expiresAt });
    assert.equal(readJobToken(build, { productId, buildId: "build-a" }, NOW)?.runId, runId);
    assert.equal(readJobToken(build, { productId, buildId: "build-b" }, NOW), null);
    assert.equal(readJobToken(build, { productId, buildId: null }, NOW), null);
    assert.equal(readJobToken(mintJobToken({ productId, runId, tick: 1, attempt: 1, expiresAt }), { productId, buildId: "build-a" }, NOW), null);
  });

  it("make the caller a job and nobody else, whatever else the request claims", () => {
    const t = mintJobToken({ productId, runId, tick: 1, attempt: 1, expiresAt });
    const req = new Request("https://x.example", {
      headers: { "x-musemuse-job": t, "x-musemuse-visitor": "visitor-aaaaaaaaaaaaaaaa", "x-musemuse-owner": mintOwnerSession({ productId, subject: "s" }, NOW).session },
    });
    const caller = resolveCapCaller(req, { productId, scope: "live" }, NOW);
    assert.deepEqual([caller.kind, caller.job, caller.owner, caller.visitor, caller.user], ["job", runId, null, null, null]);
    const forged = resolveCapCaller(new Request("https://x.example", { headers: { "x-musemuse-job": `${t}x` } }), { productId, scope: "live" }, NOW);
    assert.deepEqual([forged.kind, forged.job], ["product", null]);
  });
});

describe("a job's dollars in the gateway's model route", () => {
  const productId = "00000000-0000-4000-8000-000000000002";
  const reply = () =>
    new Response(JSON.stringify({ id: "r1", model: "muse-wonder-1.0", usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 }, output: [] }), { status: 200, headers: { "content-type": "application/json" } });
  const call = (headers: Record<string, string>, maxOut = 100) =>
    new Request("https://platform.example/api/gateway/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "muse-wonder-1.0", input: "made-up", max_output_tokens: maxOut }),
    });
  const run = { id: "33333333-3333-4333-8333-333333333333", productId, namespace: "live", status: "running", budgetUsd: 0.1, costUsd: 0, createdAt: NOW };
  function harness(over: Partial<typeof run> = {}, dailyUsd = 5, productUsd = 1) {
    const stopped: string[] = [];
    const notices: unknown[] = [];
    const costs: number[] = [];
    const daily = new Map<string, number>();
    const gw = fakeGateway({ token: { productId, allowedModels: ["muse-wonder-1.0"] }, fetch: (async () => reply()) as typeof fetch });
    return {
      gw,
      stopped,
      notices,
      costs,
      daily,
      jobDeps: {
        getRun: async () => ({ ...run, ...over }),
        addRunCost: async (_id: string, usd: number) => void costs.push(usd),
        stopRun: async (id: string) => (stopped.push(id), true),
        addNotice: async (n: unknown) => void notices.push(n),
        dailyUsd: () => dailyUsd,
        productDailyUsd: () => productUsd,
        counterValue: async (k: string) => daily.get(k) ?? 0,
        adjustCounter: async (k: string, _w: Date, d: number) => void daily.set(k, (daily.get(k) ?? 0) + d),
      },
    };
  }
  const header = (id = run.id) => ({ "x-musemuse-job": mintJobToken({ productId, runId: id, tick: 1, attempt: 1, expiresAt: new Date(Date.now() + 600_000) }) });
  const route = async (h: ReturnType<typeof harness>) => {
    const { jobCallOf } = await import("@/lib/caps/jobs/budget");
    return { ...h.gw.deps, jobCall: (req: Request, token: { productId: string; scope: string }, now: Date) => jobCallOf(req, token, h.jobDeps, now) } as typeof h.gw.deps;
  };

  it("with no jobs wired, the header means nothing and the call goes as it did", async () => {
    const h = harness();
    const res = await handleGateway(call(header()), ["responses"], h.gw.deps);
    assert.equal(res.status, 200);
    await h.gw.settled();
    assert.equal(h.costs.length, 0);
  });

  it("a call in a run settles what it really cost on the run, and on the day's job dollars", async () => {
    const h = harness();
    const res = await handleGateway(call(header()), ["responses"], await route(h));
    assert.equal(res.status, 200);
    await res.text();
    await h.gw.settled();
    assert.equal(h.costs.length, 1, "one settle");
    const sent = new Headers(h.gw.upstreamCalls[0]!.init?.headers);
    assert.equal(sent.get("x-musemuse-job"), null, "the job token never goes to Meta");
    assert.ok(h.costs[0]! >= 0);
    assert.deepEqual(h.stopped, []);
  });

  it("a call without the header isn't part of any run", async () => {
    const h = harness();
    const res = await handleGateway(call({}), ["responses"], await route(h));
    assert.equal(res.status, 200);
    await res.text();
    await h.gw.settled();
    assert.equal(h.costs.length, 0);
  });

  it("stops the run at its dollars: the call that would pass them is refused, never sent, and the owner hears", async () => {
    const h = harness({ costUsd: 0.095 });
    const deps = await route(h);
    const spent: typeof deps = { ...deps, reserveCounter: async (key, w, amount, limit) => (key.startsWith("run-usd:") ? null : deps.reserveCounter(key, w, amount, limit)) };
    const res = await handleGateway(call(header()), ["responses"], spent);
    assert.equal(res.status, 429);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "run_limit");
    assert.equal(h.gw.upstreamCalls.length, 0);
    assert.deepEqual(h.stopped, [run.id]);
    assert.equal(h.notices.length, 1);
  });

  it("with money settled under the limit, a refused call doesn't end the run: parallel holds and one too-big estimate only wait", async () => {
    // Three parallel calls at the skill's 2,000 tokens: the third doesn't fit next to the first two's holds.
    const h = harness();
    const deps = await route(h);
    const spent: typeof deps = { ...deps, reserveCounter: async (key, w, amount, limit) => (key.startsWith("run-usd:") ? null : deps.reserveCounter(key, w, amount, limit)) };
    const parallel = await handleGateway(call(header(), 2000), ["responses"], spent);
    assert.equal(parallel.status, 429);
    assert.deepEqual([h.stopped, h.notices.length], [[], 0], "nothing is really spent");
    // $0.06 spent, then a $0.042 estimate: a smaller call still fits.
    const part = harness({ costUsd: 0.06 });
    const partDeps = await route(part);
    const partSpent: typeof partDeps = { ...partDeps, reserveCounter: async (key, w, amount, limit) => (key.startsWith("run-usd:") ? null : partDeps.reserveCounter(key, w, amount, limit)) };
    assert.equal((await handleGateway(call(header(), 2000), ["responses"], partSpent)).status, 429);
    assert.deepEqual([part.stopped, part.notices.length], [[], 0]);
  });

  it("the turn limit ends the run in its own words, not as dollars", async () => {
    const h = harness();
    const deps = await route(h);
    const out: typeof deps = { ...deps, reserveCounter: async (key, w, amount, limit) => (key.startsWith("run-turns:") ? null : deps.reserveCounter(key, w, amount, limit)) };
    const res = await handleGateway(call(header()), ["responses"], out);
    assert.equal(res.status, 429);
    assert.deepEqual(h.stopped, [run.id]);
    const [n] = h.notices as Array<{ title: string; body: string }>;
    assert.doesNotMatch(`${n!.title} ${n!.body}`, /dollar/);
    assert.match(n!.title, /model calls/);
  });

  it("holdRun says which limit refused", async () => {
    const empty: RunCounters = { reserveCounter: async () => null, adjustCounter: async () => undefined, counterValue: async () => 60 };
    const limits = { turns: 60, toolCalls: 60, usd: 0.1 };
    assert.deepEqual(await holdRun(empty, { tokenId: "t", runId: "run-aaaaaaaa", limits, now: NOW }).then((r) => !r.ok && r.reason), "turns");
    const turnsOk: RunCounters = { ...empty, reserveCounter: async (k, _w, a) => (k.startsWith("run-turns:") ? a : null) };
    assert.deepEqual(await holdRun(turnsOk, { tokenId: "t", runId: "run-aaaaaaaa", limits, toolCalls: 2, now: NOW }).then((r) => !r.ok && r.reason), "tool_calls");
    assert.deepEqual(await holdRun(turnsOk, { tokenId: "t", runId: "run-aaaaaaaa", limits, usd: 1, now: NOW }).then((r) => !r.ok && r.reason), "usd");
  });

  it("a call too big for any run is only refused: the run goes on, and can ask for fewer tokens", async () => {
    const h = harness();
    const res = await handleGateway(call(header(), 8000), ["responses"], await route(h));
    assert.equal(res.status, 429);
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /fewer output tokens/);
    assert.deepEqual([h.stopped, h.notices.length, h.gw.upstreamCalls.length], [[], 0, 0]);
    const again = await handleGateway(call(header(), 2000), ["responses"], await route(h));
    assert.equal(again.status, 200, "2,000 output tokens on Muse Wonder fits a $0.10 run");
    await again.text();
    await h.gw.settled();
  });

  it("refuses a bad token, a stopped run, and a call while the day's dollars are gone or paused", async () => {
    const bad = harness();
    assert.equal((await handleGateway(call({ "x-musemuse-job": "jr1.nope" }), ["responses"], await route(bad))).status, 403);
    const done = harness({ status: "done" });
    assert.equal((await handleGateway(call(header()), ["responses"], await route(done))).status, 429);
    const other = harness({ productId: "44444444-4444-4444-8444-444444444444" });
    assert.equal((await handleGateway(call(header()), ["responses"], await route(other))).status, 403);
    const paused = harness({}, 0);
    assert.equal((await handleGateway(call(header()), ["responses"], await route(paused))).status, 503);
    const spent = harness({}, 1);
    spent.daily.set("jobs-usd", 1_000_000);
    const over = await handleGateway(call(header()), ["responses"], await route(spent));
    assert.equal(over.status, 429);
    assert.equal(((await over.json()) as { error: { code: string } }).error.code, "budget_exceeded");
    assert.equal(spent.gw.upstreamCalls.length + paused.gw.upstreamCalls.length + bad.gw.upstreamCalls.length, 0);
  });

  it("one product stops at its own dollars for the day, and the run isn't ended by it", async () => {
    const h = harness({}, 5, 0.5);
    h.daily.set(`jobs-usd:${productId}`, 500_000);
    const over = await handleGateway(call(header()), ["responses"], await route(h));
    assert.equal(over.status, 429);
    assert.equal(((await over.json()) as { error: { code: string } }).error.code, "budget_exceeded");
    assert.deepEqual([h.gw.upstreamCalls.length, h.stopped.length], [0, 0]);
    const other = harness({ productId }, 5, 0.5);
    const ok = await handleGateway(call(header()), ["responses"], await route(other));
    assert.equal(ok.status, 200);
    await ok.text();
    await other.gw.settled();
    assert.ok((other.daily.get(`jobs-usd:${productId}`) ?? 0) > 0, "what it spent counts on the product");
    assert.ok((other.daily.get("jobs-usd") ?? 0) > 0, "and on the platform");
  });

  it("a run's counters stay in one window across hours, so a long run can't start its dollars over", async () => {
    const counters = new Map<string, number>();
    const deps: RunCounters = {
      reserveCounter: async (key, w, amount, limit) => {
        const k = `${key}@${w.getTime()}`;
        const next = (counters.get(k) ?? 0) + amount;
        if (next > limit) return null;
        counters.set(k, next);
        return next;
      },
      adjustCounter: async () => undefined,
      counterValue: async () => 0,
    };
    const { jobCallOf } = await import("@/lib/caps/jobs/budget");
    const h = harness();
    const at = async (hoursLater: number) => {
      const now = new Date(NOW.getTime() + hoursLater * 3_600_000);
      const hdr = { "x-musemuse-job": mintJobToken({ productId, runId: run.id, tick: 1, attempt: 1, expiresAt: new Date(now.getTime() + 60_000) }) };
      const j = await jobCallOf(call(hdr), { productId, scope: "live" }, h.jobDeps, now);
      assert.ok(j && !(j instanceof Response));
      return holdRun(deps, { tokenId: j.counterKey, runId: j.runId, limits: j.limits, usd: 0.06, now: j.windowAt });
    };
    assert.equal((await at(0)).ok, true);
    assert.equal((await at(5)).ok, false, "$0.12 passes $0.10, five hours later");
  });
});

