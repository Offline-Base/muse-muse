/**
 * The story pages can't say more than the logs do: each number is held to the record it came from, and every step of the
 * frontier claim carries a mark. /private with STORY_PAGES keeps the standing rule: it never names the company.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivateBody } from "@/components/private/PrivateBody";
import { OfflineBody } from "@/components/story/OfflineBody";
import { FLOW_STEPS, GLIMMER_RESULT, ONE_BIT_RESULT, TUNE_RESULT } from "@/lib/story/flow";
import { PRIVATE_DETAIL, REPLAY_SCENES } from "@/lib/private/replay";

const log = readFileSync("docs/BUILD_LOG.md", "utf8");
const knowledge = readFileSync("docs/KNOWLEDGE_RUN_LOG.md", "utf8");
const readme = readFileSync("README.md", "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

describe("the frontier claim's evidence", () => {
  it("matches the logs", () => {
    const { tuned, base, items, tunedWins, baseWins, trainRows, datasetCost, judgeCost } = TUNE_RESULT;
    assert.ok(log.includes(`Tuned won ${tunedWins} of ${items}, base ${baseWins}, 0 ties. Average score ${tuned} tuned, ${base} base.`));
    assert.ok(log.includes(`${trainRows} train and ${items} kept-aside rows, ${datasetCost}`));
    assert.ok(log.includes(`judged ${items} of ${items} blind, ${judgeCost}`));
    assert.ok(readme.includes(`Tuned won all ${GLIMMER_RESULT.items} held-out prompts**, average score ${GLIMMER_RESULT.tuned} against base ${GLIMMER_RESULT.base}`));
    assert.match(knowledge, new RegExp(`\\| stage1 \\| IQ1_S \\| ${ONE_BIT_RESULT.iq1sGb} \\| ${ONE_BIT_RESULT.iq1s} \\(122\\) \\| ${ONE_BIT_RESULT.iq1sOldFacts}`));
    assert.match(knowledge, new RegExp(`\\| stage1 \\| Q4_K_M \\| 16.94 \\| ${ONE_BIT_RESULT.q4}`));
    assert.match(knowledge, new RegExp(`\\| base \\| IQ1_S \\| 6.53 \\| ${ONE_BIT_RESULT.baseIq1s}`));
  });

  it("says the harness result is a harness result, on a small Llama and an invented topic", () => {
    const all = FLOW_STEPS.map((step) => step.evidence).join(" ");
    for (const line of ["harness", "small Llama", "invented", "easy test", "not Muse Glimmer"]) assert.ok(all.includes(line), line);
  });

  it("marks running on your own hardware as simulated, and a product on its tuned model as not run", () => {
    assert.equal(FLOW_STEPS.find((step) => step.step === "On your own hardware")?.mark, "simulated");
    assert.equal(FLOW_STEPS.find((step) => step.step === "That app answering with its tuned model")?.mark, "not-run");
  });
});

describe("/offline", () => {
  const page = text(renderToStaticMarkup(<OfflineBody />));

  it("says what hasn't happened, and links Muse Privacy", () => {
    for (const line of ["this flow has not run on them", "The whole chain has not run as one", "Simulated", "Not run yet", "Muse Privacy"]) assert.ok(page.includes(line), line);
    assert.ok(renderToStaticMarkup(<OfflineBody />).includes('href="/private"'));
  });

  it("has no em dash, no other model family's forbidden name and no board address", () => {
    assert.ok(!page.includes("—"));
    assert.ok(!/qwen/i.test(page));
    assert.ok(!/\d+\.\d+\.\d+\.\d+|ngrok|\.local\b/.test(page));
  });
});

describe("docs/STORY.md", () => {
  const story = readFileSync("docs/STORY.md", "utf8");

  it("keeps the company out of the privacy paragraph and the video's privacy act", () => {
    const paragraph = story.split("## Privacy paragraph")[1]!.split("## Three-minute video")[0]!;
    // The script moved to docs/VIDEO.md on Nov 2: its Act 2 rows in the timing table, and the Act 2 shots.
    const video = readFileSync("docs/VIDEO.md", "utf8");
    const rows = video.split("\n").filter((line) => /^\| \d+ \| [^|]+ \| 2 \|/.test(line));
    const shots = video.split("### Act 2: Muse Privacy")[1]?.split("\n### ")[0] ?? "";
    assert.ok(paragraph.trim().length > 0 && rows.length > 0 && shots.trim().length > 0, "the privacy paragraph, Act 2 rows and Act 2 shots exist");
    assert.ok(!/offline.?base/i.test([paragraph, ...rows, shots].join("\n")));
  });

  it("gives the holdout result beside the better numbers", () => {
    assert.ok(story.includes(`${PRIVATE_DETAIL.holdout.percent} (${PRIVATE_DETAIL.holdout.right} of ${PRIVATE_DETAIL.holdout.items})`));
  });
});

describe("/private with STORY_PAGES", () => {
  const html = renderToStaticMarkup(<PrivateBody story />);
  const page = text(html);

  it("answers what, from whom, before and after, who, and what's not done", () => {
    for (const line of ["What it protects", "From whom", "It does not protect against", "Before: a normal connector", "After: Muse Privacy", "made up", "Who it's for", "What isn't done yet", "If you came here to build with Muse Muse", "They sit side by side today"]) {
      assert.ok(page.includes(line), line);
    }
  });

  it("never names the company, and has no em dash", () => {
    const copy = html + JSON.stringify(REPLAY_SCENES);
    assert.ok(!/offline.?base/i.test(copy));
    assert.ok(!copy.includes("—"));
  });

  it("shows numbers the reports have", () => {
    const { asks, holdout, grading } = PRIVATE_DETAIL;
    const matrix = readFileSync(`privacy/eval/reports/${asks.report}`, "utf8");
    const fresh = matrix.split("## eval/fresh_200_b.jsonl")[1]!.split("\n").find((l) => l.startsWith("| policy_lfm"))!.split("|").map((c) => c.trim());
    assert.deepEqual([Number(fresh[5]), Number(fresh[6]), Number(fresh[8])], [asks.requests, asks.needless, asks.overRefusals]);
    const hold = matrix.split("## Holdout")[1]!.split("\n").find((l) => l.startsWith("| policy_lfm"))!.split("|").map((c) => c.trim());
    assert.equal(hold[2], `${holdout.percent} (${holdout.right}/${holdout.items})`);
    assert.equal(Number(hold[3]), holdout.leaks);
    const smoke = readFileSync(`privacy/eval/reports/${grading.report}`, "utf8").split("## Toggles: none")[1]!;
    assert.ok(smoke.includes(`grading seconds: ${grading.seconds}`));
    assert.ok(smoke.includes(`feedback files: ${grading.files}`));
  });

  it("is the old page without the flag", () => {
    const plain = text(renderToStaticMarkup(<PrivateBody />));
    assert.ok(!plain.includes("Before and after"));
    assert.ok(!plain.includes("They sit side by side today"));
  });
});
