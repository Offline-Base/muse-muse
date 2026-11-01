import type { Metadata } from "next";
import { connection } from "next/server";
import { ComposerDock } from "@/components/gallery/ComposerDock";
import "@/components/gallery/gallery.css";
import { Presets } from "@/components/gallery/Presets";
import { ProductBrowser } from "@/components/gallery/ProductBrowser";
import { EmptyCard, NotConnected } from "@/components/ui";
import { GALLERY_PRESETS } from "@/lib/gallery/presets";
import { listShippedProducts, safeQuery } from "@/lib/queries";

export const metadata: Metadata = { title: "Gallery" };

export default async function Gallery() {
  await connection();
  const result = await safeQuery(() => listShippedProducts(60));
  return (
    <div className="page gx-page">
      <h1 className="sr-only">Gallery</h1>
      <Presets presets={GALLERY_PRESETS} />
      {!result.ok ? (
        <NotConnected reason={result.reason} what="the gallery" />
      ) : result.data.length === 0 ? (
        <EmptyCard title="Nothing shipped yet" action={{ href: "/", label: "Start a muse" }}>
          <p>Products show up here once they pass their checks and go live.</p>
        </EmptyCard>
      ) : (
        <ProductBrowser products={result.data} />
      )}
      <ComposerDock />
    </div>
  );
}
