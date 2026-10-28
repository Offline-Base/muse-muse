/**
 * End-to-end test of lib/sandbox/builder.ts against real Vercel Sandbox and the real Meta API (through the firewall).
 *   npx tsx --env-file=.env.local scripts/dev/sandbox-e2e.ts <snapshotId> [--keep]
 *
 * Provisions product-e2e-<time> from the snapshot with data: URL references, runs a tiny Muse Code edit, previews,
 * verifies, records the demo MP4, reads the manifest, exports the transcript, kills a long command, hibernates,
 * reopens and resumes the Muse Code session. Blob isn't provisioned, so uploads are skipped (skipUpload) and the
 * local artifacts are checked instead. Deletes the sandbox and its snapshots at the end unless --keep.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { Sandbox } from "@vercel/sandbox";
import { collectDeployFiles } from "@/lib/publish/vercel";
import {
  collectVerifyResult,
  exportTranscript,
  finishDemo,
  hibernate,
  killCommand,
  pollMuse,
  pollTask,
  provisionSandbox,
  readBuildNotes,
  readManifest,
  reopenSandbox,
  sandboxNameFor,
  startMuse,
  startPreview,
  startTask,
  writeProductFile,
} from "@/lib/sandbox/builder";
import { LOG_DIR, PRODUCT_DIR } from "@/lib/sandbox/paths";
import { sh, writeRunner } from "@/lib/sandbox/shell";
import type { ModelUsage } from "@/lib/types";

const snapshotId = process.argv[2];
if (!snapshotId?.startsWith("snap_")) throw new Error("usage: sandbox-e2e.ts <snapshotId> [--keep]");
process.env.BUILDER_SNAPSHOT_ID = snapshotId;
const keep = process.argv.includes("--keep");
const SCRATCH = process.env.E2E_OUT || "/tmp/musemuse-e2e";
mkdirSync(SCRATCH, { recursive: true });

const timings: Array<[string, number]> = [];
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  process.stdout.write(`\n== ${name}\n`);
  try {
    const v = await fn();
    timings.push([name, Date.now() - t]);
    console.log(`   (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    return v;
  } catch (err) {
    timings.push([`${name} (FAILED)`, Date.now() - t]);
    console.log(`   FAILED after ${((Date.now() - t) / 1000).toFixed(1)} s: ${String(err).slice(0, 2000)}`);
    throw err;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A small solid-color PNG, so the test needs no files on disk. */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function runMuse(sandboxName: string, sessionId: string, promptFile: string, round: number, images: string[]) {
  const { cmdId, logPath } = await startMuse({ sandboxName, sessionId, promptFile, images, model: "muse-spark-1.3", maxModelSteps: 30, round });
  console.log(`   started ${cmdId}, log ${logPath}`);
  let offset = 0;
  let usage: ModelUsage[] = [];
  let finalText: string | null = null;
  const pollTimes: number[] = [];
  for (let i = 0; i < 200; i++) {
    await sleep(3000);
    const t = Date.now();
    const p = await pollMuse({ sandboxName, cmdId, logPath, offset });
    pollTimes.push(Date.now() - t);
    offset = p.offset;
    for (const l of p.lines) console.log(`   [${l.kind}${l.tool ? `:${l.tool}` : ""}${l.ok === false ? " FAIL" : ""}] ${l.text.slice(0, 200)}`);
    if (p.usage.length) usage = p.usage;
    if (p.finalText) finalText = p.finalText;
    if (p.done) {
      console.log(`   done, exit ${p.exitCode}, offset ${offset}, ${pollTimes.length} polls averaging ${Math.round(pollTimes.reduce((a, b) => a + b, 0) / pollTimes.length)} ms`);
      break;
    }
  }
  console.log(`   usage: ${JSON.stringify(usage)}`);
  return { finalText, usage };
}

