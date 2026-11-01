// Platform file (Muse Muse trust). Don't edit: the platform puts it back before every check.
//
// The age gate proxy.ts sends a first visit to. One tap, posted to /api/musemuse/age, which remembers it in this
// browser and goes back to where the visitor was headed.
import type { Metadata } from "next";
import { safeNext, TRUST } from "@/lib/platform/trust";

export const metadata: Metadata = { title: "18 and older" };

export default async function AgePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const next = safeNext(typeof sp.next === "string" ? sp.next : null);
  const under = sp.under === "1";
  return (
    <main className="stack" style={{ maxWidth: 520, margin: "0 auto", padding: "48px var(--gutter)" }}>
      <h1>{TRUST.product.name}</h1>
      {under ? (
        <p>Sorry, this app is only for people 18 and older.</p>
      ) : (
        <>
          <p>This app is for people 18 and older. It uses Meta&apos;s models, and Meta&apos;s terms set that age.</p>
          <form method="post" action="/api/musemuse/age" className="stack">
            <input type="hidden" name="next" value={next} />
            <button type="submit" className="primary">
              I&apos;m 18 or older
            </button>
          </form>
          <p>
            <a href="/age?under=1">I&apos;m under 18</a>
          </p>
        </>
      )}
      {TRUST.legalPages ? (
        <p style={{ color: "var(--fg-2)" }}>
          <a href="/privacy">Privacy</a> and <a href="/terms">Terms</a>
        </p>
      ) : null}
    </main>
  );
}
