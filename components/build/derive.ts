import type {
  Brief,
  BuildEvent,
  BuildStatus,
  JudgeVerdict,
  MuseLineDetail,
  MuseLogLine,
  Screenshot,
  VerifySummary,
} from "@/lib/types";
import type { BuildView } from "@/components/view-types";
import { isTerminalStatus } from "@/lib/format";

/**
 * Turns a build's event log into what the build room shows: assistant turns in order (brief, Muse Code rounds,
 * checks, recording, deploy), plus the step rail and the panel's running numbers. Pure, so it runs the same on the
 * server render and in the browser as events stream in.
 *
 * A Muse Code round on the session bridge (docs/MUSE_CODE_FULL.md, "The build room shows all of it") sends lines with
 * item ids: a line whose id is already in the round replaces that line in place, so a tool call shows once and turns
 * from running to done. Each round also gets a model of what the bridge showed beyond its log (SessionModel).
 */

export type RailStep = "brief" | "provision" | "build" | "preview" | "check" | "record" | "deploy";
export type RailState = "pending" | "active" | "done" | "failed" | "skipped";

export const RAIL: ReadonlyArray<{ key: RailStep; label: string }> = [
  { key: "brief", label: "Brief" },
  { key: "provision", label: "Provision" },
  { key: "build", label: "Build" },
  { key: "preview", label: "Preview" },
  { key: "check", label: "Check" },
  { key: "record", label: "Record" },
  { key: "deploy", label: "Deploy" },
];

const STATUS_RAIL: Partial<Record<BuildStatus, RailStep>> = {
  briefing: "brief",
  provisioning: "provision",
  building: "build",
  previewing: "preview",
  verifying: "check",
  fixing: "check",
  recording: "record",
  deploying: "deploy",
};

/** Workflow step names (lib/pipeline/steps.ts) mapped onto the rail. */
const STEP_RAIL: Record<string, RailStep> = {
  brief: "brief",
  provision: "provision",
  build: "build",
  preview: "preview",
  verify: "check",
  fix: "check",
  record: "record",
  deploy: "deploy",
  register: "deploy",
  hibernate: "deploy",
};

export interface Note {
  id: number;
  kind: "log" | "error" | "status";
  text: string;
  at: string;
}

interface SegmentBase {
  key: string;
  startAt: string;
  endAt: string;
  costUsd: number;
  notes: Note[];
}

export type Segment =
  | (SegmentBase & { type: "brief"; brief: Brief })
  | (SegmentBase & {
      type: "muse";
      round: number;
      lines: MuseLogLine[];
      /** What the session bridge showed of this round. Null for a `muse exec` round, which shows none of it. */
      session: SessionModel | null;
    })
  | (SegmentBase & {
      type: "check";
      round: number;
      /** 0 for the first check, 1 for the check after the first fix, and so on. */
      index: number;
      verify: { summary: VerifySummary; screenshots: Screenshot[] } | null;
      judge: JudgeVerdict | null;
    })
  | (SegmentBase & { type: "record"; url: string; posterUrl: string | null })
  | (SegmentBase & { type: "deploy"; url: string });

type CheckSegment = Extract<Segment, { type: "check" }>;
type MuseSegment = Extract<Segment, { type: "muse" }>;
type Delivery = NonNullable<MuseLineDetail["delivery"]>;

/** One agent in a round's tree: a subagent, a workflow, or one of a workflow's children. */
export interface AgentNode {
  id: string;
  kind: "subagent" | "workflow" | "child";
  name: string;
  status: string;
  /** subagent: its path, such as main/scout/1. */
  path?: string;
  /** workflow: the phase it is in. */
  phase?: string;
  children: AgentNode[];
}

export type OpenQuestion = NonNullable<MuseLineDetail["question"]> & { itemId: string };

