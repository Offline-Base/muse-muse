import { requireAdmin } from "@/lib/auth";
import { callDeviceTool, deviceConfig } from "@/lib/device/client";
import { eraseDrive } from "@/lib/device/drive";
import { DeviceRefusedError } from "@/lib/device/train";
import { env } from "@/lib/env";
import { badRequest, errorJson, HttpError, readJson, route } from "@/lib/http";

/**
 * POST {drive, identity, confirm} -> {erasing: true}: erases the drive an export waits on in needs_erase, as exFAT, after
 * the admin typed its label (or ERASE when it has none) on the card. The board checks the word and the drive's identity
 * again, and once more just before the format, so a drive swapped in the meantime is never erased. A product can never
 * reach this. Admins only. 404 with DRIVE_EXPORT_ENABLED off, 400 bad input, 409 device_refused with the board's sentence,
 * 503 device_not_configured, 502 device_unavailable.
 */
export const POST = route(async (req: Request) => {
  if (!env.driveExportEnabled) return errorJson(404, "not_found");
  const admin = await requireAdmin();
  const config = deviceConfig();
  if (!config) return errorJson(503, "device_not_configured");
  const body = await readJson(req, 4 * 1024);
  if (typeof body.drive !== "string" || !/^[a-z][a-z0-9]{1,15}$/.test(body.drive)) throw badRequest("drive must be a drive's name from the list.");
  if (typeof body.identity !== "string" || !/^[0-9a-f]{16}$/.test(body.identity)) throw badRequest("identity must be the drive's identity from the list.");
  if (typeof body.confirm !== "string" || !body.confirm.trim() || body.confirm.length > 64) throw badRequest("Type the drive's name to erase it.");
  try {
    console.info(`[device/drive] admin ${admin.id} erase_drive`);
    await eraseDrive(config, { drive: body.drive, identity: body.identity, confirm: body.confirm.trim() }, callDeviceTool);
    return Response.json({ erasing: true });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof DeviceRefusedError) return errorJson(409, "device_refused", { message: err.message });
    // No link and no token in the log: the error's own text can carry the board's address.
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error("[device/drive] erase", reason.split(config.token).join("[token]").replace(/https?:\/\/[^\s"'<>]+/g, "[URL]").slice(0, 300));
    return errorJson(502, "device_unavailable");
  }
});
