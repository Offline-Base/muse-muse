// Platform file (Muse Muse trust). Required on every product. Don't remove, reword or edit it: the platform puts it back
// before every check. A product made from one of Meta's developer videos passes the video's link as `credit` in
// app/layout.tsx, <Footer credit="https://..." />, which adds the one credit line it needs.
import { TRUST } from "@/lib/platform/trust";

const linkStyle = { color: "inherit" } as const;

export function Footer({ credit }: { credit?: string }) {
  return (
    <footer
      style={{
        maxWidth: "calc(var(--page-width) + 2 * var(--gutter))",
        margin: "0 auto",
        padding: "8px var(--gutter) 40px",
        color: "var(--fg-2)",
        font: "var(--type-meta)",
      }}
    >
      {credit ? (
        <p style={{ margin: "0 0 8px" }}>
          Idea from{" "}
          <a href={credit} target="_blank" rel="noreferrer">
            a Meta developer video
          </a>
          .
        </p>
      ) : null}
      <p style={{ margin: 0 }}>Built with Muse Muse. Not an official Meta product. It uses AI, which can make mistakes.</p>
      <nav aria-label="About this app" style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", marginTop: 8 }}>
        {TRUST.legalPages ? (
          <>
            <a href="/privacy" style={linkStyle}>
              Privacy
            </a>
            <a href="/terms" style={linkStyle}>
              Terms
            </a>
          </>
        ) : null}
        {TRUST.reportUrl ? (
          <a href={TRUST.reportUrl} target="_blank" rel="noreferrer" style={linkStyle}>
            Report
          </a>
        ) : null}
      </nav>
    </footer>
  );
}
