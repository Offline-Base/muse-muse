import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { CopyButton, CopyField } from "@/components/CopyButton";
import { Icon } from "@/components/icons";
import { KIND_ICON } from "@/components/composer/AttachmentChip";
import "@/components/product/get-it.css";
import { CheckedPanel } from "@/components/product/CheckedPanel";
import { checksFailed, RequirementsChecklist, type CheckOutcome } from "@/components/build/RequirementsChecklist";
import { latestChecklist } from "@/lib/full/requirements";
import { GetItPanel } from "@/components/product/GetItPanel";
import { nativeSlots } from "@/components/product/NativeSlots";
import { productOutputSlots } from "@/components/product/OutputPanels";
import { extensionSlots } from "@/components/product/ExtensionPanel";
import { extensionZipReady } from "@/lib/caps/extension/store";
import { hardwareOwnerLink } from "@/lib/caps/hardware/owner-link";
import { museCodeOwnerLink } from "@/lib/caps/code/musecode/owner-link";
import { runtimeOutputSlots } from "@/components/product/RuntimeOutputPanels";
import { TrainOnMyData } from "@/components/product/TrainOnMyData";
import { JobsPanel } from "@/components/jobs/JobsPanel";
import { AddClip, RemoveClip } from "@/components/product/OwnerClips";
import { StatusControl } from "@/components/product/StatusControl";
import { EmptyCard, ExternalLink, NotConnected, StatusPill } from "@/components/ui";
import { compact, connectorActions, modelLabel, plural, relativeTime, statusLabel, truncate, usd } from "@/lib/format";
import { canActAsOwner } from "@/lib/auth";
import { canEditProduct } from "@/lib/edit-pass";
import type { Brief } from "@/lib/brief/schema";
import { env } from "@/lib/env";
import { downloadCounts, readProductNative } from "@/lib/native/queries";
import { panelLinkOrigin } from "@/lib/native/product-view";
import { briefTargets } from "@/lib/native/targets";
import { enabledFrameBrief, liveFrameAllow, liveFrameSandbox } from "@/lib/product-frame";
import { buildHighlights, currentUser, getProductPage, platformOrigin, rebuildRef, safeQuery } from "@/lib/queries";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: slug.replace(/-/g, " ") };
}

/**
 * The panel's slots for a shipped product. Reading them must never take the page down: the rest of the page works without
 * them, so a failure here only leaves the panel out.
 */
