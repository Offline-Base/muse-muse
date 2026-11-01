/**
 * Drive export from the platform's side (docs/DRIVE_EXPORT.md): the board's five drive tools (muse-device/server.py and
 * drive.py), and building an export for one of three sources. A board run's files and facts come from export_source; a
 * lab model's from localFilesFor and its GGUF repo at the commit; the owner's own private file from the owner's script.
 * Each becomes a drive plan (lib/drive/plan.ts) plus a link for every file the board downloads (lib/drive/sources.ts).
 *
 * The platform calls the board; the board never calls the platform and holds no platform credential. Signed links are
 * made at the moment the board needs them, handed straight over, and never stored or logged here.
 */
import type { DeviceConfig, DeviceToolResult } from "@/lib/device/client";
import { boardText, DeviceRefusedError } from "@/lib/device/train";
import type { DriveKit } from "@/lib/drive/kit";
import { RUNTIME_PIN, type RuntimePin } from "@/lib/drive/layout";
import {
  boardModel,
  boardSourceProblem,
  boardTuned,
  exportPlan,
  labModel,
  MAX_PLAN_CALL_BYTES,
  newExportId,
  urlModel,
  type BoardSource,
  type DrivePlan,
  type DriveTemplates,
  type LabSource,
  type UrlSource,
} from "@/lib/drive/plan";
import { expiringUrl, planUrls, SourceError, type FetchLike } from "@/lib/drive/sources";
import { LAB_MERGE_BASE } from "@/lib/train/base";
import type { LocalFiles } from "@/lib/train/local-files";

export type DeviceCaller = (config: DeviceConfig, name: string, args: Record<string, unknown>) => Promise<DeviceToolResult>;

export type ExportState =
  | "waiting_for_drive"
  | "checking"
  | "needs_erase"
  | "read_only"
  | "too_small"
  | "writing"
  | "needs_urls"
  | "verifying"
  | "done"
  | "failed"
  | "stopped";

export const ENDED_STATES: ReadonlySet<ExportState> = new Set(["done", "failed", "stopped"]);

/** One USB drive as drive_status lists it. */
export interface BoardDrive {
  name: string;
  title: string;
  bytes: number;
  kind: string;
  filesystem: string | null;
  label: string;
  free: number | null;
  read_only: boolean;
  identity: string;
  usable: boolean;
  why: string | null;
}

export interface ExportStatus {
  export: string;
  state: ExportState;
  message?: string;
  folder?: string;
  source?: string | null;
  armed?: boolean;
  copies?: number;
  copies_done?: number;
  drive?: { name: string; title: string; bytes: number; kind: string; filesystem: string | null; label: string; identity: string } | null;
  erasable?: boolean;
  file?: string | null;
  done_bytes?: number;
  total_bytes?: number;
  mbps?: number | null;
  eta_s?: number | null;
  result?: "PASS" | "FAIL" | null;
  problems?: string[];
  results?: Array<{ drive: string; bytes: number; seconds: number; result: "PASS" | "FAIL"; problems: string[] }>;
  seconds?: number;
}

/** A finished run on the board that could go on a drive. */
export interface BoardRun {
  run: string;
  base: string;
  adapter: string | null;
}

export interface DriveStatusReply {
  drives: BoardDrive[];
  export: ExportStatus | null;
  runs: BoardRun[];
}

function boardJson<T>(result: DeviceToolResult): T {
  return JSON.parse(boardText(result)) as T;
}

export async function driveStatus(config: DeviceConfig, call: DeviceCaller): Promise<DriveStatusReply> {
  const reply = boardJson<Partial<DriveStatusReply>>(await call(config, "drive_status", {}));
  return { drives: reply.drives ?? [], export: reply.export ?? null, runs: reply.runs ?? [] };
}

export async function exportSource(config: DeviceConfig, run: string, call: DeviceCaller): Promise<BoardSource> {
  return boardJson<BoardSource>(await call(config, "export_source", { run }));
}

export interface StartArgs {
  plan: DrivePlan;
  urls: Record<string, string>;
  drive?: string;
  identity?: string;
  wait_for_drive?: boolean;
  copies?: number;
}

/** The board takes 1 MiB a body, so a plan and its links that come out bigger are refused here, before the call. */
export function callTooLarge(args: StartArgs): boolean {
  return Buffer.byteLength(JSON.stringify(args)) > MAX_PLAN_CALL_BYTES;
}

export async function startExport(config: DeviceConfig, args: StartArgs, call: DeviceCaller): Promise<{ export: string; state: ExportState; folder?: string }> {
  return boardJson(await call(config, "export_model", { ...args }));
}

