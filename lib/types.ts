import type { Brief, ProductModelId, TargetId } from "@/lib/brief/schema";
import type { ProductOutput } from "@/lib/native/targets";
import type { MilestoneState } from "@/lib/engine/milestones";
import type { RequirementResult, RequirementTest } from "@/lib/full/requirements";

export type { Brief, ProductModelId, TargetId };

/** Model ids the platform itself or the gateway may send upstream. */
export type MetaModelId =
  | "muse-spark-1.3"
  | "muse-spark-1.3-contributor"
  | "muse-wonder-1.0"
  | "muse-image-1.0"
  | "sam-3.1"
  | "muse-voice-transcribe-1.0";

export type BuildStatus =
  | "queued"
  | "briefing"
  | "refused"
  | "provisioning"
  | "building"
  | "previewing"
  | "verifying"
  | "fixing"
  | "recording"
  | "deploying"
  | "live"
  | "partial"
  | "failed";

/** Statuses after which a build never changes again. */
export const TERMINAL_STATUSES: readonly BuildStatus[] = ["refused", "live", "partial", "failed"];

export type ProductStatus = "building" | "live" | "partial" | "failed" | "disabled";

/**
 * "audio" references are always 16 kHz mono 16-bit WAV: the browser converts voice memos before upload, because
 * Muse Voice Transcribe accepts nothing else (docs/SPIKES.md).
 */
export type ReferenceKind = "image" | "video" | "audio" | "pdf";

/** One file the user gave as an example or inspo. Stored in Vercel Blob with a public URL. */
export interface Reference {
  url: string;
  kind: ReferenceKind;
  fileName: string;
  contentType: string;
  size: number;
}

/** A muse: references plus an optional note. A note alone is allowed. */
export interface Inspiration {
  id: string;
  userId: string;
  note: string | null;
  references: Reference[];
  createdAt: string;
}

/** Token counts for one model from one call or one Muse Code run. */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  images?: number;
  videoFrames?: number;
  audioSeconds?: number;
  units?: number;
  costUsd: number;
}

/**
 * One condensed line of Muse Code activity for the build room, made from a raw `muse exec` JSONL event
 * (docs/SPIKES.md) or a session bridge protocol frame (docs/MUSE_CODE_FULL.md). The kinds after "error" come from the
 * session bridge: reasoning summaries, subagents, workflows, observer (reminder) runs, hook runs, the goal, the todo
 * list, a command the owner sent, a question the agent asked, and context compaction.
 */
export interface MuseLogLine {
  kind:
    | "start"
    | "tool"
    | "edit"
    | "say"
    | "status"
    | "usage"
    | "done"
    | "error"
    | "reasoning"
    | "subagent"
    | "workflow"
    | "reminder"
    | "hook"
    | "goal"
    | "todo"
    | "steer"
    | "question"
    | "compaction";
  text: string;
  /** The protocol item's id, so a later update replaces the line instead of adding one. Session bridge only. */
  itemId?: string;
  /** Structured detail for the session bridge kinds; the build room renders what it knows and ignores the rest. */
  detail?: MuseLineDetail;
  /** Tool name for kind "tool", such as read_file or apply_patch. */
  tool?: string;
  ok?: boolean;
  /** For kind "edit": files touched and lines added and removed. */
  files?: number;
  added?: number;
  removed?: number;
}

