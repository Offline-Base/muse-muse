/**
 * The two drive tools a product may call (docs/DRIVE_EXPORT.md, "From a product"), once lib/gateway/gadget.ts has decided who is
 * asking: a build, which gets lib/device/drive-sim.ts and no board, or the linked board's verified owner.
 *
 *   drive_status      the drive and the export's progress, trimmed to what a product needs. It also hands fresh signed links to
 *                     this product's own export when one waits in needs_urls, as the admin route's GET does.
 *   export_to_drive   the product's own tuned model, onto the one usable drive plugged in, confirmed once on a card.
 *
 * What a product can't do from here, by construction: name a source (`model` resolves through ownModel alone), hand in a link or a
 * plan, arm an export for later, erase, format or stop. The plan comes from buildExport, the admin route's path, so
 * checkDerivativePlan guards it the same way. The confirmation is the tool gateway's (lib/tools/sign.ts), with the same
 * needs_confirmation answer. As there, the gateway can't tell a click from a server repeating the call: only the product's card
 * proves a person agreed, which is why the skill and the judge both ask for it.
 */
import type { ProductDriveTool } from "@/lib/caps/hardware/limits";
import type { DeviceConfig } from "@/lib/device/client";
import {
  buildExport,
  callTooLarge,
  driveStatus,
  ENDED_STATES,
  ExportSourceMissing,
  freshUrls,
  parseSourceRef,
  refreshUrls,
  startExport,
  type BoardDrive,
  type DeviceCaller,
  type DriveStatusReply,
  type ExportDeps,
  type ExportStatus,
} from "@/lib/device/drive";
import { simulatedDriveStatus } from "@/lib/device/drive-sim";
import { DeviceRefusedError } from "@/lib/device/train";
import { kitProblem, type DriveKit } from "@/lib/drive/kit";
import { isKnowledgeRunName } from "@/lib/drive/plan";
import { expiringUrl, redactUrls, SourceError } from "@/lib/drive/sources";
import { gatewayError } from "@/lib/gateway/errors";
import { noBoard, type GadgetBoard, type GadgetDriveCall } from "@/lib/gateway/gadget";
import { hardwareProofKey } from "@/lib/caps/hardware/limits";
import { cardText, checkApproval, mintApproval, type ApprovalScope } from "@/lib/tools/sign";
import { BUILT_WITH_SPARK_OPEN, USAGE_POINTS } from "@/lib/train/base";
import type { LocalFile, LocalFiles } from "@/lib/train/local-files";

export interface ProductDriveDeps {
  /** ownModelFor. The only way a product's `model` becomes a model. */
  ownModel(productId: string): Promise<{ adapterJobId: string } | null>;
  localFiles(adapterJobId: string): Promise<LocalFiles | null>;
  kit(): Promise<DriveKit | null>;
  /** What buildExport needs besides the board: the drive's templates and the Hub. */
  planDeps(): Promise<Pick<ExportDeps, "templates" | "hubText" | "hfToken" | "fetchImpl" | "newId" | "pin">>;
  /** Spends an approval's nonce (`tool-approval:<nonce>`, as the tool gateway does). False when it was spent already. */
  spendApproval(nonce: string, exp: Date): Promise<boolean>;
  /** A count at this moment, for /caps/proof and the simulator's clock. */
  note(key: string, at: Date): Promise<void>;
  latestNote(key: string): Promise<Date | null>;
  now?(): Date;
}

/** The sentence the docs promise for a drive that needs erasing. A product can't do it. */
export const NEEDS_ERASE_WORDS = "This drive needs erasing before the model can go on it. A product can't do that. Confirm it on your board's page.";

const NO_DRIVE_WORDS = "Plug the drive into your board first, then try again. An export from a product never waits for a drive.";

/** The model's files are named in full here, so one of these is a Derivative with no duties. Never goes on a drive. */
const NO_DUTIES_WORDS = "This model is a Derivative of Muse Spark Open, and its files don't carry the license duties it owes, so it can't go on a drive.";

/** Preferred, for a product's export: the admin card picks by hand, and here nobody does. Otherwise the smallest that passed. */
const PREFERRED_LEVEL = "Q4_K_M";

/** The linked board keeps its own address and token (LinkedBoard.open). lib/device/drive.ts takes a config, and this one is never read. */
const BOARD_HOLDS_ITS_OWN_CONFIG: DeviceConfig = { url: "", token: "" };

const callerFor = (board: GadgetBoard): DeviceCaller => (_config, name, args) => board.callTool(name, args);

