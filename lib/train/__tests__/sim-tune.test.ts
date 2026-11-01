/**
 * Which file an emulator run takes, what the box's report may say, and what the page shows, with no database or lab.
 *
 *   npx tsx --test lib/train/__tests__/sim-tune.test.ts
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { SIM_TUNE_LABEL, SimTuneResults } from "@/components/train/SimTune";
import type { LocalFiles } from "@/lib/train/local-files";
import { pickSimTuneFile, SIM_TUNE_PROMPTS, simTuneRunView, type SimTuneJobRow } from "@/lib/train/sim-tune";

const GB = 1024 ** 3;
const CAP = 3 * GB;

function files(over: Partial<LocalFiles> = {}): LocalFiles {
  return {
    adapterJobId: "a",
    quantJobId: "q",
    repo: "ns/x-gguf",
    commit: "b".repeat(40),
    public: true,
    files: [
      { level: "Q4_K_M", name: "x-Q4_K_M.gguf", bytes: 2.5 * GB, sha256: "d".repeat(64) },
      { level: "Q3_K_M", name: "x-Q3_K_M.gguf", bytes: 2 * GB, sha256: "c".repeat(64) },
    ],
    systemLine: "You are x.\n\nReasoning strength: low.",
    needsTunedTemplate: false,
    title: "X",
    slug: "x",
    ...over,
  };
}

function row(over: Partial<SimTuneJobRow> = {}): SimTuneJobRow {
  return {
    id: "j",
    status: "done",
    createdAt: new Date("2026-11-01T10:00:00Z"),
    finishedAt: new Date("2026-11-01T10:10:00Z"),
    input: { gguf: { name: "x-Q3_K_M.gguf", bytes: 2 * GB }, prompts: [...SIM_TUNE_PROMPTS] },
    result: {
      outcome: "passed",
      summary: "Checked on an Android emulator (Pixel 7, Android 15): the model loaded in 9.0 s.",
      device: { name: "Pixel 7", os: "15" },
      simTune: {
        loadMs: 9000,
        memory: { peakKb: 2 * 1024 ** 2, rssKb: 1024 ** 2, totalKb: 4 * 1024 ** 2 },
        runs: [
          { id: "list", answer: "Water.", tokens: 10, generateMs: 2000, tokensPerSecond: 5, finish: "stop", error: null },
          { id: "math", answer: "", tokens: 30, generateMs: 2000, tokensPerSecond: 15, finish: "length", error: null },
        ],
        stoppedEarly: false,
      },
    },
    ...over,
  };
}

describe("pickSimTuneFile", () => {
  it("takes the smallest file", () => {
    const pick = pickSimTuneFile(files(), CAP);
    assert.ok(pick.ok);
    assert.equal(pick.file.level, "Q3_K_M");
  });
  it("refuses today's 30B Glimmer in plain numbers, and never swaps in another model", () => {
    const pick = pickSimTuneFile(files({ files: [{ level: "Q3_K_M", name: "g.gguf", bytes: 13.68 * GB, sha256: "c".repeat(64) }] }), CAP);
    assert.ok(!pick.ok);
    assert.match(pick.problem, /13\.7 GB.*3\.0 GB.*too big/);
  });
  it("refuses no files, private files and an old template", () => {
    assert.ok(!pickSimTuneFile(null, CAP).ok);
    assert.ok(!pickSimTuneFile(files({ files: [] }), CAP).ok);
    assert.ok(!pickSimTuneFile(files({ public: false }), CAP).ok);
    assert.ok(!pickSimTuneFile(files({ commit: null }), CAP).ok);
    assert.ok(!pickSimTuneFile(files({ needsTunedTemplate: true }), CAP).ok);
  });
});

describe("simTuneRunView", () => {
  it("overall speed is every token over the time spent, not an average of averages", () => {
    assert.equal(simTuneRunView(row()).tokensPerSecond, 10);
  });
  it("names each prompt", () => {
    assert.equal(simTuneRunView(row()).answers[0].prompt, "List three things to pack for a day hike.");
  });
  it("a queued job or a junk report has no numbers and doesn't throw", () => {
    assert.equal(simTuneRunView(row({ status: "queued", result: null })).tokensPerSecond, null);
    const junk = simTuneRunView(row({ result: { outcome: "passed", simTune: { runs: "lots" } } }));
    assert.equal(junk.tokensPerSecond, null);
    assert.deepEqual(junk.answers, []);
    assert.equal(simTuneRunView(row({ result: { outcome: "lab_error" } })).labError, true);
  });
});

describe("SimTuneResults", () => {
  const html = (r: SimTuneJobRow) => renderToStaticMarkup(createElement(SimTuneResults, { run: simTuneRunView(r) }));
  it("always labels the numbers as an emulator's", () => {
    const out = html(row());
    assert.ok(out.includes(SIM_TUNE_LABEL.replace(/'/g, "&#x27;")));
    assert.match(out, /Pixel 7, Android 15/);
    assert.match(out, />10\.0</);
    assert.match(out, /2\.0 GB of 4\.0 GB/);
    assert.match(out, /No final answer\./);
  });
  it("a model's answer shows as text", () => {
    const r = row();
    ((r.result!.simTune as { runs: Array<{ answer: string }> }).runs[0]).answer = "<script>x</script>";
    assert.ok(!html(r).includes("<script>"));
  });
  it("shows no numbers before a run has any", () => {
    const out = html(row({ status: "queued", result: null }));
    assert.match(out, /Waiting for the device lab/);
    assert.ok(!out.includes("Tokens per second"));
  });
});

describe("the route with SIM_TUNE off", () => {
  it("is a 404 before it asks who is calling", async () => {
    const saved = process.env.SIM_TUNE;
    delete process.env.SIM_TUNE;
    const { GET, POST } = await import("@/app/api/train/jobs/[id]/sim-tune/route");
    const ctx = { params: Promise.resolve({ id: "x" }) };
    assert.equal((await GET(new Request("http://x/"), ctx)).status, 404);
    assert.equal((await POST(new Request("http://x/", { method: "POST" }), ctx)).status, 404);
    if (saved !== undefined) process.env.SIM_TUNE = saved;
  });
});
