/**
 * The bench (docs/VIBE_TUNING.md, Feature 6, "Fulfillment"): flashes the next paid order onto a USB stick on the
 * owner's Mac and checks it, for scripts/drive-bench.ts. The order comes from GET /api/drive/bench/next with the bench
 * token; its model files come from the public GGUF repo at the order's commit (once, then from a cache on the Mac),
 * each checked against its sha256. Only removable USB disks of a stick's size are offered, and one is erased only after
 * the owner types its disk id. The stick gets the image (lib/drive/image.ts), the model files, PROVENANCE.json and
 * SHA256SUMS, loses its extended attributes, and is ejected. After the owner unplugs it and plugs it back in, every file
 * is read back from the stick and checked, and the result goes to POST /api/drive/bench/{id}/flashed. A FAIL never
 * ships. Every disk command goes through DiskOps, so the tests use a folder as the stick and never touch a real disk.
 *
 * The list shows each disk's volumes and how much they hold, and a disk that holds files asks for its volume's name
 * too. The order is claimed before the last look at the disk, and the erase itself reads the disk once more right
 * before it runs, so no network call sits between the check and the erase: a stick swapped meanwhile is never erased.
 */
import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { DRIVE_IMAGE_VERSION, buildLabel, gb, type BenchOrder } from "@/lib/drive/logic";
import {
  fetchPinned,
  listFiles,
  sha256File,
  writeManifestFiles,
  type FetchLike,
  type ImageManifest,
  type ImageModel,
} from "@/lib/drive/image";
import type { DriveFile, VerifyResult } from "@/lib/drive/types";

const run = promisify(execFile);

/** The volume label every stick gets. */
export const DRIVE_LABEL = "MUSEMUSE";

/**
 * Stick sizes the bench offers, as their drives report them in bytes: a "64 GB" stick holds 60 to 70 GB, a "32 GB"
 * one 30 to 35. A single-build order fits the smaller one; all three sizes need the bigger.
 */
export const STICK_SIZES = [
  { label: "32 GB", min: 30e9, max: 35e9 },
  { label: "64 GB", min: 60e9, max: 70e9 },
] as const;

/** Room left on the stick past the files, for exFAT's own tables. */
const STICK_SPARE = 1e9;

/** How long the owner has to unplug the stick and plug it back in. */
export const REPLUG_TIMEOUT_MS = 10 * 60_000;

/** Files and folders macOS or Windows make on a stick by themselves, which the check doesn't count as extra. */
const OS_METADATA = /^(\.fseventsd|\.Spotlight-V100|\.Trashes|\.TemporaryItems|System Volume Information)(\/|$)|(^|\/)(\.DS_Store|\._[^/]*)$/;

/** A volume holding less than this counts as blank: a new stick's own volume, or one a maker put a small app on. */
export const BLANK_MAX_BYTES = 100e6;

/** How long one call to the platform may take before the bench gives up on it. */
export const PLATFORM_TIMEOUT_MS = 60_000;

/** A volume on a disk, so the owner sees what an erase would destroy. */
export interface DiskVolume {
  /** Its name, such as "PHOTOS", or "" when it has none. */
  name: string;
  /** How much it holds, or null when it isn't mounted and that can't be read. */
  usedBytes: number | null;
}

export interface UsbDisk {
  /** "disk4". */
  id: string;
  /** What the stick calls itself, such as "SanDisk Ultra". */
  name: string;
  bytes: number;
  /** USB, as diskutil's BusProtocol says. */
  protocol: string;
  removable: boolean;
  internal: boolean;
  /**
   * Where the disk sits on the Mac's buses, and its media's UUID when it has one (diskutil's DeviceTreePath, DiskUUID and
   * MediaUUID): with the name, the size and the volumes, how the bench tells that a disk id still names the same disk.
   */
  identity: string;
  /** Its volumes, as diskutil lists its partitions. */
  volumes: DiskVolume[];
}

