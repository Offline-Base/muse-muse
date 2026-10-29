import Link from "next/link";
import { CancelOrder } from "@/components/drive/CancelOrder";
import { DRIVE_STATUS_LABEL, DRIVE_STEPS, addressLines, driveTone, nextStepText, trackingHref, wasPaid } from "@/components/drive/format";
import { LocalTime } from "@/components/drive/LocalTime";
import { Icon } from "@/components/icons";
import { ExternalLink, PageHeader } from "@/components/ui";
import { BUYER_KEEP_DAYS, buildLabel, gb, type DriveOrderView } from "@/lib/drive/logic";

/** Where each step stands for an order: done, the one it is at, or still to come. */
function stepState(order: DriveOrderView, index: number): "done" | "active" | "pending" | "skipped" {
  const at = DRIVE_STEPS.findIndex((s) => s.status === order.status);
  if (order.status === "cancelled") return order.at[DRIVE_STEPS[index].status] ? "done" : "skipped";
  if (index < at) return "done";
  if (index === at) return order.status === "delivered" ? "done" : "active";
  return "pending";
}

/** Where a buyer writes about their order: the contact address when the site has one, else the invoice's email. */
function ContactLine({ contact, invoiced }: { contact: string | null; invoiced: boolean }) {
  if (contact) {
    return (
      <p className="muted small">
        Questions about your order? Write to <a href={`mailto:${contact}`}>{contact}</a>.
      </p>
    );
  }
  return invoiced ? <p className="muted small">Questions about your order? Reply to your invoice&apos;s email.</p> : null;
}

/**
 * One order as its buyer sees it at /orders/{id} (docs/VIBE_TUNING.md, Feature 6): where it stands, what happens next,
 * what goes on the drive, where it ships, where to write, and Cancel until the bench starts writing it. Times are the
 * reader's own. A server component: the page hands it the order only after checking the link's secret (or an admin),
 * so the address reaches nobody else. An admin sees the same page, titled as theirs to look at, not to own.
 */
export function OrderView({ order, adminView = false, contact = null }: { order: DriveOrderView; adminView?: boolean; contact?: string | null }) {
  const bytes = order.files.reduce((n, f) => n + f.bytes, 0);
  const track = order.status === "shipped" || order.status === "delivered" ? trackingHref(order.carrier, order.tracking) : null;
  return (
    <div className="page">
      <PageHeader
        title={adminView ? "Flash drive order" : "Your flash drive order"}
        subtitle={
          <>
            {order.title} · {buildLabel(order.build, order.files.length)} · requested{" "}
            {order.at.requested ? <LocalTime iso={order.at.requested} /> : null}{" "}
            <span className={`pill pill-${driveTone(order.status)}`}>
              <span className="pill-dot" aria-hidden />
              {DRIVE_STATUS_LABEL[order.status]}
            </span>
          </>
        }
        actions={
          adminView ? (
            <Link className="btn btn-outline" href="/fine-tuning/orders">
              <Icon name="chevronLeft" size={18} />
              All orders
            </Link>
          ) : null
        }
      />

      <section className="card section-card" aria-labelledby="order-next">
        <h2 id="order-next">{adminView ? "What the buyer reads next" : "What happens next"}</h2>
        <p>{nextStepText(order)}</p>
        {track ? (
          <p>
            <ExternalLink href={track}>Track it on USPS</ExternalLink>
          </p>
        ) : null}
        {order.buyerCanCancel && !adminView ? <CancelOrder orderId={order.id} paid={wasPaid(order)} /> : null}
        {adminView ? null : <ContactLine contact={contact} invoiced={Boolean(order.at.invoiced)} />}
      </section>

      <div className="two-col">
        <section className="card section-card" aria-labelledby="order-steps">
          <h2 id="order-steps">Where it stands</h2>
          <ol className="rail drive-steps">
            {DRIVE_STEPS.map((step, i) => {
              const state = stepState(order, i);
              const when = order.at[step.status];
              return (
                <li key={step.status} className={`rail-step rail-${state}`} aria-current={state === "active" ? "step" : undefined}>
                  <span className="rail-dot" aria-hidden>
                    {state === "done" ? <Icon name="check" size={12} /> : null}
                  </span>
                  <span className="rail-text">
                    <span className="rail-label">{step.label}</span>
                    <span className="rail-sub">{when ? <LocalTime iso={when} /> : step.sub}</span>
                  </span>
                </li>
              );
            })}
            {order.status === "cancelled" ? (
              <li className="rail-step rail-failed">
                <span className="rail-dot" aria-hidden />
                <span className="rail-text">
                  <span className="rail-label">Cancelled</span>
                  <span className="rail-sub">{order.at.cancelled ? <LocalTime iso={order.at.cancelled} /> : ""}</span>
                </span>
              </li>
            ) : null}
          </ol>
        </section>

        <section className="card section-card" aria-labelledby="order-what">
          <h2 id="order-what">What&apos;s on the drive</h2>
          <dl className="kv">
            <div>
              <dt>Model</dt>
              <dd>
                <Link href={`/fine-tuning/${order.trainingJobId}`}>{order.title}</Link>
              </dd>
            </div>
            {order.files.map((f) => (
              <div key={f.level}>
                <dt>{f.level}</dt>
                <dd>{gb(f.bytes)}</dd>
              </div>
            ))}
            <div>
              <dt>In all</dt>
              <dd>{gb(bytes)}, plus the runtime</dd>
            </div>
            {order.serial ? (
              <div>
                <dt>Serial</dt>
                <dd>{order.serial}</dd>
              </div>
            ) : null}
            <div>
              <dt>Files from</dt>
              <dd>
                <ExternalLink href={`https://huggingface.co/${order.repo}/tree/${order.commit}`}>{order.repo}</ExternalLink>
              </dd>
            </div>
          </dl>
          <p className="muted small">
            Every file is checked against its SHA-256 after the drive is written. Verify on the drive checks them again.
          </p>
        </section>
      </div>

      <section className="card section-card" aria-labelledby="order-ship">
        <h2 id="order-ship">Shipping to</h2>
        {order.buyer ? (
          <>
            <address className="drive-address">
              {[order.buyer.name, ...addressLines(order.buyer.address)].map((line) => (
                <span key={line}>{line}</span>
              ))}
            </address>
            <p>
              Invoice to <strong>{order.buyer.email}</strong>
            </p>
          </>
        ) : (
          <p className="muted">We deleted the name, email and address on this order {BUYER_KEEP_DAYS} days after it ended.</p>
        )}
        <p className="muted small">
          We keep your name, email and address to ship this drive, and delete them {BUYER_KEEP_DAYS} days after delivery or
          cancellation. Only this link and the people who ship it can see them.
        </p>
      </section>
    </div>
  );
}
