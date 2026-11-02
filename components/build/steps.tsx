import type { ReactNode } from "react";
import type { SourceItem, StepItem, StepMedia, StepState, StepsEnd } from "@/components/chat";
import { groupLog, type AgentNode, type LogGroup, type Note, type OpenQuestion, type RailState, type RailStep, type RoomState, type Segment, type WatcherRun } from "@/components/build/derive";
import { GoalCard, Thinking, TodoList, statusWords, steerMeta } from "@/components/build/session";
import { BriefBody, CheckBody, VERIFY_LABEL, groupSummary, museUsageText, segmentMeta } from "@/components/build/turns";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import type { InspirationView } from "@/components/view-types";
import { modelLabel, plural, truncate } from "@/lib/format";
import { NOTE_REPLY_PREFIX } from "@/lib/pipeline/control";
import type { BuildStatus, MuseLineDetail, MuseLogLine } from "@/lib/types";

/**
 * Maps a build onto the chat kit (docs/UI_MUSE_APP.md, "Where it applies"): the steps panel's list and sources, and the
 * few things the conversation column keeps. Every piece of the old room has a place here; the table in the spec says
 * which. Works the same for a session bridge round and a `muse exec` round, which simply has fewer pieces.
 */

type MuseSegment = Extract<Segment, { type: "muse" }>;
type CheckSegment = Extract<Segment, { type: "check" }>;
type ActivityItem = Extract<LogGroup, { type: "activity" }>["items"][number];

/** How many of a running round's newest lines stay unfolded. */
const RECENT_LINES = 8;
/** A run of activity longer than this folds behind its summary. */
const SHORT_RUN = 3;

/** What the build is doing, as the conversation and the steps list say it. */
const WORKING: Partial<Record<BuildStatus, string>> = {
  queued: "Waiting to start",
  briefing: "Muse Wonder is reading your inspo and writing the brief",
  provisioning: "Setting up a sandbox for this product",
  building: "Muse Code is building",
  previewing: "Starting the live preview",
  verifying: "Checking it",
  fixing: "Muse Code is fixing what failed",
  recording: "Recording the demo",
  deploying: "Deploying it to its own link",
};

/** A stage that failed with no turn of its own to say so. */
const STAGE_FAILED: Record<RailStep, string> = {
  brief: "The brief didn't finish",
  provision: "The sandbox didn't start",
  build: "Muse Code didn't start",
  preview: "The live preview didn't start",
  check: "The checks didn't finish",
  record: "The demo wasn't recorded",
  deploy: "It didn't deploy",
};

/** The turn that can still change: the newest, while the build is in the matching phase. During "fixing", round 0 has ended even before the fix round logs its first line. */
export function liveSegmentKey(room: RoomState): string | undefined {
  const last = room.segments[room.segments.length - 1];
  if (room.terminal || !last) return undefined;
  const museWorking = last.type === "muse" && (room.status === "building" || room.status === "fixing");
  return museWorking || (last.type === "check" && room.status === "verifying") ? last.key : undefined;
}

/** The link Share copies: the live product once it ships, the build room before. */
export function shareLink(input: { liveUrl: string | null; origin: string; buildId: string }): string {
  return input.liveUrl ?? `${input.origin}/b/${input.buildId}`;
}

/** How the steps list ends. A build still running has no end row. */
export function stepsEnd(room: RoomState): StepsEnd | undefined {
  if (!room.terminal) return undefined;
  if (room.status === "live" || room.status === "partial") return "done";
  const said = `${room.lastStatusMessage ?? ""} ${room.lastError ?? ""}`;
  return /stopped by you|owner stopped/i.test(said) ? "stopped" : "unfinished";
}

// ---------- The Steps tab ----------

const statusState = (status: string): StepState => {
  const tone = statusWords(status).tone;
  return tone === "building" ? "running" : tone === "failed" ? "failed" : "done";
};

/** Something left running when its round ended didn't keep working. */
const settled = (state: StepState, live: boolean): StepState => (state === "running" && !live ? "done" : state);

