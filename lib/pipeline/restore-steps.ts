/**
 * The sandbox side of a restore (docs/VERSIONS.md): the saved files go in, and what the version didn't have comes out.
 * Files hidden from versions (env files, the platform's build files) and everything never deployed are left alone.
 */
import { Sandbox } from "@vercel/sandbox";
import { eq } from "drizzle-orm";
import { FatalError } from "workflow";
import { db, schema } from "@/lib/db/client";
import { DEPLOY_EXCLUDE_DIRS } from "@/lib/publish/vercel";
import { OUT_DIR, PRODUCT_DIR, RUN_DIR } from "@/lib/sandbox/paths";
import { q, sh } from "@/lib/sandbox/shell";
import { isSafePath, restorePlan } from "@/lib/versions/policy";
import { readVersionFile, versionOf } from "@/lib/versions/store";

const LIST_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const [root, out, ...skip] = process.argv.slice(2);
const skipDirs = new Set(skip);
const files = [];
(function walk(rel) {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) { if (!skipDirs.has(e.name)) walk(child); continue; }
    if (!e.isFile()) continue;
    files.push({ path: child, sha: crypto.createHash("sha1").update(fs.readFileSync(path.join(root, child))).digest("hex") });
  }
})("");
fs.writeFileSync(out, JSON.stringify(files));
`;

const REMOVE_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const [root, list] = process.argv.slice(2);
for (const p of JSON.parse(fs.readFileSync(list, "utf8"))) fs.rmSync(path.join(root, p), { force: true });
`;

/** Writes at most this many bytes to the sandbox per call. */
const WRITE_BATCH_BYTES = 16 * 1024 * 1024;

/**
 * Puts a saved version's files in the product's sandbox and commits them there, on top of what's there. `fromBuildId`
 * null means the product's live version, which is how a failed restore goes back.
 */
export async function restoreFilesStep(input: { buildId: string; productId: string; sandboxName: string; fromBuildId: string | null }): Promise<void> {
  "use step";
  let from = input.fromBuildId;
  if (!from) {
    const [row] = await db().select({ latest: schema.products.latestBuildId }).from(schema.products).where(eq(schema.products.id, input.productId)).limit(1);
    from = row?.latest ?? null;
  }
  const version = from ? await versionOf(input.productId, from) : null;
  if (!version) throw new FatalError("That version's files weren't kept, so it can't be restored.");

  const sandbox = await Sandbox.get({ name: input.sandboxName, resume: true });
  const script = `${RUN_DIR}/restore-list.cjs`;
  const remover = `${RUN_DIR}/restore-remove.cjs`;
  const listFile = `${OUT_DIR}/restore-files.json`;
  const removeFile = `${OUT_DIR}/restore-remove.json`;
  await sandbox.writeFiles([
    { path: script, content: LIST_SCRIPT },
    { path: remover, content: REMOVE_SCRIPT },
  ]);
  await sh(sandbox, `mkdir -p ${q(OUT_DIR)} && node ${[script, PRODUCT_DIR, listFile, ...DEPLOY_EXCLUDE_DIRS].map(q).join(" ")}`, { timeoutMs: 60_000 });
  const listed = await sandbox.readFileToBuffer({ path: listFile });
  if (!listed) throw new Error("Could not list the product's files in its sandbox");
  const plan = restorePlan(JSON.parse(listed.toString("utf8")) as Array<{ path: string; sha: string }>, version.files);

  const queue = [...plan.write];
  const contents: Array<{ path: string; content: Buffer }> = [];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      if (!isSafePath(f.path)) throw new FatalError(`Not a file's path: ${f.path}`);
      const content = await readVersionFile(f);
      if (content) contents.push({ path: `${PRODUCT_DIR}/${f.path}`, content });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  let batch: typeof contents = [];
  let size = 0;
  for (const c of contents) {
    if (size + c.content.length > WRITE_BATCH_BYTES && batch.length) {
      await sandbox.writeFiles(batch);
      batch = [];
      size = 0;
    }
    batch.push(c);
    size += c.content.length;
  }
  if (batch.length) await sandbox.writeFiles(batch);
  await sandbox.writeFiles([{ path: removeFile, content: JSON.stringify(plan.remove) }]);
  await sh(sandbox, `node ${[remover, PRODUCT_DIR, removeFile].map(q).join(" ")}`, { timeoutMs: 60_000 });
  // A new commit on top, never a reset: Muse Code's own git log keeps the history too. No repo there is no problem.
  await sh(sandbox, `git add -A && git -c user.name='Muse Muse' -c user.email='noreply@musemuse.invalid' commit -qm 'Restore an earlier version' --allow-empty`, { cwd: PRODUCT_DIR, allowFail: true, timeoutMs: 60_000 });
}
restoreFilesStep.maxRetries = 2;

/** A restored version ships as what it was. */
export async function restoreOutcomeStep(fromBuildId: string): Promise<"live" | "partial"> {
  "use step";
  const [row] = await db().select({ status: schema.builds.status }).from(schema.builds).where(eq(schema.builds.id, fromBuildId)).limit(1);
  return row?.status === "partial" ? "partial" : "live";
}
