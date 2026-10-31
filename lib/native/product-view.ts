/**
 * What the product page's "Get it" panel knows about a product's apps (docs/NATIVE.md). Pure: lib/native/queries.ts reads
 * the rows and this turns them into a view, so a package, a check and what counts as simulated are decided in one place,
 * for the panel and the download route alike.
 */
import type { TargetId } from "@/lib/brief/schema";
import {
  NATIVE_DOWNLOADS,
  type NativeArtifactKind,
  type NativeCheck,
  type NativeDownload,
  type NativeJobKind,
  type NativeJobResult,
  type NativeJobStatus,
  type NativeRunStatus,
} from "@/lib/native/types";
import type { ProductClip } from "@/lib/types";

/** Where a lab job's result shows, what it vouches for, and whether what ran it was a real machine. */
const JOB_KINDS: Record<NativeJobKind, { target: TargetId; download: NativeDownload | null; label: string; simulated: boolean }> = {
  android_emu: { target: "phone", download: "android", label: "Android emulator", simulated: true },
  ios_sim: { target: "phone", download: null, label: "iPhone simulator", simulated: true },
  desktop_mac: { target: "desktop", download: "mac", label: "Mac in the device lab", simulated: false },
  desktop_windows: { target: "desktop", download: "windows", label: "Windows in the device lab", simulated: false },
  glasses_sim: { target: "glasses", download: null, label: "iPhone simulator with Meta's mock glasses", simulated: true },
};

/** The rows the view is made from, with only the columns it reads. Runs an agent started checked a preview, so they aren't here. */
export interface NativeArtifactRow {
  id: string;
  runId: string;
  jobId: string | null;
  kind: NativeArtifactKind;
  platform: string | null;
  device: string | null;
  caption: string | null;
  url: string;
  bytes: number;
  check: NativeCheck | null;
  createdAt: Date;
}

export interface NativeJobRow {
  id: string;
  runId: string;
  kind: NativeJobKind;
  status: NativeJobStatus;
  result: NativeJobResult | null;
  createdAt: Date;
}

export type NativeCheckState = "passed" | "failed" | "checking" | "not_checked";

export interface NativeCheckView {
  id: string;
  target: TargetId;
  /** The package it vouches for. Null for what has no download: the iPhone shell, glasses in the simulator. */
  download: NativeDownload | null;
  label: string;
  /** "Pixel 7, Android 15", when the lab said. */
  device: string | null;
  /** An emulator, a simulator or mock glasses, not the real thing. Mock and simulated are always said out loud. */
  simulated: boolean;
  state: NativeCheckState;
  summary: string | null;
  /** Why it failed, for the owner. */
  reasons: string[];
  clip: { url: string; posterUrl: string | null; caption: string | null } | null;
  shots: Array<{ url: string; caption: string | null }>;
}

export interface NativePackageView {
  download: NativeDownload;
  artifactId: string;
  url: string;
  bytes: number;
  /** "failed" keeps it from visitors and from the download route. */
  state: NativeCheckState;
}

export interface ProductNativeView {
  targets: TargetId[];
  packages: NativePackageView[];
  checks: NativeCheckView[];
  clips: ProductClip[];
  /** A run is still making or checking things. */
  working: boolean;
}

const WORKING: readonly NativeRunStatus[] = ["planned", "running"];

