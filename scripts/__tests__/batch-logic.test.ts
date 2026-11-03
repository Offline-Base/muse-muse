/**
 * The batch tools' pure parts: batch files, the build status answer, the spend ledger, the polish answer and queue,
 * and focus files (scripts/batch/logic.ts, scripts/spend-ledger.ts, scripts/polish-batch.ts). Made-up ids, no network.
 *   npx tsx --test scripts/__tests__/batch-logic.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  batchBuilds,
  focusFor,
  focusMap,
  ledgerOf,
  ledgerTable,
  mapLimit,
  MAX_FOCUS_CHARS,
  nextState,
  parseBuildStatus,
  parsePolishAnswer,
  planStarts,
  queueDone,
  refineIdsFrom,
  type BuildView,
  type PolishItem,
} from "../batch/logic";
import { applyAnswer, initialItems, MAX_ATTEMPTS, readRound } from "../polish-batch";
import { collectLedger } from "../spend-ledger";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SITE = "https://www.example.com";
const now = new Date("2026-11-03T18:00:00Z");

function answer(n: number, o: { status?: string; kind?: string; cost?: unknown; latest?: string | null; slug?: string } = {}) {
  return {
    build: { id: id(n), kind: o.kind ?? "build", status: o.status ?? "building", costUsd: o.cost ?? 0.25, productId: id(900 + n), error: null },
    product: { id: id(900 + n), slug: o.slug ?? `prod-${n}`, name: `Prod ${n}`, liveUrl: `https://prod-${n}.example.app`, status: "live", latestBuildId: o.latest ?? null },
    inspiration: null,
    viewer: { signedIn: false, isOwner: false, isAdmin: false },
  };
}
const view = (n: number, o: Parameters<typeof answer>[1] = {}) => parseBuildStatus(id(n), 200, answer(n, o)) as BuildView;
const item = (n: number, state: PolishItem["state"], extra: Partial<PolishItem> = {}): PolishItem => ({ label: `b${n}`, buildId: id(n), state, refineIds: [], attempts: 0, ...extra });

describe("batch files", () => {
  it("takes started builds from demo-batch files and bare ids, once each, and skips notes that failed to start", () => {
    const files = [
      { path: "a.json", json: { site: SITE, started: [{ id: "tutor", buildId: id(1) }, { id: "broken", error: { status: 429 } }] } },
      { path: "b.json", json: { site: SITE, started: [{ id: "tutor-again", buildId: id(1) }, { id: "games", buildId: id(2) }] } },
    ];
    assert.deepEqual(batchBuilds(files, [id(3), id(2)]), [
      { label: "tutor", buildId: id(1) },
      { label: "games", buildId: id(2) },
      { label: id(3), buildId: id(3) },
    ]);
  });
  it("refuses a file of another shape and an id that isn't one", () => {
    assert.throws(() => batchBuilds([{ path: "x.json", json: { builds: [] } }]), /x\.json has no "started" list/);
    assert.throws(() => batchBuilds([], ["tutor"]), /tutor isn't a build id/);
  });
});

describe("build status", () => {
  it("reads status, cost, product and its latest build", () => {
    const v = view(1, { status: "partial", cost: 0.31, latest: id(7) });
    assert.equal(v.status, "partial");
    assert.equal(v.terminal, true);
    assert.equal(v.shipped, true);
    assert.equal(v.costUsd, 0.31);
    assert.equal(v.slug, "prod-1");
    assert.equal(v.liveUrl, "https://prod-1.example.app");
    assert.equal(v.latestBuildId, id(7));
  });
  it("keeps running, failed and refine builds apart, and reads a cost sent as a string", () => {
    assert.equal(view(1, { status: "verifying" }).terminal, false);
    const failed = view(1, { status: "failed" });
    assert.equal(failed.terminal && !failed.shipped, true);
    assert.equal(view(1, { kind: "refine" }).kind, "refine");
    assert.equal(view(1, { cost: "0.5" }).costUsd, 0.5);
    assert.equal(view(1, { cost: undefined }).costUsd, 0.25);
    assert.equal((parseBuildStatus(id(1), 200, { build: { status: "live" } }) as BuildView).costUsd, null);
  });
  it("turns a missing build, a network failure or another shape into an error, never 'still building'", () => {
    assert.deepEqual(parseBuildStatus(id(1), 404, { error: "not_found" }), { error: "not_found" });
    assert.match((parseBuildStatus(id(1), 0, { message: "ECONNRESET" }) as { error: string }).error, /network: ECONNRESET/);
    assert.deepEqual(parseBuildStatus(id(1), 500, null), { error: "status 500" });
    assert.deepEqual(parseBuildStatus(id(1), 200, { ok: true }), { error: "the answer has no build status" });
  });
});

describe("spend ledger", () => {
  it("adds builds and refinements, counts a refinement once, and says what is left", () => {
    const l = ledgerOf(
      [
        { label: "a", buildId: id(1), slug: "a", status: "live", buildCostUsd: 0.4, refinements: [{ buildId: id(11), status: "live", costUsd: 1.1 }, { buildId: id(11), status: "live", costUsd: 1.1 }] },
        { label: "b", buildId: id(2), slug: "b", status: "building", buildCostUsd: 0.2, refinements: [] },
      ],
      2,
    );
    assert.equal(l.rows[0].totalUsd, 1.5);
    assert.equal(l.spentUsd, 1.7);
    assert.equal(l.remainingUsd, 0.3);
    assert.equal(l.over, false);
    assert.equal(l.unknownCount, 0);
  });
  it("is over past the budget, and marks a row whose cost the API didn't give", () => {
    const l = ledgerOf([{ label: "a", buildId: id(1), slug: null, status: "live", buildCostUsd: 3, refinements: [{ buildId: id(11), status: null, costUsd: null }] }], 2.5);
    assert.equal(l.over, true);
    assert.equal(l.remainingUsd, -0.5);
    assert.equal(l.rows[0].unknown, true);
    const table = ledgerTable(l);
    assert.match(table, /Over by \$0\.50/);
    assert.match(table, /\$3\.00\*/);
    assert.match(table, /may be low/);
    assert.doesNotMatch(table, /—/);
  });
  it("collects from the status route: refinements from polish files and the product's newer latest build", async () => {
    const answers = new Map<string, BuildView>([
      [id(1), view(1, { status: "live", cost: 0.3, latest: id(12) })],
      [id(11), { ...view(11, { kind: "refine", status: "failed", cost: 0.9 }), buildId: id(11) }],
      [id(12), { ...view(12, { kind: "refine", status: "live", cost: 1.2 }), buildId: id(12) }],
      [id(2), view(2, { status: "building", cost: 0.1, latest: id(2) })],
    ]);
    const seen: string[] = [];
    const fetch = async (b: string) => (seen.push(b), answers.get(b) ?? { error: "not_found" });
    const l = await collectLedger([{ label: "a", buildId: id(1) }, { label: "b", buildId: id(2) }], new Map([[id(1), [id(11)]]]), fetch, 200);
    assert.equal(l.spentUsd, 2.5);
    assert.deepEqual(l.rows[0].refinements.map((r) => r.buildId), [id(11), id(12)]);
    assert.equal(l.rows[1].refinements.length, 0, "a latest build that is the batch's own build isn't a refinement");
    assert.equal(l.remainingUsd, 197.5);
    assert.equal(new Set(seen).size, seen.length, "each id is read once");
  });
  it("reads refinement ids out of polish files", () => {
    const m = refineIdsFrom([{ items: [{ buildId: id(1), refineIds: [id(11), "nope"] }] }, { items: [{ buildId: id(1), refineIds: [id(11), id(12)] }] }, { other: true }]);
    assert.deepEqual(m.get(id(1)), [id(11), id(12)]);
  });
});

