import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { DataRequestForm } from "@/components/trust/DataRequestForm";
import { LegalPage } from "@/components/trust/LegalPage";
import { contributorBuildsOn, env } from "@/lib/env";
import { privacySections, TERMS_UPDATED, TERMS_VERSION } from "@/lib/trust/terms";

export const metadata: Metadata = { title: "Privacy" };

// DRAFT (wave 3, unit 1): the text in lib/trust/terms.ts is a plain draft for the Muse Muse owner and counsel to review
// before anyone relies on it. It is not legal advice. With TRUST_LEGAL_PAGES off this page doesn't exist.
export default async function PrivacyPage() {
  await connection();
  if (!env.trustLegalPages) notFound();
  return (
    <LegalPage
      title="Privacy"
      updated={TERMS_UPDATED}
      version={TERMS_VERSION}
      sections={privacySections({ sparkToWonder: env.trustSparkToWonder, buildsOnContributor: contributorBuildsOn(), guestMode: env.openAccess === "guest", reports: env.trustReports })}
    >
      {/* Posts a privacy request to /api/reports, which takes one while this page is on. Admins read them at /admin/reports, which needs TRUST_REPORTS today, or in the abuse_reports table. */}
      <DataRequestForm />
    </LegalPage>
  );
}
