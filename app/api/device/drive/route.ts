import path from "node:path";
import { requireAdmin } from "@/lib/auth";
import { callDeviceTool, deviceConfig, type DeviceConfig } from "@/lib/device/client";
import {
  buildExport,
  buildUrlExport,
  callTooLarge,
  driveStatus,
  ExportSourceMissing,
  freshUrls,
  LEVEL,
  parseSourceRef,
  refreshUrls,
  resumeExport,
  startExport,
  stopExport,
  type ExportDeps,
} from "@/lib/device/drive";
import { DeviceRefusedError } from "@/lib/device/train";
import { kitFileUrl, kitProblem, loadKit, type DriveKit } from "@/lib/drive/kit";
import { EXPORT_ID, isKnowledgeRunName, readDriveTemplates, SPARK_DERIVATIVE_KEYS, type LinkedSparkDerivative, type UrlSource } from "@/lib/drive/plan";
import { expiringUrl, hubText, redactUrls, SourceError } from "@/lib/drive/sources";
import { env } from "@/lib/env";
import { badRequest, errorJson, HttpError, readJson, route } from "@/lib/http";

// Building a plan reads the model's card from the Hub and asks the board for its run's files, which can take a minute.
export const maxDuration = 300;

const DRIVE_NAME = /^[a-z][a-z0-9]{1,15}$/;
const IDENTITY = /^[0-9a-f]{16}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_COPIES = 10;

/** One line per call, naming the admin and the board tool, never a link, a token or the board's address. */
function logCall(admin: { id: string }, tool: string): void {
  console.info(`[device/drive] admin ${admin.id} ${tool}`);
}

