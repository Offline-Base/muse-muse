/**
 * The hardware unit's switches (docs/CAPABILITIES.md, section 19), read straight from process.env, so lib/env.ts and the
 * cap's prompt text can both read them without an import cycle. lib/env.ts's getters call these. HARDWARE_ENABLED, the
 * cap's own flag, is read through env.enabledCaps.
 */
const on = (name: string) => ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());

/** HARDWARE_BOARD_TOOLS: read_sensor and show_text. */
export const boardToolsOn = (): boolean => on("HARDWARE_BOARD_TOOLS");
/** HARDWARE_BOARD_REGISTRY: /api/boards, linking a board to a product, and the board list on /gadgets and /device. */
export const boardRegistryOn = (): boolean => on("HARDWARE_BOARD_REGISTRY");
/** HARDWARE_GADGET_OWNER_CHECK: a live token reaches only the board its product's owner linked. */
export const gadgetOwnerCheckOn = (): boolean => on("HARDWARE_GADGET_OWNER_CHECK");
