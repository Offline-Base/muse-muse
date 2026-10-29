"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { CopyField } from "@/components/CopyButton";
import { Icon, type IconName } from "@/components/icons";
import { KIND_ICON } from "@/components/composer/AttachmentChip";
import { ExternalLink, ModelChips } from "@/components/ui";
import type { InspirationView, RebuildRef } from "@/components/view-types";
import { groupLog, type LogGroup, type Note, type Segment } from "@/components/build/derive";
import { FIT_LABEL, compact, duration, modelLabel, plural, truncate, usd } from "@/lib/format";
import type { Brief, MuseLogLine, Reference } from "@/lib/types";

/** The building blocks of the build room's conversation column. */

export function Turn({
  icon,
  title,
  meta,
  children,
  tone,
}: {
  icon: IconName;
  title: string;
  meta?: Array<string | null | undefined | false>;
  children: ReactNode;
  tone?: "ok" | "bad" | "warn";
}) {
  const metaText = (meta ?? []).filter(Boolean).join(" · ");
  return (
    <li className={`turn${tone ? ` turn-${tone}` : ""}`}>
      <h2 className="turn-head">
        <span className="turn-icon" aria-hidden>
          <Icon name={icon} size={18} />
        </span>
        {title}
      </h2>
      <div className="turn-body">{children}</div>
      {metaText ? <p className="turn-meta">{metaText}</p> : null}
    </li>
  );
}

export function segmentMeta(seg: Segment, extra: Array<string | null | false> = []): string[] {
  const ms = Date.parse(seg.endAt) - Date.parse(seg.startAt);
  return [
    Number.isFinite(ms) && ms > 0 ? duration(ms) : null,
    ...extra,
    seg.costUsd > 0 ? `${usd(seg.costUsd)} est.` : null,
  ].filter((s): s is string => Boolean(s));
}

