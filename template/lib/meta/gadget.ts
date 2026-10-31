import { clientIpHeaders, gatewayEnv, type RequestLike } from "@/lib/meta/client";
import { toDataUrl } from "@/lib/meta/media";

/**
 * A physical board's camera and microphone, through the Muse Muse gateway ({GATEWAY_URL}/gadget). Server only. Use
 * it only when the brief lists muse-gadget, or the gateway answers 403 gadget_not_allowed.
 *
 * During the build the gateway answers with a simulated board: takePhoto returns the same photo of a receipt and
 * recordSound three seconds of someone saying "Hi, this is a short test recording", every time, so tests are steady.
 * Live, it reaches the board connected to Muse Muse, or throws GadgetError with code "gadget_offline" when none is.
 */

export class GadgetError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GadgetError";
  }
}

/** True when the board isn't there right now: show how to connect one, and offer an upload instead. */
export function isGadgetOffline(err: unknown): boolean {
  return err instanceof GadgetError && (err.code === "gadget_offline" || err.code === "gadget_unavailable");
}

type Content = { type: string; text?: string; data?: string; mimeType?: string };

interface GadgetReply {
  content: Content[];
  isError: boolean;
  simulated: boolean;
}

function gadgetUrl(): string {
  // gatewayEnv() checks GATEWAY_URL and PRODUCT_TOKEN, and its baseURL ends in /v1.
  return gatewayEnv().baseURL.replace(/\/v1\/?$/, "/gadget");
}

async function callGadget(tool: string, args: Record<string, unknown>, request?: RequestLike | null): Promise<GadgetReply> {
  const res = await fetch(gadgetUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gatewayEnv().apiKey}`, ...clientIpHeaders(request) },
    body: JSON.stringify({ tool, arguments: args }),
  });
  const body = (await res.json().catch(() => null)) as (GadgetReply & { error?: { code?: string; message?: string } }) | null;
  if (!res.ok || !body) {
    throw new GadgetError(body?.error?.message ?? `The gadget call failed (HTTP ${res.status}).`, body?.error?.code ?? "gadget_error", res.status);
  }
  if (body.isError) {
    const text = body.content.find((c) => c.type === "text")?.text ?? "The gadget couldn't do that.";
    throw new GadgetError(text, "gadget_tool_error", 200);
  }
  return body;
}

export interface GadgetPhoto {
  /** A data URL, ready for imagePart() or an <img>. */
  dataUrl: string;
  /** True during the build, when the photo is the simulated board's sample. */
  simulated: boolean;
}

/** Takes one photo with the board's camera (about 2 seconds). */
export async function takePhoto(opts: { width?: number; height?: number; request?: RequestLike | null } = {}): Promise<GadgetPhoto> {
  const args: Record<string, unknown> = {};
  if (opts.width) args.width = opts.width;
  if (opts.height) args.height = opts.height;
  const reply = await callGadget("capture_image", args, opts.request);
  const image = reply.content.find((c) => c.type === "image" && c.data);
  if (!image?.data) throw new GadgetError("The gadget didn't send a photo.", "gadget_tool_error", 200);
  return { dataUrl: `data:${image.mimeType ?? "image/jpeg"};base64,${image.data}`, simulated: reply.simulated };
}

export interface GadgetSound {
  /** 16 kHz mono 16-bit WAV, ready for transcribeFile({ bytes }). */
  wav: Uint8Array;
  dataUrl: string;
  simulated: boolean;
}

/** Records from the board's microphone, 1 to 30 seconds (3 by default). */
export async function recordSound(opts: { seconds?: number; request?: RequestLike | null } = {}): Promise<GadgetSound> {
  const seconds = Math.min(30, Math.max(1, Math.round(opts.seconds ?? 3)));
  const reply = await callGadget("record_audio", { seconds }, opts.request);
  const audio = reply.content.find((c) => c.type === "audio" && c.data);
  if (!audio?.data) throw new GadgetError("The gadget didn't send a recording.", "gadget_tool_error", 200);
  const wav = Uint8Array.from(Buffer.from(audio.data, "base64"));
  return { wav, dataUrl: toDataUrl(wav, "audio/wav"), simulated: reply.simulated };
}

/** What the board has: its cameras and microphones. */
export async function gadgetInfo(request?: RequestLike | null): Promise<{ info: Record<string, unknown>; simulated: boolean }> {
  const reply = await callGadget("describe_device", {}, request);
  const text = reply.content.find((c) => c.type === "text")?.text ?? "{}";
  let info: Record<string, unknown> = {};
  try {
    info = JSON.parse(text) as Record<string, unknown>;
  } catch {
    info = { description: text };
  }
  return { info, simulated: reply.simulated };
}
