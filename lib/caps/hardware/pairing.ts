import { randomUUID } from "node:crypto";
import { boardKeyring, boardTokenAad, boardUrlAad, checkBoardAddress, openBoardConfig, type AddressVerdict } from "@/lib/caps/hardware/board";
import { BOARD_CHECK_MS, BOARD_NAME_MAX_CHARS, BOARD_TOKEN_MIN_CHARS, BOARD_URL_MAX_CHARS, BOARDS_PER_OWNER, PAIR_TICKET_MS } from "@/lib/caps/hardware/limits";
import { pairCheckNumber, pinnedFetch, readBoardPin } from "@/lib/caps/hardware/pinned";
import { looksLikeMuseDevice } from "@/lib/caps/hardware/registry";
import { countBoards, insertPairedBoard, ownedBoardRow, type PairedFacts } from "@/lib/caps/hardware/store";
import { boardKindOf, targetForBoardKind } from "@/lib/caps/hardware/targets";
import { callDeviceTool, type DeviceToolResult } from "@/lib/device/client";
import { openSecret, sealSecret, type BoxKeyring, type SealedSecret } from "@/lib/secrets/box";

/**
 * Pairing a person's own board (docs/GADGETS.md; design in docs/OFFLINE.md, "Pairing and the LAN trust story", on tg-offline).
 *
 *  1. On the board, `server.py pair` prints an 8-character one-time code and a 6-digit check number from its certificate.
 *  2. startPairing reads the board's public key from a TLS handshake and shows the same 6 digits. Nothing is stored or sent. The
 *     person compares the numbers: that's what stops someone in the middle. The key's hash goes back sealed in a ticket, naming this
 *     person, so no other account can finish it and nobody can swap the key in between.
 *  3. finishPairing sends the code over TLS pinned to that key. The board returns a new token once and keeps only its hash.
 *  4. Every later call checks the pin (lib/caps/hardware/pinned.ts). The row belongs to this account, and the gateway compares it to
 *     the product's owner on every call, so one person's product can't reach another's board.
 *
 * The route refuses the shared guest before any of this runs (requireBoardOwner).
 */

export type PairRefusal = "unsafe_address" | "board_unreachable" | "key_missing" | "invalid_name" | "invalid_code" | "pair_expired" | "wrong_code" | "not_a_board" | "too_many_boards" | "not_confirmed";

const CODE = /^[2-9A-HJ-NP-Z]{8}$/;

export interface PairDeps {
  ring(): BoxKeyring | null;
  check(url: string): Promise<AddressVerdict>;
  readPin(origin: string): Promise<string>;
  /** POST /pair over pinned TLS: the new token, or null for a wrong or used code. */
  redeem(origin: string, pin: string, code: string): Promise<string | null>;
  describe(mcpUrl: string, token: string, pin: string): Promise<DeviceToolResult>;
  served(origin: string, token: string, pin: string): Promise<string[]>;
  count(ownerUserId: string): Promise<number>;
  insert: typeof insertPairedBoard;
  now?(): Date;
}

const timed = (ms: number) => AbortSignal.timeout(ms);

