import type { Metadata } from "next";
import { connection } from "next/server";
import { ComposerDock } from "@/components/gallery/ComposerDock";
import { Creations } from "@/components/gallery/Creations";
import "@/components/gallery/gallery.css";
import { Presets } from "@/components/gallery/Presets";
import { NotConnected } from "@/components/ui";
import { creationsOf } from "@/lib/gallery/filter";
import { MEDIA_PRESETS } from "@/lib/gallery/presets";
import { listShippedProducts, safeQuery } from "@/lib/queries";

export const metadata: Metadata = { title: "Media" };

export default async function MediaPage() {
  await connection();
  const result = await safeQuery(() => listShippedProducts(60));
  return (
    <div className="page gx-page">
      <h1 className="sr-only">Media</h1>
      <Presets presets={MEDIA_PRESETS} />
      {result.ok ? <Creations items={creationsOf(result.data)} /> : <NotConnected reason={result.reason} what="the media" />}
      <ComposerDock />
    </div>
  );
}
