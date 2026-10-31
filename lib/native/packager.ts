/**
 * Turns the shell templates into one product's downloads, in a short-lived sandbox (docs/NATIVE_PACKAGER.md). The workflow
 * calls startPackaging, then pollPackaging every 10 s, then collectPackaging, and stopPackaging from a `finally`. Each takes
 * and returns plain data, so they can be separate steps. A package that fails never stops the others.
 *
 * The sandbox holds no credentials, only presigned upload slots for its own output paths, and its firewall allows only
 * Blob's hosts. It reads the product's name and URL from job.json, never from a shell string.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BlobNotFoundError, del, head, issueSignedToken } from "@vercel/blob";
import { handleUploadPresigned } from "@vercel/blob/client";
import { APIError, Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { env } from "@/lib/env";
import { isSafeFileKey, localFilesEnabled, localFileUrl } from "@/lib/local-files";
import { apkSigner, readApkKey, signApk, type ApkKey } from "@/lib/native/apk-sign";
import { currentShells, SHELL_TEMPLATE_KINDS, type ShellRelease, type ShellTemplateKind } from "@/lib/native/shells";
import { NATIVE_DOWNLOADS, type NativeArtifactKind } from "@/lib/native/types";
import { NO_CALLBACK_KEY } from "@/lib/pipeline/inspo-upload";
import { BLOB_UPLOAD_HOSTS } from "@/lib/sandbox/policy";
import { q, sh } from "@/lib/sandbox/shell";
import { blobAuth, fetchBytes, localFilePaths, putBlobAt, sha256OfUrl } from "@/lib/storage";

export const PACKAGER_DIR = "/vercel/native";
export const PACKAGER_SHELLS_DIR = `${PACKAGER_DIR}/shells`;
const PACKAGER_SCRIPT = `${PACKAGER_DIR}/packager/package.mjs`;
const JOB_PATH = `${PACKAGER_DIR}/job.json`;
const ICON_PATH = `${PACKAGER_DIR}/icon-source`;
const RESULT_PATH = `${PACKAGER_DIR}/result.json`;
const LOG_PATH = `${PACKAGER_DIR}/package.log`;
const EXIT_PATH = `${PACKAGER_DIR}/package.exit`;

export const PACKAGER_VCPUS = 4;
/** How long a run may take before the workflow gives up on it. The Oct 31 spike took about a minute for all three. */
export const PACKAGING_LIMIT_MS = 8 * 60_000;
const SANDBOX_TIMEOUT_MS = PACKAGING_LIMIT_MS + 4 * 60_000;
const UPLOAD_TTL_MS = SANDBOX_TIMEOUT_MS + 2 * 60_000;

const MB = 1024 * 1024;
/** What each upload slot allows. The Mac template alone is 217 MB and Windows 158 MB, so these leave room for a big icon. */
export const PACKAGE_MAX_BYTES: Record<ShellTemplateKind, number> = { android: 120 * MB, mac: 320 * MB, windows: 260 * MB };
export const PACKAGE_CONTENT_TYPES: Record<ShellTemplateKind, string> = {
  android: "application/vnd.android.package-archive",
  mac: "application/zip",
  windows: "application/zip",
};
export const SHELL_CONTENT_TYPES = PACKAGE_CONTENT_TYPES;
/** The biggest shell template the admin upload route takes. */
export const SHELL_TEMPLATE_MAX_BYTES = 400 * MB;
const ICON_MAX_BYTES = 8 * MB;
const ICON_FETCH_MS = 5_000;
const MULTIPART_BYTES = 16 * MB;

