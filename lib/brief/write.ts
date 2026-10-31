import { referenceParts, textPart, type ContentPart } from "@/lib/brief/media";
import { applyRebuildFit, briefProblems, normalizeRawBrief, patchBrief } from "@/lib/brief/normalize";
import { type Brief, newBriefSchemaFor, type TargetId } from "@/lib/brief/schema";
import { respondStructured, StructuredOutputError } from "@/lib/brief/structured";
import { env } from "@/lib/env";
import { metaPlatform } from "@/lib/meta/platform";
import { usageCost } from "@/lib/meta/pricing";
import { applyTargets, targetProblems } from "@/lib/native/targets";
import { briefInstructions, briefRequestText, rebuildRequestText } from "@/lib/prompts/brief";
import { putFile } from "@/lib/storage";
import type { ModelUsage, Reference, RebuildTarget } from "@/lib/types";

/**
 * CONTRACT (owned by the brief agent). Signatures are fixed; add optional fields only.
 */

export interface BriefInput {
  note: string | null;
  references: Reference[];
  /** Set when the muse is a rebuild of one of Meta's videos. The video is linked, never downloaded. */
  rebuildOf?: RebuildTarget | null;
  /** Where the person picked for it to run (builds.requested_targets). Empty or missing lets the writer choose. */
  requestedTargets?: readonly TargetId[] | null;
}

export interface BriefResult {
  brief: Brief;
  /** Voice memo transcripts, by reference index (0-based, the position in input.references). */
  transcripts: Array<{ index: number; text: string }>;
  usage: ModelUsage[];
  costUsd: number;
}

function total(usage: ModelUsage[]): number {
  return Math.round(usage.reduce((sum, u) => sum + u.costUsd, 0) * 1e6) / 1e6;
}

/**
 * Reads the inspo and note with the brief model, env.briefModel (Muse Wonder by default; prompt 1 in
 * docs/PROMPTS.md), and returns a validated brief. Voice memos (16 kHz mono WAV) are transcribed with Muse Voice
 * Transcribe first. A refusal is a normal result: brief.verdict "no" with brief.refusal set. Throws only when the model
 * can't produce a valid brief after a retry (a StructuredOutputError, whose `usage` says what was spent).
 *
 * brief.inspiration.references[].index is the 0-based position in input.references. A rebuild is text only: its
 * references are ignored and the brief's references list is empty.
 */
export async function writeBrief(input: BriefInput): Promise<BriefResult> {
  const rebuild = input.rebuildOf ?? null;
  const references = rebuild ? [] : input.references;
  const model = env.briefModel;
  const enabled = env.enabledTargets;
  const personalTools = env.composioPersonalEnabled;
  // A pick whose flag went off after it was made counts as never made.
  const requested = enabled.length ? (input.requestedTargets ?? []).filter((t) => t === "web" || enabled.includes(t)) : [];

  let content: ContentPart[];
  let prepared: Awaited<ReturnType<typeof referenceParts>> = { parts: [], sources: new Map(), transcripts: [], usage: [] };
  if (rebuild) {
    content = [textPart(rebuildRequestText(rebuild, input.note, requested))];
  } else {
    prepared = await referenceParts(references);
    content = [...prepared.parts, textPart(briefRequestText(input.note, references, requested))];
  }

  const result = await respondStructured({
    model,
    instructions: briefInstructions(),
    content,
    sources: prepared.sources,
    schema: newBriefSchemaFor({ gadgets: env.gadgetsEnabled, targets: enabled, personalTools }),
    schemaName: "muse_brief",
    effort: "medium",
    normalize: (raw) => normalizeRawBrief(raw, references),
    check: (brief) => [...briefProblems(brief, references), ...targetProblems(brief, { enabled, requested })],
  }).catch((err: unknown) => {
    // Keep the transcription spend on the error too, so the caller can record everything.
    if (err instanceof StructuredOutputError) throw new StructuredOutputError(err.message, [...prepared.usage, ...err.usage]);
    throw err;
  });

  let brief = result.issues.length ? patchBrief(result.data, references) : result.data;
  if (rebuild) brief = applyRebuildFit(brief, rebuild);
  brief = applyTargets(brief, { enabled, requested, personalTools });

  const usage = [...prepared.usage, ...result.usage];
  return { brief, transcripts: prepared.transcripts, usage, costUsd: total(usage) };
}

export interface PreparedFixture {
  /** File name inside the product's fixtures/ folder. */
  fileName: string;
  /** Public URL to copy from. */
  url: string;
  description: string;
  /** True when the file is one of the person's own references, used as a test input. */
  fromUserSample?: boolean;
}

/** Saves a file and returns its public URL. Defaults to Vercel Blob under fixtures/<buildId>/. */
export type FixtureStore = (fileName: string, body: Buffer | string, contentType: string) => Promise<string>;

const MAX_GENERATED_IMAGES = 3;
const IMAGE_MODEL = "muse-image-1.0";

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

/** A safe file name: lowercase words and hyphens, at most 48 characters, with an extension that matches the type. */
export function safeFileName(original: string, contentType: string, fallback: string): string {
  const dot = original.lastIndexOf(".");
  const stem = dot > 0 ? original.slice(0, dot) : original;
  const originalExt = dot > 0 ? original.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  const ext = EXTENSIONS[contentType.split(";")[0].trim().toLowerCase()] ?? (originalExt || "bin");
  const base =
    stem
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || fallback;
  return `${base}.${ext}`;
}

