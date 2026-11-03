import { samRequest, type JsonObject } from "@/lib/docs/media/requests";
import { parseSamOutput, samTextOfResponse, type SamBox } from "@/lib/docs/media/sam";
import { fromResponsesUsage, usageCost } from "@/lib/meta/pricing";
import type { ModelUsage } from "@/lib/types";
import { holdSpend, type SpendDeps, type SpendLimits, type SpendRefusal } from "@/lib/train/sam/spend";
import type { SamPhoto } from "@/lib/train/sam/types";

/**
 * First boxes for the person's own photos (U6): one hosted SAM 3.1 look per photo through the Responses API
 * (samRequest, lib/docs/media/requests.ts), asked the run's generic word ("plush toy"), since Meta's weights have never
 * heard the person's own name for it. Boxes only: the masks come back one_bit and are dropped, and the parser is
 * lib/docs/media/sam.ts. The person then checks every box on the review grid, fixes or skips it, and only checked boxes
 * go to the board.
 *
 * Every look is held against the caps first (lib/train/sam/spend.ts). A refusal stops the batch before the call, so a
 * capped run sends nothing. A batch is small (LABEL_BATCH) so one request stays well inside a function's time limit;
 * the page asks again until every photo has a box or was skipped.
 */

export const SAM_LABEL_MODEL = "sam-3.1";
/** One image on SAM 3.1 (lib/meta/pricing.ts): $2.50 per 1,000. */
export const LABEL_PHOTO_USD = usageCost({ model: SAM_LABEL_MODEL, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 1 });
/** Looks in one request: 6 at 40 s each stays inside the route's 300 s. */
export const LABEL_BATCH = 6;
/** One look's time box. */
export const LABEL_TIMEOUT_MS = 40_000;
/** The other boxes the page may offer instead of the first pick. */
export const LABEL_CANDIDATES = 3;

/** A COCO box: [x, y, width, height] in the photo's own pixels, as the board writes its COCO json. */
export type CocoBox = [number, number, number, number];

export interface LabelRun {
  id: string;
  generic: string;
  photos: SamPhoto[];
}

export interface LabelDeps extends SpendDeps {
  /** Sends one Responses request (POST /responses, not streamed). Must stop when `signal` aborts. */
  segment(body: JsonObject, signal: AbortSignal): Promise<unknown>;
  /** Saves a photo's box and skipped mark, by its url. */
  savePhoto(url: string, patch: { box: CocoBox | null; skipped: boolean }): Promise<void>;
  /** Records the call's usage and adds `usd` to the run's cost. */
  charge(usage: ModelUsage): Promise<void>;
  log(message: string): void;
  timeoutMs?: number;
}

export interface LabeledPhoto {
  url: string;
  box: CocoBox | null;
  skipped: boolean;
  /** Up to LABEL_CANDIDATES boxes SAM found, best first, for the page to offer. Not stored. */
  candidates: Array<{ box: CocoBox; confidence: number | null }>;
}

export interface LabelOutcome {
  labeled: LabeledPhoto[];
  /** Set when a cap stopped the batch before its next call. */
  refused: SpendRefusal | null;
  /** Looks that failed (no box saved; the photo stays unlabeled and can be asked again). */
  failed: number;
  /** What this batch cost. */
  costUsd: number;
  /** Photos still with no box and not skipped after this batch. */
  left: number;
}

/** The photos still waiting for a first box: no box and not skipped, in upload order. */
export function needsLabel(photos: readonly SamPhoto[]): SamPhoto[] {
  return photos.filter((p) => !p.box && !p.skipped);
}

/** SAM's inclusive corners as a COCO box, held inside the photo. */
export function cocoBox(b: SamBox): CocoBox {
  const x1 = Math.max(0, Math.min(b.x1, b.x2));
  const y1 = Math.max(0, Math.min(b.y1, b.y2));
  const x2 = b.w > 0 ? Math.min(b.w - 1, Math.max(b.x1, b.x2)) : Math.max(b.x1, b.x2);
  const y2 = b.h > 0 ? Math.min(b.h - 1, Math.max(b.y1, b.y2)) : Math.max(b.y1, b.y2);
  return [x1, y1, Math.max(1, x2 - x1 + 1), Math.max(1, y2 - y1 + 1)];
}

