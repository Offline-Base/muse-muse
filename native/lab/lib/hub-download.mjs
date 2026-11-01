// A tuned model's public GGUF from the Hugging Face Hub, for gguf_emu. downloadFile only takes Vercel Blob and the platform
// and stops at 600 MB, so this has its own rules: a file pinned by repo, commit and checksum, its exact size and no token,
// and redirects followed only to the Hub's own hosts. Files are cached by checksum, and the agent's cache limit prunes them.
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LabError } from "./errors.mjs";

const MAX_HOPS = 4;

/** Is this a host the Hub stores its files on? */
export function isHubHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "huggingface.co" || host.endsWith(".huggingface.co") || host === "hf.co" || host.endsWith(".hf.co");
}

export const hubFileUrl = ({ repo, commit, name }) => `https://huggingface.co/${repo}/resolve/${commit}/${name}`;

async function fetchFollowing(start, doFetch, signal) {
  let url = start;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !isHubHost(parsed.hostname)) throw new LabError("download_failed", "The Hub sent the download somewhere else.");
    const res = await doFetch(url, { redirect: "manual", signal });
    if (res.status < 300 || res.status >= 400) return res;
    const next = res.headers.get("location");
    if (!next) throw new LabError("download_failed", "The Hub's redirect had no address.");
    url = new URL(next, url).toString();
  }
  throw new LabError("download_failed", "The Hub redirected too many times.");
}

/**
 * @param {{ repo: string, commit: string, name: string, sha256: string, bytes: number }} spec
 * @param {{ cacheDir: string, tempDir: string, fetch?: typeof fetch, signal?: AbortSignal }} opts
 * @returns {Promise<string>} the local path
 */
export async function downloadHubFile(spec, { cacheDir, tempDir, fetch: doFetch = fetch, signal }) {
  const cached = path.join(cacheDir, spec.sha256);
  if ((await stat(cached).catch(() => null))?.isFile()) return cached;
  await mkdir(cacheDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  // In the cache's folder, so the rename can't cross a volume. A job's folder is removed with the job, this isn't, so it goes on any failure.
  const temp = path.join(cacheDir, `partial-${randomBytes(6).toString("hex")}`);
  let res;
  try {
    res = await fetchFollowing(hubFileUrl(spec), doFetch, signal);
  } catch (err) {
    if (err instanceof LabError) throw err;
    if (signal?.aborted) throw new LabError("canceled", "The job was stopped.");
    throw new LabError("download_failed", `The download failed: ${err?.message ?? "no answer"}.`);
  }
  if (!res.ok || !res.body) throw new LabError("download_failed", `The Hub answered ${res.status}.`);

  const hash = createHash("sha256");
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > spec.bytes) {
        done(new LabError("download_failed", "The download is larger than its record says."));
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
  if (bytes !== spec.bytes) {
    await rm(temp, { force: true });
    throw new LabError("download_failed", `The download was ${bytes} bytes, not ${spec.bytes}.`);
  }
  if (hash.digest("hex") !== spec.sha256) {
    await rm(temp, { force: true });
    throw new LabError("checksum_mismatch", "The download didn't match its checksum.");
  }
  await rename(temp, cached);
  return cached;
}
