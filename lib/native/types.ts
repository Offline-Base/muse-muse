/**
 * The native lane's shared shapes (docs/NATIVE.md): lab jobs, artifacts, the spend ledger and what a run stores. The
 * tables are in lib/db/schema.ts, and the `native` build event and its condensing are in lib/types.ts.
 */
import type { TargetId } from "@/lib/brief/schema";

export type { NativeEventBody, NativeItemState, NativeOrigin, NativeItemView, NativeRunView } from "@/lib/types";

/** The lab boxes. Device Farm isn't one: it has no queue, only a budget. */
export const NATIVE_LANES = ["mac", "windows"] as const;
export type NativeLane = (typeof NATIVE_LANES)[number];

/** What a lab box can be asked to do, as native/lab/jobs names them. */
export const NATIVE_JOB_KINDS = ["ios_sim", "android_emu", "desktop_mac", "desktop_windows", "glasses_sim", "shell_release"] as const;
export type NativeJobKind = (typeof NATIVE_JOB_KINDS)[number];

/** The lane each job kind runs on. shell_release is whichever box builds that shell, so its job row says. */
export const JOB_KIND_LANE: Record<Exclude<NativeJobKind, "shell_release">, NativeLane> = {
  ios_sim: "mac",
  android_emu: "mac",
  desktop_mac: "mac",
  desktop_windows: "windows",
  glasses_sim: "mac",
};

export const NATIVE_JOB_STATUSES = ["queued", "claimed", "done", "failed", "expired", "canceled"] as const;
export type NativeJobStatus = (typeof NATIVE_JOB_STATUSES)[number];

export const NATIVE_RUN_STATUSES = ["planned", "running", "done", "partial", "failed", "canceled"] as const;
export type NativeRunStatus = (typeof NATIVE_RUN_STATUSES)[number];

/** Files a run keeps. The first three are downloads; the rest are what a check left behind. */
export const NATIVE_ARTIFACT_KINDS = ["android_apk", "mac_zip", "windows_zip", "clip", "poster", "shot", "report", "log"] as const;
export type NativeArtifactKind = (typeof NATIVE_ARTIFACT_KINDS)[number];

/** What `/p/<slug>/get/<kind>` answers for, and the artifact behind each. */
export const NATIVE_DOWNLOADS = { android: "android_apk", mac: "mac_zip", windows: "windows_zip" } as const satisfies Record<string, NativeArtifactKind>;
export type NativeDownload = keyof typeof NATIVE_DOWNLOADS;

/** A check's result on an artifact: null for a package nobody has checked yet. */
export type NativeCheck = "passed" | "failed";

/** What the ledger keeps budgets for. "total" is the $150 cap over the other three. */
export const NATIVE_BUDGET_LANES = ["mac", "windows", "device_farm", "total"] as const;
export type NativeBudgetLane = (typeof NATIVE_BUDGET_LANES)[number];

export type NativeSpendKind = "reserve" | "commit" | "release";

/** One thing a run plans to do. `item` is the id the `native` events name it by, such as "package:android". */
export interface NativePlanItem {
  item: string;
  target: TargetId;
  kind: "package" | "check" | "device_farm";
  /** Why it won't run this time, in a plain sentence. Null when it will. */
  skip: string | null;
}

/** native_runs.plan. */
export interface NativePlan {
  items: NativePlanItem[];
  shellVersion: string | null;
}

/** native_runs.summary: what the run ended with, for the product page. */
export interface NativeRunSummary {
  packaged: NativeArtifactKind[];
  checks: Array<{ item: string; check: NativeCheck | "not_checked"; device: string | null }>;
  note?: string;
}

/**
 * native_jobs.input. native/lab/lib/validate.mjs is the source of truth and is strict, so `v` and `limitSeconds` are all
 * this type promises; each kind's fields are in docs/NATIVE_LAB.md, "Job inputs".
 */
export interface NativeJobInput {
  v: 1;
  limitSeconds: number;
  [field: string]: unknown;
}

/** native_jobs.result: the finish call's body, as docs/NATIVE_LAB.md has it. Treat its links as claims. */
export interface NativeJobResult {
  outcome: "passed" | "failed" | "lab_error";
  informational?: boolean;
  summary: string;
  [field: string]: unknown;
}

/** native_labs.state: what a box last said about itself. */
export interface NativeLabState {
  slots?: number;
  running?: string[];
  kinds?: string[];
  capabilities?: Record<string, unknown>;
  simBooted?: boolean;
  emulatorBooted?: boolean;
  diskFreeGb?: number;
}