/** A run of an observer (one of Muse Code's reminder agents) or of a hook. */
export interface WatcherRun {
  id: string;
  /** observer: goal, verify, skill, memory, todo or scope. hook: its event, such as preToolUse. */
  name: string;
  /** hook: the hook's key. */
  key?: string;
  status: string;
  text: string;
  ok?: boolean;
}

/** What the session bridge showed of one Muse Code round, beyond its log (docs/MUSE_CODE_FULL.md, "Build room"). */
export interface SessionModel {
  goal: NonNullable<MuseLineDetail["goal"]> | null;
  todos: NonNullable<MuseLineDetail["todos"]>;
  /** The agents under Muse Code: subagents nested by path, workflows with their children. */
  agents: AgentNode[];
  observers: WatcherRun[];
  hooks: WatcherRun[];
  /** Questions Muse Code asked that haven't settled. */
  questions: OpenQuestion[];
}

export interface RoomState {
  status: BuildStatus;
  terminal: boolean;
  step: string | null;
  brief: Brief | null;
  segments: Segment[];
  /** Notes logged before any turn started. */
  preNotes: Note[];
  previewUrl: string | null;
  liveUrl: string | null;
  recordingUrl: string | null;
  /** The recording's poster, when it came with one. */
  recordingPosterUrl: string | null;
  costUsd: number;
  fixRounds: number;
  /** The last rail step that was running, so a failure can be pinned to it. */
  lastRail: RailStep | null;
  lastEventId: number;
  lastEventAt: string | null;
  lastError: string | null;
  lastStatusMessage: string | null;
}

