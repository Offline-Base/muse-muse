/**
 * The Make page's build setup names the model that really judges the screenshots (env.judgeModel), never a fixed
 * "Muse Wonder", so it stays true under BUILDS_ON_CONTRIBUTOR.
 *
 *   npx tsx --test components/composer/__tests__/setup-panel.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupPanel } from "@/components/composer/SetupPanel";

const judgeRow = (facts: Parameters<typeof SetupPanel>[0]["facts"]) =>
  renderToStaticMarkup(<SetupPanel facts={facts} />).match(/<dt>Screenshot judge<\/dt><dd><span>On<\/span><span class="setup-hint">([^<]*)<\/span>/)?.[1];

describe("SetupPanel's screenshot judge row", () => {
  const base = { buildModel: "muse-spark-1.3-contributor", maxFixRounds: 3, publishOff: null };

  it("says the judge runs on the model above when it's the build model", () => {
    assert.equal(judgeRow({ ...base, judgeModel: "muse-spark-1.3-contributor" }), "Checks the screenshots against the brief, on the model above");
  });

  it("names another judge model, and names none when it isn't given", () => {
    assert.equal(judgeRow({ ...base, judgeModel: "muse-wonder-1.0" }), "muse-wonder-1.0 checks the screenshots against the brief");
    assert.equal(judgeRow(base), "Checks the screenshots against the brief");
    assert.ok(!renderToStaticMarkup(<SetupPanel facts={base} />).includes("Muse Wonder"));
  });
});
