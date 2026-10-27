import type { Brief, BuildEvent, BuildStatus, JudgeVerdict, MuseLogLine, Screenshot, VerifySummary } from "@/lib/types";
import type { BuildView } from "@/components/view-types";
import { isTerminalStatus } from "@/lib/format";

/**
 * Turns a build's event log into what the build room shows: assistant turns in order (brief, Muse Code rounds,
 * checks, recording, deploy), plus the step rail and the panel's running numbers. Pure, so it runs the same on the
 * server render and in the browser as events stream in.
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
  | (SegmentBase & { type: "muse"; round: number; lines: MuseLogLine[] })
  | (SegmentBase & {
      type: "check";
      round: number;
      /** 0 for the first check, 1 for the check after the first fix, and so on. */
      index: number;
      verify: { summary: VerifySummary; screenshots: Screenshot[] } | null;
      judge: JudgeVerdict | null;
    })
  | (SegmentBase & { type: "record"; url: string })
  | (SegmentBase & { type: "deploy"; url: string });

type CheckSegment = Extract<Segment, { type: "check" }>;

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
        const seg = touch(
          `muse:${e.round}`,
          () => ({
            ...base(`muse:${e.round}`, e.at),
            type: "muse" as const,
            round: e.round,
            lines: [] as MuseLogLine[],
          }),
          e.at,
        );
        seg.lines.push(...e.lines);
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
        const seg = touch("record", () => ({ ...base("record", e.at), type: "record" as const, url: e.url }), e.at);
        seg.url = e.url;
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
    costUsd,
    fixRounds: Math.max(build.fixRounds, build.kind === "refine" ? Math.max(0, fixFromRounds) : fixFromRounds),
    lastRail,
    lastEventId: last?.id ?? 0,
    lastEventAt: last?.at ?? null,
    lastError,
    lastStatusMessage,
  };
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
  | { type: "tool"; text: string; tool?: string; ok?: boolean }
  | { type: "edit"; text: string; files: number; added: number; removed: number }
  | { type: "status"; text: string }
  | { type: "start"; text: string }
  | { type: "done"; text: string }
  | { type: "error"; text: string };

export type LogGroup =
  | { type: "say"; text: string }
  | { type: "activity"; items: Exclude<LogItem, { type: "say" | "done" | "usage" }>[] }
  | { type: "done"; text: string };

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

/** Joins streamed "say" deltas into paragraphs and groups tool and edit lines between them. */
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

  for (const l of lines) {
    switch (l.kind) {
      case "say": {
        const g = lastGroup();
        if (g?.type === "say") g.text += l.text;
        else groups.push({ type: "say", text: l.text });
        break;
      }
      case "usage":
        summary.usageText = l.text;
        break;
      case "done":
        summary.finalText = l.text;
        if (l.text.trim()) groups.push({ type: "done", text: l.text });
        break;
      default: {
        let item: Exclude<LogItem, { type: "say" | "done" }>;
        if (l.kind === "tool") {
          summary.tools++;
          if (l.ok === false) summary.failedTools++;
          item = { type: "tool", text: firstLine(l.text), tool: l.tool, ok: l.ok };
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
        } else {
          item = { type: l.kind, text: firstLine(l.text) };
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
