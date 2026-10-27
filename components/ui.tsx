import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/icons";
import { modelLabel, statusLabel, statusTone } from "@/lib/format";

/** Small presentational pieces shared by server pages and client components. No hooks, no server imports. */

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const tone = statusTone(status);
  return (
    <span className={`pill pill-${tone}`}>
      <span className="pill-dot" aria-hidden />
      {label ?? statusLabel(status)}
    </span>
  );
}

export function ModelChips({ models, label = "Models" }: { models: string[]; label?: string }) {
  if (!models.length) return null;
  return (
    <ul className="chips" aria-label={label}>
      {models.map((m) => (
        <li key={m} className="chip">
          {modelLabel(m)}
        </li>
      ))}
    </ul>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {subtitle ? <p className="subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-head-actions">{actions}</div> : null}
    </header>
  );
}

/** Shown wherever a page needs the database and it isn't there yet. */
export function NotConnected({
  reason,
  what = "this page",
}: {
  reason: "not_configured" | "unreachable";
  what?: string;
}) {
  return (
    <section className="card notice" role="status">
      <span className="notice-icon" aria-hidden>
        <Icon name="plug" />
      </span>
      <div>
        <h2>{reason === "not_configured" ? "Not connected yet" : "Can't reach the database"}</h2>
        <p className="muted">
          {reason === "not_configured"
            ? `The database for Muse Muse isn't set up on this deployment yet, so there's nothing to show for ${what}. Everything else still works.`
            : `The database didn't answer just now, so ${what} couldn't load. Try again in a moment.`}
        </p>
      </div>
    </section>
  );
}

export function EmptyCard({
  icon = "sparkle",
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <section className="card empty">
      <span className="empty-icon" aria-hidden>
        <Icon name={icon} size={24} />
      </span>
      <h2>{title}</h2>
      {children ? <div className="muted">{children}</div> : null}
      {action ? (
        <Link className="btn btn-primary" href={action.href}>
          {action.label}
        </Link>
      ) : null}
    </section>
  );
}

/** An info icon that reveals a short explanation. Works without JavaScript. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="tip">
      <summary aria-label={label}>
        <Icon name="info" size={16} />
      </summary>
      <div className="tip-body" role="note">
        {children}
      </div>
    </details>
  );
}

/** An external link that opens in a new tab and says so to screen readers. */
export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <Icon name="external" size={14} className="ext-icon" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
