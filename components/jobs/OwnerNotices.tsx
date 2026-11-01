import Link from "next/link";
import { NoticeActions } from "@/components/jobs/NoticeActions";
import { listNotices } from "@/lib/caps/jobs/store";
import { env } from "@/lib/env";
import { relativeTime } from "@/lib/format";
import { currentUser } from "@/lib/queries";

/**
 * What a person's background jobs left for them (docs/CAPABILITIES.md, section 12), on the dashboard. Renders nothing while
 * the jobs cap is off, and reads nothing either. A drafted message shows whole, since confirming it sends exactly that.
 */
export async function OwnerNotices() {
  if (!env.servedCaps.includes("jobs")) return null;
  const user = await currentUser();
  // The shared guest account can't tell who owns what, and guests' products have no jobs anyway.
  if (!user || user.openAccess) return null;
  const notices = await listNotices(user.id).catch((err: unknown) => {
    console.error("[jobs] notices:", err instanceof Error ? err.message : "unknown");
    return [];
  });
  if (!notices.length) return null;
  const now = Date.now();
  return (
    <section className="dash-card owner-notices" aria-label="From your background jobs">
      <h2 className="dash-label">From your background jobs</h2>
      <ul className="owner-notice-list">
        {notices.map((n) => (
          <li key={n.id} className="owner-notice">
            <p>
              <strong>{n.title}</strong>{" "}
              <span className="muted small">
                <Link href={`/p/${n.productSlug}`}>{n.productName}</Link>, {relativeTime(n.createdAt.toISOString(), now)}
              </span>
            </p>
            {n.body ? <p className="owner-notice-body">{n.body}</p> : null}
            <NoticeActions slug={n.productSlug} id={n.id} held={n.kind === "send_held"} />
          </li>
        ))}
      </ul>
      <style>{`
        .owner-notices { margin-block-end: 16px; }
        .owner-notice-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
        .owner-notice { display: grid; gap: 6px; min-width: 0; }
        .owner-notice-body { white-space: pre-wrap; overflow-wrap: anywhere; }
        .owner-notice-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      `}</style>
    </section>
  );
}
