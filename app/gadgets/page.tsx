import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { GADGET_TOOLS, gadgetProducts, gadgetStatusRows } from "@/components/gadgets/info";
import { Icon } from "@/components/icons";
import { ProductCard } from "@/components/product/ProductCard";
import { EmptyCard, NotConnected, PageHeader } from "@/components/ui";
import { deviceConfig } from "@/lib/device/client";
import { env } from "@/lib/env";
import { listShippedProducts, safeQuery } from "@/lib/queries";
import { pageViewer } from "../fine-tuning/viewer";

export const metadata: Metadata = { title: "Gadgets" };

/** The newest shipped products read, as the gallery reads them, to find the ones with the gadget option. */
const PRODUCTS_READ = 60;

/**
 * Gadgets as a build option (docs/GADGETS.md), public and read-only. The status is plain words from the environment:
 * the board's address and key never reach this page, and nothing here calls the board.
 */
export default async function GadgetsPage() {
  await connection();
  const [viewer, products] = await Promise.all([
    pageViewer(),
    safeQuery(async () => gadgetProducts(await listShippedProducts(PRODUCTS_READ))),
  ]);
  const status = gadgetStatusRows({ buildsOn: env.gadgetsEnabled, boardSetUp: deviceConfig() !== null });

  return (
    <div className="page">
      <PageHeader title="Gadgets" subtitle="A gadget is a physical board a product can use to see and hear the real world." />

      <section className="section" aria-labelledby="what-title">
        <div className="section-head">
          <h2 id="what-title">What a gadget is</h2>
        </div>
        <div className="card section-card">
          <p>
            A small computer with a camera and a microphone, such as a Jetson board running <code>muse-device</code>.
            When a muse asks for hardware, the brief can add the gadget option next to the model that reads what the
            board captures, and the product reaches the board through Muse Muse&apos;s gateway.
          </p>
          <h3>What a product can ask a board to do</h3>
          <ol className="how">
            {GADGET_TOOLS.map((t) => (
              <li key={t.name} className="how-step">
                <span className="how-icon" aria-hidden>
                  <Icon name={t.icon} />
                </span>
                <h4 className="how-title">
                  <code>{t.name}</code>
                </h4>
                <p className="muted">{t.text}</p>
              </li>
            ))}
          </ol>
          <ul className="plain-list">
            <li>
              Every build gets a simulated board: the same receipt photo and three seconds of speech each time, so tests
              are steady and builds never reach real hardware.
            </li>
            <li>Products can&apos;t run commands on a board. Only the three tools above are served.</li>
            <li>A product must still work with no board, with a clear message and a way to upload instead.</li>
          </ul>
        </div>
      </section>

      <section className="section" aria-labelledby="status-title">
        <div className="section-head">
          <h2 id="status-title">Status</h2>
        </div>
        <div className="card">
          <dl className="kv gadgets-status">
            {status.map((row) => (
              <div key={row.label}>
                <dt>
                  {row.label}
                  <span className="row-sub muted">{row.note}</span>
                </dt>
                <dd>
                  <span className={`pill ${row.on ? "pill-live" : "pill-neutral"}`}>
                    <span className="pill-dot" aria-hidden />
                    {row.value}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
        {viewer?.isAdmin ? (
          <Link className="card vibe-run-link" href="/device">
            <span className="notice-icon" aria-hidden>
              <Icon name="mic" />
            </span>
            <span className="vibe-run-link-text">
              <strong>Device</strong>
              <span className="muted">Ask with the board&apos;s camera and microphone, and fine-tune on it. Admins only.</span>
            </span>
            <Icon name="chevronRight" className="vibe-run-link-go" />
          </Link>
        ) : null}
      </section>

      <section className="section" aria-labelledby="products-title">
        <div className="section-head">
          <h2 id="products-title">Products that use a gadget</h2>
        </div>
        {!products.ok ? (
          <NotConnected reason={products.reason} what="the products" />
        ) : products.data.length === 0 ? (
          <EmptyCard icon="chip" title="No products use a gadget yet">
            <p>Products built with the gadget option show up here once they ship.</p>
          </EmptyCard>
        ) : (
          <div className="grid-cards">
            {products.data.map((p) => (
              <ProductCard key={p.slug} p={p} />
            ))}
          </div>
        )}
      </section>

      <section className="card notice" aria-labelledby="coming-title">
        <span className="notice-icon" aria-hidden>
          <Icon name="plug" />
        </span>
        <div>
          <h2 id="coming-title">Planned: connect your own board</h2>
          <p className="muted">
            Today, live products with the option can only use a board Muse Muse sets up. Connecting your own board is
            planned.
          </p>
        </div>
      </section>
    </div>
  );
}