/** The boxes in a reply, best first: by confidence, then by area when confidence is missing. */
export function boxesOf(reply: unknown): Array<{ box: CocoBox; confidence: number | null }> {
  const out = parseSamOutput(samTextOfResponse(reply));
  const seen = new Set<string>();
  const boxes: Array<{ box: CocoBox; confidence: number | null; area: number }> = [];
  for (const r of out.records) {
    if (r.frame !== 0 || seen.has(r.objectId)) continue;
    seen.add(r.objectId);
    const box = cocoBox(r.box);
    boxes.push({ box, confidence: r.box.confidence ?? r.mask.confidence ?? null, area: box[2] * box[3] });
  }
  boxes.sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1) || b.area - a.area);
  return boxes.map(({ box, confidence }) => ({ box, confidence }));
}

/** The request for one photo: the generic word, the photo's public URL, boxes wanted, not streamed. */
export function labelRequest(generic: string, url: string): JsonObject {
  return samRequest({ prompt: generic, media: { url }, kind: "image", stream: false, maskEncoding: "one_bit", includeConfidence: true }).body;
}

/** What a reply cost: Meta's own count when it gives one, else one image. */
export function labelUsage(reply: unknown): ModelUsage {
  const usage = (reply as { usage?: Parameters<typeof fromResponsesUsage>[1] } | null)?.usage;
  const u = fromResponsesUsage(SAM_LABEL_MODEL, usage);
  if (u.images && u.costUsd > 0) return u;
  return { ...u, images: 1, costUsd: LABEL_PHOTO_USD };
}

function isTimeout(err: unknown, signal: AbortSignal): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return signal.aborted || (typeof name === "string" && /timeout/i.test(name));
}

/**
 * Labels up to `max` photos that have no box yet, one look at a time. Never throws for a single look: a failed look
 * leaves its photo unlabeled. A look that found nothing saves the photo as skipped, so the batch moves on; the person
 * can still draw a box for it on the review grid.
 */
export async function labelPhotos(run: LabelRun, limits: SpendLimits, deps: LabelDeps, max = LABEL_BATCH): Promise<LabelOutcome> {
  const todo = needsLabel(run.photos).slice(0, Math.max(0, max));
  const labeled: LabeledPhoto[] = [];
  let refused: SpendRefusal | null = null;
  let failed = 0;
  let costUsd = 0;

  for (const photo of todo) {
    const held = await holdSpend(deps, limits, LABEL_PHOTO_USD);
    if (!held.ok) {
      refused = held.reason;
      break;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? LABEL_TIMEOUT_MS);
    let reply: unknown = undefined;
    let spent = 0;
    try {
      reply = await deps.segment(labelRequest(run.generic, photo.url), abort.signal);
      const usage = labelUsage(reply);
      spent = usage.costUsd;
      await deps.charge(usage).catch((err) => deps.log(`usage not recorded: ${(err as Error).message}`));
    } catch (err) {
      // A look still out when its time box ran out may be billed anyway: keep the hold, on the safe side of the caps.
      if (isTimeout(err, abort.signal)) {
        spent = LABEL_PHOTO_USD;
        const usage = { model: SAM_LABEL_MODEL, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 1, costUsd: spent };
        await deps.charge(usage).catch((e) => deps.log(`usage not recorded: ${(e as Error).message}`));
      }
      deps.log(`look failed: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      clearTimeout(timer);
      await held.hold.settle(spent);
    }
    costUsd += spent;
    if (reply === undefined) {
      failed += 1;
      continue;
    }
    const found = boxesOf(reply);
    const box = found[0]?.box ?? null;
    const patch = { box, skipped: !box };
    try {
      await deps.savePhoto(photo.url, patch);
    } catch (err) {
      deps.log(`box not saved: ${(err as Error).message}`);
      failed += 1;
      continue;
    }
    labeled.push({ url: photo.url, ...patch, candidates: found.slice(0, LABEL_CANDIDATES) });
  }

  const done = new Set(labeled.map((l) => l.url));
  const left = needsLabel(run.photos).filter((p) => !done.has(p.url)).length;
  return { labeled, refused, failed, costUsd: Math.round(costUsd * 1e6) / 1e6, left };
}

/** A box the person drew or fixed on the review grid, checked: four finite numbers inside the photo, at least 2 px. */
export function personBox(value: unknown): CocoBox | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const n = value.map((v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN));
  if (n.some((v) => Number.isNaN(v))) return null;
  const [x, y, w, h] = n;
  if (x < 0 || y < 0 || w < 2 || h < 2 || x + w > 4096 || y + h > 4096) return null;
  return [x, y, w, h];
}
