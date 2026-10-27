/**
 * Creates the warm builder snapshot every product sandbox starts from. Run it again whenever template/ changes:
 *
 *   npm run snapshot
 *
 * It boots `vercel/sandbox/universal` with open egress, installs ffmpeg, fonts, espeak-ng, Playwright's Chromium and
 * Muse Code, copies template/ to /vercel/app, runs npm ci, commits the template, then snapshots with no expiry.
 * Builds start from the snapshot and run with the locked-down policy in lib/sandbox/policy.ts.
 * Save the printed id as BUILDER_SNAPSHOT_ID.
 */
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { SNAPSHOT_POLICY } from "@/lib/sandbox/policy";
import { readTemplateFiles, setupBuilder, templateHash } from "@/lib/sandbox/setup";

const MIN = 60_000;

async function main() {
  const started = Date.now();
  const timings: Array<{ step: string; ms: number; detail?: string }> = [];
  const log = (step: string, ms: number, detail?: string) => {
    timings.push({ step, ms, detail });
    console.log(`  ${(ms / 1000).toFixed(1).padStart(6)} s  ${step}${detail ? `  (${detail})` : ""}`);
  };

  const files = await readTemplateFiles(path.join(process.cwd(), "template"));
  console.log(`template: ${files.length} files, hash ${templateHash(files)}`);

  let t = Date.now();
  const sandbox = await Sandbox.create({
    name: `musemuse-builder-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`,
    persistent: false,
    resources: { vcpus: 4 },
    timeout: 30 * MIN,
    ports: [3000],
    networkPolicy: SNAPSHOT_POLICY,
    tags: { app: "musemuse", role: "builder-snapshot" },
  });
  log("create sandbox", Date.now() - t, sandbox.name);

  let snapshotId: string | null = null;
  try {
    const info = await setupBuilder(sandbox, files, log);
    console.log("builder:", JSON.stringify(info));

    t = Date.now();
    const snapshot = await sandbox.snapshot({ expiration: 0 });
    snapshotId = snapshot.snapshotId;
    log("snapshot", Date.now() - t, `${snapshot.snapshotId}, ${Math.round(snapshot.sizeBytes / 1e6)} MB, ${snapshot.status}`);
  } finally {
    // Snapshotting stops the VM. Delete the builder sandbox either way; the snapshot outlives it.
    await sandbox.stop().catch(() => {});
    await sandbox.delete({ deleteOrphanSnapshots: false }).catch((err) => console.warn("delete builder sandbox:", String(err)));
  }

  console.log(`\nTotal ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log(`BUILDER_SNAPSHOT_ID=${snapshotId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
