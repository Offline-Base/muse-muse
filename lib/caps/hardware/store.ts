import { and, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { GUEST_EMAIL } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { hardwareBlock } from "@/lib/caps/hardware/brief";
import { BOARD_TOOLS, hardwareProofKey, PRODUCT_DRIVE_TOOLS } from "@/lib/caps/hardware/limits";
import { readCapDrops, withoutCaps } from "@/lib/caps/ready";
import type { DeviceHealth, DeviceTrust } from "@/lib/db/schema";
import type { SealedSecret } from "@/lib/secrets/box";

/**
 * The hardware unit's rows (docs/CAPABILITIES.md, section 19): `devices` rows with kind muse_device and `product_boards`.
 * Secrets only pass through here sealed. What leaves for a person (BoardView) holds no address and no token.
 */

/** What a person sees of a board: status words only. */
export interface BoardView {
  id: string;
  name: string;
  status: "ok" | "unreachable" | "unknown";
  lastSeenAt: string | null;
  products: Array<{ slug: string; name: string; visitors: boolean }>;
  /** GADGET_CONNECT, for a paired board. */
  paired?: { target: string; simulated: boolean; stopped: boolean };
}

/** What pairing learned about a board, saved in `devices.models`. */
export interface PairedFacts {
  kind: string;
  target: string;
  targetLabel: string;
  simulated: boolean;
  robot: boolean;
  served: string[];
}

export const pairedFactsOf = (models: unknown): PairedFacts | null => (Array.isArray(models) && models[0] && typeof models[0] === "object" && typeof (models[0] as PairedFacts).target === "string" ? (models[0] as PairedFacts) : null);

export interface NewBoardRow {
  id: string;
  ownerUserId: string;
  name: string;
  url: SealedSecret;
  token: SealedSecret;
  trust: DeviceTrust;
  health: DeviceHealth;
  now: Date;
}

/** A linked board as the gateway needs it. Sealed: lib/caps/hardware/board.ts opens it for one call. */
export interface LinkedBoardRow {
  boardId: string;
  ownerUserId: string;
  visitors: boolean;
  urlCiphertext: Buffer;
  urlIv: Buffer;
  urlTag: Buffer;
  tokenCiphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
  /** Set for a paired board: every call checks this, not a certificate authority. */
  certSpkiSha256?: string | null;
  models?: unknown;
  health?: DeviceHealth | null;
}

export async function insertBoard(row: NewBoardRow): Promise<void> {
  await db().insert(schema.devices).values({
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    kind: "muse_device",
    mcpUrlCiphertext: row.url.ciphertext,
    urlIv: row.url.iv,
    urlTag: row.url.tag,
    tokenCiphertext: row.token.ciphertext,
    iv: row.token.iv,
    tag: row.token.tag,
    keyVersion: row.token.keyVersion,
    trust: row.trust,
    health: row.health,
    lastSeenAt: row.now,
  });
}

/** A board that pairing just set up: its pin and what it said it is. */
export async function insertPairedBoard(row: NewBoardRow & { pin: string; facts: PairedFacts }): Promise<void> {
  await db().insert(schema.devices).values({
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    kind: "muse_device",
    mcpUrlCiphertext: row.url.ciphertext,
    urlIv: row.url.iv,
    urlTag: row.url.tag,
    tokenCiphertext: row.token.ciphertext,
    iv: row.token.iv,
    tag: row.token.tag,
    keyVersion: row.token.keyVersion,
    trust: "pinned_tls",
    certSpkiSha256: row.pin,
    models: [row.facts],
    pairedAt: row.now,
    health: row.health,
    lastSeenAt: row.now,
  });
}

export async function countBoards(ownerUserId: string): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(schema.devices)
    .where(and(eq(schema.devices.ownerUserId, ownerUserId), eq(schema.devices.kind, "muse_device"), isNull(schema.devices.revokedAt)));
  return row?.n ?? 0;
}

/** A person's boards, newest first, with those of their own products each is linked to. */
export async function listBoards(ownerUserId: string): Promise<BoardView[]> {
  const rows = await db()
    .select({ id: schema.devices.id, name: schema.devices.name, health: schema.devices.health, lastSeenAt: schema.devices.lastSeenAt, models: schema.devices.models, pairedAt: schema.devices.pairedAt })
    .from(schema.devices)
    .where(and(eq(schema.devices.ownerUserId, ownerUserId), eq(schema.devices.kind, "muse_device"), isNull(schema.devices.revokedAt)))
    .orderBy(desc(schema.devices.createdAt));
  if (!rows.length) return [];
  const links = await db()
    .select({ boardId: schema.productBoards.boardId, visitors: schema.productBoards.visitors, slug: schema.products.slug, name: schema.products.name })
    .from(schema.productBoards)
    .innerJoin(schema.products, and(eq(schema.products.id, schema.productBoards.productId), eq(schema.products.ownerId, ownerUserId)))
    .where(inArray(schema.productBoards.boardId, rows.map((r) => r.id)));
  return rows.map((r) => {
    const facts = r.pairedAt ? pairedFactsOf(r.models) : null;
    return {
      id: r.id,
      name: r.name,
      status: r.health?.status ?? "unknown",
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      products: links.filter((l) => l.boardId === r.id).map((l) => ({ slug: l.slug, name: l.name, visitors: l.visitors })),
      ...(facts ? { paired: { target: facts.targetLabel, simulated: facts.simulated, stopped: r.health?.stopped === true } } : {}),
    };
  });
}