/** Every disk command the bench runs. macDiskOps runs diskutil; the tests use a folder. */
export interface DiskOps {
  /** Physical external disks, whole ones only. */
  listDisks(): Promise<UsbDisk[]>;
  /** One disk as it is now, or null once it's gone. */
  info(id: string): Promise<UsbDisk | null>;
  /**
   * Erases the whole disk as exFAT on MBR with this label, and returns where its volume mounted. It reads the disk once
   * more just before the erase and refuses, erasing nothing, unless it is still `disk` (sameDisk) and still offerable.
   */
  erase(disk: UsbDisk, label: string): Promise<string>;
  /** Removes extended attributes and AppleDouble (._) files, so no quarantine flag rides along. */
  strip(mountPoint: string): Promise<void>;
  eject(id: string): Promise<void>;
  /** Waits for the stick to be unplugged and plugged back in, and returns its disk id and where it mounted. */
  waitForReplug(id: string, label: string, timeoutMs: number): Promise<{ id: string; mountPoint: string }>;
}

/** The disks the bench may offer for `needBytes`: removable, not internal, over USB, and of a stick's size. */
export function offerableDisks(disks: readonly UsbDisk[], needBytes: number): UsbDisk[] {
  return disks.filter(
    (d) =>
      d.removable &&
      !d.internal &&
      d.protocol.toUpperCase() === "USB" &&
      STICK_SIZES.some((s) => d.bytes >= s.min && d.bytes <= s.max) &&
      d.bytes >= needBytes + STICK_SPARE,
  );
}

/**
 * The volumes of a disk that hold files: more than BLANK_MAX_BYTES, or not mounted, so what they hold can't be read.
 * None means the disk is blank.
 */
export function filledVolumes(disk: Pick<UsbDisk, "volumes">): DiskVolume[] {
  return disk.volumes.filter((v) => v.usedBytes === null || v.usedBytes > BLANK_MAX_BYTES);
}

/**
 * True when `now` is the disk the owner picked as `listed`: the same id, name, size, bus, identity and volumes. macOS
 * gives a disk id to whatever is plugged in next, so an id alone never says which disk it is.
 */
export function sameDisk(listed: UsbDisk, now: UsbDisk | null): boolean {
  const names = (d: UsbDisk) => JSON.stringify(d.volumes.map((v) => v.name).sort());
  return (
    now !== null &&
    now.id === listed.id &&
    now.name === listed.name &&
    now.bytes === listed.bytes &&
    now.protocol === listed.protocol &&
    now.removable === listed.removable &&
    now.internal === listed.internal &&
    now.identity === listed.identity &&
    names(now) === names(listed)
  );
}

/** One disk as the bench lists it: its id, name and size, then what it holds ("blank" when nothing). */
export function diskLine(d: UsbDisk): string {
  const held = d.volumes.map((v) => `${v.name ? `"${v.name}"` : "a volume with no name"} ${v.usedBytes === null ? "(not mounted, so what it holds is unknown)" : `(${gb(v.usedBytes)} used)`}`);
  return `${d.id}  ${d.name}  ${gb(d.bytes)}  ${filledVolumes(d).length ? `holds ${held.join(", ")}` : "blank"}`;
}

export interface PlatformClient {
  next(): Promise<BenchOrder | null>;
  claim(orderId: string, serial: string): Promise<void>;
  report(orderId: string, report: { serial: string; manifestSha256: string; result: VerifyResult; imageVersion: string }): Promise<void>;
}

export class BenchError extends Error {}

/** What DiskOps.erase throws, having erased nothing, when the disk isn't the one the owner picked any more. */
export class DiskChangedError extends BenchError {}

/** Why the bench won't send its token to `origin`, or null: https only, or plain http on this Mac for a dev server. */
export function originProblem(origin: string): string | null {
  const trimmed = origin.trim().replace(/\/+$/, "");
  if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(trimmed)) return null;
  return /^https:\/\/[^/\s?#@]+$/.test(trimmed) ? null : `${trimmed || "The platform's origin"} isn't an https origin, and the bench token only goes over https (plain http only on localhost).`;
}

