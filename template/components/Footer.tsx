// Required on every product. Don't remove or reword it. A product made from one of Meta's developer videos passes the
// video's link as `credit` in app/layout.tsx, <Footer credit="https://..." />, which adds the one credit line it needs.
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
      {process.env.MUSE_CONTRIBUTOR_NOTICE === "1" ? <p style={{ margin: "0 0 8px" }}>This product runs on a model Meta may train on. Don't enter personal or sensitive information.</p> : null}
      Built with Muse Muse. Not an official Meta product.
    </footer>
  );
}
