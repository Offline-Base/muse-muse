/**
 * The polish round (lib/polish/logic.ts, lib/polish/start.ts) with fakes: its note, bounds, labels and every answer of
 * POST /api/builds/{id}/polish. Nothing reaches Neon, a workflow or Meta.
 *
 *   npx tsx --test lib/polish/__tests__/polish.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changeLabel, isPolishMessage, passedPolish, POLISH_HEADER, POLISH_LABEL, POLISH_MAX_FOCUS_CHARS, polishBudgetLine, polishEnding, polishNote, polishPlan, polishRoomLine } from "@/lib/polish/logic";
import { startPolish, type PolishDeps } from "@/lib/polish/start";

const EM_DASH = String.fromCharCode(0x2014);
const BUILD = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

describe("the polish note", () => {
  it("names both looks, /taste, the phone checks, no new features or fake data, and the full verify", () => {
    const note = polishNote();
    assert.ok(note.startsWith(POLISH_HEADER));
    for (const want of ["muse-app-ui", "meta-ui", "/taste", "44 by 44", "contrast", "cut off", "into view", "Tab bars", "no new features", "no fake or sample data", "npm run verify", "screenshot judge"]) {
      assert.ok(note.includes(want), want);
    }
    assert.ok(!note.includes(EM_DASH));
    assert.ok(!note.includes("audit"));
  });

  it("adds the caller's focus at the end, and tells a polish from a person's change", () => {
    const note = polishNote("  The tab bar clips on a 360 px phone.  ");
    assert.match(note, /findings from an audit of this product:\nThe tab bar clips on a 360 px phone\.$/);
    assert.equal(isPolishMessage(note), true);
    assert.equal(isPolishMessage("Make it dark"), false);
    assert.equal(isPolishMessage(null), false);
  });
});

describe("the polish bounds", () => {
  it("splits $4 into the product's test calls and two capped Muse Code runs, one fix round", () => {
    const plan = polishPlan(4, 10);
    assert.deepEqual(plan, { maxUsd: 4, productUsd: 0.8, roundSteps: 26, fixSteps: 14, fixRounds: 1 });
    // The build token's own budget is the ceiling for the product's share.
    assert.equal(polishPlan(40, 5).productUsd, 5);
    // Never fewer steps than a pass needs, never more than Muse Code's own cap.
    assert.equal(polishPlan(0.1, 10).roundSteps, 12);
    assert.equal(polishPlan(1000, 10).roundSteps, 200);
  });

  it("says the estimate, the budget stop and the ending plainly, with no em dash", () => {
    const plan = polishPlan(4, 10);
    const line = polishRoomLine(plan);
    assert.match(line, /^Final pass on Muse Wonder: one round of up to 26 model steps and at most 1 fix round of up to 14, estimated at no more than \$4\.00/);
    assert.match(polishBudgetLine(plan, 4.1), /spent \$4\.10 of its \$4\.00 budget, so no fix round runs/);
    assert.equal(polishEnding("live", "Live at https://x.vercel.app"), "UI pass by Muse Wonder. Live at https://x.vercel.app");
    assert.match(polishEnding("failed", "The change did not pass its checks."), /^The UI pass by Muse Wonder didn't ship, so nothing changed on the live product\. The change/);
    for (const text of [line, polishBudgetLine(plan, 1), polishEnding("failed", "x")]) assert.ok(!text.includes(EM_DASH));
  });

  it("labels a polish in the versions list and finds the newest one that shipped", () => {
    const note = polishNote();
    assert.equal(changeLabel(note, "Change"), POLISH_LABEL);
    assert.equal(changeLabel("Dark mode", "Change"), "Dark mode");
    assert.equal(changeLabel(null, "Change"), "Change");
    const rows = [
      { id: "a", kind: "refine", message: note, status: "live", startedAt: "2026-11-03T10:00:00Z" },
      { id: "b", kind: "refine", message: note, status: "failed", startedAt: "2026-11-03T12:00:00Z" },
      { id: "c", kind: "refine", message: "Dark mode", status: "live", startedAt: "2026-11-03T13:00:00Z" },
    ];
    assert.equal(passedPolish(rows)?.id, "a");
    assert.equal(passedPolish(rows.slice(1)), null);
  });
});

type Calls = { insert: unknown[]; start: string[]; failed: string[]; attached: string[] };

function deps(over: Partial<PolishDeps> = {}): { deps: PolishDeps; calls: Calls } {
  const calls: Calls = { insert: [], start: [], failed: [], attached: [] };
  return {
    calls,
    deps: {
      enabled: true,
      maxUsd: 4,
      buildTokenUsd: 10,
      findBuild: async () => ({ productId: "prod-1" }),
      findProduct: async () => ({ id: "prod-1", status: "live", sandboxName: "product-shelf-scout", museSessionId: "sess-1", rebuildOf: null }),
      lastPolish: async () => null,
      allowed: async () => ({ ok: true }),
      insert: async (input) => {
        calls.insert.push(input);
        return { buildId: "polish-1" };
      },
      start: async (id) => {
        calls.start.push(id);
        return "run-1";
      },
      attachRun: async (id) => void calls.attached.push(id),
      markStartFailed: async (id) => void calls.failed.push(id),
      ...over,
    },
  };
}

describe("POST /api/builds/{id}/polish", () => {
  it("starts one refinement on Muse Wonder with the polish note and the caller's focus", async () => {
    const { deps: d, calls } = deps();
    const res = await startPolish(d, BUILD, { focus: "Buttons are 36 px tall." });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { buildId: "polish-1", model: "muse-wonder-1.0", maxUsd: 4, roundSteps: 26, fixRounds: 1 });
    const inserted = calls.insert[0] as { message: string; buildModel: string; productId: string };
    assert.equal(inserted.buildModel, "muse-wonder-1.0");
    assert.equal(inserted.productId, "prod-1");
    assert.ok(isPolishMessage(inserted.message));
    assert.match(inserted.message, /Buttons are 36 px tall\.$/);
    assert.deepEqual(calls.start, ["polish-1"]);
    assert.deepEqual(calls.attached, ["polish-1"]);
  });

  it("is off with the flag off and at a $0 budget, and nothing starts", async () => {
    for (const over of [{ enabled: false }, { maxUsd: 0 }]) {
      const { deps: d, calls } = deps(over);
      const res = await startPolish(d, BUILD, {});
      assert.equal(res.status, over.enabled === false ? 404 : 503);
      assert.equal(calls.insert.length + calls.start.length, 0);
    }
  });

  it("checks the body", async () => {
    const { deps: d } = deps();
    assert.equal((await startPolish(d, BUILD, { focus: 4 })).status, 400);
    assert.equal((await startPolish(d, BUILD, { again: "yes" })).status, 400);
    assert.equal((await startPolish(d, BUILD, { focus: "x".repeat(POLISH_MAX_FOCUS_CHARS + 1) })).status, 400);
  });

  it("needs a shipped product with a session to resume", async () => {
    assert.equal((await startPolish(deps({ findBuild: async () => null }).deps, BUILD, {})).status, 404);
    assert.deepEqual((await startPolish(deps({ findBuild: async () => ({ productId: null }) }).deps, BUILD, {})).body, { error: "not_shipped" });
    for (const product of [{ status: "failed" }, { sandboxName: null }, { museSessionId: null }]) {
      const res = await startPolish(deps({ findProduct: async () => ({ id: "prod-1", status: "live", sandboxName: "s", museSessionId: "m", rebuildOf: null, ...product }) }).deps, BUILD, {});
      assert.equal(res.status, 409);
    }
  });

  it("is idempotent: busy while a polish or another change runs, and a second polish only with again: true", async () => {
    const running = await startPolish(deps({ lastPolish: async () => ({ buildId: "p0", status: "building" }) }).deps, BUILD, { again: true });
    assert.deepEqual(running.body, { error: "busy", buildId: "p0" });

    const done = deps({ lastPolish: async () => ({ buildId: "p0", status: "live" }) });
    const twice = await startPolish(done.deps, BUILD, {});
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error, "already_polished");
    assert.equal(done.calls.insert.length, 0);
    assert.equal((await startPolish(done.deps, BUILD, { again: true })).status, 201);

    // insertRefineBuild's own check: another build of the product runs.
    const busy = deps({ insert: async () => null });
    assert.deepEqual((await startPolish(busy.deps, BUILD, {})).body, { error: "busy" });
    assert.equal(busy.calls.start.length, 0);
  });

  it("passes the spend pause on, and fails a build whose workflow can't start", async () => {
    const paused = deps({ allowed: async () => ({ ok: false, status: 503, error: "paused" }) });
    assert.deepEqual(await startPolish(paused.deps, BUILD, {}), { status: 503, body: { error: "paused" } });
    assert.equal(paused.calls.insert.length, 0);

    const broken = deps({
      start: async () => {
        throw new Error("no workflow");
      },
    });
    assert.equal((await startPolish(broken.deps, BUILD, {})).status, 500);
    assert.deepEqual(broken.calls.failed, ["polish-1"]);
  });
});
