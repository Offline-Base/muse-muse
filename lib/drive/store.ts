/**
 * The drive_orders table (lib/db/schema.ts driveOrders, docs/VIBE_TUNING.md Feature 6): saving a request inside its
 * quotas, reading an order for the holder of its link, the admin's, buyer's and bench's moves, and the purge. Every move
 * is one guarded update that lands only while the order is in a status the move is allowed from (lib/drive/logic.ts),
 * so two clicks at once move an order once.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { hashToken } from "@/lib/gateway/tokens";
import {
  movableFrom,
  purgeCutoffs,
  REQUEST_WINDOW_MS,
  type AdminChange,
  type BenchReport,
  type DriveOrderRow,
  type DriveRequest,
} from "@/lib/drive/logic";
import type { DriveActor, DriveFile, DriveModel, DriveStatus } from "@/lib/drive/types";

const orders = schema.driveOrders;

/** Serializes saving requests, so two at once can't both slip under a quota. Any constant works; this one is drive's. */
const REQUEST_LOCK = 7_301_626;

/** Closed orders the admin queue lists, newest first. Open ones are all listed. */
const CLOSED_SHOWN = 50;

const CLOSED: DriveStatus[] = ["delivered", "cancelled"];

/** The column each status stamps when an order reaches it. */
const STAMPS = {
  invoiced: "invoicedAt",
  paid: "paidAt",
  flashing: "flashingAt",
  checked: "checkedAt",
  shipped: "shippedAt",
  delivered: "deliveredAt",
  cancelled: "cancelledAt",
} as const satisfies Partial<Record<DriveStatus, keyof DriveOrderRow>>;

/** A new order link's secret: 32 random bytes, base64url. Only hashToken of it is stored. */
export function newOrderSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** A random id for a browser's quota cookie. */
export function newBrowserId(): string {
  return randomBytes(16).toString("base64url");
}

/** The quota key of a client IP (clientIpKey's form): an HMAC with the pepper, never the IP itself. */
export function clientKeyOf(ip: string): string {
  return hashToken(`ip:${ip}`);
}

/** The quota key of a browser's random cookie id. */
export function browserKeyOf(browserId: string): string {
  return hashToken(`browser:${browserId}`);
}

function sameHash(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** The rows of a db().execute() result: Neon and PGlite both answer { rows }. */
function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

export interface NewDriveOrder {
  request: DriveRequest;
  files: DriveFile[];
  repo: string;
  commit: string;
  model: DriveModel;
  imageVersion: string;
  secretHash: string;
  clientKey: string;
  browserKey: string;
}

export type CreateOrderResult = { ok: true; order: DriveOrderRow } | { ok: false; limit: "client" | "everyone" };

/**
 * Saves a request as "requested", unless this client (a row with its IP's key or its browser's key) already sent
 * `perClient` in the last 24 hours, or everyone together sent `everyone`. The count and the insert are one statement
 * after an advisory lock, in one transaction (Neon runs a batch as one), so requests at once can't pass a quota.
 */
export async function createOrder(input: NewDriveOrder, limits: { perClient: number; everyone: number }, now = new Date()): Promise<CreateOrderResult> {
  const since = new Date(now.getTime() - REQUEST_WINDOW_MS);
  const r = input.request;
  const sinceIso = since.toISOString();
  const nowIso = now.toISOString();
  // Whole numbers Postgres can compare a count with, however large an exemption the caller asks for.
  const perClient = Math.max(0, Math.min(1e9, Math.floor(limits.perClient)));
  const everyone = Math.max(0, Math.min(1e9, Math.floor(limits.everyone)));
  const [, inserted] = await db().batch([
    db().execute(sql`select pg_advisory_xact_lock(${REQUEST_LOCK})`),
    db().execute(
      sql`insert into drive_orders (status, secret_hash, training_job_id, build, gguf_repo, gguf_commit, files, model,
            image_version, name, email, address, terms_version, terms_accepted_at, age_ok_at, client_key, browser_key,
            created_at, updated_at)
          select 'requested', ${input.secretHash}, ${r.trainingJobId}::uuid, ${r.build}, ${input.repo}, ${input.commit},
                 ${JSON.stringify(input.files)}::jsonb, ${JSON.stringify(input.model)}::jsonb, ${input.imageVersion},
                 ${r.name}, ${r.email}, ${JSON.stringify(r.address)}::jsonb, ${r.termsVersion}, ${nowIso}::timestamptz,
                 ${nowIso}::timestamptz, ${input.clientKey}, ${input.browserKey}, ${nowIso}::timestamptz, ${nowIso}::timestamptz
          where (select count(*) from drive_orders
                  where created_at > ${sinceIso}::timestamptz
                    and (client_key = ${input.clientKey} or browser_key = ${input.browserKey})) < ${perClient}::int
            and (select count(*) from drive_orders where created_at > ${sinceIso}::timestamptz) < ${everyone}::int
          returning id`,
    ),
  ]);
  const id = rowsOf(inserted)[0]?.id;
  if (typeof id === "string") {
    const order = await getOrder(id);
    if (order) return { ok: true, order };
  }
  // Nothing was saved: say which quota stopped it.
  const [mine] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(sql`${orders.createdAt} > ${sinceIso}::timestamptz`, or(eq(orders.clientKey, input.clientKey), eq(orders.browserKey, input.browserKey))));
  return { ok: false, limit: Number(mine?.n ?? 0) >= perClient ? "client" : "everyone" };
}