/** Same envelope as the board's tools, so a product reads every gadget answer one way. */
function answer(payload: object, simulated: boolean): Response {
  const text = JSON.stringify(simulated ? { ...payload, simulated: true } : payload);
  return Response.json({ isError: false, content: [{ type: "text", text }], simulated });
}

const refusal = (status: number, code: string, message: string): Response => gatewayError(status, status === 404 ? "not_found_error" : "invalid_request_error", code, message, { retry: false });

/** A board's sentence, for a product: no link of any kind, and no path on the board. */
function forProductWords(text: string): string {
  return redactUrls(text)
    .replace(/https?:\/\/[^\s"'<>]+/g, "[link]")
    .replace(/\sat\s+\/[^\s,]*/g, "")
    .replace(/(^|\s)\/[^\s,]+/g, "$1[a folder on the board]");
}

/** Why something failed, for the log. Never a link (a board's address is one), and never a plan. */
function forLog(err: unknown): string {
  const reason = err instanceof Error ? `${err.name}: ${err.message}` : "unknown";
  return reason.replace(/https?:\/\/[^\s"'<>]+/g, "[URL]").slice(0, 300);
}

function failed(err: unknown): Response {
  if (err instanceof DeviceRefusedError) return refusal(409, "device_refused", forProductWords(err.message));
  if (err instanceof ExportSourceMissing) return refusal(404, "own_model_not_ready", forProductWords(err.message));
  if (err instanceof SourceError) return refusal(409, "source_unavailable", forProductWords(err.message));
  console.error("[gadget] drive tool:", forLog(err));
  return gatewayError(502, "server_error", "gadget_unavailable", "The gadget didn't answer. Check that it's on and connected, then try again.");
}

// ---------- drive_status ----------

function driveView(d: BoardDrive) {
  return { title: d.title, bytes: d.bytes, kind: d.kind, filesystem: d.filesystem, free: d.free, read_only: d.read_only, usable: d.usable, why: d.why ? forProductWords(d.why) : null };
}

/** The progress. No source, no folder, and no drive identity: the board may be busy with something else of its owner's. */
function exportView(e: ExportStatus) {
  const needsErase = e.state === "needs_erase";
  return {
    export: e.export,
    state: e.state,
    ...(needsErase ? { message: NEEDS_ERASE_WORDS } : e.message ? { message: forProductWords(e.message) } : {}),
    ...(e.drive ? { drive: { title: e.drive.title, bytes: e.drive.bytes, kind: e.drive.kind } } : {}),
    ...(e.done_bytes !== undefined ? { done_bytes: e.done_bytes } : {}),
    ...(e.total_bytes !== undefined ? { total_bytes: e.total_bytes } : {}),
    ...(e.mbps !== undefined ? { mbps: e.mbps } : {}),
    ...(e.eta_s !== undefined ? { eta_s: e.eta_s } : {}),
    ...(e.result !== undefined ? { result: e.result } : {}),
    ...(e.problems ? { problems: e.problems.map(forProductWords) } : {}),
    ...(e.seconds !== undefined ? { seconds: e.seconds } : {}),
  };
}

/** What a product sees of a board's drive_status. Never the board's runs, a drive's name or its identity. */
const statusView = (s: Pick<DriveStatusReply, "drives" | "export">) => ({ drives: s.drives.map(driveView), export: s.export ? exportView(s.export) : null });

/**
 * An export of this product's own model, waiting in needs_urls, gets fresh signed links. Only its own: the status comes from the
 * board, and whatever else its source tag names isn't this product's to sign, even on its owner's board.
 */
async function refreshOwnLinks(status: DriveStatusReply, board: GadgetBoard, productId: string, deps: ProductDriveDeps): Promise<void> {
  const exp = status.export;
  if (exp?.state !== "needs_urls") return;
  const ref = parseSourceRef(exp.source);
  if (ref?.kind !== "lab") return;
  const own = await deps.ownModel(productId);
  if (!own || own.adapterJobId.toLowerCase() !== ref.jobId) return;
  const kit = await deps.kit();
  if (!kit || kitProblem(kit)) return;
  const made = await freshUrls(exp.source, await exportDeps(board, kit, deps));
  const urls = Object.fromEntries(Object.entries(made ?? {}).filter(([, url]) => expiringUrl(url)));
  if (Object.keys(urls).length) await refreshUrls(BOARD_HOLDS_ITS_OWN_CONFIG, exp.export, urls, callerFor(board));
}

async function statusOnBoard(call: Extract<GadgetDriveCall, { kind: "owner" }>, deps: ProductDriveDeps): Promise<Response> {
  const board = await call.open();
  if (!board) return noBoard();
  const status = await driveStatus(BOARD_HOLDS_ITS_OWN_CONFIG, callerFor(board));
  // A link that can't be made yet is no reason not to show the status. The next poll tries again.
  await refreshOwnLinks(status, board, call.productId, deps).catch((err: unknown) => console.error("[gadget] fresh links:", forLog(err)));
  return answer(statusView(status), false);
}

// ---------- export_to_drive ----------

async function exportDeps(board: GadgetBoard, kit: DriveKit, deps: ProductDriveDeps): Promise<ExportDeps> {
  return { ...(await deps.planDeps()), config: BOARD_HOLDS_ITS_OWN_CONFIG, call: callerFor(board), kit, localFiles: deps.localFiles };
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

function pickLevel(files: readonly LocalFile[]): LocalFile {
  return files.find((f) => f.level === PREFERRED_LEVEL) ?? files[0];
}

/** A card for this approval scope. `stale` when an approval was sent that no longer fits. */
function confirmCard(scope: ApprovalScope, lines: string[], stale: boolean, now: Date, simulated: boolean): Response {
  return answer(
    {
      ok: false,
      code: "needs_confirmation",
      approval: { id: mintApproval(scope, now), title: "Put this model on your drive?", lines: lines.map(cardText) },
      ...(stale ? { stale: true } : {}),
    },
    simulated,
  );
}

const needsErase = (exportId: string, simulated = false) => answer({ ok: false, code: "needs_erase", export: exportId, state: "needs_erase", message: NEEDS_ERASE_WORDS }, simulated);

async function exportOnBoard(call: Extract<GadgetDriveCall, { kind: "owner" }>, deps: ProductDriveDeps): Promise<Response> {
  const now = deps.now?.() ?? new Date();

  // Whose model. Nothing but ownModel says, so another product's id is the same as no such id.
  const own = await deps.ownModel(call.productId);
  const wanted = (call.model as string).toLowerCase();
  if (!own || (wanted !== "own" && wanted !== own.adapterJobId.toLowerCase())) return refusal(404, "own_model_not_found", "This product has no tuned model of its own by that name.");
  const lf = await deps.localFiles(own.adapterJobId);
  if (!lf || lf.adapterJobId !== own.adapterJobId || !lf.repo || !lf.commit || !lf.files.length) return refusal(409, "own_model_not_ready", "This product's model has no checked files for a drive yet.");

  // ownModelFor returns only models trained on r30b, each a Derivative, so a file that doesn't say so has lost its duties. labModel
  // adds them only when sparkOpen is set. Refused here, knowledge-run name or not, and exportPlan's own check is behind this.
  if (!lf.sparkOpen) {
    if (isKnowledgeRunName(lf.slug, lf.title, ...lf.files.map((f) => f.name))) console.error(`[gadget] a knowledge-run file without duties, on job ${own.adapterJobId}`);
    return refusal(409, "license_duties_missing", NO_DUTIES_WORDS);
  }

  const kit = await deps.kit();
  const kitWhy = kitProblem(kit);
  if (kitWhy || !kit) return gatewayError(503, "server_error", "drive_kit_missing", "Muse Muse can't make drives right now. Nothing was changed.", { retry: false });

  const board = await call.open();
  if (!board) return noBoard();
  const caller = callerFor(board);

  // Which drive. It must be in the board now: an export from a product is never armed, since a private model's links expire.
  const status = await driveStatus(BOARD_HOLDS_ITS_OWN_CONFIG, caller);
  const going = status.export && !ENDED_STATES.has(status.export.state) ? status.export : null;
  if (going?.state === "needs_erase") return needsErase(going.export);
  if (going) return refusal(409, "export_busy", "An export is already going on this board. Wait for it to end, then try again.");
  const usable = status.drives.filter((d) => d.usable);
  if (!usable.length) return refusal(409, "no_drive", NO_DRIVE_WORDS);
  if (usable.length > 1) return refusal(409, "several_drives", "More than one drive is plugged in. Leave only the one you want, then try again.");
  const [drive] = usable;
  const file = pickLevel(lf.files);

  // The card. The approval covers this model, this file and this drive, so a swapped stick or a newer model needs a new one.
  const scope: ApprovalScope = {
    productId: call.productId,
    subject: call.subject,
    slug: "export_to_drive",
    args: { model: own.adapterJobId, sha256: file.sha256, drive: drive.name, identity: drive.identity },
  };
  const lines = [
    `Model: ${lf.title}`,
    `File: ${file.level}, ${gb(file.bytes)}`,
    `Drive: ${drive.title}, ${gb(drive.bytes)}`,
    `${BUILT_WITH_SPARK_OPEN}. ${USAGE_POINTS.join(" ")}`,
    "Nothing on the drive is erased. If it needs erasing first, you confirm that on your board's page.",
  ];
  const approved = call.approval ? checkApproval(call.approval, scope, now) : null;
  if (!approved) return confirmCard(scope, lines, Boolean(call.approval), now, false);

  // The plan, through the admin route's path. Nothing is spent until it's whole.
  let built: Awaited<ReturnType<typeof buildExport>>;
  try {
    // The row checked above and shown on the card, not a second read that a newer quantize run could change.
    built = await buildExport({ kind: "lab", jobId: own.adapterJobId.toLowerCase(), build: file.level }, { ...(await exportDeps(board, kit, deps)), localFiles: async () => lf });
  } catch (err) {
    if (err instanceof ExportSourceMissing || err instanceof SourceError || err instanceof DeviceRefusedError) throw err;
    // exportPlan refusing a plan, checkDerivativePlan included. No board call follows.
    console.error("[gadget] drive plan refused:", forLog(err));
    return refusal(409, "plan_refused", "This model can't go on a drive as it stands. Nothing was changed.");
  }
  const args = { plan: built.plan, urls: built.urls, drive: drive.name, identity: drive.identity };
  if (callTooLarge(args)) return refusal(413, "plan_too_large", "This drive's plan is too big to send to the board in one call.");

  // Spent when the call goes out, as the tool gateway does: a refusal above doesn't burn one, and no two calls share one.
  if (!(await deps.spendApproval(approved.nonce, approved.exp))) return confirmCard(scope, lines, true, now, false);
  console.info(`[gadget] drive export for product ${call.productId}`);
  const started = await startExport(BOARD_HOLDS_ITS_OWN_CONFIG, args, caller);
  if (started.state === "needs_erase") return needsErase(started.export);
  return answer({ ok: true, export: started.export, state: started.state }, false);
}

// ---------- A build: the simulator, and never a board ----------

const simKey = (call: Extract<GadgetDriveCall, { kind: "build" }>, tool: ProductDriveTool) => hardwareProofKey(tool, call.buildId ?? call.tokenId);

async function onSimulator(call: Extract<GadgetDriveCall, { kind: "build" }>, deps: ProductDriveDeps): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  if (call.tool === "drive_status") {
    const startedAt = await deps.latestNote(simKey(call, "export_to_drive"));
    await deps.note(simKey(call, "drive_status"), now);
    return answer(statusView(simulatedDriveStatus(startedAt ? startedAt.getTime() : null, now.getTime())), true);
  }
  if ((call.model as string).toLowerCase() !== "own") return refusal(404, "own_model_not_found", "This product has no tuned model of its own by that name.");
  const [drive] = simulatedDriveStatus(null, now.getTime()).drives;
  const scope: ApprovalScope = { productId: call.productId, subject: "build", slug: "export_to_drive", args: { model: "own", drive: drive.name, identity: drive.identity } };
  const lines = ["Model: This product's own tuned model", `Drive: ${drive.title}, ${gb(drive.bytes)}`, `${BUILT_WITH_SPARK_OPEN}. ${USAGE_POINTS.join(" ")}`, "Nothing on the drive is erased. If it needs erasing first, you confirm that on your board's page."];
  const approved = call.approval ? checkApproval(call.approval, scope, now) : null;
  if (!approved) return confirmCard(scope, lines, Boolean(call.approval), now, true);
  if (!(await deps.spendApproval(approved.nonce, approved.exp))) return confirmCard(scope, lines, true, now, true);
  await deps.note(simKey(call, "export_to_drive"), now);
  const started = simulatedDriveStatus(now.getTime(), now.getTime()).export as ExportStatus;
  return answer({ ok: true, export: started.export, state: started.state }, true);
}

/** One drive tool call, past the gateway's checks. */
export async function productDriveCall(call: GadgetDriveCall, deps: ProductDriveDeps): Promise<Response> {
  if (call.kind === "build") return onSimulator(call, deps);
  try {
    return call.tool === "drive_status" ? await statusOnBoard(call, deps) : await exportOnBoard(call, deps);
  } catch (err) {
    return failed(err);
  }
}