/** A person's own products, for the link picker. */
export async function ownProducts(ownerUserId: string): Promise<Array<{ slug: string; name: string }>> {
  return db()
    .select({ slug: schema.products.slug, name: schema.products.name })
    .from(schema.products)
    .where(eq(schema.products.ownerId, ownerUserId))
    .orderBy(desc(schema.products.createdAt))
    .limit(100);
}

/** Removes a person's board: its secrets are wiped and its links go. False when it isn't theirs or is already gone. */
export async function revokeBoard(id: string, ownerUserId: string, now: Date): Promise<boolean> {
  return db().transaction(async (tx) => {
    const done = await tx
      .update(schema.devices)
      .set({ revokedAt: now, mcpUrlCiphertext: null, urlIv: null, urlTag: null, tokenCiphertext: null, iv: null, tag: null, keyVersion: null })
      .where(and(eq(schema.devices.id, id), eq(schema.devices.ownerUserId, ownerUserId), eq(schema.devices.kind, "muse_device"), isNull(schema.devices.revokedAt)))
      .returning({ id: schema.devices.id });
    if (!done.length) return false;
    await tx.delete(schema.productBoards).where(eq(schema.productBoards.boardId, id));
    return true;
  });
}

export async function productBySlug(slug: string): Promise<{ id: string; ownerId: string | null } | null> {
  const [row] = await db().select({ id: schema.products.id, ownerId: schema.products.ownerId }).from(schema.products).where(eq(schema.products.slug, slug)).limit(1);
  return row ?? null;
}

/** True when this active board is the person's. */
export async function ownsBoard(id: string, ownerUserId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(and(eq(schema.devices.id, id), eq(schema.devices.ownerUserId, ownerUserId), eq(schema.devices.kind, "muse_device"), isNull(schema.devices.revokedAt)))
    .limit(1);
  return Boolean(row);
}

/** A product has one board: linking again replaces it. */
export async function linkBoard(productId: string, boardId: string, visitors: boolean): Promise<void> {
  await db()
    .insert(schema.productBoards)
    .values({ productId, boardId, visitors })
    .onConflictDoUpdate({ target: schema.productBoards.productId, set: { boardId, visitors } });
}

export async function unlinkBoard(productId: string): Promise<void> {
  await db().delete(schema.productBoards).where(eq(schema.productBoards.productId, productId));
}

/**
 * The board a live product reaches, or null. Everything the owner check rests on is in this one query: the link, a board of
 * the muse_device kind that isn't removed, whose owner is the product's owner right now and isn't banned. A product that
 * changed hands, or a board linked by anyone else, gets nothing. Nor does the shared guest: every guest has its id, so "the owner"
 * would mean everyone. No route lets a guest pair or link, and this holds even if a row got here some other way.
 */
export async function linkedBoardRow(productId: string): Promise<LinkedBoardRow | null> {
  const [row] = await db()
    .select({
      boardId: schema.devices.id,
      ownerUserId: schema.devices.ownerUserId,
      visitors: schema.productBoards.visitors,
      urlCiphertext: schema.devices.mcpUrlCiphertext,
      urlIv: schema.devices.urlIv,
      urlTag: schema.devices.urlTag,
      tokenCiphertext: schema.devices.tokenCiphertext,
      iv: schema.devices.iv,
      tag: schema.devices.tag,
      keyVersion: schema.devices.keyVersion,
      certSpkiSha256: schema.devices.certSpkiSha256,
      models: schema.devices.models,
      health: schema.devices.health,
    })
    .from(schema.productBoards)
    .innerJoin(schema.products, eq(schema.products.id, schema.productBoards.productId))
    .innerJoin(schema.devices, and(eq(schema.devices.id, schema.productBoards.boardId), eq(schema.devices.ownerUserId, schema.products.ownerId)))
    .innerJoin(schema.users, eq(schema.users.id, schema.devices.ownerUserId))
    .where(and(eq(schema.productBoards.productId, productId), eq(schema.devices.kind, "muse_device"), isNull(schema.devices.revokedAt), isNull(schema.users.bannedAt), ne(schema.users.email, GUEST_EMAIL)))
    .limit(1);
  if (!row?.urlCiphertext || !row.urlIv || !row.urlTag || !row.tokenCiphertext || !row.iv || !row.tag || row.keyVersion === null) return null;
  return row as LinkedBoardRow;
}