describe("polish answer", () => {
  it("takes the refinement id(s) a 201 names", () => {
    assert.deepEqual(parsePolishAnswer(201, { buildId: id(5) }, SITE), { kind: "started", refineIds: [id(5)] });
    assert.deepEqual(parsePolishAnswer(201, { passes: [{ buildId: id(5) }, id(6)] }, SITE), { kind: "started", refineIds: [id(5), id(6)] });
    assert.deepEqual(parsePolishAnswer(202, { runId: "r1" }, SITE), { kind: "started", refineIds: [] });
    assert.deepEqual(parsePolishAnswer(201, { buildId: id(5), maxUsd: 4 }, SITE), { kind: "started", refineIds: [id(5)], maxUsd: 4 });
  });
  it("stops on a route that isn't deployed or is switched off, never marking the build refused", () => {
    const missing = parsePolishAnswer(404, {}, SITE);
    assert.equal(missing.kind, "route_missing");
    assert.match((missing as { message: string }).message, /polish route isn't deployed on https:\/\/www\.example\.com yet/);
    const off = parsePolishAnswer(404, { error: "not_found" }, SITE);
    assert.equal(off.kind, "route_missing");
    assert.match((off as { message: string }).message, /POLISH_ENABLED/);
  });
  it("follows a 409 that names the product's polish instead of retrying or polishing again", () => {
    assert.deepEqual(parsePolishAnswer(409, { error: "already_polished", buildId: id(7), status: "live" }, SITE), { kind: "adopt", refineIds: [id(7)], reason: "already_polished" });
    assert.deepEqual(parsePolishAnswer(409, { error: "busy", buildId: id(8) }, SITE), { kind: "adopt", refineIds: [id(8)], reason: "busy" });
    const a = item(1, "ready");
    assert.deepEqual(applyAnswer(a, { status: 409, json: { error: "already_polished", buildId: id(7) } }, SITE, now), {});
    assert.equal(a.state, "polishing");
    assert.deepEqual(a.refineIds, [id(7)]);
    assert.equal(a.attempts, 0);
  });
  it("stops the run when the site has polish spending off", () => {
    assert.equal(parsePolishAnswer(503, { error: "polish_budget_off", message: "POLISH_MAX_USD is 0" }, SITE).kind, "fatal");
    assert.equal(applyAnswer(item(1, "ready"), { status: 503, json: { error: "polish_budget_off" } }, SITE, now).stop?.exitCode, 1);
  });
  it("retries busy, rate limits and server errors, and stops on a refused key", () => {
    assert.deepEqual(parsePolishAnswer(409, { error: "busy" }, SITE), { kind: "retry", reason: "409 busy", afterSeconds: 60 });
    assert.deepEqual(parsePolishAnswer(429, { error: "daily_limit", retryAfterSeconds: 900 }, SITE), { kind: "retry", reason: "429 daily_limit", afterSeconds: 900 });
    assert.equal(parsePolishAnswer(503, { error: "paused" }, SITE).kind, "retry");
    assert.equal(parsePolishAnswer(401, { error: "unauthorized" }, SITE).kind, "fatal");
    assert.equal(parsePolishAnswer(400, { error: "bad focus" }, SITE).kind, "refused");
  });
  it("applies an answer to its item", () => {
    const a = item(1, "ready");
    assert.deepEqual(applyAnswer(a, { status: 201, json: { buildId: id(11) } }, SITE, now), {});
    assert.equal(a.state, "polishing");
    assert.deepEqual(a.refineIds, [id(11)]);

    const busy = item(2, "ready");
    applyAnswer(busy, { status: 409, json: { error: "busy" } }, SITE, now);
    assert.equal(busy.state, "ready");
    assert.equal(busy.notBefore, "2026-11-03T18:01:00.000Z");

    const limited = item(3, "ready");
    assert.deepEqual(applyAnswer(limited, { status: 429, json: { retryAfterSeconds: 120 } }, SITE, now), { pauseUntil: new Date("2026-11-03T18:02:00Z") });

    const tired = item(4, "ready", { attempts: MAX_ATTEMPTS - 1 });
    applyAnswer(tired, { status: 409, json: { error: "busy" } }, SITE, now);
    assert.equal(tired.state, "refused");

    const missing = item(5, "ready");
    assert.equal(applyAnswer(missing, { status: 404, json: {} }, SITE, now).stop?.exitCode, 2);
    assert.equal(missing.state, "ready", "a missing route leaves the build to polish on a later run");

    const untracked = item(6, "ready");
    applyAnswer(untracked, { status: 202, json: {} }, SITE, now);
    assert.equal(untracked.state, "polishing");
    assert.equal(untracked.untrackedUntil, "2026-11-03T18:30:00.000Z");
  });
});

describe("polish queue", () => {
  it("moves items by their build and refinement statuses", () => {
    assert.equal(nextState(item(1, "waiting"), view(1, { status: "building" }), [], now), "waiting");
    assert.equal(nextState(item(1, "waiting"), view(1, { status: "live" }), [], now), "ready");
    assert.equal(nextState(item(1, "waiting"), view(1, { status: "failed" }), [], now), "skipped");
    assert.equal(nextState(item(1, "waiting"), { error: "not_found" }, [], now), "error");
    assert.equal(nextState(item(1, "waiting"), { error: "network: x" }, [], now), "waiting", "a network blip keeps the state");
    const p = item(1, "polishing", { refineIds: [id(11)] });
    assert.equal(nextState(p, view(1, { status: "live" }), [view(11, { kind: "refine", status: "verifying" })], now), "polishing");
    assert.equal(nextState(p, view(1, { status: "live" }), [view(11, { kind: "refine", status: "live" })], now), "polished");
    assert.equal(nextState(p, view(1, { status: "live" }), [view(11, { kind: "refine", status: "failed" })], now), "polish_failed");
    assert.equal(nextState(p, view(1, { status: "live" }), [], now), "polishing", "an unread refinement is still in flight");
    assert.equal(nextState(item(1, "polishing", { untrackedUntil: "2026-11-03T18:10:00Z" }), view(1, { status: "live" }), [], now), "polishing");
    assert.equal(nextState(item(1, "refused"), view(1, { status: "live" }), [], now), "refused");
  });
  it("starts up to the concurrency limit", () => {
    const items = [item(1, "polishing"), item(2, "ready"), item(3, "ready"), item(4, "ready"), item(5, "waiting")];
    const move = planStarts(items, { concurrency: 3, budgetUsd: 200, reserveUsd: 2, spentUsd: 10, now });
    assert.deepEqual(move.start.map((i) => i.buildId), [id(2), id(3)]);
    assert.equal(move.held, "concurrency");
    assert.equal(move.inFlight, 1);
  });
  it("holds the reserve for each polish in flight and the next one, and stops at the budget", () => {
    const items = [item(1, "polishing"), item(2, "ready"), item(3, "ready")];
    // 195 spent + 2 for the one in flight + 2 for the next = 199: one starts; a second would need 201.
    const move = planStarts(items, { concurrency: 8, budgetUsd: 200, reserveUsd: 2, spentUsd: 195, now });
    assert.deepEqual(move.start.map((i) => i.buildId), [id(2)]);
    assert.equal(move.held, "budget");
    const none = planStarts([item(2, "ready")], { concurrency: 8, budgetUsd: 200, reserveUsd: 2, spentUsd: 199, now });
    assert.deepEqual(none.start, []);
    assert.equal(none.held, "budget");
    assert.equal(queueDone([item(2, "ready")], none), true, "nothing in flight and the budget used: done");
  });
  it("holds a polish's own cap when its answer named one, and that cap for the next start", () => {
    const items = [item(1, "polishing", { maxUsd: 4 }), item(2, "ready"), item(3, "ready")];
    // 190 spent + 4 in flight + 4 for the next = 198: one starts; a second would need 202, though a $2 reserve allowed it.
    const move = planStarts(items, { concurrency: 8, budgetUsd: 200, reserveUsd: 2, spentUsd: 190, now });
    assert.deepEqual(move.start.map((i) => i.buildId), [id(2)]);
    assert.equal(move.held, "budget");
    // Eight at once can never pass the budget by more than they already spent: 8 x $4 held from $168.
    const eight = Array.from({ length: 10 }, (_, k) => item(10 + k, "ready"));
    const m8 = planStarts(eight, { concurrency: 8, budgetUsd: 200, reserveUsd: 4, spentUsd: 168, now });
    assert.equal(m8.start.length, 8);
    assert.equal(planStarts(eight, { concurrency: 8, budgetUsd: 200, reserveUsd: 4, spentUsd: 168.5, now }).start.length, 7);
  });
  it("waits out a pause and an item's notBefore", () => {
    const items = [item(2, "ready", { notBefore: "2026-11-03T18:05:00Z" }), item(3, "ready")];
    assert.deepEqual(planStarts(items, { concurrency: 8, budgetUsd: 200, reserveUsd: 2, spentUsd: 0, now }).start.map((i) => i.buildId), [id(3)]);
    const paused = planStarts(items, { concurrency: 8, budgetUsd: 200, reserveUsd: 2, spentUsd: 0, now, pausedUntil: new Date("2026-11-03T18:03:00Z") });
    assert.equal(paused.held, "paused");
    assert.equal(queueDone(items, paused), false);
  });
  it("is done only when nothing waits, flies or can still start", () => {
    const empty = { start: [], inFlight: 0 };
    assert.equal(queueDone([item(1, "polished"), item(2, "skipped")], empty), true);
    assert.equal(queueDone([item(1, "polished"), item(2, "waiting")], empty), false);
    assert.equal(queueDone([item(1, "polishing")], { start: [], inFlight: 1, held: "budget" }), false);
  });
  it("resumes without polishing a build twice", () => {
    const resumed = [item(1, "polishing", { refineIds: [id(11)] }), item(2, "ready")];
    const items = initialItems([{ label: "one", buildId: id(1) }, { label: "two", buildId: id(2) }, { label: "three", buildId: id(3) }], resumed);
    assert.deepEqual(items.map((i) => [i.label, i.state, i.refineIds]), [["one", "polishing", [id(11)]], ["two", "waiting", []], ["three", "waiting", []]]);
  });
  it("reads a round: ready builds, finished refinements, and the ledger with them", async () => {
    const answers = new Map<string, BuildView>([
      [id(1), view(1, { status: "live", cost: 0.3 })],
      [id(2), view(2, { status: "live", cost: 0.4, latest: id(21) })],
      [id(21), { ...view(21, { kind: "refine", status: "live", cost: 1 }), buildId: id(21) }],
      [id(3), view(3, { status: "refused", cost: 0.01 })],
    ]);
    const builds = [{ label: "a", buildId: id(1) }, { label: "b", buildId: id(2) }, { label: "c", buildId: id(3) }];
    const items = initialItems(builds, [item(2, "polishing", { refineIds: [id(21)] })]);
    const cache = new Map();
    const reads: string[] = [];
    const fetch = async (b: string) => (reads.push(b), answers.get(b) ?? { error: "not_found" });
    const l = await readRound(items, builds, cache, fetch, 200, now);
    assert.deepEqual(items.map((i) => i.state), ["ready", "polished", "skipped"]);
    assert.equal(l.spentUsd, 1.71);
    assert.equal(items[1].refineStatus?.[id(21)], "live");
    reads.length = 0;
    await readRound(items, builds, cache, fetch, 200, now);
    assert.deepEqual(reads, [id(1)], "the next round reads only what can still change");
  });
});

describe("focus files", () => {
  it("takes failing products' focus from an audit file, by build id and slug", () => {
    const m = focusMap({ products: [{ buildId: id(1), slug: "a", pass: false, focus: " Fix the tap targets. " }, { buildId: id(2), slug: "b", pass: true, focus: "ignored" }] });
    assert.equal(m.get(id(1)), "Fix the tap targets.");
    assert.equal(m.get("a"), "Fix the tap targets.");
    assert.equal(m.has(id(2)), false);
    assert.equal(focusFor(m, { buildId: id(9), slug: "a" }), "Fix the tap targets.");
  });
  it("takes a plain map, cuts long text, and refuses another shape", () => {
    const m = focusMap({ [id(1)]: "x".repeat(MAX_FOCUS_CHARS + 50) });
    assert.equal(focusFor(m, { buildId: id(1) })!.length, MAX_FOCUS_CHARS);
    assert.equal(focusFor(m, { buildId: id(2) }), undefined);
    assert.throws(() => focusMap(["a"]), /must be an audit file/);
  });
});

describe("mapLimit", () => {
  it("keeps order and never runs more than the limit at once", async () => {
    let running = 0;
    let most = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (x) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, x));
      running -= 1;
      return x * 10;
    });
    assert.deepEqual(out, [50, 10, 40, 20, 30]);
    assert.equal(most, 2);
  });
});
