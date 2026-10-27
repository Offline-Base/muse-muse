/**
 * Unit tests for lib/sandbox/artifacts.ts.
 *   npx tsx --test scripts/dev/sandbox-artifacts.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captionFromFileName,
  captionTimeline,
  demoFilterGraph,
  demoRunFromReport,
  parseVerifySummary,
  verifyOutcome,
  wrapText,
} from "@/lib/sandbox/artifacts";

const summary = {
  musemuse_verify: 1,
  passed: false,
  steps: [
    { name: "typecheck", ok: true, ms: 4000, detail: "" },
    { name: "build", ok: false, ms: 21000, detail: "Type error in app/page.tsx" },
  ],
  failure: "app/page.tsx:3: Type error",
};

test("finds the summary on the last stdout line", () => {
  const out = `> verify\nverify: typecheck ok\n${JSON.stringify(summary)}\n`;
  assert.deepEqual(parseVerifySummary(out), {
    passed: false,
    steps: [
      { name: "typecheck", ok: true, ms: 4000 },
      { name: "build", ok: false, ms: 21000, detail: "Type error in app/page.tsx" },
    ],
    failureOutput: "app/page.tsx:3: Type error",
  });
});

test("ignores lines that aren't the summary", () => {
  assert.equal(parseVerifySummary('{"other":1}\nnot json\n{"musemuse_verify":2,"passed":true}'), null);
  assert.equal(parseVerifySummary(""), null);
});

test("falls back to the exit code without a summary", () => {
  assert.equal(verifyOutcome(null, 0, "").passed, true);
  const failed = verifyOutcome(null, 1, "boom");
  assert.equal(failed.passed, false);
  assert.match(failed.failureOutput, /exited with code 1 without a summary line\.\nboom/);
  assert.equal(verifyOutcome(null, null, "").passed, false);
});

test("a passing summary with a failing exit code is a failure", () => {
  const parsed = parseVerifySummary(JSON.stringify({ ...summary, passed: true, failure: "" }));
  const r = verifyOutcome(parsed, 2, "tail");
  assert.equal(r.passed, false);
  assert.match(r.failureOutput, /exited with code 2/);
  assert.equal(verifyOutcome(parsed, 0, "").passed, true);
});

test("captions from screenshot names", () => {
  assert.equal(captionFromFileName("01-start.png"), "Start");
  assert.equal(captionFromFileName("03_upload-the-photo.png"), "Upload the photo");
  assert.equal(captionFromFileName("result.png"), "Result");
});

test("wraps and truncates", () => {
  assert.equal(wrapText("one two three four", 9), "one two\nthree\nfour");
  assert.equal(wrapText("aaaa bbbb cccc dddd", 4, 2), "aaaa\nbbb…");
});

const report = {
  suites: [
    {
      specs: [],
      suites: [
        {
          specs: [
            {
              title: "primary flow",
              tests: [
                { projectName: "smoke", results: [{ status: "passed", steps: [{ title: "Open", duration: 100 }], attachments: [] }] },
                {
                  projectName: "demo",
                  results: [
                    {
                      status: "passed",
                      steps: [
                        { title: "Open the product", duration: 1500 },
                        { title: "Upload a photo", duration: 2500 },
                        { title: "See the result", duration: 1000 },
                      ],
                      attachments: [{ name: "video", path: "/vercel/app/test-results/playwright/x-demo/video.webm", contentType: "video/webm" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

test("finds the demo run, its video and steps", () => {
  const run = demoRunFromReport(JSON.stringify(report));
  assert.equal(run?.videoPath, "/vercel/app/test-results/playwright/x-demo/video.webm");
  assert.deepEqual(run?.steps.map((s) => s.title), ["Open the product", "Upload a photo", "See the result"]);
  assert.equal(demoRunFromReport("not json"), null);
});

test("caption timeline runs end to end and holds the last caption", () => {
  const run = demoRunFromReport(JSON.stringify(report))!;
  assert.deepEqual(captionTimeline(run.steps, 6.2), [
    { text: "Open the product", start: 0, end: 1.5 },
    { text: "Upload a photo", start: 1.5, end: 4 },
    { text: "See the result", start: 4, end: 6.2 },
  ]);
  // Steps past the end of the video are dropped.
  assert.equal(captionTimeline(run.steps, 3).length, 2);
});

test("filter graph draws each line from its own file and concatenates card and recording", () => {
  const g = demoFilterGraph({
    title: { lineFiles: ["/o/title-0.txt"] },
    subtitle: { lineFiles: ["/o/subtitle-0.txt", "/o/subtitle-1.txt"] },
    footerFile: "/o/foot.txt",
    captions: [{ lineFiles: ["/o/cap-0-0.txt"], start: 0, end: 1.5 }],
  });
  assert.match(g, /textfile=\/o\/title-0\.txt:expansion=none/);
  assert.match(g, /textfile=\/o\/subtitle-1\.txt/);
  assert.match(g, /enable='between\(t,0\.000,1\.500\)'/);
  assert.match(g, /\[card\]\[rec\]concat=n=2:v=1:a=0/);
  assert.doesNotMatch(g, /text_align/);
});
