/**
 * The rover's camera on the e-ink display (owner, Nov 3: "a second view when you scroll down that streams the webcam and SAM
 * 3.1 stuff from the rover"). A real video stream can't cross the fleet: SAM 3.1 answers one photo in 10 to 20 s through the
 * control plane's jobs API, behind ngrok's free plan. So this is a still that renews: a photo from the board server's
 * capture_image (DEVICE_MCP_URL, the rover's C920S), sent to SAM 3.1 on the SAM board (samLook, the same path products use,
 * holding the same one-look-at-a-time slot), and returned as one SVG: the outlined photo, or the plain photo, with a line
 * saying which and why. The route caches it on Vercel's CDN, so however many screens are open, the rover and the board see
 * about one look per ROVER_VIEW.cacheS. Made-up photos in tests only; the photo is never logged or stored here.
 */
import type { DeviceConfig, DeviceToolResult } from "@/lib/device/client";
import type { FleetSamSettings, Look } from "@/lib/caps/fleet/sam";

export const ROVER_VIEW = {
  /** How long the CDN keeps one frame. */
  cacheS: 180,
  /** SAM looks for this view a day, apart from products' own allowance. */
  perDay: 200,
  width: 640,
  height: 360,
  timeoutMs: 95_000,
  maxImageB64: 400_000,
} as const;

/** What SAM looks for: letters, digits, spaces and . , ' - only, as the board's ask.py takes. */
export const ROVER_PROMPT_OK = /^[\p{L}\p{N} .,'-]{1,60}$/u;

export interface RoverDeps {
  camera(): DeviceConfig | null;
  sam(): FleetSamSettings | null;
  capture(config: DeviceConfig, args: Record<string, unknown>): Promise<DeviceToolResult>;
  look(settings: FleetSamSettings, look: Look, signal: AbortSignal): Promise<Record<string, unknown>>;
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  acquireInFlight(key: string, limit: number, now: Date): Promise<Date | null>;
  releaseInFlight(key: string, bucket: Date): Promise<void>;
  now?(): Date;
}

export interface RoverFrame {
  /** JPEG in base64: SAM's outlined picture when it answered, else the plain photo. Null with no photo at all. */
  jpegB64: string | null;
  outlined: boolean;
  count: number | null;
  seconds: number | null;
  note: string;
}

const isJpeg = (b64: unknown): b64 is string => typeof b64 === "string" && b64.startsWith("/9j/") && b64.length <= ROVER_VIEW.maxImageB64 && /^[A-Za-z0-9+/]+={0,2}$/.test(b64);

/** A photo from the rover's camera, outlined by SAM 3.1 when the board can look. Never throws. */
export async function roverFrame(deps: RoverDeps, prompt: string): Promise<RoverFrame> {
  const none = (note: string): RoverFrame => ({ jpegB64: null, outlined: false, count: null, seconds: null, note });
  const camera = deps.camera();
  if (!camera) return none("No rover camera is connected.");
  let photo: string;
  try {
    const result = await deps.capture(camera, { width: ROVER_VIEW.width, height: ROVER_VIEW.height });
    const image = result.content.find((c): c is { type: "image"; data: string } => (c as { type?: unknown })?.type === "image");
    if (result.isError || !image || !isJpeg(image.data)) {
      // The board's own words help here ("no camera found"); kept short and plain, never an address or a token.
      const said = result.content.map((c) => (c as { type?: unknown; text?: unknown })).find((c) => c.type === "text" && typeof c.text === "string")?.text as string | undefined;
      const plainWords = said?.replace(/https?:\S+|\b(jpt|jik|sk)_\S+/g, "").replace(/[^\p{L}\p{N} .,:'()/-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 90);
      return none(`The rover's camera didn't send a photo${plainWords ? `: ${plainWords}` : "."}`);
    }
    photo = image.data;
  } catch {
    return none("The rover didn't answer.");
  }
  const plain = (note: string): RoverFrame => ({ jpegB64: photo, outlined: false, count: null, seconds: null, note });
  const settings = deps.sam();
  if (!settings) return plain("Camera only: SAM 3.1 isn't connected.");
  if (!ROVER_PROMPT_OK.test(prompt)) return plain("Camera only: the SAM prompt isn't usable.");
  const now = deps.now?.() ?? new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const counts = await deps.hitRateLimits(["fleetsam:rover"], day).catch(() => null);
  if (!counts) return plain("Camera only: SAM 3.1 couldn't be scheduled.");
  if ((counts["fleetsam:rover"] ?? 0) > ROVER_VIEW.perDay) return plain("Camera only: SAM 3.1 has done today's looks.");
  const slot = await deps.acquireInFlight("fleetsam:flight:all", 1, now).catch(() => null);
  if (!slot) return plain("Camera only: SAM 3.1 is busy with another look.");
  const started = Date.now();
  try {
    const reply = await deps.look(settings, { b64: photo, prompt, threshold: 0.5, overlay: true }, AbortSignal.timeout(ROVER_VIEW.timeoutMs));
    const count = typeof reply.count === "number" ? reply.count : null;
    const seconds = Math.round((Date.now() - started) / 1000);
    if (!isJpeg(reply.overlay_jpeg_b64)) return { ...plain("Camera only: SAM 3.1 sent no picture."), count, seconds };
    return { jpegB64: reply.overlay_jpeg_b64, outlined: true, count, seconds, note: "" };
  } catch {
    return plain("Camera only: SAM 3.1 didn't answer in time.");
  } finally {
    await deps.releaseInFlight("fleetsam:flight:all", slot).catch(() => undefined);
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** One SVG for an <img>: the picture and, under it, what it shows. */
export function roverSvg(frame: RoverFrame, prompt: string, at: Date, timeZone = "America/New_York"): string {
  const W = ROVER_VIEW.width;
  const H = ROVER_VIEW.height;
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const what = !frame.jpegB64 ? "" : frame.outlined
    ? `${frame.count === null ? "" : `${frame.count} “${prompt}” `}outlined by Meta SAM 3.1 on a Jetson${frame.seconds === null ? "" : ` in ${frame.seconds} s`}`
    : frame.note;
  const picture = frame.jpegB64
    ? `<image href="data:image/jpeg;base64,${frame.jpegB64}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet"/>`
    : `<rect x="0" y="0" width="${W}" height="${H}" fill="#f3f4f5"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="22" fill="#111112">${esc(frame.note)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H + 44}" width="${W}" height="${H + 44}" font-family="Inter, system-ui, -apple-system, Helvetica, Arial, sans-serif">
<rect width="100%" height="100%" fill="#ffffff"/>${picture}
<text x="0" y="${H + 30}" font-size="18" fill="#111112">${esc(what)}</text><text x="${W}" y="${H + 30}" font-size="18" fill="rgba(0,4,9,.59)" text-anchor="end">${frame.jpegB64 ? "Photo" : "Checked"} at ${esc(time)}</text>
</svg>`;
}
