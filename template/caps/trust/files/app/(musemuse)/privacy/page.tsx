// Platform file (Muse Muse trust). Don't edit: the platform puts it back before every check, and writes the facts it
// shows (musemuse.privacy.json) from this product's brief.
//
// DRAFT: this wording is a plain-language draft for the Muse Muse owner and counsel to review. It is not legal advice.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PRIVACY, TRUST } from "@/lib/platform/trust";

export const metadata: Metadata = { title: "Privacy" };

const section = { margin: "24px 0 8px" } as const;

export default function PrivacyPage() {
  if (!TRUST.legalPages) notFound();
  const { name } = TRUST.product;
  return (
    <main className="stack" style={{ maxWidth: "calc(var(--page-width) + 2 * var(--gutter))", margin: "0 auto", padding: "24px var(--gutter)" }}>
      <h1>Privacy</h1>
      <p style={{ color: "var(--fg-2)" }}>
        How {name} handles what you give it. Last updated {TRUST.updated}.
      </p>

      <h2 style={section}>What goes to Meta&apos;s models</h2>
      <p>
        {name} runs on Meta&apos;s models through Muse Muse. What you type or upload is sent to them to get an answer. Meta&apos;s own terms
        and privacy policy apply to what it receives.
      </p>
      <ul>
        {PRIVACY.models.map((m) => (
          <li key={m.id}>
            <strong>{m.label}</strong>: {m.does}
            {m.gets.length ? ` It gets ${m.gets.join(", ")}.` : ""}
          </li>
        ))}
      </ul>

      <h2 style={section}>What it keeps</h2>
      <ul>
        {PRIVACY.keeps.map((k) => (
          <li key={k}>{k}</li>
        ))}
        {PRIVACY.uploads ? <li>Large photos, videos and recordings go to temporary storage first, and are deleted after 24 hours.</li> : null}
        <li>Muse Muse counts how often the app is used, with your IP address, to keep it within its limits. Those counts are deleted within a day.</li>
      </ul>

      {PRIVACY.services.length ? (
        <>
          <h2 style={section}>Other services</h2>
          <ul>
            {PRIVACY.services.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </>
      ) : null}

      <h2 style={section}>Who can use it</h2>
      <p>You must be 18 or older. It isn&apos;t available in countries and regions where Meta&apos;s terms don&apos;t allow its models.</p>

      <h2 style={section}>Questions and deletion</h2>
      <p>
        {TRUST.reportUrl ? (
          <>
            To ask for something to be removed, or to report a problem, use the <a href={TRUST.reportUrl}>Report</a> page and pick the one
            about personal information.
          </>
        ) : (
          <>To ask for something to be removed, contact the person who shared this app with you.</>
        )}
      </p>
      <p style={{ color: "var(--fg-2)" }}>Built with Muse Muse. Not an official Meta product.</p>
    </main>
  );
}
