import type { LegalSection } from "@/lib/trust/terms";
import "@/components/trust/trust.css";

/** The platform's Terms or Privacy page (TRUST_LEGAL_PAGES), from lib/trust/terms.ts. */
export function LegalPage({ title, updated, version, sections }: { title: string; updated: string; version: string; sections: readonly LegalSection[] }) {
  return (
    <div className="page">
      <article className="legal">
        <h1>{title}</h1>
        <p className="legal-meta">
          Last updated {updated}. Version {version}.
        </p>
        {sections.map((s) => (
          <section key={s.heading}>
            <h2>{s.heading}</h2>
            {s.paragraphs?.map((p) => <p key={p}>{p}</p>)}
            {s.bullets?.length ? (
              <ul>
                {s.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </article>
    </div>
  );
}