/** A status in words, which agrees with settled(). */
function statusSaid(status: string, live: boolean): string {
  const words = statusWords(status);
  return words.tone === "building" && !live ? "Ended" : words.label;
}

function noteRow(n: Note): StepItem {
  return { id: `note:${n.id}`, title: n.text, state: n.kind === "error" ? "failed" : "done" };
}

function itemRow(it: ActivityItem, id: string, live: boolean): StepItem {
  const failed = "ok" in it && it.ok === false;
  switch (it.type) {
    case "tool":
      return {
        id,
        kind: "tool",
        title: it.tool ? `${it.text} · ${it.tool}` : it.text,
        state: failed ? "failed" : settled(it.running ? "running" : "done", live),
      };
    case "edit": {
      const extra = it.text && !/^edited/i.test(it.text) ? ` ${it.text}` : "";
      return { id, title: `Edited ${plural(it.files, "file")} +${it.added} −${it.removed}${extra}`, state: "done" };
    }
    case "subagent":
      return {
        id,
        kind: "subagent",
        title: it.text,
        description: statusSaid(it.status, live),
        state: failed ? "failed" : settled(statusState(it.status), live),
      };
    default:
      return { id, title: it.text, state: failed || it.type === "error" ? "failed" : "done" };
  }
}

/** One run of activity: as rows when it's short or still moving, folded behind its summary when it's long. */
function activityRows(items: ActivityItem[], id: string, live: boolean, newest: boolean): StepItem[] {
  const rows = items.map((it, i) => itemRow(it, `${id}/${i}`, live));
  if (live && newest) {
    if (rows.length <= RECENT_LINES) return rows;
    const earlier = rows.slice(0, -RECENT_LINES);
    return [{ id: `${id}/earlier`, title: plural(earlier.length, "earlier step"), state: "done", folded: true, children: earlier }, ...rows.slice(-RECENT_LINES)];
  }
  if (rows.length <= SHORT_RUN) return rows;
  return [{ id, title: groupSummary(items), state: rows.some((r) => r.state === "failed") ? "failed" : "done", folded: true, children: rows }];
}

function workflowRow(g: Extract<LogGroup, { type: "workflow" }>, id: string, live: boolean): StepItem {
  const said = statusSaid(g.status, live);
  return {
    id,
    kind: "workflow",
    title: g.text,
    description: g.phase ? `${said} · Phase: ${g.phase}` : said,
    state: settled(statusState(g.status), live),
    children: g.children.map((c, i) => ({
      id: `${id}/${i}`,
      title: c.label,
      description: statusSaid(c.status, live),
      state: settled(statusState(c.status), live),
    })),
  };
}

/** The round's log, in order. */
function logRows(seg: MuseSegment, live: boolean, listsAgents: boolean): StepItem[] {
  const { groups } = groupLog(seg.lines);
  const lastActivity = groups.reduce((at, g, i) => (g.type === "activity" ? i : at), -1);
  const lastSay = groups.reduce<string | null>((said, g) => (g.type === "say" ? g.text.trim() : said), null);
  return groups.flatMap((g, i): StepItem[] => {
    const id = `${seg.key}/${i}`;
    switch (g.type) {
      case "say":
        return [{ id, title: "", state: "done", body: <MarkdownText className="say" text={g.text.trim()} /> }];
      case "done":
        // On the session bridge the last message comes twice: as itself, and as what the round ended on.
        return g.text.trim() === lastSay ? [] : [{ id, title: "", state: "done", body: <MarkdownText className="say say-final" text={g.text.trim()} /> }];
      case "thinking":
        return [{ id, title: "", state: "done", body: <Thinking text={g.text} /> }];
      case "steer":
        return [{ id, title: "Note from the owner", description: `${g.text} (${steerMeta(g)})`, state: g.status === "refused" ? "failed" : "done" }];
      case "workflow":
        // The Agents row already has it, with its children.
        return listsAgents ? [] : [workflowRow(g, id, live)];
      case "activity":
        // "Started" says nothing once the round has anything else to show.
        return activityRows(groups.length > 1 ? g.items.filter((it) => it.type !== "start") : g.items, id, live, i === lastActivity);
    }
  });
}