const defaultDeps: PairDeps = {
  ring: boardKeyring,
  check: (url) => checkBoardAddress(url, { pinned: true }),
  readPin: (origin) => readBoardPin(origin),
  async redeem(origin, pin, code) {
    const res = await pinnedFetch(pin)(`${origin}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }), signal: timed(BOARD_CHECK_MS) });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error(`The board answered ${res.status}.`);
    const body = (await res.json()) as { token?: unknown };
    return typeof body.token === "string" && body.token.length >= BOARD_TOKEN_MIN_CHARS ? body.token : null;
  },
  describe: (mcpUrl, token, pin) => callDeviceTool({ url: mcpUrl, token }, "describe_device", {}, (input, init) => pinnedFetch(pin)(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timed(BOARD_CHECK_MS)]) : timed(BOARD_CHECK_MS) })),
  async served(origin, token, pin) {
    try {
      const res = await pinnedFetch(pin)(`${origin}/v1/models`, { headers: { authorization: `Bearer ${token}` }, signal: timed(BOARD_CHECK_MS) });
      if (!res.ok) return [];
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
      return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string").slice(0, 20);
    } catch {
      return [];
    }
  },
  count: countBoards,
  insert: insertPairedBoard,
};

/** The board's https origin from what someone typed: a host and port, or a full address. Null when it can't carry a token. */
export function boardOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > BOARD_URL_MAX_CHARS) return null;
  const typed = value.trim();
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
  if (!URL.canParse(text)) return null;
  const url = new URL(text);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["/", "/mcp"].includes(url.pathname)) return null;
  return url.origin;
}

const ticketAad = (ownerUserId: string) => `pair-ticket:${ownerUserId}`;

interface Ticket {
  origin: string;
  pin: string;
  exp: number;
}

function sealTicket(ticket: Ticket, ring: BoxKeyring, ownerUserId: string): string {
  const s = sealSecret(JSON.stringify(ticket), ring, ticketAad(ownerUserId));
  return [s.keyVersion, s.iv.toString("base64url"), s.tag.toString("base64url"), s.ciphertext.toString("base64url")].join(".");
}

function openTicket(value: unknown, ring: BoxKeyring, ownerUserId: string, now: Date): Ticket | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  const [version, iv, tag, ciphertext] = value.split(".");
  if (!version || !iv || !tag || !ciphertext) return null;
  try {
    const sealed: SealedSecret = { keyVersion: Number(version), iv: Buffer.from(iv, "base64url"), tag: Buffer.from(tag, "base64url"), ciphertext: Buffer.from(ciphertext, "base64url") };
    const ticket = JSON.parse(openSecret(sealed, ring, ticketAad(ownerUserId))) as Ticket;
    return ticket.exp > now.getTime() ? ticket : null;
  } catch {
    return null;
  }
}

export type StartResult = { ok: true; ticket: string; checkNumber: string } | { ok: false; error: PairRefusal };

/** Step 2: the check number to compare. Nothing is sent to the board but a TLS handshake. */
export async function startPairing(input: { address: unknown }, ownerUserId: string, deps: PairDeps = defaultDeps): Promise<StartResult> {
  const ring = deps.ring();
  if (!ring) return { ok: false, error: "key_missing" };
  const origin = boardOrigin(input.address);
  if (!origin || !(await deps.check(`${origin}/mcp`)).ok) return { ok: false, error: "unsafe_address" };
  let pin: string;
  try {
    pin = await deps.readPin(origin);
  } catch (err) {
    console.error("[hardware] pairing couldn't reach a board:", err instanceof Error ? err.name : "error");
    return { ok: false, error: "board_unreachable" };
  }
  const now = deps.now?.() ?? new Date();
  return { ok: true, ticket: sealTicket({ origin, pin, exp: now.getTime() + PAIR_TICKET_MS }, ring, ownerUserId), checkNumber: pairCheckNumber(pin) };
}

const cleanName = (value: unknown) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");

export type FinishResult = { ok: true; id: string; target: string; simulated: boolean } | { ok: false; error: PairRefusal };

/** Step 3: the person said the numbers match. The code goes to the pinned key only, and the board's new token is sealed here. */
export async function finishPairing(input: { ticket: unknown; code: unknown; name: unknown; confirmed: unknown }, ownerUserId: string, deps: PairDeps = defaultDeps): Promise<FinishResult> {
  const ring = deps.ring();
  if (!ring) return { ok: false, error: "key_missing" };
  if (input.confirmed !== true) return { ok: false, error: "not_confirmed" };
  const name = cleanName(input.name);
  if (!name || name.length > BOARD_NAME_MAX_CHARS || /\p{Cc}/u.test(name)) return { ok: false, error: "invalid_name" };
  const code = typeof input.code === "string" ? input.code.trim().toUpperCase() : "";
  if (!CODE.test(code)) return { ok: false, error: "invalid_code" };
  const now = deps.now?.() ?? new Date();
  const ticket = openTicket(input.ticket, ring, ownerUserId, now);
  if (!ticket) return { ok: false, error: "pair_expired" };
  if ((await deps.count(ownerUserId)) >= BOARDS_PER_OWNER) return { ok: false, error: "too_many_boards" };
  const mcpUrl = `${ticket.origin}/mcp`;
  let token: string | null;
  let described: DeviceToolResult;
  try {
    token = await deps.redeem(ticket.origin, ticket.pin, code);
    if (!token) return { ok: false, error: "wrong_code" };
    described = await deps.describe(mcpUrl, token, ticket.pin);
  } catch (err) {
    console.error("[hardware] pairing couldn't finish:", err instanceof Error ? err.name : "error");
    return { ok: false, error: "board_unreachable" };
  }
  if (!looksLikeMuseDevice(described)) return { ok: false, error: "not_a_board" };
  const info = JSON.parse((described.content as Array<{ type?: string; text?: string }>).find((c) => c.type === "text")?.text ?? "{}") as { model?: unknown; simulated?: unknown; robot?: unknown };
  const kind = boardKindOf(info.model);
  const target = targetForBoardKind(kind);
  const simulated = info.simulated === true;
  const facts: PairedFacts = { kind, target: target.id, targetLabel: target.label, simulated, robot: simulated && info.robot === true, served: await deps.served(ticket.origin, token, ticket.pin) };
  const id = randomUUID();
  await deps.insert({
    id,
    ownerUserId,
    name,
    url: sealSecret(mcpUrl, ring, boardUrlAad(id, ownerUserId)),
    token: sealSecret(token, ring, boardTokenAad(id, ownerUserId)),
    trust: "pinned_tls",
    pin: ticket.pin,
    facts,
    health: { status: "ok", failures: 0, checkedAt: now.toISOString() },
    now,
  });
  return { ok: true, id, target: target.label, simulated };
}

/** Best effort, before a paired board's row goes: tells the board to forget this token. A board that's off keeps the hash until `unpair` runs there. */
export async function forgetOnBoard(id: string, ownerUserId: string): Promise<void> {
  const ring = boardKeyring();
  const row = ring ? await ownedBoardRow(id, ownerUserId).catch(() => null) : null;
  if (!ring || !row?.certSpkiSha256) return;
  try {
    const config = openBoardConfig(row, ring);
    await pinnedFetch(row.certSpkiSha256)(new URL("/unpair", config.url), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` }, body: "{}", signal: AbortSignal.timeout(5_000) });
  } catch {
    console.error("[hardware] a board didn't hear it was removed");
  }
}
