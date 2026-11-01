// Platform file (Muse Muse trust). Don't edit: the platform puts it back before every check.
//
// DRAFT: this wording is a plain-language draft for the Muse Muse owner and counsel to review. It is not legal advice.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TRUST } from "@/lib/platform/trust";

export const metadata: Metadata = { title: "Terms" };

const section = { margin: "24px 0 8px" } as const;

export default function TermsPage() {
  if (!TRUST.legalPages) notFound();
  const { name } = TRUST.product;
  return (
    <main className="stack" style={{ maxWidth: "calc(var(--page-width) + 2 * var(--gutter))", margin: "0 auto", padding: "24px var(--gutter)" }}>
      <h1>Terms</h1>
      <p style={{ color: "var(--fg-2)" }}>
        For using {name}. Last updated {TRUST.updated}. Version {TRUST.termsVersion}.
      </p>
      <h2 style={section}>What it is</h2>
      <p>
        {name} was made with Muse Muse, a concept project built on Meta&apos;s models. It is not an official Meta product, and it isn&apos;t
        made by Meta.
      </p>
      <h2 style={section}>Who can use it</h2>
      <ul>
        <li>You must be 18 or older.</li>
        <li>You can&apos;t use it from a country or region where Meta&apos;s terms don&apos;t allow its models.</li>
      </ul>
      <h2 style={section}>Using it well</h2>
      <ul>
        <li>What it says or makes comes from AI. It can be wrong, incomplete or out of date. Check anything that matters before you rely on it.</li>
        <li>Don&apos;t use it to break the law, to hurt or deceive people, or in ways Meta&apos;s Acceptable Use Policy doesn&apos;t allow.</li>
        <li>Don&apos;t put in passwords, payment details or other people&apos;s private information.</li>
      </ul>
      <h2 style={section}>No promises</h2>
      <p>
        It is offered as it is, for trying ideas out. It can change, stop for the day when its budget runs out, or go away. To the extent
        the law allows, nobody behind it is responsible for losses from using it.
      </p>
      {TRUST.reportUrl ? (
        <>
          <h2 style={section}>Problems</h2>
          <p>
            If something is wrong or harmful, use the <a href={TRUST.reportUrl}>Report</a> page.
          </p>
        </>
      ) : null}
    </main>
  );
}