async function waitTask(sandboxName: string, task: "verify" | "demo") {
  const { cmdId } = await startTask(sandboxName, task);
  console.log(`   started ${task} ${cmdId}`);
  for (let i = 0; i < 200; i++) {
    await sleep(5000);
    const p = await pollTask(sandboxName, cmdId);
    if (p.done) {
      console.log(`   ${task} exit ${p.exitCode}. Output tail:\n${p.outputTail.split("\n").slice(-25).map((l) => `     | ${l}`).join("\n")}`);
      return p;
    }
  }
  throw new Error(`${task} did not finish`);
}

async function main() {
  const slug = `e2e-${Date.now().toString(36)}`;
  const sessionId = randomUUID();
  const productId = randomUUID();
  const swatch = png(96, 96, [255, 112, 67]);
  const references = [
    {
      url: `data:image/png;base64,${swatch.toString("base64")}`,
      kind: "image" as const,
      fileName: "swatch.png",
      contentType: "image/png",
      size: swatch.length,
    },
  ];
  const fixtures = [{ fileName: "sample.txt", url: `data:text/plain;base64,${Buffer.from("A sample input.\n").toString("base64")}` }];
  const input = {
    buildId: randomUUID(),
    productId,
    slug,
    references,
    fixtures,
    promptMarkdown: "# Brief\n\nA tiny test product. The inspo is a coral color swatch.\n",
    buildToken: "mm_build_test_not_a_real_token",
    gatewayUrl: "https://example.invalid/api/gateway",
  };
  const sandboxName = sandboxNameFor(slug, productId);

  try {
    await step("provisionSandbox (fresh, from snapshot)", () => provisionSandbox(input).then((r) => console.log("  ", r)));
    await step("provisionSandbox again (a retried step must not fail)", () => provisionSandbox(input).then((r) => console.log("  ", r)));

    await step("check files, env and egress lock", async () => {
      const sb = await Sandbox.get({ name: sandboxName, resume: true });
      const ls = await sh(sb, "ls -la inspo fixtures brief.md .env.local && file inspo/swatch.png && cat fixtures/sample.txt", { cwd: PRODUCT_DIR });
      console.log(ls.stdout.trim().split("\n").map((l) => `   ${l}`).join("\n"));
      const key = process.env.MODEL_API_KEY ?? "";
      const envOut = await sh(sb, "env; cat /vercel/app/.env.local; cat /vercel/app/brief.md");
      console.log(`   master key in sandbox env or files: ${key.length > 8 && envOut.stdout.includes(key)}`);
      const net = await sh(
        sb,
        [
          'echo "api.meta.ai/v1/models with placeholder key: $(curl -s -o /dev/null -w "%{http_code}" --max-time 15 -H "Authorization: Bearer brokered" https://api.meta.ai/v1/models)"',
          'echo "registry.npmjs.org: $(curl -s -o /dev/null -w "%{http_code}" --max-time 15 https://registry.npmjs.org/react)"',
          'echo "example.com: $(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://example.com/ || echo blocked)"',
          'echo "dev.meta.ai: $(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://dev.meta.ai/ || echo blocked)"',
        ].join("; "),
        { allowFail: true },
      );
      console.log(net.stdout.trim().split("\n").map((l) => `   ${l}`).join("\n"));
    });

    await step("writeProductFile task.md", () =>
      writeProductFile(
        sandboxName,
        "task.md",
        'Change the h1 in app/page.tsx to say "Hello from the pipeline" and set "name" in musemuse.json to "Pipeline Test". Do nothing else. Do not run npm or any tests.',
      ),
    );
    const first = await step("startMuse + pollMuse to completion", () => runMuse(sandboxName, sessionId, "task.md", 0, ["inspo/swatch.png", "inspo/missing.png"]));
    console.log(`   final text: ${first.finalText}`);

    await step("startPreview and fetch the public URL", async () => {
      const { url } = await startPreview(sandboxName);
      const t = Date.now();
      const res = await fetch(url);
      const html = await res.text();
      console.log(`   ${url} -> ${res.status} in ${Date.now() - t} ms, h1 updated: ${html.includes("Hello from the pipeline")}`);
      const again = await startPreview(sandboxName);
      console.log(`   second call (already running) returned ${again.url}`);
    });

    await step("collectDeployFiles (publish file collection)", async () => {
      const { files, skipped } = await collectDeployFiles(sandboxName);
      const bytes = files.reduce((s, f) => s + f.size, 0);
      const bad = files.filter((f) => /(^|\/)(node_modules|\.next|test-results|inspo|\.git)\//.test(f.file) || /(^|\/)\.env/.test(f.file));
      console.log(`   ${files.length} files, ${bytes} bytes, skipped ${skipped.length}, excluded paths leaked: ${bad.length}`);
      console.log(`   ${files.map((f) => f.file).join(", ")}`);
    });

    const verify = await step("startTask verify + pollTask", () => waitTask(sandboxName, "verify"));
    await step("collectVerifyResult (skipUpload)", async () => {
      const r = await collectVerifyResult({ sandboxName, buildId: input.buildId, round: 0, exitCode: verify.exitCode, outputTail: verify.outputTail, skipUpload: true });
      console.log(`   passed: ${r.summary.passed}`);
      for (const s of r.summary.steps) console.log(`   step ${s.name}: ${s.ok ? "ok" : "FAIL"} ${s.ms ?? ""} ms ${s.detail ? `(${s.detail.slice(0, 160)})` : ""}`);
      if (r.summary.failureOutput) console.log(`   failure: ${r.summary.failureOutput.slice(0, 800)}`);
      console.log(`   screenshots: ${JSON.stringify(r.screenshots)}`);
    });

    const demo = await step("startTask demo + pollTask", () => waitTask(sandboxName, "demo"));
    void demo;
    await step("finishDemo up to the MP4 (skipUpload)", async () => {
      const r = await finishDemo({
        sandboxName,
        buildId: input.buildId,
        title: "Pipeline Test",
        subtitle: "From a coral color swatch and the note: make a tiny test page that says hello",
        skipUpload: true,
      });
      console.log(`   ${JSON.stringify(r)}`);
      if (!r.videoUrl) return;
      const sb = await Sandbox.get({ name: sandboxName, resume: true });
      const mp4 = r.videoUrl.replace(`sandbox://${sandboxName}`, "");
      const probe = await sh(sb, `ffprobe -v error -show_entries stream=codec_name,profile,width,height,pix_fmt,r_frame_rate -show_entries format=duration,size -of compact ${mp4}`);
      console.log(`   ffprobe: ${probe.stdout.trim().replace(/\n/g, " | ")}`);
      await sh(sb, `ffmpeg -y -loglevel error -ss 1.2 -i ${mp4} -frames:v 1 /tmp/f-title.png && ffmpeg -y -loglevel error -ss 3.0 -i ${mp4} -frames:v 1 /tmp/f-cap.png`);
      for (const f of ["f-title", "f-cap"]) {
        const buf = await sb.readFileToBuffer({ path: `/tmp/${f}.png` });
        if (buf) writeFileSync(`${SCRATCH}/${f}.png`, buf);
      }
      const mp4buf = await sb.readFileToBuffer({ path: mp4 });
      if (mp4buf) writeFileSync(`${SCRATCH}/demo.mp4`, mp4buf);
      console.log(`   frames and MP4 saved to ${SCRATCH}`);
    });

    await step("readManifest and readBuildNotes", async () => {
      const m = await readManifest(sandboxName);
      console.log(`   manifest name: ${m?.name}, slug: ${m?.slug}`);
      console.log(`   build notes: ${JSON.stringify((await readBuildNotes(sandboxName))?.slice(0, 200) ?? null)}`);
    });

    await step("exportTranscript (skipUpload)", async () => {
      const r = await exportTranscript({ sandboxName, sessionId, buildId: input.buildId, skipUpload: true });
      console.log(`   url: ${r.url}`);
      console.log(`   highlights: ${JSON.stringify(r.highlights)}`);
      if (r.url) {
        const sb = await Sandbox.get({ name: sandboxName, resume: true });
        const p = r.url.replace(`sandbox://${sandboxName}`, "");
        const info = await sh(sb, `wc -c < ${p}; head -c 300 ${p}`);
        console.log(`   transcript bytes and start: ${info.stdout.slice(0, 400).replace(/\n/g, " ")}`);
      }
    });

    await step("killCommand on a long sleep (with a child process)", async () => {
      const sb = await Sandbox.get({ name: sandboxName, resume: true });
      const script = await writeRunner(sb, { name: "sleeper", cwd: PRODUCT_DIR, argv: ["bash", "-c", "sleep 600 & sleep 600; wait"], stdoutPath: `${LOG_DIR}/sleeper.log` });
      const cmd = await sb.runCommand({ cmd: "bash", args: [script], detached: true });
      await sleep(1500);
      const before = await sh(sb, "pgrep -fc 'sleep 600' || true");
      const t = Date.now();
      await killCommand(sandboxName, cmd.cmdId);
      const after = await sh(sb, "pgrep -fc 'sleep 600' || true");
      const state = await sb.getCommand(cmd.cmdId);
      console.log(`   sleeps before ${before.stdout.trim()}, after ${after.stdout.trim()}, exit ${state.exitCode}, kill took ${Date.now() - t} ms`);
    });

    await step("hibernate", async () => {
      await hibernate(sandboxName);
      const sb = await Sandbox.get({ name: sandboxName });
      let status = "";
      try {
        status = sb.status;
      } catch {
        status = "(no session)";
      }
      console.log(`   status after hibernate: ${status}`);
    });

    await step("reopenSandbox", () =>
      reopenSandbox({
        sandboxName,
        productId,
        buildToken: "mm_build_test_2",
        gatewayUrl: "https://example.invalid/api/gateway",
        newReferences: [{ ...references[0], fileName: "swatch-2.png" }],
      }),
    );

    await step("files, policy and session survived", async () => {
      const sb = await Sandbox.get({ name: sandboxName, resume: true });
      const r = await sh(
        sb,
        [
          'echo "h1 kept: $(grep -c "Hello from the pipeline" app/page.tsx)"',
          'echo "new inspo: $(ls inspo | tr "\\n" " ")"',
          'echo "env token: $(grep -c mm_build_test_2 .env.local)"',
          `echo "session dir: $(ls -d $HOME/.local/share/muse/sessions/*/*/*/${sessionId} 2>/dev/null | wc -l)"`,
          'echo "node_modules kept: $(ls node_modules | wc -l)"',
          'echo "api.meta.ai: $(curl -s -o /dev/null -w "%{http_code}" --max-time 15 -H "Authorization: Bearer brokered" https://api.meta.ai/v1/models)"',
          'echo "example.com: $(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://example.com/ || echo blocked)"',
        ].join("; "),
        { cwd: PRODUCT_DIR, allowFail: true },
      );
      console.log(r.stdout.trim().split("\n").map((l) => `   ${l}`).join("\n"));
    });

    await step("resume the Muse Code session (round 1)", async () => {
      await writeProductFile(sandboxName, "refine.md", "In one sentence, what did you change in this project in the previous turn? Do not edit any files.");
      const r = await runMuse(sandboxName, sessionId, "refine.md", 1, []);
      console.log(`   final text: ${r.finalText}`);
    });
  } finally {
    if (keep) console.log(`\nKept sandbox ${sandboxName}`);
    else {
      const t = Date.now();
      try {
        const sb = await Sandbox.get({ name: sandboxName });
        await sb.delete({ deleteOrphanSnapshots: true });
        console.log(`\nDeleted ${sandboxName} and its snapshots (${Date.now() - t} ms)`);
      } catch (err) {
        console.log(`\nCleanup of ${sandboxName}: ${String(err)}`);
      }
    }
    console.log("\nTimings:");
    for (const [name, ms] of timings) console.log(`  ${(ms / 1000).toFixed(1).padStart(6)} s  ${name}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