function isOrderId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** One order, every column, or null. */
export async function getOrder(id: string): Promise<DriveOrderRow | null> {
  if (!isOrderId(id)) return null;
  const [row] = await db().select().from(orders).where(eq(orders.id, id.toLowerCase())).limit(1);
  return row ?? null;
}

/** The order when `secret` is its link's secret (compared as HMACs, in constant time), else null. */
export async function orderForSecret(id: string, secret: string | null | undefined): Promise<DriveOrderRow | null> {
  if (!secret) return null;
  const row = await getOrder(id);
  return row && sameHash(hashToken(secret), row.secretHash) ? row : null;
}

/** The admin queue: every open order, oldest first, then the latest closed ones, newest first. */
export async function listOrders(): Promise<{ open: DriveOrderRow[]; closed: DriveOrderRow[] }> {
  const [open, closed] = await Promise.all([
    db().select().from(orders).where(notInArray(orders.status, CLOSED)).orderBy(asc(orders.createdAt)),
    db().select().from(orders).where(inArray(orders.status, CLOSED)).orderBy(desc(orders.createdAt)).limit(CLOSED_SHOWN),
  ]);
  return { open, closed };
}

/** How many requests wait for an invoice. */
export async function countRequested(): Promise<number> {
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(orders).where(eq(orders.status, "requested"));
  return Number(row?.n ?? 0);
}

/**
 * Moves an order to `to` for `actor`, stamping the status's time, in one guarded update: only from a status
 * lib/drive/logic.ts allows. Returns the order as it now is, or null when the move isn't allowed from where it stands
 * (or there is no such order).
 */
async function moveOrder(
  id: string,
  to: Exclude<DriveStatus, "requested">,
  actor: DriveActor,
  set: Partial<DriveOrderRow>,
  now: Date,
): Promise<DriveOrderRow | null> {
  const from = movableFrom(to, actor);
  if (!from.length || !isOrderId(id)) return null;
  const [row] = await db()
    .update(orders)
    .set({ ...set, status: to, [STAMPS[to]]: now, updatedAt: now })
    .where(and(eq(orders.id, id.toLowerCase()), inArray(orders.status, from)))
    .returning();
  return row ?? null;
}

/** The admin's Invoiced, Paid, Cancel, Shipped and Delivered, with what each needs. */
export async function adminMove(id: string, change: AdminChange, now = new Date()): Promise<DriveOrderRow | null> {
  const set: Partial<DriveOrderRow> = {};
  if (change.to === "invoiced") Object.assign(set, { invoiceRef: change.invoiceRef, amountText: change.amountText });
  if (change.to === "shipped") Object.assign(set, { carrier: change.carrier, tracking: change.tracking });
  if (change.to === "cancelled") set.cancelledBy = "admin";
  if (change.note) set.note = change.note;
  return moveOrder(id, change.to, "admin", set, now);
}

