import type { Metadata } from "next";
import { connection } from "next/server";
import { ComposerDock } from "@/components/gallery/ComposerDock";
import { DemoWall } from "@/components/gallery/DemoWall";
import "@/components/gallery/gallery.css";
import { EmptyCard, NotConnected } from "@/components/ui";
import { listShippedProducts, safeQuery } from "@/lib/queries";

export const metadata: Metadata = { title: "Demos" };

export default async function DemosPage() {
  await connection();
  const result = await safeQuery(() => listShippedProducts(60));
  const demos = result.ok ? result.data.filter((p) => p.demoVideoUrl) : [];
  return (
    <div className="page gx-page">
      <h1 className="sr-only">Demos</h1>
      {!result.ok ? (
        <NotConnected reason={result.reason} what="the demos" />
      ) : demos.length === 0 ? (
        <EmptyCard title="No demos yet" action={{ href: "/", label: "Start a muse" }}>
          <p>Each product's demo video shows up here once it goes live.</p>
        </EmptyCard>
      ) : (
        <DemoWall products={demos} />
      )}
      <ComposerDock />
    </div>
  );
}
