/**
 * Teaching SAM 3.1 a new object (SAM_TUNE, off by default). The shared contract every SAM tune unit builds against: the
 * run's row, the office board's worker API and the report it posts. The board (jetson-03, scripts/edge/sam3/tune/) sends
 * numbers only; lib/train/sam/logic.ts writes the verdict and caveats on the server.
 *
 * Nothing here imports server code, so a page or a test can use these types as they are.
 */
export type SamStatus = "draft" | "queued" | "claimed" | "running" | "done" | "failed" | "stopped";
export type SamStage = "claimed" | "building_sets" | "loading_meta" | "scoring_meta" | "training"
  | "loading_tune" | "scoring_tune" | "drawing" | "uploading" | "done";
export type SamData = "builtin-muse" | "uploads";
/** `box` is COCO form, [x, y, width, height] in the photo's own pixels, as per_image.json and the board's COCO json have it. */
export interface SamPhoto { url: string; split: "train" | "held"; box: [number, number, number, number] | null; skipped: boolean }
export interface SamDistractor { url: string; source: "muse-image" | "own"; split: "train" | "held"; kept: boolean }
export interface SamProgress { stage: SamStage; step?: number; steps?: number; line?: string; at: string }
export interface SamSettingScore {             // one column
  B: { n: number; found: number; top: number; only: number; otherBoxes: number; ap: number; ap50: number };
  A: { n: number; firedPhotos: number; boxes: number };
  H?: { n: number; found: number; ap: number };
  medianScore: number | null; medianBestOther: number | null;
}
export type SamSettingId = "meta_word" | "meta_generic" | "meta_toy" | "tuned_word" | "tuned_generic" | "prior_word";
export interface SamImage { url: string; rule: "tuned_top" | "generic_top" | "tuned_false_fire"; caption: string; credit: string | null; license: string | null }
export interface SamReportIn {                 // what the board posts to /done (max 64 KB)
  version: 1; word: string; generic: string; seed: number; setsSource: "nov3" | "run";
  settings: Partial<Record<SamSettingId, SamSettingScore>>;
  truck: { meta: { truck: number; wheel: number }; tuned: { truck: number; wheel: number } };
  images: SamImage[]; files: { scores: string; perImage: string };  // urls from /upload
  // apFrom: the lowest score counted toward AP. A board run scores from 0.05. Only the Nov 3 numbers (the fixture and the
  // 5 AM fallback import) kept boxes at 0.5 or more, so their AP is a lower bound and the caveats have to say so.
  deltaSha256: string; workerId: string; apFrom: 0.05 | 0.5; timings: Record<string, number>;
}
export interface SamReport extends SamReportIn { verdict: { code: "better" | "adds_name" | "worse" | "mixed"; text: string }; caveats: string[] }
export interface SamRunView { id: string; word: string; generic: string; data: SamData; status: SamStatus;
  stage: SamProgress | null; queueAhead: number; boardSeenAt: string | null; report: SamReport | null;
  costUsd: number; maxUsd: number; shown: boolean; createdAt: string; photos?: SamPhoto[]; distractors?: SamDistractor[] }
export const SAM_TUNE_LIMITS = { photosMin: 12, photosMax: 60, heldMin: 4, distractorsMin: 16, distractorsMax: 24,
  leaseMs: 600_000, uploadMaxBytes: 400_000, uploadsMax: 10, reportMaxBytes: 65_536, wordRe: /^[a-z]{2,24}$/,
  genericRe: /^[a-z][a-z ]{1,23}$/ } as const;

// ---------- Beyond the shared contract: what U1 adds for the other units ----------

export type SamVerdictCode = SamReport["verdict"]["code"];
export type SamImageRule = SamImage["rule"];

/** What `POST /api/train/sam/worker/next` answers with when it hands the board a run. `jobToken` is shown only here. */
export interface SamClaim {
  id: string;
  word: string;
  generic: string;
  data: SamData;
  photos: SamPhoto[];
  distractors: SamDistractor[];
  seed: number;
  epochs: number;
  jobToken: string;
}

/** What the board says about itself when it polls. */
export interface SamWorkerPoll {
  workerId: string;
  freeMemMb: number;
  freeDiskMb: number;
}

// ---------- Spend counters (U2's Start and U6's paid calls share these) ----------

/**
 * The rate_limits counter (lib/gateway/store.ts reserveCounter) all SAM tune Meta spend in one UTC day is held under, in
 * micro-dollars (a hosted SAM 3.1 look is $0.0025, so cents would round it up fourfold). U2's Start and U6's labels and
 * look-alikes reserve and settle this one key, so SAM_TUNE_DAILY_USD is counted once.
 */
export const SAM_TUNE_DAY_KEY = "sam-tune-usd";
/** One run's own spend counter, held to its max_usd. */
export const samTuneRunKey = (runId: string) => `sam-tune-run-usd:${runId}`;

/**
 * The window a day counter is kept under: the next UTC midnight, never today's. The hourly cleanup cron
 * (lib/gateway/cleanup.ts) deletes rate_limits windows that started over an hour ago, so a window at today's midnight
 * would be wiped every hour and the daily cap would become an hourly one (lib/tools/handler.ts dayWindow does the same).
 */
export function samTuneDayWindow(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** A run counter's one window, far in the future so the cleanup never deletes it and the run cap never resets. */
export const SAM_TUNE_RUN_WINDOW = new Date(Date.UTC(9999, 0, 1));

/** Dollars to whole micro-dollars, rounded up, so a hold never comes out under the real cost. */
export function samMicros(usd: number): number {
  return Math.max(0, Math.ceil(Math.round(usd * 1e9) / 1e3));
}