/**
 * The platform's bench routes, with the bench token, at an https origin (originProblem). Each call gives up after
 * PLATFORM_TIMEOUT_MS. Errors say what the platform answered, never the token.
 */
export function platformClient(origin: string, token: string, fetchImpl: FetchLike = fetch, timeoutMs = PLATFORM_TIMEOUT_MS): PlatformClient {
  const problem = originProblem(origin);
  if (problem) throw new BenchError(problem);
  const base = origin.trim().replace(/\/+$/, "");
  async function call(method: "GET" | "POST", route: string, body?: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${route}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // The token is only in a header, so the error can name the route and what went wrong.
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      const why = timedOut ? `didn't answer within ${Math.round(timeoutMs / 1000)} seconds` : `couldn't reach the platform (${err instanceof Error ? err.message : String(err)})`;
      throw new BenchError(`${method} ${route} ${why}.`);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new BenchError(`${method} ${route} answered ${res.status} ${String(json.error ?? "")}`.trim());
    return json;
  }
  return {
    next: async () => ((await call("GET", "/api/drive/bench/next")).order as BenchOrder | null) ?? null,
    claim: async (orderId, serial) => void (await call("POST", `/api/drive/bench/${orderId}/flashing`, { serial })),
    report: async (orderId, report) => void (await call("POST", `/api/drive/bench/${orderId}/flashed`, report)),
  };
}

/** The model the image and PROVENANCE.json describe, from the order's saved copy of its local files. */
export function imageModelOf(order: BenchOrder): ImageModel {
  return { ...order.model, adapterJobId: order.trainingJobId, repo: order.repo, commit: order.commit, files: order.files };
}

/**
 * One GGUF file in the Mac's cache, checked against the order's sha256: a cached copy whose size and time match the
 * check saved next to it is taken as it is, anything else is hashed again, and a missing or wrong file is downloaded
 * from the public repo at the order's commit. Returns its path.
 */
export async function cachedModelFile(cacheDir: string, order: Pick<BenchOrder, "repo" | "commit">, file: DriveFile, fetchImpl: FetchLike = fetch): Promise<string> {
  const dir = path.join(cacheDir, "models", order.repo.replace(/\//g, "__"), order.commit);
  const dest = path.join(dir, file.name);
  const check = `${dest}.sha256`;
  const stat = await fs.stat(dest).catch(() => null);
  if (stat?.isFile() && stat.size === file.bytes) {
    const saved = (await fs.readFile(check, "utf8").catch(() => "")).trim();
    if (saved === `${file.sha256} ${stat.size} ${Math.floor(stat.mtimeMs)}`) return dest;
  }
  await fetchPinned(fetchImpl, `https://huggingface.co/${order.repo}/resolve/${order.commit}/${file.name}`, file.sha256, dest);
  const done = await fs.stat(dest);
  if (done.size !== file.bytes) throw new BenchError(`${file.name} is ${done.size} bytes, not the ${file.bytes} the order says.`);
  await fs.writeFile(check, `${file.sha256} ${done.size} ${Math.floor(done.mtimeMs)}\n`);
  return dest;
}

/** Copies one file, reporting how far it got, and flushes it to the stick before it returns. */
export async function copyWithProgress(from: string, to: string, onProgress?: (copied: number) => void): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  let copied = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      copied += chunk.length;
      onProgress?.(copied);
      done(null, chunk);
    },
  });
  await pipeline(createReadStream(from, { highWaterMark: 4 * 1024 * 1024 }), tap, createWriteStream(to, { flush: true }));
}

export interface StickCheck {
  result: VerifyResult;
  /** One sentence for each file that is missing, different, or not on the list. */
  problems: string[];
  manifestSha256: string;
}

/**
 * Reads every listed file back from the stick and compares it with the sha256 the bench wrote, and checks that
 * SHA256SUMS and PROVENANCE.json are the ones it wrote and that nothing else is on the stick (besides what an OS makes
 * by itself). Run after a replug, so it reads the stick and not a cache.
 */
