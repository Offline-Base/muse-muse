import { callRoverTool, roverBoard } from "@/lib/device/rover";
import { roverAdmin, roverFailure, roverOff } from "@/lib/device/rover-http";
import { rangesOf, roverCall, ROVER_TOOLS, type RoverDriveReply, type RoverRanges } from "@/lib/device/rover-tools";
import { env } from "@/lib/env";
import { readJson, route } from "@/lib/http";

// A photo from the webcam takes a few seconds, and a drive from the pad returns once the rover has it.
export const maxDuration = 60;

const MAX_TEXT_CHARS = 2000;

type Part = { type?: string; text?: string; data?: string; mimeType?: string };

/** The ranges in a ranges reply, or in a status reply's own ranges. Nothing else carries them. */
function rangesIn(tool: string, texts: string[]): RoverRanges | null {
  if (tool !== ROVER_TOOLS.ranges && tool !== ROVER_TOOLS.status) return null;
  try {
    const value = JSON.parse(texts[0] ?? "") as Record<string, unknown> | null;
    return rangesOf(tool === ROVER_TOOLS.status ? value?.ranges : value);
  } catch {
    return null;
  }
}

/**
 * POST {action: "drive", direction, ms?, speed?} | {action: "stop"} | {action: "look", pan?, tilt?} | {action: "ranges"} |
 * {action: "status"} | {action: "photo"} -> {ok, text, image, ranges}: one of the rover's tools, through the fleet's device
 * route with the board's token, which never leaves the server. Within the limits in lib/device/rover-tools.ts, and the
 * rover's own on top. Behind ROVER_ENABLED (404 otherwise), signed-in admins only. 400 invalid_input, 503
 * fleet_not_configured, 502 rover_unavailable, with a message when the rover isn't set up yet or its token can't be read.
 */
export const POST = route(async (req: Request) => {
  if (!env.roverEnabled) return roverOff();
  await roverAdmin(req);
  const body = await readJson(req, 4096);
  try {
    const { tool, args } = roverCall(body);
    const result = await callRoverTool(roverBoard(), tool, args);
    const parts = result.content as Part[];
    const texts = parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text!);
    const image = parts.find((part) => part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string" && part.mimeType.startsWith("image/"));
    const reply: RoverDriveReply = {
      ok: !result.isError,
      text: texts.length ? texts.join("\n").slice(0, MAX_TEXT_CHARS) : null,
      image: image ? { mimeType: image.mimeType!, data: image.data! } : null,
      ranges: result.isError ? null : rangesIn(tool, texts),
    };
    return Response.json(reply);
  } catch (err) {
    return roverFailure(err, "device/rover/drive");
  }
});
