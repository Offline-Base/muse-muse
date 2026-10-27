import type { Brief } from "@/lib/brief/schema";
import type { ModelUsage, Reference, RebuildTarget } from "@/lib/types";

/**
 * CONTRACT (owned by the brief agent). Signatures are fixed; add optional fields only.
 */

export interface BriefInput {
  note: string | null;
  references: Reference[];
  /** Set when the muse is a rebuild of one of Meta's videos. The video is linked, never downloaded. */
  rebuildOf?: RebuildTarget | null;
}

export interface BriefResult {
  brief: Brief;
  /** Voice memo transcripts, by reference index, so the build room can show them. */
  transcripts: Array<{ index: number; text: string }>;
  usage: ModelUsage[];
  costUsd: number;
}

/**
 * Reads the inspo and note with Muse Spark 1.3 (prompt 1 in docs/PROMPTS.md) and returns a validated brief.
 * Voice memos (16 kHz mono WAV) are transcribed with Muse Voice Transcribe first. A refusal is a normal result:
 * brief.verdict "no" with brief.refusal set. Throws only when the model can't produce a valid brief after a retry.
 */
export async function writeBrief(input: BriefInput): Promise<BriefResult> {
  void input;
  throw new Error("writeBrief: not implemented");
}

export interface PreparedFixture {
  /** File name inside the product's fixtures/ folder. */
  fileName: string;
  /** Public URL to copy from. */
  url: string;
  description: string;
}

/**
 * Turns the brief's fixtures into real files: the user's own references when fixture.fromUserSample is true, and
 * Muse Image pictures for image fixtures that aren't. Text fixtures become small .txt files. Fixtures the platform
 * can't make (video or audio without a user sample) are skipped; Muse Code makes its own (AGENTS.md).
 */
export async function prepareFixtures(input: {
  buildId: string;
  brief: Brief;
  references: Reference[];
}): Promise<{ fixtures: PreparedFixture[]; usage: ModelUsage[]; costUsd: number }> {
  void input;
  throw new Error("prepareFixtures: not implemented");
}