/** Fresh links for an export waiting in needs_urls. */
export async function refreshUrls(config: DeviceConfig, exportId: string, urls: Record<string, string>, call: DeviceCaller): Promise<void> {
  boardText(await call(config, "export_model", { export: exportId, urls }));
}

/** Carries on an export that failed or was stopped, from the plan the board kept, on a drive from drive_status. */
export async function resumeExport(config: DeviceConfig, args: { export: string; drive: string; identity?: string; urls?: Record<string, string> }, call: DeviceCaller) {
  return boardJson<{ export: string; state: ExportState }>(await call(config, "export_model", { ...args }));
}

export async function eraseDrive(config: DeviceConfig, args: { drive: string; identity: string; confirm: string }, call: DeviceCaller): Promise<void> {
  boardText(await call(config, "erase_drive", args));
}

export async function stopExport(config: DeviceConfig, exportId: string | undefined, call: DeviceCaller): Promise<ExportStatus> {
  return boardJson<ExportStatus>(await call(config, "stop_export", exportId ? { export: exportId } : {}));
}

// ---------- Which model ----------

const RUN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A build's level as the launchers' tables and Start Here hold it: Q4_K_M, IQ1_S, BF16. */
export const LEVEL = /^[A-Za-z0-9_]{1,16}$/;

/** What a POST names: a board run ("board:<run>", any of its base builds or one), or a lab model's build ("lab:<jobId>:<build>"). */
export type SourceRef = { kind: "board"; run: string; build?: string } | { kind: "lab"; jobId: string; build: string };

export function parseSourceRef(value: unknown, build?: unknown): SourceRef | null {
  if (typeof value !== "string") return null;
  const [kind, id, level] = value.split(":");
  if (kind === "board" && RUN.test(id ?? "") && level === undefined) {
    if (build === undefined || build === null || build === "") return { kind: "board", run: id };
    return typeof build === "string" && LEVEL.test(build) ? { kind: "board", run: id, build } : null;
  }
  if (kind === "lab" && UUID.test(id ?? "") && (level === "all" || LEVEL.test(level ?? ""))) return { kind: "lab", jobId: id.toLowerCase(), build: level };
  return null;
}

export const sourceTag = (ref: SourceRef): string => (ref.kind === "board" ? `board:${ref.run}` : `lab:${ref.jobId}:${ref.build}`);

/** The source isn't there: no such run, no checked files. A 404, with a sentence. */
export class ExportSourceMissing extends Error {}

export interface ExportDeps {
  config: DeviceConfig;
  call: DeviceCaller;
  kit: DriveKit;
  templates: DriveTemplates;
  localFiles: (jobId: string) => Promise<LocalFiles | null>;
  hubText: (repo: string, commit: string, name: string, token: string | null) => Promise<string>;
  hfToken: () => string | null;
  fetchImpl?: FetchLike;
  now?: () => Date;
  newId?: () => string;
  pin?: RuntimePin;
}

export interface BuiltExport {
  plan: DrivePlan;
  urls: Record<string, string>;
  /** False when a link expires, so the export can't wait for a drive plugged in later. */
  armable: boolean;
}

const sha = (f: { sha256: string }) => f.sha256.toLowerCase();

function labFiles(lf: LocalFiles, build: string) {
  const files = build === "all" ? lf.files : lf.files.filter((f) => f.level === build);
  if (!files.length) throw new ExportSourceMissing(`This model has no ${build} build that passed its checks.`);
  return files.map((f) => ({ level: f.level, name: f.name, bytes: f.bytes, sha256: sha(f) }));
}

/** The plan and links for a lab model's checked files. Also what GET re-signs for an export waiting in needs_urls. */
async function labExport(ref: Extract<SourceRef, { kind: "lab" }>, deps: ExportDeps) {
  const lf = await deps.localFiles(ref.jobId);
  if (!lf || !lf.repo || !lf.commit || !lf.files.length) throw new ExportSourceMissing("That lab model has no checked GGUF files on the Hub yet.");
  const files = labFiles(lf, ref.build);
  return { lf: { ...lf, repo: lf.repo, commit: lf.commit }, files };
}

