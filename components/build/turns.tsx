"use client";

import Link from "next/link";
import { MediaCard, UserBubble, type BubbleAttachment } from "@/components/chat";
import { Icon } from "@/components/icons";
import { KIND_ICON } from "@/components/composer/AttachmentChip";
import { ExternalLink } from "@/components/ui";
import type { InspirationView, RebuildRef } from "@/components/view-types";
import { groupLog, type LogGroup, type Segment } from "@/components/build/derive";
import { DrillGroup } from "@/components/build/DrillGroup";
import { splitDrillSteps } from "@/lib/edge/drills";
import { splitBuildNote } from "@/lib/docs/build-note";
import { isContributorPolish, isPolishMessage, polishRoomTitleFor } from "@/lib/polish/logic";
import { costItemsOf, planMoney, runCostUsd } from "@/lib/brief/cost";
import { briefKeepsWonder, compact, duration, modelLabel, plural, servedModelLabel, truncate, usd } from "@/lib/format";
import type { Brief, Reference } from "@/lib/types";

/** The building blocks of the build room's conversation column. */

export function segmentMeta(seg: Segment, extra: Array<string | null | false> = []): string[] {
  const ms = Date.parse(seg.endAt) - Date.parse(seg.startAt);
  return [
    Number.isFinite(ms) && ms > 0 ? duration(ms) : null,
    ...extra,
    seg.costUsd > 0 ? `${usd(seg.costUsd)} est.` : null,
  ].filter((s): s is string => Boolean(s));
}

// ---------- The user's muse ----------

/** A reference as a thumbnail in the person's bubble: the picture, or its kind's icon with its name for screen readers. */
export function referenceAttachment(r: Reference, index: number): BubbleAttachment {
  if (r.kind === "image") return { src: r.url, alt: `Inspo ${index + 1}: ${r.fileName}`, href: r.url };
  return { alt: truncate(r.fileName, 32), icon: KIND_ICON[r.kind], href: r.url };
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
  // The polish round (lib/polish/logic.ts): named plainly, with the platform's note folded away.
  if (isPolishMessage(message)) {
    return (
      <li className="turn-user">
        <h2 className="sr-only">Your muse</h2>
        <p className="rebuild-tag">
          <Icon name="sparkle" size={16} />
          <span>{polishRoomTitleFor(message)}</span>
        </p>
        <UserBubble text={isContributorPolish(message) ? "A quick UI pass on Muse Spark 1.3 Contributor. Every feature stays as it is." : "A final UI pass to Meta's look, on Muse Wonder. Every feature stays as it is."} attachments={[]} />
        <details className="bubble-context">
          <summary>What Muse Code was asked</summary>
          {message
            .split("\n")
            .filter((line) => line.trim())
            .map((line, i) => (
              <p key={i}>{line}</p>
            ))}
        </details>
      </li>
    );
  }
  const note = message ?? inspiration?.note ?? null;
  const { wish: text, context } = note ? splitBuildNote(note) : { wish: null, context: null };
  return (
    <li className="turn-user">
      <h2 className="sr-only">Your muse</h2>
      {rebuild ? (
        <p className="rebuild-tag">
          <Icon name="cap" size={16} />
          {rebuild.learnHref ? (
            <>
              <span>For Meta&apos;s lesson</span>
              <ExternalLink href={rebuild.url}>{truncate(rebuild.title, 70)}</ExternalLink>
              <Link href={rebuild.learnHref}>How it measures up</Link>
            </>
          ) : (
            <span>First demo: {truncate(rebuild.title, 70)}</span>
          )}
        </p>
      ) : null}
      {text || refs.length ? (
        <UserBubble text={text} attachments={refs.map(referenceAttachment)} />
      ) : (
        <UserBubble text={<span className="muted">No note</span>} />
      )}
      {context ? (
        <details className="bubble-context">
          <summary>From the docs page</summary>
          <p>{context}</p>
        </details>
      ) : null}
    </li>
  );
}

// ---------- Brief ----------

export const VERDICT: Record<Brief["verdict"], { label: string; tone: string }> = {
  yes: { label: "Can build", tone: "live" },
  partly: { label: "Can build part of it", tone: "partial" },
  no: { label: "Can't build this", tone: "failed" },
};

/** What a brief's inputs and outputs are, in a word. */
const MEDIA_LABEL: Record<Brief["inputs"][number]["kind"] | Brief["outputs"][number]["kind"], string> = {
  text: "Text",
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF",
  overlay: "Overlay",
  json: "JSON",
  file: "File",
};

