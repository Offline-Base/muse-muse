// Platform file (Muse Muse platform services). Don't edit: products wrap these helpers, never change them.
//
// What can go wrong with a board call, in words a person can read. No imports, so a page's code can use these too.

export class BoardError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BoardError";
  }
}

/** True when no board is there for this person right now: show a plain message, and keep the rest of the product working. */
export function isBoardOffline(err: unknown): boolean {
  return err instanceof BoardError && (err.code === "gadget_offline" || err.code === "gadget_unavailable");
}

/** A drive export's refusals are already in words a person can read, and each says what to do. */
const DRIVE_REFUSALS: ReadonlySet<string> = new Set(["no_drive", "several_drives", "export_busy", "own_model_not_found", "own_model_not_ready", "license_duties_missing", "drive_kit_missing", "device_refused", "plan_refused", "plan_too_large", "source_unavailable"]);

/**
 * The line to show for a failed board call, or null when it isn't a BoardError, which is a bug to let through. Covers every
 * way a board can say no: nobody linked one, too many calls, and a board with no such sensor or that couldn't do it.
 */
export function boardMessage(err: unknown): string | null {
  if (!(err instanceof BoardError)) return null;
  if (isBoardOffline(err)) return err.message.startsWith("Your board") ? err.message : "The board isn't available right now.";
  if (err.code === "gadget_no_model" || err.code === "robot_real_board_off" || err.code === "board_not_paired") return err.message;
  if (DRIVE_REFUSALS.has(err.code)) return err.message;
  if (err.code === "rate_limited") return "The board has had too many requests. Try again in a minute.";
  if (err.code === "board_tool_error") return "The board couldn't do that right now.";
  return "The board didn't answer. Try again.";
}