/** The buyer's Cancel, until the bench starts writing the stick. */
export async function buyerCancel(id: string, now = new Date()): Promise<DriveOrderRow | null> {
  return moveOrder(id, "cancelled", "buyer", { cancelledBy: "buyer" }, now);
}

/**
 * The order the bench should flash next: one it already claimed (a run that stopped part way) first, then the oldest
 * paid one. Null when the queue is empty.
 */
export async function benchNext(): Promise<DriveOrderRow | null> {
  const [flashing] = await db().select().from(orders).where(eq(orders.status, "flashing")).orderBy(asc(orders.flashingAt)).limit(1);
  if (flashing) return flashing;
  const [paid] = await db().select().from(orders).where(eq(orders.status, "paid")).orderBy(asc(orders.paidAt), asc(orders.createdAt)).limit(1);
  return paid ?? null;
}

/**
 * The bench starts writing a stick for a paid order: "flashing", with the order's serial. Claiming it again with the
 * same serial (a run that stopped part way) is fine; another serial never is. Null when it isn't claimable.
 */
export async function claimFlashing(id: string, serial: string, now = new Date()): Promise<DriveOrderRow | null> {
  const [row] = await db()
    .update(orders)
    .set({ status: "flashing", serial, flashingAt: now, verifyResult: null, updatedAt: now })
    .where(
      and(
        eq(orders.id, id.toLowerCase()),
        or(
          and(eq(orders.status, "paid"), or(isNull(orders.serial), eq(orders.serial, serial))),
          and(eq(orders.status, "flashing"), eq(orders.serial, serial)),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * The bench's check after a replug. PASS makes the order "checked"; FAIL puts it back in the queue as "paid" with the
 * result kept, so a stick that failed never moves on. Only for an order flashing under this serial; null otherwise.
 */
export async function reportFlashed(id: string, report: BenchReport, now = new Date()): Promise<DriveOrderRow | null> {
  const pass = report.result === "PASS";
  const [row] = await db()
    .update(orders)
    .set({
      status: pass ? "checked" : "paid",
      verifyResult: report.result,
      manifestSha256: report.manifestSha256,
      ...(pass ? { checkedAt: now } : {}),
      ...(report.imageVersion ? { imageVersion: report.imageVersion } : {}),
      updatedAt: now,
    })
    .where(and(eq(orders.id, id.toLowerCase()), eq(orders.status, "flashing"), eq(orders.serial, report.serial)))
    .returning();
  return row ?? null;
}

/**
 * Clears what the platform no longer needs: the buyer's name, email and address, the tracking number, the invoice's
 * reference and amount, and the notes of orders delivered or cancelled more than 60 days ago, or shipped more than 74
 * days ago and never marked delivered (purgeCutoffs), and every order's quota keys after 30 days. Safe to run often.
 */
export async function purgeDriveOrders(now = new Date()): Promise<{ buyers: number; keys: number }> {
  const cut = purgeCutoffs(now);
  const buyers = await db()
    .update(orders)
    .set({ name: null, email: null, address: null, tracking: null, invoiceRef: null, amountText: null, note: null, purgedAt: now, updatedAt: now })
    .where(
      and(
        isNull(orders.purgedAt),
        or(
          and(eq(orders.status, "delivered"), lt(orders.deliveredAt, cut.buyer)),
          and(eq(orders.status, "cancelled"), lt(orders.cancelledAt, cut.buyer)),
          and(eq(orders.status, "shipped"), lt(orders.shippedAt, cut.shipped)),
        ),
      ),
    )
    .returning({ id: orders.id });
  const keys = await db()
    .update(orders)
    .set({ clientKey: null, browserKey: null })
    .where(and(lt(orders.createdAt, cut.keys), or(isNotNull(orders.clientKey), isNotNull(orders.browserKey))))
    .returning({ id: orders.id });
  return { buyers: buyers.length, keys: keys.length };
}