const filled = (list: readonly string[]) => list.map((s) => s.trim()).filter(Boolean);

/**
 * The whole brief: who it's for, how it works, the screens, what goes in and comes out, the models and why, the limits,
 * what it takes from the inspo and the cost per run. A part with nothing in it is left out, heading and all. The steps
 * panel's "Read the brief" shows it with its name and verdict on top; the plan card (PlanCard.tsx) shows it under its
 * own name and tagline, so it passes `title={false}`. A declined brief shows its reason instead.
 */
export function BriefBody({ brief, title = true }: { brief: Brief; title?: boolean }) {
  const verdict = VERDICT[brief.verdict];
  const declined = brief.verdict === "no" || Boolean(brief.refusal);
  const user = brief.user.trim();
  const flow = filled(brief.primaryFlow);
  const screens = brief.screens.filter((s) => s.name.trim() || s.purpose.trim());
  const limits = filled(brief.limits);
  const borrow = filled(brief.inspiration.borrow);
  const dontCopy = filled(brief.inspiration.dontCopy);
  const inspo = brief.inspiration.summary.trim();
  const costNotes = brief.costNotes.trim();
  // The total is the sum of the parts listed under it, worked out in code (lib/brief/cost.ts), so the two always agree.
  const costParts = costItemsOf(brief);
  return (
    <div className="rich">
      {title ? (
        <>
          <p className="lead">
            <strong>{brief.name}</strong>
            <span className={`pill pill-${declined ? "failed" : verdict.tone}`}>
              <span className="pill-dot" aria-hidden />
              {brief.refusal ? "Declined" : verdict.label}
            </span>
          </p>
          {brief.tagline ? <p className="muted">{brief.tagline}</p> : null}
        </>
      ) : null}
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
          {user ? (
            <>
              <h3>Who it&apos;s for</h3>
              <p>{user}</p>
            </>
          ) : null}
          {flow.length ? (
            <>
              <h3>How it works</h3>
              <ol>
                {flow.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </>
          ) : null}
          {screens.length ? (
            <>
              <h3>Screens</h3>
              <ul>
                {screens.map((s, i) => (
                  <li key={`${s.name}-${i}`}>
                    <strong>{s.name}.</strong> {s.purpose}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {brief.inputs.length ? (
            <>
              <h3>What goes in</h3>
              <ul>
                {brief.inputs.map((x, i) => (
                  <li key={i}>
                    <strong>{MEDIA_LABEL[x.kind] ?? x.kind}</strong>
                    {x.required ? "" : " (optional)"}
                    {x.notes.trim() ? `: ${x.notes.trim()}` : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {brief.outputs.length ? (
            <>
              <h3>What comes out</h3>
              <ul>
                {brief.outputs.map((x, i) => (
                  <li key={i}>
                    <strong>{MEDIA_LABEL[x.kind] ?? x.kind}</strong>
                    {x.notes.trim() ? `: ${x.notes.trim()}` : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {brief.capabilities.length ? (
            <>
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
                          <strong>{servedModelLabel(c.model, { keepsWonder: briefKeepsWonder(brief) })}</strong>
                        </td>
                        <td>{c.need}</td>
                        <td>{c.why}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          {limits.length ? (
            <>
              <h3>Limits</h3>
              <ul>
                {limits.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </>
          ) : null}
          {inspo || borrow.length || dontCopy.length ? <h3>From your inspo</h3> : null}
          {inspo ? <p>{inspo}</p> : null}
          {borrow.length || dontCopy.length ? (
            <div className="two-col">
              {borrow.length ? (
                <div>
                  <h4>Takes</h4>
                  <ul>
                    {borrow.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {dontCopy.length ? (
                <div>
                  <h4>Leaves out</h4>
                  <ul>
                    {dontCopy.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          <p>
            <strong>Cost per run:</strong> about {costParts.length ? planMoney(runCostUsd(brief)) : usd(brief.estimatedCostPerRunUsd)} (est.)
            {costParts.length ? ", from these parts:" : "."}{" "}
            {costNotes && !costParts.length ? <span className="muted">{costNotes}</span> : null}
          </p>
          {costParts.length ? (
            <>
              <ul>
                {costParts.map((c, i) => (
                  <li key={i}>
                    {c.what.replace(/[.;\s]+$/, "")}: {planMoney(c.usd)}
                  </li>
                ))}
              </ul>
              {costNotes ? <p className="muted">{costNotes}</p> : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------- Muse Code log ----------

/** A long run of activity in a few words, for the row that folds it. */
export function groupSummary(items: Extract<LogGroup, { type: "activity" }>["items"]): string {
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

export function museUsageText(seg: Extract<Segment, { type: "muse" }>): string | null {
  return groupLog(seg.lines).summary.usageText;
}

// ---------- Checks ----------

export const VERIFY_LABEL: Record<string, string> = {
  typecheck: "Typecheck",
  build: "Production build",
  start: "Server starts",
  console: "No console errors",
  smoke: "Smoke test",
  requirements: "Requirements",
  manifest: "Manifest",
};

/** What the checks ran and what the judge said. Their screenshots are the step's thumbnails (roomSteps). */
export function CheckBody({ seg, live }: { seg: Extract<Segment, { type: "check" }>; live: boolean }) {
  const { verify, judge } = seg;
  // An edge build's simulated outage drills show as their own group. For any other build `checks` is verify's steps.
  const { checks, drills } = splitDrillSteps(verify?.summary.steps ?? []);
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
            {checks.map((s) => (
              <li key={s.name} className={s.ok ? "ok" : "bad"}>
                <Icon name={s.ok ? "check" : "close"} size={16} title={s.ok ? "Passed" : "Failed"} />
                <span className="vstep-name">{VERIFY_LABEL[s.name] ?? s.name}</span>
                {typeof s.ms === "number" ? <span className="muted">{duration(s.ms)}</span> : null}
                {s.detail ? <span className="vstep-detail muted">{truncate(s.detail, 160)}</span> : null}
              </li>
            ))}
          </ul>
          <DrillGroup drills={drills} />
          {!verify.summary.passed && verify.summary.failureOutput ? (
            <details className="fold">
              <summary>Failing output</summary>
              <pre className="pre">{verify.summary.failureOutput}</pre>
            </details>
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
  unpublished = false,
  issues = [],
}: {
  status: "live" | "partial";
  liveUrl: string | null;
  slug: string | null;
  unpublished?: boolean;
  /** Known issues (lib/pipeline/known-issues.ts): the failed judge's mismatches and the live checks that failed. */
  issues?: string[];
}) {
  return (
    <div className="ship">
      <p>{unpublished ? (status === "live" ? "It's finished, but not online." : "Finished as partial, but not online.") : status === "live" ? "It's live." : "Shipped as partial."}</p>
      {issues.length ? (
        <KnownIssues issues={issues} />
      ) : status === "partial" ? (
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

/** What a shipped build still gets wrong, in the checks' own words. Never hidden behind a clean "It's live". */
export function KnownIssues({ issues }: { issues: string[] }) {
  if (!issues.length) return null;
  return (
    <div className="known-issues" role="note" aria-label="Known issues">
      <p>
        <strong>Known {issues.length === 1 ? "issue" : "issues"}</strong>
      </p>
      <ul>
        {issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
    </div>
  );
}

/** What the build made, once it's done: the demo video, else its poster, else the checks' last screenshot. */
export function BuildOutput({
  name,
  demoUrl,
  demoPosterUrl = null,
  screenshotUrl = null,
}: {
  name: string;
  demoUrl: string | null;
  demoPosterUrl?: string | null;
  screenshotUrl?: string | null;
}) {
  if (demoUrl) {
    return (
      <MediaCard label="Recorded demo" ratio="16 / 10">
        <video src={demoUrl} poster={demoPosterUrl ?? undefined} controls preload="metadata" playsInline aria-label="Recorded demo" />
      </MediaCard>
    );
  }
  const still = demoPosterUrl ?? screenshotUrl;
  if (!still) return null;
  return (
    <MediaCard label={demoPosterUrl ? "From the demo" : "From the checks"} ratio="16 / 10">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={still} alt={`What ${name} looks like`} loading="lazy" />
    </MediaCard>
  );
}

/** The running product, in the conversation while the build works. */
export function LivePreview({ url, name }: { url: string; name: string }) {
  return (
    <>
      <MediaCard label="Live preview" ratio="16 / 10">
        <iframe
          src={url}
          title={`Live preview of ${name}`}
          loading="lazy"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          referrerPolicy="no-referrer"
        />
      </MediaCard>
      <a className="room-media-link" href={url} target="_blank" rel="noopener noreferrer">
        Open preview
        <Icon name="external" size={14} className="ext-icon" />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </>
  );
}

export function tokensText(tokens: { input: number; cached: number; output: number }): string | null {
  if (!tokens.input && !tokens.output) return null;
  return `Input ${compact(tokens.input)} · Output ${compact(tokens.output)}`;
}