/** Scripts on a laptop whose OIDC token has expired can sign in with a token instead. On Vercel the SDK uses the request's. */
export function sandboxCredentials(): { token: string; teamId: string; projectId: string } | Record<string, never> {
  const { VERCEL, VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env;
  return !VERCEL && token && teamId && projectId ? { token, teamId, projectId } : {};
}

export class PackagerUnavailableError extends Error {}

export interface PackageRequest {
  runId: string;
  productId: string;
  slug: string;
  name: string;
  /** The live product's URL. The shell opens this and nothing else. */
  url: string;
  kinds: readonly ShellTemplateKind[];
  /** The picture to use for the icon, if the caller has one. Otherwise startPackaging asks the product for its own. */
  icon?: Buffer | null;
}

/** One output of a package run. The upload goes to `uploadPathname`, and it's offered at `pathname`. */
export interface PackageSlotInfo {
  kind: ShellTemplateKind;
  pathname: string;
  uploadPathname: string;
  /** A local run with no Blob store: the package stays in the sandbox until the platform copies it out. */
  kept?: boolean;
}

/** What the workflow carries between steps. No secret is in it: the upload slots stay in the sandbox's job.json. */
export interface PackagingHandle {
  sandboxName: string;
  runId: string;
  shellVersion: string;
  startedAt: number;
  slots: PackageSlotInfo[];
  /** Kinds with no template in this shell release, with why. */
  skipped: Partial<Record<ShellTemplateKind, string>>;
}

export interface PackagedFile {
  kind: ShellTemplateKind;
  artifactKind: NativeArtifactKind;
  url: string;
  pathname: string;
  bytes: number;
  sha256: string;
  shellVersion: string;
  /** For an APK, who signed it. "debug" is the public key the sandbox used, because the platform had no key of its own. */
  signedWith: "platform" | "debug" | null;
  ms: number;
}

/**
 * One package in the sandbox's answer. It's the sandbox's own account, so `bytes` and `sha256` are only claims to check, and
 * any URL it reports is ignored: what's offered is what the platform finds in its own store.
 */
export interface PackageResultEntry {
  ok: boolean;
  error?: string;
  keptAt?: string;
  bytes?: number;
  sha256?: string;
  ms?: number;
  madeMs?: number;
  uploadMs?: number;
  timings?: Record<string, number>;
}

/** What package.mjs prints as its last line. */
export interface PackageResult {
  v: 1;
  ms?: number;
  error?: string;
  icon?: "product" | "tile";
  warning?: string | null;
  packages: Partial<Record<ShellTemplateKind, PackageResultEntry>>;
}

export type PackagingState = { state: "running" } | { state: "finished"; result: PackageResult } | { state: "failed"; reason: string };

export interface CollectedPackages {
  files: PackagedFile[];
  /** A plain sentence per kind that didn't make it. */
  failures: Partial<Record<ShellTemplateKind, string>>;
}

/** A stable package id for a product, so an update of its app installs over the last one. */
export function packageIdFor(productId: string): string {
  return `ai.musemuse.p${createHash("sha256").update(productId).digest("hex").slice(0, 16)}`;
}

function safeSlug(slug: string): string {
  const clean = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "app";
}

/** Where a run's packages live: under the run's own id, with clean file names (docs/NATIVE.md, Blob). */
export function packagePathname(req: Pick<PackageRequest, "productId" | "runId" | "slug">, kind: ShellTemplateKind): string {
  const name = kind === "android" ? `${safeSlug(req.slug)}.apk` : `${safeSlug(req.slug)}-${kind}.zip`;
  return `native/products/${req.productId}/${req.runId}/${name}`;
}

/** The APK's stop on the way: it leaves the sandbox with the debug key and only reaches its real path once re-signed. */
function unsignedPathname(pathname: string): string {
  return `${path.posix.dirname(pathname)}/unsigned/${path.posix.basename(pathname)}`;
}

export function packagerNetworkPolicy(): NetworkPolicy {
  return { allow: [...BLOB_UPLOAD_HOSTS] };
}

/** Why `pathname` can't take a shell template, or null. Only the three files of a release, by their exact names. */
export function checkShellPathname(pathname: unknown): string | null {
  if (typeof pathname !== "string" || !/^native\/shells\/[0-9A-Za-z.+-]{1,40}\/(android\.apk|mac\.zip|windows\.zip)$/.test(pathname) || !isSafeFileKey(pathname)) {
    return "Shell templates go to native/shells/<version>/android.apk, mac.zip or windows.zip.";
  }
  return null;
}

/** The platform's Android key, or null when none is set. A key that's set but broken throws, so nobody misses it. */
export function platformApkKey(): ApkKey | null {
  const encoded = env.nativeApkKeystoreB64;
  if (!encoded) return null;
  return readApkKey(Buffer.from(encoded, "base64").toString("utf8"), env.nativeApkKeystorePassword);
}

/** A presigned slot for exactly one pathname, in the shape native/lab/lib/blob.mjs takes. */
async function blobSlot(kind: ShellTemplateKind, pathname: string, now: number) {
  const multipart = PACKAGE_MAX_BYTES[kind] > MULTIPART_BYTES;
  const limits = { allowedContentTypes: [PACKAGE_CONTENT_TYPES[kind]], maximumSizeInBytes: PACKAGE_MAX_BYTES[kind] };
  const token = await issueSignedToken({ pathname, operations: ["put"], validUntil: now + UPLOAD_TTL_MS, ...limits, ...blobAuth() });
  const reply = await handleUploadPresigned({
    body: { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: null, multipart } },
    // Only used for a completion callback, and this asks for none.
    request: new Request(`${env.platformUrl}/api/native/packager`),
    webhookPublicKey: process.env.BLOB_WEBHOOK_PUBLIC_KEY || NO_CALLBACK_KEY,
    getSignedToken: async () => ({ token, urlOptions: { ...limits, addRandomSuffix: false, allowOverwrite: true } }),
  });
  return { name: kind, method: "blob", pathname, multipart, presignedUrlPayload: (reply as { presignedUrlPayload: unknown }).presignedUrlPayload };
}

