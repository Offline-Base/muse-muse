/**
 * The hardware unit's switches (docs/CAPABILITIES.md, section 19), read straight from process.env, so lib/env.ts and the
 * cap's prompt text can both read them without an import cycle. lib/env.ts's getters call these. HARDWARE_ENABLED, the
 * cap's own flag, is read through env.enabledCaps.
 */
const on = (name: string) => ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());

/** HARDWARE_BOARD_TOOLS: read_sensor and show_text. */
export const boardToolsOn = (): boolean => on("HARDWARE_BOARD_TOOLS");
/**
 * Whether a product may be built with board tools or told about them. They need the owner check too: without it there's no
 * linked board for them to reach, and the writer would promise something the gateway refuses. Fails closed.
 */
export const boardToolsUsable = (): boolean => boardToolsOn() && gadgetOwnerCheckOn();
/**
 * DRIVE_EXPORT_PRODUCTS with the owner check: drive_status and export_to_drive, built, told about and served. Without the owner
 * check there's no verified owner on a linked board, so they stay off for builds as well. Fails closed.
 */
export const driveToolsUsable = (): boolean => on("DRIVE_EXPORT_PRODUCTS") && gadgetOwnerCheckOn();
/**
 * GADGET_CONNECT (docs/GADGETS.md): a signed-in person pairs their own board, its products run the model on it, and a simulated
 * board takes confirmed robot actions. Needs the owner check to reach anything, and HARDWARE_BOARD_KEY to save a board.
 */
export const gadgetConnectOn = (): boolean => on("GADGET_CONNECT");
/** What a product may be built with and served: pairing means nothing unless the gateway checks who owns the board. Fails closed. */
export const gadgetConnectUsable = (): boolean => gadgetConnectOn() && gadgetOwnerCheckOn() && boardToolsOn();
/** HARDWARE_BOARD_REGISTRY: /api/boards, linking a board to a product, and the board list on /gadgets and /device. GADGET_CONNECT needs them too. */
export const boardRegistryOn = (): boolean => on("HARDWARE_BOARD_REGISTRY") || gadgetConnectOn();
/** HARDWARE_GADGET_OWNER_CHECK: a live token reaches only the board its product's owner linked. */
export const gadgetOwnerCheckOn = (): boolean => on("HARDWARE_GADGET_OWNER_CHECK");