/** A person's own active board, opened the way a link is. For their stop button, their confirmations and unpairing. */
export async function ownedBoardRow(id: string, ownerUserId: string): Promise<LinkedBoardRow | null> {
  const [row] = await db()
    .select({
      boardId: schema.devices.id,
      ownerUserId: schema.devices.ownerUserId,
      urlCiphertext: schema.devices.mcpUrlCiphertext,
      urlIv: schema.devices.urlIv,
      urlTag: schema.devices.urlTag,
      tokenCiphertext: schema.devices.tokenCiphertext,
      iv: schema.devices.iv,
      tag: schema.devices.tag,
      keyVersion: schema.devices.keyVersion,
      certSpkiSha256: schema.devices.certSpkiSha256,
      models: schema.devices.models,
      health: schema.devices.health,
    })
    .from(schema.devices)
    .where(and(eq(schema.devices.id, id), eq(schema.devices.ownerUserId, ownerUserId), eq(schema.devices.kind, "muse_device"), isNull(schema.devices.revokedAt)))
    .limit(1);
  if (!row?.urlCiphertext || !row.urlIv || !row.urlTag || !row.tokenCiphertext || !row.iv || !row.tag || row.keyVersion === null) return null;
  return { ...row, visitors: false } as LinkedBoardRow;
}

/** The hard stop, saved here so it holds whether or not the board answered. */
export async function setBoardStopped(id: string, stopped: boolean): Promise<void> {
  await db()
    .update(schema.devices)
    .set({ health: sql`coalesce(${schema.devices.health}, '{"status":"ok","failures":0}'::jsonb) || jsonb_build_object('stopped', ${stopped}::boolean)` })
    .where(eq(schema.devices.id, id));
}

/** Remembers how a call went, for the status word. Best effort: a call never fails because of this. */
export async function noteBoardHealth(boardId: string, ok: boolean, now: Date, latencyMs?: number): Promise<void> {
  await db()
    .update(schema.devices)
    .set({
      // Merged, so the hard stop survives a health note.
      health: sql`coalesce(${schema.devices.health}, '{}'::jsonb) || jsonb_build_object(
        'status', ${ok ? "ok" : "unreachable"}::text,
        'failures', ${ok ? sql`0` : sql`coalesce((${schema.devices.health}->>'failures')::int, 0) + 1`},
        'checkedAt', ${now.toISOString()}::text
        ${latencyMs === undefined ? sql`` : sql`, 'latencyMs', ${Math.round(latencyMs)}::int`}
      )`,
      ...(ok ? { lastSeenAt: now } : {}),
    })
    .where(eq(schema.devices.id, boardId));
}

/** When a counter keyed by moment last counted, or null. The simulated drive's start, so it needs no table of its own. The hourly prune takes the rows. */
export async function latestProofAt(key: string): Promise<Date | null> {
  const [row] = await db().select({ at: sql<string | Date | null>`max(${schema.rateLimits.windowStart})` }).from(schema.rateLimits).where(eq(schema.rateLimits.key, key));
  return row?.at ? new Date(row.at) : null;
}

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []));

/** /caps/proof: board tool calls that reached the simulated board since `since`, and what the brief asks for. */
export async function hardwareProof(buildId: string, window: { since: Date | null }): Promise<Record<string, number>> {
  const [build] = await db().select({ brief: schema.builds.brief, capsDropped: schema.builds.capsDropped }).from(schema.builds).where(eq(schema.builds.id, buildId)).limit(1);
  const dropped = (readCapDrops(build?.capsDropped) ?? []).map((d) => d.cap);
  const block = build?.brief ? hardwareBlock(withoutCaps(build.brief as object, dropped)) : null;
  const calls: Record<string, number> = {};
  for (const tool of block?.driveExport ? [...BOARD_TOOLS, ...PRODUCT_DRIVE_TOOLS] : BOARD_TOOLS) {
    const since = window.since ? sql`and window_start >= ${window.since.toISOString()}::timestamptz` : sql``;
    const [row] = rowsOf<{ n: number | string }>(await db().execute(sql`select coalesce(sum(count), 0)::int as n from rate_limits where key = ${hardwareProofKey(tool, buildId)} ${since}`));
    calls[tool] = Number(row?.n ?? 0);
  }
  return {
    ...calls,
    ...(block?.links.length ? { "brief:links": block.links.length } : {}),
    ...(block?.boardTools ? { "brief:boardTools": 1 } : {}),
    ...(block?.driveExport ? { "brief:driveExport": 1 } : {}),
  };
}
