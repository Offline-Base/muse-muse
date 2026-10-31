import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { CopyButton, CopyField } from "@/components/CopyButton";
import { Icon } from "@/components/icons";
import { KIND_ICON } from "@/components/composer/AttachmentChip";
import "@/components/product/get-it.css";
import { GetItPanel } from "@/components/product/GetItPanel";
import { nativeSlots } from "@/components/product/NativeSlots";
import { AddClip, RemoveClip } from "@/components/product/OwnerClips";
import { StatusControl } from "@/components/product/StatusControl";
import { EmptyCard, ExternalLink, NotConnected, StatusPill } from "@/components/ui";
import { FIT_LABEL, compact, modelLabel, plural, relativeTime, statusLabel, truncate, usd } from "@/lib/format";
import { canActAsOwner } from "@/lib/auth";
import type { Brief } from "@/lib/brief/schema";
import { env } from "@/lib/env";
import { downloadCounts, readProductNative } from "@/lib/native/queries";
import { briefTargets } from "@/lib/native/targets";
import { liveFrameAllow, liveFrameSandbox } from "@/lib/product-frame";
import { buildHighlights, currentUser, getProductPage, platformOrigin, rebuildRef, safeQuery } from "@/lib/queries";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: slug.replace(/-/g, " ") };
}

/**
 * The panel's slots for a shipped product. Reading them must never take the page down: the rest of the page works without
 * them, so a failure here only leaves the panel out.
 */
