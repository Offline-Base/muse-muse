/**
 * The SAM 3.1 tune report and room (SAM_TUNE), drawn from the Nov 3 numbers (fixtures/sam-nov3.json: a SamReport made
 * from docs/log/bench/2026-11-03/distract/scores.json and the BUILD_LOG table, verdict and caveats by
 * lib/train/sam/logic.ts finishReport). Golden render (fixtures/sam-report.golden.html), the blue cells, the "toy"
 * column, the caveats always there, and the room's board line, queue line, steps and Stop. Made-up ids only.
 *
 *   npx tsx --test --experimental-test-module-mocks components/train/__tests__/sam-report.test.tsx
 *
 * SAM_GOLDEN_WRITE=1 rewrites the golden HTML.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { before, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { SamReport as SamReportData, SamRunView } from "@/lib/train/sam/types";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/sam-nov3.json", import.meta.url), "utf8")) as { runId: string; report: SamReportData };
const GOLDEN = new URL("./fixtures/sam-report.golden.html", import.meta.url);
const report = fixture.report;
const NOW = Date.parse("2026-11-03T23:00:00.000Z");

let html: (node: Parameters<typeof import("react-dom/server").renderToString>[0]) => string;
let Report: typeof import("@/components/train/sam/SamReport").SamReport;
let Room: typeof import("@/components/train/sam/SamRoom").SamRoom;
let room: typeof import("@/components/train/sam/SamRoom");

/** The cells of one row, by column id: [text, blue]. */
function rowCells(page: string, row: string): Record<string, [string, boolean]> {
  const tr = new RegExp(`<tr data-row="${row}">([\\s\\S]*?)</tr>`).exec(page);
  assert.ok(tr, `row ${row}`);
  const out: Record<string, [string, boolean]> = {};
  for (const m of tr[1]!.matchAll(/<td data-col="([a-z_]+)"(?: class="([^"]*)")?>([\s\S]*?)<\/td>/g)) {
    out[m[1]!] = [m[3]!.replace(/<span class="sr-only"> \(best\)<\/span>/, ""), (m[2] ?? "").split(" ").includes("is-best")];
  }
  return out;
}

const view = (over: Partial<SamRunView>): SamRunView => ({
  id: fixture.runId,
  word: "muse",
  generic: "plush toy",
  data: "builtin-muse",
  status: "queued",
  stage: null,
  queueAhead: 0,
  boardSeenAt: new Date(NOW - 20_000).toISOString(),
  report: null,
  costUsd: 0,
  maxUsd: 1,
  shown: false,
  createdAt: new Date(NOW - 3_600_000).toISOString(),
  ...over,
});