function agentRow(n: AgentNode, live: boolean): StepItem {
  const said = statusSaid(n.status, live);
  const where = n.phase ? `Phase: ${n.phase}` : n.path;
  return {
    id: `agent:${n.id}`,
    kind: n.kind === "child" ? "step" : n.kind,
    title: n.name,
    description: where ? `${said} · ${where}` : said,
    state: settled(statusState(n.status), live),
    children: n.children.map((c) => agentRow(c, live)),
  };
}

function observerRows(seg: MuseSegment): StepItem[] {
  const observers: WatcherRun[] = seg.session?.observers ?? [];
  const rows = observers.map((o): StepItem => ({ id: `observer:${o.id}`, kind: "observer", title: o.text, state: o.ok === false ? "failed" : "done" }));
  if (rows.length <= SHORT_RUN) return rows;
  return [{ id: `${seg.key}/observers`, title: `${plural(rows.length, "observer")} ran`, state: rows.some((r) => r.state === "failed") ? "failed" : "done", folded: true, children: rows }];
}

function questionRows(seg: MuseSegment, live: boolean): StepItem[] {
  return (seg.session?.questions ?? []).map((q: OpenQuestion) => ({
    id: `question:${q.itemId}`,
    title: "Muse Code asks",
    description: q.questions.map((x) => x.text).join(" "),
    state: settled("running", live),
  }));
}

function roundDescription(seg: MuseSegment): string {
  const { summary } = groupLog(seg.lines);
  const edits = summary.edits ? `Edited ${plural(summary.files, "file")} +${summary.added} −${summary.removed}` : null;
  return [
    summary.tools ? plural(summary.tools, "tool call") : null,
    edits,
    summary.failedTools ? `${summary.failedTools} failed` : null,
    ...segmentMeta(seg, [museUsageText(seg)]),
  ]
    .filter(Boolean)
    .join(" · ");
}

function roundRow(seg: MuseSegment, opts: { live: boolean; failed: boolean; isRefine: boolean; newest: boolean }): StepItem {
  const { live, failed } = opts;
  const ended = seg.round === 0 ? (opts.isRefine ? "Muse Code made the change" : "Muse Code built it") : `Fix round ${seg.round}`;
  const title = live ? (seg.round === 0 ? "Muse Code is working" : `Fix round ${seg.round} is working`) : failed ? (seg.round === 0 ? "Muse Code didn't finish" : `Fix round ${seg.round} didn't finish`) : ended;
  const session = seg.session;
  const agents = opts.newest && session?.agents.length ? [{ id: `${seg.key}/agents`, title: "Agents", state: "done" as const, children: session.agents.map((n) => agentRow(n, live)) }] : [];
  const log = logRows(seg, live, agents.length > 0);
  const body: ReactNode =
    session?.goal || session?.todos.length ? (
      <>
        {session.goal ? <GoalCard goal={session.goal} /> : null}
        {session.todos.length ? <TodoList todos={session.todos} /> : null}
      </>
    ) : null;
  const description = roundDescription(seg);
  return {
    id: seg.key,
    title,
    ...(description ? { description } : {}),
    state: live ? "running" : failed ? "failed" : "done",
    ...(body ? { body } : {}),
    children: [
      ...seg.notes.filter((n) => n.leading).map(noteRow),
      ...agents,
      ...log,
      ...(log.length ? [] : [{ id: `${seg.key}/empty`, title: live ? "Muse Code is reading the brief." : "No activity was logged.", state: "done" as const }]),
      ...observerRows(seg),
      ...questionRows(seg, live),
      ...seg.notes.filter((n) => !n.leading).map(noteRow),
    ],
  };
}

