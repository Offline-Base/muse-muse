import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Icon } from "@/components/icons";
import { EmptyCard, NotConnected, PageHeader, StatusPill } from "@/components/ui";
import { dateTimeUtc, elapsedMs, isTerminalStatus, relativeTime, shortDuration, truncate, usd } from "@/lib/format";
import { currentUser, listUserBuilds, safeQuery } from "@/lib/queries";

export const metadata: Metadata = { title: "Builds" };

export default async function BuildsPage() {
  await connection();
  const user = await currentUser();
  if (!user) {
    return (
      <div className="page">
        <PageHeader title="Builds" subtitle="Every muse you've sent, with its status, time and cost." />
        <EmptyCard
          icon="user"
          title="Sign in to see your builds"
          action={{ href: "/sign-in?next=%2Fbuilds", label: "Sign in" }}
        >
          <p>Browsing is open to everyone. Your own builds show up here once you sign in.</p>
        </EmptyCard>
      </div>
    );
  }

  const result = await safeQuery(() => listUserBuilds(user.id));
  const now = Date.now();
  return (
    <div className="page">
      <PageHeader
        title="Builds"
        subtitle={
          user.openAccess && !user.isAdmin
            ? "Every muse sent from the shared guest account, with its status, time and cost."
            : "Every muse you've sent, with its status, time and cost."
        }
        actions={
          <Link className="btn btn-primary" href="/">
            <Icon name="plus" size={18} />
            New muse
          </Link>
        }
      />
      {!result.ok ? (
        <NotConnected reason={result.reason} what="your build list" />
      ) : result.data.length === 0 ? (
        <EmptyCard title="No builds yet" action={{ href: "/", label: "Start a muse" }}>
          <p>Drop in a photo, a sketch, a short video, a voice memo or a PDF and Muse Code builds it.</p>
        </EmptyCard>
      ) : (
        <div className="table-wrap">
          <table className="data data-list">
            <caption className="sr-only">Your builds, newest first</caption>
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
                return (
                  <tr key={b.id}>
                    <td>
                      <Link href={`/b/${b.id}`} className="row-title">
                        {title}
                      </Link>
                      {sub ? <span className="row-sub muted">{sub}</span> : null}
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