/** A link a page or a redirect may use. Rows come from the platform, but a stray scheme must never reach an href. */
export function safeHttpUrl(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

/** A file for a thumbnail or a video: a link, or a data URL as the local fixtures use. */
function safeMediaUrl(url: unknown): url is string {
  return safeHttpUrl(url) || (typeof url === "string" && /^data:(image|video)\//i.test(url));
}

function jobState(job: NativeJobRow): NativeCheckState {
  if (job.status === "queued" || job.status === "claimed") return "checking";
  // lab_error means the check never ran, so the product isn't to blame (docs/NATIVE_LAB.md).
  if (job.result?.outcome === "passed") return "passed";
  if (job.result?.outcome === "failed") return "failed";
  return "not_checked";
}

function deviceName(result: NativeJobResult | null): string | null {
  const device = result?.device as { name?: unknown; os?: unknown } | null | undefined;
  if (!device || typeof device.name !== "string" || !device.name) return null;
  return typeof device.os === "string" && device.os ? `${device.name}, ${device.os}` : device.name;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

const newestFirst = <T extends { createdAt: Date }>(rows: readonly T[]) => [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

/** A check's media from the rows that belong to it. */
function mediaOf(rows: readonly NativeArtifactRow[]): Pick<NativeCheckView, "clip" | "shots"> {
  const clip = rows.find((a) => a.kind === "clip" && safeMediaUrl(a.url));
  const poster = rows.find((a) => a.kind === "poster" && safeMediaUrl(a.url));
  return {
    clip: clip ? { url: clip.url, posterUrl: poster?.url ?? null, caption: clip.caption } : null,
    shots: rows.filter((a) => a.kind === "shot" && safeMediaUrl(a.url)).map((a) => ({ url: a.url, caption: a.caption })),
  };
}

/**
 * Turns a product's rows into the panel's view.
 *
 * - **A package** is the newest of its kind. It counts as failed when its row says so or when a check made after it failed,
 *   and as checked only by checks made after it, so an older package's pass never vouches for a newer one.
 * - **A check** is the newest job of its kind. Device Farm has no jobs, so its checks come from the clips it left.
 */
export function buildProductNativeView(input: {
  targets: TargetId[];
  artifacts: readonly NativeArtifactRow[];
  jobs: readonly NativeJobRow[];
  runs: ReadonlyArray<{ status: NativeRunStatus }>;
  clips?: readonly ProductClip[];
}): ProductNativeView {
  const artifacts = newestFirst(input.artifacts);
  const newestPackage = new Map<NativeDownload, NativeArtifactRow>();
  for (const [download, kind] of Object.entries(NATIVE_DOWNLOADS) as Array<[NativeDownload, NativeArtifactKind]>) {
    const row = artifacts.find((a) => a.kind === kind && safeHttpUrl(a.url));
    if (row) newestPackage.set(download, row);
  }
  const stillCurrent = (download: NativeDownload | null, createdAt: Date) => {
    const pack = download && newestPackage.get(download);
    return !pack || createdAt.getTime() >= pack.createdAt.getTime();
  };

  const checks: NativeCheckView[] = [];
  const seenKinds = new Set<NativeJobKind>();
  for (const job of newestFirst(input.jobs)) {
    const meta = JOB_KINDS[job.kind];
    if (!meta || seenKinds.has(job.kind)) continue;
    seenKinds.add(job.kind);
    if (!stillCurrent(meta.download, job.createdAt)) continue;
    checks.push({
      id: job.id,
      target: meta.target,
      download: meta.download,
      label: meta.label,
      device: deviceName(job.result),
      simulated: meta.simulated,
      state: jobState(job),
      summary: typeof job.result?.summary === "string" ? job.result.summary : null,
      reasons: strings(job.result?.reasons),
      ...mediaOf(artifacts.filter((a) => a.jobId === job.id)),
    });
  }

  const seenDevices = new Set<string>();
  for (const clip of artifacts) {
    if (clip.kind !== "clip" || clip.jobId !== null || !clip.device || seenDevices.has(clip.device)) continue;
    seenDevices.add(clip.device);
    const download: NativeDownload | null = clip.platform === "android" ? "android" : null;
    if (!stillCurrent(download, clip.createdAt)) continue;
    checks.push({
      id: clip.id,
      target: "phone",
      download,
      label: `${clip.device} on AWS Device Farm`,
      device: null,
      simulated: false,
      state: clip.check ?? "not_checked",
      summary: null,
      reasons: [],
      ...mediaOf(artifacts.filter((a) => a.jobId === null && a.runId === clip.runId && a.device === clip.device)),
    });
  }

  const packages = [...newestPackage].map(([download, row]): NativePackageView => {
    const own = checks.filter((c) => c.download === download).map((c) => c.state);
    const state: NativeCheckState =
      row.check === "failed" || own.includes("failed") ? "failed" : own.includes("checking") ? "checking" : row.check === "passed" || own.includes("passed") ? "passed" : "not_checked";
    return { download, artifactId: row.id, url: row.url, bytes: row.bytes, state };
  });

  return {
    targets: input.targets,
    packages,
    checks,
    clips: (input.clips ?? []).filter((c) => safeMediaUrl(c?.url)),
    working: input.runs.some((r) => WORKING.includes(r.status)),
  };
}

/** The package a visitor may download, or null: nothing made yet, or its check failed. */
export function downloadablePackage(view: ProductNativeView, download: NativeDownload): NativePackageView | null {
  const pack = view.packages.find((p) => p.download === download);
  return pack && pack.state !== "failed" ? pack : null;
}
