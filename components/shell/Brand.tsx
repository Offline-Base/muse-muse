import Link from "next/link";

/** The brand slot: "Muse Muse" plus the Concept pill. No logo image, no Meta wordmark. */
export function Brand() {
  return (
    <Link href="/" className="brand">
      <span className="brand-name">Muse Muse</span>
      <span className="concept">Concept</span>
    </Link>
  );
}