/** job.json: everything package.mjs reads. `outputs` holds the slots, the only thing in the sandbox that can write anywhere. */
export function packagerJob(req: PackageRequest, release: ShellRelease, outputs: Partial<Record<ShellTemplateKind, unknown>>, hasIcon: boolean) {
  return {
    v: 1,
    shellVersion: release.shellVersion,
    product: { name: req.name, url: req.url, packageId: packageIdFor(req.productId) },
    iconPath: hasIcon ? ICON_PATH : null,
    templates: release.templates,
    outputs,
  };
}

/** Whether bytes really are a PNG, JPEG or WebP. A product picks its own headers, and sharp would also parse SVG and more. */
export function isIconPicture(bytes: Buffer): boolean {
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const webp = bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP";
  return png || jpeg || webp;
}

/** A response's body, or null past `max` bytes. It stops reading there, so a product can't fill this function's memory. */
async function readUpTo(res: Response, max: number): Promise<Buffer | null> {
  if (!res.body || Number(res.headers.get("content-length")) > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
}

/** The product's own generated icon (template-native's app/icon.tsx), or null. Its bytes are only ever decoded in the sandbox. */
export async function fetchProductIcon(productUrl: string, doFetch: typeof fetch = fetch): Promise<Buffer | null> {
  try {
    const res = await doFetch(new URL("/icon/512", productUrl), { redirect: "error", signal: AbortSignal.timeout(ICON_FETCH_MS) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/^image\/(png|jpeg|webp)\b/.test(type)) return null;
    const bytes = await readUpTo(res, ICON_MAX_BYTES);
    return bytes && isIconPicture(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

function credentials(sandboxName: string) {
  return { ...sandboxCredentials(), name: sandboxName };
}

/** Starts the packager on a new sandbox and returns at once. Safe to repeat: a retried step replaces its earlier sandbox. */
export async function startPackaging(req: PackageRequest, now = Date.now()): Promise<PackagingHandle> {
  const snapshotId = env.packagerSnapshotId;
  if (!snapshotId) throw new PackagerUnavailableError("The packager has no snapshot yet: PACKAGER_SNAPSHOT_ID isn't set.");
  const release = currentShells();
  const skipped: PackagingHandle["skipped"] = {};
  const kinds: ShellTemplateKind[] = [];
  for (const kind of SHELL_TEMPLATE_KINDS) {
    if (!req.kinds.includes(kind)) continue;
    if (release.templates[kind]) kinds.push(kind);
    else skipped[kind] = `Shell ${release.shellVersion} has no ${kind} template yet.`;
  }
  const signing = platformApkKey() !== null;
  const local = localFilesEnabled();
  const slots: PackageSlotInfo[] = [];
  const outputs: Partial<Record<ShellTemplateKind, unknown>> = {};
  for (const kind of kinds) {
    const pathname = packagePathname(req, kind);
    const uploadPathname = kind === "android" && signing ? unsignedPathname(pathname) : pathname;
    slots.push({ kind, pathname, uploadPathname, ...(local ? { kept: true } : {}) });
    outputs[kind] = local ? { name: kind, method: "keep", pathname: uploadPathname } : await blobSlot(kind, uploadPathname, now);
  }
  const sandboxName = `musemuse-packager-${req.runId}`;
  const handle: PackagingHandle = { sandboxName, runId: req.runId, shellVersion: release.shellVersion, startedAt: now, slots, skipped };
  if (!kinds.length) return handle;

  const picture = req.icon ?? (await fetchProductIcon(req.url));
  const icon = picture && isIconPicture(picture) ? picture : null;
  await stopPackaging(handle);
  const sandbox = await Sandbox.create({
    ...credentials(sandboxName),
    source: { type: "snapshot", snapshotId },
    persistent: false,
    resources: { vcpus: PACKAGER_VCPUS },
    timeout: SANDBOX_TIMEOUT_MS,
    networkPolicy: packagerNetworkPolicy(),
    tags: { app: "musemuse", role: "packager" },
  });
  try {
    const job = packagerJob(req, release, outputs, Boolean(icon));
    await sandbox.writeFiles([{ path: JOB_PATH, content: Buffer.from(JSON.stringify(job)) }, ...(icon ? [{ path: ICON_PATH, content: icon }] : [])]);
    await sandbox.runCommand({
      cmd: "bash",
      args: ["-c", `node ${q(PACKAGER_SCRIPT)} ${q(JOB_PATH)} > ${q(RESULT_PATH)} 2> ${q(LOG_PATH)}; echo $? > ${q(EXIT_PATH)}`],
      detached: true,
    });
  } catch (error) {
    // The caller has no handle yet, so nothing else would stop this one.
    await stopPackaging(handle);
    throw error;
  }
  return handle;
}

/** The last line of package.mjs's output. */
export function parsePackageResult(stdout: string): PackageResult | null {
  const line = stdout.trim().split("\n").at(-1);
  if (!line) return null;
  try {
    const value = JSON.parse(line) as PackageResult;
    return value?.v === 1 && typeof value.packages === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Reads where a run is. A run that went wrong comes back as `failed`. An error reaching the sandbox API throws instead, so the
 * step retries and a hiccup doesn't end a healthy run.
 */
export async function pollPackaging(handle: PackagingHandle, now = Date.now()): Promise<PackagingState> {
  if (!handle.slots.length) return { state: "finished", result: { v: 1, packages: {} } };
  if (now - handle.startedAt > PACKAGING_LIMIT_MS) return { state: "failed", reason: "Packaging took too long." };
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.get(credentials(handle.sandboxName));
  } catch (error) {
    if (error instanceof APIError && error.response.status === 404) return { state: "failed", reason: "The packager's sandbox is gone." };
    throw error;
  }
  // This comes first because any later call on a stopped sandbox starts a new, empty session, which looks like a run still going.
  if (sandbox.status !== "running") return { state: "failed", reason: "The packager's sandbox stopped before it finished." };
  const { stdout } = await sh(sandbox, `[ -f ${q(EXIT_PATH)} ] && cat ${q(EXIT_PATH)} || true`);
  if (!stdout.trim()) return { state: "running" };
  const text = await sandbox.fs.readFile(RESULT_PATH, "utf8").catch((error) => {
    if ((error as { code?: string }).code === "ENOENT") return "";
    throw error;
  });
  const result = parsePackageResult(text);
  if (result && !result.error) return { state: "finished", result };
  return { state: "failed", reason: result?.error ?? "The packager stopped without a result." };
}

/** Writes to the path itself, in Blob or in .data/files. Unlike putFile it adds no random suffix. */
async function putExact(pathname: string, bytes: Buffer, contentType: string): Promise<string> {
  if (!localFilesEnabled()) return putBlobAt(pathname, bytes, contentType);
  const { file, type } = localFilePaths(pathname);
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(path.dirname(type), { recursive: true });
  await writeFile(file, bytes);
  await writeFile(type, contentType);
  return localFileUrl(pathname);
}

export interface CollectDeps {
  /** What's at this path in the platform's own store, or null. */
  head(pathname: string): Promise<{ url: string; size: number } | null>;
  /** The hash of what's at this URL, without holding the file in memory. */
  sha256(url: string): Promise<string>;
  fetchBytes(url: string): Promise<Buffer>;
  readKept(file: string): Promise<Buffer | null>;
  put(pathname: string, bytes: Buffer, contentType: string): Promise<string>;
  remove(url: string): Promise<void>;
  apkKey(): ApkKey | null;
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Nothing that gets offered comes from the sandbox's answer alone. A file's URL, size and hash are read from the platform's own
 * store, at the path this run's slot allowed, so a sandbox can't point a download somewhere else or vouch for its own bytes. Its
 * size and hash only have to agree, which also catches an upload that went wrong.
 */
async function collectOne(slot: PackageSlotInfo, entry: PackageResultEntry, handle: PackagingHandle, deps: CollectDeps): Promise<PackagedFile> {
  const artifactKind = NATIVE_DOWNLOADS[slot.kind];
  const common = { kind: slot.kind, artifactKind, pathname: slot.pathname, shellVersion: handle.shellVersion, ms: entry.ms ?? 0 };
  const key = slot.kind === "android" ? deps.apkKey() : null;
  const signedWith = slot.kind !== "android" ? null : key ? "platform" : "debug";
  const checkHash = (sha256: string) => {
    if (entry.sha256 !== sha256) throw new Error("The package in the store isn't the one the packager made.");
  };
  const place = async (bytes: Buffer): Promise<PackagedFile> => {
    const final = key ? signApk(bytes, key) : bytes;
    if (key && apkSigner(final) !== sha256Of(key.certificate.raw)) throw new Error("The signed APK didn't check out.");
    const url = await deps.put(slot.pathname, final, PACKAGE_CONTENT_TYPES[slot.kind]);
    return { ...common, url, bytes: final.length, sha256: sha256Of(final), signedWith };
  };

  if (slot.kept) {
    const bytes = entry.keptAt ? await deps.readKept(entry.keptAt) : null;
    if (!bytes) throw new Error("The package wasn't where the packager left it.");
    return place(bytes);
  }

  const stored = await deps.head(slot.uploadPathname);
  if (!stored) throw new Error("The package isn't in the store.");
  if (stored.size !== entry.bytes) throw new Error("The package in the store isn't the size the packager made.");
  // A file that's already in its place, and needs no signature, doesn't have to sit in this function's memory.
  if (!key) {
    const sha256 = await deps.sha256(stored.url);
    checkHash(sha256);
    return { ...common, url: stored.url, bytes: stored.size, sha256, signedWith };
  }
  const bytes = await deps.fetchBytes(stored.url);
  checkHash(sha256Of(bytes));
  const file = await place(bytes);
  if (slot.uploadPathname !== slot.pathname) await deps.remove(stored.url).catch(() => {});
  return file;
}

/** Turns a finished run into files to offer, with each failure in plain words. Takes its dependencies so tests can fake them. */
export async function collectPackages(handle: PackagingHandle, result: PackageResult, deps: CollectDeps): Promise<CollectedPackages> {
  const files: PackagedFile[] = [];
  const failures: CollectedPackages["failures"] = { ...handle.skipped };
  for (const slot of handle.slots) {
    const entry = result.packages[slot.kind];
    if (!entry?.ok) {
      failures[slot.kind] = entry?.error ?? "The packager didn't get to it.";
      continue;
    }
    try {
      files.push(await collectOne(slot, entry, handle, deps));
    } catch (error) {
      failures[slot.kind] = error instanceof Error ? error.message : String(error);
    }
  }
  return { files, failures };
}

/** collectPackages with the real Blob store and sandbox. Call stopPackaging after it. */
export async function collectPackaging(handle: PackagingHandle, result: PackageResult): Promise<CollectedPackages> {
  return collectPackages(handle, result, {
    head: async (pathname) => {
      try {
        const { url, size } = await head(pathname, blobAuth());
        return { url, size };
      } catch (error) {
        if (error instanceof BlobNotFoundError) return null;
        throw error;
      }
    },
    sha256: sha256OfUrl,
    fetchBytes: (url) => fetchBytes(url),
    readKept: async (file) => (await Sandbox.get(credentials(handle.sandboxName))).readFileToBuffer({ path: file }),
    put: putExact,
    remove: (url) => del(url, blobAuth()),
    apkKey: platformApkKey,
  });
}

/** Stops and deletes the sandbox. Quiet when there's none. The workflow calls this from a `finally`. */
export async function stopPackaging(handle: Pick<PackagingHandle, "sandboxName">): Promise<void> {
  try {
    const sandbox = await Sandbox.get(credentials(handle.sandboxName));
    await sandbox.stop().catch(() => {});
    await sandbox.delete();
  } catch {
    // Already gone. It wasn't persistent and it has its own timeout, so it can't run on.
  }
}
