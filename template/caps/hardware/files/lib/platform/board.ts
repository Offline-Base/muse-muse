// Platform file (Muse Muse platform services). Don't edit: products wrap these helpers, never change them.
//
// A board connected to Muse Muse: read its sensors, or show a short line on it, through the gateway. Server only, from a
// route handler: pass the incoming request, so the owner's pass and the visitor's id travel with it. During the build the
// gateway answers with a simulated board. Live, a board reaches this product only after its owner links one, and only the
// owner until they open it to visitors. Anything else throws BoardError, and isBoardOffline(err) is true.
import { gatewayEnv, type RequestLike } from "@/lib/meta/client";
import { identityHeaders } from "@/lib/platform/identity";

export const SHOW_TEXT_MAX_CHARS = 200;

export class BoardError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BoardError";
  }
}

/** True when no board is there for this person right now: show a plain message, and keep the rest of the product working. */
export function isBoardOffline(err: unknown): boolean {
  return err instanceof BoardError && (err.code === "gadget_offline" || err.code === "gadget_unavailable");
}

type Content = { type: string; text?: string };

async function callBoard<T>(tool: string, args: Record<string, unknown>, request?: RequestLike | null): Promise<T & { simulated: boolean }> {
  const res = await fetch(gatewayEnv().baseURL.replace(/\/v1\/?$/, "/gadget"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gatewayEnv().apiKey}`, ...identityHeaders(request) },
    body: JSON.stringify({ tool, arguments: args }),
  });
  const body = (await res.json().catch(() => null)) as { content?: Content[]; isError?: boolean; simulated?: boolean; error?: { code?: string; message?: string } } | null;
  if (!res.ok || !body) throw new BoardError(body?.error?.message ?? `The board call failed (HTTP ${res.status}).`, body?.error?.code ?? "board_error", res.status);
  const text = body.content?.find((c) => c.type === "text")?.text ?? "";
  if (body.isError) throw new BoardError(text || "The board couldn't do that.", "board_tool_error", 200);
  try {
    return { ...(JSON.parse(text) as T), simulated: body.simulated === true };
  } catch {
    throw new BoardError("The board sent an answer this product can't read.", "board_tool_error", 200);
  }
}

export interface SensorReading {
  name: string;
  /** Like "temperature". */
  kind: string;
  value: number;
  /** Like "C". */
  unit: string;
}

/** Reads the board's sensors, or one by name. Read only. */
export async function readSensor(opts: { sensor?: string; request?: RequestLike | null } = {}): Promise<{ sensors: SensorReading[]; simulated: boolean }> {
  return callBoard("read_sensor", opts.sensor ? { sensor: opts.sensor } : {}, opts.request);
}

/** Shows one line on the board, up to 200 characters, 6 times a minute. */
export async function showText(text: string, opts: { request?: RequestLike | null } = {}): Promise<{ shown: string; simulated: boolean }> {
  return callBoard("show_text", { text }, opts.request);
}
