/**
 * Makes the builder image Modal build sandboxes start from (SANDBOX_HOST=modal, docs/MODAL_HOST.md): the Modal
 * counterpart of scripts/make-builder-snapshot.ts. Built, not run yet (Nov 2).
 *
 *   npx tsx scripts/dev/modal-builder-image.ts
 *
 * Boots BASE_IMAGE on Modal with open egress, runs the same setupBuilder as the Vercel snapshot (system tools, fonts,
 * Playwright's Chromium, Muse Code, template/ with npm ci, the pristine and targets copies), stops it, which publishes
 * the filesystem as an image with no expiry, and prints the image id. Save it as MODAL_BUILDER_IMAGE_ID. The checks the
 * Vercel script makes on the pristine and targets copies aren't repeated here. Uses the local Modal login or
 * MODAL_TOKEN_ID and MODAL_TOKEN_SECRET, and never prints them.
 */
import path from "node:path";
import { env } from "@/lib/env";
import { createModalHost, imageNameFor, loadModalSdk } from "@/lib/sandbox/host/modal";
import { readCapFiles, readTargetFiles, readTemplateFiles, setupBuilder, templateHash } from "@/lib/sandbox/setup";

async function main() {
  const dir = path.join(process.cwd(), "template");
  const [files, targets, caps] = await Promise.all([readTemplateFiles(dir), readTargetFiles(dir), readCapFiles(dir)]);
  console.log(`template: ${files.length} files, hash ${templateHash([...files, ...targets, ...caps])}`);
  let sdk: Awaited<ReturnType<typeof loadModalSdk>> | null = null;
  const host = createModalHost(async () => (sdk = await loadModalSdk(env.modalAppName)), { timeoutMs: 60 * 60_000, imageTtlMs: null });
  const name = `builder-image-${Date.now().toString(36)}`;
  const sandbox = await host.getOrCreate({ name, resources: { vcpus: 4 }, ports: [], timeout: 60 * 60_000, tags: { app: "musemuse", role: "builder-image" }, networkPolicy: "allow-all" });
  try {
    const started = Date.now();
    const info = await setupBuilder(sandbox, files, (step, ms, detail) => console.log(`  ${step}: ${Math.round(ms / 1000)} s${detail ? ` (${detail})` : ""}`), targets, caps);
    console.log(`setup done in ${Math.round((Date.now() - started) / 1000)} s, Muse Code ${info.muse}`);
    await sandbox.stop();
    const image = await sdk!.imageFromName(imageNameFor(name));
    console.log(`\nMODAL_BUILDER_IMAGE_ID=${image.imageId}`);
  } catch (err) {
    await sandbox.delete().catch(() => {});
    throw err;
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
