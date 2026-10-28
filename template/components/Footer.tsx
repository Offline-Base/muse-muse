// Required on every product. Don't remove or reword it.
export function Footer() {
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
      Built with Muse Muse. Not an official Meta product.
    </footer>
  );
}
