// Checks every parameter a page sends before any native code sees it. Pages are untrusted input.

import type { BridgeMethod, HapticKind } from "./protocol";

export type ParamCheck = { ok: true; params: unknown } | { ok: false; message: string };

const HAPTIC_KINDS: readonly HapticKind[] = ["light", "medium", "heavy", "selection", "success", "warning", "error"];

const ok = (params: unknown): ParamCheck => ({ ok: true, params });
const bad = (message: string): ParamCheck => ({ ok: false, message });

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function optionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max) return null;
  return value;
}

function optionalNumber(value: unknown, min: number, max: number): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

/** Only web links can go into a share sheet, so a page can't hand out app or file links. */
export function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Returns a clean copy with only the known fields, or the reason it was refused. */
export function validateParams(method: BridgeMethod, raw: unknown): ParamCheck {
  const params = asRecord(raw);
  if (!params) return bad("Options must be an object.");

  switch (method) {
    case "hello":
    case "glasses.status":
    case "glasses.connect":
    case "glasses.stopRecording":
      return ok({});

    case "haptic": {
      const kind = params.kind ?? "light";
      if (!HAPTIC_KINDS.includes(kind as HapticKind)) return bad("That haptic kind isn't known.");
      return ok({ kind });
    }

    case "share": {
      const title = optionalText(params.title, 200);
      const text = optionalText(params.text, 2_000);
      const url = optionalText(params.url, 2_000);
      if (title === null || text === null || url === null) return bad("Share text is too long.");
      if (!title && !text && !url) return bad("Share needs a title, text or a link.");
      if (url && !isWebUrl(url)) return bad("Share links must start with http or https.");
      return ok({ title, text, url });
    }

    case "takePhoto": {
      const source = params.source ?? "camera";
      if (source !== "camera" && source !== "library") return bad("Photo source must be camera or library.");
      const maxSize = optionalNumber(params.maxSize, 64, 4_096);
      if (maxSize === null) return bad("maxSize must be between 64 and 4096.");
      return ok({ source, maxSize: maxSize ?? 1_600 });
    }

    case "notify": {
      if (typeof params.title !== "string" || !params.title || params.title.length > 120) {
        return bad("A notification needs a title of 120 characters or fewer.");
      }
      const body = optionalText(params.body, 500);
      if (body === null) return bad("Notification text is too long.");
      const delaySeconds = optionalNumber(params.delaySeconds, 0, 86_400);
      if (delaySeconds === null) return bad("delaySeconds must be between 0 and 86400.");
      return ok({ title: params.title, body, delaySeconds: delaySeconds ?? 0 });
    }

    case "glasses.capturePhoto": {
      const maxSize = optionalNumber(params.maxSize, 64, 1_600);
      if (maxSize === null) return bad("maxSize must be between 64 and 1600.");
      return ok({ maxSize: maxSize ?? 1_600 });
    }

    case "glasses.preview":
      if (typeof params.show !== "boolean") return bad("preview needs show to be true or false.");
      return ok({ show: params.show });

    case "glasses.startRecording": {
      const maxSeconds = optionalNumber(params.maxSeconds, 1, 60);
      if (maxSeconds === undefined || maxSeconds === null) return bad("maxSeconds must be between 1 and 60.");
      return ok({ maxSeconds });
    }

    case "glasses.speak": {
      if (typeof params.text !== "string" || !params.text || params.text.length > 1_000) {
        return bad("speak needs text of 1000 characters or fewer.");
      }
      return ok({ text: params.text });
    }

    // Internal to the lab variant. Their handlers exist only in selftest and autopilot runs, and the fields are
    // cleaned where they are used.
    case "selftest.report":
    case "autopilot.checkpoint":
      return ok(params);
  }
}
