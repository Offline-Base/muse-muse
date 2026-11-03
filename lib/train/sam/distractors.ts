import { imageType, type EditReply } from "@/lib/pipeline/plan-art";
import { usageCost } from "@/lib/meta/pricing";
import type { ModelUsage } from "@/lib/types";
import { holdSpend, type SpendDeps, type SpendLimits, type SpendRefusal } from "@/lib/train/sam/spend";
import { splitFor } from "@/lib/train/sam/photo";
import { SAM_TUNE_LIMITS, type SamDistractor, type SamPhoto } from "@/lib/train/sam/types";

/**
 * Look-alikes for the person's own object (U6): Muse Image pictures of a different thing of the same kind ("a plush
 * toy that is not this one"), so the tune learns to say the person's word for their object and stay quiet for others
 * like it. They go in the run as negatives (SamDistractor, source "muse-image"); the person can drop any of them on the
 * look-alike grid, and can add their own photos of other ones (source "own", through /photos).
 *
 * The pattern is lib/pipeline/plan-art.ts: one Muse Image call per picture, with one of the person's training photos as
 * the reference when there is one, so the look-alike comes out about the same size, kind and colors, and a plain
 * images/generations call when there isn't. Before each call the cost is held against every cap
 * (lib/train/sam/spend.ts: the platform's daily cap, SAM_TUNE_DAILY_USD and the run's own cap), and a refusal stops the
 * batch before the call. After it the hold is settled to what the call cost: a picture that came back costs $0.01, a
 * call still out when its time box ran out is kept as spent (Meta may bill it), and a refusal or a failed call costs
 * nothing, as plan art counts it.
 *
 * Every look-alike is a made-up picture, which the report's caveats always say.
 */

export const LOOKALIKE_MODEL = "muse-image-1.0";
/** One Muse Image picture (lib/meta/pricing.ts): $0.01. */
export const LOOKALIKE_USD = usageCost({ model: LOOKALIKE_MODEL, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 1 });
/** Pictures in one request: 4 at 60 s each stays inside the route's 300 s. */
export const LOOKALIKE_BATCH = 4;
/** One picture's time box. */
export const LOOKALIKE_TIMEOUT_MS = 60_000;
/** Square: the board pastes and crops either way, and a square keeps every look-alike the same shape. */
export const LOOKALIKE_SIZE = "1024x1024";

/** Where each look-alike is put, in turn, so the set isn't one table photographed twenty times. */
export const LOOKALIKE_SCENES = [
  "on a wooden kitchen table",
  "on a gray couch cushion",
  "on an unmade bed",
  "on a bookshelf",
  "on a carpeted floor",
  "on a desk next to a lamp",
  "on a windowsill in daylight",
  "on a playroom rug",
] as const;

export interface LookalikeRun {
  id: string;
  generic: string;
  photos: readonly SamPhoto[];
  distractors: readonly SamDistractor[];
}

/** The request: images/edits with a reference photo, or images/generations with none. */
export type LookalikeRequest =
  | { path: "/images/edits"; body: Record<string, unknown> }
  | { path: "/images/generations"; body: Record<string, unknown> };

export interface DistractorDeps extends SpendDeps {
  /** Sends one images request. Must stop when `signal` aborts. */
  draw(request: LookalikeRequest, signal: AbortSignal): Promise<EditReply>;
  /** Saves the picture and returns its public URL. */
  store(bytes: Buffer, type: { contentType: string; ext: string }): Promise<string>;
  /** Adds the look-alike to the run; false when the run is full or no longer a draft. */
  save(distractor: SamDistractor): Promise<boolean>;
  /** Records the call's usage and adds it to the run's cost. */
  charge(usage: ModelUsage): Promise<void>;
  log(message: string): void;
  timeoutMs?: number;
}

export type LookalikeSkip = "refused" | "timeout" | "empty" | "error" | "full";

export interface LookalikeOutcome {
  made: SamDistractor[];
  /** Set when a cap stopped the batch before its next call. */
  refused: SpendRefusal | null;
  /** Calls that gave no picture, by why. */
  skipped: LookalikeSkip[];
  /** What this batch cost. */
  costUsd: number;
}

/** How many look-alikes the run can still take, at most `asked` and at most LOOKALIKE_BATCH. */
export function lookalikesToMake(run: Pick<LookalikeRun, "distractors">, asked: number): number {
  const room = SAM_TUNE_LIMITS.distractorsMax - run.distractors.length;
  const n = Number.isFinite(asked) ? Math.floor(asked) : 0;
  return Math.max(0, Math.min(n, LOOKALIKE_BATCH, room));
}

/**
 * The prompt. The generic word is held to SAM_TUNE_LIMITS.genericRe (lowercase letters and spaces) before a run is
 * made, so it can't carry instructions, and it is quoted anyway.
 */