export function deriveRoom(build: BuildView, events: BuildEvent[]): RoomState {
  let status: BuildStatus = build.status;
  let step = build.step;
  let brief: Brief | null = build.brief;
  let previewUrl = build.previewUrl;
  let liveUrl: string | null = null;
  let recordingUrl: string | null = null;
  let recordingPosterUrl: string | null = null;
  let costUsd = build.costUsd;
  let lastRail: RailStep | null = STATUS_RAIL[build.status] ?? (build.step ? (STEP_RAIL[build.step] ?? null) : null);
  let lastError: string | null = build.error;
  let lastStatusMessage: string | null = null;
  let lastStatusAt: string = build.startedAt;

  const segments: Segment[] = [];
  const byKey = new Map<string, Segment>();
  const preNotes: Note[] = [];
  // Held in an object so the closures below can update it without TypeScript narrowing it to null.
  const cur: { seg: Segment | null } = { seg: null };
  let checkCount = 0;

  // A turn starts at the later of the last status change and the previous turn's end. ISO strings sort by time.
  const startFor = (at: string): string => {
    const prevEnd = segments[segments.length - 1]?.endAt;
    const candidates = [lastStatusAt, prevEnd].filter((t): t is string => typeof t === "string" && t <= at);
    return candidates.sort().pop() ?? at;
  };

  const touch = <S extends Segment>(key: string, create: () => S, at: string): S => {
    let seg = byKey.get(key) as S | undefined;
    if (!seg) {
      seg = create();
      byKey.set(key, seg);
      segments.push(seg);
    }
    seg.endAt = at > seg.endAt ? at : seg.endAt;
    cur.seg = seg;
    return seg;
  };

  const base = (key: string, at: string): SegmentBase => ({
    key,
    startAt: startFor(at),
    endAt: at,
    costUsd: 0,
    notes: [],
  });

  const note = (n: Note) => {
    const seg = cur.seg;
    if (seg) {
      seg.notes.push(n);
      if (n.at > seg.endAt) seg.endAt = n.at;
    } else preNotes.push(n);
  };

  const newMuse = (round: number, at: string): MuseSegment => ({
    ...base(`muse:${round}`, at),
    type: "muse" as const,
    round,
    lines: [] as MuseLogLine[],
    session: null,
  });
  /** Per muse round: itemId -> where its line is, so an update replaces it. */
  const slots = new Map<string, Map<string, number>>();
  /** Per muse round: owner commands the room sent that the session bridge hasn't confirmed yet. */
  const pending = new Map<string, Array<{ itemId: string; confirms: Delivery[]; text: string }>>();
  const addLine = (seg: MuseSegment, line: MuseLogLine) => {
    let slot = slots.get(seg.key);
    if (!slot) slots.set(seg.key, (slot = new Map()));
    const waiting = pending.get(seg.key);
    if (waiting?.length && line.kind === "steer" && line.itemId && !slot.has(line.itemId) && line.detail?.status !== "sent") {
      // The bridge's line for a command takes the place of the note the room showed when it was sent.
      const i = waiting.findIndex((p) => confirms(p, line));
      if (i >= 0) {
        const [p] = waiting.splice(i, 1);
        slot.set(line.itemId, slot.get(p!.itemId)!);
        slot.delete(p!.itemId);
      }
    }
    upsertLine(seg.lines, slot, line);
  };

  for (const e of events) {
    switch (e.type) {
      case "status": {
        status = e.status;
        if (e.step) step = e.step;
        const rail = STATUS_RAIL[e.status] ?? (e.step ? STEP_RAIL[e.step] : undefined);
        if (rail && !isTerminalStatus(e.status)) lastRail = rail;
        lastStatusAt = e.at;
        if (e.message) {
          lastStatusMessage = e.message;
          note({ id: e.id, kind: "status", text: e.message, at: e.at });
        }
        break;
      }
      case "brief": {
        brief = e.brief;
        const seg = touch("brief", () => ({ ...base("brief", e.at), type: "brief" as const, brief: e.brief }), e.at);
        seg.brief = e.brief;
        break;
      }
      case "muse": {
        const seg = touch(`muse:${e.round}`, () => newMuse(e.round, e.at), e.at);
        for (const l of e.lines) addLine(seg, l);
        break;
      }
      case "control": {
        // The owner's command shows in its round at once, without moving the current turn or its times.
        let seg = byKey.get(`muse:${e.round}`) as MuseSegment | undefined;
        if (!seg) {
          seg = newMuse(e.round, e.at);
          byKey.set(seg.key, seg);
          segments.push(seg);
        }
        const line = controlLine(e);
        addLine(seg, line);
        if (e.ok) {
          const list = pending.get(seg.key) ?? [];
          list.push({ itemId: line.itemId!, confirms: CONTROL_CONFIRMS[e.action] ?? [], text: (e.text ?? "").trim() });
          pending.set(seg.key, list);
        }
        break;
      }
      case "verify":
      case "judge": {
        const seg = touch(
          `check:${e.round}`,
          () => ({
            ...base(`check:${e.round}`, e.at),
            type: "check" as const,
            round: e.round,
            index: checkCount++,
            verify: null as CheckSegment["verify"],
            judge: null as CheckSegment["judge"],
          }),
          e.at,
        );
        if (e.type === "verify") seg.verify = { summary: e.summary, screenshots: e.screenshots ?? [] };
        else seg.judge = e.verdict;
        break;
      }
      case "recording": {
        recordingUrl = e.url;
        recordingPosterUrl = e.posterUrl ?? null;
        const seg = touch(
          "record",
          () => ({ ...base("record", e.at), type: "record" as const, url: e.url, posterUrl: recordingPosterUrl }),
          e.at,
        );
        seg.url = e.url;
        seg.posterUrl = recordingPosterUrl;
        break;
      }
      case "deploy": {
        liveUrl = e.url;
        const seg = touch("deploy", () => ({ ...base("deploy", e.at), type: "deploy" as const, url: e.url }), e.at);
        seg.url = e.url;
        break;
      }
      case "preview":
        previewUrl = e.url;
        break;
      case "cost":
        costUsd = e.totalUsd;
        if (cur.seg) cur.seg.costUsd += e.addedUsd;
        break;
      case "log":
        note({ id: e.id, kind: "log", text: e.text, at: e.at });
        break;
      case "error":
        lastError = e.message;
        note({ id: e.id, kind: "error", text: e.message, at: e.at });
        break;
    }
  }

  for (const seg of segments) if (seg.type === "muse") seg.session = sessionOf(seg.lines);

  // The build row is the source of truth once it is terminal, even if the stream missed the last status event.
  if (isTerminalStatus(build.status) && !isTerminalStatus(status)) status = build.status;

  const fixFromRounds = segments.filter((s) => s.type === "muse" && s.round > 0).length;
  const last = events[events.length - 1];
  return {
    status,
    terminal: isTerminalStatus(status),
    step,
    brief,
    segments,
    preNotes,
    previewUrl,
    liveUrl,
    recordingUrl,
    recordingPosterUrl,
    costUsd,
    fixRounds: Math.max(build.fixRounds, build.kind === "refine" ? Math.max(0, fixFromRounds) : fixFromRounds),
    lastRail,
    lastEventId: last?.id ?? 0,
    lastEventAt: last?.at ?? null,
    lastError,
    lastStatusMessage,
  };
}

