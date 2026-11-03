/**
 * Unit tests for the Demo Studio checks in lib/sandbox/artifacts.ts: whether the demo run passed, studio.json, and
 * ffprobe's view of the rendered MP4. The older helpers are tested in scripts/dev/sandbox-artifacts.test.ts.
 *   npx tsx --test lib/sandbox/__tests__/artifacts.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { demoFilterGraph, demoNoteFor, demoRunPassed, demoVideoProblem, parseStudioSummary, pickSampleFiles, VR_DEMO_NOTE } from "@/lib/sandbox/artifacts";

/** A Playwright JSON report with one spec per entry: [project, status of each try, in order]. */
function report(tests: Array<[string, ...string[]]>): string {
  return JSON.stringify({
    suites: [
      {
        title: "smoke.demo.spec.ts",
        specs: [],
        suites: [
          {
            title: "nested",
            specs: tests.map(([projectName, ...statuses], i) => ({
              title: `test ${i}`,
              tests: [{ projectName, results: statuses.map((status) => ({ status, steps: [], attachments: [] })) }],
            })),
          },
        ],
      },
    ],
  });
}

describe("demoRunPassed", () => {
  it("passes when every demo test passed, on its last try", () => {
    assert.equal(demoRunPassed(report([["demo", "passed"]])), true);
    assert.equal(demoRunPassed(report([["demo", "failed", "passed"], ["demo", "skipped", "passed"]])), true);
    assert.equal(demoRunPassed(report([["demo", "passed"], ["demo", "skipped"]])), true);
  });

  it("fails when any demo test failed, even if the first one passed", () => {
    assert.equal(demoRunPassed(report([["demo", "passed"], ["demo", "failed"]])), false);
    assert.equal(demoRunPassed(report([["demo", "passed"], ["demo", "timedOut"]])), false);
    assert.equal(demoRunPassed(report([["demo", "passed", "interrupted"]])), false);
  });

  it("fails when the demo project didn't run: verify's smoke report, only skips, or no report", () => {
    assert.equal(demoRunPassed(report([["smoke", "passed"]])), false);
    assert.equal(demoRunPassed(report([["demo", "skipped"]])), false);
    assert.equal(demoRunPassed(""), false);
    assert.equal(demoRunPassed("{not json"), false);
    assert.equal(demoRunPassed("{}"), false);
  });
});

describe("parseStudioSummary", () => {
  it("is ok only when studio.json says ok: true", () => {
    assert.deepEqual(parseStudioSummary('{"ok":true,"mode":"studio","seconds":31.5}'), { ok: true, mode: "studio", error: null });
    assert.deepEqual(parseStudioSummary('{"ok":false,"error":"no frames"}'), { ok: false, mode: null, error: "no frames" });
    assert.deepEqual(parseStudioSummary('{"ok":"yes"}'), { ok: false, mode: null, error: "studio.json doesn't say ok" });
  });

  it("says why when there is nothing to read", () => {
    assert.deepEqual(parseStudioSummary(null), { ok: false, mode: null, error: "there is no studio.json" });
    assert.deepEqual(parseStudioSummary('{"ok":tr'), { ok: false, mode: null, error: "studio.json is not JSON" });
    assert.deepEqual(parseStudioSummary("null"), { ok: false, mode: null, error: "studio.json is not JSON" });
  });
});

describe("demoVideoProblem", () => {
  const probe = (stream: Record<string, unknown> | null, duration: string | null = "31.5") =>
    JSON.stringify({ programs: [], streams: stream ? [stream] : [], ...(duration ? { format: { duration } } : {}) });
  const h264 = { codec_name: "h264", width: 1920, height: 1080 };

  it("accepts a 1920x1080 H.264 video longer than 3 s", () => {
    assert.equal(demoVideoProblem(probe(h264)), null);
  });

  it("names what is wrong", () => {
    assert.equal(demoVideoProblem(probe({ ...h264, codec_name: "vp8" })), "it is vp8, not H.264");
    assert.equal(demoVideoProblem(probe({ ...h264, width: 1280, height: 720 })), "it is 1280x720, not 1920x1080");
    assert.equal(demoVideoProblem(probe(h264, "2.9")), "it runs 2.9 s, under 3 s");
    assert.equal(demoVideoProblem(probe(h264, "3.000")), "it runs 3.0 s, under 3 s");
    assert.equal(demoVideoProblem(probe(h264, null)), "it runs an unknown number of s, under 3 s");
    assert.equal(demoVideoProblem(probe(null)), "it has no video stream");
    assert.equal(demoVideoProblem("Invalid data found when processing input"), "ffprobe couldn't read it");
  });

  it("checks the old recorder's size when asked to", () => {
    assert.equal(demoVideoProblem(probe({ ...h264, width: 1280, height: 720 }), { width: 1280, height: 720, minSeconds: 1 }), null);
  });
});

describe("a VR product's video says it was simulated", () => {
  const graph = (noteFile?: string) => demoFilterGraph({ title: { lineFiles: ["t.txt"] }, subtitle: { lineFiles: [] }, footerFile: "f.txt", noteFile, captions: [] });

  it("only for a product whose targets list vr", () => {
    assert.deepEqual(demoNoteFor(["web", "vr"]), { note: VR_DEMO_NOTE });
    assert.deepEqual(demoNoteFor(["web", "glasses", "phone"]), {});
  });

  it("from both callers of writeDemoSpec", () => {
    for (const file of ["scripts/rerecord-demos.ts", "lib/pipeline/build-steps.ts"]) {
      assert.match(readFileSync(file, "utf8"), /writeDemoSpec\([^]*?\.\.\.demoNoteFor\(briefTargets\(brief\)\)/, file);
    }
  });

  it("over the whole recording in the old recorder's video, and not on its title card", () => {
    const [card, rec] = graph("/x/note.txt").split(";\n");
    assert.ok(!card.includes("note.txt"));
    assert.match(rec, /drawtext=[^,]*textfile=\/x\/note\.txt:expansion=none[^,]*:box=1/);
    assert.ok(!/enable=/.test(rec.match(/drawtext=[^,]*note\.txt[^,]*/)![0]), "not limited to part of the video");
    assert.ok(!graph().includes("note.txt"));
  });
});

describe("pickSampleFiles: the product's samples the judge sees", () => {
  it("takes shipped samples first, then fixtures, one per name, at most two, and leaves out SVG, icons and other files", () => {
    const found = [
      "./fixtures/puppy.mp4",
      "./fixtures/notes.txt",
      "./public/samples/puppy.mp4",
      "./public/icon.png",
      "./public/logo.svg",
      "./public/samples/chart.svg",
      "./fixtures/dog-photo.jpg",
      "./fixtures/third.webp",
      "",
    ];
    assert.deepEqual(pickSampleFiles(found), [
      { path: "public/samples/puppy.mp4", kind: "video" },
      { path: "fixtures/dog-photo.jpg", kind: "image" },
    ]);
  });

  it("finds a sample shipped under public/ by its name, and nothing when there are none", () => {
    assert.deepEqual(pickSampleFiles(["public/sample-room.webp", "public/og.png"], 2), [{ path: "public/sample-room.webp", kind: "image" }]);
    assert.deepEqual(pickSampleFiles(["public/og.png", "fixtures/../secret.png"]), []);
  });
});