export function lookalikePrompt(generic: string, scene: string, withReference: boolean): string {
  const kind = JSON.stringify(generic);
  const lines = withReference
    ? [
        `Make a new, realistic phone photo of a different ${kind}: one that could be mistaken for the one in the reference picture at a glance.`,
        "Keep it about the same size, kind, material and colors, but make it clearly a different one, with a different face, shape, markings or details.",
        "Do not show the object from the reference picture itself.",
      ]
    : [`Make a realistic phone photo of one ${kind}.`];
  return [
    ...lines,
    `Show it alone, whole and in focus, ${scene}, in natural indoor light.`,
    "No text, letters, numbers, labels, logos, brand marks or people anywhere in the picture.",
  ].join("\n");
}

/** The images request for the `index`th look-alike of a run. */
export function lookalikeRequest(generic: string, index: number, referenceUrl: string | null): LookalikeRequest {
  const scene = LOOKALIKE_SCENES[index % LOOKALIKE_SCENES.length];
  const common = {
    model: LOOKALIKE_MODEL,
    prompt: lookalikePrompt(generic, scene, referenceUrl !== null),
    n: 1,
    size: LOOKALIKE_SIZE,
    output_format: "jpeg",
    tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
  };
  return referenceUrl
    ? { path: "/images/edits", body: { ...common, images: [{ image_url: referenceUrl }] } }
    : { path: "/images/generations", body: common };
}

/** The reference for the `index`th look-alike: the run's training photos with a box, in turn, or null when it has none. */
export function referenceFor(photos: readonly SamPhoto[], index: number): string | null {
  const train = photos.filter((p) => p.split === "train" && p.box && !p.skipped);
  return train.length ? train[index % train.length].url : null;
}

export function lookalikeUsage(): ModelUsage {
  return { model: LOOKALIKE_MODEL, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 1, costUsd: LOOKALIKE_USD };
}

function isRefusal(err: unknown): boolean {
  const e = err as { code?: unknown; error?: { code?: unknown } } | null;
  return e?.code === "content_policy_violation" || e?.error?.code === "content_policy_violation";
}

function isTimeout(err: unknown, signal: AbortSignal): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return signal.aborted || (typeof name === "string" && /timeout/i.test(name));
}

/**
 * Makes up to `asked` look-alikes (lookalikesToMake), one call at a time, each held against the caps first. Never
 * throws for one picture: a failed call is counted in `skipped` and the batch moves on. Stops at the first cap refusal,
 * and when the run can't take another (it filled up, or it was started meanwhile).
 */
export async function makeLookalikes(run: LookalikeRun, limits: SpendLimits, deps: DistractorDeps, asked: number): Promise<LookalikeOutcome> {
  const n = lookalikesToMake(run, asked);
  const made: SamDistractor[] = [];
  const skipped: LookalikeSkip[] = [];
  let refused: SpendRefusal | null = null;
  let costUsd = 0;

  for (let i = 0; i < n; i++) {
    const index = run.distractors.length + made.length;
    const held = await holdSpend(deps, limits, LOOKALIKE_USD);
    if (!held.ok) {
      refused = held.reason;
      break;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? LOOKALIKE_TIMEOUT_MS);
    let spent = 0;
    let bytes: Buffer | null = null;
    let skip: LookalikeSkip | null = null;
    try {
      const reply = await deps.draw(lookalikeRequest(run.generic, index, referenceFor(run.photos, index)), abort.signal);
      const b64 = reply?.data?.[0]?.b64_json;
      if (b64) {
        spent = LOOKALIKE_USD;
        bytes = Buffer.from(b64, "base64");
      } else {
        skip = "empty";
      }
    } catch (err) {
      if (isTimeout(err, abort.signal)) {
        // Still out when the time box ran out: Meta may finish and bill it, so it stays spent.
        spent = LOOKALIKE_USD;
        skip = "timeout";
      } else {
        skip = isRefusal(err) ? "refused" : "error";
        if (skip === "error") deps.log(`no look-alike: ${(err as Error)?.message ?? String(err)}`);
      }
    } finally {
      clearTimeout(timer);
      await held.hold.settle(spent);
    }
    if (spent > 0) await deps.charge(lookalikeUsage()).catch((err) => deps.log(`usage not recorded: ${(err as Error).message}`));
    costUsd += spent;

    const type = bytes ? imageType(bytes) : null;
    if (!bytes || !type) {
      skipped.push(skip ?? "empty");
      continue;
    }
    try {
      const url = await deps.store(bytes, type);
      const distractor: SamDistractor = { url, source: "muse-image", split: splitFor(index), kept: true };
      if (!(await deps.save(distractor))) {
        skipped.push("full");
        break;
      }
      made.push(distractor);
    } catch (err) {
      deps.log(`look-alike not saved: ${(err as Error).message}`);
      skipped.push("error");
    }
  }
  return { made, refused, skipped, costUsd: Math.round(costUsd * 1e6) / 1e6 };
}
