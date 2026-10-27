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
  | "deploying"
  | "live"
  | "partial"
  | "failed";

export type ReferenceKind = "image" | "video" | "audio" | "pdf";

/** One file the user gave as an example or inspo. Stored in Vercel Blob. */
export interface Reference {
  url: string;
  kind: ReferenceKind;
  fileName: string;
}

/** A muse: references plus an optional note. A note alone is allowed. */
export interface Inspiration {
  id: string;
  userId: string;
  note: string | null;
  references: Reference[];
  createdAt: string;
}

export interface Build {
  id: string;
  inspirationId: string;
  /** Set when this build rebuilds one of Meta's videos (an id from catalog/meta-resources.json). */
  rebuildOf: string | null;
  productId: string | null;
  status: BuildStatus;
  brief: Brief | null;
  sandboxName: string | null;
  museSessionId: string | null;
  fixRounds: number;
  previewUrl: string | null;
  costUsd: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

/** What the build room streams over server-sent events. */
export type BuildEvent =
  | { type: "status"; status: BuildStatus; at: string }
  | { type: "brief"; brief: Brief; at: string }
  | { type: "muse"; event: unknown; at: string } // one raw JSONL event from `muse exec --json`
  | { type: "preview"; url: string; at: string }
  | { type: "verify"; passed: boolean; summary: string; screenshots: string[]; at: string }
  | { type: "judge"; pass: boolean; reasons: string[]; at: string }
  | { type: "recording"; url: string; at: string } // demo MP4 made from the test run
  | { type: "deploy"; url: string; at: string }
  | { type: "error"; message: string; at: string };

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

export interface Product {
  id: string;
  slug: string;
  name: string;
  manifest: Manifest;
  vercelProjectId: string | null;
  liveUrl: string | null;
  demoVideoUrl: string | null;
  status: "live" | "partial" | "disabled";
  ownerId: string;
  createdAt: string;
}

export type GatewayEndpoint = "responses" | "images/generations" | "images/edits" | "files" | "asr/transcribe";

export interface GatewayToken {
  id: string;
  productId: string;
  scope: "build" | "live";
  allowedModels: ProductModelId[];
  dailyBudgetUsd: number;
  revokedAt: string | null;
}

export interface UsageRecord {
  id: string;
  productId: string;
  tokenId: string;
  endpoint: GatewayEndpoint;
  model: MetaModelId | null;
  units: number;
  unitType: "input_tokens" | "output_tokens" | "cached_input_tokens" | "images" | "video_frames" | "audio_seconds";
  costUsd: number;
  at: string;
}

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