export function Notes({ notes }: { notes: Note[] }) {
  if (!notes.length) return null;
  return (
    <ul className="notes">
      {notes.map((n) => (
        <li key={n.id} className={`note note-${n.kind}`}>
          <Icon name={n.kind === "error" ? "alert" : "info"} size={16} />
          <span>{n.text}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------- The user's muse ----------

function RefThumb({ r, index }: { r: Reference; index: number }) {
  if (r.kind === "image") {
    return (
      <a className="ref-thumb" href={r.url} target="_blank" rel="noopener noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={r.url} alt={`Inspo ${index + 1}: ${r.fileName}`} loading="lazy" />
      </a>
    );
  }
  return (
    <a className="ref-chip" href={r.url} target="_blank" rel="noopener noreferrer">
      <Icon name={KIND_ICON[r.kind]} size={18} />
      <span>{truncate(r.fileName, 32)}</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function UserTurn({
  inspiration,
  message,
  rebuild,
  showReferences,
}: {
  inspiration: InspirationView | null;
  message: string | null;
  rebuild: RebuildRef | null;
  showReferences: boolean;
}) {
  const refs = showReferences ? (inspiration?.references ?? []) : [];
  const text = message ?? inspiration?.note ?? null;
  return (
    <li className="turn-user">
      <h2 className="sr-only">Your muse</h2>
      {rebuild ? (
        <p className="rebuild-tag">
          <Icon name="rebuild" size={16} />
          <span>Rebuild of</span>
          <ExternalLink href={rebuild.url}>{truncate(rebuild.title, 70)}</ExternalLink>
          {rebuild.fit ? <span className="pill pill-neutral">{FIT_LABEL[rebuild.fit]}</span> : null}
        </p>
      ) : null}
      {refs.length ? (
        <div className="ref-row">
          {refs.map((r, i) => (
            <RefThumb key={`${r.url}-${i}`} r={r} index={i} />
          ))}
        </div>
      ) : null}
      {text ? <p className="bubble">{text}</p> : refs.length ? null : <p className="bubble muted">No note</p>}
    </li>
  );
}

// ---------- Brief ----------

const VERDICT: Record<Brief["verdict"], { label: string; tone: string }> = {
  yes: { label: "Can build", tone: "live" },
  partly: { label: "Can build part of it", tone: "partial" },
  no: { label: "Can't build this", tone: "failed" },
};

export function BriefBody({ brief }: { brief: Brief }) {
  const verdict = VERDICT[brief.verdict];
  const declined = brief.verdict === "no" || Boolean(brief.refusal);
  return (
    <div className="rich">
      <p className="lead">
        <strong>{brief.name}</strong>
        <span className={`pill pill-${declined ? "failed" : verdict.tone}`}>
          <span className="pill-dot" aria-hidden />
          {brief.refusal ? "Declined" : verdict.label}
        </span>
      </p>
      {brief.tagline ? <p className="muted">{brief.tagline}</p> : null}
      {declined ? (
        <>
          <div className="callout callout-bad" role="note">
            <Icon name="alert" size={18} />
            <p>{brief.refusal ?? "Muse can't make this with the models it has."}</p>
          </div>
          {brief.limits.length ? (
            <>
              <h3>Why</h3>
              <ul>
                {brief.limits.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : (
        <>
          <h3>Who it&apos;s for</h3>
          <p>{brief.user}</p>
          <h3>How it works</h3>
          <ol>
            {brief.primaryFlow.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          {brief.screens.length ? (
            <>
              <h3>Screens</h3>
              <ul>
                {brief.screens.map((s) => (
                  <li key={s.name}>
                    <strong>{s.name}.</strong> {s.purpose}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <h3>Models</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Used for</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {brief.capabilities.map((c, i) => (
                  <tr key={`${c.model}-${i}`}>
                    <td>
                      <strong>{modelLabel(c.model)}</strong>
                    </td>
                    <td>{c.need}</td>
                    <td>{c.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {brief.limits.length ? (
            <>
              <h3>Limits</h3>
              <ul>
                {brief.limits.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </>
          ) : null}
          <h3>From your inspo</h3>
          <p>{brief.inspiration.summary}</p>
          {brief.inspiration.borrow.length || brief.inspiration.dontCopy.length ? (
            <div className="two-col">
              <div>
                <h4>Takes</h4>
                <ul>
                  {brief.inspiration.borrow.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h4>Leaves out</h4>
                <ul>
                  {brief.inspiration.dontCopy.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
          <p>
            <strong>Cost per run:</strong> about {usd(brief.estimatedCostPerRunUsd)} (est.).{" "}
            {brief.costNotes ? <span className="muted">{brief.costNotes}</span> : null}
          </p>
        </>
      )}
    </div>
  );
}

// ---------- Muse Code log ----------

const RECENT_LINES = 8;

function ActivityList({ items, live }: { items: Extract<LogGroup, { type: "activity" }>["items"]; live: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const hidden = live && !showAll ? Math.max(0, items.length - RECENT_LINES) : 0;
  const visible = hidden ? items.slice(-RECENT_LINES) : items;
  return (
    <div className="activity">
      {hidden ? (
        <button type="button" className="link-btn" onClick={() => setShowAll(true)}>
          Show {plural(hidden, "earlier step")}
        </button>
      ) : null}
      <ul className="activity-list">
        {visible.map((it, i) => (
          <li key={i} className={`act act-${it.type}${"ok" in it && it.ok === false ? " act-failed" : ""}`}>
            <span className="act-icon" aria-hidden>
              <Icon
                name={
                  it.type === "edit"
                    ? "file"
                    : it.type === "error" || ("ok" in it && it.ok === false)
                      ? "alert"
                      : it.type === "tool"
                        ? "check"
                        : "info"
                }
                size={14}
              />
            </span>
            <span className="act-text">
              {it.type === "edit" ? (
                <>
                  Edited {plural(it.files, "file")} <span className="plus">+{it.added}</span>{" "}
                  <span className="minus">−{it.removed}</span>
                  {it.text && !/^edited/i.test(it.text) ? <span className="muted"> {it.text}</span> : null}
                </>
              ) : (
                it.text
              )}
            </span>
            {it.type === "tool" && it.tool ? <code className="act-name">{it.tool}</code> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function groupSummary(items: Extract<LogGroup, { type: "activity" }>["items"]): string {
  const tools = items.filter((i) => i.type === "tool").length;
  const edits = items.filter((i) => i.type === "edit") as Array<{ files: number; added: number; removed: number }>;
  const parts = [tools ? plural(tools, "step") : null];
  if (edits.length) {
    const files = edits.reduce((s, e) => s + e.files, 0);
    const added = edits.reduce((s, e) => s + e.added, 0);
    const removed = edits.reduce((s, e) => s + e.removed, 0);
    parts.push(`edited ${plural(files, "file")} (+${added} −${removed})`);
  }
  return parts.filter(Boolean).join(", ") || plural(items.length, "line");
}

export function MuseLog({ lines, live }: { lines: MuseLogLine[]; live: boolean }) {
  const { groups, summary } = groupLog(lines);
  return (
    <div
      className="muse"
      role={live ? "log" : undefined}
      aria-relevant={live ? "additions" : undefined}
      aria-label={live ? "Muse Code activity" : undefined}
    >
      {groups.map((g, i) => {
        if (g.type === "say")
          return (
            <p key={i} className="say">
              {g.text.trim()}
            </p>
          );
        if (g.type === "done")
          return (
            <p key={i} className="say say-final">
              {g.text.trim()}
            </p>
          );
        const isLast = i === groups.length - 1 || groups.slice(i + 1).every((x) => x.type !== "activity");
        if (live && isLast) return <ActivityList key={i} items={g.items} live />;
        if (g.items.length <= 3) return <ActivityList key={i} items={g.items} live={false} />;
        return (
          <details key={i} className="activity-fold">
            <summary>{groupSummary(g.items)}</summary>
            <ActivityList items={g.items} live={false} />
          </details>
        );
      })}
      {!groups.length ? (
        <p className="muted">{live ? "Muse Code is reading the brief." : "No activity was logged."}</p>
      ) : null}
      {summary.edits || summary.tools ? (
        <p className="muse-summary muted">
          {summary.tools ? plural(summary.tools, "tool call") : null}
          {summary.tools && summary.edits ? " · " : null}
          {summary.edits ? (
            <>
              Edited {plural(summary.files, "file")} <span className="plus">+{summary.added}</span>{" "}
              <span className="minus">−{summary.removed}</span>
            </>
          ) : null}
          {summary.failedTools ? ` · ${summary.failedTools} failed` : ""}
        </p>
      ) : null}
    </div>
  );
}

export function museUsageText(seg: Extract<Segment, { type: "muse" }>): string | null {
  return groupLog(seg.lines).summary.usageText;
}

// ---------- Checks ----------

const VERIFY_LABEL: Record<string, string> = {
  typecheck: "Typecheck",
  build: "Production build",
  start: "Server starts",
  console: "No console errors",
  smoke: "Smoke test",
  manifest: "Manifest",
};

export function CheckBody({ seg, live }: { seg: Extract<Segment, { type: "check" }>; live: boolean }) {
  const { verify, judge } = seg;
  return (
    <div className="check">
      {verify ? (
        <>
          <p className="lead">
            <strong>npm run verify</strong>
            <span className={`pill pill-${verify.summary.passed ? "live" : "failed"}`}>
              <span className="pill-dot" aria-hidden />
              {verify.summary.passed ? "Passed" : "Failed"}
            </span>
          </p>
          <ul className="vsteps">
            {verify.summary.steps.map((s) => (
              <li key={s.name} className={s.ok ? "ok" : "bad"}>
                <Icon name={s.ok ? "check" : "close"} size={16} title={s.ok ? "Passed" : "Failed"} />
                <span className="vstep-name">{VERIFY_LABEL[s.name] ?? s.name}</span>
                {typeof s.ms === "number" ? <span className="muted">{duration(s.ms)}</span> : null}
                {s.detail ? <span className="vstep-detail muted">{truncate(s.detail, 160)}</span> : null}
              </li>
            ))}
          </ul>
          {!verify.summary.passed && verify.summary.failureOutput ? (
            <details className="fold">
              <summary>Failing output</summary>
              <pre className="pre">{verify.summary.failureOutput}</pre>
            </details>
          ) : null}
          {verify.screenshots.length ? (
            <ul className="shots" aria-label="Screenshots from the smoke test">
              {verify.screenshots.map((s, i) => (
                <li key={s.url}>
                  <figure>
                    <a href={s.url} target="_blank" rel="noopener noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={s.url} alt={s.caption || `Screenshot ${i + 1}`} loading="lazy" />
                    </a>
                    {s.caption ? <figcaption>{s.caption}</figcaption> : null}
                  </figure>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : live ? (
        <p className="muted">Running typecheck, build, start, console and smoke checks.</p>
      ) : null}
      {judge ? (
        <div className={`judge judge-${judge.pass ? "pass" : "fail"}`}>
          <p className="lead">
            <strong>Screenshot judge</strong>
            <span className={`pill pill-${judge.pass ? "live" : "failed"}`}>
              <span className="pill-dot" aria-hidden />
              {judge.pass ? "Pass" : "Fail"}
            </span>
          </p>
          {judge.reasons.length ? (
            <ul>
              {judge.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
          {judge.mismatches.length ? (
            <>
              <h4>Doesn&apos;t match the brief</h4>
              <ul>
                {judge.mismatches.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : verify?.summary.passed && live ? (
        <p className="muted">Muse Wonder is judging the screenshots against the brief.</p>
      ) : null}
    </div>
  );
}

// ---------- Ship and outcomes ----------

export function ShipBody({
  status,
  liveUrl,
  slug,
  connectorUrl,
  models,
  demoUrl,
  demoPosterUrl = null,
}: {
  status: "live" | "partial";
  liveUrl: string | null;
  slug: string | null;
  connectorUrl: string | null;
  models: string[];
  demoUrl: string | null;
  demoPosterUrl?: string | null;
}) {
  return (
    <div className="ship">
      <p className="lead">
        <strong>{status === "live" ? "It's live." : "Shipped as partial."}</strong>
      </p>
      {status === "partial" ? (
        <p className="muted">
          The main page works, and some checks still fail for a documented reason. The limits are on the product page.
        </p>
      ) : null}
      {liveUrl ? (
        <p>
          <ExternalLink href={liveUrl} className="ship-link">
            {liveUrl.replace(/^https?:\/\//, "")}
          </ExternalLink>
        </p>
      ) : null}
      <ModelChips models={models} />
      {connectorUrl ? (
        <div className="field-block">
          <span className="field-label" id="ship-connector">
            Muse app connector
          </span>
          <CopyField value={connectorUrl} label="Connector URL" />
          <p className="muted small">Add it in the Muse app as a custom connector to use this product from chat.</p>
        </div>
      ) : null}
      {demoUrl ? (
        <video
          className="demo"
          src={demoUrl}
          poster={demoPosterUrl ?? undefined}
          controls
          preload="metadata"
          playsInline
          aria-label="Recorded demo"
        />
      ) : null}
      <div className="row-actions">
        {slug ? (
          <Link className="btn btn-outline" href={`/p/${slug}`}>
            <Icon name="grid" size={18} />
            Product page
          </Link>
        ) : null}
        <Link className="btn btn-outline" href="/">
          <Icon name="plus" size={18} />
          New muse
        </Link>
      </div>
    </div>
  );
}

export function tokensText(tokens: { input: number; cached: number; output: number }): string | null {
  if (!tokens.input && !tokens.output) return null;
  return `Input ${compact(tokens.input)} · Output ${compact(tokens.output)}`;
}