/** The item a sub-line belongs just before, as lib/sandbox/msp-log.ts's subLineOf says: `<item id>#patch`. */
function subLineOf(itemId: string): string | null {
  const at = itemId.lastIndexOf("#");
  return at > 0 ? itemId.slice(0, at) : null;
}

/**
 * Adds a line to a round. A line with an id already there replaces that line in place, and a new sub-line (a tool
 * call's edit line) goes just before its item's line. `slot` maps ids to where their lines are.
 */
export function upsertLine(lines: MuseLogLine[], slot: Map<string, number>, line: MuseLogLine): void {
  const id = line.itemId;
  if (id === undefined) {
    lines.push(line);
    return;
  }
  const at = slot.get(id);
  if (at !== undefined) {
    lines[at] = line;
    return;
  }
  const parent = subLineOf(id);
  const under = parent === null ? undefined : slot.get(parent);
  if (under === undefined) {
    slot.set(id, lines.length);
    lines.push(line);
    return;
  }
  lines.splice(under, 0, line);
  for (const [key, i] of slot) if (i >= under) slot.set(key, i + 1);
  slot.set(id, under);
}

/** The deliveries a session bridge line may have for each control action, so it can confirm the room's note. */
const CONTROL_CONFIRMS: Record<string, Delivery[]> = {
  steer: ["steer"],
  queue: ["queue"],
  interrupt: ["interrupt"],
  stop: ["end", "interrupt"],
  goal: ["goal"],
  answer: ["answer"],
};

const CONTROL_DELIVERY: Record<string, Delivery> = {
  steer: "steer",
  queue: "queue",
  interrupt: "interrupt",
  stop: "end",
  goal: "goal",
  answer: "answer",
};

/** The owner's command as the room shows it the moment it is sent, in the owner's words. */
function controlLine(e: Extract<BuildEvent, { type: "control" }>): MuseLogLine {
  const text = (e.text ?? "").trim();
  const words: Record<string, string> = {
    steer: text || "A note for Muse Code.",
    queue: text || "A note for after this turn.",
    interrupt: "Stop the current turn.",
    stop: "Stop the run.",
    goal: text ? `Goal: ${text}` : "Change the goal.",
    answer: text || "An answer.",
  };
  const delivery = CONTROL_DELIVERY[e.action];
  return {
    kind: "steer",
    itemId: `control:${e.id}`,
    text: words[e.action] ?? (text || "A command."),
    ok: e.ok,
    detail: { ...(delivery ? { delivery } : {}), status: e.ok ? "sent" : "refused", ...(e.error ? { error: e.error } : {}) },
  };
}

/** Whether a session bridge command line is the one a waiting control note stands for: notes match by their text. */
function confirms(p: { confirms: Delivery[]; text: string }, line: MuseLogLine): boolean {
  const delivery = line.detail?.delivery;
  if (!delivery || !p.confirms.includes(delivery)) return false;
  return delivery === "steer" || delivery === "queue" ? line.text.trim() === p.text : true;
}

