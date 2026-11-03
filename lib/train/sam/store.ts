// U2 SHIM of U1's lib/train/sam/store.ts (tg-sam-core owns it). Signatures only, so the routes compile before U1
// merges; every function throws. On merge, take U1's file and drop this one. The routes assume:
//   createRun     makes a draft row.
//   getRunView    the full view (photos and distractors included), or null.
//   queueRun      draft to queued, or null when the run isn't a draft. (Not in the plan's list: U2 needs it for Start.)
//   claimNext     records the poll in boardSeenAt, fails expired leases ("the board stopped answering"), then claims
//                 the oldest queued run atomically and returns it with a fresh plaintext jobToken, or null.
//   progress      stores the stage, extends the lease, moves claimed to running; null when the run isn't claimed or running.
//   saveUpload    puts the file with putFile under samtune/<id>/report/<random>-<name> and counts it; "too_many" past
//                 SAM_TUNE_LIMITS.uploadsMax; null when the run isn't claimed or running.
//   finish        writes the server's verdict and caveats (logic.ts) over the board's numbers; status done.
//   fail          failed, or stopped when Stop was asked; null when the run already ended.
//   requestStop   queued or draft runs stop at once; claimed or running ones get stopRequested. Null when ended or unknown.
//   markShown     sets shown; null when unknown.
import type { SamData, SamProgress, SamReportIn, SamRunView, SamDistractor, SamPhoto } from "@/lib/train/sam/types";

export interface ClaimedRun {
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

const NOT_MERGED = "lib/train/sam/store.ts is U2's shim: merge tg-sam-core (U1).";

export async function createRun(_input: { word: string; generic: string; data: SamData; createdBy: string; maxUsd: number }): Promise<SamRunView> {
  throw new Error(NOT_MERGED);
}
export async function getRunView(_id: string): Promise<SamRunView | null> {
  throw new Error(NOT_MERGED);
}
export async function queueRun(_id: string): Promise<SamRunView | null> {
  throw new Error(NOT_MERGED);
}
export async function claimNext(_input: { workerId: string; freeMemMb: number; freeDiskMb: number }): Promise<ClaimedRun | null> {
  throw new Error(NOT_MERGED);
}
export async function progress(_id: string, _p: Omit<SamProgress, "at">): Promise<{ stop: boolean } | null> {
  throw new Error(NOT_MERGED);
}
export async function saveUpload(
  _id: string,
  _file: { name: string; body: Buffer; contentType: string },
): Promise<{ url: string } | "too_many" | null> {
  throw new Error(NOT_MERGED);
}
export async function finish(_id: string, _report: SamReportIn): Promise<SamRunView | null> {
  throw new Error(NOT_MERGED);
}
export async function fail(_id: string, _reason: string): Promise<SamRunView | null> {
  throw new Error(NOT_MERGED);
}
export async function requestStop(_id: string): Promise<SamRunView | null> {
  throw new Error(NOT_MERGED);
}
export async function markShown(_id: string, _shown: boolean): Promise<SamRunView | null> {
  throw new Error(NOT_MERGED);
}
