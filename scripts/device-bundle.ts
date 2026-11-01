/**
 * Packs muse-device/ at a commit into a tarball for a board (docs/DRIVE_EXPORT.md, "Deploying to a real board"), and
 * prints its sha256 and the fleet job's commands that fetch it, check it and set drive export up. The repo is private, so
 * a board can't fetch it from GitHub without a key, and shouldn't hold one.
 *
 * With --upload it also puts the tarball on public Blob, which writes to the site's store, so the owner runs that. Nothing
 * here touches a board: the deploy is Hussam's, or a fleet job the owner approves.
 *
 *   npx tsx scripts/device-bundle.ts [--commit HEAD] [--out <folder>]
 *   npx tsx --env-file-if-exists=.env.local scripts/device-bundle.ts --upload
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { put } from "@vercel/blob";
import { blobAuth } from "@/lib/storage";

const run = promisify(execFile);

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { commit: { type: "string", default: "HEAD" }, out: { type: "string" }, upload: { type: "boolean", default: false } } });
  const commit = (await run("git", ["rev-parse", "--verify", `${values.commit}^{commit}`])).stdout.trim();
  const out = values.out ?? (await fs.mkdtemp(path.join(os.tmpdir(), "muse-device-")));
  const file = path.join(out, `muse-device-${commit.slice(0, 12)}.tar.gz`);
  // Only what a board runs: no fixtures, no tests and no notes.
  const keep = ["server.py", "drive.py", "train.py", "setup-train.sh", "setup-drive.sh", "requirements-train.lock", "test_drive_loop.py", "fixtures/plan-small.json"];
  await run("git", ["archive", "--format=tar.gz", `--output=${file}`, commit, ...keep.map((name) => `muse-device/${name}`)]);
  const sha256 = createHash("sha256").update(await fs.readFile(file)).digest("hex");
  console.log(`${file}\nsha256 ${sha256}\ncommit ${commit}`);
  if (!values.upload) {
    console.log("Not uploaded. Run it again with --upload for a link a board can fetch.");
    return;
  }
  const blob = await put(`drive-kit/muse-device/${sha256}.tar.gz`, await fs.readFile(file), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/gzip",
    ...blobAuth(),
  });
  console.log(`Uploaded to ${blob.url}`);
  console.log("\nOn the board, as root, in a fleet job the owner approved (board in maintenance first):");
  console.log(`  curl -fsSL -o /tmp/md.tgz '${blob.url}' && echo '${sha256}  /tmp/md.tgz' | sha256sum -c -`);
  console.log("  tar -xzf /tmp/md.tgz -C /tmp && cp -R /tmp/muse-device/. <muse-device folder>/");
  console.log("  <muse-device folder>/setup-drive.sh <the server's user> && systemctl restart muse-device");
  console.log("  cd <muse-device folder> && python3 -m unittest test_drive_loop");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
