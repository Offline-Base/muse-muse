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

/** How long a board's model has to answer. A one-bit Muse Glimmer on a Jetson is slow; the route's limit is above this. */
export const BOARD_ANSWER_MS = 100_000;
/** Pairing: how long the check number stays good, and tries a person gets per hour. */
export const PAIR_TICKET_MS = 10 * 60_000;
export const PAIR_TRIES_PER_HOUR = 20;
export const ASK_BOARD_MAX_MESSAGES = 32;
export const ASK_BOARD_MAX_CHARS = 24_000;
export const ASK_BOARD_MAX_TOKENS = 512;

/** The tools HARDWARE_BOARD_TOOLS adds, with no import, so lib/device/drive-tools.ts stays as light as it is. */
export const BOARD_TOOLS = ["read_sensor", "show_text"] as const;
export type BoardTool = (typeof BOARD_TOOLS)[number];

/**
 * What GADGET_CONNECT adds for a product with board tools: the model on its owner's board, and a simulated board's robot.
 * robot_action never moves anything by itself: the owner confirms each one. Never a shell.
 */
export const CONNECT_TOOLS = ["ask_board", "robot_status", "robot_action", "hard_stop"] as const;
export type ConnectTool = (typeof CONNECT_TOOLS)[number];

/**
 * The two drive tools a product may call (docs/DRIVE_EXPORT.md, "From a product"), kept apart from PRODUCT_GADGET_TOOLS and
 * BOARD_TOOLS. The owner's only, and only with DRIVE_EXPORT_PRODUCTS and the owner check. drive_status here is an answer the
 * platform trims, and export_to_drive isn't a board tool at all: it becomes the board's export_model, on a plan the platform builds.
 */
export const PRODUCT_DRIVE_TOOLS = ["drive_status", "export_to_drive"] as const;
export type ProductDriveTool = (typeof PRODUCT_DRIVE_TOOLS)[number];

/** In a token's allowedModels: the brief asked to put its own model on a drive. Its own marker, like BOARD_TOOLS_MARKER. */
export const DRIVE_TOOLS_MARKER = "drive-tools";

/**
 * In a token's allowedModels: the brief asked for board tools. Its own marker, so a product that wants a sensor doesn't get the
 * board's camera and microphone (those need muse-gadget), and a browser-links product (cap:hardware alone) gets neither.
 */
export const BOARD_TOOLS_MARKER = "board-tools";

/** A count for /caps/proof: a rate_limits row per moment, so a verify's `since` counts exactly what happened after it. */
export const hardwareProofKey = (tool: BoardTool | ProductDriveTool, buildId: string) => `hardware-proof:${tool}:${buildId}`;
