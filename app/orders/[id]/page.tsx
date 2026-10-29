import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { OrderView } from "@/components/drive/OrderView";
import { NotConnected } from "@/components/ui";
import { isOrderSecret, orderCookieName, toOrderView } from "@/lib/drive/logic";
import { getOrder, orderForSecret } from "@/lib/drive/store";
import { env } from "@/lib/env";
import { safeQuery } from "@/lib/queries";
import { pageViewer } from "@/app/fine-tuning/viewer";

export const metadata: Metadata = {
  title: "Your flash drive order",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * One flash drive order, /orders/{id} (docs/VIBE_TUNING.md, Feature 6), for the holder of its link: the secret the
 * link's /orders/{id}/open saved in this browser's cookie, or the one the request itself set. Admins see every order.
 * Anyone else gets the not-found page, whether or not the order exists, so ids reveal nothing.
 */
export default async function DriveOrderPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const secret = (await cookies()).get(orderCookieName(id))?.value;
  const result = await safeQuery(async () => {
    const mine = isOrderSecret(secret) ? await orderForSecret(id, secret) : null;
    if (mine) return { row: mine, admin: false };
    const viewer = await pageViewer();
    const row = viewer?.isAdmin ? await getOrder(id) : null;
    return row ? { row, admin: true } : null;
  });
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="this order" />
      </div>
    );
  }
  if (!result.data) notFound();
  return <OrderView order={toOrderView(result.data.row)} adminView={result.data.admin} contact={env.driveContactEmail} />;
}
