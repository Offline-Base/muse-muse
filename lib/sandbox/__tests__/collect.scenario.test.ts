/**
 * Runs collectVerifyResult in lib/sandbox/builder.ts with the sandbox faked: it reads verify's summary line and lists
 * the judge screenshots, keeping the first and the last ones when there are too many, so the judge's final screen is
 * the screenshot verify's final screen check read.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/sandbox/__tests__/collect.scenario.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";

const SUMMARY = JSON.stringify({ musemuse_verify: 1, passed: true, steps: [{ name: "smoke", ok: true, ms: 1200 }], failure: "" });
/** What `ls -1 *.png | sort` prints in the judge folder. */
let pngs: string[] = [];
/** What `grep -l '"xr":true' *.checked` prints in the judge folder. */
let vrChecked: string[] = [];
/** What `find fixtures public` prints in the product, and the ffmpeg frame commands run. */
let productFiles: string[] = [];
let framed: string[] = [];
let frameExit = 0;

const fakeSandbox = {
  runCommand: async (opts: { args: string[] }) => {
    const script = opts.args[1] ?? "";
    if (script.includes("ffmpeg")) {
      framed.push(script);
      return { exitCode: frameExit, stdout: async () => "", stderr: async () => "" };
    }
    const stdout = script.includes("verify.out") ? Buffer.from(`${SUMMARY}\n`).toString("base64") : script.includes("find fixtures public") ? productFiles.join("\n") : script.includes("ls -1") ? pngs.join("\n") : script.includes("grep -l") ? vrChecked.join("\n") : "";
    return { exitCode: 0, stdout: async () => stdout, stderr: async () => "" };
  },
};

const canMock = typeof (mock as { module?: unknown }).module === "function";
let builder: typeof import("../builder");

describe("collectVerifyResult", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module("@vercel/sandbox", {
      namedExports: { APIError: class APIError extends Error {}, Sandbox: { get: async () => fakeSandbox } },
    });
    mock.module(new URL("../../storage.ts", import.meta.url).href, {
      namedExports: { putFile: async () => "https://blob/x", fetchBytes: async () => Buffer.alloc(0) },
    });
    builder = await import("../builder");
  });

  const collect = () => builder.collectVerifyResult({ sandboxName: "sb", buildId: "b", round: 0, exitCode: 0, outputTail: "ok", skipUpload: true });

  it("reads the summary and keeps every screenshot when there are a few", async () => {
    pngs = ["01-start.png", "02-chart.png", "03-explained.png"];
    const { summary, screenshots } = await collect();
    assert.equal(summary.passed, true);
    assert.deepEqual(
      screenshots.map((s) => s.caption),
      ["Start", "Chart", "Explained"],
    );
    assert.equal(screenshots[2]!.url, "sandbox://sb/vercel/app/test-results/judge/03-explained.png");
  });

  it("says which screenshots were taken inside VR", async () => {
    pngs = ["01-start.png", "02-in-vr.png", "03-result.png"];
    vrChecked = ["02-in-vr.checked", "03-result.checked"];
    const { screenshots } = await collect();
    vrChecked = [];
    assert.deepEqual(screenshots.map((s) => s.caption), ["Start", "In vr (VR view)", "Result (VR view)"]);
  });

  it("keeps the first and the last seven of more than eight, so the last one is still the final screen", async () => {
    pngs = Array.from({ length: 11 }, (_, i) => `${String(i + 1).padStart(2, "0")}-step.png`);
    const { screenshots } = await collect();
    assert.deepEqual(
      screenshots.map((s) => s.url.split("/").pop()),
      ["01-step.png", "05-step.png", "06-step.png", "07-step.png", "08-step.png", "09-step.png", "10-step.png", "11-step.png"],
    );
  });
});

describe("collectJudgeSamples", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  const collect = () => builder.collectJudgeSamples({ sandboxName: "sb", buildId: "b", round: 1, skipUpload: true });

  it("sends one JPEG for each sample: a video's frame, and an image re-encoded", async () => {
    productFiles = ["public/samples/puppy.mp4", "fixtures/room.jpg", "public/favicon.png"];
    framed = [];
    const samples = await collect();
    assert.deepEqual(samples, [
      { url: "sandbox://sb/vercel/musemuse/run/judge-sample-1.jpg", fileName: "public/samples/puppy.mp4", kind: "video" },
      { url: "sandbox://sb/vercel/musemuse/run/judge-sample-2.jpg", fileName: "fixtures/room.jpg", kind: "image" },
    ]);
    assert.equal(framed.length, 2);
    assert.match(framed[0]!, /ffmpeg -nostdin .*'\/vercel\/app\/public\/samples\/puppy\.mp4'.*thumbnail/);
    assert.match(framed[1]!, /ffmpeg -nostdin .*'\/vercel\/app\/fixtures\/room\.jpg'.*-frames:v 1/);
  });

  it("leaves out a sample ffmpeg can't read", async () => {
    productFiles = ["fixtures/broken.mp4", "fixtures/broken.png"];
    frameExit = 1;
    assert.deepEqual(await collect(), []);
    frameExit = 0;
  });
});