const BRIDGE_KINDS = new Set<MuseLogLine["kind"]>([
  "reasoning",
  "subagent",
  "workflow",
  "reminder",
  "hook",
  "goal",
  "todo",
  "steer",
  "question",
  "compaction",
]);

/** The last segment of an agent path that isn't a number: "scout" in main/scout/1. */
function agentName(path: string): string {
  return path.split("/").filter((s) => s && s !== "main" && !/^\d+$/.test(s)).pop() ?? "";
}

/** The agent that spawned a path: main/scout/1/helper/1 -> main/scout/1. */
function parentPath(path: string): string {
  const parts = path.split("/");
  if (/^\d+$/.test(parts[parts.length - 1] ?? "")) parts.pop();
  parts.pop();
  return parts.join("/");
}

function agentTree(lines: MuseLogLine[]): AgentNode[] {
  const roots: AgentNode[] = [];
  const byPath = new Map<string, AgentNode>();
  const runs = new Map<string, { node: AgentNode; listed: boolean }>();
  for (const l of lines) {
    if (l.kind !== "workflow" && l.kind !== "subagent") continue;
    const d = l.detail ?? {};
    const id = l.itemId ?? `${l.kind}-${roots.length}`;
    if (l.kind === "workflow") {
      const children: AgentNode[] = (d.children ?? []).map((c, i) => ({ id: `${id}/${i}`, kind: "child", name: c.label, status: c.status, children: [] }));
      const node: AgentNode = { id, kind: "workflow", name: d.label || "Workflow", status: d.status ?? "", ...(d.phase ? { phase: d.phase } : {}), children };
      if (d.workflowRunId) runs.set(d.workflowRunId, { node, listed: children.length > 0 });
      roots.push(node);
      continue;
    }
    const run = d.workflowRunId ? runs.get(d.workflowRunId) : undefined;
    // A workflow's own list of children already shows the agents it runs.
    if (run?.listed) continue;
    const path = d.agentPath ?? "";
    const node: AgentNode = { id, kind: "subagent", name: d.label || agentName(path) || "Subagent", status: d.status ?? "", ...(path ? { path } : {}), children: [] };
    const parent = run?.node ?? (path ? byPath.get(parentPath(path)) : undefined);
    (parent ? parent.children : roots).push(node);
    if (path) byPath.set(path, node);
  }
  return roots;
}

/**
 * The round's goal, todo list, agent tree, observer and hook runs and open questions, from its lines once updates
 * have replaced what they update. Null when no line came from the session bridge, so a `muse exec` round renders as it
 * always has.
 */
export function sessionOf(lines: MuseLogLine[]): SessionModel | null {
  if (!lines.some((l) => l.itemId !== undefined || BRIDGE_KINDS.has(l.kind))) return null;
  const model: SessionModel = { goal: null, todos: [], agents: agentTree(lines), observers: [], hooks: [], questions: [] };
  for (const l of lines) {
    const d = l.detail ?? {};
    const run = (name: string): WatcherRun => ({
      id: l.itemId ?? `${l.kind}-${model.observers.length + model.hooks.length}`,
      name,
      status: d.status ?? "",
      text: l.text,
      ...(l.ok === undefined ? {} : { ok: l.ok }),
    });
    switch (l.kind) {
      case "goal":
        model.goal = d.goal && d.goal.status !== "cleared" ? d.goal : null;
        break;
      case "todo":
        model.todos = d.todos ?? [];
        break;
      case "reminder":
        model.observers.push(run(d.reminder ?? ""));
        break;
      case "hook":
        model.hooks.push({ ...run(d.hookEvent ?? ""), ...(d.hookKey ? { key: d.hookKey } : {}) });
        break;
      case "question":
        if (d.question?.questions.length) model.questions.push({ ...d.question, itemId: l.itemId ?? d.question.userInputId });
        break;
    }
  }
  return model;
}