/** What a session bridge line carries beyond its text (docs/MUSE_CODE_FULL.md, "Build room"). */
export interface MuseLineDetail {
  /** subagent and workflow children: e.g. "main/scout/1", and the child session to follow. */
  agentPath?: string;
  childSessionId?: string;
  status?: string;
  /** subagent and workflow: a short name to show, such as the subagent's task or the workflow's entry. */
  label?: string;
  /** subagent and workflow: the workflow run the item belongs to, so a workflow's subagents nest under it. */
  workflowRunId?: string;
  /** workflow: its declared phase and its children. */
  phase?: string;
  children?: Array<{ label: string; status: string }>;
  /** reminder: which observer (goal, verify, skill, memory, todo, scope). */
  reminder?: string;
  /** hook: the event and the hook's key. */
  hookEvent?: string;
  hookKey?: string;
  /** goal: the objective, its status and how far along it is. */
  goal?: { objective: string; status: string; percentComplete?: number };
  /** todo: the agent's current list. */
  todos?: Array<{ text: string; status: string }>;
  /**
   * question: the open question for the owner to answer, with its options. An answer names an option by its label;
   * `descriptions` runs beside `options`, and `min` and `max` bound a multiple choice.
   */
  question?: {
    userInputId: string;
    questions: Array<{
      id: string;
      text: string;
      options?: string[];
      multiple?: boolean;
      header?: string;
      descriptions?: string[];
      min?: number;
      max?: number;
    }>;
  };
  /** steer: who sent it and how it was delivered. */
  delivery?: "steer" | "queue" | "interrupt" | "answer" | "goal" | "end" | "workflow" | "subagent";
  /** steer: why the command was refused. */
  error?: string;
  /** tool and web search: what it looked at, for the build room's Sources tab. Plain text from the agent's arguments. */
  source?: { kind: "docs" | "docs-search" | "skill" | "web"; title: string };
}

export interface Screenshot {
  url: string;
  caption: string;
}

export interface VerifySummary {
  passed: boolean;
  /** Each step in scripts/verify.mjs with its result. */
  steps: Array<{ name: string; ok: boolean; ms?: number; detail?: string }>;
  /** The failing part of the output, trimmed for the fix prompt and the build room. */
  failureOutput: string;
  /** What verify's caps step found, per cap (docs/CAPABILITIES.md, 2.8). Only products with musemuse.caps.json have it. */
  caps?: CapProof[];
  /** FULL_BUILDS: what each requirement's own test did. Only products with musemuse.requirements.json have it. */
  requirements?: RequirementTest[];
}

/** One cap's fixed checks, from scripts/caps-check.mjs in the product (docs/CAPABILITIES.md, 2.8). */
export interface CapProof {
  cap: string;
  checks: Array<{ id: string; ok: boolean; detail?: string }>;
}

export interface JudgeVerdict {
  pass: boolean;
  reasons: string[];
  mismatches: string[];
  /** True when a failure must stop the product shipping even as partial: copying, implying Meta made it, or no result. */
  blocking?: boolean;
  /** FULL_BUILDS: every requirement's result, decided by code from its test and what the judge saw. */
  requirements?: RequirementResult[];
}

/** What the build room streams over server-sent events. Stored as build_events.payload. */
export type BuildEventBody =
  | { type: "status"; status: BuildStatus; step?: string; message?: string }
  | { type: "brief"; brief: Brief }
  | { type: "muse"; lines: MuseLogLine[]; round: number }
  | { type: "preview"; url: string }
  | { type: "verify"; round: number; summary: VerifySummary; screenshots: Screenshot[] }
  | { type: "judge"; round: number; verdict: JudgeVerdict }
  | { type: "recording"; url: string; posterUrl?: string | null }
  /** PLAN_ART: the plan card's own picture, the mascot doing something that fits this build (lib/pipeline/plan-art.ts). */
  | { type: "plan_art"; url: string }
  /** BUILD_ROOM_STEPS: Contributor's simple words for steps the feed worked out from this log (lib/steps-feed/facts.ts). */
  | { type: "steps_feed"; lines: Array<{ id: string; text: string }>; recaps: Array<{ after: string; text?: string; comment?: string }> }
  | { type: "deploy"; url: string }
  | { type: "cost"; totalUsd: number; addedUsd: number; what: string }
  | { type: "log"; text: string }
  /**
   * The owner sent a running build a command (docs/MUSE_CODE_FULL.md, "Steering"): a note, a stop, a goal change.
   * `commandIds` are the ids of the mailbox envelopes it wrote, in order. The build room counts a session bridge
   * command line as the owner's only when its id is among them, since the agent can write to the bridge's log.
   */
  | { type: "control"; round: number; action: "steer" | "queue" | "interrupt" | "stop" | "goal" | "answer" | "workflow" | "subagent"; text?: string; ok: boolean; error?: string; commandIds?: string[] }
  | NativeEventBody
  | ProveEventBody
  // Wave 3, unit 2 (docs/CAPABILITIES.md, section 8): a cap's fixed check, a milestone's progress and the live link's check.
  | { type: "caps"; cap: string; check: string; ok: boolean; detail?: string }
  | { type: "milestone"; index: number; of: number; title: string; state: MilestoneState }
  | { type: "live_check"; ok: boolean; url: string; reason?: string }
  /**
   * LOOK_FIRST (docs/LOOK_FIRST.md): where the screens-first stage is. "ready" waits for the owner until `waitUntil`;
   * "changing" applies their note; "wiring" means the look is settled and everything is being wired in.
   */
  | { type: "look"; state: "building" | "ready" | "changing" | "wiring"; round: number; waitUntil?: string; text?: string; why?: "approved" | "waited" | "changes_used" }
  /** LOOK_FIRST: the owner's answer to the screens, from POST /api/builds/{id}/look. */
  | { type: "look_reply"; action: "approve" | "change"; text?: string }
  | { type: "error"; message: string };

