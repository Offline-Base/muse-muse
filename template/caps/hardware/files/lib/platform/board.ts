// Platform file (Muse Muse platform services). Don't edit: products wrap these helpers, never change them.
//
// A board connected to Muse Muse: read its sensors, or show a short line on it, through the gateway. Server only, from a
// route handler: pass the incoming request, so the owner's pass and the visitor's id travel with it. During the build the
// gateway answers with a simulated board. Live, a board reaches this product only after its owner links one, and only the
// owner until they open it to visitors. Anything else throws BoardError, and boardMessage(err) has the line to show.
import { gatewayEnv, type RequestLike } from "@/lib/meta/client";
import { BoardError, boardMessage, isBoardOffline } from "@/lib/platform/board-errors";
import { identityHeaders } from "@/lib/platform/identity";

export const SHOW_TEXT_MAX_CHARS = 200;
export { BoardError, boardMessage, isBoardOffline };

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Reply = { content?: Content[]; isError?: boolean; simulated?: boolean; error?: { code?: string; message?: string } };

async function send(tool: string, args: Record<string, unknown>, request: RequestLike | null, approval?: string): Promise<Reply> {
  const res = await fetch(gatewayEnv().baseURL.replace(/\/v1\/?$/, "/gadget"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gatewayEnv().apiKey}`, ...identityHeaders(request) },
    body: JSON.stringify({ tool, arguments: args, ...(approval ? { approval } : {}) }),
  });
  const body = (await res.json().catch(() => null)) as Reply | null;
  if (!res.ok || !body) throw new BoardError(body?.error?.message ?? `The board call failed (HTTP ${res.status}).`, body?.error?.code ?? "board_error", res.status);
  if (body.isError) throw new BoardError(body.content?.find((c) => c.type === "text")?.text || "The board couldn't do that.", "board_tool_error", 200);
  return body;
}

async function callBoard<T>(tool: string, args: Record<string, unknown>, request: RequestLike | null, approval?: string): Promise<T & { simulated: boolean }> {
  const body = await send(tool, args, request, approval);
  try {
    return { ...(JSON.parse(body.content?.find((c) => c.type === "text")?.text ?? "") as T), simulated: body.simulated === true };
  } catch {
    throw new BoardError("The board sent an answer this product can't read.", "board_tool_error", 200);
  }
}

async function callMedia(tool: string, type: string, args: Record<string, unknown>, request: RequestLike | null): Promise<{ dataUrl: string; simulated: boolean }> {
  const body = await send(tool, args, request);
  const part = body.content?.find((c) => c.type === type && c.data);
  if (!part?.data) throw new BoardError("The board sent an answer this product can't read.", "board_tool_error", 200);
  return { dataUrl: `data:${part.mimeType ?? "application/octet-stream"};base64,${part.data}`, simulated: body.simulated === true };
}

export interface SensorReading {
  name: string;
  /** Like "temperature". */
  kind: string;
  value: number;
  /** Like "C". */
  unit: string;
}

/**
 * Every helper takes the incoming request, and has to: it carries the owner's pass, and without it the live board refuses
 * everyone but visitors of a board opened to them. Pass null only where no person is asking.
 */
type WithRequest = { request: RequestLike | null };

/** Reads the board's sensors, or one by name. Read only. */
export async function readSensor(opts: { sensor?: string } & WithRequest): Promise<{ sensors: SensorReading[]; simulated: boolean }> {
  return callBoard("read_sensor", opts.sensor ? { sensor: opts.sensor } : {}, opts.request);
}

/** Shows one line on the board, up to 200 characters, 6 times a minute. */
export async function showText(text: string, opts: WithRequest): Promise<{ shown: string; simulated: boolean }> {
  return callBoard("show_text", { text }, opts.request);
}

/** takePhoto for a brief that lists muse-gadget too, with the owner's pass: `takePhoto` in lib/meta/gadget.ts doesn't send it. */
export async function boardPhoto(opts: WithRequest): Promise<{ dataUrl: string; simulated: boolean }> {
  return callMedia("capture_image", "image", {}, opts.request);
}

/** recordSound for a brief that lists muse-gadget too, with the owner's pass. 1 to 30 seconds, 3 by default. */
export async function boardSound(opts: { seconds?: number } & WithRequest): Promise<{ dataUrl: string; simulated: boolean }> {
  return callMedia("record_audio", "audio", { seconds: Math.min(30, Math.max(1, Math.round(opts.seconds ?? 3))) }, opts.request);
}

export interface DriveStatus {
  drives: Array<{ title: string; bytes: number; kind: string; filesystem: string | null; free: number | null; read_only: boolean; usable: boolean; why: string | null }>;
  export: {
    export: string;
    /** "done" with result "PASS" means it's safe to unplug. "needs_erase" waits for the owner on their board's page. */
    state: string;
    message?: string;
    drive?: { title: string; bytes: number; kind: string };
    done_bytes?: number;
    total_bytes?: number;
    mbps?: number | null;
    eta_s?: number | null;
    result?: "PASS" | "FAIL" | null;
    problems?: string[];
    seconds?: number;
  } | null;
  simulated: boolean;
}

export type DriveExportReply = (
  | { ok: true; export: string; state: string }
  /** Show `approval.title` and every line on a card. Call again with `approval.id` only after the person confirms. */
  | { ok: false; code: "needs_confirmation"; approval: { id: string; title: string; lines: string[] }; stale?: boolean }
  /** Show `message`: a product never erases a drive, and the owner confirms that on their board's page. */
  | { ok: false; code: "needs_erase"; export: string; state: "needs_erase"; message: string }
) & { simulated: boolean };

/** The drive in the owner's board and how the export is going. The owner only. Read only: poll it every 10 seconds at most. */
export async function driveStatus(opts: WithRequest): Promise<DriveStatus> {
  return callBoard("drive_status", {}, opts.request);
}

/**
 * Puts this product's own tuned model on the drive plugged into the owner's board. The owner only, and the first call only asks:
 * it answers needs_confirmation. Send `approval` only from the person's own click on the card, never by yourself.
 */
export async function exportToDrive(opts: { approval?: string } & WithRequest): Promise<DriveExportReply> {
  return callBoard<DriveExportReply>("export_to_drive", { model: "own" }, opts.request, opts.approval);
}
