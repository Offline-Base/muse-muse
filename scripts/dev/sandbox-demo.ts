/**
 * Focused test of verify screenshots and the demo MP4, with no Muse Code run: provisions a sandbox from the snapshot,
 * writes a smoke test with several captioned steps and two judge screenshots, runs verify and demo, then
 * collectVerifyResult and finishDemo with skipUpload. Saves frames and the MP4 locally for a look.
 *   npx tsx --env-file=.env.local scripts/dev/sandbox-demo.ts <snapshotId> [outDir]
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Sandbox } from "@vercel/sandbox";
import { collectVerifyResult, finishDemo, pollTask, provisionSandbox, startTask, writeProductFile } from "@/lib/sandbox/builder";
import { sh } from "@/lib/sandbox/shell";

const snapshotId = process.argv[2];
if (!snapshotId?.startsWith("snap_")) throw new Error("usage: sandbox-demo.ts <snapshotId> [outDir]");
process.env.BUILDER_SNAPSHOT_ID = snapshotId;
const out = process.argv[3] || "/tmp/musemuse-demo";
mkdirSync(out, { recursive: true });

const SMOKE = `import { test, expect } from "@playwright/test";

test("shows the page and its footer", async ({ page }) => {
  await test.step("Open the product", async () => {
    await page.goto("/");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "test-results/judge/01-start.png", fullPage: true });
  });
  await test.step("Scroll to the footer that says it was built with Muse Muse and is not an official Meta product", async () => {
    await page.getByText("Built with Muse Muse. Not an official Meta product.").scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
  });
  await test.step("Check the result", async () => {
    await expect(page.getByText("Built with Muse Muse. Not an official Meta product.")).toBeVisible();
    await page.screenshot({ path: "test-results/judge/02-the-result.png", fullPage: true });
    await page.waitForTimeout(1500);
  });
});
`;

const t0 = Date.now();
const s = (t = t0) => `${((Date.now() - t) / 1000).toFixed(1)} s`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function runTask(name: string, task: "verify" | "demo") {
  const { cmdId } = await startTask(name, task);
  for (;;) {
    await sleep(3000);
    const p = await pollTask(name, cmdId);
    if (p.done) return p;
  }
}

const slug = `demo-${Date.now().toString(36)}`;
const buildId = randomUUID();
const { sandboxName } = await provisionSandbox({
  buildId,
  slug,
  references: [],
  fixtures: [],
  promptMarkdown: "# Brief\n\nDemo test.\n",
  buildToken: "mm_build_test",
  gatewayUrl: "https://example.invalid/api/gateway",
});
console.log(`provisioned ${sandboxName} in ${s()}`);
try {
  await writeProductFile(sandboxName, "tests/smoke.spec.ts", SMOKE);
  let t = Date.now();
  const v = await runTask(sandboxName, "verify");
  console.log(`verify exit ${v.exitCode} in ${s(t)}`);
  t = Date.now();
  const r = await collectVerifyResult({ sandboxName, buildId, round: 1, exitCode: v.exitCode, outputTail: v.outputTail, skipUpload: true });
  console.log(`collectVerifyResult in ${s(t)}: passed ${r.summary.passed}, steps ${r.summary.steps.map((x) => `${x.name}:${x.ok}`).join(" ")}`);
  console.log(`screenshots: ${JSON.stringify(r.screenshots)}`);

  t = Date.now();
  const d = await runTask(sandboxName, "demo");
  console.log(`demo exit ${d.exitCode} in ${s(t)}`);
  t = Date.now();
  const f = await finishDemo({
    sandboxName,
    buildId,
    title: "Shelf Planner for a Very Long Product Name That Wraps",
    subtitle: "From a photo of a cafe bookshelf and the note: make me one for my wall, with sizes I can buy at a hardware store",
    skipUpload: true,
  });
  console.log(`finishDemo in ${s(t)}: ${JSON.stringify(f)}`);
  if (f.videoUrl) {
    const sb = await Sandbox.get({ name: sandboxName, resume: true });
    const mp4 = f.videoUrl.replace(`sandbox://${sandboxName}`, "");
    const probe = await sh(sb, `ffprobe -v error -show_entries stream=codec_name,width,height,pix_fmt -show_entries format=duration,size -of compact ${mp4}`);
    console.log(`ffprobe: ${probe.stdout.trim().replace(/\n/g, " | ")}`);
    const frames: Array<[string, number]> = [["title", 1.2], ["cap1", 3.2], ["cap2", 5.0], ["cap3", 7.0]];
    for (const [name, at] of frames) {
      await sh(sb, `ffmpeg -y -loglevel error -ss ${at} -i ${mp4} -frames:v 1 /tmp/${name}.png`, { allowFail: true });
      const buf = await sb.readFileToBuffer({ path: `/tmp/${name}.png` }).catch(() => null);
      if (buf) writeFileSync(`${out}/${name}.png`, buf);
    }
    const shot = await sb.readFileToBuffer({ path: "/vercel/app/test-results/judge/02-the-result.png" });
    if (shot) writeFileSync(`${out}/judge-02.png`, shot);
    console.log(`frames saved to ${out}`);
  }
} finally {
  const sb = await Sandbox.get({ name: sandboxName });
  await sb.delete({ deleteOrphanSnapshots: true });
  console.log(`deleted ${sandboxName}, total ${s()}`);
}
