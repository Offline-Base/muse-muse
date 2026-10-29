// Required on every product. Don't remove or reword it. A product made from one of Meta's developer videos passes the
// video's link as `credit` in app/layout.tsx, <Footer credit="https://..." />, which adds the one credit line it needs.
// Its look is the .footer class in app/globals.css: at the bottom of the screen, left aligned with the main column.
export function Footer({ credit }: { credit?: string }) {
  return (
    <footer className="footer">
      {credit ? (
        <p>
          Idea from{" "}
          <a href={credit} target="_blank" rel="noreferrer">
            a Meta developer video
          </a>
          .
        </p>
      ) : null}
      Built with Muse Muse. Not an official Meta product.
    </footer>
  );
}