async function getItSlots({ productId, brief, ...ctx }: Omit<Parameters<typeof nativeSlots>[1], "enabled" | "downloads" | "onQuest"> & { productId: string; brief: Brief | null }) {
  try {
    const view = await readProductNative(productId, briefTargets(brief));
    const downloads = ctx.isOwner ? await downloadCounts(view.packages.map((p) => p.artifactId)) : undefined;
    const onQuest = ((await headers()).get("user-agent") ?? "").includes("OculusBrowser");
    const slots = nativeSlots(view, { ...ctx, enabled: env.enabledTargets, downloads, onQuest });
    return { slots, clips: view.clips, initial: onQuest && slots.vr ? ("vr" as const) : undefined };
  } catch (err) {
    console.error("[product page] couldn't read its apps:", err instanceof Error ? err.message : err);
    return { slots: {}, clips: [], initial: undefined };
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
  const canEdit = await canEditProduct(user, product);
  const rebuild = rebuildRef(product.rebuildOf);
  const highlights = buildHighlights(events, latestBuild);
  const models: Array<{ id: string; usedFor: string }> = manifest?.models?.length
    ? manifest.models
    : (brief?.capabilities ?? []).map((c) => ({ id: c.model, usedFor: c.need }));
  const limits = manifest?.limits?.length ? manifest.limits : (brief?.limits ?? []);
  const costPerRun = manifest?.estimatedCostPerRunUsd ?? brief?.estimatedCostPerRunUsd ?? null;
  const muse = manifest?.inspiration || inspiration?.note || brief?.inspiration.summary || null;
  const exposedActions = connectorActions(manifest);
  const refineHref = latestBuild ? `/b/${latestBuild.id}?refine=1#refine` : null;
  const now = Date.now();
  const frameBrief = enabledFrameBrief(brief, env.enabledTargets, env.servedCaps);
  const native = shipped
    ? await getItSlots({ productId: product.id, slug: product.slug, name: product.name, liveUrl: product.liveUrl, origin: panelLinkOrigin(origin), brief, frameBrief, isOwner, buildId: latestBuild?.id ?? null })
    : { slots: {}, clips: [], initial: undefined };
  // Wave 3, unit 14: whether the extension's zip is there, looked up only with its flag on, for a live brief with one.
  const extensionReady = shipped && product.liveUrl && env.enabledCaps.includes("extension") && (brief as { extension?: unknown } | null)?.extension ? await extensionZipReady(product.id) : null;
  // Only for a product that runs somewhere else too, so with every flag off the page has no trace of this.
  const ownerLink = shipped
    ? (museCodeOwnerLink({ isOwner, liveUrl: product.liveUrl, slug: product.slug, status: product.status, brief, served: env.servedCaps.includes("code") }) ??
      // Wave 3, unit 13: a product with board tools needs the same way in. Null with HARDWARE_BOARD_TOOLS off.
      hardwareOwnerLink({ isOwner, liveUrl: product.liveUrl, slug: product.slug, status: product.status, brief, served: env.servedCaps.includes("hardware") }))
    : null;
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
          {latestBuild && (canEdit || product.sourcePublic) ? (
            <Link className="btn" href={`/p/${product.slug}/code`}>
              <Icon name="code" size={18} />
              <span>Code</span>
            </Link>
          ) : null}
          {canEdit && shipped && refineHref ? (
            <Link className="btn btn-primary" href={refineHref}>
              <Icon name="edit" size={18} />
              <span>Keep editing</span>
            </Link>
          ) : null}
          {/* Wave 3, unit 9: an owner-only Muse Code product needs a way in. A plain link: each visit signs a one-time code, so it's never prefetched. */}
          {ownerLink ? (
            <a className="btn" href={ownerLink} target="_blank" rel="noopener">
              <Icon name="terminal" size={18} />
              <span>Open as owner</span>
            </a>
          ) : null}
          {/* Wave 3, unit 1 (TRUST_REPORTS): anyone can report a product, as from its own footer. */}
          {env.trustReports ? (
            <Link className="btn" href={`/report/${product.slug}`}>
              <Icon name="alert" size={18} />
              <span>Report</span>
            </Link>
          ) : null}
        </div>

        <header className="product-head">
          <div className="product-title">
            <h1>{product.name}</h1>
            {/* A shipped product with no link never reads "Live" next to "Not published". */}
            {shipped && !product.liveUrl ? <StatusPill status="disabled" label="Not published" /> : <StatusPill status={product.status} />}
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
              allow={liveFrameAllow(frameBrief)}
              sandbox={liveFrameSandbox(frameBrief)}
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
              {product.status === "partial"
                ? "It shipped with some checks failing, and publishing was off where it was built, such as a local run, so it has no live link."
                : "It passed its checks, but publishing was off where it was built, such as a local run, so it has no live link."}{" "}
              Its recorded demo is in the panel.
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
            <p>It never went live. The build room shows where it stopped.</p>
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

        {shipped ? (
          <GetItPanel slots={{ ...native.slots, ...(env.productOutputs ? productOutputSlots({ product, origin, events, now }) : {}), ...(env.runtimeOutputs ? runtimeOutputSlots({ product, origin, isOwner }) : {}), ...(env.enabledCaps.includes("extension") ? extensionSlots({ product, origin, brief, ready: extensionReady }) : {}) }} initial={native.initial} />
        ) : null}

        {/* FULL_BUILDS: only a brief written with it has requirements. Nothing renders for any other product. */}
        {brief?.requirements?.length ? (
          <section className="card section-card">
            <RequirementsChecklist
              items={latestChecklist(brief, events.flatMap((e): Parameters<typeof latestChecklist>[1][number][] => (e.type === "judge" ? [{ judge: e.verdict }] : e.type === "verify" ? [{ tests: e.summary.requirements ?? null }] : [])))}
              failed={checksFailed(product.status, events.flatMap((e): CheckOutcome[] => (e.type === "judge" ? [{ judge: e.verdict }] : e.type === "verify" ? [{ verify: e.summary }] : [])))}
            />
          </section>
        ) : null}

        {/* VERIFY_AGENTS: not in the tree while it's off. */}
        {env.verifyAgents && latestBuild && (shipped || product.status === "failed") ? (
          <CheckedPanel events={events} status={product.status} hasActions={exposedActions.length > 0} isAgent={briefTargets(brief).includes("agent")} isOwner={isOwner} now={now} />
        ) : null}

        {/* Wave 3, unit 11: nothing unless GPU_TRAIN_ON_DATA and TUNE_COMPOSER are on, for the signed-in owner, not an admin. */}
        {shipped && user?.id === product.ownerId && !user?.openAccess && env.gpuTrainOnData && env.tuneComposer ? (
          <section className="card section-card">
            <TrainOnMyData slug={product.slug} />
          </section>
        ) : null}
        {/* Wave 3, unit 6: not in the tree at all while the jobs cap is off. */}
        {shipped && env.servedCaps.includes("jobs") ? <JobsPanel productId={product.id} slug={product.slug} brief={brief} isOwner={isOwner} viewerIsOwner={Boolean(user && !user.openAccess && user.id === product.ownerId)} /> : null}

        <section className="card section-card" aria-labelledby="muse-title">
          <h2 id="muse-title">The muse</h2>
          {rebuild ? (
            <p className="rebuild-tag">
              <Icon name="cap" size={16} />
              {rebuild.learnHref ? (
                <>
                  <span>Made for Meta&apos;s lesson</span>
                  <ExternalLink href={rebuild.url}>{truncate(rebuild.title, 80)}</ExternalLink>
                  {rebuild.verdict?.product === product.slug ? (
                    <span className="pill pill-neutral">{rebuild.verdict.label}</span>
                  ) : (
                    <span className="pill pill-neutral">Not checked against the lesson yet</span>
                  )}
                  <Link href={rebuild.learnHref}>See it on Learn</Link>
                </>
              ) : (
                <span>First demo: {truncate(rebuild.title, 80)}</span>
              )}
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
                {exposedActions.length
                  ? ` It exposes ${plural(exposedActions.length, "action")}: ${exposedActions.map((a) => a.name).join(", ")}.`
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
                  <ExternalLink href={rebuild.url}>{rebuild.learnHref ? "Meta's lesson" : "Meta's Videos page"}</ExternalLink>
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

          {canEdit && shipped && refineHref ? (
            <section className="panel-section">
              <h2 className="panel-label">Keep editing</h2>
              <p className="muted small">
                Ask for a change. Muse Code resumes the same session, checks it again and redeploys.
              </p>
              <Link className="btn btn-primary" href={refineHref}>
                <Icon name="edit" size={18} />
                Keep editing this product
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
