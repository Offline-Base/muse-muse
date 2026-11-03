import Link from "next/link";

/**
 * The Offline Base logo (the house), from the owner's logo files (Nov 2). Two files, one per theme: the dark-stroke one on
 * light pages, the white one on dark pages. CSS shows the one that matches the theme (globals.css, .brand-mark).
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element -- a 120 px PNG drawn at 28 px, nothing to optimize */}
      <img className="brand-mark-light" src="/brand/base-logo-light.png" alt="" width={size} height={size} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="brand-mark-dark" src="/brand/base-logo-dark.png" alt="" width={size} height={size} />
    </span>
  );
}

/** The brand slot: the logo, "Muse Muse" and the Concept pill. No Meta logo or wordmark. */
export function Brand({ onClick }: { onClick?: () => void }) {
  return (
    <Link href="/" className="brand" onClick={onClick}>
      <BrandMark />
      <span className="brand-name">Muse Muse</span>
      <span className="concept">Concept</span>
    </Link>
  );
}