export async function checkStick(
  mountPoint: string,
  expected: ReadonlyArray<{ path: string; sha256: string }>,
  manifestSha256: string,
  serial: string,
  hash: (file: string) => Promise<string> = sha256File,
): Promise<StickCheck> {
  const problems: string[] = [];
  const sumsPath = path.join(mountPoint, "SHA256SUMS");
  const sums = await fs.readFile(sumsPath).catch(() => null);
  const gotManifest = sums ? await hash(sumsPath) : "";
  if (!sums) problems.push("SHA256SUMS is missing.");
  else if (gotManifest !== manifestSha256) problems.push("SHA256SUMS isn't the one the bench wrote.");
  const provenance = await fs.readFile(path.join(mountPoint, "PROVENANCE.json"), "utf8").catch(() => "");
  try {
    if ((JSON.parse(provenance) as { serial?: unknown }).serial !== serial) problems.push(`PROVENANCE.json doesn't name serial ${serial}.`);
  } catch {
    problems.push("PROVENANCE.json is missing or unreadable.");
  }
  for (const e of expected) {
    const file = path.join(mountPoint, e.path);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) {
      problems.push(`${e.path} is missing.`);
      continue;
    }
    if ((await hash(file)) !== e.sha256) problems.push(`${e.path} doesn't match its sha256.`);
  }
  const listed = new Set([...expected.map((e) => e.path), "SHA256SUMS"]);
  for (const rel of await listFiles(mountPoint)) {
    if (!listed.has(rel) && !OS_METADATA.test(rel)) problems.push(`${rel} isn't on the list.`);
  }
  return { result: problems.length ? "FAIL" : "PASS", problems, manifestSha256 };
}

export interface BenchDeps {
  platform: PlatformClient;
  disks: DiskOps;
  /** Asks the owner something and returns what they typed. */
  ask(question: string): Promise<string>;
  say(line: string): void;
  /** The model file in the Mac's cache, checked against its sha256. */
  modelFile(order: BenchOrder, file: DriveFile): Promise<string>;
  /** Builds the order's image into an empty folder. */
  buildImage(order: BenchOrder, dir: string): Promise<ImageManifest>;
  /** A scratch folder for the image. */
  workDir: string;
  copy?: (from: string, to: string, onProgress?: (copied: number) => void) => Promise<void>;
  hash?: (file: string) => Promise<string>;
  now?: () => Date;
  replugTimeoutMs?: number;
}

export type BenchOutcome =
  | { result: "none" }
  | { result: "stopped"; reason: string }
  | { result: VerifyResult; serial: string; problems: string[] };

/**
 * Flashes the next paid order. Returns "none" with an empty queue, "stopped" when the owner (or a check before the
 * erase) stopped it with nothing erased, or the PASS or FAIL it reported.
 */
