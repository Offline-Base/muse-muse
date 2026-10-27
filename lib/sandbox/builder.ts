import type { Manifest, ModelUsage, MuseLogLine, Reference, Screenshot, VerifySummary } from "@/lib/types";
import type { BuildModel } from "@/lib/sandbox/muse";

/**
 * CONTRACT (owned by the sandbox agent). Signatures are fixed; add optional fields only.
 *
 * Every function is safe to call from a workflow step: it takes plain values, returns small plain values, and finishes
 * well under a minute. Long work (Muse Code, verify, demo recording) starts detached and is polled, so a 20-minute
 * build is many short steps with durable sleeps between them.
 *
 * Product sandboxes are persistent and named `product-<slug>`. The product source lives in PRODUCT_DIR.
 */
export const PRODUCT_DIR = "/vercel/app";

export interface ProvisionInput {
  buildId: string;
  slug: string;
  /** User references, copied into inspo/ under their file names. */
  references: Reference[];
  /** Copied into fixtures/. */
  fixtures: Array<{ fileName: string; url: string }>;
  /** Written to brief.md. */
  promptMarkdown: string;
  /** Build-scoped gateway token and URL, written to .env.local for the product's smoke tests. */
  buildToken: string;
  gatewayUrl: string;
}

/**
 * Creates the product's sandbox from BUILDER_SNAPSHOT_ID (or installs everything when no snapshot is set), puts the
 * template in PRODUCT_DIR, writes inspo/, fixtures/, brief.md and .env.local, then locks egress to the build policy
 * (api.meta.ai with the brokered key, registry.npmjs.org, the platform host).
 */
export async function provisionSandbox(input: ProvisionInput): Promise<{ sandboxName: string }> {
  void input;
  throw new Error("provisionSandbox: not implemented");
}

/** Reopens an existing product sandbox for a refinement: resumes it, rewrites .env.local, and resets egress policy. */
export async function reopenSandbox(input: {
  sandboxName: string;
  buildToken: string;
  gatewayUrl: string;
  newReferences: Reference[];
}): Promise<void> {
  void input;
  throw new Error("reopenSandbox: not implemented");
}

/** Writes a text file inside PRODUCT_DIR, such as fix.md or refine.md. */
export async function writeProductFile(sandboxName: string, path: string, content: string): Promise<void> {
  void sandboxName;
  void path;
  void content;
  throw new Error("writeProductFile: not implemented");
}

export interface StartMuseInput {
  sandboxName: string;
  /** A UUID. The first run sets it; later runs pass the same id to resume the session (docs/SPIKES.md). */
  sessionId: string;
  /** Path inside PRODUCT_DIR, such as brief.md or fix.md. */
  promptFile: string;
  /** Image paths inside PRODUCT_DIR (inspo/...), attached with --image. */
  images: string[];
  model: BuildModel;
  maxModelSteps?: number;
  /** 0 for the first build, then 1, 2, 3 for fix rounds or refinements. Names the log file. */
  round: number;
}

/** Starts `muse exec --json` detached, writing JSONL to a log file. Returns immediately. */
export async function startMuse(input: StartMuseInput): Promise<{ cmdId: string; logPath: string }> {
  void input;
  throw new Error("startMuse: not implemented");
}

export interface MusePoll {
  done: boolean;
  exitCode: number | null;
  /** Byte offset to pass to the next poll. */
  offset: number;
  /** New condensed log lines since the last poll (see the table in docs/SPIKES.md). */
  lines: MuseLogLine[];
  /** From run.usage once the run ends, priced with lib/meta/pricing.ts. Empty until then. */
  usage: ModelUsage[];
  /** The final message from run.terminal.completed. */
  finalText: string | null;
}

/** Reads new JSONL from the log since `offset` and reports whether the command finished. */
export async function pollMuse(input: { sandboxName: string; cmdId: string; logPath: string; offset: number }): Promise<MusePoll> {
  void input;
  throw new Error("pollMuse: not implemented");
}

/** Stops a running command, for timeouts. */
export async function killCommand(sandboxName: string, cmdId: string): Promise<void> {
  void sandboxName;
  void cmdId;
  throw new Error("killCommand: not implemented");
}

/** Starts `next dev` on 0.0.0.0:3000 if it isn't running, waits for a 200, and returns sandbox.domain(3000). */
export async function startPreview(sandboxName: string): Promise<{ url: string }> {
  void sandboxName;
  throw new Error("startPreview: not implemented");
}

export type SandboxTask = "verify" | "demo";

/** Starts `npm run verify` or `npm run demo` detached. */
export async function startTask(sandboxName: string, task: SandboxTask): Promise<{ cmdId: string }> {
  void sandboxName;
  void task;
  throw new Error("startTask: not implemented");
}

export interface TaskPoll {
  done: boolean;
  exitCode: number | null;
  /** The last few KB of combined output. */
  outputTail: string;
}

export async function pollTask(sandboxName: string, cmdId: string): Promise<TaskPoll> {
  void sandboxName;
  void cmdId;
  throw new Error("pollTask: not implemented");
}

/**
 * After verify finishes: parses the JSON summary line verify.mjs prints last, and uploads test-results/judge/*.png
 * to Blob (screens/<buildId>/...). Passing `exitCode` lets it report a failure even if the summary line is missing.
 */
export async function collectVerifyResult(input: {
  sandboxName: string;
  buildId: string;
  round: number;
  exitCode: number | null;
  outputTail: string;
}): Promise<{ summary: VerifySummary; screenshots: Screenshot[] }> {
  void input;
  throw new Error("collectVerifyResult: not implemented");
}

/**
 * After `npm run demo` finishes: turns test-results/**\/video.webm into an MP4 with a title card and step captions
 * (from test-results/report.json) using ffmpeg in the sandbox, uploads it to Blob (demos/<buildId>/demo.mp4), and
 * returns its URL. Null when there is no video.
 */
export async function finishDemo(input: {
  sandboxName: string;
  buildId: string;
  title: string;
  subtitle: string;
}): Promise<{ videoUrl: string | null }> {
  void input;
  throw new Error("finishDemo: not implemented");
}

/** Reads and parses musemuse.json. Null when it's missing or not JSON. */
export async function readManifest(sandboxName: string): Promise<Manifest | null> {
  void sandboxName;
  throw new Error("readManifest: not implemented");
}

/** Reads BUILD_NOTES.md, trimmed. Null when missing. */
export async function readBuildNotes(sandboxName: string): Promise<string | null> {
  void sandboxName;
  throw new Error("readBuildNotes: not implemented");
}

/**
 * Runs `muse export --session <id> --redacted`, uploads it to Blob (transcripts/<buildId>/...), and returns its URL
 * plus a short list of what happened (tool calls and edits) for the "how it was built" section.
 */
export async function exportTranscript(input: {
  sandboxName: string;
  sessionId: string;
  buildId: string;
}): Promise<{ url: string | null; highlights: string[] }> {
  void input;
  throw new Error("exportTranscript: not implemented");
}

/** Stops the sandbox. Persistent sandboxes snapshot on stop, so refinements resume where they left off. */
export async function hibernate(sandboxName: string): Promise<void> {
  void sandboxName;
  throw new Error("hibernate: not implemented");
}
