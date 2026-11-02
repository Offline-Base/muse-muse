import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Icon } from "@/components/icons";
import { EmptyCard, NotConnected, PageHeader, StatusPill } from "@/components/ui";
import { dateTimeUtc, elapsedMs, isTerminalStatus, relativeTime, shortDuration, truncate, usd } from "@/lib/format";
import { editTargets } from "@/lib/edit-pass";
import { currentUser, listUserBuilds, safeQuery } from "@/lib/queries";

export const metadata: Metadata = { title: "Musings" };

export default async function BuildsPage() {
  await connection();
  const user = await currentUser();
  if (!user) {
    return (
      <div className="page">
        <PageHeader title="Musings" subtitle="Every muse you've sent, with its status, time and cost." />
        <EmptyCard
          icon="user"
          title="Sign in to see your musings"
          action={{ href: "/sign-in?next=%2Fbuilds", label: "Sign in" }}
        >
          <p>Browsing is open to everyone. Your own musings show up here once you sign in.</p>
        </EmptyCard>
      </div>
    );
  }

  const result = await safeQuery(() => listUserBuilds(user.id));
  // The action on a product's newest row only, and for a shared guest only what this browser's pass covers.
  const edits = result.ok ? await safeQuery(() => editTargets(user, result.data.map((b) => b.productId))) : null;
  const editable = edits?.ok ? edits.data : new Map<string, string>();
  const offered = new Set<string>();
  const now = Date.now();
  return (
    <div className="page">
      <PageHeader
        title="Musings"
        subtitle={
          user.openAccess && !user.isAdmin
            ? "Every muse sent from the shared guest account, with its status, time and cost."
            : "Every muse you've sent, with its status, time and cost."
        }
        actions={
          <Link className="btn btn-primary" href="/">
            <Icon name="plus" size={18} />
            Start musing
          </Link>
        }
      />
      {!result.ok ? (
        <NotConnected reason={result.reason} what="your build list" />
      ) : result.data.length === 0 ? (
        <EmptyCard title="Your first musing starts here" action={{ href: "/", label: "Start musing" }}>
          <p>Drop in a photo, a sketch, a short video, a voice memo or a PDF and Muse Code builds it.</p>
        </EmptyCard>
      ) : (
        <div className="table-wrap">
          <table className="data data-list">
            <caption className="sr-only">Builds, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Build</th>
                <th scope="col">Status</th>
                <th scope="col">Started</th>
                <th scope="col">Time</th>
                <th scope="col" className="num">
                  Cost (est.)
                </th>
              </tr>
            </thead>
            <tbody>
              {result.data.map((b) => {
                const title = b.name ?? (b.note ? truncate(b.note, 60) : "Untitled muse");
                const sub =
                  b.kind === "refine"
                    ? `Change: ${truncate(b.message ?? "", 70)}`
                    : b.note && b.name
                      ? truncate(b.note, 80)
                      : null;
                const ms = elapsedMs(b.startedAt, b.finishedAt, now);
                const editId = b.productId && !offered.has(b.productId) ? editable.get(b.productId) : undefined;
                if (b.productId) offered.add(b.productId);
                return (
                  <tr key={b.id}>
                    <td>
                      <Link href={`/b/${b.id}`} className="row-title">
                        {title}
                      </Link>
                      {sub ? <span className="row-sub muted">{sub}</span> : null}
                      {editId ? (
                        <span className="row-actions">
                          <Link className="btn btn-sm" href={`/b/${editId}?refine=1#refine`} aria-label={`Keep editing ${title}`}>
                            <Icon name="edit" size={16} />
                            Keep editing
                          </Link>
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <StatusPill status={b.status} />
                    </td>
                    <td>
                      <time dateTime={b.startedAt} title={dateTimeUtc(b.startedAt)}>
                        {relativeTime(b.startedAt, now)}
                      </time>
                    </td>
                    <td>{isTerminalStatus(b.status) || ms ? shortDuration(ms) : ""}</td>
                    <td className="num">{usd(b.costUsd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
