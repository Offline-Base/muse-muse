import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import resources from "@/catalog/meta-resources.json";
import { Icon } from "@/components/icons";
import { RebuildButton } from "@/components/rebuilds/RebuildButton";
import { ExternalLink, ModelChips, NotConnected, PageHeader, StatusPill } from "@/components/ui";
import type { RebuildCardView } from "@/components/view-types";
import { FIT_LABEL, dayLabel, plural, shortDuration, usd } from "@/lib/format";
import { currentUser, joinRebuilds, listRebuilds, safeQuery } from "@/lib/queries";

export const metadata: Metadata = { title: "Rebuilds" };

const FIT_TONE: Record<string, string> = { clean: "live", reframe: "building", partial: "partial" };

function RebuildCard({ c, admin, isNew }: { c: RebuildCardView; admin: boolean; isNew?: boolean }) {
  const shipped = c.product && (c.product.status === "live" || c.product.status === "partial");
  const meta = [
    c.attempts ? `Built in ${shortDuration(c.totalMs)}` : null,
    c.attempts ? `${usd(c.totalCostUsd)} est.` : null,
    c.attempts > 1 ? plural(c.attempts, "attempt") : null,
  ].filter(Boolean);
  return (
    <article className="pcard rcard">
      <div className="pcard-media">
        {c.product?.demoVideoUrl ? (
          <video
            src={c.product.demoVideoUrl}
            poster={c.product.demoPosterUrl ?? undefined}
            preload="metadata"
            controls
            muted
            playsInline
            aria-label={`Demo of the rebuild of ${c.title}`}
          />
        ) : (
          <div className="pcard-placeholder" aria-hidden>
            <Icon name={isNew ? "sparkle" : "rebuild"} size={28} />
            <span>{shipped ? "Demo coming" : "Not built yet"}</span>
          </div>
        )}
      </div>
      <div className="pcard-body">
        <div className="pills">
          {isNew ? (
            <span className="pill pill-building">First demo</span>
          ) : (
            <span className={`pill pill-${FIT_TONE[c.fit] ?? "neutral"}`}>{FIT_LABEL[c.fit] ?? c.fit}</span>
          )}
          {!isNew ? <span className="pill pill-neutral">{c.era}</span> : null}
        </div>
        <h3 className="rcard-title">{isNew ? c.title : <ExternalLink href={c.url}>{c.title}</ExternalLink>}</h3>
        <p className="muted small">{c.demonstrates}</p>
        {!isNew ? <p className="small">{c.plan}</p> : null}
        <ModelChips models={c.models} />
        <div className="rcard-status">
          {c.product ? (
            <>
              <StatusPill status={c.product.status} />
              {shipped && c.product.liveUrl ? <ExternalLink href={c.product.liveUrl}>Live</ExternalLink> : null}
              <Link href={`/p/${c.product.slug}`}>{c.product.name}</Link>
            </>
          ) : c.latestBuild ? (
            <>
              <StatusPill status={c.latestBuild.status} />
              <Link href={`/b/${c.latestBuild.id}`}>Build room</Link>
            </>
          ) : (
            <span className="muted small">Not built yet</span>
          )}
          {c.latestBuild && c.product ? <Link href={`/b/${c.latestBuild.id}`}>Latest build</Link> : null}
        </div>
        {meta.length ? <p className="pcard-meta">{meta.join(" · ")}</p> : null}
        {admin ? <RebuildButton ids={[c.id]} text={c.attempts ? "Rebuild again" : "Rebuild"} /> : null}
      </div>
    </article>
  );
}

export default async function Rebuilds() {
  await connection();
  const [user, result] = await Promise.all([currentUser(), safeQuery(() => listRebuilds())]);
  const data = result.ok ? result.data : joinRebuilds([], []);
  const admin = Boolean(user?.isAdmin);
  const t = data.totals;

  return (
    <div className="page">
      <PageHeader
        title="Meta's demos, rebuilt"
        subtitle={
          <>
            Every video on the first page of{" "}
            <ExternalLink href={resources.source}>Meta&apos;s Videos section</ExternalLink> uses Llama. Each one becomes
            a muse that Muse Muse rebuilds on current Muse models and records. Checked {dayLabel(resources.checkedOn)}.
            The rebuilds link to Meta&apos;s videos and never copy them.
          </>
        }
        actions={admin ? <RebuildButton text="Rebuild all" /> : null}
      />

      {!result.ok ? <NotConnected reason={result.reason} what="the rebuild results" /> : null}

      {result.ok ? (
        <section className="card totals" aria-label="Totals">
          <p className="totals-big">
            <strong>
              {t.rebuilt} of {t.of}
            </strong>{" "}
            rebuilt{t.totalMs ? ` in ${shortDuration(t.totalMs)}` : ""} for {usd(t.totalCostUsd)}
          </p>
          <p className="muted small">
            {t.firstDemos ? `Plus ${plural(t.firstDemos, "first demo")} for models Meta has no video for yet. ` : ""}
            Time and cost include every attempt and fix round. Costs are estimates.
          </p>
        </section>
      ) : null}

      <section aria-labelledby="videos-title" className="section">
        <h2 id="videos-title" className="sr-only">
          Meta&apos;s videos
        </h2>
        <div className="grid-cards">
          {data.videos.map((c) => (
            <RebuildCard key={c.id} c={c} admin={admin} />
          ))}
        </div>
      </section>

      <section aria-labelledby="missing-title" className="section">
        <div className="section-head">
          <h2 id="missing-title">Demos Meta doesn&apos;t have yet</h2>
        </div>
        <p className="muted">
          No video on the first page shows SAM 3.1, Muse Image, Voice Transcribe or Muse Wonder. These are first demos
          for each.
        </p>
        <div className="grid-cards">
          {data.missing.map((c) => (
            <RebuildCard key={c.id} c={c} admin={admin} isNew />
          ))}
        </div>
      </section>
    </div>
  );
}
