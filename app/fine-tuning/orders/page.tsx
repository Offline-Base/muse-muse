import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { OrdersQueue } from "@/components/drive/OrdersQueue";
import { Icon } from "@/components/icons";
import { EmptyCard, NotConnected, PageHeader } from "@/components/ui";
import { priceLine, toAdminRow } from "@/lib/drive/logic";
import { listOrders, purgeDriveOrders } from "@/lib/drive/store";
import { env } from "@/lib/env";
import { safeQuery } from "@/lib/queries";
import { pageViewer } from "../viewer";

export const metadata: Metadata = { title: "Drive orders", robots: { index: false } };

const SUBTITLE =
  "Flash drive order requests. Email each buyer an invoice from your own tool, then move the order along here. The bench script flashes and checks the paid ones.";

/**
 * The admin queue of flash drive orders (docs/VIBE_TUNING.md, Feature 6). Admins only, confirmed against the database
 * as the other fine-tuning pages do (pageViewer), since it shows buyers' names, emails and addresses. Old buyers'
 * details are purged before it reads, so it never shows what should be gone.
 */
export default async function DriveOrdersPage() {
  await connection();
  const viewer = await pageViewer();
  if (!viewer?.isAdmin) {
    return (
      <div className="page">
        <EmptyCard
          icon="download"
          title="Admins only"
          action={viewer ? { href: "/fine-tuning", label: "Back to fine-tuning" } : { href: "/sign-in?next=%2Ffine-tuning%2Forders", label: "Sign in" }}
        >
          <p>Drive orders hold buyers&apos; names and addresses, so only admins can see this queue.</p>
        </EmptyCard>
      </div>
    );
  }

  const now = new Date();
  const result = await safeQuery(async () => {
    await purgeDriveOrders(now);
    return listOrders();
  });
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="drive orders" />
      </div>
    );
  }
  const open = result.data.open.map((r) => toAdminRow(r, now));
  const closed = result.data.closed.map((r) => toAdminRow(r, now));
  const count = (...statuses: string[]) => open.filter((r) => statuses.includes(r.status)).length;
  const overdue = open.filter((r) => r.overdue).length;

  return (
    <div className="page">
      <PageHeader
        title="Drive orders"
        subtitle={SUBTITLE}
        actions={
          <Link className="btn btn-outline" href="/fine-tuning">
            <Icon name="chevronLeft" size={18} />
            Fine-tuning
          </Link>
        }
      />

      <section className="card section-card" aria-labelledby="orders-now">
        <h2 id="orders-now" className="sr-only">
          Where the queue stands
        </h2>
        <dl className="kv">
          <div>
            <dt>To invoice</dt>
            <dd>
              {count("requested")}
              {overdue ? `, ${overdue} of them over 2 business days` : ""}
            </dd>
          </div>
          <div>
            <dt>Waiting for payment</dt>
            <dd>{count("invoiced")}</dd>
          </div>
          <div>
            <dt>To flash</dt>
            <dd>{count("paid", "flashing")}</dd>
          </div>
          <div>
            <dt>To ship</dt>
            <dd>{count("checked")}</dd>
          </div>
          <div>
            <dt>On their way</dt>
            <dd>{count("shipped")}</dd>
          </div>
        </dl>
        <p className="muted small">
          {env.driveEnabled ? "Requests are on (DRIVE_ENABLED)." : "Requests are off: DRIVE_ENABLED isn't set, so nobody can send a new one."}{" "}
          The price line reads &quot;{priceLine(env.drivePriceText)}&quot;{" "}
          {env.driveNotifyUrl ? "The notify webhook gets one line per request." : "No notify webhook is set (DRIVE_NOTIFY_URL)."}{" "}
          {env.driveBenchTokenHash ? "The bench token is set." : "The bench script needs DRIVE_BENCH_TOKEN_HASH."}
        </p>
      </section>

      <OrdersQueue open={open} closed={closed} now={now.getTime()} />
    </div>
  );
}
