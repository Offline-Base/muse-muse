import Link from "next/link";
import type { ReactNode } from "react";
import { safeHref } from "@/lib/markdown-reply";

/**
 * Where a kit link may go: a path on this site, opened in place, or an http or https address, opened in a new tab.
 * Anything else, such as a javascript: URL in something an agent reported, gives null, so the kit can show what it's
 * handed without trusting it.
 */
export function chatHref(href: string | null | undefined): { href: string; external: boolean } | null {
  const value = (href ?? "").trim();
  // "//host" and "/\host" are other sites, as browsers read them.
  if (/^\/(?![/\\])/.test(value)) return { href: value, external: false };
  const safe = safeHref(value);
  return safe && !safe.startsWith("mailto:") ? { href: safe, external: true } : null;
}

/** A link for the kit's rows and thumbnails. Without a usable href it's a plain span with the same class. */
export function ChatLink({ href, className, children }: { href: string | null | undefined; className?: string; children: ReactNode }) {
  const link = chatHref(href);
  if (!link) return <span className={className}>{children}</span>;
  if (!link.external) {
    return (
      <Link href={link.href} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <a href={link.href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
