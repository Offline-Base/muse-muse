import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { AuthError, canActAsOwner, requireUser } from "@/lib/auth";
import { liveBrief } from "@/lib/caps/data/store";
import { jobsBlock } from "@/lib/caps/jobs/brief";
import { JOB_NAME } from "@/lib/caps/jobs/limits";
import { revokeWebhook, saveWebhook } from "@/lib/caps/jobs/store";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";

// A product's webhooks (docs/CAPABILITIES.md, section 12): the builder makes one for a webhook its brief names and sees
// its secret once. Making one again replaces it. Only a sha256 of the secret is kept. 404 while the cap is off.
export const runtime = "nodejs";

const off = () => Response.json({ error: "not_found" }, { status: 404 });

async function ownerProduct(slug: string): Promise<{ id: string } | Response> {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
  const [product] = await db().select({ id: schema.products.id, ownerId: schema.products.ownerId }).from(schema.products).where(eq(schema.products.slug, slug)).limit(1);
  if (!product) return off();
  if (!canActAsOwner(user, product.ownerId)) {
    return Response.json({ error: user.openAccess ? "Sign in first. Everyone shares the guest account, so it can't tell who owns what." : "Only the product's owner can do this." }, { status: 403 });
  }
  return { id: product.id };
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!env.servedCaps.includes("jobs") || !env.jobsWebhooks) return off();
  const product = await ownerProduct((await params).slug);
  if (product instanceof Response) return product;
  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  const name = body?.name;
  if (typeof name !== "string" || !JOB_NAME.test(name)) return Response.json({ error: "Name a webhook this product's brief lists." }, { status: 400 });
  const block = jobsBlock((await liveBrief(product.id)) as object | null);
  if (!block?.webhooks.some((w) => w.name === name)) return Response.json({ error: "This product wasn't built with a webhook by that name." }, { status: 400 });
  const secret = randomBytes(32).toString("base64url");
  const saved = await saveWebhook(product.id, name, createHash("sha256").update(secret).digest("hex"), new Date());
  if (saved === "full") return Response.json({ error: "A product has at most 2 webhooks. Remove one first." }, { status: 409 });
  return Response.json({ name, url: `${env.gatewayUrl.replace(/\/+$/, "")}/hooks/${product.id}/${name}?k=${secret}` }, { status: 201, headers: { "cache-control": "no-store" } });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!env.servedCaps.includes("jobs") || !env.jobsWebhooks) return off();
  const product = await ownerProduct((await params).slug);
  if (product instanceof Response) return product;
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!JOB_NAME.test(name)) return Response.json({ error: "Name the webhook to remove." }, { status: 400 });
  return Response.json({ removed: await revokeWebhook(product.id, name, new Date()) });
}