export async function flashNext(deps: BenchDeps): Promise<BenchOutcome> {
  const { platform, disks, say } = deps;
  const copy = deps.copy ?? copyWithProgress;
  const hash = deps.hash ?? sha256File;
  const now = deps.now ?? (() => new Date());

  const order = await platform.next();
  if (!order) {
    say("No paid orders to flash.");
    return { result: "none" };
  }
  const modelBytes = order.files.reduce((n, f) => n + f.bytes, 0);
  say(`Order ${order.id.slice(0, 8)}, serial ${order.serial}: ${order.model.title}, ${buildLabel(order.build, order.files.length)} (${gb(modelBytes)}).`);
  if (order.imageVersion !== DRIVE_IMAGE_VERSION) {
    say(`It was requested under drive image ${order.imageVersion}; this checkout writes ${DRIVE_IMAGE_VERSION}.`);
  }

  // The files first, so a 54 GB download never happens with a stick erased and waiting.
  const sources: Record<string, string> = {};
  for (const f of order.files) {
    say(`Model file ${f.name} (${gb(f.bytes)}): checking the cache, or downloading it.`);
    sources[f.name] = await deps.modelFile(order, f);
  }
  const imageDir = await fs.mkdtemp(path.join(deps.workDir, "image-"));
  const manifest = await deps.buildImage(order, imageDir);
  const imageBytes = manifest.files.reduce((n, f) => n + f.bytes, 0);
  const need = modelBytes + imageBytes;

  // The stick: only removable USB disks of a stick's size are offered, each with what it holds, and only the one whose
  // id is typed is erased. One that holds files also needs its volume's name typed.
  const offered = offerableDisks(await disks.listDisks(), need);
  if (!offered.length) {
    return { result: "stopped", reason: `No USB stick that fits ${gb(need)} is plugged in. Plug in a 64 GB stick (or a 32 GB one for a single size), then run it again.` };
  }
  say("");
  say("USB sticks plugged in:");
  for (const d of offered) say(`  ${diskLine(d)}`);
  say("");
  const typed = (await deps.ask(`Type the disk id to ERASE it and write order ${order.serial} (for example ${offered[0].id}), or press Return to stop: `)).trim();
  const disk = offered.find((d) => d.id === typed);
  if (!disk) return { result: "stopped", reason: typed ? `${typed} isn't one of the sticks listed. Nothing was erased.` : "Stopped. Nothing was erased." };
  const filled = filledVolumes(disk);
  if (filled.length) {
    const word = filled[0].name || "ERASE";
    const again = (await deps.ask(`${disk.id} isn't blank: it holds ${filled.map((v) => (v.name ? `"${v.name}"` : "a volume with no name")).join(", ")}. Type ${word} to erase it anyway, or press Return to stop: `)).trim();
    if (again !== word) return { result: "stopped", reason: `${disk.id} holds files, and its name wasn't typed. Nothing was erased.` };
  }

  // Claimed first, so no network call sits between the last look at the disk and the erase; erase looks once more.
  await platform.claim(order.id, order.serial);
  const stopped = (why: string): BenchOutcome => ({
    result: "stopped",
    reason: `${why} Nothing was erased. The order stays claimed for this bench, so the next run starts with it.`,
  });
  const fresh = await disks.info(disk.id);
  if (!sameDisk(disk, fresh) || offerableDisks([fresh!], need).length !== 1) return stopped(`${disk.id} changed since it was listed.`);
  say(`Erasing ${disk.id} as exFAT, labeled ${DRIVE_LABEL}.`);
  let mountPoint: string;
  try {
    mountPoint = await disks.erase(disk, DRIVE_LABEL);
  } catch (err) {
    if (err instanceof DiskChangedError) return stopped(err.message);
    throw err;
  }

  const report = async (result: VerifyResult, manifestSha256: string, problems: string[]): Promise<BenchOutcome> => {
    await platform.report(order.id, { serial: order.serial, manifestSha256, result, imageVersion: manifest.imageVersion });
    return { result, serial: order.serial, problems };
  };

  // The image and the model files, then the manifests, then strip and eject.
  let manifestSha256 = "";
  let expected: Array<{ path: string; sha256: string }> = [];
  try {
    for (const f of manifest.files) await copy(path.join(imageDir, f.path), path.join(mountPoint, f.path));
    for (const f of order.files) {
      say(`Writing ${f.name} (${gb(f.bytes)}).`);
      let shown = 0;
      await copy(sources[f.name], path.join(mountPoint, "model", f.name), (copied) => {
        if (copied - shown >= 2e9 || copied === f.bytes) {
          shown = copied;
          say(`  ${gb(copied)} of ${gb(f.bytes)}`);
        }
      });
    }
    const written = await writeManifestFiles(mountPoint, manifest, imageModelOf(order), order.serial, now());
    manifestSha256 = written.manifestSha256;
    expected = written.entries;
    await disks.strip(mountPoint);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    say(`The copy stopped: ${why}`);
    await disks.eject(disk.id).catch(() => {});
    return report("FAIL", manifestSha256 || "0".repeat(64), [`The copy stopped: ${why}`]);
  } finally {
    await fs.rm(imageDir, { recursive: true, force: true });
  }
  await disks.eject(disk.id);

  // The check reads the stick after a replug, so it reads the stick and not the Mac's cache of what it wrote.
  say("");
  say(`Unplug the stick, then plug it back in. Waiting up to ${Math.round((deps.replugTimeoutMs ?? REPLUG_TIMEOUT_MS) / 60_000)} minutes.`);
  let back: { id: string; mountPoint: string };
  try {
    back = await disks.waitForReplug(disk.id, DRIVE_LABEL, deps.replugTimeoutMs ?? REPLUG_TIMEOUT_MS);
  } catch (err) {
    return report("FAIL", manifestSha256, [`The stick didn't come back: ${err instanceof Error ? err.message : String(err)}`]);
  }
  say("Reading every file back from the stick.");
  const checked = await checkStick(back.mountPoint, expected, manifestSha256, order.serial, hash);
  await disks.eject(back.id).catch(() => {});
  return report(checked.result, manifestSha256, checked.problems);
}

