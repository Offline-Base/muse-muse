import Link from "next/link";

/**
 * Terms and Privacy under the sidebar's disclaimer, while the pages exist (TRUST_LEGAL_PAGES). It uses the disclaimer's
 * own style, so the shell's CSS stays as it is.
 */
export function TrustLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <p className="disclaimer" style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
      <Link href="/terms" onClick={onNavigate} style={{ color: "inherit" }}>
        Terms
      </Link>
      <Link href="/privacy" onClick={onNavigate} style={{ color: "inherit" }}>
        Privacy
      </Link>
    </p>
  );
}
