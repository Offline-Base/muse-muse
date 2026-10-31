// Downloads for jobs: shell builds, packages and sample media. Only from Vercel Blob or the platform, and checked against
// the job's checksum when it gives one. Files with a checksum are cached by it, so a shell build comes down once.
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LabError } from "./errors.mjs";
import { downloadUrlProblem } from "./validate.mjs";

const MAX_BYTES = 600 * 1024 * 1024;

/**
 * @param {{ url: string, sha256?: string | null, bytes?: number | null }} spec
 * @param {object} opts
 * @param {string} opts.cacheDir
 * @param {string} opts.tempDir
 * @param {string | null} [opts.platformOrigin]
 * @param {boolean} [opts.allowInsecure]
 * @param {typeof fetch} [opts.fetch]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>} the local path
 */
export async function downloadFile(spec, opts) {
  const { cacheDir, tempDir, platformOrigin = null, allowInsecure = false, fetch: doFetch = fetch, signal } = opts;
  const problem = downloadUrlProblem(spec.url, { platformOrigin, allowInsecure });
  if (problem) throw new LabError("download_failed", `The download address ${problem}.`);

  const cached = spec.sha256 ? path.join(cacheDir, spec.sha256) : null;
  if (cached) {
    const found = await stat(cached).catch(() => null);
    if (found?.isFile()) return cached;
  }

  await mkdir(tempDir, { recursive: true });
  const temp = path.join(tempDir, `download-${randomBytes(6).toString("hex")}`);
  let res;
  try {
    res = await doFetch(spec.url, { redirect: "error", signal });
  } catch (err) {
    if (signal?.aborted) throw new LabError("canceled", "The job was stopped.");
    throw new LabError("download_failed", `The download failed: ${err?.message ?? "no answer"}.`);
  }
  if (!res.ok || !res.body) throw new LabError("download_failed", `The download answered ${res.status}.`);

  const hash = createHash("sha256");
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        done(new LabError("download_failed", "The download is too large."));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(temp), { signal });
  } catch (err) {
    await rm(temp, { force: true });
    if (err instanceof LabError) throw err;
    if (signal?.aborted) throw new LabError("canceled", "The job was stopped.");
    throw new LabError("download_failed", `The download stopped: ${err?.message ?? "no reason given"}.`);
  }

  if (spec.bytes && bytes !== spec.bytes) {
    await rm(temp, { force: true });
    throw new LabError("download_failed", `The download was ${bytes} bytes, not ${spec.bytes}.`);
  }
  if (spec.sha256 && hash.digest("hex") !== spec.sha256) {
    await rm(temp, { force: true });
    throw new LabError("checksum_mismatch", "The download didn't match its checksum.");
  }
  if (!cached) return temp;
  await mkdir(cacheDir, { recursive: true });
  await rename(temp, cached);
  return cached;
}