function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  const dot = name.lastIndexOf(".");
  for (let n = 2; taken.has(candidate); n++) candidate = `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
  taken.add(candidate);
  return candidate;
}

function shortDescription(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).replace(/\s+\S*$/, "")}...`;
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

/**
 * Which reference is the user's sample for a fixture: the brief's referenceIndex when it fits, otherwise the unused
 * reference of the same kind whose description shares the most words with the fixture's.
 */
function pickSample(fixture: Brief["fixtures"][number], brief: Brief, references: Reference[], used: Set<number>): number {
  const candidates = references.map((r, i) => i).filter((i) => references[i].kind === fixture.kind && !used.has(i));
  const hinted = fixture.referenceIndex;
  if (typeof hinted === "number" && candidates.includes(hinted)) return hinted;
  if (candidates.length <= 1) return candidates[0] ?? -1;
  const target = words(fixture.description);
  let best = candidates[0];
  let bestScore = -1;
  for (const i of candidates) {
    const describes = brief.inspiration.references.find((r) => r.index === i)?.describes ?? "";
    const own = words(`${describes} ${references[i].fileName}`);
    const score = [...target].filter((w) => own.has(w)).length;
    if (score > bestScore) [best, bestScore] = [i, score];
  }
  return best;
}

async function generateImage(description: string): Promise<Buffer | null> {
  const res = await metaPlatform().images.generate({
    model: IMAGE_MODEL,
    prompt: `${description}\nA realistic sample input for testing an app. No logos, brand names, watermarks or real people.`,
    n: 1,
    size: "1536x1024",
    output_format: "jpeg",
  });
  const b64 = res.data?.[0]?.b64_json;
  return b64 ? Buffer.from(b64, "base64") : null;
}

/**
 * Turns the brief's fixtures into real files: the user's own references when fixture.fromUserSample is true, and
 * Muse Image pictures for image fixtures that aren't. Text fixtures become small .txt files. Fixtures the platform
 * can't make (video or audio without a user sample) are skipped; Muse Code makes its own (AGENTS.md).
 *
 * User samples reuse the reference URL (no re-upload). At most 3 images are generated. A generation that fails or is
 * safety-blocked is skipped, not fatal.
 */
export async function prepareFixtures(input: {
  buildId: string;
  brief: Brief;
  references: Reference[];
  /** Overrides where generated files are saved. Tests use it while Blob isn't set up. */
  store?: FixtureStore;
}): Promise<{ fixtures: PreparedFixture[]; usage: ModelUsage[]; costUsd: number }> {
  const store: FixtureStore =
    input.store ?? ((fileName, body, contentType) => putFile("fixtures", `${input.buildId}/${fileName}`, body, contentType));
  const taken = new Set<string>();
  const used = new Set<number>();
  const usage: ModelUsage[] = [];
  const jobs: Array<Promise<PreparedFixture | null>> = [];
  let generated = 0;

  for (const [n, fixture] of input.brief.fixtures.entries()) {
    const fallback = `sample-${n + 1}`;
    if (fixture.kind === "text") {
      const fileName = uniqueName(safeFileName(fallback, "text/plain", fallback), taken);
      const text = fixture.description.trim();
      if (!text) continue;
      jobs.push(
        store(fileName, `${text}\n`, "text/plain; charset=utf-8").then((url) => ({
          fileName,
          url,
          description: `Sample text: ${shortDescription(text)}`,
        })),
      );
      continue;
    }

    const sampleIndex = fixture.fromUserSample ? pickSample(fixture, input.brief, input.references, used) : -1;
    if (sampleIndex >= 0) {
      used.add(sampleIndex);
      const ref = input.references[sampleIndex];
      const fileName = uniqueName(safeFileName(ref.fileName, ref.contentType, fallback), taken);
      jobs.push(Promise.resolve({ fileName, url: ref.url, description: fixture.description, fromUserSample: true }));
      continue;
    }

    if (fixture.kind !== "image" || generated >= MAX_GENERATED_IMAGES) continue;
    generated++;
    const fileName = uniqueName(safeFileName(`${fallback}-${fixture.description.split(/\s+/).slice(0, 4).join(" ")}`, "image/jpeg", fallback), taken);
    jobs.push(
      generateImage(fixture.description)
        .catch((err: unknown) => {
          // Safety blocks and model errors skip this fixture. Muse Code makes its own (AGENTS.md).
          console.warn(`prepareFixtures: skipped ${fileName}: ${(err as Error).message}`);
          return null;
        })
        .then(async (bytes) => {
          if (!bytes) return null;
          const u = { model: IMAGE_MODEL, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 1 };
          usage.push({ ...u, costUsd: usageCost(u) });
          const url = await store(fileName, bytes, "image/jpeg");
          return { fileName, url, description: fixture.description };
        }),
    );
  }

  const fixtures = (await Promise.all(jobs)).filter((f): f is PreparedFixture => f !== null);
  return { fixtures, usage, costUsd: total(usage) };
}
