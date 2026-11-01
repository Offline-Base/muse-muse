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

async function send(tool: string, args: Record<string, unknown>, request: RequestLike | null): Promise<Reply> {
  const res = await fetch(gatewayEnv().baseURL.replace(/\/v1\/?$/, "/gadget"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gatewayEnv().apiKey}`, ...identityHeaders(request) },
    body: JSON.stringify({ tool, arguments: args }),
  });
  const body = (await res.json().catch(() => null)) as Reply | null;
  if (!res.ok || !body) throw new BoardError(body?.error?.message ?? `The board call failed (HTTP ${res.status}).`, body?.error?.code ?? "board_error", res.status);
  if (body.isError) throw new BoardError(body.content?.find((c) => c.type === "text")?.text || "The board couldn't do that.", "board_tool_error", 200);
  return body;
}

async function callBoard<T>(tool: string, args: Record<string, unknown>, request: RequestLike | null): Promise<T & { simulated: boolean }> {
  const body = await send(tool, args, request);
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