/** Why something failed, for the log: no link of any kind (the board's address included) and never the board's token. */
function logReason(err: unknown, config: DeviceConfig | null): string {
  let reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (config?.token) reason = reason.split(config.token).join("[token]");
  return reason.replace(/https?:\/\/[^\s"'<>]+/g, "[URL]").slice(0, 300);
}

function failure(err: unknown, config: DeviceConfig | null): Response {
  if (err instanceof HttpError) throw err;
  if (err instanceof DeviceRefusedError) return errorJson(409, "device_refused", { message: redactUrls(err.message) });
  if (err instanceof ExportSourceMissing) return errorJson(404, "source_not_found", { message: err.message });
  if (err instanceof SourceError) return errorJson(409, "source_unavailable", { message: redactUrls(err.message) });
  console.error("[device/drive]", logReason(err, config));
  return errorJson(502, "device_unavailable");
}

/** Off, every drive route answers as if it didn't exist, and touches nothing: no session, no board, no kit. */
const off = () => errorJson(404, "not_found");

async function deps(config: DeviceConfig, kit: DriveKit): Promise<ExportDeps> {
  const { localFilesFor } = await import("@/lib/train/local-files-server");
  return {
    config,
    call: callDeviceTool,
    kit,
    templates: await readDriveTemplates(path.join(process.cwd(), "drive")),
    localFiles: localFilesFor,
    hubText: (repo, commit, name, token) => hubText(repo, commit, name, token),
    hfToken: () => process.env.HF_TOKEN?.trim() || null,
  };
}

/** Every kit file's link: what a board needs to fetch the kit when it hasn't yet. */
function kitUrls(kit: DriveKit): Record<string, string> {
  return Object.fromEntries(kit.files.map((f) => [f.sha256, kitFileUrl(kit, f.sha256)!]));
}

function driveArgs(body: Record<string, unknown>): { drive?: string; identity?: string } {
  if (body.drive === undefined) return {};
  if (typeof body.drive !== "string" || !DRIVE_NAME.test(body.drive)) throw badRequest("drive must be a drive's name from the list.");
  if (body.identity !== undefined && (typeof body.identity !== "string" || !IDENTITY.test(body.identity))) throw badRequest("identity must be the drive's identity from the list.");
  return { drive: body.drive, ...(body.identity ? { identity: body.identity as string } : {}) };
}

/** The owner's private file, as scripts/drive-export.ts sends it. */
function urlSource(body: Record<string, unknown>): UrlSource {
  const file = body.file as Record<string, unknown> | undefined;
  const text = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
  if (!file || !text(file.name, 200) || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/.test(file.name as string)) throw badRequest("file.name must be a .gguf file name.");
  if (typeof file.level !== "string" || !LEVEL.test(file.level) || !Number.isSafeInteger(file.bytes) || (file.bytes as number) <= 0 || typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) {
    throw badRequest("file needs its level (letters, digits and _, like IQ1_S), bytes and sha256.");
  }
  if (!text(body.title, 120) || !text(body.slug, 60)) throw badRequest("Name the model with title and slug.");
  if (typeof body.systemLine !== "string" || body.systemLine.length > 4000) throw badRequest("systemLine must be text.");
  const changes = Array.isArray(body.changes) ? body.changes.filter((c): c is string => typeof c === "string" && c.length <= 400).slice(0, 10) : [];
  if (!changes.length) throw badRequest("changes must say what was done to Meta's model, one sentence each.");
  const derivative = derivativeOf(body);
  if (!derivative && isKnowledgeRunName(file.name as string, body.slug as string, body.title as string)) {
    throw badRequest("This is a knowledge-run model, a Derivative of Muse Spark Open: send its license texts as derivative, from scripts/drive-export.ts.");
  }
  return {
    title: body.title as string,
    slug: body.slug as string,
    systemLine: body.systemLine,
    file: { level: file.level as string, name: file.name as string, bytes: file.bytes as number, sha256: file.sha256 },
    changes,
    ...(derivative ? { derivative } : {}),
  };
}

/** A Derivative's duties as scripts/drive-export.ts sends them, or undefined when there are none. */
function derivativeOf(body: Record<string, unknown>): LinkedSparkDerivative | undefined {
  if (body.derivative === undefined) return undefined;
  const d = body.derivative as { files?: Record<string, { bytes?: unknown; sha256?: unknown }>; dangers?: Record<string, unknown> } | null;
  const files = {} as LinkedSparkDerivative["files"];
  for (const key of SPARK_DERIVATIVE_KEYS) {
    const f = d?.files?.[key];
    if (!f || !Number.isSafeInteger(f.bytes) || (f.bytes as number) <= 0 || typeof f.sha256 !== "string" || !SHA256.test(f.sha256)) {
      throw badRequest(`derivative.files.${key} needs its bytes and sha256.`);
    }
    files[key] = { bytes: f.bytes as number, sha256: f.sha256 };
  }
  const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
  const dangers = d?.dangers ?? {};
  if (!n(dangers.madeUpPct) || !n(dangers.honestPct) || !n(dangers.falsePremisePct)) throw badRequest("derivative.dangers needs madeUpPct, honestPct and falsePremisePct, in percent.");
  return { files, dangers: { madeUpPct: dangers.madeUpPct as number, honestPct: dangers.honestPct as number, falsePremisePct: dangers.falsePremisePct as number } };
}

/** The links for a Derivative's license texts, by sha256, as the board looks files up. */
function derivativeLinks(body: Record<string, unknown>, d: LinkedSparkDerivative | undefined): Record<string, string> {
  if (!d) return {};
  const given = (body.derivativeUrls ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of SPARK_DERIVATIVE_KEYS) {
    const url = given[key];
    if (typeof url !== "string" || !URL.canParse(url) || new URL(url).protocol !== "https:") throw badRequest(`derivativeUrls.${key} must be an https link.`);
    out[d.files[key].sha256.toLowerCase()] = url;
  }
  return out;
}

/**
 * GET -> {drives, export, runs, kit}: the USB drives on the board, the current or last export, the board's finished runs,
 * and why the drive kit can't be used yet (null when it can). An export waiting in needs_urls for a private lab model gets
 * freshly signed links before this answers, so an open card keeps it moving. Only signed links are sent: the board waits
 * only on those, and a public link is the same link every time. Admins only. 404 with DRIVE_EXPORT_ENABLED off, 503
 * device_not_configured, 502 device_unavailable.
 */
export const GET = route(async () => {
  if (!env.driveExportEnabled) return off();
  const admin = await requireAdmin();
  const config = deviceConfig();
  if (!config) return errorJson(503, "device_not_configured");
  const kit = await loadKit();
  try {
    logCall(admin, "drive_status");
    const status = await driveStatus(config, callDeviceTool);
    let refreshed = false;
    if (status.export?.state === "needs_urls" && kit && !kitProblem(kit)) {
      const made = await freshUrls(status.export.source, await deps(config, kit)).catch((err) => {
        console.error("[device/drive] fresh links", logReason(err, config));
        return null;
      });
      const urls = Object.fromEntries(Object.entries(made ?? {}).filter(([, url]) => expiringUrl(url)));
      if (Object.keys(urls).length) {
        logCall(admin, "export_model (fresh links)");
        await refreshUrls(config, status.export.export, urls, callDeviceTool);
        refreshed = true;
      }
    }
    return Response.json({ ...status, kit: kitProblem(kit), refreshed });
  } catch (err) {
    return failure(err, config);
  }
});

/**
 * POST starts an export, and answers {export, state, folder}:
 *   {source: "board:<run>", build?, mode: "now" | "arm", drive?, identity?, copies?}   a board run
 *   {source: "lab:<jobId>:<build>", mode, drive?, identity?, copies?}                  a lab model's checked files
 *   {source: "url", url, file, title, slug, systemLine, changes, derivative?, derivativeUrls?, drive, identity?}
 *                                                                                      the owner's own file (their script)
 *   {resume: "<export>", drive, identity?, url?}                                         carry on an export that stopped
 * "now" needs a drive from GET; "arm" waits for drives plugged in after it, up to `copies`. Admins only. 400 bad input, 404
 * source_not_found, 409 device_refused or source_unavailable or cant_arm, 413 plan_too_large, 503 device_not_configured or
 * drive_kit_missing, 502 device_unavailable.
 */
export const POST = route(async (req: Request) => {
  if (!env.driveExportEnabled) return off();
  const admin = await requireAdmin();
  const config = deviceConfig();
  if (!config) return errorJson(503, "device_not_configured");
  const body = await readJson(req, 64 * 1024);
  const kit = await loadKit();
  const kitWhy = kitProblem(kit);
  if (kitWhy || !kit) return errorJson(503, "drive_kit_missing", { message: kitWhy });
  const target = driveArgs(body);
  try {
    if (body.resume !== undefined) {
      if (typeof body.resume !== "string" || !EXPORT_ID.test(body.resume)) throw badRequest("resume must be an export's id.");
      const urls: Record<string, string> = { ...kitUrls(kit) };
      if (typeof body.url === "string" && body.file && typeof (body.file as { sha256?: unknown }).sha256 === "string") {
        urls[(body.file as { sha256: string }).sha256.toLowerCase()] = body.url;
      }
      if (body.derivative !== undefined) Object.assign(urls, derivativeLinks(body, derivativeOf(body)));
      const status = await driveStatus(config, callDeviceTool);
      if (status.export?.export === body.resume && status.export.state === "needs_urls") {
        logCall(admin, "export_model (fresh links)");
        await refreshUrls(config, body.resume, urls, callDeviceTool);
        return Response.json({ export: body.resume, state: "needs_urls" });
      }
      if (!target.drive) throw badRequest("Name the drive to carry on with, from the list.");
      const fresh = status.export?.export === body.resume ? await freshUrls(status.export.source, await deps(config, kit)).catch(() => null) : null;
      logCall(admin, "export_model (carry on)");
      return Response.json(await resumeExport(config, { export: body.resume, drive: target.drive, identity: target.identity, urls: { ...urls, ...fresh } }, callDeviceTool));
    }

    const mode = body.mode ?? "now";
    if (mode !== "now" && mode !== "arm") throw badRequest('mode must be "now" or "arm".');
    const copies = body.copies ?? 1;
    if (!Number.isInteger(copies) || (copies as number) < 1 || (copies as number) > MAX_COPIES) throw badRequest(`copies must be a whole number from 1 to ${MAX_COPIES}.`);
    if (mode === "now" && !target.drive) throw badRequest("Pick a drive that's plugged in, or arm the export.");
    if (mode === "now" && copies !== 1) throw badRequest("Only an armed export makes several copies.");

    let built;
    if (body.source === "url") {
      if (typeof body.url !== "string") throw badRequest("Send the owner's link as url.");
      const src = urlSource(body);
      built = await buildUrlExport(src, body.url, await deps(config, kit), derivativeLinks(body, src.derivative));
    } else {
      const ref = parseSourceRef(body.source, body.build);
      if (!ref) throw badRequest('source must be "board:<run>" or "lab:<training job id>:<build>".');
      built = await buildExport(ref, await deps(config, kit));
    }
    if (mode === "arm" && !built.armable) {
      return errorJson(409, "cant_arm", { message: "This model's files have links that expire, so the export can't wait for a drive. Plug the drive in, then press Export now." });
    }
    const args = { plan: built.plan, urls: built.urls, ...(mode === "arm" ? { wait_for_drive: true, copies: copies as number } : target) };
    if (callTooLarge(args)) return errorJson(413, "plan_too_large", { message: "This drive's plan is too big to send to the board in one call." });
    logCall(admin, mode === "arm" ? "export_model (armed)" : "export_model");
    return Response.json(await startExport(config, args, callDeviceTool));
  } catch (err) {
    return failure(err, config);
  }
});

/** DELETE ?export= -> the export as it ended: stops it, keeps what it wrote, and powers the drive off. Errors as GET. */
export const DELETE = route(async (req: Request) => {
  if (!env.driveExportEnabled) return off();
  const admin = await requireAdmin();
  const config = deviceConfig();
  if (!config) return errorJson(503, "device_not_configured");
  const exportId = new URL(req.url).searchParams.get("export") || undefined;
  if (exportId && !EXPORT_ID.test(exportId)) throw badRequest("export must be an export's id.");
  try {
    logCall(admin, "stop_export");
    return Response.json(await stopExport(config, exportId, callDeviceTool));
  } catch (err) {
    return failure(err, config);
  }
});
