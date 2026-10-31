/**
 * The board's five drive tools (muse-device 0.4.0, docs/DRIVE_EXPORT.md). They are reached only through
 * /api/device/drive and /api/device/drive/erase: behind DRIVE_EXPORT_ENABLED, with requireAdmin (never AUTOMATION_SECRET),
 * and one log line a call. The generic admin route /api/device neither lists nor calls them, whatever the flag says
 * (docs/CAPABILITIES.md, section 1, item 6). No imports, so that route stays as light as it is.
 */
export const DRIVE_TOOLS: ReadonlySet<string> = new Set(["drive_status", "export_source", "export_model", "erase_drive", "stop_export"]);

/** Whether the generic /api/device route may list or call a board tool. */
export const genericDeviceTool = (name: string): boolean => !DRIVE_TOOLS.has(name);
