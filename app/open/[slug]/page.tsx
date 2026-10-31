import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import "@/components/product/get-it.css";
import { ExternalLink } from "@/components/ui";
import { env } from "@/lib/env";
import { shippedProductBySlug } from "@/lib/native/queries";
import { safeHttpUrl } from "@/lib/native/product-view";
import { appLink } from "@/lib/native/shell-links";
import { safeQuery } from "@/lib/queries";

export const metadata: Metadata = { title: "Open in the iPhone app" };

/**
 * Where the glasses panel's QR code lands. A phone's camera can only open a web link, so this page hands off to the
 * Muse Muse iPhone app, with the live product as the way out for anyone without it.
 */
export default async function OpenInAppPage({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  if (!env.glassesEnabled) notFound();
  const { slug } = await params;
  const result = await safeQuery(() => shippedProductBySlug(slug));
  const product = result.ok ? result.data : null;
  if (!product || !product.targets.includes("glasses")) notFound();
  return (
    <div className="page open-app">
      <h1>{product.name}</h1>
      <p className="subtitle">Open it in the Muse Muse iPhone app to use it with your glasses.</p>
      <a className="btn btn-primary btn-block" href={appLink(slug)}>
        Open in the iPhone app
      </a>
      <p className="muted small">The app isn&apos;t on the App Store. If you don&apos;t have it, this button does nothing.</p>
      {safeHttpUrl(product.liveUrl) ? (
        <p className="small">
          <ExternalLink href={product.liveUrl}>Open it in your browser instead</ExternalLink>. It uses your phone&apos;s camera or a sample view.
        </p>
      ) : null}
    </div>
  );
}