/** A stored event as the SSE route sends it. `id` is the SSE event id. */
export type BuildEvent = BuildEventBody & { id: number; at: string };

/** Who started a native run: shipping, the agent mid-build, the owner, or a refinement's re-check. */
export type NativeOrigin = "ship" | "agent" | "owner" | "refine";
export type NativeItemState = "planned" | "queued" | "running" | "done" | "failed" | "skipped";

/**
 * One step of a native run, written to its build's log (docs/NATIVE.md, "The native event"): a package, a lab check or
 * a Device Farm run. `item` is the step's id within the run, and each event says all that is true of it now, except that
 * `media` and `artifact` stay from earlier events until a later one replaces them.
 */
export interface NativeEventBody {
  type: "native";
  runId: string;
  origin: NativeOrigin;
  item: string;
  target: TargetId;
  state: NativeItemState;
  title: string;
  detail?: string;
  media?: Array<{ kind: "image" | "video"; url: string; posterUrl?: string | null; caption: string }>;
  artifact?: { kind: string; url: string; bytes: number };
  /** While queued: the jobs ahead of it and about how long they will take. */
  queue?: { ahead: number; etaSeconds: number };
  costUsd?: number;
}

/** A step of a native run as it stands after every event about it. */
export type NativeItemView = Omit<NativeEventBody, "type" | "runId" | "origin">;

export interface NativeRunView {
  runId: string;
  origin: NativeOrigin;
  /** Oldest first, by when each step was first mentioned. */
  items: NativeItemView[];
  /** True while any step is planned, queued or running. A state this version doesn't know doesn't hold a run open. */
  active: boolean;
  costUsd: number;
}

const NATIVE_UNSETTLED: readonly NativeItemState[] = ["planned", "queued", "running"];

/**
 * Condenses a build's `native` events into its runs, oldest first. The latest event for a step wins, as Muse Code lines
 * do by item id. Events may come from a newer branch, so anything that doesn't name a run and a step is skipped.
 */
export function condenseNativeEvents(events: ReadonlyArray<{ type: string }>): NativeRunView[] {
  const runs = new Map<string, { origin: NativeOrigin; items: Map<string, NativeItemView> }>();
  for (const event of events) {
    if (event.type !== "native") continue;
    const { type: _type, runId, origin, ...item } = event as NativeEventBody;
    if (typeof runId !== "string" || typeof item.item !== "string") continue;
    let run = runs.get(runId);
    if (!run) runs.set(runId, (run = { origin, items: new Map() }));
    const before = run.items.get(item.item);
    run.items.set(item.item, { ...item, media: item.media ?? before?.media, artifact: item.artifact ?? before?.artifact, costUsd: item.costUsd ?? before?.costUsd });
  }
  return [...runs].map(([runId, run]) => {
    const items = [...run.items.values()];
    return {
      runId,
      origin: run.origin,
      items,
      active: items.some((i) => NATIVE_UNSETTLED.includes(i.state)),
      costUsd: items.reduce((sum, i) => sum + (i.costUsd ?? 0), 0),
    };
  });
}

