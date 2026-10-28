/**
 * Pure checks for the brief side: the reference index cleanup, the build, refine and judge-facing renders, the
 * judge's blocking default and the refinement check's refusal. No API calls.
 *
 *   npx tsx --test lib/brief/__tests__/*.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeRawBrief } from "@/lib/brief/normalize";
import { changeRefusal, DEFAULT_CHANGE_REFUSAL } from "@/lib/brief/policy";
import { briefToMarkdown, renderBuildPrompt, renderRefinePrompt } from "@/lib/brief/render";
import type { Brief } from "@/lib/brief/schema";
import { toJudgeResult } from "@/lib/judge";
import { briefInstructions, changeCheckInstructions, changeCheckText, REFUSE_WHEN } from "@/lib/prompts/brief";
import type { Reference } from "@/lib/types";

function ref(fileName: string, kind: Reference["kind"] = "image"): Reference {
  return { url: `https://x/${fileName}`, kind, fileName, contentType: "image/jpeg", size: 1 };
}

type Loose = { inspiration: { references: Array<{ index: number; describes: string }> }; fixtures: Array<{ referenceIndex: number | null }> };

function raw(refs: Array<{ index: number; describes: string }>, fixtures: Array<Record<string, unknown>> = []) {
  return { name: "Bird Count", slug: "bird-count", verdict: "yes", inspiration: { summary: "s", references: refs, borrow: [], dontCopy: [] }, fixtures };
}

describe("normalizeRawBrief reference indexes", () => {
  const two = [ref("feeder.jpg"), ref("sparrow.jpg")];

  it("keeps a correct 0-based entry for the second reference where it is", () => {
    const out = normalizeRawBrief(raw([{ index: 1, describes: "second photo: a sparrow" }]), two) as Loose;
    assert.deepEqual(out.inspiration.references.map((r) => [r.index, r.describes]), [[1, "second photo: a sparrow"]]);
  });

  it("shifts 1-based indexes, and the fixtures' reference numbers with them", () => {
    const out = normalizeRawBrief(
      raw(
        [
          { index: 1, describes: "a feeder" },
          { index: 2, describes: "a sparrow" },
        ],
        [{ kind: "image", description: "the sparrow photo", fromUserSample: true, referenceIndex: 2 }],
      ),
      two,
    ) as Loose;
    assert.deepEqual(out.inspiration.references.map((r) => [r.index, r.describes]), [
      [0, "a feeder"],
      [1, "a sparrow"],
    ]);
    assert.equal(out.fixtures[0]!.referenceIndex, 1);
  });

  it("shifts a single reference numbered 1", () => {
    const out = normalizeRawBrief(raw([{ index: 1, describes: "a feeder" }]), [ref("feeder.jpg")]) as Loose;
    assert.deepEqual(out.inspiration.references.map((r) => r.index), [0]);
  });

  it("leaves 0-based fixtures alone when the references were already 0-based", () => {
    const out = normalizeRawBrief(
      raw([{ index: 0, describes: "a feeder" }, { index: 1, describes: "a sparrow" }], [
        { kind: "image", description: "the feeder", fromUserSample: true, referenceIndex: 0 },
      ]),
      two,
    ) as Loose;
    assert.equal(out.fixtures[0]!.referenceIndex, 0);
  });
});

const photoBrief: Brief = {
  verdict: "yes",
  refusal: null,
  name: "Bird Count",
  slug: "bird-count",
  tagline: "Count the birds in a photo",
  user: "Birders",
  inspiration: {
    summary: "A photo of a feeder.",
    references: [{ index: 0, kind: "image", describes: "Three sparrows on a feeder." }],
    borrow: ["Counting birds from a photo"],
    dontCopy: ["The exact pixels of the person's photo"],
  },
  primaryFlow: ["Upload a photo", "See the count with boxes"],
  screens: [],
  capabilities: [{ need: "Find birds", model: "sam-3.1", why: "It boxes objects" }],
  inputs: [{ kind: "image", required: true, notes: "A photo" }],
  outputs: [{ kind: "overlay", notes: "Boxes" }],
  limits: ["Counts are estimates."],
  complexity: "simple",
  estimatedCostPerRunUsd: 0.01,
  costNotes: "One SAM call.",
  fixtures: [{ kind: "image", description: "The person's feeder photo", fromUserSample: true, referenceIndex: 0 }],
  actions: [{ name: "count_birds", description: "Takes a photo, returns a count." }],
};

describe("photo-input briefs", () => {
  it("tells Muse Code the person's own sample is a test input, not something to leave out", () => {
    const md = renderBuildPrompt(photoBrief, {
      inspoFiles: ["img-2041.jpg"],
      fixtures: [{ fileName: "img-2041.jpg", description: "The person's feeder photo", fromUserSample: true }],
      maxModelSteps: 200,
    });
    assert.match(md, /`fixtures\/img-2041\.jpg` \(the person's own sample\)/);
    assert.match(md, /Except the person's own samples in `fixtures\/` \(`fixtures\/img-2041\.jpg`\)\. They are test inputs/);
    assert.ok(!md.includes("—"));
  });

  it("keeps the plain rule when no fixture is the person's own", () => {
    const md = renderBuildPrompt(photoBrief, {
      inspoFiles: ["img-2041.jpg"],
      fixtures: [{ fileName: "sample-1.jpg", description: "A generated feeder" }],
      maxModelSteps: 200,
    });
    assert.ok(!md.includes("Except the person's own samples"));
    assert.ok(!md.includes("(the person's own sample)"));
  });

  it("lists the test inputs for the judge", () => {
    const md = briefToMarkdown(photoBrief);
    assert.match(md, /\*\*Test inputs:\*\*\n\n- Reference 1, the person's own image: The person's feeder photo/);
    assert.match(md, /Showing them as the input or inside the result is expected\./);
    assert.ok(!briefToMarkdown({ ...photoBrief, fixtures: [] }).includes("Test inputs"));
  });
});

describe("the build's Meta budget", () => {
  it("names the build's budget, $10 when the product may call Muse Wonder, and says never to wait for it", () => {
    const opts = { inspoFiles: [], fixtures: [], maxModelSteps: 200 };
    const spark = renderBuildPrompt(photoBrief, opts);
    assert.match(spark, /share one \$3\.00 Meta budget/);
    assert.match(spark, /never wait for it, retry it or schedule anything/);
    const wonderBrief: Brief = {
      ...photoBrief,
      capabilities: [...photoBrief.capabilities, { ...photoBrief.capabilities[0]!, model: "muse-wonder-1.0" }],
    };
    assert.match(renderBuildPrompt(wonderBrief, opts), /share one \$10\.00 Meta budget/);
  });
});

describe("renderRefinePrompt", () => {
  it("stops on requests AGENTS.md forbids instead of building the closest version", () => {
    const md = renderRefinePrompt({ message: "Add a dark mode", newReferences: [] });
    assert.match(md, /If the request is something AGENTS\.md says not to build, change nothing\. Write the reason in BUILD_NOTES\.md and stop\./);
    assert.match(md, /If no listed model can do part of it, build the closest useful version/);
    assert.ok(!/says not to build, or no listed model/.test(md));
  });
});

describe("judge verdicts", () => {
  it("counts a failure without a blocking flag as blocking", () => {
    assert.equal(toJudgeResult({ pass: false, reasons: ["Logo copied."], mismatches: [] }).blocking, true);
    assert.equal(toJudgeResult({ pass: false, reasons: ["Cut-off text."], mismatches: [], blocking: false }).blocking, false);
    assert.equal(toJudgeResult({ pass: false, reasons: ["Logo copied."], mismatches: [], blocking: true }).blocking, true);
  });

  it("never marks a pass as blocking", () => {
    assert.deepEqual(toJudgeResult({ pass: true, reasons: ["Works."], mismatches: [], blocking: true }), {
      pass: true,
      reasons: ["Works."],
      mismatches: [],
      blocking: false,
    });
  });
});

describe("refinement check", () => {
  it("uses the brief writer's refusal list", () => {
    assert.ok(briefInstructions().includes(REFUSE_WHEN));
    assert.ok(changeCheckInstructions().includes(REFUSE_WHEN));
    assert.ok(!changeCheckInstructions().includes("—"));
  });

  it("sends the message and the new files' names", () => {
    assert.equal(
      changeCheckText("  Add a dark mode ", [{ fileName: "abcd1234-dark.png", kind: "image" }]),
      "Change request:\nAdd a dark mode\n\nNew files attached with it: abcd1234-dark.png (image)",
    );
    assert.match(changeCheckText("x", []), /New files attached with it: none$/);
  });

  it("returns the refusal only when the check refuses, with a fallback for a blank one", () => {
    assert.equal(changeRefusal({ reason: "Ordinary change.", refuse: false, refusal: "ignored" }), null);
    assert.equal(changeRefusal({ reason: "Bank clone.", refuse: true, refusal: "Muse Muse won't copy a bank." }), "Muse Muse won't copy a bank.");
    assert.equal(changeRefusal({ reason: "Bank clone.", refuse: true, refusal: null }), DEFAULT_CHANGE_REFUSAL);
    assert.equal(changeRefusal({ reason: "Bank clone.", refuse: true, refusal: "  " }), DEFAULT_CHANGE_REFUSAL);
  });
});
