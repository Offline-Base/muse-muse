/** FULL_BUILDS (docs/FULL_BUILDS.md): npx tsx --test lib/full/__tests__/full-builds.test.ts. Fakes only: no model call. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { goalObjective, renderBuildPrompt, renderFixPrompt } from "@/lib/brief/render";
import { BriefSchema, newBriefSchemaFor, NewBriefSchema, type Brief } from "@/lib/brief/schema";
import { normalizeRawBrief } from "@/lib/brief/normalize";
import { pickScreenshots, withRequirements } from "@/lib/judge";
import { fullMilestones, latestChecklist, nameWhatItCantDo, normalizeRequirements, requirementProblems, requirementResults, requirementsFile, type Requirement, unmetLines, wordsLeftOut } from "@/lib/full/requirements";
import { enforceScope, scopeLine, scopePlanText, SCOPE_INSTRUCTIONS, uncoveredAsks } from "@/lib/full/scope";
import { env } from "@/lib/env";
import { decideOutcome } from "@/lib/pipeline/logic";
import { fullChecksReserveMs, fullRoundCap, fullRoundPlan } from "@/lib/pipeline/steps";
import { briefInstructions } from "@/lib/prompts/brief";
import { judgeInstructions } from "@/lib/prompts/judge";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const req = (n: number, over: Partial<Requirement> = {}): Requirement => ({ id: `R${n}`, text: `Thing ${n}`, kind: "needed", words: "", savesData: false, canDo: true, cantDoWhy: null, ...over });
const many = (n: number) => Array.from({ length: n }, (_, i) => req(i + 1));
const FULL = { ...BRIEF, requirements: many(9) } as Brief;

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.MUSE_APP_LOOK;
  process.env.MUSE_APP_LOOK = "1";
});
afterEach(() => {
  if (saved === undefined) delete process.env.MUSE_APP_LOOK;
  else process.env.MUSE_APP_LOOK = saved;
});

describe("the flag", () => {
  it("is off by default, and off the writer's schema is the same object as before", () => {
    delete process.env.FULL_BUILDS;
    assert.equal(env.fullBuilds, false);
    assert.equal(newBriefSchemaFor({ gadgets: true, targets: [] }), NewBriefSchema);
    assert.ok(!briefInstructions({}).includes("Requirements\n"));
  });
  it("holds the wall between 90 and 150, 120 by default", () => {
    delete process.env.FULL_BUILD_WALL_MINUTES;
    assert.equal(env.fullBuildWallMinutes, 150);
    process.env.FULL_BUILD_WALL_MINUTES = "500";
    assert.equal(env.fullBuildWallMinutes, 150);
    delete process.env.FULL_BUILD_WALL_MINUTES;
  });
});

describe("the writer", () => {
  it("drops the small-product wording", () => {
    const text = briefInstructions({ fullBuilds: true });
    assert.ok(text.includes("Never shrink a request"));
    assert.ok(!text.includes("one to three screens"));
    assert.ok(!text.includes("two to six short steps"));
    assert.ok(!text.includes("actions are one to three"));
    assert.ok(!text.includes("—"));
  });
  it("takes past the old limits, and the normalizer keeps them", () => {
    const raw = { ...BRIEF, primaryFlow: Array(20).fill("Step"), screens: Array(12).fill({ name: "S", purpose: "P" }), requirements: [{ text: "One" }, { text: "" }, { text: "Two", canDo: false }] };
    const out = normalizeRawBrief(raw, [], { fullBuilds: true }) as Brief;
    assert.equal(out.primaryFlow.length, 20);
    assert.equal(out.screens.length, 12);
    assert.deepEqual(out.requirements!.map((r) => r.id), ["R1", "R2"]);
    assert.ok(out.requirements![1]!.cantDoWhy);
    assert.equal(newBriefSchemaFor({ gadgets: true, targets: [], fullBuilds: true }).safeParse(out).success, true);
    assert.equal(BriefSchema.safeParse(out).success, true);
    const off = normalizeRawBrief(raw, []) as Brief;
    assert.equal(off.screens.length, 5);
  });
  it("names a part it can't do, as a limit and a partly verdict", () => {
    const b = nameWhatItCantDo({ verdict: "yes" as const, limits: [], requirements: [req(1, { canDo: false, cantDoWhy: "No accounts yet.", text: "Sign in" })] });
    assert.equal(b.verdict, "partly");
    assert.match(b.limits[0]!, /Can't do: Sign in\. No accounts yet\./);
  });
  it("code sends back a list with no navigation, edit, delete, reload, empty or error", () => {
    const problems = requirementProblems({ verdict: "yes", screens: [{}, {}], requirements: [req(1, { savesData: true, text: "Add a trip" })] }, null);
    assert.equal(problems.length, 6);
    assert.deepEqual(requirementProblems({ verdict: "no", screens: [], requirements: [] }, null), []);
  });
  it("code sends back words that aren't in the note", () => {
    const r = [req(1, { kind: "asked", words: "track my invoices", text: "Handle errors" })];
    assert.match(requirementProblems({ verdict: "yes", screens: [], requirements: r }, "I want a garden planner").join(), /R1: words must be copied/);
    assert.deepEqual(requirementProblems({ verdict: "yes", screens: [], requirements: r }, "please Track my invoices!"), []);
  });
  it("finds a note's words the plan left out", () => {
    assert.deepEqual(wordsLeftOut("track invoices and clients", "Invoice list"), ["track", "clients"]);
  });
});

describe("the independent check", () => {
  const brief = { name: "X", primaryFlow: ["a"], screens: [], limits: [], requirements: [req(1)] };
  const covered = { asks: [{ ask: "thing", coveredBy: ["R1"], covered: true }] };
  const open = { asks: [{ ask: "invoices", coveredBy: [], covered: false }] };
  it("has no build context", () => {
    assert.ok(!/template|muse code|next\.js|gateway|sandbox/i.test(SCOPE_INSTRUCTIONS + scopePlanText(brief)));
  });
  it("doesn't believe a covered claim with an id the plan doesn't have", () => {
    assert.deepEqual(uncoveredAsks({ asks: [{ ask: "x", coveredBy: ["R99"], covered: true }] }, brief), ["x"]);
  });
  it("sends a shrunken brief back and takes the rewrite", async () => {
    let rewrites = 0;
    const replies = [open, covered];
    const out = await enforceScope({
      brief,
      note: null,
      run: async () => ({ reply: replies.shift()!, usage: [] }),
      rewrite: async (b, problems) => {
        rewrites++;
        assert.match(problems[0]!, /invoices/);
        return { brief: { ...b, name: "Rewritten" }, usage: [] };
      },
    });
    assert.equal(rewrites, 1);
    assert.equal(out.brief.name, "Rewritten");
    assert.equal(out.brief.scopeCheck.sentBack, 1);
  });
  it("adds what's still missing after two send-backs, so nothing is dropped", async () => {
    const out = await enforceScope({ brief, note: null, run: async () => ({ reply: open, usage: [] }), rewrite: async (b) => ({ brief: b, usage: [] }) });
    assert.equal(out.brief.scopeCheck.sentBack, 2);
    assert.deepEqual(out.brief.requirements!.map((r) => r.text), ["Thing 1", "invoices"]);
    assert.match(scopeLine(out.brief.scopeCheck), /invoices/);
  });
  it("records a check that couldn't run", async () => {
    const out = await enforceScope({ brief, note: null, run: async () => { throw new Error("down"); }, rewrite: async (b) => ({ brief: b, usage: [] }) });
    assert.equal(out.brief.scopeCheck.ran, false);
    assert.equal(out.failure, "down");
    assert.match(scopeLine(out.brief.scopeCheck), /could not run/);
  });
});

describe("the build prompt", () => {
  const opts = { inspoFiles: [], fixtures: [], maxModelSteps: 200, museAppLook: true };
  it("is only different when asked for, even with requirements stored", () => {
    assert.equal(renderBuildPrompt(FULL, opts), renderBuildPrompt(BRIEF as Brief, opts));
    assert.equal(goalObjective(FULL), goalObjective(BRIEF as Brief));
  });
  it("lists every requirement, in milestones, with no first-flow-only wording", () => {
    const text = renderBuildPrompt(FULL, { ...opts, fullBuild: true });
    for (let i = 1; i <= 9; i++) assert.ok(text.includes(`**R${i}**`), `R${i}`);
    assert.ok(text.includes("## Milestones"));
    assert.ok(!text.includes("if at all"));
    assert.ok(!text.includes("under 5 model calls"));
    assert.match(text, /4\. Every requirement has its own test/);
    assert.ok(goalObjective(FULL, { fullBuild: true }).length <= 1000);
  });
  it("keeps every requirement across milestones, at most six", () => {
    for (const n of [1, 4, 5, 9, 24, 60]) {
      const ms = fullMilestones({ requirements: many(n) });
      assert.ok(ms.length <= 6);
      assert.deepEqual(ms.flatMap((m) => m.requirementIds), many(n).map((r) => r.id));
    }
  });
  it("verify's list grows by milestone, and leaves out what can't be done", () => {
    const b = { requirements: [...many(8), req(9, { canDo: false })] };
    assert.equal(JSON.parse(requirementsFile(b, 1)).requirements.length, 4);
    assert.equal(JSON.parse(requirementsFile(b)).requirements.length, 8);
  });
  it("the fix prompt asks for a shot per requirement only on a full build", () => {
    const input = { verify: null, judge: { pass: false, reasons: ["r"], mismatches: ["m"] }, round: 1 };
    assert.match(renderFixPrompt(input), /2 to 4 numbered/);
    assert.match(renderFixPrompt({ ...input, fullBuild: true }), /one numbered screenshot for each requirement/);
  });
});

describe("time", () => {
  const plan = fullRoundPlan({ requirements: 12 }, [], { wallMinutes: 120 });
  const MIN = 60_000;
  it("verify's cap grows with the requirements, within reason", () => {
    assert.equal(fullRoundPlan({ requirements: 1 }, [], { wallMinutes: 90 }).verifyMs, 12 * MIN);
    assert.equal(fullRoundPlan({ requirements: 60 }, [], { wallMinutes: 90 }).verifyMs, 25 * MIN);
  });
  it("shares what's left among the milestones not yet built, keeping the checks' reserve", () => {
    const left = 120 * MIN - fullChecksReserveMs(plan);
    assert.equal(fullRoundCap({ plan, startedAt: 0, now: 0, milestonesLeft: 3 }), left / 3);
    assert.equal(fullRoundCap({ plan, startedAt: 0, now: 40 * MIN, milestonesLeft: 1 }), Math.min(60 * MIN, left - 40 * MIN));
    assert.equal(fullRoundCap({ plan, startedAt: 0, now: 119 * MIN, milestonesLeft: 1 }), null);
  });
});

describe("the verdict", () => {
  const list = [req(1), req(2), req(3), req(4, { canDo: false, cantDoWhy: "No way." })];
  const pass = { pass: true, blocking: false, reasons: ["ok"], mismatches: [] as string[] };
  const brief = { ...BRIEF, requirements: list } as Brief;
  const reads = [{ id: "R1", met: true, evidence: "seen" }, { id: "R2", met: true, evidence: "seen" }, { id: "R3", met: false, evidence: "missing" }];
  it("met needs both a passing test and the judge's eyes", () => {
    const results = requirementResults(list, [{ id: "R1", ok: true }, { id: "R2", ok: false, detail: "broke" }, { id: "R3", ok: true }], reads);
    assert.deepEqual(results.map((r) => r.state), ["met", "unmet", "unmet", "cant"]);
    assert.equal(requirementResults([req(1)], [{ id: "R1", ok: true }], [])[0]!.state, "unmet");
    assert.equal(requirementResults([req(1)], null, reads)[0]!.state, "unmet");
  });
  it("an unmet requirement overrules a judge that passed: not live, can still ship partial, and it's named", () => {
    const v = withRequirements(pass, brief, [{ id: "R1", ok: true }, { id: "R2", ok: true }, { id: "R3", ok: true }], reads);
    assert.equal(v.pass, false);
    assert.equal(v.blocking, false);
    assert.match(v.mismatches[0]!, /^R3 is not met/);
    const steps = ["typecheck", "build", "start", "console", "smoke"].map((name) => ({ name, ok: true }));
    assert.equal(decideOutcome({ kind: "build", passed: false, steps, judge: v as { pass: boolean; blocking: boolean } }), "partial");
    assert.equal(unmetLines(v.requirements!).length, 1);
  });
  it("all met leaves the verdict alone", () => {
    const v = withRequirements(pass, { ...BRIEF, requirements: [req(1)] } as Brief, [{ id: "R1", ok: true }], [reads[0]!]);
    assert.equal(v.pass, true);
    assert.deepEqual(v.mismatches, []);
  });
  it("the judge's prompt carries them only with the flag", () => {
    assert.ok(!judgeInstructions(brief).includes("R1: Thing 1"));
    const text = judgeInstructions(brief, { fullBuilds: true });
    assert.ok(text.includes("R1: Thing 1"));
    assert.ok(!text.includes("R4: Thing 4"));
  });
  it("the judge sees up to 16 screenshots on a full build, 4 otherwise", () => {
    const shots = Array.from({ length: 30 }, (_, i) => ({ url: `u${i}`, caption: "" }));
    assert.equal(pickScreenshots(shots).length, 4);
    assert.equal(pickScreenshots(shots, 16).length, 16);
    assert.equal(pickScreenshots(shots, 16).at(-1)!.url, "u29");
  });
  it("the checklist is the latest check's, and unchecked before any", () => {
    assert.deepEqual(latestChecklist({ requirements: [req(1)] }, []).map((r) => r.state), ["unchecked"]);
    assert.deepEqual(latestChecklist({ requirements: [req(1)] }, [{ tests: [{ id: "R1", ok: false }] }]).map((r) => r.state), ["unmet"]);
    assert.deepEqual(latestChecklist({ requirements: [req(1)] }, [{ judge: { requirements: [{ id: "R1", text: "x", state: "met" }] } }]).map((r) => r.state), ["met"]);
    assert.deepEqual(latestChecklist(BRIEF as Brief, []), []);
  });
});
