import Link from "next/link";

/** Muse Muse's own mark: two sparkles. Nothing borrowed from Meta's logo. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={(size * 24) / 28} viewBox="0 0 28 24" aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M11 2.5l2.1 6a3 3 0 0 0 1.9 1.9l6 2.1-6 2.1a3 3 0 0 0-1.9 1.9l-2.1 6-2.1-6A3 3 0 0 0 7 14.6l-6-2.1 6-2.1a3 3 0 0 0 1.9-1.9l2.1-6z"
      />
      <path fill="currentColor" d="M23 1.5l.95 2.55 2.55.95-2.55.95L23 8.5l-.95-2.55L19.5 5l2.55-.95L23 1.5z" />
    </svg>
  );
}

/** The brand slot: our mark, "Muse Muse" and the Concept pill. No Meta logo or wordmark. */
export function Brand({ onClick }: { onClick?: () => void }) {
  return (
    <Link href="/" className="brand" onClick={onClick}>
      <BrandMark />
      <span className="brand-name">Muse Muse</span>
      <span className="concept">Concept</span>
    </Link>
  );
}
