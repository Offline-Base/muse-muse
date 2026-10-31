import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { OrderView } from "@/components/drive/OrderView";
import { NotConnected } from "@/components/ui";
import { settleReturn } from "@/lib/drive/checkout";
import { isOrderSecret, orderCookieName, orderLink, toOrderView, usd } from "@/lib/drive/logic";
import { getOrder, orderForSecret } from "@/lib/drive/store";
import { isCheckoutSessionId } from "@/lib/drive/stripe";
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
 *
 * Stripe brings a card order's buyer back here with ?session=<Checkout Session id>: the page reads that session from
 * Stripe and settles it (settleReturn), so a paid order shows as paid before the webhook lands. ?checkout=cancelled
 * means they closed the checkout page without paying.
 */
export default async function DriveOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const { id } = await params;
  const query = (await searchParams) ?? {};
  const secret = (await cookies()).get(orderCookieName(id))?.value;
  const session = isCheckoutSessionId(query.session) ? query.session : null;
  const result = await safeQuery(async () => {
    const found = isOrderSecret(secret) ? await orderForSecret(id, secret) : null;
    const mine = found && session ? await settleReturn(found, session) : found;
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
  const { row, admin } = result.data;
  return (
    <OrderView
      order={toOrderView(row)}
      adminView={admin}
      contact={env.driveContactEmail}
      link={!admin && isOrderSecret(secret) ? orderLink(env.platformUrl, row.id, secret) : null}
      cardPrice={env.driveCheckout && env.drivePriceCents ? usd(env.drivePriceCents) : null}
      checkoutClosed={query.checkout === "cancelled"}
    />
  );
}
