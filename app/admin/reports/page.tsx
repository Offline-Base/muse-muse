import type { Metadata } from "next";
import { asc, desc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { AdminReportActions } from "@/components/trust/AdminReportActions";
import "@/components/trust/trust.css";
import { requireAdmin } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { relativeTime } from "@/lib/format";
import { REASON_LABELS } from "@/lib/trust/reports";

export const metadata: Metadata = { title: "Reports" };

/**
 * Admins review reports here (TRUST_REPORTS, docs/CAPABILITIES.md, section 7): open ones first, then the newest. Each
 * row shows what was reported and why, never who reported it. Anyone else gets a 404.
 */
export default async function AdminReportsPage() {
  await connection();
  // Delete requests from /privacy land here too, so the page is on whenever either flag is.
  if (!env.trustReports && !env.trustLegalPages) notFound();
  try {
    await requireAdmin();
  } catch {
    notFound();
  }
  const rows = await db()
    .select({
      id: schema.abuseReports.id,
      slug: schema.abuseReports.productSlug,
      reason: schema.abuseReports.reason,
      detail: schema.abuseReports.detail,
      status: schema.abuseReports.status,
      createdAt: schema.abuseReports.createdAt,
      productId: schema.products.id,
      name: schema.products.name,
      takenDownAt: schema.products.takenDownAt,
      takedownReason: schema.products.takedownReason,
      ownerId: schema.products.ownerId,
      ownerEmail: schema.users.email,
      ownerBannedAt: schema.users.bannedAt,
    })
    .from(schema.abuseReports)
    .leftJoin(schema.products, eq(schema.products.id, schema.abuseReports.productId))
    .leftJoin(schema.users, eq(schema.users.id, schema.products.ownerId))
    .orderBy(asc(sql`case when ${schema.abuseReports.status} = 'open' then 0 else 1 end`), desc(schema.abuseReports.createdAt))
    .limit(200);
  const now = Date.now();
  const open = rows.filter((r) => r.status === "open").length;

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-text">
          <h1>Reports</h1>
          <p className="subtitle">
            {open} open, {rows.length} shown. Reporters are never shown here.
          </p>
        </div>
      </div>
      {rows.length ? (
        <div className="trust-table-wrap">
          <table className="trust-table">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Why</th>
                <th scope="col">When</th>
                <th scope="col">What to do</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.productId && !r.takenDownAt ? <Link href={`/p/${r.slug}`}>{r.name ?? r.slug}</Link> : <span>{r.name ?? r.slug}</span>}
                    {r.takenDownAt ? <p className="muted small">Taken down: {r.takedownReason}</p> : null}
                    {r.ownerEmail ? <p className="muted small">Owner: {r.ownerEmail}{r.ownerBannedAt ? " (banned)" : ""}</p> : null}
                    {!r.productId ? <p className="muted small">No product has this link.</p> : null}
                  </td>
                  <td>
                    <strong>{REASON_LABELS[r.reason] ?? r.reason}</strong>
                    {r.detail ? <p className="trust-detail">{r.detail}</p> : null}
                    <p className="muted small">{r.status}</p>
                  </td>
                  <td>{relativeTime(r.createdAt.toISOString(), now)}</td>
                  <td>
                    <AdminReportActions
                      reportId={r.id}
                      status={r.status}
                      slug={r.productId ? r.slug : null}
                      takenDown={Boolean(r.takenDownAt)}
                      ownerId={r.ownerId}
                      ownerBanned={Boolean(r.ownerBannedAt)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No reports yet.</p>
      )}
    </div>
  );
}
