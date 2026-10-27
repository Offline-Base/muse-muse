import type { Brief, ProductModelId } from "@/lib/brief/schema";

export type { Brief, ProductModelId };

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
  costUsd: number;
}

/** One condensed line of Muse Code activity for the build room, made from a raw JSONL event (docs/SPIKES.md). */
export interface MuseLogLine {
  kind: "start" | "tool" | "edit" | "say" | "status" | "usage" | "done" | "error";
  text: string;
  /** Tool name for kind "tool", such as read_file or apply_patch. */
  tool?: string;
  ok?: boolean;
  /** For kind "edit": files touched and lines added and removed. */
  files?: number;
  added?: number;
  removed?: number;
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
}

export interface JudgeVerdict {
  pass: boolean;
  reasons: string[];
  mismatches: string[];
  /** True when a failure must stop the product shipping even as partial: copying, implying Meta made it, or no result. */
  blocking?: boolean;
}

/** What the build room streams over server-sent events. Stored as build_events.payload. */
export type BuildEventBody =
  | { type: "status"; status: BuildStatus; step?: string; message?: string }
  | { type: "brief"; brief: Brief }
  | { type: "muse"; lines: MuseLogLine[]; round: number }
  | { type: "preview"; url: string }
  | { type: "verify"; round: number; summary: VerifySummary; screenshots: Screenshot[] }
  | { type: "judge"; round: number; verdict: JudgeVerdict }
  | { type: "recording"; url: string }
  | { type: "deploy"; url: string }
  | { type: "cost"; totalUsd: number; addedUsd: number; what: string }
  | { type: "log"; text: string }
  | { type: "error"; message: string };

/** A stored event as the SSE route sends it. `id` is the SSE event id. */
export type BuildEvent = BuildEventBody & { id: number; at: string };

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
  }>;
  fixtures: Array<{ path: string; description: string }>;
  limits: string[];
  estimatedCostPerRunUsd: number;
}

export type GatewayEndpoint = "responses" | "images/generations" | "images/edits" | "files" | "asr/transcribe";

/** How well one of Meta's videos maps onto a rebuild with current Muse models. */
export type RebuildFit = "clean" | "reframe" | "partial";

/** Mirrors an entry in catalog/meta-resources.json. */
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
}
