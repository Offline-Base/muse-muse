import Link from "next/link";
import { OrderActions } from "@/components/drive/OrderActions";
import { DRIVE_STATUS_LABEL, addressLines, driveTone, wasPaid } from "@/components/drive/format";
import { buildLabel, type DriveAdminRow } from "@/lib/drive/logic";
import { dateTimeUtc, relativeTime } from "@/lib/format";

function StatusCell({ row }: { row: DriveAdminRow }) {
  return (
    <>
      <span className={`pill pill-${driveTone(row.status)}`}>
        <span className="pill-dot" aria-hidden />
        {DRIVE_STATUS_LABEL[row.status]}
      </span>
      {row.overdue ? <span className="drive-flag">Over 2 business days</span> : null}
      {row.verifyResult === "FAIL" && row.status === "paid" ? <span className="drive-flag">Last stick failed its check</span> : null}
      {row.payment === "card" ? <span className="row-sub muted">{row.status === "requested" ? "Card, waiting for the buyer to pay" : "Card"}</span> : null}
      {row.status === "cancelled" && wasPaid(row) && !row.refunded ? (
        <span className="drive-flag">{row.payment === "card" ? "Card refund not sent" : "Refund owed"}</span>
      ) : null}
      {row.refunded ? <span className="row-sub muted">Refunded on Stripe</span> : null}
      {row.note ? <span className="row-sub muted">{row.note}</span> : null}
      {row.invoiceRef ? (
        <span className="row-sub muted">
          {row.invoiceRef}
          {row.amountText ? `, ${row.amountText}` : ""}
        </span>
      ) : null}
      {row.serial ? <span className="row-sub muted">{row.serial}</span> : null}
      {row.carrier && row.tracking ? (
        <span className="row-sub muted">
          {row.carrier} {row.tracking}
        </span>
      ) : null}
    </>
  );
}

function BuyerCell({ row }: { row: DriveAdminRow }) {
  if (!row.buyer) return <span className="muted">Deleted 60 days after it ended</span>;
  return (
    <>
      <span className="row-title">{row.buyer.name}</span>
      <span className="row-sub">
        <a href={`mailto:${row.buyer.email}`}>{row.buyer.email}</a>
      </span>
      <details className="drive-ship">
        <summary>Ship to</summary>
        <address className="drive-address">
          {[row.buyer.name, ...addressLines(row.buyer.address)].map((line) => (
            <span key={line}>{line}</span>
          ))}
        </address>
      </details>
    </>
  );
}

function QueueTable({ rows, now, caption, actions }: { rows: DriveAdminRow[]; now: number; caption: string; actions: boolean }) {
  // Open orders wait at their status; closed ones say when they ended.
  return (
    <div className="table-wrap">
      <table className="data data-list drive-queue">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Buyer</th>
            <th scope="col">Status</th>
            <th scope="col">{actions ? "Waiting since" : "Closed"}</th>
            {actions ? <th scope="col">Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.overdue ? "drive-overdue" : undefined}>
              <td>
                <Link href={`/orders/${row.id}`} className="row-title">
                  {row.title}
                </Link>
                <span className="row-sub muted">
                  {buildLabel(row.build, row.files.length)} · {row.id.slice(0, 8)}
                </span>
              </td>
              <td>
                <BuyerCell row={row} />
              </td>
              <td>
                <StatusCell row={row} />
              </td>
              <td className="train-nowrap">
                <time dateTime={row.since} title={dateTimeUtc(row.since)}>
                  {relativeTime(row.since, now)}
                </time>
              </td>
              {actions ? (
                <td>
                  <OrderActions orderId={row.id} actions={row.actions} />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The admin queue at /fine-tuning/orders (docs/VIBE_TUNING.md, Feature 6): open orders oldest first, one row each with
 * the model and build, the buyer's name, email and shipping address, the status and how long it has waited there, and
 * the actions it allows. A request nobody invoiced within 2 business days is highlighted. Delivered and cancelled orders
 * follow, with no actions.
 */
export function OrdersQueue({ open, closed, now }: { open: DriveAdminRow[]; closed: DriveAdminRow[]; now: number }) {
  return (
    <>
      <section className="section" aria-labelledby="orders-open">
        <div className="section-head">
          <h2 id="orders-open">Waiting on you</h2>
        </div>
        {open.length ? (
          <QueueTable rows={open} now={now} caption="Open drive orders, oldest first" actions />
        ) : (
          <p className="muted">No open orders. New requests show up here, and the notify webhook gets a line for each.</p>
        )}
      </section>
      {closed.length ? (
        <section className="section" aria-labelledby="orders-closed">
          <div className="section-head">
            <h2 id="orders-closed">Delivered and cancelled</h2>
          </div>
          <QueueTable rows={closed} now={now} caption="Delivered and cancelled drive orders, newest first" actions={false} />
        </section>
      ) : null}
    </>
  );
}