function checkTitle(seg: CheckSegment, live: boolean): string {
  const failed = seg.verify?.summary.passed === false || seg.judge?.pass === false;
  const tryWord = seg.index === 0 ? "" : `, try ${seg.index + 1}`;
  if (failed) return `Checks found problems${tryWord}`;
  if (live) return `Checking it${tryWord}`;
  return seg.judge ? `Checks passed${tryWord}` : `Checks ran${tryWord}`;
}

function checkRow(seg: CheckSegment, live: boolean): StepItem {
  const failed = seg.verify?.summary.passed === false || seg.judge?.pass === false;
  const media: StepMedia[] = (seg.verify?.screenshots ?? []).map((s, i) => ({ kind: "image", src: s.url, alt: s.caption || `Screenshot ${i + 1}`, href: s.url }));
  const description = segmentMeta(seg).join(" · ");
  return {
    id: seg.key,
    title: checkTitle(seg, live),
    ...(description ? { description } : {}),
    state: failed ? "failed" : live ? "running" : "done",
    ...(media.length ? { media } : {}),
    body: <RowFold summary="What ran" open={failed || live}><CheckBody seg={seg} live={live} /></RowFold>,
    children: seg.notes.map(noteRow),
  };
}

/** A fold in a row's body, for what's too long to leave open. */
function RowFold({ summary, open = false, children }: { summary: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="room-fold" open={open}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

function segmentRow(seg: Segment, opts: { live: boolean; failed: boolean; isRefine: boolean; newestRound: string | undefined }): StepItem {
  switch (seg.type) {
    case "brief": {
      const declined = seg.brief.verdict === "no" || Boolean(seg.brief.refusal);
      const description = [seg.brief.refusal ?? (seg.brief.tagline || null), ...segmentMeta(seg)].filter(Boolean).join(" · ");
      return {
        id: seg.key,
        title: declined ? "Declined" : "Wrote the brief",
        ...(description ? { description } : {}),
        state: declined ? "failed" : "done",
        body: <RowFold summary="Read the brief"><BriefBody brief={seg.brief} /></RowFold>,
        children: seg.notes.map(noteRow),
      };
    }
    case "muse":
      return roundRow(seg, { live: opts.live, failed: opts.failed, isRefine: opts.isRefine, newest: seg.key === opts.newestRound });
    case "check":
      return checkRow(seg, opts.live);
    case "record": {
      const description = segmentMeta(seg).join(" · ");
      return {
        id: seg.key,
        title: "Recorded the demo",
        ...(description ? { description } : {}),
        state: "done",
        ...(seg.posterUrl ? { media: { kind: "video" as const, src: seg.posterUrl, alt: "Recorded demo", href: seg.url } } : { body: <a href={seg.url} target="_blank" rel="noopener noreferrer">Open the demo</a> }),
        children: seg.notes.map(noteRow),
      };
    }
    case "deploy": {
      const description = segmentMeta(seg).join(" · ");
      return {
        id: seg.key,
        title: "Deployed",
        ...(description ? { description } : {}),
        body: <p>Live at <a href={seg.url} target="_blank" rel="noopener noreferrer">{seg.url.replace(/^https?:\/\//, "")}<span className="sr-only"> (opens in a new tab)</span></a></p>,
        state: "done",
        children: seg.notes.map(noteRow),
      };
    }
  }
}

/**
 * The whole build in order: what happened before any turn, the brief, the sandbox, each Muse Code round with everything
 * under it, the preview, the checks and fix rounds, the demo, the deploy, then the product's other targets.
 *
 * `targets` is where native targets' screenshots and videos go (phone, desktop, glasses, VR): rows with `media`, under
 * the deploy. Nothing fills it yet, and with none there is no row and no trace of it on the page.
 */
export function roomSteps(input: {
  room: RoomState;
  rail: Record<RailStep, RailState>;
  isRefine: boolean;
  targets?: readonly StepItem[];
}): StepItem[] {
  const { room, rail, isRefine, targets = [] } = input;
  const liveKey = liveSegmentKey(room);
  const last = room.segments[room.segments.length - 1];
  const rounds = room.segments.filter((s): s is MuseSegment => s.type === "muse");
  const newestRound = rounds[rounds.length - 1]?.key;
  const ended = room.status === "failed";

  const rows: StepItem[] = [];
  if (room.preNotes.length) rows.push({ id: "pre", title: "Getting ready", state: room.preNotes.some((n) => n.kind === "error") ? "failed" : "done", children: room.preNotes.map(noteRow) });

  const sandbox = (): StepItem[] => (rail.provision === "done" ? [{ id: "provision", title: "Set up the sandbox", state: "done" }] : []);
  const preview = (): StepItem[] => (rail.preview === "done" ? [{ id: "preview", title: "Started the live preview", state: "done" }] : []);

  const hasBrief = room.segments.some((s) => s.type === "brief");
  if (!hasBrief) rows.push(...sandbox());
  let previewed = false;
  for (const seg of room.segments) {
    rows.push(segmentRow(seg, { live: seg.key === liveKey, failed: ended && seg === last && seg.type === "muse", isRefine, newestRound }));
    if (seg.type === "brief") rows.push(...sandbox());
    if (seg.type === "muse" && !previewed) {
      previewed = true;
      rows.push(...preview());
    }
  }
  if (!previewed) rows.push(...preview());
  rows.push(...targets);

  // What's going on now, when no turn says so yet.
  if (!room.terminal && !liveKey) rows.push({ id: "now", title: WORKING[room.status] ?? "Working", state: "running" });
  // A stage that failed with no turn of its own.
  if (ended && last?.type !== "muse") {
    const stage: RailStep = room.lastRail ?? "brief";
    const said = last?.type === "check" && (last.verify?.summary.passed === false || last.judge?.pass === false);
    if (!said) rows.push({ id: "failed", title: STAGE_FAILED[stage], ...(room.lastError ? { description: room.lastError } : {}), state: "failed" });
  }
  if (room.status === "refused" && !hasBrief) rows.push({ id: "refused", title: "Declined", ...(room.lastError ? { description: room.lastError } : {}), state: "failed" });
  return rows;
}

// ---------- The Sources tab ----------

/** What a Muse Code line looked at, from what the session bridge noted or, on `muse exec`, from the tool's name. */
function lineSource(l: MuseLogLine): NonNullable<MuseLineDetail["source"]> | "models" | null {
  if (l.detail?.source) return l.detail.source;
  if (l.kind !== "tool") return null;
  const name = (l.tool ?? "").replace(/^mcp__.+?__/, "");
  if (name === "models_list") return "models";
  if (name === "docs_read") return { kind: "docs", title: l.text };
  return null;
}

/** A docs slug as the agent gave it: a slug, a /docs/ path or a dev.meta.ai URL, with an optional #anchor. */
function docsHref(slug: string): string | undefined {
  const page = slug.replace(/^https?:\/\/[^/]+/, "").replace(/^\/?docs\//, "").replace(/^\//, "");
  return /^[\w/#-]+$/.test(page) ? `/docs/${page}` : undefined;
}

/**
 * What the build used: the muse's references, the models in its brief, then the Meta docs pages, the model catalog, the
 * skills and the web searches Muse Code looked at, each once.
 */
export function roomSources(input: { room: RoomState; inspiration: InspirationView | null; showReferences: boolean; models: readonly string[] }): SourceItem[] {
  const { room, inspiration, showReferences, models } = input;
  const out: SourceItem[] = [];
  const seen = new Set<string>();
  const add = (s: SourceItem) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push(s);
  };

  const described = room.brief?.inspiration.references ?? [];
  if (showReferences) {
    (inspiration?.references ?? []).forEach((r, i) => {
      const detail = described.find((d) => d.index === i)?.describes ?? r.kind;
      add({ id: `ref:${r.url}`, title: r.fileName, detail, href: r.url, kind: r.kind === "image" ? "inspiration" : "file", ...(r.kind === "image" ? { icon: r.url } : {}) });
    });
  }
  for (const id of models) {
    const need = room.brief?.capabilities.find((c) => c.model === id)?.need;
    add({ id: `model:${id}`, title: modelLabel(id), detail: need ? `${id} · ${need}` : id, kind: "model" });
  }
  for (const seg of room.segments) {
    if (seg.type !== "muse") continue;
    for (const line of seg.lines) {
      const source = lineSource(line);
      if (!source) continue;
      if (source === "models") add({ id: "catalog", title: "The model catalog", detail: "What a product may call", kind: "model" });
      else if (source.kind === "docs") {
        const href = docsHref(source.title);
        add({ id: `docs:${source.title}`, title: source.title, detail: "Meta's docs", kind: "docs", ...(href ? { href } : {}) });
      } else if (source.kind === "docs-search") add({ id: `search:${source.title}`, title: `Searched for ${truncate(source.title, 80)}`, detail: "Meta's docs", kind: "docs" });
      else if (source.kind === "skill") add({ id: `skill:${source.title}`, title: source.title, detail: "Skill", kind: "skill" });
      else add({ id: `web:${source.title}`, title: source.title, detail: "Web search", kind: "web" });
    }
  }
  return out;
}

// ---------- The conversation column ----------

export type ConvoItem =
  /** A finished round, folded. Its row opens the steps panel: at the top, or at a fix round. */
  | { type: "thinking"; key: string; step: string | null }
  | { type: "owner"; key: string; group: Extract<LogGroup, { type: "steer" }> }
  /** What a round said when it ended. */
  | { type: "say"; key: string; text: string; /** Muse Code's answer to an owner's note. */ reply?: boolean }
  /** A line the reader shouldn't have to open a panel for: how checks went, or an error. */
  | { type: "step"; key: string; title: string; description?: string; state: StepState }
  | { type: "question"; key: string; question: OpenQuestion; live: boolean };

function checkLine(seg: CheckSegment): ConvoItem | null {
  const failed = seg.verify?.summary.passed === false || seg.judge?.pass === false;
  if (!seg.verify && !seg.judge) return null;
  const tryWord = seg.index === 0 ? "" : `, try ${seg.index + 1}`;
  if (!failed) return { type: "step", key: seg.key, title: seg.judge ? `Checks passed${tryWord}` : `Checks ran${tryWord}`, state: "done" };
  const steps = (seg.verify?.summary.steps ?? []).filter((s) => !s.ok).map((s) => VERIFY_LABEL[s.name] ?? s.name);
  const said = [...steps, ...(seg.judge?.pass === false ? seg.judge.reasons.slice(0, 1) : [])].join(", ");
  return { type: "step", key: seg.key, title: `Checks found problems${tryWord}`, ...(said ? { description: truncate(said, 200) } : {}), state: "failed" };
}

/** What a finished round said last. */
function roundWords(seg: MuseSegment): string | undefined {
  const { groups, summary } = groupLog(seg.lines);
  const says = groups.filter((g): g is Extract<LogGroup, { type: "say" }> => g.type === "say");
  return summary.finalText?.trim() || says[says.length - 1]?.text.trim();
}

/** A shipped build's answer, which reads under what it made: what its last round said. */
export function finalWords(room: RoomState): string | undefined {
  if (room.status !== "live" && room.status !== "partial") return undefined;
  const rounds = room.segments.filter((s): s is MuseSegment => s.type === "muse");
  const last = rounds[rounds.length - 1];
  return last && roundWords(last);
}

/** The conversation between the person's message and the build's outcome: each round folded, with what it said, and whatever needs an answer. */
/** Muse Code's answers to the owner's notes, from the lines of a message that start with NOTE_REPLY_PREFIX. */
export function noteReplies(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    const words = line.trim().replace(/^[*_]+/, "");
    if (!words.startsWith(NOTE_REPLY_PREFIX)) return [];
    const reply = words.slice(NOTE_REPLY_PREFIX.length).replace(/^[*_\s]+/, "").trim();
    return reply ? [reply] : [];
  });
}

export function conversationItems(room: RoomState): ConvoItem[] {
  const liveKey = liveSegmentKey(room);
  const items: ConvoItem[] = [];
  const failure = room.status === "failed" ? room.lastError : null;
  const shipped = room.status === "live" || room.status === "partial";
  const lastRound = [...room.segments].reverse().find((s) => s.type === "muse")?.key;
  for (const seg of room.segments) {
    const live = seg.key === liveKey;
    if (seg.type === "muse") {
      const { groups } = groupLog(seg.lines);
      if (!live) items.push({ type: "thinking", key: `${seg.key}/thinking`, step: seg.round === 0 ? null : seg.key });
      groups.forEach((g, i) => {
        if (g.type === "steer") items.push({ type: "owner", key: `${seg.key}/owner/${i}`, group: g });
        if (g.type === "say") noteReplies(g.text).forEach((text, n) => items.push({ type: "say", key: `${seg.key}/reply/${i}/${n}`, text: `${NOTE_REPLY_PREFIX} ${text}`, reply: true }));
      });
      if (!live && !(shipped && seg.key === lastRound)) {
        const text = roundWords(seg);
        if (text) items.push({ type: "say", key: `${seg.key}/say`, text });
      }
      for (const q of seg.session?.questions ?? []) items.push({ type: "question", key: `${seg.key}/${q.itemId}`, question: q, live });
    } else if (seg.type === "check" && !live) {
      const line = checkLine(seg);
      if (line) items.push(line);
    }
    for (const n of seg.notes) {
      if (n.kind === "error" && n.text !== failure) items.push({ type: "step", key: `error:${n.id}`, title: n.text, state: "failed" });
    }
  }
  // A build that ended with no round still has steps to show.
  if (room.terminal && !items.some((i) => i.type === "thinking") && (room.segments.length || room.preNotes.length)) {
    items.unshift({ type: "thinking", key: "thinking", step: null });
  }
  return items;
}

export interface CurrentStep {
  title: string;
  description?: string;
  /** What's running under it: tools, subagents, a workflow's children. */
  children: Array<{ id: string; title: string }>;
}

const MAX_CURRENT = 4;

/** The running build's step in the conversation: what it's doing, what Muse Code last said, and what's running under it. */
export function currentStep(room: RoomState): CurrentStep | null {
  if (room.terminal) return null;
  const title = WORKING[room.status] ?? "Working";
  const key = liveSegmentKey(room);
  const seg = room.segments.find((s) => s.key === key);
  if (seg?.type === "check") {
    const description = seg.verify?.summary.passed ? "Muse Wonder is judging the screenshots against the brief." : "Running typecheck, build, start, console and smoke checks.";
    return { title, description, children: [] };
  }
  if (seg?.type !== "muse") return { title, children: [] };
  const { groups } = groupLog(seg.lines);
  const spoken = [...groups].reverse().find((g) => g.type === "say" || g.type === "thinking");
  const line = spoken && "text" in spoken ? spoken.text.split("\n").find((s) => s.trim())?.trim() : undefined;
  const running: CurrentStep["children"] = [];
  groups.forEach((g, i) => {
    if (g.type === "activity") {
      g.items.forEach((it, j) => {
        const moving = (it.type === "tool" && it.running) || (it.type === "subagent" && statusState(it.status) === "running");
        if (moving) running.push({ id: `${i}/${j}`, title: it.text });
      });
    } else if (g.type === "workflow" && statusState(g.status) === "running") {
      const child = g.children.filter((c) => statusState(c.status) === "running");
      if (child.length) child.forEach((c, j) => running.push({ id: `${i}/${j}`, title: c.label }));
      else running.push({ id: String(i), title: g.text });
    }
  });
  return { title, ...(line ? { description: truncate(line, 240) } : {}), children: running.slice(-MAX_CURRENT) };
}