export function railStates(room: RoomState, kind: BuildView["kind"]): Record<RailStep, RailState> {
  const out = Object.fromEntries(RAIL.map((r) => [r.key, "pending"])) as Record<RailStep, RailState>;
  const order = RAIL.map((r) => r.key);
  const mark = (upTo: number, state: RailState, from = 0) => {
    for (let i = from; i < upTo; i++) out[order[i]] = state;
  };

  switch (room.status) {
    case "live":
    case "partial":
      mark(order.length, "done");
      if (!room.recordingUrl) out.record = "skipped";
      if (kind === "refine" && !room.brief) out.brief = "skipped";
      return out;
    case "refused":
      out.brief = "failed";
      mark(order.length, "skipped", 1);
      return out;
    case "failed": {
      const at = room.lastRail ? order.indexOf(room.lastRail) : 0;
      mark(at, "done");
      out[order[at]] = "failed";
      mark(order.length, "skipped", at + 1);
      return out;
    }
    case "queued":
      return out;
    default: {
      const rail = STATUS_RAIL[room.status] ?? room.lastRail ?? "brief";
      const at = order.indexOf(rail);
      mark(at, "done");
      out[rail] = "active";
      if (kind === "refine" && !room.brief && at > 0) out.brief = "skipped";
      return out;
    }
  }
}

export type RefineSpot =
  | { show: true }
  | { show: false; elsewhere: { buildId: string; running: boolean } | null };

/**
 * Whether this build room offers the refine composer. Eligibility comes from the product, not this build: it shows
 * while the product is live or partial and none of its other builds is running, on the product's current build or on
 * its newest one (say, a refinement that failed and left the live version in place). Elsewhere it points at the
 * running build or the current one.
 */
export function refineSpot(input: {
  buildId: string;
  terminal: boolean;
  canRefine: boolean;
  product: { status: string; latestBuildId: string | null } | null;
  history: ReadonlyArray<{ id: string; status: string }>;
}): RefineSpot {
  const { product, history } = input;
  const shipped = product?.status === "live" || product?.status === "partial";
  if (!product || !shipped || !input.canRefine || !input.terminal) return { show: false, elsewhere: null };
  const running = history.find((h) => h.id !== input.buildId && !isTerminalStatus(h.status));
  if (running) return { show: false, elsewhere: { buildId: running.id, running: true } };
  if (!history.length || product.latestBuildId === input.buildId || history[0].id === input.buildId) {
    return { show: true };
  }
  const current = product.latestBuildId ?? history[0].id;
  return { show: false, elsewhere: { buildId: current, running: false } };
}

/** Condensed view of one Muse Code round for display. */
export type LogItem =
  | { type: "say"; text: string }
  | { type: "tool"; text: string; tool?: string; ok?: boolean; running?: boolean }
  | { type: "edit"; text: string; files: number; added: number; removed: number }
  | { type: "status"; text: string }
  | { type: "start"; text: string }
  | { type: "done"; text: string }
  | { type: "error"; text: string }
  | { type: "subagent"; text: string; status: string; ok?: boolean }
  | { type: "hook"; text: string; ok?: boolean }
  | { type: "compaction"; text: string };

export type LogGroup =
  | { type: "say"; text: string }
  | { type: "activity"; items: Exclude<LogItem, { type: "say" | "done" | "usage" }>[] }
  | { type: "done"; text: string }
  /** Reasoning summaries in a row. */
  | { type: "thinking"; text: string }
  /** A command from the owner: a note, a stop, a goal change, an answer. */
  | { type: "steer"; text: string; delivery?: Delivery; status: string; error?: string }
  | { type: "workflow"; text: string; status: string; phase?: string; children: Array<{ label: string; status: string }> };

export interface RoundSummary {
  tools: number;
  edits: number;
  files: number;
  added: number;
  removed: number;
  failedTools: number;
  usageText: string | null;
  finalText: string | null;
}

