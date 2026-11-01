/** The hosted_endpoints table. Server only. */
import { and, eq, gte, inArray, or } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { HOST_OPEN, type HostEndpoint } from "@/lib/train/host/types";
import type { NewEndpoint } from "@/lib/train/host/service";

const t = () => schema.hostedEndpoints;
const OPEN = [...HOST_OPEN];

export async function hostRows(now: Date): Promise<HostEndpoint[]> {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const rows = await db().select().from(t()).where(or(inArray(t().status, OPEN), gte(t().createdAt, day)));
  return rows as HostEndpoint[];
}

export async function insertHostEndpoint(row: NewEndpoint): Promise<HostEndpoint | null> {
  const [saved] = await db().insert(t()).values(row).onConflictDoNothing().returning();
  return (saved as HostEndpoint | undefined) ?? null;
}

export async function patchHostEndpoint(id: string, patch: Partial<HostEndpoint>): Promise<void> {
  await db().update(t()).set(patch).where(eq(t().id, id));
}

export async function touchHostEndpoint(id: string, now: Date): Promise<void> {
  await patchHostEndpoint(id, { lastUsedAt: now });
}

const SERVING = ["starting", "live"] as const;

export async function hostByOwnerTokenHash(hash: string): Promise<HostEndpoint | null> {
  const [row] = await db().select().from(t()).where(and(eq(t().ownerTokenHash, hash), inArray(t().status, [...SERVING]))).limit(1);
  return (row as HostEndpoint | undefined) ?? null;
}

export async function hostByModel(adapterJobId: string): Promise<HostEndpoint | null> {
  const [row] = await db().select().from(t()).where(and(eq(t().adapterJobId, adapterJobId), inArray(t().status, [...SERVING]))).limit(1);
  return (row as HostEndpoint | undefined) ?? null;
}

/** The model was trained for this product, or by the person who owns it. */
export async function productOwnsModel(productId: string, adapterJobId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/.test(adapterJobId)) return false;
  const [job] = await db().select({ productId: schema.trainingJobs.productId, createdBy: schema.trainingJobs.createdBy }).from(schema.trainingJobs).where(eq(schema.trainingJobs.id, adapterJobId)).limit(1);
  if (!job) return false;
  if (job.productId === productId) return true;
  const [product] = await db().select({ ownerId: schema.products.ownerId }).from(schema.products).where(eq(schema.products.id, productId)).limit(1);
  return Boolean(product && job.createdBy && product.ownerId === job.createdBy);
}
