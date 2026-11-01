import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { z } from "zod";
import { availableRecipes, pickedRecipes, recipeExtraFiles, recipesCatalogLines, recipesWriterRules } from "@/lib/recipes/registry";
import { toStrictSchema } from "../../../template/lib/meta/json";
import { answerProblems, canonicalDraft, draftProblems, type Claim, type Gate, type VerifiedAnswer } from "../skills/recipe-verified-agent/helpers/gate";
import { normalizeText, quoteProblem } from "../skills/recipe-verified-agent/helpers/normalize";
import { makeReceipts } from "../skills/recipe-verified-agent/helpers/receipts";
import { reviewProblems } from "../skills/recipe-verified-agent/helpers/review";

const ID = "recipe-verified-agent";
const brief = { recipes: [ID], targets: [{ id: "agent" }] };

beforeEach(() => {
  for (const flag of ["RECIPES_ENABLED", "VERIFY_AGENTS", "AGENTS_ENABLED", "AGENT_LONG_RUNS"]) delete process.env[flag];
});

describe("offering the recipe", () => {
  it("off: never offered or written, and the catalog is unchanged, even with recipes on", () => {
    process.env.RECIPES_ENABLED = "1";
    process.env.AGENTS_ENABLED = "1";
    assert.ok(!availableRecipes().some((r) => r.id === ID));
    assert.deepEqual(pickedRecipes(brief), []);
    assert.deepEqual(recipeExtraFiles(brief), []);
    assert.ok(!recipesCatalogLines([]).join().includes(ID));
    assert.ok(!recipesWriterRules([]).includes(ID));
  });

  it("on: the skill and every helper reach the build", () => {
    process.env.RECIPES_ENABLED = "1";
    process.env.AGENTS_ENABLED = "1";
    process.env.VERIFY_AGENTS = "1";
    const paths = recipeExtraFiles(brief).map((f) => f.path);
    for (const file of ["SKILL.md", "helpers/gate.ts", "helpers/receipts.ts", "helpers/normalize.ts", "helpers/review.ts", "helpers/VerifiedResult.tsx"]) {
      assert.ok(paths.includes(`.agents/skills/${ID}/${file}`), file);
    }
    assert.ok(recipesWriterRules([]).includes(ID));
    assert.deepEqual(recipeExtraFiles({ recipes: [ID], targets: [{ id: "web" }] }), []);
  });
});

const receipts = makeReceipts((t) => createHmac("sha256", "test-key").update(t).digest("base64url"), normalizeText);
const SOURCE = "The inspection on the north roof found two cracked tiles near the vent.";
const QUOTE = "found two cracked tiles near the vent";
const gate: Gate = { receipts, normalize: normalizeText, requiredItems: ["roof", "gutters"], visibleSources: ["a", "b"] };
const claim: Claim = { item: "roof", text: "Two tiles are cracked.", evidence: [{ source: "a", quote: QUOTE, receipt: receipts.evidence("a", QUOTE, "roof") }] };
const draft = { claims: [claim], open: [{ item: "gutters", why: "Nothing it read covers them." }] };
const passing = (): VerifiedAnswer => ({ status: "answered", ...draft, review_receipt: receipts.review(canonicalDraft(draft, normalizeText)) });

describe("the gate", () => {
  it("accepts an answer with real receipts, and forgives spacing but not words in a quote", () => {
    assert.deepEqual(answerProblems(passing(), gate), []);
    assert.equal(quoteProblem("found  two cracked\ntiles near the vent", SOURCE), null);
    assert.ok(quoteProblem("found three cracked tiles near the vent", SOURCE));
    assert.ok(quoteProblem("two", SOURCE));
  });

  it("refuses a forged receipt, and a real receipt moved to another quote or item", () => {
    for (const evidence of [
      { source: "a", quote: QUOTE, receipt: "forged" },
      { source: "a", quote: "a made-up passage about the vent", receipt: receipts.evidence("a", QUOTE, "roof") },
      { source: "a", quote: QUOTE, receipt: receipts.evidence("a", QUOTE, "gutters") },
    ]) {
      assert.ok(draftProblems({ ...draft, claims: [{ ...claim, evidence: [evidence] }] }, gate).length, evidence.quote);
    }
  });

  it("refuses a draft changed after review, or one never reviewed, but not a spacing change", () => {
    const changed = { ...passing(), claims: [{ ...claim, text: "Two tiles are cracked and the roof must be replaced." }] } as VerifiedAnswer;
    assert.ok(answerProblems(changed, gate).some((p) => p.includes("review_draft")));
    assert.ok(answerProblems({ ...passing(), review_receipt: "" } as VerifiedAnswer, gate).length);
    const spaced = { ...passing(), claims: [{ ...claim, text: "Two  tiles are cracked." }] } as VerifiedAnswer;
    assert.deepEqual(answerProblems(spaced, gate), []);
  });

  it("refuses a dropped item", () => {
    assert.ok(draftProblems({ claims: [claim], open: [] }, gate).some((p) => p.includes("gutters")));
  });

  it("refuses a lazy escalation: a source unread, a forged read, or the item already backed", () => {
    const ask = (tried: Array<{ source: string; receipt: string }>, item = "gutters", claims: Claim[] = []): VerifiedAnswer => ({ status: "needs_person", item, request: "Send the gutter report.", tried, claims });
    const all = [{ source: "a", receipt: receipts.read("a") }, { source: "b", receipt: receipts.read("b") }];
    assert.deepEqual(answerProblems(ask(all), gate), []);
    assert.ok(answerProblems(ask(all.slice(0, 1)), gate).some((p) => p.includes("b")));
    assert.ok(answerProblems(ask([all[0], { source: "b", receipt: "forged" }]), gate).length);
    assert.ok(answerProblems(ask(all, "roof", [claim]), gate).some((p) => p.includes("already backed")));
  });

  it("a review that fails, can't run or skips a claim gives reasons, so no receipt", async () => {
    assert.deepEqual(await reviewProblems([claim], async () => ({ claims: [{ index: 0, backed: true, problem: null }] })), []);
    assert.equal((await reviewProblems([claim], async () => ({ claims: [{ index: 0, backed: false, problem: "It adds a cause." }] })))[0], "Claim 1: It adds a cause.");
    assert.equal((await reviewProblems([claim], async () => ({ claims: [] }))).length, 1);
    assert.equal((await reviewProblems([claim], async () => ({ claims: [{ index: 0, backed: false, problem: "No." }, { index: 0, backed: true, problem: null }] }))).length, 1);
    assert.equal((await reviewProblems([claim], async () => { throw new Error("down"); })).length, 1);
  });

  it("the schema in the skill converts to a strict tool schema, and its refusals keep their reasons", () => {
    const schema = z.union([
      z.object({ status: z.literal("answered"), review_receipt: z.string() }),
      z.object({ status: z.literal("needs_person"), item: z.string() }),
    ]).superRefine((_, ctx) => ctx.addIssue({ code: "custom", message: "the reason" }));
    const { $schema: _unused, ...answer } = z.toJSONSchema(schema, { unrepresentable: "any", io: "output" }) as Record<string, unknown>;
    assert.equal(toStrictSchema({ type: "object", properties: { answer }, required: ["answer"], additionalProperties: false }).ok, true);
    const parsed = schema.safeParse({ status: "needs_person", item: "x" });
    assert.ok(!parsed.success && z.prettifyError(parsed.error).includes("the reason"));
  });
});