/** Builds the plan and links for a board run or a lab model, without calling export_model. */
export async function buildExport(ref: SourceRef, deps: ExportDeps): Promise<BuiltExport> {
  const pin = deps.pin ?? RUNTIME_PIN;
  const facts = { exportId: (deps.newId ?? newExportId)(), madeAt: (deps.now ?? (() => new Date()))(), source: sourceTag(ref) };
  if (ref.kind === "board") {
    let src: BoardSource;
    try {
      src = await exportSource(deps.config, ref.run, deps.call);
    } catch (err) {
      if (err instanceof DeviceRefusedError && /no training run called|nothing to put on a drive/.test(err.message)) throw new ExportSourceMissing(err.message);
      throw err;
    }
    const problem = boardSourceProblem(src);
    if (problem) throw new ExportSourceMissing(problem);
    const model = boardModel(src, pin, ref.build);
    const plan = exportPlan(model, deps.kit, deps.templates, { ...facts, tuned: boardTuned(src), madeBy: { board: src.board.model, museDevice: src.board.muse_device } });
    return { plan, urls: await planUrls(plan, deps.kit, null), armable: true };
  }
  const { lf, files } = await labExport(ref, deps);
  const token = lf.public ? null : deps.hfToken();
  if (!lf.public && !token) throw new SourceError("This model's files are private, and HF_TOKEN isn't set, so the board can't be given a link to them.");
  const source: LabSource = {
    title: lf.title,
    slug: lf.slug,
    systemLine: lf.systemLine,
    adapterJobId: lf.adapterJobId,
    quantJobId: lf.quantJobId,
    repo: lf.repo,
    commit: lf.commit,
    public: lf.public,
    files,
    card: await deps.hubText(lf.repo, lf.commit, "README.md", token),
    tuned: lf.needsTunedTemplate ? await deps.hubText(lf.repo, lf.commit, "tuned.jinja", token) : null,
    ...(lf.sparkOpen ? { sparkOpen: true } : {}),
  };
  const tuned = { where: "cloud", base: lf.sparkOpen ? LAB_MERGE_BASE : "Muse Glimmer 30B", adapterJobId: lf.adapterJobId, quantJobId: lf.quantJobId, repo: lf.repo, commit: lf.commit };
  const plan = exportPlan(labModel(source, pin), deps.kit, deps.templates, { ...facts, tuned, madeBy: { board: null, museDevice: null } });
  const cloud = { repo: lf.repo, commit: lf.commit, public: lf.public, files: Object.fromEntries(files.map((f) => [f.sha256, f.name])) };
  const urls = await planUrls(plan, deps.kit, cloud, { hfToken: token, fetchImpl: deps.fetchImpl });
  return { plan, urls, armable: !Object.values(urls).some(expiringUrl) };
}

/** The owner's own private file (stage 2 in S3), with the link the owner's script signed on the laptop. Never armable. */
export async function buildUrlExport(
  src: UrlSource,
  url: string,
  deps: Pick<ExportDeps, "kit" | "templates" | "now" | "newId" | "pin">,
  /** A Derivative's license texts' links, by sha256 (scripts/drive-export.ts signs them next to the GGUF's). */
  derivativeUrls: Record<string, string> = {},
): Promise<BuiltExport> {
  if (!URL.canParse(url) || new URL(url).protocol !== "https:") throw new SourceError("The owner's link must be https.");
  for (const f of src.derivative ? Object.values(src.derivative.files) : []) {
    const link = derivativeUrls[f.sha256.toLowerCase()];
    if (!link || !URL.canParse(link) || new URL(link).protocol !== "https:") throw new SourceError("Each of a Derivative's license texts needs its https link.");
  }
  const plan = exportPlan(urlModel(src, deps.pin ?? RUNTIME_PIN), deps.kit, deps.templates, {
    exportId: (deps.newId ?? newExportId)(),
    madeAt: (deps.now ?? (() => new Date()))(),
    source: "url",
    tuned: { where: "cloud", base: "Muse Glimmer 30B", file: "the owner's private copy" },
    madeBy: { board: null, museDevice: null },
  });
  const kitUrls = await planUrls({ files: plan.files.filter((f) => "kit" in f) }, deps.kit, null);
  return { plan, urls: { ...kitUrls, ...derivativeUrls, [src.file.sha256.toLowerCase()]: url }, armable: false };
}

/**
 * Fresh links for an export waiting in needs_urls, from what its source tag says, or null when the platform can't make
 * them: a board run needs none, and only the owner's script can sign the owner's own file again.
 */
export async function freshUrls(source: string | null | undefined, deps: ExportDeps): Promise<Record<string, string> | null> {
  const ref = parseSourceRef(source);
  if (!ref || ref.kind !== "lab") return null;
  const { lf, files } = await labExport(ref, deps);
  const token = lf.public ? null : deps.hfToken();
  const cloud = { repo: lf.repo, commit: lf.commit, public: lf.public, files: Object.fromEntries(files.map((f) => [f.sha256, f.name])) };
  return planUrls({ files: files.map((f) => ({ path: `model/${f.name}`, bytes: f.bytes, sha256: f.sha256, url: true as const })) }, deps.kit, cloud, {
    hfToken: token,
    fetchImpl: deps.fetchImpl,
  });
}
