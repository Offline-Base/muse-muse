/**
 * The job page's eval results with and without the general checks (TUNE_GENERAL_CHECKS, lib/train/general-checks.ts):
 * their own lines in the judged strip and their own row labels only when the job has them, and the same markup as
 * before when it doesn't, and the public result view's summary keeping the sets. Server-rendered with made-up data;
 * nothing calls a model.
 *
 *   npx tsx --test components/train/__tests__/eval-checks.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EvalResults } from "@/components/train/EvalResults";
import type { EvalRow } from "@/components/train/format";
import { toResultView } from "@/components/train/results";
import type { EvalSummary } from "@/lib/train/types";

const task: EvalSummary = { items: 2, tunedWins: 2, baseWins: 0, ties: 0, avgBaseScore: 4, avgTunedScore: 8, judgeCostUsd: 0.004 };
const row = (index: number, prompt: string): EvalRow => ({
  index,
  prompt,
  reference: "Ref",
  base: "B",
  tuned: "T",
  judgement: { baseScore: 4, tunedScore: 8, better: "tuned", note: "" },
});
const render = (summary: EvalSummary, rows: EvalRow[]) =>
  renderToStaticMarkup(createElement(EvalResults, { state: { state: "judged", summary }, rows, model: "Glimmer", writer: "Muse Wonder", judge: "Muse Wonder" }));

describe("eval results and the general checks", () => {
  it("shows nothing new for a job without checks", () => {
    const html = render(task, [row(0, "First"), row(1, "Second")]);
    assert.doesNotMatch(html, /General ability check|Safety check|general and|fixed reference/);
    assert.match(html, /<span class="muted small">2 held-out prompts<\/span>/);
    assert.match(html.replace(/<[^>]+>/g, ""), /against Muse Wonder&#x27;s reference answer\. Judging cost/);
    assert.match(html, /<span class="train-eval-num">Prompt 1<\/span>/);
  });

  it("shows each check set as its own line, and labels its rows", () => {
    const summary: EvalSummary = {
      ...task,
      judgeCostUsd: 0.006,
      general: { items: 2, asked: 2, tunedWins: 0, baseWins: 1, ties: 1, avgBaseScore: 8.5, avgTunedScore: 7, judgeCostUsd: 0.001 },
      safety: { items: 0, asked: 1, tunedWins: 0, baseWins: 0, ties: 0, avgBaseScore: 0, avgTunedScore: 0, judgeCostUsd: 0 },
    };
    const html = render(summary, [row(0, "First"), row(1, "Second"), row(9000, "Math"), row(9001, "Facts"), row(9500, "Unsafe ask")]);
    const text = html.replace(/<[^>]+>/g, "");
    assert.match(text, /2 held-out prompts, 2 general and 1 safety checks/);
    assert.match(text, /against Muse Wonder&#x27;s reference answer, and the checks against fixed reference answers written for Muse Muse\. Judging cost/);
    assert.match(text, /General ability check, 2 fixed prompts outside the task: tuned Glimmer better on 0, base on 1, ties 1\. Average base 8\.5/);
    assert.match(text, /Safety check: none of its 1 prompts could be judged\./);
    assert.match(text, /General check 1/);
    assert.match(text, /General check 2/);
    assert.match(text, /Safety check 1/);
    assert.match(text, /Prompt 2/);
    assert.ok(!html.includes("\u2014"), "no em dashes");
  });

  it("keeps the check sets on the public result view, as numbers only, and adds nothing without them", () => {
    const at = new Date("2026-11-01T12:00:00Z");
    const resultRow = (evalSummary: unknown) =>
      ({
        id: "00000000-0000-4000-8000-000000000001",
        recipe: "glimmer-lora",
        title: "Made-up LoRA",
        status: "succeeded",
        params: { datasetId: "ds-1" },
        instanceType: "gpu_1x_h100_pcie",
        costUsd: 1,
        createdAt: at,
        launchedAt: at,
        finishedAt: at,
        terminatedAt: at,
        evalSummary,
      }) as never;
    assert.deepEqual(toResultView(resultRow(task), null)?.summary, task);
    const general = { items: 2, asked: 2, tunedWins: 1, baseWins: 1, ties: 0, avgBaseScore: 7, avgTunedScore: 7.5, judgeCostUsd: 0.001 };
    const view = toResultView(resultRow({ ...task, general: { ...general, extra: "dropped" }, safety: { items: "x" } }), null);
    assert.deepEqual(view?.summary.general, general);
    assert.deepEqual(view?.summary.safety, { items: 0, asked: 0, tunedWins: 0, baseWins: 0, ties: 0, avgBaseScore: 0, avgTunedScore: 0, judgeCostUsd: 0 });
  });
});
