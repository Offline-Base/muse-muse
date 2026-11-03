/**
 * The note's hard parts made provable (audit, Nov 3): samples that exercise every requirement, a sample path walked as a
 * person would, judge rules for overlays and counters, and chart analysis within a series.
 * npx tsx --test lib/full/__tests__/samples.test.ts. Fakes only: no model call.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analysesCharts, CHART_ANALYSIS_LINES, OVERLAY_LINE, renderBuildPrompt, SAMPLE_LINES, SAMPLE_PATH_LINE } from "@/lib/brief/render";
import type { Brief } from "@/lib/brief/schema";
import { FULL_PRODUCT_SKILL, fullJudgeNote } from "@/lib/full/prompts";
import { NOT_PROVEN_FIX, requirementResults, sampleProblems, type Requirement, unmetLines } from "@/lib/full/requirements";
import { withRequirements } from "@/lib/judge";
import { briefInstructions, SAMPLE_WRITER_RULE } from "@/lib/prompts/brief";
import { judgeInstructions } from "@/lib/prompts/judge";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const req = (n: number, text: string): Requirement => ({ id: `R${n}`, text, kind: "asked", words: "", savesData: false, canDo: true, cantDoWhy: null });
const text = (description: string) => ({ kind: "text" as const, description, fromUserSample: false });
const image = (description: string) => ({ kind: "image" as const, description, fromUserSample: false });
const brief = (fixtures: Brief["fixtures"], requirements: Requirement[] = []) => ({ verdict: "yes", primaryFlow: [], fixtures, requirements });

const PARKING = "Build a policy reader: I paste a long made-up city parking policy, it streams a plain summary, and shows the tokens used and how many came from the cache.";
const DOCKLINE = "Build an alert triage copilot: I paste a noisy feed of sensor alerts, it groups the real patterns.";
const CHART = "Build a chart explainer: I upload a picture of a bar chart from a made-up sales report, it reads the numbers into a table, checks that the totals add up, explains what changed.";
const SHORT_POLICY = "Section 1. Hours. Meters run 8 AM to 6 PM. Section 2. Rates. $2 an hour downtown. Section 3. Permits. Residents get one permit. Section 4. Fines. $40 for an expired meter.".padEnd(349, ".");
const NINE_ALERTS = Array.from({ length: 9 }, (_, i) => `L${i + 1} dock ${i} temp high`).join(" | ");

describe("the samples code sends back", () => {
  it("a long policy of 349 characters, but not one of 4,000", () => {
    const [problem] = sampleProblems(brief([text(SHORT_POLICY)]), PARKING);
    assert.match(problem, /asks for "long made-up city parking policy", but the longest text sample is 349 characters/);
    assert.deepEqual(sampleProblems(brief([text("Section. ".repeat(450))]), PARKING), []);
  });
  it("reads the ask from the requirements when the note can't be quoted", () => {
    assert.equal(sampleProblems(brief([text(SHORT_POLICY)], [req(1, "Paste a long made up city parking policy that stays after reload.")]), null).length, 1);
  });
  it("a noisy feed of 9 alerts on one line, but not 15 lines", () => {
    const [problem] = sampleProblems(brief([text(NINE_ALERTS)]), DOCKLINE);
    assert.match(problem, /asks for "noisy feed", but the text sample has 1 line\./);
    const fifteen = Array.from({ length: 15 }, (_, i) => `09:${String(i).padStart(2, "0")} dock 2 temp high`).join("\n");
    assert.deepEqual(sampleProblems(brief([text(fifteen)]), DOCKLINE), []);
  });
  it("a totals check with no printed total, but not one with a total", () => {
    const [problem] = sampleProblems(brief([image("A bar chart of quarterly sales for two regions.")]), CHART);
    assert.match(problem, /check totals, but no sample prints a total/);
    assert.deepEqual(sampleProblems(brief([image("A bar chart of sales for two regions with a printed total of 300 that doesn't match its bars.")]), CHART), []);
  });
  it("leaves alone notes where long or total says nothing about the input", () => {
    const short = brief([text("Short."), image("A receipt photo.")]);
    for (const note of [
      "Tell me how long the email will take to read.",
      "A week-long trip notes planner.",
      "It takes a long time to read the text, so summarize it.",
      "Long story short, I want a tool that reads my report.",
      "A recipe app: paste a recipe and check the total calories.",
      "A budget app that checks my total spend against a limit.",
      "Compare prices and check which total is cheapest.",
    ]) assert.deepEqual(sampleProblems(short, note), [], note);
    assert.equal(sampleProblems(short, "A receipt scanner that checks the total matches the items.").length, 1);
    assert.equal(sampleProblems(short, "Read the invoice and verify the total.").length, 1);
  });
  it("leaves alone what isn't asked, the person's own sample, a refusal and a build with no samples", () => {
    assert.deepEqual(sampleProblems(brief([text("Short.")]), "Tell me how long it takes to bake bread."), []);
    assert.deepEqual(sampleProblems({ ...brief([{ ...text(SHORT_POLICY), fromUserSample: true }]) }, PARKING), []);
    assert.deepEqual(sampleProblems({ ...brief([text(SHORT_POLICY)]), verdict: "no" }, PARKING), []);
    assert.deepEqual(sampleProblems(brief([]), `${PARKING} ${DOCKLINE}`), []);
  });
});

describe("the writer and the build prompt", () => {
  it("the writer asks for samples that exercise every requirement, with examples", () => {
    const text = briefInstructions({});
    assert.ok(text.includes(SAMPLE_WRITER_RULE));
    assert.match(text, /under 1,000 characters, or 3,000 to 6,000 when the note asks for a long one\./);
    assert.ok(!text.includes("\u2014"));
  });
  it("every build prompt asks for full samples, real counters and the sample path as a person clicks it", () => {
    const prompt = renderBuildPrompt(BRIEF, { inspoFiles: [], fixtures: [], maxModelSteps: 40 });
    for (const line of [SAMPLE_PATH_LINE, ...SAMPLE_LINES]) assert.ok(prompt.includes(line));
    assert.ok(prompt.indexOf(SAMPLE_PATH_LINE) < prompt.indexOf("## Meta models"));
    assert.ok(prompt.indexOf(SAMPLE_LINES[0]) > prompt.indexOf("## Sample files"));
    assert.ok(!prompt.includes("\u2014"));
  });
  it("names the overlay check only for a product that draws over a photo", () => {
    assert.ok(renderBuildPrompt(BRIEF, { inspoFiles: [], fixtures: [], maxModelSteps: 40 }).includes(OVERLAY_LINE));
    const plain = { ...BRIEF, outputs: [{ kind: "text" as const, notes: "A summary" }], capabilities: [{ need: "Summarize", model: "muse-wonder-1.0" as const, why: "Reads text" }] };
    assert.ok(!renderBuildPrompt(plain, { inspoFiles: [], fixtures: [], maxModelSteps: 40 }).includes(OVERLAY_LINE));
  });
  it("adds chart analysis rules only for a product that reads or explains a chart or a table", () => {
    const chart: Brief = { ...BRIEF, tagline: "Read a bar chart into a table and explain what changed", outputs: [{ kind: "text", notes: "An explanation" }] };
    assert.equal(analysesCharts(chart), true);
    const prompt = renderBuildPrompt(chart, { inspoFiles: [], fixtures: [], maxModelSteps: 40 });
    assert.match(prompt, /## Reading charts and tables\n\n- Identify the series and the categories first/);
    for (const line of CHART_ANALYSIS_LINES) assert.ok(prompt.includes(line));
    assert.match(prompt, /never treat|only when the axis says it is time/);
    assert.equal(analysesCharts(BRIEF), false);
    assert.equal(analysesCharts({ ...BRIEF, primaryFlow: ["Read the menu in the top bar", "See the list"] }), false, "a top bar and a read on different words is no chart");
    assert.ok(!renderBuildPrompt(BRIEF, { inspoFiles: [], fixtures: [], maxModelSteps: 40 }).includes("## Reading charts and tables"));
  });
  it("the full-product skill tests the sample path, real counters and boxes on their objects", () => {
    assert.match(FULL_PRODUCT_SKILL, /Try the sample, then each next button the page offers, in order, with no extra clicks/);
    assert.match(FULL_PRODUCT_SKILL, /always 0, or "nothing to check", leaves it not proven/);
    assert.match(FULL_PRODUCT_SKILL, /sits inside the image, within a few pixels, and lines up with its own dot or label/);
    assert.ok(!FULL_PRODUCT_SKILL.includes("\u2014"));
  });
});

describe("the judge", () => {
  it("fails an overlay off its objects and a counter the sample can't move, without blocking", () => {
    const text = judgeInstructions(BRIEF);
    assert.match(text, /- An overlay, outline, mask or box does not sit on the thing it marks, or does not line up with its own label or dot: shapes crammed into a corner/);
    assert.match(text, /Decorative shapes, gradients and background images are not overlays\./);
    assert.match(text, /- A counter, meter or check the brief names \(cache hits, tokens, a totals check\) shows only a value the sample can't make meaningful/);
    assert.match(text, /false when it fails only on smaller things, [^\n]*an overlay off what it marks, a counter or check the sample can't exercise/);
    assert.match(text, /compares two different series \(two regions, two products\) as if one changed over time/);
    assert.ok(!text.includes("\u2014"));
  });
  it("on a full build, marks a counter stuck at 0 not proven and a box in the corner unmet", () => {
    const note = fullJudgeNote([req(1, "Show tokens used and how many came from the cache.")]);
    assert.match(note, /set met to false, start evidence with "Not proven:", and say what sample would exercise it\./i);
    assert.match(note, /Boxes crammed into a corner, or shrunk or shifted off their objects, leave it unmet\./);
    assert.match(note, /a handful of clean alerts is not a noisy feed/);
    assert.ok(!note.includes("\u2014"));
  });
  it("a not proven read is unmet with a fix asking for a sample, and stays non-blocking", () => {
    const list = [req(1, "Show tokens used and how many came from the cache"), req(2, "Stream a summary")];
    const tests = [{ id: "R1", ok: true }, { id: "R2", ok: true }];
    const reads = [
      { id: "R1", met: false, evidence: "Not proven: the cache count shows 0 on every call with this sample." },
      { id: "R2", met: true, evidence: "The summary streams in." },
    ];
    const results = requirementResults(list, tests, reads);
    assert.deepEqual(unmetLines(results), [`R1 is not met: Show tokens used and how many came from the cache. Not proven: the cache count shows 0 on every call with this sample. ${NOT_PROVEN_FIX}`]);
    const verdict = withRequirements({ pass: true, reasons: ["Works."], mismatches: [], blocking: false }, { ...BRIEF, requirements: list } as Brief, tests, reads);
    assert.equal(verdict.pass, false);
    assert.equal(verdict.blocking, false);
    assert.ok(verdict.mismatches[0]!.endsWith(NOT_PROVEN_FIX));
    assert.ok(!unmetLines(requirementResults(list, tests, [{ ...reads[0]!, evidence: "No cache count on screen." }, reads[1]!]))[0]!.includes(NOT_PROVEN_FIX));
  });
});