// ---------- The real disks: diskutil on the bench Mac ----------

/** Runs a command and pipes its plist output through plutil, which turns it into JSON. */
async function plistJson(command: string, args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await run(command, args, { maxBuffer: 16 * 1024 * 1024 });
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"]);
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new BenchError(`plutil couldn't read ${command}'s answer.`));
      try {
        resolve(JSON.parse(out) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.end(stdout);
  });
}

/**
 * One disk from `diskutil info -plist`, or null when it isn't a whole physical disk. Its volumes come from diskutil's
 * list instead (volumesFromList), so they start empty here.
 */
export function diskFromInfo(info: Record<string, unknown>): UsbDisk | null {
  const id = typeof info.DeviceIdentifier === "string" ? info.DeviceIdentifier : "";
  if (!/^disk\d+$/.test(id) || info.WholeDisk !== true || info.VirtualOrPhysical === "Virtual") return null;
  const bytes = Number(info.TotalSize ?? info.Size ?? 0);
  return {
    id,
    name: String(info.MediaName ?? info.IORegistryEntryName ?? "USB disk").trim(),
    bytes: Number.isFinite(bytes) ? bytes : 0,
    protocol: String(info.BusProtocol ?? ""),
    removable: info.RemovableMedia === true || info.Removable === true || info.Ejectable === true,
    internal: info.Internal !== false,
    identity: [info.DeviceTreePath, info.DiskUUID, info.MediaUUID].map((v) => (typeof v === "string" ? v : "")).join("|"),
    volumes: [],
  };
}

/**
 * A whole disk's volumes from `diskutil list -plist external physical`: each partition's name, and how much it holds
 * when it is mounted (`used`, from its mount point). An EFI partition holds nothing of anyone's, so it isn't listed.
 */
export async function volumesFromList(
  id: string,
  list: Record<string, unknown>,
  used: (mountPoint: string) => Promise<number | null>,
): Promise<DiskVolume[]> {
  const disk = ((list.AllDisksAndPartitions as Array<Record<string, unknown>> | undefined) ?? []).find((d) => d.DeviceIdentifier === id);
  const out: DiskVolume[] = [];
  for (const p of (disk?.Partitions as Array<Record<string, unknown>> | undefined) ?? []) {
    if (p.Content === "EFI") continue;
    out.push({
      name: typeof p.VolumeName === "string" ? p.VolumeName : "",
      usedBytes: typeof p.MountPoint === "string" && p.MountPoint ? await used(p.MountPoint) : null,
    });
  }
  return out;
}

