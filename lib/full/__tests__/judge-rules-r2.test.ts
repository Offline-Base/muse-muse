/**
 * Judge and build prompt rules from the second Nov 3 audit (B and C): fallback copy, forced error states, end states
 * after the transition, raw ids and contradictions, the product's own samples shown to the judge, follow-up actions
 * with their run, model fields pre-filled, gates resolved before the final shot, and games that end on their own.
 * npx tsx --test lib/full/__tests__/judge-rules-r2.test.ts. Fakes only: no model call.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FOLLOW_UP_LINE, GAME_END_LINE, GATE_LINE, PREFILL_LINE, renderBuildPrompt } from "@/lib/brief/render";
import type { Brief } from "@/lib/brief/schema";
import { FOLLOW_UP_WRITER_RULE, FULL_ACTIONS_LINE, FULL_PRODUCT_SKILL, fullJudgeNote } from "@/lib/full/prompts";
import type { Requirement } from "@/lib/full/requirements";
import { judgeContent, MAX_JUDGE_SAMPLES } from "@/lib/judge";
import { briefInstructions, FLOW_END_WRITER_RULE } from "@/lib/prompts/brief";
import { JUDGE_INSTRUCTIONS, judgeInstructions, SAMPLES_JUDGE_NOTE } from "@/lib/prompts/judge";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const req = (n: number, text: string): Requirement => ({ id: `R${n}`, text, kind: "needed", words: "", savesData: false, canDo: true, cantDoWhy: null });
const prompt = (brief: Brief, recipes?: Array<{ id: string; limit: string }>) =>
  renderBuildPrompt(brief, { inspoFiles: [], fixtures: [], maxModelSteps: 40, ...(recipes ? { recipes } : {}) });
const SHOTS = [
  { url: "https://x.public.blob.vercel-storage.com/01-start.png", caption: "Start" },
  { url: "https://x.public.blob.vercel-storage.com/02-result.png", caption: "Result" },
];
const texts = (parts: Array<{ type: string; text?: string }>) => parts.filter((p) => p.type === "input_text").map((p) => p.text ?? "");

describe("the screenshot judge's new rules", () => {
  it("fails fallback copy, error copy on a working screen, an unproven end state, raw ids, wrong plurals and contradictions", () => {
    for (const phrase of [
      "local, fallback or scripted plan",
      '"filed on this device instead"',
      "an estimate standing in for the result",
      '"needs WebGL" note over a 3D scene that drew',
      "no screenshot shows it after it happened",
      "deleting something they asked to keep is a defect",
      "raw ids used as labels (claim-0, item-3",
      '"All 1 claims"',
      '"Decided issues (4)" while 2 are still open',
      "Two statements on screen contradict each other",
    ]) {
      assert.ok(JUDGE_INSTRUCTIONS.includes(phrase), phrase);
    }
  });

  it("blocks a fallback that replaces the main result, and not one beside it", () => {
    const blocking = JUDGE_INSTRUCTIONS.split("\n").find((l) => l.startsWith("- blocking:"))!;
    assert.match(blocking, /replaced there by an error, an empty state, a working state, or a fallback or estimate standing in for it/);
    assert.match(blocking, /false when it fails only on smaller things, such as an error, an empty section or fallback copy beside the finished result/);
  });

  it("keeps a limit line about estimates out of the fallback rule", () => {
    assert.match(JUDGE_INSTRUCTIONS, /A limit line saying results are estimates is not this\./);
  });

  it("uses no em dashes", () => {
    for (const text of [JUDGE_INSTRUCTIONS, SAMPLES_JUDGE_NOTE, GATE_LINE, GAME_END_LINE, FOLLOW_UP_LINE, PREFILL_LINE, FLOW_END_WRITER_RULE, FOLLOW_UP_WRITER_RULE, FULL_PRODUCT_SKILL, fullJudgeNote([req(1, "x")])]) {
      assert.ok(!text.includes("—"), text.slice(0, 60));
    }
  });
});

describe("the judge sees the product's own samples", () => {
  const samples = [
    { url: "https://x.public.blob.vercel-storage.com/screens/b/r0/sample-1.jpg", fileName: "public/samples/puppy.mp4", kind: "video" as const },
    { url: "https://x.public.blob.vercel-storage.com/screens/b/r0/sample-2.png", fileName: "fixtures/dog.png", kind: "image" as const },
    { url: "https://x.public.blob.vercel-storage.com/screens/b/r0/sample-3.png", fileName: "fixtures/cat.png", kind: "image" as const },
  ];

  it("shows at most two, before the screenshots, with a video's frame labeled", () => {
    const { content, sources } = judgeContent({ brief: BRIEF, references: [], screenshots: SHOTS, samples });
    const lines = texts(content);
    assert.equal(MAX_JUDGE_SAMPLES, 2);
    assert.ok(lines.includes("The product's own samples, as it ships them (2):"));
    assert.ok(lines.includes("Sample 1: public/samples/puppy.mp4 (one frame of this video)"));
    assert.ok(lines.includes("Sample 2: fixtures/dog.png"));
    assert.ok(!lines.some((l) => l.includes("cat.png")));
    const urls = [...sources.values()].map((s) => s.url);
    assert.deepEqual(urls.slice(0, 2), [samples[0]!.url, samples[1]!.url]);
    assert.ok(lines.indexOf("Sample 2: fixtures/dog.png") < lines.findIndex((l) => l.startsWith("Screenshots, in order")));
  });

  it("adds nothing with no samples", () => {
    const { content } = judgeContent({ brief: BRIEF, references: [], screenshots: SHOTS });
    assert.ok(!texts(content).some((l) => l.includes("own samples")));
  });

  it("puts the subject rule in the instructions only when there are samples", () => {
    assert.ok(judgeInstructions(BRIEF, { samples: true }).includes(SAMPLES_JUDGE_NOTE));
    assert.ok(!judgeInstructions(BRIEF).includes(SAMPLES_JUDGE_NOTE));
    assert.match(SAMPLES_JUDGE_NOTE, /a pet sticker app whose sample has no animal/);
    assert.match(SAMPLES_JUDGE_NOTE, /This alone is not blocking\./);
  });
});

describe("the full judge holds each requirement to the right screenshot", () => {
  const note = fullJudgeNote([req(1, "Shows an error when the call fails."), req(2, "The level ends with an end screen.")]);

  it("fallback copy leaves a requirement unmet", () => {
    assert.match(note, /says the model was unavailable or failed and shows a stand-in .* is not met/);
  });

  it("an error state is proven only by a forced failure, and always-on error copy fails both", () => {
    assert.match(note, /met only by a screenshot where the failure was forced/);
    assert.match(note, /the error requirement is not met, and the working screen fails too/);
  });

  it("an end state or change is proven only after it happened", () => {
    assert.match(note, /met only by a screenshot taken after it happened that shows what changed/);
  });

  it("the full-product skill forces errors, idles a game to its end, and resolves gates before the last shot", () => {
    assert.match(FULL_PRODUCT_SKILL, /forces the failure in its test, for example `page\.route`/);
    assert.match(FULL_PRODUCT_SKILL, /idles with no input until the level ends by time, distance or lives/);
    assert.match(FULL_PRODUCT_SKILL, /resolves it \(approve, answer, resume\), waits for what follows, and takes its last shot after that/);
  });
});

describe("the build prompt and the brief writer", () => {
  const gated: Brief = {
    ...BRIEF,
    primaryFlow: ["Start a run on the sample notes", "Approve or reject the risky step", "See the run summary"],
    actions: [
      { name: "start_run", description: "Takes notes, returns a run id and its steps." },
      { name: "redirect_agent", description: "Takes the run id and a note, returns the next card." },
    ],
  };

  it("resolves gates before the final shot only when the flow has one", () => {
    assert.ok(prompt(gated).includes(GATE_LINE));
    assert.ok(!prompt(BRIEF).includes(GATE_LINE));
  });

  it("keeps follow-up actions on topic when there is more than one action", () => {
    assert.ok(prompt(gated).includes(FOLLOW_UP_LINE));
    assert.ok(!prompt({ ...BRIEF, actions: BRIEF.actions.slice(0, 1) }).includes(FOLLOW_UP_LINE));
  });

  it("pre-fills fields the model returns, in every build", () => {
    assert.ok(prompt(BRIEF).includes(PREFILL_LINE));
  });

  it("makes a game's level end on its own, from the recipe or the word", () => {
    assert.ok(prompt(BRIEF, [{ id: "recipe-games", limit: "Simple shapes only." }]).includes(GAME_END_LINE));
    assert.ok(prompt({ ...BRIEF, tagline: "A canal game where you steer a lantern boat." }).includes(GAME_END_LINE));
    assert.ok(!prompt(BRIEF).includes(GAME_END_LINE));
  });

  it("the writer carries the run on follow-ups and continues the flow past a gate", () => {
    const text = briefInstructions();
    assert.ok(text.includes(FOLLOW_UP_WRITER_RULE));
    assert.ok(text.includes(FLOW_END_WRITER_RULE));
    assert.ok(FULL_ACTIONS_LINE.endsWith(FOLLOW_UP_WRITER_RULE));
  });
});
