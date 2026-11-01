import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ReportForm } from "@/components/trust/ReportForm";
import { db, schema } from "@/lib/db/client";
import { REPORT_REASONS } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { REASON_LABELS } from "@/lib/trust/reports";

export const metadata: Metadata = { title: "Report a product" };

/**
 * Where every product's Report link goes (TRUST_REPORTS, docs/CAPABILITIES.md, section 7). Anyone can open it, signed
 * in or not. Requests to delete data come here too, as "privacy".
 */
export default async function ReportPage({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  if (!env.trustReports) notFound();
  const { slug } = await params;
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) notFound();
  const [product] = await db()
    .select({ name: schema.products.name, takenDownAt: schema.products.takenDownAt })
    .from(schema.products)
    .where(eq(schema.products.slug, slug))
    .limit(1)
    .catch(() => []);
  const name = product && !product.takenDownAt ? product.name : null;
  return (
    <div className="page page-narrow">
      <section className="card signin">
        <h1>Report {name ? `“${name}”` : "a product"}</h1>
        <p className="muted">
          Tell the Muse Muse team what&apos;s wrong. You don&apos;t need to sign in. To ask for your data to be deleted, pick the
          one about personal information.
        </p>
        <ReportForm slug={slug} reasons={REPORT_REASONS.map((id) => ({ id, label: REASON_LABELS[id] }))} />
      </section>
    </div>
  );
}
