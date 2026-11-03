/**
 * The polish round (lib/polish/logic.ts, lib/polish/start.ts) with fakes: its note, bounds, labels and every answer of
 * POST /api/builds/{id}/polish. Nothing reaches Neon, a workflow or Meta.
 *
 *   npx tsx --test lib/polish/__tests__/polish.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changeLabel, isPolishMessage, passedPolish, POLISH_HEADER, POLISH_LABEL, POLISH_MAX_FOCUS_CHARS, polishBudgetLine, polishEnding, polishFixSteps, POLISH_MIN_USD, polishNote, polishPlan, polishRoomLine } from "@/lib/polish/logic";
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

  it("gives the fix round only what the budget has left after the product's share, and none below 6 steps", () => {
    const plan = polishPlan(4, 10);
    assert.equal(polishFixSteps(plan, 0.5), 14);
    assert.equal(polishFixSteps(plan, 2.5), 8);
    assert.equal(polishFixSteps(plan, 2.8), 0);
    assert.equal(polishFixSteps(plan, Number.NaN), 0);
    // The round's own floor fits in the smallest budget a polish starts with.
    const least = polishPlan(POLISH_MIN_USD, 10);
    assert.ok(least.productUsd + least.roundSteps * 0.08 <= POLISH_MIN_USD);
    assert.ok(polishPlan(POLISH_MIN_USD - 0.01, 10).roundSteps * 0.08 > (POLISH_MIN_USD - 0.01) * 0.8 * 0.65);
  });

  it("says the estimate, the budget stop and the ending plainly, with no em dash", () => {
    const plan = polishPlan(4, 10);
    const line = polishRoomLine(plan);
    assert.match(line, /^Final pass on Muse Wonder: one round of up to 26 model steps and at most 1 fix round of up to 14, estimated at no more than \$4\.00/);
    assert.match(polishBudgetLine(plan, 4.1), /spent \$4\.10 of its \$4\.00 budget, and a fix round wouldn't fit in what's left, so none runs\./);
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

  it("is off with the flag off, at a $0 budget and below the smallest budget, and nothing starts", async () => {
    for (const over of [{ enabled: false }, { maxUsd: 0 }, { maxUsd: 1 }]) {
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

describe("the no-worse gate (owner's rule, Nov 3)", async () => {
  const { polishBaseline, polishBaselineLine, polishBrokeLine, polishFixLines, polishJudgeNote, polishKeptLine, polishNoWorse, withoutKnownFailing } = await import("@/lib/polish/logic");
  const reqs = (states: Record<string, string>) => Object.entries(states).map(([id, state]) => ({ id, state }));
  const judge = (states: Record<string, string>, extra: Partial<{ pass: boolean; blocking: boolean; ownPass: boolean }> = {}) => ({ pass: false, blocking: false, ownPass: true, requirements: reqs(states), ...extra });

  it("reads the live build's unmet requirements in id order, and no list as unknown", () => {
    assert.deepEqual(polishBaseline(reqs({ R10: "unmet", R2: "met", R7: "unmet", R3: "unmet", R4: "cant" })), { known: true, failing: ["R3", "R7", "R10"] });
    assert.deepEqual(polishBaseline(reqs({ R1: "met" })), { known: true, failing: [] });
    for (const none of [null, undefined, []]) assert.deepEqual(polishBaseline(none), { known: false, failing: [] });
  });

  it("ships when only what failed before still fails, and the judge's own call passed", () => {
    assert.deepEqual(polishNoWorse({ verifyPassed: true, judge: judge({ R1: "met", R3: "unmet", R7: "unmet" }), failing: ["R3", "R7"] }), { ship: true, stillFailing: ["R3", "R7"], newlyFailing: [] });
    // One of the old failures fixed is still no worse.
    assert.equal(polishNoWorse({ verifyPassed: true, judge: judge({ R3: "met", R7: "unmet" }), failing: ["R3", "R7"] }).ship, true);
  });

  it("blocks on anything that passed before and fails now, or a requirement with no record", () => {
    const gate = polishNoWorse({ verifyPassed: true, judge: judge({ R1: "unmet", R3: "unmet", R9: "unmet" }), failing: ["R3"] });
    assert.deepEqual(gate, { ship: false, stillFailing: ["R3"], newlyFailing: ["R1", "R9"] });
  });

  it("blocks on a failed verify, no judge, the judge's own fail, a blocking call, or an empty baseline", () => {
    const states = { R3: "unmet" };
    assert.equal(polishNoWorse({ verifyPassed: false, judge: judge(states), failing: ["R3"] }).ship, false);
    assert.equal(polishNoWorse({ verifyPassed: true, judge: null, failing: ["R3"] }).ship, false);
    assert.equal(polishNoWorse({ verifyPassed: true, judge: judge(states, { ownPass: false }), failing: ["R3"] }).ship, false);
    assert.equal(polishNoWorse({ verifyPassed: true, judge: { pass: false, blocking: false, requirements: reqs(states) }, failing: ["R3"] }).ship, false, "no own call: unknown, so no");
    assert.equal(polishNoWorse({ verifyPassed: true, judge: judge(states, { blocking: true }), failing: ["R3"] }).ship, false);
    assert.equal(polishNoWorse({ verifyPassed: true, judge: judge(states), failing: [] }).ship, false);
    assert.equal(polishNoWorse({ verifyPassed: true, judge: { pass: false, blocking: false, ownPass: true }, failing: ["R3"] }).ship, false, "no requirement states");
  });

  it("is today's gate when the judge passed", () => {
    assert.deepEqual(polishNoWorse({ verifyPassed: true, judge: { pass: true, blocking: false }, failing: [] }), { ship: true, stillFailing: [], newlyFailing: [] });
  });

  it("says plainly what it is held to, what it broke and what it shipped with, with no em dash", () => {
    assert.equal(polishBaselineLine({ known: true, failing: [] }), null);
    assert.equal(polishBaselineLine({ known: true, failing: ["R3", "R7"] }), "The live version already fails R3 and R7. This pass can still ship if everything that passed there still passes, and those stay listed as known issues.");
    assert.match(polishBaselineLine({ known: false, failing: [] })!, /ships only if every requirement passes\.$/);
    assert.equal(polishBrokeLine(["R1", "R2", "R9"]), "This pass broke R1, R2 and R9, which passed on the live version, so it can't ship as it is.");
    assert.equal(polishKeptLine("https://x.vercel.app", ["R8"]), "Shipped as partial at https://x.vercel.app. Everything that passed on the live version still passes. R8 still fails as before, so it stays listed as known issues.");
    assert.match(polishKeptLine(null, ["R3", "R7"]), /^Finished as partial without publishing to its own link\. .* R3 and R7 still fail as before, so they stay/);
    const all = [polishBaselineLine({ known: true, failing: ["R3"] })!, polishBaselineLine({ known: false, failing: [] })!, polishBrokeLine(["R1"]), polishKeptLine("u", ["R3"]), polishJudgeNote(["R3"]), ...polishFixLines(["R3", "R7"])];
    for (const line of all) assert.ok(!line.includes(EM_DASH), line);
  });

  it("drops only the old failures' lines from the fix round's judge notes, and tells it to leave them", () => {
    const lines = ["R3 is not met: A. Its test failed.", "R30 is not met: B.", "R7 is not met: C.", "The header is clipped."];
    assert.deepEqual(withoutKnownFailing(lines, ["R3"]), ["R30 is not met: B.", "R7 is not met: C.", "The header is clipped."]);
    const fix = polishFixLines(["R3", "R7"]).join("\n");
    assert.match(fix, /^## Already failing before this pass\n\nR3 and R7 already failed on the live version before this UI pass\. Leave them as they are: don't spend steps on them/);
  });

  it("tells the judge, only on a polish with known failures, not to fail the product for them alone", async () => {
    const { judgeContent } = await import("@/lib/judge");
    const { BRIEF } = await import("@/lib/promote/__tests__/fixtures");
    const req = (n: number) => ({ id: `R${n}`, text: `Thing ${n}`, kind: "asked" as const, words: "", savesData: false, canDo: true, cantDoWhy: null });
    const brief = { ...BRIEF, requirements: [req(1), req(2), req(3)] };
    const input = { brief, references: [], screenshots: [{ url: "https://x.public.blob.vercel-storage.com/01.png", caption: "Start" }], requirementTests: [{ id: "R1", ok: true }, { id: "R2", ok: true }, { id: "R3", ok: false }] };
    const text = (parts: ReturnType<typeof judgeContent>["content"]) => parts.flatMap((p) => (p.type === "input_text" ? [p.text] : [])).join("\n");
    const told = text(judgeContent({ ...input, knownFailing: ["R3"] }).content);
    assert.ok(told.includes(polishJudgeNote(["R3"])));
    assert.match(polishJudgeNote(["R3"]), /already failed R3 before this pass\. Report it in requirements as the screens show, but don't fail the product for it alone/);
    assert.ok(!text(judgeContent(input).content).includes("UI pass on a live product"));
  });
});
