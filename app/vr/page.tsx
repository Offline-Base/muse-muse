import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import "@/components/product/get-it.css";
import { EmptyCard, NotConnected } from "@/components/ui";
import { env } from "@/lib/env";
import { listVrProducts } from "@/lib/native/queries";
import { safeQuery } from "@/lib/queries";

export const metadata: Metadata = { title: "VR products" };

/** The list to bookmark once in Quest Browser, since Quest can't scan a link. Large tiles, so a controller's ray finds them. */
export default async function VrPage() {
  await connection();
  if (!env.vrEnabled) notFound();
  const result = await safeQuery(() => listVrProducts());
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="the VR products" />
      </div>
    );
  }
  return (
    <div className="page vr-list">
      <header className="vr-list-head">
        <h1>VR products</h1>
        <p className="subtitle">Bookmark this page in Quest Browser. Pick a product, then press Enter VR.</p>
      </header>
      {result.data.length ? (
        <ul className="vr-tiles">
          {result.data.map((p) => (
            <li key={p.slug}>
              {/* A plain link: /q/<slug> is a route that redirects to the product's own site. */}
              <a className="vr-tile" href={`/q/${p.slug}`}>
                <span className="vr-tile-name">{p.name}</span>
                {p.tagline ? <span className="vr-tile-line">{p.tagline}</span> : null}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyCard icon="monitor" title="No VR products yet">
          <p>They show here once one ships.</p>
        </EmptyCard>
      )}
    </div>
  );
}