/**
 * Joins streamed "say" deltas into paragraphs and groups tool and edit lines between them. A session bridge message
 * is whole, so it is a paragraph of its own. The goal, todo list, observers and open questions show beside the log
 * (SessionModel), not in it.
 */
export function groupLog(lines: MuseLogLine[]): { groups: LogGroup[]; summary: RoundSummary } {
  const groups: LogGroup[] = [];
  const summary: RoundSummary = {
    tools: 0,
    edits: 0,
    files: 0,
    added: 0,
    removed: 0,
    failedTools: 0,
    usageText: null,
    finalText: null,
  };
  const lastGroup = () => groups[groups.length - 1];
  let wholeSay = false;

  for (const l of lines) {
    switch (l.kind) {
      case "say": {
        const g = lastGroup();
        if (g?.type === "say" && !l.itemId && !wholeSay) g.text += l.text;
        else groups.push({ type: "say", text: l.text });
        wholeSay = Boolean(l.itemId);
        break;
      }
      case "usage":
        summary.usageText = l.text;
        break;
      case "done":
        summary.finalText = l.text;
        if (l.text.trim()) groups.push({ type: "done", text: l.text });
        break;
      case "reasoning": {
        const g = lastGroup();
        if (g?.type === "thinking") g.text += `\n\n${l.text}`;
        else groups.push({ type: "thinking", text: l.text });
        break;
      }
      case "steer":
        groups.push({
          type: "steer",
          text: l.text,
          status: l.detail?.status ?? "",
          ...(l.detail?.delivery ? { delivery: l.detail.delivery } : {}),
          ...(l.detail?.error ? { error: l.detail.error } : {}),
        });
        break;
      case "workflow":
        groups.push({
          type: "workflow",
          text: firstLine(l.text),
          status: l.detail?.status ?? "",
          ...(l.detail?.phase ? { phase: l.detail.phase } : {}),
          children: l.detail?.children ?? [],
        });
        break;
      case "goal":
      case "todo":
      case "reminder":
      case "question":
        break;
      default: {
        let item: Exclude<LogItem, { type: "say" | "done" }>;
        if (l.kind === "tool") {
          summary.tools++;
          if (l.ok === false) summary.failedTools++;
          item = { type: "tool", text: firstLine(l.text), tool: l.tool, ok: l.ok };
          if (l.detail?.status === "inProgress") item.running = true;
        } else if (l.kind === "subagent") {
          item = { type: "subagent", text: firstLine(l.text), status: l.detail?.status ?? "", ...(l.ok === undefined ? {} : { ok: l.ok }) };
        } else if (l.kind === "hook") {
          item = { type: "hook", text: firstLine(l.text), ...(l.ok === undefined ? {} : { ok: l.ok }) };
        } else if (l.kind === "compaction") {
          item = { type: "compaction", text: firstLine(l.text) };
        } else if (l.kind === "edit") {
          summary.edits++;
          summary.files += l.files ?? 0;
          summary.added += l.added ?? 0;
          summary.removed += l.removed ?? 0;
          item = {
            type: "edit",
            text: firstLine(l.text),
            files: l.files ?? 0,
            added: l.added ?? 0,
            removed: l.removed ?? 0,
          };
        } else if (l.kind === "start" || l.kind === "status" || l.kind === "error") {
          item = { type: l.kind, text: firstLine(l.text) };
        } else {
          item = { type: "status", text: firstLine(l.text) };
        }
        const g = lastGroup();
        if (g?.type === "activity") g.items.push(item);
        else groups.push({ type: "activity", items: [item] });
      }
    }
  }
  // Drop empty prose made of whitespace-only deltas.
  return { groups: groups.filter((g) => g.type !== "say" || g.text.trim().length > 0), summary };
}

function firstLine(text: string): string {
  const line = (text ?? "").split("\n").find((s) => s.trim()) ?? "";
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}
