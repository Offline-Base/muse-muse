/**
 * The pure rules of a SAM 3.1 tune run (SAM_TUNE): which words are allowed, how photos split, what a run will take and
 * cost, whether a board's report is well formed, and the verdict, caveats and table rows the report page shows.
 *
 * The board (scripts/edge/sam3/tune/) sends numbers only. Everything a person reads as a claim (the verdict, the caveats,
 * the image captions) is written here, on the server, so a leaked worker secret can post numbers but never a sentence.
 * No database, env or network: the store and routes call these, and the tests run them as they are.
 */
import { PRICES } from "@/lib/meta/pricing";
import {
  SAM_TUNE_LIMITS,
  type SamData,
  type SamImage,
  type SamImageRule,
  type SamPhoto,
  type SamReport,
  type SamReportIn,
  type SamSettingId,
  type SamSettingScore,
  type SamStage,
  type SamVerdictCode,
} from "@/lib/train/sam/types";

// ---------- Words ----------

/** Why `word` can't be taught, or null. One lowercase made-up name, like "muse". */
export function wordProblem(word: unknown): string | null {
  if (typeof word !== "string" || !SAM_TUNE_LIMITS.wordRe.test(word)) return "The name has to be one word of 2 to 24 lowercase letters, like muse.";
  return null;
}

/** Why `generic` can't be the everyday words Meta's SAM 3.1 is asked, or null. Like "plush toy". */
export function genericProblem(generic: unknown, word?: string): string | null {
  if (typeof generic !== "string" || !SAM_TUNE_LIMITS.genericRe.test(generic) || /  | $/.test(generic)) {
    return "The everyday words have to be 2 to 24 lowercase letters and single spaces, like plush toy.";
  }
  if (word !== undefined && generic === word) return "The everyday words have to differ from the new name.";
  return null;
}

// ---------- Splitting photos ----------

/**
 * mulberry32: a small seeded generator, so a run's split is the same every time and on the board (worker.py has the same
 * function). Returns floats in [0, 1).
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** How many of `n` photos are held out: a quarter, rounded, and never fewer than SAM_TUNE_LIMITS.heldMin. */
export function heldCount(n: number): number {
  if (n <= 0) return 0;
  return Math.min(n, Math.max(SAM_TUNE_LIMITS.heldMin, Math.round(n / 4)));
}

/**
 * Marks each item "train" or "held" by seed: a Fisher-Yates shuffle of the indexes with seededRandom(seed), and the first
 * heldCount(n) shuffled indexes are held. Items keep their order; only `split` is set.
 */
