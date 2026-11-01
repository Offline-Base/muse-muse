import { lookup } from "node:dns/promises";
import { isPublicHttpUrl, resolvesToPublic } from "@/lib/tools/args";
import { callDeviceTool, listDeviceTools, type DeviceConfig } from "@/lib/device/client";
import type { DeviceTrust } from "@/lib/db/schema";
import { BOARD_URL_MAX_CHARS } from "@/lib/caps/hardware/limits";
import type { GadgetBoard, LinkedBoard } from "@/lib/gateway/gadget";
import { env } from "@/lib/env";
import { linkedBoardRow, noteBoardHealth, type LinkedBoardRow } from "@/lib/caps/hardware/store";
import { openSecret, parseKeyring, type BoxKeyring, type SealedSecret } from "@/lib/secrets/box";

/**
 * Reaching a registered board (docs/CAPABILITIES.md, section 19). A board's address and token stay sealed in `devices` and
 * are opened for one call, here on the server. They are never logged, and never go in a reply.
 */

export const boardUrlAad = (boardId: string, ownerUserId: string) => `board:${boardId}:${ownerUserId}:url`;
export const boardTokenAad = (boardId: string, ownerUserId: string) => `board:${boardId}:${ownerUserId}:token`;

/** HARDWARE_BOARD_KEY as a key ring. Null when unset or not a key, so nothing seals or opens with a weak key. */
export function boardKeyring(): BoxKeyring | null {
  try {
    return parseKeyring(env.hardwareBoardKey);
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type AddressLookup = (host: string) => Promise<string[]>;
const systemLookup: AddressLookup = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

export interface AddressVerdict {
  ok: boolean;
  trust?: DeviceTrust;
}

/**
 * Whether a token may travel to this address: https at a public address, with no name, password or query in it. Off Vercel
 * only, plain http on this machine too, as lib/device/client.ts allows, for a board in local tests. A hosted site never
 * calls its own network: the address and every name it resolves to must be public.
 */
export async function checkBoardAddress(value: string, opts: { hosted?: boolean; lookup?: AddressLookup } = {}): Promise<AddressVerdict> {
  if (value.length > BOARD_URL_MAX_CHARS || !URL.canParse(value)) return { ok: false };
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) return { ok: false };
  const hosted = opts.hosted ?? Boolean(process.env.VERCEL);
  if (!hosted && LOOPBACK.has(url.hostname) && (url.protocol === "http:" || url.protocol === "https:")) return { ok: true, trust: "loopback" };
  if (url.protocol !== "https:" || !isPublicHttpUrl(value)) return { ok: false };
  try {
    return (await resolvesToPublic(value, opts.lookup ?? systemLookup)) ? { ok: true, trust: "public_tls" } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** A redirect could send the board's token to another host, so a board's address never redirects. */
export const boardFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "error" });

function sealed(ciphertext: Buffer, iv: Buffer, tag: Buffer, keyVersion: number): SealedSecret {
  return { ciphertext, iv, tag, keyVersion };
}

/** Opens a linked board's address and token. Throws SecretBoxError, saying nothing about either. */
export function openBoardConfig(row: LinkedBoardRow, ring: BoxKeyring): DeviceConfig {
  return {
    url: openSecret(sealed(row.urlCiphertext, row.urlIv, row.urlTag, row.keyVersion), ring, boardUrlAad(row.boardId, row.ownerUserId)),
    token: openSecret(sealed(row.tokenCiphertext, row.iv, row.tag, row.keyVersion), ring, boardTokenAad(row.boardId, row.ownerUserId)),
  };
}

export interface LinkedBoardDeps {
  row(productId: string): Promise<LinkedBoardRow | null>;
  ring(): BoxKeyring | null;
  check(url: string): Promise<AddressVerdict>;
  list(config: DeviceConfig): ReturnType<GadgetBoard["listTools"]>;
  call(config: DeviceConfig, name: string, args: Record<string, unknown>): ReturnType<GadgetBoard["callTool"]>;
  health(boardId: string, ok: boolean, now: Date, latencyMs: number): Promise<void>;
  now?(): Date;
}

const defaultDeps: LinkedBoardDeps = {
  row: linkedBoardRow,
  ring: boardKeyring,
  check: (url) => checkBoardAddress(url),
  list: (config) => listDeviceTools(config, boardFetch),
  call: (config, name, args) => callDeviceTool(config, name, args, boardFetch),
  health: noteBoardHealth,
};

/**
 * The link this product's owner made, or null. `open` opens the board's secrets and checks its address, and is called only for
 * someone the link lets in. It gives null for no key, a row that doesn't open or an address that stopped being public: the
 * gateway then answers 503 gadget_offline, as for no board at all.
 */
export async function linkedBoardFor(productId: string, deps: LinkedBoardDeps = defaultDeps): Promise<LinkedBoard | null> {
  const row = await deps.row(productId);
  if (!row) return null;
  return { ownerUserId: row.ownerUserId, visitors: row.visitors, open: () => openLinkedBoard(row, deps) };
}

async function openLinkedBoard(row: LinkedBoardRow, deps: LinkedBoardDeps): Promise<GadgetBoard | null> {
  const ring = deps.ring();
  if (!ring) return null;
  let config: DeviceConfig;
  try {
    config = openBoardConfig(row, ring);
  } catch {
    console.error("[hardware] a board's secrets don't open with HARDWARE_BOARD_KEY");
    return null;
  }
  if (!(await deps.check(config.url)).ok) return null;
  const timed = async <T>(work: () => Promise<T>): Promise<T> => {
    const clock = () => deps.now?.() ?? new Date();
    const started = clock();
    const note = (ok: boolean) => deps.health(row.boardId, ok, clock(), clock().getTime() - started.getTime()).catch(() => undefined);
    try {
      const result = await work();
      await note(true);
      return result;
    } catch (err) {
      await note(false);
      throw err;
    }
  };
  return {
    listTools: () => timed(() => deps.list(config)),
    callTool: (name, args) => timed(() => deps.call(config, name, args)),
  };
}
