#!/usr/bin/env node
// Runs in the packager sandbox: node package.mjs <job.json>. Makes each package the job asks for and uploads it through the
// presigned slot the platform handed out. The sandbox holds no other credential, and its firewall allows only Blob's hosts.
//
// One package failing never stops the others. The last line of stdout is the result as JSON, and the exit code is 0 unless the
// job itself couldn't be read.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { uploadThroughSlot } from "../lab/lib/blob.mjs";
import { packageAndroid } from "./lib/android.mjs";
import { masterIcon } from "./lib/icons.mjs";
import { JobError, parseJob } from "./lib/job.mjs";
import { packageMac } from "./lib/mac.mjs";
import { packageWindows } from "./lib/windows.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELLS_DIR = process.env.MUSE_SHELLS_DIR ?? path.join(HERE, "..", "shells");
const PROJECT_DIR = process.env.MUSE_PACKAGER_PROJECT ?? path.join(HERE, "project");
const WORK_DIR = process.env.MUSE_PACKAGER_WORK ?? "/tmp/muse-packager";
const BUILD_TOOLS_DIR = process.env.MUSE_BUILD_TOOLS_DIR ?? "/usr/bin";

// So zip and unzip keep a product's name as UTF-8 and mark it so, or Windows shows it garbled.
process.env.LC_ALL = "C.UTF-8";

const CONTENT_TYPES = { android: "application/vnd.android.package-archive", mac: "application/zip", windows: "application/zip" };
const TEMPLATE_FILES = { android: "android.apk", mac: "mac.zip", windows: "windows.zip" };

async function sha256Of(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** The template this job names: the copy baked into the snapshot if it's the same file, or a download from Blob. */
async function templatePath(kind, job) {
  const want = job.templates[kind];
  const baked = path.join(SHELLS_DIR, job.shellVersion, TEMPLATE_FILES[kind]);
  if (existsSync(baked)) {
    const side = await readFile(`${baked}.sha256`, "utf8").catch(() => "");
    if (side.trim() === want.sha256) return baked;
  }
  if (typeof want.url !== "string" || !want.url.startsWith("https://")) throw new Error(`The ${kind} template isn't in this snapshot and has no download.`);
  const dir = path.join(WORK_DIR, "templates");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, TEMPLATE_FILES[kind]);
  const res = await fetch(want.url);
  if (!res.ok || !res.body) throw new Error(`The ${kind} template didn't download (${res.status}).`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  const got = await sha256Of(file);
  if (got !== want.sha256) throw new Error(`The ${kind} template's checksum doesn't match.`);
  return file;
}

async function makeOne(kind, job, master) {
  const started = Date.now();
  const template = await templatePath(kind, job);
  const workDir = path.join(WORK_DIR, kind);
  const common = { template, product: job.product, workDir, sharp, master };
  const made =
    kind === "android"
      ? { path: await packageAndroid({ ...common, projectRoot: PROJECT_DIR, androidBuildToolsDir: BUILD_TOOLS_DIR }), timings: {} }
      : kind === "mac"
        ? await packageMac(common)
        : await packageWindows(common);
  const madeMs = Date.now() - started;
  const sha256 = await sha256Of(made.path);
  const uploadStarted = Date.now();
  const stored = await uploadOutput(job.outputs[kind], made.path, CONTENT_TYPES[kind]);
  const { size } = await stat(made.path);
  return {
    ok: true,
    ...stored,
    bytes: size,
    sha256,
    ms: Date.now() - started,
    madeMs,
    uploadMs: Date.now() - uploadStarted,
    timings: made.timings,
  };
}

/** Through a Blob slot, or kept here for the platform to fetch when it has no Blob store (a local run). */
async function uploadOutput(slot, file, contentType) {
  if (slot.method === "keep") {
    const kept = path.join(WORK_DIR, "out", slot.name);
    await mkdir(path.dirname(kept), { recursive: true });
    await pipeline(createReadStream(file), createWriteStream(kept));
    return { keptAt: kept, pathname: slot.pathname };
  }
  return uploadThroughSlot(slot, file, contentType);
}

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath) throw new JobError("Say which job file to run.");
  const job = parseJob(JSON.parse(await readFile(jobPath, "utf8")));
  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(WORK_DIR, { recursive: true });

  const started = Date.now();
  const source = job.iconPath ? await readFile(job.iconPath).catch(() => null) : null;
  const master = await masterIcon(sharp, job.product.name, source);
  const outcomes = await Promise.all(
    job.kinds.map(async (kind) => {
      try {
        return [kind, await makeOne(kind, job, master.png)];
      } catch (error) {
        return [kind, { ok: false, error: String(error?.message ?? error).slice(0, 2000) }];
      } finally {
        // The next package needs the room more than anyone needs this.
        await rm(path.join(WORK_DIR, kind), { recursive: true, force: true }).catch(() => {});
      }
    }),
  );
  const result = { v: 1, ms: Date.now() - started, icon: master.fromProduct ? "product" : "tile", warning: master.warning, packages: Object.fromEntries(outcomes) };
  await writeFile(path.join(WORK_DIR, "result.json"), JSON.stringify(result));
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.log(JSON.stringify({ v: 1, error: String(error?.message ?? error).slice(0, 2000), packages: {} }));
  process.exitCode = error instanceof JobError ? 2 : 1;
});
