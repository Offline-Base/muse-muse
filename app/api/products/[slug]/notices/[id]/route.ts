import { eq } from "drizzle-orm";
import { AuthError, canActAsOwner, requireUser } from "@/lib/auth";
import type { SendArgs } from "@/lib/caps/connect/handler";
import { claimNotice, markNoticeRead, noticeOf, releaseNotice } from "@/lib/caps/jobs/store";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";

// The owner's answer to a notice (docs/CAPABILITIES.md, section 12): "read" clears it. A send a job drafted waits for
// "confirm", which sends that one message once with the owner's own key, or "dismiss", which drops it.
export const runtime = "nodejs";

const off = () => Response.json({ error: "not_found" }, { status: 404 });

export async function POST(req: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  if (!env.servedCaps.includes("jobs")) return off();
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
  const { slug, id } = await params;
  const [product] = await db().select({ id: schema.products.id, ownerId: schema.products.ownerId, status: schema.products.status, takenDownAt: schema.products.takenDownAt }).from(schema.products).where(eq(schema.products.slug, slug)).limit(1);
  if (!product) return off();
  if (!canActAsOwner(user, product.ownerId)) return Response.json({ error: "Only the product's owner can do this." }, { status: 403 });
  const notice = await noticeOf(product.id, id);
  if (!notice) return off();
  const action = ((await req.json().catch(() => null)) as { action?: unknown } | null)?.action;
  const now = new Date();
  if (action === "read" && notice.kind !== "send_held") {
    await markNoticeRead(notice.id, now);
    return Response.json({ ok: true });
  }
  if (notice.kind !== "send_held") return Response.json({ error: "There's nothing to confirm on this notice." }, { status: 400 });
  if (action === "dismiss") {
    if (!(await claimNotice(notice.id, now))) return Response.json({ error: "This one was already answered." }, { status: 409 });
    return Response.json({ ok: true, sent: false });
  }
  if (action !== "confirm") return Response.json({ error: "Say confirm or dismiss." }, { status: 400 });
  if (product.status === "disabled" || product.takenDownAt) return Response.json({ error: "This product is turned off, so it can't send." }, { status: 409 });
  const send = (notice.payload as { send?: SendArgs } | null)?.send;
  if (!send) return Response.json({ error: "This message can't be read any more." }, { status: 409 });
  if (!(await claimNotice(notice.id, now))) return Response.json({ error: "This one was already answered." }, { status: 409 });
  const [{ deliverHeldSend }, { connectDeps }] = await Promise.all([import("@/lib/caps/connect/handler"), import("@/lib/caps/connect/deps")]);
  const result = await deliverHeldSend({ productId: product.id, send, nonce: notice.id, now }, connectDeps()).catch(() => ({ ok: false as const, code: "failed" as const, message: "It may not have gone. Check before sending it again.", mayHaveGone: true }));
  if (result.ok) return Response.json({ ok: true, sent: true });
  // Nothing went, so the owner can try again. A send that may have gone stays answered, so it can't go twice.
  if (!result.mayHaveGone) await releaseNotice(notice.id);
  return Response.json({ error: result.message }, { status: 409 });
}
