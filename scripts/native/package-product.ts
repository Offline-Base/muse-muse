/**
 * Runs the real packager for one product, by hand or as a spike, with no database (docs/NATIVE_PACKAGER.md):
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/native/package-product.ts --name "Fern & Moss" --url https://... \
 *     [--kinds android,mac,windows] [--icon <file>] [--out <dir>] [--delete]
 *
 * It needs PACKAGER_SNAPSHOT_ID and a Blob credential, or none for a local run (files go to .data/files). --out saves each
 * package to that folder, and --delete removes them from Blob afterward. It deletes its sandbox either way.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { del } from "@vercel/blob";
import { localFilesEnabled } from "@/lib/local-files";
import { collectPackaging, packageIdFor, pollPackaging, startPackaging, stopPackaging, type PackageResult } from "@/lib/native/packager";
import { SHELL_TEMPLATE_KINDS, type ShellTemplateKind } from "@/lib/native/shells";
import { blobAuth, fetchBytes } from "@/lib/storage";

const POLL_MS = 3_000;

function flag(name: string): string | null {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? "") : null;
}

async function main() {
  const name = flag("--name");
  const url = flag("--url");
  if (!name || !url) throw new Error('Say --name "<name>" and --url <url>.');
  const kinds = (flag("--kinds")?.split(",") ?? SHELL_TEMPLATE_KINDS) as ShellTemplateKind[];
  const iconFile = flag("--icon");
  const icon = iconFile ? await readFile(iconFile) : null;
  const req = { runId: randomUUID(), productId: randomUUID(), slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, url, kinds, icon };
  console.log(`package id ${packageIdFor(req.productId)}`);

  const started = Date.now();
  const handle = await startPackaging(req, started);
  console.log(`started in ${((Date.now() - started) / 1000).toFixed(1)} s on ${handle.sandboxName}`);
  try {
    let result: PackageResult | null = null;
    while (!result) {
      const state = await pollPackaging(handle);
      if (state.state === "failed") throw new Error(state.reason);
      if (state.state === "finished") result = state.result;
      else await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    console.log(`in the sandbox: ${(((result.ms ?? 0) as number) / 1000).toFixed(1)} s, icon ${result.icon}${result.warning ? `, ${result.warning}` : ""}`);
    for (const [kind, entry] of Object.entries(result.packages)) {
      console.log(`  ${kind}: ${entry?.ok ? `made in ${((entry.madeMs ?? 0) / 1000).toFixed(1)} s, uploaded in ${((entry.uploadMs ?? 0) / 1000).toFixed(1)} s, ${JSON.stringify(entry.timings)}` : entry?.error}`);
    }

    const { files, failures } = await collectPackaging(handle, result);
    console.log(`end to end: ${((Date.now() - started) / 1000).toFixed(1)} s`);
    for (const file of files) console.log(`  ${file.kind}: ${(file.bytes / 1e6).toFixed(1)} MB, ${file.sha256.slice(0, 12)}, signed with ${file.signedWith ?? "n/a"}, ${file.pathname}`);
    for (const [kind, why] of Object.entries(failures)) console.log(`  ${kind} FAILED: ${why}`);

    const out = flag("--out");
    if (out) {
      await mkdir(out, { recursive: true });
      for (const file of files) await writeFile(path.join(out, path.posix.basename(file.pathname)), await fetchBytes(file.url));
    }
    if (process.argv.includes("--delete") && !localFilesEnabled()) {
      for (const file of files) await del(file.url, blobAuth());
      console.log("deleted from Blob");
    }
    if (Object.keys(failures).length) process.exitCode = 1;
  } finally {
    await stopPackaging(handle);
    console.log("sandbox deleted");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
