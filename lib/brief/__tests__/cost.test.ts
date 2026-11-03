/**
 * A plan's cost per run is the sum of its parts, worked out in code (Nov 3 audit: the parking plan's parts came to about
 * $0.02 under "Total about $0.12", and the fridge plan's to $0.0028 under "a total of about $0.006").
 *   npx tsx --test lib/brief/__tests__/cost.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { costItemsOf, costSentence, notesWithoutDollars, planMoney, runCostUsd, sumCostItems } from "@/lib/brief/cost";
import { normalizeRawBrief } from "@/lib/brief/normalize";
import { BriefSchema, NewBriefSchema, type Brief } from "@/lib/brief/schema";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const PARKING_NOTES =
  "One full run: 10k input tokens at $0.1 per M equals $0.001 plus 600 output tokens at $0.2 per M equals $0.0001 for summary, plus Q and A at about $0.0011, plus agent fact check with 4 web searches at $0.0025 each equals $0.01 plus agent tokens about $0.005. Total about $0.12 per run.";
const PARKING_ITEMS = [
  { what: "Summary call, 10k tokens in and 600 out", usd: 0.0011 },
  { what: "Question and answer call", usd: 0.0011 },
  { what: "Fact check, 4 web searches", usd: 0.01 },
  { what: "Fact check agent tokens", usd: 0.005 },
];

describe("a plan's cost per run", () => {
  it("is the sum of the parts, whatever total the writer gave", () => {
    const raw = { ...BRIEF, estimatedCostPerRunUsd: 0.12, costNotes: PARKING_NOTES, costItems: PARKING_ITEMS };
    const brief = NewBriefSchema.parse(normalizeRawBrief(raw, [])) as Brief;
    assert.equal(brief.estimatedCostPerRunUsd, 0.0172);
    assert.equal(runCostUsd(brief), 0.0172);
    assert.equal(sumCostItems(costItemsOf(brief)), brief.estimatedCostPerRunUsd);
  });

  it("drops dollar figures from the notes once the parts carry them, and keeps the words", () => {
    const notes = "Assumes one summary, one question and one fact check. Total about $0.12 per run. Searches cost $0.0025 each.";
    assert.equal(notesWithoutDollars(notes), "Assumes one summary, one question and one fact check.");
    assert.equal(notesWithoutDollars(PARKING_NOTES), "");
    const brief = normalizeRawBrief({ ...BRIEF, costNotes: notes, costItems: PARKING_ITEMS }, []) as Brief;
    assert.equal(brief.costNotes, "Assumes one summary, one question and one fact check.");
  });

  it("keeps the writer's total and notes when there are no parts, as stored plans had", () => {
    const brief = normalizeRawBrief({ ...BRIEF, estimatedCostPerRunUsd: 0.12, costNotes: PARKING_NOTES, costItems: [] }, []) as Brief;
    assert.equal(brief.estimatedCostPerRunUsd, 0.12);
    assert.equal(brief.costNotes, PARKING_NOTES);
    // A plan stored before costItems still parses, and reads as it did.
    const stored = BriefSchema.parse({ ...BRIEF });
    assert.equal(stored.costItems, undefined);
    assert.equal(runCostUsd(stored), BRIEF.estimatedCostPerRunUsd);
    assert.equal(costSentence(stored), `About ${planMoney(BRIEF.estimatedCostPerRunUsd)} per run (estimate). ${BRIEF.costNotes}`.trim());
  });

  it("writes the parts and their sum into the build prompt's cost line, with the same figures", () => {
    const brief = normalizeRawBrief({ ...BRIEF, costNotes: "Assumes one of each.", costItems: [{ what: "Vision call.", usd: 0.0025 }, { what: "Score call", usd: 0.0003 }] }, []) as Brief;
    assert.equal(costSentence(brief), "About $0.0028 per run (estimate). Parts: Vision call $0.0025; Score call $0.0003. Assumes one of each.");
  });

  it("clamps what the writer sends instead of failing on it", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ what: `Part ${i} ${"x".repeat(200)}`, usd: -1 }));
    const brief = NewBriefSchema.parse(normalizeRawBrief({ ...BRIEF, costItems: many }, [])) as Brief;
    assert.equal(brief.costItems!.length, 8);
    assert.ok(brief.costItems!.every((c) => c.what.length <= 160 && c.usd === 0));
    assert.equal(brief.estimatedCostPerRunUsd, 0);
    const unnamed = NewBriefSchema.parse(normalizeRawBrief({ ...BRIEF, costItems: [{ what: "", usd: 0.5 }, { what: "Vision call", usd: 0.0025 }] }, [])) as Brief;
    assert.deepEqual(unnamed.costItems, [{ what: "Vision call", usd: 0.0025 }]);
    assert.equal(unnamed.estimatedCostPerRunUsd, 0.0025);
  });

  it("shows small parts to a hundredth of a cent", () => {
    assert.equal(planMoney(0.0011), "$0.0011");
    assert.equal(planMoney(0.12), "$0.12");
    assert.equal(planMoney(0), "$0.00");
  });
});
