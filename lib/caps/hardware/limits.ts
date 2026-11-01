/** The hardware unit's limits (docs/CAPABILITIES.md, section 19). muse-device/server.py keeps the same numbers for itself. */
export const SHOW_TEXT_MAX_CHARS = 200;
export const SHOW_TEXT_PER_MINUTE = 6;
export const SENSOR_NAME_MAX_CHARS = 64;

export const BOARD_NAME_MAX_CHARS = 60;
/** muse-device's own minimum (MIN_TOKEN_CHARS in server.py). */
export const BOARD_TOKEN_MIN_CHARS = 32;
export const BOARD_TOKEN_MAX_CHARS = 512;
export const BOARD_URL_MAX_CHARS = 2048;
/** A person's registered boards, removed ones not counted. */
export const BOARDS_PER_OWNER = 20;
/** How long a new board has to answer describe_device. */
export const BOARD_CHECK_MS = 15_000;

/** The tools HARDWARE_BOARD_TOOLS adds, with no import, so lib/device/drive-tools.ts stays as light as it is. */
export const BOARD_TOOLS = ["read_sensor", "show_text"] as const;
export type BoardTool = (typeof BOARD_TOOLS)[number];

/**
 * In a token's allowedModels: the brief asked for board tools. Its own marker, so a product that wants a sensor doesn't get the
 * board's camera and microphone (those need muse-gadget), and a browser-links product (cap:hardware alone) gets neither.
 */
export const BOARD_TOOLS_MARKER = "board-tools";

/** A count for /caps/proof: a rate_limits row per moment, so a verify's `since` counts exactly what happened after it. */
export const hardwareProofKey = (tool: BoardTool, buildId: string) => `hardware-proof:${tool}:${buildId}`;