/** How much a mounted volume holds, from statfs, or null when it can't be read. */
async function usedBytesAt(mountPoint: string): Promise<number | null> {
  try {
    const s = await fs.statfs(mountPoint);
    return Math.max(0, (s.blocks - s.bfree) * s.bsize);
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** DiskOps on macOS, through diskutil, xattr and dot_clean. Only scripts/drive-bench.ts uses it; no test does. */
export function macDiskOps(): DiskOps {
  const info = async (id: string): Promise<UsbDisk | null> => {
    if (!/^disk\d+(s\d+)?$/.test(id)) return null;
    try {
      const disk = diskFromInfo(await plistJson("/usr/sbin/diskutil", ["info", "-plist", id]));
      if (!disk) return null;
      const list = await plistJson("/usr/sbin/diskutil", ["list", "-plist", "external", "physical"]);
      return { ...disk, volumes: await volumesFromList(id, list, usedBytesAt) };
    } catch {
      return null;
    }
  };
  const mountOf = async (id: string): Promise<string | null> => {
    const list = await plistJson("/usr/sbin/diskutil", ["list", "-plist", "external", "physical"]).catch(() => ({}) as Record<string, unknown>);
    for (const d of (list.AllDisksAndPartitions as Array<Record<string, unknown>> | undefined) ?? []) {
      if (d.DeviceIdentifier !== id) continue;
      for (const p of (d.Partitions as Array<Record<string, unknown>> | undefined) ?? []) {
        if (p.VolumeName === DRIVE_LABEL && typeof p.MountPoint === "string") return p.MountPoint;
      }
    }
    return null;
  };
  return {
    async listDisks() {
      const list = await plistJson("/usr/sbin/diskutil", ["list", "-plist", "external", "physical"]);
      const ids = ((list.WholeDisks as unknown[]) ?? []).filter((x): x is string => typeof x === "string");
      const out: UsbDisk[] = [];
      for (const id of ids) {
        const d = await info(id);
        if (d) out.push(d);
      }
      return out;
    },
    info,
    async erase(disk, label) {
      const id = disk.id;
      if (!/^disk\d+$/.test(id)) throw new BenchError(`${id} isn't a whole disk.`);
      // Read once more right before the erase: a disk plugged in under this id since the owner picked it is refused.
      const now = await info(id);
      if (!sameDisk(disk, now) || offerableDisks([now!], 0).length !== 1) throw new DiskChangedError(`${id} isn't the disk that was picked any more.`);
      await run("/usr/sbin/diskutil", ["eraseDisk", "ExFAT", label, "MBR", `/dev/${id}`], { maxBuffer: 4 * 1024 * 1024 });
      for (let i = 0; i < 30; i++) {
        const mount = await mountOf(id);
        if (mount) return mount;
        await sleep(1000);
      }
      throw new BenchError(`${id} was erased, but its volume didn't mount.`);
    },
    async strip(mountPoint) {
      await run("/usr/bin/xattr", ["-rc", mountPoint]);
      await run("/usr/sbin/dot_clean", ["-m", mountPoint]);
    },
    async eject(id) {
      await run("/usr/sbin/diskutil", ["eject", `/dev/${id}`]);
    },
    async waitForReplug(id, label, timeoutMs) {
      const until = Date.now() + timeoutMs;
      // Gone first, so a stick that never left isn't read from the Mac's cache.
      while ((await info(id)) && Date.now() < until) await sleep(2000);
      while (Date.now() < until) {
        const list = await plistJson("/usr/sbin/diskutil", ["list", "-plist", "external", "physical"]).catch(() => ({}) as Record<string, unknown>);
        for (const d of (list.AllDisksAndPartitions as Array<Record<string, unknown>> | undefined) ?? []) {
          for (const p of (d.Partitions as Array<Record<string, unknown>> | undefined) ?? []) {
            if (p.VolumeName === label && typeof p.MountPoint === "string" && typeof d.DeviceIdentifier === "string") {
              return { id: d.DeviceIdentifier, mountPoint: p.MountPoint };
            }
          }
        }
        await sleep(2000);
      }
      throw new BenchError(`No ${label} stick came back within ${Math.round(timeoutMs / 60_000)} minutes.`);
    },
  };
}
