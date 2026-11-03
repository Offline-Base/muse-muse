/**
 * The rover's tools, as Muse Muse names them and as the rover's muse-device server does (muse-device/server.py, ROVER_TOOLS,
 * and capture_image for its photos), and the most one call may ask for. Wonder sees the rover_ names, so the rover's camera
 * can't be taken for a board's capture_image. No imports, so Wonder's tool loop and the drive pad in the browser read the same
 * limits as the routes. The server holds a drive to 3000 ms and a wheel to 255 too, and the sketch stops by itself for
 * anything close in front.
 */
export const ROVER_TOOLS = {
  drive: "rover_drive",
  stop: "rover_stop",
  look: "rover_look",
  ranges: "rover_ranges",
  photo: "rover_photo",
  status: "rover_status",
} as const;

export type RoverAction = keyof typeof ROVER_TOOLS;

/** The tool each one calls on the rover's own server. */
export const BOARD_TOOL_OF: Readonly<Record<string, string>> = {
  rover_drive: "drive",
  rover_stop: "stop",
  rover_look: "look",
  rover_ranges: "ranges",
  rover_photo: "capture_image",
  rover_status: "rover_status",
};

export const ROVER_TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(ROVER_TOOLS));

export const DRIVE_DIRECTIONS = ["forward", "back", "left", "right"] as const;
export type DriveDirection = (typeof DRIVE_DIRECTIONS)[number];

/** One drive from the pad moves for at most this long, and the rover stops when it's up: holding the pad sends one after another. */
export const DRIVE_MS = { min: 50, max: 2000, default: 400 };
/** Percent of a wheel's full speed, which the rover's server takes as 255. */
export const DRIVE_SPEED = { min: 1, max: 100, default: 60 };
/** Degrees from straight ahead. The mount may reach less, and the rover holds each to what it reaches. */
export const LOOK_DEGREES = { min: -90, max: 90 };
/** What Wonder may ask of one drive by itself: a short one, at most this fast. The pad goes further. */
export const WONDER_DRIVE = { ms: 1000, wheel: 160, defaultMs: 500 };
const FULL_WHEEL = 255;
/** The pad's photo: smaller than the server's default, so it comes back through the tunnel sooner. */
const PAD_PHOTO = { width: 640, height: 480 };

export type RangeSide = "front" | "left" | "right";

/** What the rover's three distance sensors read, in millimetres. Null for one that read nothing; `clear` says which saw nothing in reach. */
export interface RoverRanges {
  front: number | null;
  left: number | null;
  right: number | null;
  clear: RangeSide[];
}

/** What /api/device/rover/drive answers for one call. */
export interface RoverDriveReply {
  ok: boolean;
  /** What the rover said, such as why it didn't move. */
  text: string | null;
  image: { mimeType: string; data: string } | null;
  ranges: RoverRanges | null;
}

/** A tool call refused before it reaches the rover. The message says why, for a person or a model. */
export class RoverInputError extends Error {}

function whole(value: unknown, field: string, { min, max }: { min: number; max: number }, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new RoverInputError(`${field} is needed.`);
  }
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new RoverInputError(`${field} must be a whole number from ${min} to ${max}.`);
  }
  return value as number;
}

function lookArgs(input: Record<string, unknown>): Record<string, unknown> {
  if (input.pan === undefined && input.tilt === undefined) throw new RoverInputError("Give pan, tilt or both.");
  const args: Record<string, unknown> = {};
  if (input.pan !== undefined) args.pan = whole(input.pan, "pan", LOOK_DEGREES);
  if (input.tilt !== undefined) args.tilt = whole(input.tilt, "tilt", LOOK_DEGREES);
  return args;
}

/**
 * The tool and arguments for one request from the drive pad. A direction becomes both wheels' speeds: forward and back on
 * both, left and right as a turn on the spot. The pad doesn't wait for a drive to end, so holding a direction sends the next
 * before this one runs out. Throws RoverInputError for anything past the limits.
 */
export function roverCall(input: Record<string, unknown>): { tool: string; args: Record<string, unknown> } {
  const action = input.action;
  if (typeof action !== "string" || !Object.hasOwn(ROVER_TOOLS, action)) {
    throw new RoverInputError(`action must be one of ${Object.keys(ROVER_TOOLS).join(", ")}.`);
  }
  const tool = ROVER_TOOLS[action as RoverAction];
  if (action === "drive") {
    if (!DRIVE_DIRECTIONS.includes(input.direction as DriveDirection)) {
      throw new RoverInputError(`direction must be one of ${DRIVE_DIRECTIONS.join(", ")}.`);
    }
    const ms = whole(input.ms, "ms", DRIVE_MS, DRIVE_MS.default);
    const wheel = Math.round((whole(input.speed, "speed", DRIVE_SPEED, DRIVE_SPEED.default) * FULL_WHEEL) / 100);
    const [left, right] = { forward: [wheel, wheel], back: [-wheel, -wheel], left: [-wheel, wheel], right: [wheel, -wheel] }[input.direction as DriveDirection];
    return { tool, args: { left, right, ms, wait: false } };
  }
  if (action === "look") return { tool, args: lookArgs(input) };
  if (action === "photo") return { tool, args: { ...PAD_PHOTO } };
  return { tool, args: {} };
}

/**
 * A drive Wonder asked for, in the server's own terms, held to WONDER_DRIVE. It always waits for the drive to end, so the
 * model hears why the rover stopped before it asks for another. Throws RoverInputError past the limits.
 */
export function wonderDrive(args: Record<string, unknown>): Record<string, unknown> {
  const wheel = { min: -WONDER_DRIVE.wheel, max: WONDER_DRIVE.wheel };
  try {
    return {
      left: whole(args.left, "left", wheel),
      right: whole(args.right, "right", wheel),
      ms: whole(args.ms, "ms", { min: 0, max: WONDER_DRIVE.ms }, WONDER_DRIVE.defaultMs),
      wait: true,
    };
  } catch (err) {
    if (err instanceof RoverInputError) throw new RoverInputError(`${err.message} Tell the user the rover's drive pad on /device goes further.`);
    throw err;
  }
}

/** A look Wonder asked for, checked the same way as the pad's. */
export const wonderLook = (args: Record<string, unknown>): Record<string, unknown> => lookArgs(args);

const MAX_RANGE_MM = 10_000;
const SIDES: RangeSide[] = ["front", "left", "right"];

function millimetres(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_RANGE_MM ? Math.round(value) : null;
}

/**
 * The three ranges from what the rover wrote: front_mm, left_mm and right_mm with its sensors' states, as the server's ranges
 * tool gives them. Only those names, since a drive's reply has left and right too, as wheel speeds. Null when there are none.
 */
export function rangesOf(value: unknown): RoverRanges | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const sensors = v.sensors && typeof v.sensors === "object" && !Array.isArray(v.sensors) ? (v.sensors as Record<string, unknown>) : {};
  const ranges: RoverRanges = {
    front: millimetres(v.front_mm),
    left: millimetres(v.left_mm),
    right: millimetres(v.right_mm),
    clear: SIDES.filter((side) => sensors[side] === "clear"),
  };
  const seen = SIDES.some((side) => ranges[side] !== null || sensors[side] !== undefined);
  return seen ? ranges : null;
}
