import type { StepItem, StepMedia, StepState } from "@/components/chat";
import { plural, usd } from "@/lib/format";
import type { NativeItemView, NativeRunView } from "@/lib/types";

/**
 * The build room's "Apps" step: a native run's packages and lab checks as rows in roomSteps' targets slot, built on
 * condenseNativeEvents (docs/NATIVE.md). Events may come from a newer branch, so anything here that isn't the expected
 * shape is left out, not shown broken.
 */

/** Only what's truly running gets the turning icon. Waiting and planned steps are quiet rows with a dot, whose titles say so. */
function itemState(state: NativeItemView["state"], live: boolean): StepState {
  if (state === "failed") return "failed";
  return state === "running" && live ? "running" : "done";
}

const unsettled = (state: NativeItemView["state"]) => state === "planned" || state === "queued" || state === "running";

/** How long a queue is, in words. Null while nothing says, and when the title already does. */
export function queueWords(item: Pick<NativeItemView, "queue" | "title" | "state">): string | null {
  const q = item.queue;
  if (item.state !== "queued" || !q || typeof q.ahead !== "number" || /\bahead\b/i.test(item.title)) return null;
  const minutes = typeof q.etaSeconds === "number" && q.etaSeconds > 0 ? Math.max(1, Math.round(q.etaSeconds / 60)) : null;
  const eta = minutes ? `about ${plural(minutes, "minute")}` : null;
  return [q.ahead > 0 ? `${plural(q.ahead, "check")} ahead` : "Next in line", eta].filter(Boolean).join(", ");
}

function mediaOf(item: NativeItemView): { thumbs: StepMedia[]; clipsWithNoPoster: Array<{ url: string; caption: string }> } {
  const thumbs: StepMedia[] = [];
  const clipsWithNoPoster: Array<{ url: string; caption: string }> = [];
  const seen = new Set<string>();
  for (const m of Array.isArray(item.media) ? item.media : []) {
    if (typeof m?.url !== "string") continue;
    const caption = typeof m.caption === "string" ? m.caption : item.title;
    if (m.kind === "video" && !m.posterUrl) {
      clipsWithNoPoster.push({ url: m.url, caption });
      continue;
    }
    const src = m.kind === "video" ? (m.posterUrl as string) : m.url;
    if (seen.has(src)) continue;
    seen.add(src);
    thumbs.push({ kind: m.kind === "video" ? "video" : "image", src, alt: caption, href: m.url });
  }
  return { thumbs, clipsWithNoPoster };
}

function itemRow(runId: string, item: NativeItemView, live: boolean): StepItem {
  const { thumbs, clipsWithNoPoster } = mediaOf(item);
  const title = typeof item.title === "string" ? item.title : item.item;
  // Some titles already give the cost: "Real Galaxy S25 on AWS Device Farm: 4 device minutes, $0.68".
  const cost = typeof item.costUsd === "number" && item.costUsd > 0 && !title.includes(usd(item.costUsd)) ? usd(item.costUsd) : null;
  const description = [
    typeof item.detail === "string" ? item.detail : null,
    live ? queueWords(item) : null,
    !live && unsettled(item.state) ? "It didn't finish." : null,
    cost,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    id: `apps:${runId}/${item.item}`,
    title,
    ...(description ? { description } : {}),
    state: itemState(item.state, live),
    ...(thumbs.length ? { media: thumbs } : {}),
    ...(clipsWithNoPoster.length
      ? {
          body: (
            <>
              {clipsWithNoPoster.map((c) => (
                <p key={c.url}>
                  <a href={c.url} target="_blank" rel="noopener noreferrer">
                    {c.caption}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </p>
              ))}
            </>
          ),
        }
      : {}),
  };
}

/** What a run's row says, by who started it and how it stands. */
function runTitle(run: NativeRunView, live: boolean): { title: string; state: StepState } {
  const going = live && run.active;
  const results = run.items.map((i) => i.state);
  // Steps left unsettled with nothing more coming, or every step failed.
  const fellShort = !going && (run.active || results.every((s) => s === "failed"));
  if (run.origin === "agent") {
    if (going) return { title: "Trying it on devices", state: "running" };
    return fellShort ? { title: "The device checks didn't finish", state: "failed" } : { title: "Tried it on devices", state: "done" };
  }
  if (going) return { title: run.origin === "refine" ? "Checking the apps again" : "Making the apps", state: "running" };
  if (fellShort) return { title: "The apps didn't finish", state: "failed" };
  if (results.every((s) => s === "skipped")) return { title: "No apps this time", state: "done" };
  return { title: run.origin === "refine" ? "Checked the apps again" : "Made the apps", state: "done" };
}

function runCounts(run: NativeRunView): string {
  const failed = run.items.filter((i) => i.state === "failed").length;
  const skipped = run.items.filter((i) => i.state === "skipped").length;
  const done = run.items.filter((i) => i.state === "done").length;
  return [
    `${done} of ${plural(run.items.length, "step")} done`,
    failed ? `${failed} failed` : null,
    skipped ? `${skipped} skipped` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The rows for roomSteps' targets slot, one per run. With no runs there are none, and the page has no trace of this. */
export function nativeRows(runs: readonly NativeRunView[], opts: { live: boolean; slug?: string | null }): StepItem[] {
  return runs.map((run) => {
    const { title, state } = runTitle(run, opts.live);
    const description = [runCounts(run), run.costUsd > 0 ? `${usd(run.costUsd)} est.` : null].filter(Boolean).join(" · ");
    const finished = !(opts.live && run.active);
    return {
      id: `apps:${run.runId}`,
      title,
      description,
      state,
      ...(finished && opts.slug && run.origin !== "agent" && run.items.some((i) => i.state === "done") ? { body: <a href={`/p/${opts.slug}#get-it-title`}>Get them on the product page</a> } : {}),
      children: run.items.map((item) => itemRow(run.runId, item, opts.live && run.active)),
    };
  });
}

/** The line in the conversation for the newest run a person cares about. An agent's tries belong to its round, in the panel. */
export function appsLine(runs: readonly NativeRunView[], live: boolean): { runId: string; title: string; description?: string; state: StepState; costUsd: number } | null {
  const run = [...runs].reverse().find((r) => r.origin !== "agent");
  if (!run) return null;
  const { title, state } = runTitle(run, live);
  const going = live && run.active;
  const now = going ? (run.items.find((i) => i.state === "running") ?? run.items.find((i) => i.state === "queued")) : null;
  const queue = now ? queueWords(now) : null;
  const description = now ? [now.title, queue].filter(Boolean).join(": ") : runCounts(run);
  return { runId: run.runId, title, ...(description ? { description } : {}), state, costUsd: run.costUsd };
}