/** What a Prove it run did, step by step, for the product page's list. */
export interface ProveCheck {
  label: string;
  ok: boolean;
}

export type ProveItemState = "planned" | "running" | "done" | "failed" | "skipped";

/**
 * One product output in a Prove it run (docs/PRODUCT_OUTPUTS.md), or "stage" for the run as a whole, written to its
 * build's log after the build is final. Each event says all that is true of it now, except that `media` stays from
 * earlier events until a later one replaces it.
 */
export interface ProveEventBody {
  type: "prove";
  runId: string;
  origin: "ship" | "nightly";
  /** "agent_claims" (VERIFY_AGENTS) is a check of an agent's reply, not an output: it is never in PROVED_OUTPUTS. */
  item: ProductOutput | "stage" | "agent_claims";
  state: ProveItemState;
  title: string;
  detail?: string;
  checks?: ProveCheck[];
  /** What only the product can attest to, so nothing here was re-checked. Only agent_claims has it. */
  reported?: string[];
  media?: { url: string; posterUrl?: string | null; caption: string };
  costUsd?: number;
}

export type ProveItemView = Omit<ProveEventBody, "type" | "runId" | "origin"> & { at: string | null };

/** The newest run, with what earlier runs recorded for any output it has no result or video of. */
export interface ProveView {
  runId: string;
  origin: ProveEventBody["origin"];
  items: ProveItemView[];
  /** True while any part can still change. */
  active: boolean;
  costUsd: number;
  /** When its last event was written, when events carry a time. */
  lastAt: string | null;
}

export const PROVE_UNSETTLED: readonly ProveItemState[] = ["planned", "running"];

/**
 * Condenses a build's `prove` events to what a viewer needs: the newest run, oldest first by when each part was first
 * mentioned. A nightly re-check records no video, so an output keeps the video of the run before it. A run that ended
 * before reaching an output leaves that output as the last finished run had it, with its own date. Null with none.
 */
export function condenseProveEvents(events: ReadonlyArray<{ type: string; at?: string }>): ProveView | null {
  const runs = new Map<string, { origin: ProveEventBody["origin"]; items: Map<string, ProveItemView>; lastAt: string | null }>();
  const media = new Map<string, ProveEventBody["media"]>();
  let newest: string | null = null;
  for (const event of events) {
    if (event.type !== "prove") continue;
    const { type: _type, runId, origin, ...item } = event as ProveEventBody & { at?: string };
    if (typeof runId !== "string" || typeof item.item !== "string") continue;
    let run = runs.get(runId);
    if (!run) runs.set(runId, (run = { origin, items: new Map(), lastAt: null }));
    newest = runId;
    run.lastAt = event.at ?? run.lastAt;
    const before = run.items.get(item.item);
    if (item.media) media.set(item.item, item.media);
    run.items.set(item.item, { ...item, at: event.at ?? null, media: item.media ?? before?.media, checks: item.checks ?? before?.checks, costUsd: item.costUsd ?? before?.costUsd });
  }
  const run = newest ? runs.get(newest) : undefined;
  if (!newest || !run) return null;
  const earlier = [...runs.entries()].filter(([id]) => id !== newest).reverse();
  const carried = new Map<string, ProveItemView>();
  for (const [, older] of earlier) {
    for (const item of older.items.values()) {
      if (item.item !== "stage" && !PROVE_UNSETTLED.includes(item.state) && !run.items.has(item.item) && !carried.has(item.item)) carried.set(item.item, item);
    }
  }
  const items = [...run.items.values(), ...carried.values()].map((i) => ({ ...i, media: i.media ?? media.get(i.item) }));
  // The stage's own line says when a run is over. Older events, or one with no such line, go by their parts.
  const stage = items.find((i) => i.item === "stage");
  return {
    runId: newest,
    origin: run.origin,
    items,
    active: stage ? PROVE_UNSETTLED.includes(stage.state) : items.some((i) => PROVE_UNSETTLED.includes(i.state)),
    costUsd: items.reduce((sum, i) => sum + (i.costUsd ?? 0), 0),
    lastAt: run.lastAt,
  };
}

