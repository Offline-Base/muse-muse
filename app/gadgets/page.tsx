import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { BoardsSlot } from "@/components/gadgets/BoardsSlot";
import { GADGET_TOOLS, HOUSE_BOARDS, gadgetProducts, gadgetStatusRows } from "@/components/gadgets/info";
import { Icon } from "@/components/icons";
import { ProductCard } from "@/components/product/ProductCard";
import { EmptyCard, NotConnected, PageHeader, StatusPill } from "@/components/ui";
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
  const status = gadgetStatusRows({ buildsOn: env.gadgetsEnabled, boardSetUp: deviceConfig({ quiet: true }) !== null });

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
            <li>Products can&apos;t run commands on a board. {env.hardwareBoardToolsUsable ? "Besides the three tools above, a product that asks for board tools can read a sensor and show a short line." : "Only the three tools above are served."}</li>
            {env.driveToolsUsable ? <li>A product that asks can also put its own tuned model on a USB drive, for its owner only, on the owner&apos;s board, after they confirm it on a card. It never erases a drive.</li> : null}
            <li>A product must still work with no board, with a clear message and a way to upload instead.</li>
          </ul>
        </div>
      </section>

      <section className="section" aria-labelledby="boards-title">
        <div className="section-head">
          <h2 id="boards-title">Boards on hand</h2>
        </div>
        <ul className="gadgets-boards">
          {HOUSE_BOARDS.map((b) => (
            <li key={b.key} className="card gadgets-board">
              {/* The owner's pictures as given: white background, no tile behind them, no cutout. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="gadgets-board-art"
                src={b.image}
                alt=""
                width={564}
                height={640}
                loading="lazy"
                decoding="async"
              />
              <div className="gadgets-board-text">
                <h3>{b.name}</h3>
                <ul className="chips" aria-label={`About the ${b.name}`}>
                  <li className="chip">{b.count} on hand</li>
                  <li className="chip">{b.role}</li>
                </ul>
                <p className="muted">{b.text}</p>
              </div>
            </li>
          ))}
        </ul>
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
                  <StatusPill status={row.on ? "live" : "disabled"} label={row.value} />
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

      <BoardsSlot viewer={viewer} />
    </div>
  );
}