async function getItSlots({ productId, brief, ...ctx }: Omit<Parameters<typeof nativeSlots>[1], "enabled" | "downloads" | "onQuest" | "brief"> & { productId: string; brief: Brief | null }) {
  try {
    const view = await readProductNative(productId, briefTargets(brief));
    const downloads = ctx.isOwner ? await downloadCounts(view.packages.map((p) => p.artifactId)) : undefined;
    const userAgent = (await headers()).get("user-agent") ?? "";
    return { slots: nativeSlots(view, { ...ctx, brief, enabled: env.enabledTargets, downloads, onQuest: userAgent.includes("OculusBrowser") }), clips: view.clips };
  } catch (err) {
    console.error("[product page] couldn't read its apps:", err instanceof Error ? err.message : err);
    return { slots: {}, clips: [] };
  }
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const [user, result] = await Promise.all([currentUser(), safeQuery(() => getProductPage(slug))]);
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="this product" />
      </div>
    );
  }
  if (!result.data) notFound();

  const { product, latestBuild, brief, inspiration, history, events, runs } = result.data;
  const origin = await platformOrigin();
  const connectorUrl = `${origin}/api/mcp/${product.slug}`;
  const manifest = product.manifest;
  const shipped = product.status === "live" || product.status === "partial";
  const isOwner = canActAsOwner(user, product.ownerId);
  const rebuild = rebuildRef(product.rebuildOf);
  const highlights = buildHighlights(events, latestBuild);
  const models: Array<{ id: string; usedFor: string }> = manifest?.models?.length
    ? manifest.models
    : (brief?.capabilities ?? []).map((c) => ({ id: c.model, usedFor: c.need }));
  const limits = manifest?.limits?.length ? manifest.limits : (brief?.limits ?? []);
  const costPerRun = manifest?.estimatedCostPerRunUsd ?? brief?.estimatedCostPerRunUsd ?? null;
  const muse = manifest?.inspiration || inspiration?.note || brief?.inspiration.summary || null;
  const refineHref = latestBuild ? `/b/${latestBuild.id}?refine=1#refine` : null;
  const now = Date.now();
  const native = shipped
    ? await getItSlots({ productId: product.id, slug: product.slug, name: product.name, liveUrl: product.liveUrl, origin, brief, isOwner })
    : { slots: {}, clips: [] };
  // Only for a product that runs somewhere else too, so with every flag off the page has no trace of this.
  const canAddClips = shipped && isOwner && env.enabledTargets.length > 0 && briefTargets(brief).some((t) => t !== "web");

  return (
    <div className="split">
      <div className="split-main">
        <div className="toolbar" aria-label="Product actions">
          {product.liveUrl && shipped ? (
            <a className="btn" href={product.liveUrl} target="_blank" rel="noopener noreferrer">
              <Icon name="external" size={18} />
              <span>Open</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
          {shipped ? (
            <CopyButton value={connectorUrl} label="Copy the Muse app connector URL" text="Get connector" icon="plug" />
          ) : null}
          {latestBuild ? (
            <Link className="btn" href={`/b/${latestBuild.id}`}>
              <Icon name="terminal" size={18} />
              <span>Build room</span>
            </Link>
          ) : null}
          {isOwner && shipped && refineHref ? (
            <Link className="btn btn-primary" href={refineHref}>
              <Icon name="sparkle" size={18} />
              <span>Refine</span>
            </Link>
          ) : null}
        </div>

        <header className="product-head">
          <div className="product-title">
            <h1>{product.name}</h1>
            <StatusPill status={product.status} />
          </div>
          {product.tagline ? <p className="subtitle">{product.tagline}</p> : null}
        </header>

        {shipped && product.liveUrl ? (
          <section className="frame-card" aria-label={`${product.name}, live`}>
            <div className="frame-head">
              <span className="frame-url">
                <span className="live-dot" aria-hidden />
                {product.liveUrl.replace(/^https?:\/\//, "")}
              </span>
              <ExternalLink href={product.liveUrl}>Open</ExternalLink>
            </div>
            <iframe
              src={product.liveUrl}
              title={`${product.name}, the live product`}
              loading="lazy"
              allow={liveFrameAllow(brief)}
              sandbox={liveFrameSandbox(brief)}
              referrerPolicy="no-referrer"
            />
          </section>
        ) : shipped ? (
          <EmptyCard
            icon="monitor"
            title="Not published"
            action={latestBuild ? { href: `/b/${latestBuild.id}`, label: "Open the build room" } : undefined}
          >
            <p>
              It passed its checks, but publishing was off where it was built, such as a local run, so it has no live
              link. Its recorded demo is in the panel.
            </p>
          </EmptyCard>
        ) : product.status === "disabled" ? (
          <EmptyCard icon="power" title="This product is turned off">
            <p>An admin switched it off. Its page and history stay here.</p>
          </EmptyCard>
        ) : product.status === "failed" ? (
          <EmptyCard
            icon="alert"
            title="This product didn't ship"
            action={latestBuild ? { href: `/b/${latestBuild.id}`, label: "See what happened" } : undefined}
          >
            <p>Its checks didn&apos;t pass, so it was never put live.</p>
          </EmptyCard>
        ) : (
          <EmptyCard
            icon="terminal"
            title="Still building"
            action={latestBuild ? { href: `/b/${latestBuild.id}`, label: "Watch the build" } : undefined}
          >
            <p>It goes live here once it passes its checks.</p>
          </EmptyCard>
        )}

        {shipped ? <GetItPanel slots={native.slots} /> : null}

        <section className="card section-card" aria-labelledby="muse-title">
          <h2 id="muse-title">The muse</h2>
          {rebuild ? (
            <p className="rebuild-tag">
              <Icon name="rebuild" size={16} />
              <span>Rebuild of Meta&apos;s video</span>
              <ExternalLink href={rebuild.url}>{truncate(rebuild.title, 80)}</ExternalLink>
              {rebuild.fit ? <span className="pill pill-neutral">{FIT_LABEL[rebuild.fit]}</span> : null}
            </p>
          ) : null}
          {inspiration?.references.length ? (
            <div className="ref-row ref-row-start">
              {inspiration.references.map((r, i) =>
                r.kind === "image" ? (
                  <a key={`${r.url}-${i}`} className="ref-thumb" href={r.url} target="_blank" rel="noopener noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={r.url} alt={`Inspo ${i + 1}: ${r.fileName}`} loading="lazy" />
                  </a>
                ) : (
                  <a key={`${r.url}-${i}`} className="ref-chip" href={r.url} target="_blank" rel="noopener noreferrer">
                    <Icon name={KIND_ICON[r.kind]} size={18} />
                    <span>{truncate(r.fileName, 32)}</span>
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ),
              )}
            </div>
          ) : null}
          {muse ? <p>{muse}</p> : <p className="muted">No note was given.</p>}
          {brief?.inspiration.borrow.length || brief?.inspiration.dontCopy.length ? (
            <div className="two-col">
              <div>
                <h3>Took from it</h3>
                <ul>
                  {brief.inspiration.borrow.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Left out</h3>
                <ul>
                  {brief.inspiration.dontCopy.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
        </section>
      </div>

      <aside className="panel panel-static" aria-label="Product details">
        <div className="panel-body" data-open="true">
          <section className="panel-section">
            <h2 className="panel-label">Models</h2>
            {models.length ? (
              <ul className="model-list">
                {models.map((m) => (
                  <li key={m.id}>
                    <span className="chip">{modelLabel(m.id)}</span>
                    <span className="muted">{m.usedFor}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Listed once the product ships.</p>
            )}
          </section>

          <dl className="kv">
            <div>
              <dt>Cost per run</dt>
              <dd>{costPerRun != null ? `${usd(costPerRun)} est.` : "Not known yet"}</dd>
            </div>
            <div>
              <dt>Runs so far</dt>
              <dd>
                {plural(runs.calls, "call")} · {compact(runs.tokens)} tokens · {usd(runs.costUsd)}
              </dd>
            </div>
            {latestBuild ? (
              <div>
                <dt>Build cost</dt>
                <dd>{usd(latestBuild.costUsd)} est.</dd>
              </div>
            ) : null}
          </dl>

          {limits.length ? (
            <section className="panel-section">
              <h2 className="panel-label">Limits</h2>
              <ul className="plain-list">
                {limits.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {shipped ? (
            <section className="panel-section">
              <h2 className="panel-label">Muse app connector</h2>
              <CopyField value={connectorUrl} label="Connector URL" />
              <p className="muted small">
                Add it in the Muse app as a custom connector.
                {manifest?.actions?.length
                  ? ` It exposes ${plural(manifest.actions.length, "action")}: ${manifest.actions.map((a) => a.name).join(", ")}.`
                  : ""}
              </p>
            </section>
          ) : null}

          {product.demoVideoUrl ? (
            <section className="panel-section">
              <h2 className="panel-label">Recorded demo</h2>
              <video
                className="demo"
                src={product.demoVideoUrl}
                poster={product.demoPosterUrl ?? undefined}
                controls
                preload="metadata"
                playsInline
                aria-label={`Demo of ${product.name}`}
              />
            </section>
          ) : null}

          {native.clips.length || canAddClips ? (
            <section className="panel-section">
              <h2 className="panel-label">Filmed by its owner</h2>
              {native.clips.map((clip) => (
                <figure key={clip.url} className="getit-owner-clip">
                  <video className="demo" src={clip.url} poster={clip.posterUrl ?? undefined} controls preload="metadata" playsInline aria-label={clip.caption} />
                  <figcaption>{clip.caption}</figcaption>
                  {canAddClips ? <RemoveClip slug={product.slug} url={clip.url} /> : null}
                </figure>
              ))}
              {canAddClips ? <AddClip slug={product.slug} productId={product.id} /> : null}
            </section>
          ) : null}

          <section className="panel-section">
            <h2 className="panel-label">How it was built</h2>
            {highlights.length ? (
              <ul className="plain-list">
                {highlights.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">Details appear once a build has run.</p>
            )}
            <ul className="link-list">
              {latestBuild ? (
                <li>
                  <Link href={`/b/${latestBuild.id}`}>Open the build room</Link>
                </li>
              ) : null}
              {product.transcriptUrl ? (
                <li>
                  <ExternalLink href={product.transcriptUrl}>Muse Code transcript (redacted)</ExternalLink>
                </li>
              ) : null}
              {rebuild ? (
                <li>
                  <ExternalLink href={rebuild.url}>Meta&apos;s original video</ExternalLink>
                </li>
              ) : null}
            </ul>
          </section>

          {history.length > 1 ? (
            <section className="panel-section">
              <h2 className="panel-label">Versions</h2>
              <ul className="history-list">
                {history.map((h) => (
                  <li key={h.id}>
                    <Link href={`/b/${h.id}`}>
                      {h.kind === "refine" ? truncate(h.message ?? "Change", 48) : "First build"}
                    </Link>
                    <span className="muted small">
                      {statusLabel(h.status)} · {relativeTime(h.startedAt, now)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {isOwner && shipped && refineHref ? (
            <section className="panel-section">
              <h2 className="panel-label">Refine</h2>
              <p className="muted small">
                Ask for a change. Muse Code resumes the same session, checks it again and redeploys.
              </p>
              <Link className="btn btn-primary" href={refineHref}>
                <Icon name="sparkle" size={18} />
                Refine this product
              </Link>
            </section>
          ) : null}

          {user?.isAdmin ? (
            <section className="panel-section">
              <StatusControl slug={product.slug} status={product.status} />
            </section>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
