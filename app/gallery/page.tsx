import type { Metadata } from "next";
import { connection } from "next/server";
import { ProductCard } from "@/components/product/ProductCard";
import { EmptyCard, NotConnected, PageHeader } from "@/components/ui";
import { listShippedProducts, safeQuery } from "@/lib/queries";

export const metadata: Metadata = { title: "Gallery" };

export default async function Gallery() {
  await connection();
  const result = await safeQuery(() => listShippedProducts(60));
  return (
    <div className="page">
      <PageHeader
        title="Gallery"
        subtitle="Every product Muse Muse shipped, with the muse it came from, the models it uses and its recorded demo."
      />
      {!result.ok ? (
        <NotConnected reason={result.reason} what="the gallery" />
      ) : result.data.length === 0 ? (
        <EmptyCard title="Nothing shipped yet" action={{ href: "/", label: "Start a muse" }}>
          <p>Products show up here once they pass their checks and go live.</p>
        </EmptyCard>
      ) : (
        <div className="grid-cards">
          {result.data.map((p) => (
            <ProductCard key={p.slug} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}
