import { randomUUID } from "node:crypto";
import { boardFetch, boardKeyring, boardTokenAad, boardUrlAad, checkBoardAddress, type AddressVerdict } from "@/lib/caps/hardware/board";
import { BOARD_CHECK_MS, BOARD_NAME_MAX_CHARS, BOARD_TOKEN_MAX_CHARS, BOARD_TOKEN_MIN_CHARS, BOARDS_PER_OWNER } from "@/lib/caps/hardware/limits";
import { countBoards, insertBoard, type NewBoardRow } from "@/lib/caps/hardware/store";
import { callDeviceTool, type DeviceConfig, type DeviceToolResult } from "@/lib/device/client";
import { sealSecret, type BoxKeyring } from "@/lib/secrets/box";

/**
 * Registering a muse-device board (docs/CAPABILITIES.md, section 19, decision 16: admins only). The route checks who is
 * asking. This checks the board: the address may carry a token, it answers describe_device the way muse-device does, and only
 * then is anything stored, sealed. These are muse-device board tokens. The registry never takes a Gadget SDK token, and
 * nothing here calls a tool beyond describe_device.
 */

export type RegisterRefusal = "invalid_name" | "invalid_token" | "unsafe_address" | "board_unreachable" | "not_a_board" | "too_many_boards" | "key_missing";

export type RegisterResult = { ok: true; id: string } | { ok: false; error: RegisterRefusal };

export interface RegisterDeps {
  ring(): BoxKeyring | null;
  check(url: string): Promise<AddressVerdict>;
  describe(config: DeviceConfig): Promise<DeviceToolResult>;
  count(ownerUserId: string): Promise<number>;
  insert(row: NewBoardRow): Promise<void>;
  now?(): Date;
}

const timedFetch: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(BOARD_CHECK_MS);
  return boardFetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
};

const defaultDeps: RegisterDeps = {
  ring: boardKeyring,
  check: (url) => checkBoardAddress(url),
  describe: (config) => callDeviceTool(config, "describe_device", {}, timedFetch),
  count: countBoards,
  insert: insertBoard,
};

/** A board's describe_device always lists cameras and microphones (muse-device/server.py), whatever is attached. */
export function looksLikeMuseDevice(result: DeviceToolResult): boolean {
  if (result.isError) return false;
  const text = (result.content as Array<{ type?: string; text?: string }>).find((c) => c.type === "text")?.text;
  try {
    const info = JSON.parse(text ?? "") as { cameras?: unknown; microphones?: unknown };
    return Array.isArray(info.cameras) && Array.isArray(info.microphones);
  } catch {
    return false;
  }
}

const cleanName = (value: unknown) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");

export async function registerBoard(input: { name: unknown; mcpUrl: unknown; token: unknown }, ownerUserId: string, deps: RegisterDeps = defaultDeps): Promise<RegisterResult> {
  const name = cleanName(input.name);
  // Control characters are gone with the whitespace rule above, except those \s doesn't cover.
  if (!name || name.length > BOARD_NAME_MAX_CHARS || /\p{Cc}/u.test(name)) return { ok: false, error: "invalid_name" };
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (token.length < BOARD_TOKEN_MIN_CHARS || token.length > BOARD_TOKEN_MAX_CHARS || /\s/.test(token)) return { ok: false, error: "invalid_token" };
  const url = typeof input.mcpUrl === "string" ? input.mcpUrl.trim() : "";
  const ring = deps.ring();
  if (!ring) return { ok: false, error: "key_missing" };
  const verdict = await deps.check(url);
  if (!verdict.ok || !verdict.trust) return { ok: false, error: "unsafe_address" };
  if ((await deps.count(ownerUserId)) >= BOARDS_PER_OWNER) return { ok: false, error: "too_many_boards" };

  const started = Date.now();
  let described: DeviceToolResult;
  try {
    described = await deps.describe({ url, token });
  } catch (err) {
    console.error("[hardware] a new board didn't answer:", err instanceof Error ? err.name : "error");
    return { ok: false, error: "board_unreachable" };
  }
  if (!looksLikeMuseDevice(described)) return { ok: false, error: "not_a_board" };

  const id = randomUUID();
  const now = deps.now?.() ?? new Date();
  await deps.insert({
    id,
    ownerUserId,
    name,
    url: sealSecret(url, ring, boardUrlAad(id, ownerUserId)),
    token: sealSecret(token, ring, boardTokenAad(id, ownerUserId)),
    trust: verdict.trust,
    health: { status: "ok", failures: 0, checkedAt: now.toISOString(), latencyMs: Date.now() - started },
    now,
  });
  return { ok: true, id };
}
