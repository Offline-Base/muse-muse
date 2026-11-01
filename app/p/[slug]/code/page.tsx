import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Icon } from "@/components/icons";
import { RestoreVersion } from "@/components/product/RestoreVersion";
import { EmptyCard, NotConnected, PageHeader, StatusPill } from "@/components/ui";
import { canActAsOwner } from "@/lib/auth";
import { CodeVisibility } from "@/components/product/CodeVisibility";
import { canEditProduct } from "@/lib/edit-pass";
import { db, schema } from "@/lib/db/client";
import { relativeTime, statusLabel, truncate, usd } from "@/lib/format";
import { currentUser, safeQuery } from "@/lib/queries";
import { TERMINAL_STATUSES, type BuildStatus } from "@/lib/types";
import { canReadCode, changedFiles, commitsFrom, diffHunks, fileTree, findFile, lineDiff, previousKept, visibleFiles, type Change, type Commit, type DiffLine, type TreeNode, type VersionFile } from "@/lib/versions/policy";
import { keptBuildIds, productCommitBuilds, readVersionText, versionOf } from "@/lib/versions/store";
import "./code.css";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Code: ${slug.replace(/-/g, " ")}`, robots: { index: false } };
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);
const commitTitle = (c: Commit) => (c.kind === "build" ? "First build" : (c.message ?? "Change"));
const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

async function load(slug: string) {
  const [product] = await db().select().from(schema.products).where(eq(schema.products.slug, slug)).limit(1);
  if (!product) return null;
  const [builds, kept] = await Promise.all([productCommitBuilds(product.id), keptBuildIds(product.id)]);
  return { product, commits: commitsFrom(builds, kept) };
}

const WHY: Record<"held" | "big" | "binary", string> = {
  held: "This file looks like it holds a secret, so it was never saved and can't be shown.",
  big: "This file is too big to show here. It's in the source download when it fits.",
  binary: "This is a binary file, so there's nothing to read here.",
};

function Lines({ text }: { text: string }) {
  return (
    <code className="code-lines">
      {text.split("\n").map((line, i) => (
        <span className="code-line" key={i}>
          <i>{i + 1}</i>
          <span>{line}</span>
        </span>
      ))}
    </code>
  );
}

function Diff({ lines }: { lines: Array<DiffLine | null> }) {
  return (
    <code className="code-lines">
      {lines.map((l, i) =>
        l ? (
          <span className={`code-line${l.kind === "add" ? " is-add" : l.kind === "del" ? " is-del" : ""}`} key={i}>
            <i>{l.oldLine ?? ""}</i>
            <i>{l.newLine ?? ""}</i>
            <span>
              {l.kind === "add" ? <span className="sr-only">Added: </span> : l.kind === "del" ? <span className="sr-only">Removed: </span> : null}
              {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}
              {l.text}
            </span>
          </span>
        ) : (
          <span className="code-skip" key={i}>
            ...
          </span>
        ),
      )}
    </code>
  );
}

function Tree({ nodes, selected, href }: { nodes: TreeNode[]; selected: string | null; href: (path: string) => string }) {
  return (
    <ul>
      {nodes.map((n) => (
        <li key={n.path}>
          {n.file ? (
            <Link href={href(n.path)} aria-current={n.path === selected ? "true" : undefined} scroll={false}>
              {n.name}
            </Link>
          ) : (
            <details open={!selected || selected.startsWith(`${n.path}/`) || nodes.length === 1}>
              <summary>{n.name}</summary>
              <Tree nodes={n.children} selected={selected} href={href} />
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

async function FileView({ file }: { file: VersionFile }) {
  const read = await readVersionText(file);
  return (
    <div className="code-view">
      <div className="code-view-head">
        <strong>{file.path}</strong>
        <span className="muted">{kb(file.size)}</span>
      </div>
      {"text" in read ? <Lines text={read.text} /> : <p className="code-view-empty">{WHY[read.why]}</p>}
    </div>
  );
}

async function DiffView({ change, before, after, against, number }: { change: Change; before: VersionFile | null; after: VersionFile | null; against: number; number: number }) {
  const [a, b] = await Promise.all([before ? readVersionText(before) : { text: "" }, after ? readVersionText(after) : { text: "" }]);
  const why = !("text" in a) ? a.why : !("text" in b) ? b.why : null;
  const lines = "text" in a && "text" in b ? lineDiff(a.text, b.text) : null;
  return (
    <div className="code-view">
      <div className="code-view-head">
        <strong>{change.path}</strong>
        <span className="muted">
          {change.change} in version {number}, against version {against}
        </span>
      </div>
      {why ? <p className="code-view-empty">{WHY[why]}</p> : lines ? <Diff lines={diffHunks(lines)} /> : <p className="code-view-empty">This file changed too much to compare here.</p>}
    </div>
  );
}

export default async function CodePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const { slug } = await params;
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) notFound();
  const query = await searchParams;
  const [user, result] = await Promise.all([currentUser(), safeQuery(() => load(slug))]);
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="this product" />
      </div>
    );
  }
  if (!result.data) notFound();
  const { product, commits } = result.data;
  const isOwner = canActAsOwner(user, product.ownerId);
  const canEdit = await canEditProduct(user, product);
  if (!canReadCode(product, canEdit)) notFound();

  const asked = Number(one(query.v));
  const commit = commits.find((c) => c.number === asked) ?? commits.find((c) => c.id === product.latestBuildId) ?? commits.find((c) => c.kept) ?? commits[0] ?? null;
  const showDiff = one(query.tab) === "changes";
  const path = one(query.path);
  const previous = commit ? previousKept(commits, commit.number) : null;
  const [saved, savedBefore] = await Promise.all([commit?.kept ? versionOf(product.id, commit.id) : null, showDiff && previous && commit?.kept ? versionOf(product.id, previous.id) : null]);
  const files = saved ? visibleFiles(saved.files) : [];
  const filesBefore = savedBefore ? visibleFiles(savedBefore.files) : [];
  const changes = savedBefore ? changedFiles(filesBefore, files) : [];
  const change = showDiff ? (changes.find((c) => c.path === path) ?? changes[0] ?? null) : null;
  const selected = showDiff ? null : findFile(files, path);
  const opened = selected ?? (showDiff ? null : (findFile(files, "README.md") ?? findFile(files, "package.json") ?? files[0] ?? null));
  const now = Date.now();
  const base = `/p/${product.slug}/code`;
  const at = (params: Record<string, string | number>) => `${base}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()}`;
  const running = Boolean(commit && !TERMINAL_STATUSES.includes(commit.status as BuildStatus));
  const canRestore = Boolean(commit?.kept && isOwner && !product.takenDownAt && commit.id !== product.latestBuildId && (commit.status === "live" || commit.status === "partial") && (product.status === "live" || product.status === "partial") && product.sandboxName && product.museSessionId);

  return (
    <div className="page code-page">
      <div className="code-actions">
        <Link className="btn" href={`/p/${product.slug}`}>
          <Icon name="chevronLeft" size={18} />
          <span>{truncate(product.name, 40)}</span>
        </Link>
      </div>
      <PageHeader title="Code" />
      {canEdit ? <CodeVisibility slug={product.slug} isPublic={product.sourcePublic} /> : null}
      {!commit ? (
        <EmptyCard title="No code yet">This product has no builds yet, so there&apos;s no code to show.</EmptyCard>
      ) : (
        <div className="code-grid">
          <nav aria-label="Versions">
            <h2 className="panel-label">{commits.length === 1 ? "1 version" : `${commits.length} versions`}</h2>
            <ol className="code-commits">
              {commits.map((c) => (
                <li key={c.id}>
                  <Link href={at({ v: c.number })} aria-current={c.id === commit.id ? "true" : undefined}>
                    <strong>
                      {c.number}. {truncate(commitTitle(c), 70)}
                    </strong>
                    <span className="muted small">
                      {c.id === product.latestBuildId ? "Live now · " : ""}
                      {statusLabel(c.status)} · {relativeTime(c.startedAt.toISOString(), now)} · {usd(c.costUsd)}
                    </span>
                    {c.kept || !TERMINAL_STATUSES.includes(c.status as BuildStatus) ? null : <span className="muted small">Source not kept</span>}
                  </Link>
                </li>
              ))}
            </ol>
          </nav>
          <div className="code-main">
            <div>
              <h2>
                Version {commit.number}: {commitTitle(commit)}
              </h2>
              <p className="muted small">
                <StatusPill status={commit.status} /> {relativeTime(commit.startedAt.toISOString(), now)} · {usd(commit.costUsd)} · <Link href={`/b/${commit.id}`}>Build room</Link>
              </p>
            </div>
            {!saved ? (
              <EmptyCard title={running ? "Still building" : "Source not kept"}>{running ? "Its files are saved when it deploys." : "Saving started with later builds, and a build that never reached deploy has no files to save."}</EmptyCard>
            ) : (
              <>
                <div className="code-actions">
                  <a className="btn" href={`${base}/source.zip?v=${commit.number}`} download>
                    <Icon name="download" size={18} />
                    <span>Download source</span>
                  </a>
                  {canRestore ? <RestoreVersion buildId={commit.id} number={commit.number} /> : null}
                </div>
                <div className="code-tabs">
                  <Link href={at({ v: commit.number })} aria-current={showDiff ? undefined : "page"}>
                    Files ({files.length})
                  </Link>
                  {previous ? (
                    <Link href={at({ v: commit.number, tab: "changes" })} aria-current={showDiff ? "page" : undefined}>
                      Changes since version {previous.number}
                    </Link>
                  ) : null}
                </div>
                {showDiff && previous ? (
                  changes.length === 0 ? (
                    <EmptyCard title="No changes">No files changed since version {previous.number}.</EmptyCard>
                  ) : (
                    <div className="code-files">
                      <div className="code-tree">
                        <ul>
                          {changes.map((c) => (
                            <li key={c.path}>
                              <Link href={at({ v: commit.number, tab: "changes", path: c.path })} aria-current={c.path === change?.path ? "true" : undefined} scroll={false}>
                                {c.path}
                                <span className="code-mark">{c.change}</span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                      {change ? <DiffView key={change.path} change={change} before={filesBefore.find((f) => f.path === change.path) ?? null} after={files.find((f) => f.path === change.path) ?? null} against={previous.number} number={commit.number} /> : null}
                    </div>
                  )
                ) : (
                  <div className="code-files">
                    <div className="code-tree">
                      <Tree nodes={fileTree(files)} selected={opened?.path ?? null} href={(p) => at({ v: commit.number, path: p })} />
                    </div>
                    {opened ? <FileView file={opened} /> : <p className="code-view-empty">This version has no files to show.</p>}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
