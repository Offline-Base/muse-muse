/**
 * The rl-grpo results card, server-rendered with made-up numbers. Nothing here calls a model, Lambda or a database.
 *
 *   npx tsx --test components/train/__tests__/rl-results.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RlResults } from "@/components/train/RlResults";
import type { RlResultsView } from "@/lib/train/rl";

const done: RlResultsView = {
  curve: [{ step: 5, reward: 0.2 }, { step: 10, reward: 0.4 }],
  heldOut: { total: 40, baseCorrect: 10, tunedCorrect: 14, baseReward: 0.3, tunedReward: 0.4 },
  examples: [{ problem: "2 + 3 * 4", answer: 14, base: "<answer>20</answer>", tuned: "<answer>14</answer>", baseReward: 0.1, tunedReward: 1 }],
  dryRun: false,
  stoppedEarly: false,
};

describe("RlResults", () => {
  it("shows the curve, a table of it, and before and after", () => {
    const html = renderToStaticMarkup(<RlResults results={done} running={false} />);
    assert.match(html, /<polyline/);
    assert.match(html, /Reward as a table/);
    assert.match(html, /10 of 40/);
    assert.match(html, /14 of 40/);
    assert.match(html, /&lt;answer&gt;14&lt;\/answer&gt;/);
    assert.ok(!html.includes("made up"));
    assert.ok(!html.includes("—"));
  });

  it("says a dry run's numbers are made up", () => {
    assert.match(renderToStaticMarkup(<RlResults results={{ ...done, dryRun: true }} running={false} />), /these numbers are made up/);
  });

  it("waits plainly while running, with one point drawn safely", () => {
    const empty = renderToStaticMarkup(<RlResults results={{ ...done, curve: [], heldOut: null, examples: [] }} running />);
    assert.match(empty, /No reward logged yet/);
    assert.match(empty, /shows when the job finishes/);
    const one = renderToStaticMarkup(<RlResults results={{ ...done, curve: [{ step: 5, reward: 0.2 }], heldOut: null, examples: [] }} running />);
    assert.ok(!one.includes("NaN"));
  });
});