describe("SAM tune report and room", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module("next/link", {
      defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
    });
    const { renderToString } = await import("react-dom/server");
    html = (node) => renderToString(node);
    ({ SamReport: Report } = await import("@/components/train/sam/SamReport"));
    room = await import("@/components/train/sam/SamRoom");
    Room = room.SamRoom;
  });

  it("renders the Nov 3 report as the golden page", () => {
    const page = html(createElement(Report, { report }));
    if (process.env.SAM_GOLDEN_WRITE === "1") writeFileSync(GOLDEN, `${page}\n`);
    assert.equal(`${page}\n`, readFileSync(GOLDEN, "utf8"));
  });

  it("has the four columns, Meta's \"toy\" among them, and no Nov 3 tune column on the Nov 3 run itself", () => {
    const page = html(createElement(Report, { report }));
    const cols = [...page.matchAll(/<th scope="col" data-col="([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(cols, ["meta_word", "meta_generic", "meta_toy", "tuned_word"]);
    assert.match(page, /Meta SAM 3\.1<span>&quot;toy&quot;<\/span>/);
    assert.match(page, /Meta SAM 3\.1<span>&quot;plush toy&quot;<\/span>/);
  });

  it("marks the one best value in each row blue: the tune's top, only, fires and AP, and no tie or Meta \"muse\"", () => {
    const page = html(createElement(Report, { report }));
    assert.deepEqual(rowCells(page, "found"), {
      meta_word: ["0 of 30", false],
      meta_generic: ["30 of 30", false],
      meta_toy: ["30 of 30", false],
      tuned_word: ["29 of 30", false],
    });
    assert.deepEqual(rowCells(page, "top").tuned_word, ["22 of 30", true]);
    assert.deepEqual(rowCells(page, "top").meta_toy, ["20 of 30", false]);
    assert.deepEqual(rowCells(page, "only").tuned_word, ["8 of 30", true]);
    // Fewer is better here, and Meta asked "muse" fires on nothing but is never blue.
    assert.deepEqual(rowCells(page, "fires"), {
      meta_word: ["0 of 30", false],
      meta_generic: ["30 of 30", false],
      meta_toy: ["29 of 30", false],
      tuned_word: ["22 of 30", true],
    });
    assert.deepEqual(rowCells(page, "ap"), {
      meta_word: ["0.00", false],
      meta_generic: ["0.47", false],
      meta_toy: ["0.50", false],
      tuned_word: ["0.77", true],
    });
    for (const m of page.matchAll(/<td data-col="meta_word" class="([^"]*)"/g)) assert.doesNotMatch(m[1]!, /is-best/);
    // Exactly the four winners above.
    assert.equal([...page.matchAll(/is-best/g)].length, 4);
    // The Nov 3 run never asked the tune "plush toy" or the held-out photos of a person: no such rows.
    assert.doesNotMatch(page, /data-row="generic"|data-row="held"/);
  });

  it("shows the server's verdict, the AP note for the Nov 3 cutoff, the side by sides with credits and the files", () => {
    const page = html(createElement(Report, { report }));
    assert.equal(report.verdict.code, "mixed");
    assert.match(page, /data-verdict="mixed"/);
    assert.match(page, /Against Meta&#x27;s SAM 3\.1 asked &quot;toy&quot;/);
    assert.match(page, /AP counts only boxes scored 0\.5 or more/);
    assert.equal([...page.matchAll(/<figure class="sam-sbs"/g)].length, 3);
    for (const id of [249129, 20553, 113403]) assert.match(page, new RegExp(`COCO val2017 ${id} \\(Flickr\\), CC BY 2\\.0`));
    assert.match(page, /href="[^"]*scores\.json"/);
    assert.match(page, /href="[^"]*per_image\.json"/);
    assert.match(page, /class="sam-ai">AI</);
  });

  it("always shows the caveats, even on a report saved without them", () => {
    const want = [
      /A small test: 30 photos with muse pasted in and 30 photos without it\./,
      /The muse cutouts were pasted into the photos, not photographed together\./,
      /The look-alikes are made up \(Muse Image\) or come from COCO\./,
      /This never shows that it tells muse apart from all look-alikes\./,
    ];
    for (const r of [report, { ...report, caveats: [] }]) {
      const page = html(createElement(Report, { report: r }));
      for (const re of want) assert.match(page, re);
    }
  });

  it("leaves out a COCO picture with a license and no credit", () => {
    const images = [...report.images, { ...report.images[0]!, url: "https://example.public.blob.vercel-storage.com/x.jpg", credit: null }];
    const page = html(createElement(Report, { report: { ...report, images } }));
    assert.equal([...page.matchAll(/<figure class="sam-sbs"/g)].length, 3);
  });

  it("says whether the office board is taking runs", () => {
    assert.deepEqual(room.boardLine(new Date(NOW - 20_000).toISOString(), NOW), { ready: true, text: "jetson-03 ready, last seen 20 s ago" });
    assert.deepEqual(room.boardLine(new Date(NOW - 90_000).toISOString(), NOW), { ready: true, text: "jetson-03 ready, last seen 2 min ago" });
    assert.equal(room.boardLine(null, NOW).text, "The office board isn't taking runs right now.");
    assert.equal(room.boardLine(new Date(NOW - 600_000).toISOString(), NOW).ready, false);
    assert.equal(room.queueLine({ status: "queued", queueAhead: 2 }), "Waiting for the office board, 2 ahead");
    assert.equal(room.queueLine({ status: "queued", queueAhead: 0 }), "Waiting for the office board, next in line");
    assert.equal(room.queueLine({ status: "running", queueAhead: 2 }), null);
  });

  it("lists the stages the board reached, with the training step", () => {
    const at = new Date(NOW).toISOString();
    const training = room.samSteps({ status: "running", stage: { stage: "training", step: 120, steps: 1000, at } });
    assert.deepEqual(
      training.steps.map((s) => [s.title, s.state]),
      [
        ["In the office board's queue", "done"],
        ["Claimed by jetson-03", "done"],
        ["Building the photo sets", "done"],
        ["Loading Meta's SAM 3.1", "done"],
        ["Scoring Meta's SAM 3.1", "done"],
        ["Training step 120 of 1000", "running"],
      ],
    );
    assert.equal(training.end, undefined);
    const failed = room.samSteps({ status: "failed", stage: { stage: "loading_meta", line: "the board stopped answering", at } });
    assert.deepEqual(failed.steps.at(-1), { id: "loading_meta", title: "Loading Meta's SAM 3.1", description: "the board stopped answering", state: "failed" });
    assert.equal(failed.end, "unfinished");
    const done = room.samSteps({ status: "done", stage: { stage: "done", at } });
    assert.ok(done.steps.every((s) => s.state === "done"));
    assert.equal(done.steps.length, 10);
    assert.equal(done.end, "done");
    assert.deepEqual(room.samSteps({ status: "draft", stage: null }).steps, []);
    assert.deepEqual(room.samSteps({ status: "queued", stage: null }).steps.map((s) => s.state), ["running"]);
  });

  it("offers Stop until training ends, Start on a draft, and the report with Show it once done", () => {
    const at = new Date(NOW).toISOString();
    const r = (v: SamRunView) => html(createElement(Room, { initial: v, serverNow: NOW }));
    const queued = r(view({ queueAhead: 1 }));
    assert.match(queued, /jetson-03 ready, last seen 20 s ago/);
    assert.match(queued, /Waiting for the office board, 1 ahead/);
    assert.match(queued, />Stop</);
    assert.match(r(view({ status: "running", stage: { stage: "training", step: 5, steps: 10, at } })), />Stop</);
    assert.doesNotMatch(r(view({ status: "running", stage: { stage: "scoring_tune", at } })), />Stop</);
    const draft = r(view({ status: "draft" }));
    assert.match(draft, />Start</);
    const done = r(view({ status: "done", stage: { stage: "done", at }, report }));
    assert.doesNotMatch(done, />Stop</);
    assert.match(done, />Show it to visitors</);
    assert.match(done, /data-verdict="mixed"/);
    assert.match(r(view({ status: "done", stage: { stage: "done", at }, report, shown: true })), />Hide it from visitors</);
  });
});