export function splitBySeed<T extends object>(items: readonly T[], seed: number, held = heldCount(items.length)): Array<T & { split: "train" | "held" }> {
  const order = items.map((_, i) => i);
  const rand = seededRandom(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const heldSet = new Set(order.slice(0, Math.max(0, Math.min(held, items.length))));
  return items.map((item, i) => ({ ...item, split: heldSet.has(i) ? "held" : "train" }));
}

/** Why a run's own photos aren't ready to train on, or null. Skipped photos and photos with no box don't count. */
export function photosProblem(photos: readonly SamPhoto[]): string | null {
  const usable = photos.filter((p) => !p.skipped && p.box);
  const held = usable.filter((p) => p.split === "held").length;
  if (usable.length < SAM_TUNE_LIMITS.photosMin) return `Add at least ${SAM_TUNE_LIMITS.photosMin} photos with a box (${usable.length} so far).`;
  if (photos.length > SAM_TUNE_LIMITS.photosMax) return `A run takes at most ${SAM_TUNE_LIMITS.photosMax} photos.`;
  if (held < SAM_TUNE_LIMITS.heldMin) return `Hold out at least ${SAM_TUNE_LIMITS.heldMin} photos for the check (${held} so far).`;
  return null;
}

// ---------- The plan card ----------

/** The built-in Muse run (Nov 3): 160 made-up Muse images to train on. */
export const BUILTIN_MUSE_TRAIN_IMAGES = 160;
/** About how many COCO bear composites the built-in run adds as look-alikes (the board builds them, seed fixed). */
export const BUILTIN_BEAR_NEGATIVES = 40;
/** Meta's trainer on jetson-03 on Nov 3: about 2.1 s a step at batch 1. */
export const SECONDS_PER_STEP = 2.1;
/** One look through SAM 3.1 on an Orin Nano: a median 1.35 s on Nov 3. */
export const SECONDS_PER_LOOK = 1.35;
/** Loading SAM 3.1 from the board's own disk, about a minute, or streamed over the office Wi-Fi, about 11. */
export const LOAD_MINUTES = { local: 1, share: 11 } as const;
/** The Nov 3 test sets: 30 photos with no Muse (A) and the same 30 with one Muse pasted in (B). */
export const NOV3_SET_PHOTOS = 30;
export const DEFAULT_EPOCHS = 5;

export interface SamPlanIn {
  data: SamData;
  /** The run's own photos (uploads), counted when not skipped. */
  photos?: readonly SamPhoto[];
  /** Muse Image look-alikes to make ($0.01 each). Built-in runs may add up to 20. */
  lookAlikes?: number;
  epochs?: number;
  /** Whether the base weights are on the board's own disk (else streamed from jetson-04). */
  baseLocal?: boolean;
}

export interface SamPlan {
  trainImages: number;
  steps: number;
  looks: number;
  minutes: number;
  /** Meta spend, an estimate: hosted SAM 3.1 boxes ($0.0025 a photo) and Muse Image look-alikes ($0.01 each). */
  costUsd: number;
  lines: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What a run will take on jetson-03 and cost on Meta, for the plan card and Start's caps. An estimate, said so on screen. */
export function planFor(input: SamPlanIn): SamPlan {
  const epochs = input.epochs ?? DEFAULT_EPOCHS;
  const lookAlikes = Math.max(0, Math.floor(input.lookAlikes ?? 0));
  const own = (input.photos ?? []).filter((p) => !p.skipped);
  let trainImages: number;
  let looks: number;
  let labelUsd = 0;
  if (input.data === "builtin-muse") {
    trainImages = BUILTIN_MUSE_TRAIN_IMAGES + BUILTIN_BEAR_NEGATIVES + lookAlikes;
    // Five settings over sets A and B (Meta's word, generic and "toy", the tune's word and generic), plus the Nov 3 tune.
    looks = 6 * 2 * NOV3_SET_PHOTOS;
  } else {
    const train = own.filter((p) => p.split === "train").length;
    const held = own.length - train;
    trainImages = train + lookAlikes;
    labelUsd = own.length * PRICES["sam-3.1"].perImage;
    // Five settings over A and B (sized like the held photos, at least the Nov 3 count is not assumed) and H.
    looks = 5 * (2 * Math.max(held, SAM_TUNE_LIMITS.heldMin) + held);
  }
  const steps = trainImages * epochs;
  const load = input.baseLocal === false ? LOAD_MINUTES.share : LOAD_MINUTES.local;
  const minutes = Math.ceil(2 * load + (steps * SECONDS_PER_STEP + looks * SECONDS_PER_LOOK) / 60 + 2);
  const costUsd = round2(labelUsd + lookAlikes * PRICES["muse-image-1.0"].perImage);
  const lines = [
    `Trains on jetson-03, the office board: ${trainImages} images, ${epochs} epochs, ${steps} steps, encoders frozen.`,
    `About ${minutes} minutes, an estimate.`,
    costUsd > 0 ? `About $${costUsd.toFixed(2)} on Meta, an estimate.` : "$0 on Meta.",
  ];
  return { trainImages, steps, looks, minutes, costUsd, lines };
}

// ---------- Stages ----------

export const SAM_STAGES: readonly SamStage[] = ["claimed", "building_sets", "loading_meta", "scoring_meta", "training", "loading_tune", "scoring_tune", "drawing", "uploading", "done"];

/** What each stage reads as in the room. */
export const SAM_STAGE_LABELS: Record<SamStage, string> = {
  claimed: "Claimed by the office board",
  building_sets: "Building the photo sets",
  loading_meta: "Loading Meta's SAM 3.1",
  scoring_meta: "Scoring Meta's SAM 3.1",
  training: "Training",
  loading_tune: "Loading the tune",
  scoring_tune: "Scoring the tune",
  drawing: "Drawing side by sides",
  uploading: "Uploading the report",
  done: "Done",
};

/** Stop is offered until training has ended: after that the run is minutes from its report. */
export function canStop(stage: SamStage | null | undefined): boolean {
  return !stage || SAM_STAGES.indexOf(stage) <= SAM_STAGES.indexOf("training");
}

// ---------- Checking the board's report ----------

export type ReportCheck = { ok: true; report: SamReportIn } | { ok: false; problem: string };

/** Detections count from this score up for AP (the board's pycocotools run). */
export const AP_FROM = 0.05;
/** Settings every report must carry: the word and generic asked of Meta's weights, Meta's "toy", and the tune's word. */
export const REQUIRED_SETTINGS: readonly SamSettingId[] = ["meta_word", "meta_generic", "meta_toy", "tuned_word"];
const SETTING_IDS: readonly SamSettingId[] = ["meta_word", "meta_generic", "meta_toy", "tuned_word", "tuned_generic", "prior_word"];
const IMAGE_RULES: readonly SamImageRule[] = ["tuned_top", "generic_top", "tuned_false_fire"];
/** The only licenses a COCO photo may be shown under (with its credit). Made-up and the person's own images carry none. */
export const SHOWN_LICENSES = ["CC BY 2.0", "CC BY-SA 2.0"] as const;
const MAX_IMAGES = 6;
const HEX64 = /^[0-9a-f]{64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown, max = 100_000): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const isUnit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const unitOrNull = (v: unknown): v is number | null => v === null || isUnit(v);

/** A plain line from the board: no control characters, no em dash, at most `max` characters. */
function cleanLine(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/—/g, ", ").replace(/\s+/g, " ").trim();
  return s.length > 0 && s.length <= max ? s : null;
}

function checkSetting(id: SamSettingId, v: unknown): SamSettingScore | string {
  if (!isObj(v) || !isObj(v.B) || !isObj(v.A)) return `${id}: needs B and A`;
  const { B, A, H } = v;
  if (!isCount(B.n, 10_000) || B.n === 0) return `${id}: B.n`;
  for (const k of ["found", "top", "only"] as const) if (!isCount(B[k]) || (B[k] as number) > (B.n as number)) return `${id}: B.${k}`;
  if (!isCount(B.otherBoxes)) return `${id}: B.otherBoxes`;
  if (!isUnit(B.ap) || !isUnit(B.ap50)) return `${id}: B.ap`;
  if ((B.only as number) > (B.found as number) || (B.top as number) > (B.found as number)) return `${id}: B counts`;
  if (!isCount(A.n, 10_000) || A.n === 0 || !isCount(A.firedPhotos) || (A.firedPhotos as number) > (A.n as number) || !isCount(A.boxes)) return `${id}: A`;
  if ((A.boxes as number) < (A.firedPhotos as number)) return `${id}: A counts`;
  let h: SamSettingScore["H"];
  if (H !== undefined) {
    if (!isObj(H) || !isCount(H.n, 10_000) || H.n === 0 || !isCount(H.found) || (H.found as number) > (H.n as number) || !isUnit(H.ap)) return `${id}: H`;
    h = { n: H.n as number, found: H.found as number, ap: H.ap as number };
  }
  if (!unitOrNull(v.medianScore) || !unitOrNull(v.medianBestOther)) return `${id}: medians`;
  return {
    B: { n: B.n as number, found: B.found as number, top: B.top as number, only: B.only as number, otherBoxes: B.otherBoxes as number, ap: B.ap as number, ap50: B.ap50 as number },
    A: { n: A.n as number, firedPhotos: A.firedPhotos as number, boxes: A.boxes as number },
    ...(h ? { H: h } : {}),
    medianScore: v.medianScore as number | null,
    medianBestOther: v.medianBestOther as number | null,
  };
}

export interface ReportRun {
  word: string;
  generic: string;
  seed: number;
  data: SamData;
  workerId: string | null;
  /** The URLs this run's board saved through /upload: the only URLs a report may point to. */
  uploads: readonly string[];
}

/**
 * Checks what the board posted to /done against its run and rebuilds it field by field, so nothing the board added
 * survives. Captions are rewritten from each image's rule (imageCaption); the board's own caption is dropped.
 */
export function validateReportIn(body: unknown, run: ReportRun, byteLength?: number): ReportCheck {
  const bad = (problem: string): ReportCheck => ({ ok: false, problem });
  const size = byteLength ?? new TextEncoder().encode(JSON.stringify(body ?? null)).length;
  if (size > SAM_TUNE_LIMITS.reportMaxBytes) return bad("report_too_large");
  if (!isObj(body)) return bad("report");
  if (body.version !== 1) return bad("version");
  if (body.word !== run.word || body.generic !== run.generic) return bad("word");
  if (body.seed !== run.seed) return bad("seed");
  if (body.setsSource !== "nov3" && body.setsSource !== "run") return bad("setsSource");
  if (run.data === "uploads" && body.setsSource !== "run") return bad("setsSource");
  if (body.apFrom !== AP_FROM) return bad("apFrom");
  if (typeof body.workerId !== "string" || (run.workerId !== null && body.workerId !== run.workerId)) return bad("workerId");
  if (typeof body.deltaSha256 !== "string" || !HEX64.test(body.deltaSha256)) return bad("deltaSha256");

  if (!isObj(body.settings)) return bad("settings");
  const settings: Partial<Record<SamSettingId, SamSettingScore>> = {};
  for (const [id, value] of Object.entries(body.settings)) {
    if (!SETTING_IDS.includes(id as SamSettingId)) return bad(`settings.${id}`);
    const got = checkSetting(id as SamSettingId, value);
    if (typeof got === "string") return bad(got);
    settings[id as SamSettingId] = got;
  }
  for (const id of REQUIRED_SETTINGS) if (!settings[id]) return bad(`settings.${id}`);
  if (run.data === "uploads" && !settings.tuned_word!.H) return bad("settings.tuned_word.H");

  const truck = body.truck;
  const pair = (v: unknown) => isObj(v) && isCount(v.truck, 1000) && isCount(v.wheel, 1000);
  if (!isObj(truck) || !pair(truck.meta) || !pair(truck.tuned)) return bad("truck");
  const t = truck as { meta: { truck: number; wheel: number }; tuned: { truck: number; wheel: number } };

  const uploads = new Set(run.uploads);
  if (!isObj(body.files) || typeof body.files.scores !== "string" || typeof body.files.perImage !== "string") return bad("files");
  if (!uploads.has(body.files.scores) || !uploads.has(body.files.perImage)) return bad("files");

  if (!Array.isArray(body.images) || body.images.length > MAX_IMAGES) return bad("images");
  const images: SamImage[] = [];
  for (const raw of body.images) {
    if (!isObj(raw) || typeof raw.url !== "string" || !uploads.has(raw.url)) return bad("images.url");
    if (!IMAGE_RULES.includes(raw.rule as SamImageRule)) return bad("images.rule");
    const license = raw.license === null || raw.license === undefined ? null : raw.license;
    if (license !== null && !SHOWN_LICENSES.includes(license as (typeof SHOWN_LICENSES)[number])) return bad("images.license");
    const credit = raw.credit === null || raw.credit === undefined ? null : cleanLine(raw.credit, 200);
    if (raw.credit != null && credit === null) return bad("images.credit");
    if (license !== null && credit === null) return bad("images.credit");
    images.push({ url: raw.url, rule: raw.rule as SamImageRule, caption: imageCaption(raw.rule as SamImageRule, run.word, run.generic), credit, license: license as string | null });
  }

  if (!isObj(body.timings)) return bad("timings");
  const timings: Record<string, number> = {};
  for (const [k, v] of Object.entries(body.timings)) {
    if (!/^[a-z_]{1,32}$/.test(k) || typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 86_400) return bad("timings");
    timings[k] = v;
  }

  return {
    ok: true,
    report: {
      version: 1,
      word: run.word,
      generic: run.generic,
      seed: run.seed,
      setsSource: body.setsSource,
      settings,
      truck: { meta: { truck: t.meta.truck, wheel: t.meta.wheel }, tuned: { truck: t.tuned.truck, wheel: t.tuned.wheel } },
      images,
      files: { scores: body.files.scores, perImage: body.files.perImage },
      deltaSha256: body.deltaSha256,
      workerId: body.workerId,
      apFrom: AP_FROM,
      timings,
    },
  };
}

// ---------- The verdict ----------

/** AP the tune must gain over Meta's better generic word for "better". */
export const BETTER_AP = 0.1;
/** AP within this of Meta's better generic word reads as "adds a name"; below it by more is "worse". */
export const SAME_AP = 0.05;
/** For "better", photos with no target the tune fires on must drop, and photos where it ranks the target top must rise, by this share of n. */
export const BETTER_SHARE = 0.2;

/** Meta's generic words, compared with the tune: whichever of the run's generic and "toy" has the higher AP. */
export function bestMetaGeneric(report: Pick<SamReportIn, "settings" | "generic">): { id: "meta_generic" | "meta_toy"; prompt: string; score: SamSettingScore } | null {
  const g = report.settings.meta_generic;
  const toy = report.settings.meta_toy;
  if (!g && !toy) return null;
  if (g && (!toy || g.B.ap >= toy.B.ap)) return { id: "meta_generic", prompt: report.generic, score: g };
  return { id: "meta_toy", prompt: "toy", score: toy! };
}

const f2 = (n: number) => n.toFixed(2);

/**
 * The verdict, from numbers only. The tune asked the word is compared with the better of Meta's SAM 3.1 asked the
 * generic words and asked "toy":
 *   better     AP up by BETTER_AP or more, fires on fewer photos with no target by BETTER_SHARE of n or more, and ranks
 *              the target top in more photos by BETTER_SHARE of n or more. "Picks it out" needs all three.
 *   adds_name  AP within SAME_AP.
 *   worse      AP below by more than SAME_AP.
 *   mixed      anything else, stating each number.
 */
export function verdictFor(report: Pick<SamReportIn, "settings" | "word" | "generic">): SamReport["verdict"] {
  const tuned = report.settings.tuned_word;
  const meta = bestMetaGeneric(report);
  if (!tuned || !meta) return { code: "mixed", text: "Not enough numbers to compare with Meta's SAM 3.1." };
  const m = meta.score;
  const dAp = tuned.B.ap - m.B.ap;
  const nA = tuned.A.n;
  const nB = tuned.B.n;
  const firesDrop = m.A.firedPhotos - tuned.A.firedPhotos;
  const topGain = tuned.B.top - m.B.top;
  const asked = `Meta's SAM 3.1 asked "${meta.prompt}"`;
  let code: SamVerdictCode;
  if (dAp >= BETTER_AP - 1e-9 && firesDrop >= BETTER_SHARE * nA - 1e-9 && topGain >= BETTER_SHARE * nB - 1e-9) code = "better";
  else if (Math.abs(dAp) <= SAME_AP + 1e-9) code = "adds_name";
  else if (dAp < -SAME_AP) code = "worse";
  else code = "mixed";
  const w = report.word;
  switch (code) {
    case "better":
      return { code, text: `Picks it out better than ${asked}.` };
    case "adds_name":
      return { code, text: `Adds a name, not accuracy: AP ${f2(tuned.B.ap)} for the tune asked "${w}" against ${f2(m.B.ap)} for ${asked}.` };
    case "worse":
      return { code, text: `Worse than Meta's own word: AP ${f2(tuned.B.ap)} for the tune asked "${w}" against ${f2(m.B.ap)} for ${asked}.` };
    default:
      return {
        code,
        text:
          `Mixed. Against ${asked}, the tune asked "${w}" has AP ${f2(tuned.B.ap)} against ${f2(m.B.ap)}, ` +
          `ranks ${w} as the top match in ${tuned.B.top} of ${nB} photos against ${m.B.top}, ` +
          `and fires on ${tuned.A.firedPhotos} of ${nA} photos with no ${w} against ${m.A.firedPhotos}.`,
      };
  }
}

/** The caveats every report carries, whatever the verdict. */
export function caveatsFor(report: Pick<SamReportIn, "settings" | "word" | "setsSource">): string[] {
  const t = report.settings.tuned_word;
  const w = report.word;
  const out = [
    t ? `A small test: ${t.B.n} photos with ${w} pasted in and ${t.A.n} photos without it.` : `A small test.`,
    `The ${w} cutouts were pasted into the photos, not photographed together.`,
    "The look-alikes are made up (Muse Image) or come from COCO.",
    `This never shows that it tells ${w} apart from all look-alikes.`,
  ];
  if (report.setsSource === "nov3") out.push("Scored on the same test photos as the Nov 3 run.");
  return out;
}

/** The report page's whole report: the board's numbers with the server's verdict and caveats. */
export function finishReport(input: SamReportIn): SamReport {
  return { ...input, verdict: verdictFor(input), caveats: caveatsFor(input) };
}

// ---------- Side by sides ----------

/** A side by side's caption, written here from its rule. */
export function imageCaption(rule: SamImageRule, word: string, generic: string): string {
  switch (rule) {
    case "tuned_top":
      return `The tune asked "${word}" ranks ${word} as its top match. Left: Meta's SAM 3.1 asked "${generic}".`;
    case "generic_top":
      return `Meta's SAM 3.1 asked "${generic}" ranks ${word} as its top match too.`;
    case "tuned_false_fire":
      return `No ${word} in this photo, and the tune asked "${word}" still boxes something.`;
  }
}

/** One photo the board could draw, as sbs_draw.py sees it. */
export interface SamPickCandidate {
  key: string;
  set: "A" | "B";
  source: "coco" | "muse-image" | "own";
  /** For COCO photos: the license name as COCO gives it, like "CC BY 2.0". */
  license: string | null;
  /** The tune asked the word put its highest box on the target. */
  tunedTop: boolean;
  /** Meta's SAM 3.1 asked the generic words put its highest box on the target. */
  genericTop: boolean;
  /** The tune's highest score on a photo with no target, or null when it boxed nothing. */
  tunedFalseScore: number | null;
}

/** A COCO photo may be shown only under CC BY or CC BY-SA, with its credit. Made-up and own images always may. */
export function mayShow(c: Pick<SamPickCandidate, "source" | "license">): boolean {
  if (c.source !== "coco") return true;
  return c.license !== null && (SHOWN_LICENSES as readonly string[]).includes(c.license);
}

/** Which side-by-side rule a photo fits, or null: a tune win, then a fair Meta win, then an honest false fire. */
export function pickRule(c: SamPickCandidate): SamImageRule | null {
  if (!mayShow(c)) return null;
  if (c.set === "B" && c.tunedTop && !c.genericTop) return "tuned_top";
  if (c.set === "B" && c.genericTop) return "generic_top";
  if (c.set === "A" && c.tunedFalseScore !== null) return "tuned_false_fire";
  return null;
}

/**
 * The side by sides to draw: one per rule, in rule order, each the first fitting photo by key (the false fire with the
 * highest score, so the worst case shows). Every report gets the false fire when there is one.
 */
export function pickImages(candidates: readonly SamPickCandidate[]): Array<{ key: string; rule: SamImageRule }> {
  const sorted = [...candidates].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const out: Array<{ key: string; rule: SamImageRule }> = [];
  for (const rule of IMAGE_RULES) {
    const fits = sorted.filter((c) => pickRule(c) === rule);
    if (rule === "tuned_false_fire") fits.sort((a, b) => (b.tunedFalseScore ?? 0) - (a.tunedFalseScore ?? 0));
    if (fits[0]) out.push({ key: fits[0].key, rule });
  }
  return out;
}

// ---------- The table ----------

export interface SamColumn {
  id: SamSettingId;
  /** "Meta SAM 3.1" or "Tuned" or "Tuned (Nov 3)". */
  weights: string;
  /** The words asked, quoted. */
  prompt: string;
}

export interface SamCell {
  text: string;
  value: number | null;
  /** Blue: the best value in its row. */
  best: boolean;
}

export interface SamRow {
  key: "found" | "top" | "only" | "fires" | "ap" | "held" | "generic" | "truck";
  label: string;
  lowerIsBetter: boolean;
  /** Aligned with reportColumns(report). */
  cells: SamCell[];
}

const COLUMN_ORDER: readonly SamSettingId[] = ["meta_word", "meta_generic", "meta_toy", "prior_word", "tuned_word"];

/** The table's columns, in order: Meta's word, generic and "toy", the Nov 3 tune when scored, then the tune. */
export function reportColumns(report: Pick<SamReportIn, "settings" | "word" | "generic">): SamColumn[] {
  const prompt: Record<SamSettingId, string> = {
    meta_word: report.word,
    meta_generic: report.generic,
    meta_toy: "toy",
    prior_word: report.word,
    tuned_word: report.word,
    tuned_generic: report.generic,
  };
  return COLUMN_ORDER.filter((id) => report.settings[id]).map((id) => ({
    id,
    weights: id.startsWith("meta_") ? "Meta SAM 3.1" : id === "prior_word" ? "Tuned (Nov 3)" : "Tuned",
    prompt: `"${prompt[id]}"`,
  }));
}

const empty = (): SamCell => ({ text: "", value: null, best: false });

/** Marks the single best value blue. A tie gets no blue, and Meta's weights asked the new word is never blue. */
function markBest(columns: readonly SamColumn[], cells: SamCell[], lowerIsBetter: boolean): SamCell[] {
  const eligible = cells.map((c, i) => ({ c, i })).filter(({ c, i }) => c.value !== null && columns[i]!.id !== "meta_word");
  if (eligible.length < 2) return cells;
  const values = eligible.map(({ c }) => c.value!);
  const best = lowerIsBetter ? Math.min(...values) : Math.max(...values);
  const winners = eligible.filter(({ c }) => Math.abs(c.value! - best) < 1e-9);
  if (winners.length !== 1) return cells;
  return cells.map((c, i) => (i === winners[0]!.i ? { ...c, best: true } : c));
}

/** The report table's rows: Finds, Ranks top, Boxes only, Fires, AP, held-out (uploads), generic, truck. */
export function reportRows(report: Pick<SamReportIn, "settings" | "word" | "generic" | "truck">): SamRow[] {
  const columns = reportColumns(report);
  const w = report.word;
  const s = (id: SamSettingId) => report.settings[id]!;
  const row = (key: SamRow["key"], label: string, lowerIsBetter: boolean, cell: (id: SamSettingId) => SamCell | null, blue = true): SamRow => {
    const cells = columns.map((c) => cell(c.id) ?? empty());
    return { key, label, lowerIsBetter, cells: blue ? markBest(columns, cells, lowerIsBetter) : cells };
  };
  const ofN = (n: number, of: number): SamCell => ({ text: `${n} of ${of}`, value: n / of, best: false });
  const ap = (v: number): SamCell => ({ text: f2(v), value: v, best: false });

  const rows: SamRow[] = [
    row("found", `Finds ${w}`, false, (id) => ofN(s(id).B.found, s(id).B.n)),
    row("top", `Ranks ${w} as the top match`, false, (id) => ofN(s(id).B.top, s(id).B.n)),
    row("only", `Boxes ${w} and nothing else`, false, (id) => ofN(s(id).B.only, s(id).B.n)),
    row("fires", `Fires on photos with no ${w}`, true, (id) => ofN(s(id).A.firedPhotos, s(id).A.n)),
    row("ap", `Accuracy at finding ${w} (AP)`, false, (id) => ap(s(id).B.ap)),
  ];
  if (columns.some((c) => s(c.id).H)) {
    rows.push(row("held", `Finds ${w} in your own held-out photos`, false, (id) => (s(id).H ? ofN(s(id).H!.found, s(id).H!.n) : null)));
  }
  const tg = report.settings.tuned_generic;
  if (tg) {
    rows.push(
      row("generic", `Still knows "${report.generic}" (AP)`, false, (id) =>
        id === "meta_generic" ? ap(s(id).B.ap) : id === "tuned_word" ? ap(tg.B.ap) : null,
      ),
    );
  }
  const truck = (v: { truck: number; wheel: number }): SamCell => ({ text: `truck ${v.truck}, wheels ${v.wheel}`, value: null, best: false });
  rows.push(row("truck", "Truck check (nothing forgotten)", false, (id) => (id === "meta_generic" ? truck(report.truck.meta) : id === "tuned_word" ? truck(report.truck.tuned) : null), false));
  return rows;
}
