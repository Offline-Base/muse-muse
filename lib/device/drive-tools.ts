import { boardToolsOn } from "@/lib/caps/hardware/flags";
import { BOARD_TOOLS } from "@/lib/caps/hardware/limits";

/**
 * The board's five drive tools (muse-device 0.4.0, docs/DRIVE_EXPORT.md). They are reached only through
 * /api/device/drive and /api/device/drive/erase: behind DRIVE_EXPORT_ENABLED, with requireAdmin (never AUTOMATION_SECRET),
 * and one log line a call. The generic admin route /api/device neither lists nor calls them, whatever the flag says
 * (docs/CAPABILITIES.md, section 1, item 6). Its only imports have none of their own, so that route stays as light as it is.
 */
export const DRIVE_TOOLS: ReadonlySet<string> = new Set(["drive_status", "export_source", "export_model", "erase_drive", "stop_export"]);

/** Wave 3, unit 13: muse-device 0.5.0's two tools for products. Admins' routes filter them too until HARDWARE_BOARD_TOOLS (section 1, item 6). */
export const BOARD_TOOL_NAMES: ReadonlySet<string> = new Set<string>(BOARD_TOOLS);

/** Whether the generic /api/device route may list or call a board tool. */
export const genericDeviceTool = (name: string): boolean => !DRIVE_TOOLS.has(name) && (!BOARD_TOOL_NAMES.has(name) || boardToolsOn());
