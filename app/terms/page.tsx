import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { LegalPage } from "@/components/trust/LegalPage";
import { env } from "@/lib/env";
import { TERMS_SECTIONS, TERMS_UPDATED, TERMS_VERSION } from "@/lib/trust/terms";

export const metadata: Metadata = { title: "Terms" };

// DRAFT (wave 3, unit 1): the text in lib/trust/terms.ts is a plain draft for the Muse Muse owner and counsel to review
// before anyone relies on it. It is not legal advice. With TRUST_LEGAL_PAGES off this page doesn't exist.
export default async function TermsPage() {
  // Rendered per request, so the flag is read at run time like the others.
  await connection();
  if (!env.trustLegalPages) notFound();
  return <LegalPage title="Terms" updated={TERMS_UPDATED} version={TERMS_VERSION} sections={TERMS_SECTIONS} />;
}