/** A clip of a product on a real device that its owner uploaded (products.extra_clips). */
export interface ProductClip {
  url: string;
  posterUrl: string | null;
  /** Says honestly what it shows, such as "Filmed on a Meta Quest 3". */
  caption: string;
  addedAt: string;
}

/** Mirrors template/musemuse.schema.json. */
export interface Manifest {
  name: string;
  slug: string;
  tagline: string;
  /** One line on what the user gave and asked for. */
  inspiration: string;
  models: Array<{ id: ProductModelId; usedFor: string }>;
  actions: Array<{
    name: string;
    description: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    example?: Record<string, unknown>;
    /** Default anyone. An owner action stays off the connector, whose callers are anonymous. */
    who?: "anyone" | "owner";
    annotations?: { readOnly?: boolean; openWorld?: boolean };
  }>;
  fixtures: Array<{ path: string; description: string }>;
  limits: string[];
  estimatedCostPerRunUsd: number;
  /** Only when the product is an agent. Its tools can narrow what the brief picked, never widen it. */
  agent?: {
    task: string;
    tools: Array<{ id: string; usedFor: string }>;
    connections: "none" | "owner";
    limits?: { maxTurns?: number; maxToolCalls?: number; maxCostUsd?: number };
  };
}

export type GatewayEndpoint = "responses" | "images/generations" | "images/edits" | "files" | "asr/transcribe";

/** How well one of Meta's videos maps onto a rebuild with current Muse models. */
export type RebuildFit = "clean" | "reframe" | "partial";

/** The Nov 2, 2026 audit's verdict on Muse Muse's version of one of Meta's lessons. */
export type LessonVerdict = "wrong" | "partly wrong" | "not built";

export type LessonKind = "tutorial" | "talk" | "course" | "case study";

/** The improved plan for a lesson on the Learn page. It says planned until it runs. */
export interface LessonPlan {
  title: string;
  plan: string;
  models: string[];
  /** The fine-tune the plan uses, or null when the lesson has none. */
  tune: string | null;
  /** Estimated cost to redo it, in words. Nothing is spent until the owner says so. */
  estimate: string;
  status: "planned";
  unverified?: string[];
}

/** Mirrors an entry in catalog/meta-resources.json. The lesson fields are optional so a synthetic target still fits. */
export interface RebuildTarget {
  id: string;
  title: string;
  url: string;
  era: string;
  demonstrates: string;
  rebuild: {
    fit: RebuildFit;
    models: string[];
    plan: string;
    note: string;
  };
  kind?: LessonKind;
  presenter?: string | null;
  /** Set when the presenter is unconfirmed or spelled oddly on Meta's page. */
  presenterNote?: string;
  /** The date on Meta's page, YYYY-MM-DD. */
  date?: string;
  /** An earlier upload, such as the YouTube date, when Meta's page shows a later one. */
  firstPublished?: string;
  event?: string;
  length?: string;
  links?: { video?: string; code?: string; course?: string };
  pageNote?: string;
  teaches?: string;
  verdict?: LessonVerdict;
  /** The product the audit judged, or null when nothing was built. */
  current?: { product: string; builtOn: string; state: string } | null;
  learn?: LessonPlan;
  /** False keeps the lesson out of the no-ids batch. It is built only when named by id. */
  autoBuild?: boolean;
}
