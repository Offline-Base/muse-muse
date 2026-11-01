import { isSparkOpenDerivative } from "@/lib/caps/gpu/general";
import type { GlimmerWindow } from "@/lib/caps/gpu/types";
import { clampLimits, recipeDefaults, SERVE_ADAPTER_PARAM, SERVE_BOOT_MINUTES, SERVE_MINUTES_PARAM, SERVE_RECIPE, serveMinutes, validateParams } from "@/lib/train/logic";
import { isTrainTerminal, type TrainStatus } from "@/lib/train/types";
import { recipeById } from "@/lib/train/recipes";
import type { LaunchInput, LaunchResult } from "@/lib/train/launch";
import type { ModelUsage } from "@/lib/types";
import type { UsageContext } from "@/lib/usage";

/**
 * Demo windows of the shared Glimmer endpoint (docs/CAPABILITIES.md, section 17; decision 11). An admin opens one. It starts
 * a glimmer-serve job through General's launchJob, with every lab cap (TRAIN_DAILY_USD, TRAIN_MAX_ACTIVE, the job's own
 * dollar limit), and reserves that job's whole dollar limit as a `glimmer` usage row, under GPU_GLIMMER_DAILY_USD. Closing
 * asks the GPU to stop. The reservation settles at what the job really cost once its GPU is down, here or in the hourly
 * sweep. A job's own deadline stops the GPU whether or not anyone closes the window.
 */

export const WINDOW_MODEL = "glimmer-window";

export interface WindowJob {
  status: string;
  costUsd: number;
  instanceId: string | null;
  terminatedAt: Date | null;
  stopRequested: boolean;
}

export interface WindowDeps {
  dailyUsd(): number;
  dailySpendCapUsd(): number;
  jobCeilings(): { maxMinutes: number; maxUsd: number };
  platformSpendToday(): Promise<number>;
  reservedToday(now: Date): Promise<number>;
  adapter(jobId: string): Promise<{ job: { params: Record<string, unknown> | null }; metrics: Record<string, unknown> | null } | null>;
  insert(input: Pick<GlimmerWindow, "startsAt" | "endsAt" | "createdBy" | "capUsd" | "adapterJobId" | "sparkOpen" | "reservationId">): Promise<GlimmerWindow | null>;
  get(id: string): Promise<GlimmerWindow | null>;
  unsettled(): Promise<GlimmerWindow[]>;
  attach(id: string, serveJobId: string): Promise<void>;
  move(id: string, patch: Partial<Pick<GlimmerWindow, "status" | "costUsd">>): Promise<GlimmerWindow | null>;
  reserveSpend(ctx: UsageContext, model: string | null, costUsd: number): Promise<string>;
  settleSpend(id: string, item: ModelUsage | null): Promise<void>;
  launch(input: LaunchInput, caller: { userId: string }): Promise<LaunchResult>;
  job(id: string): Promise<WindowJob | null>;
  stop(jobId: string): Promise<unknown>;
  /** The adapter's serve job with a GPU not yet down, or null: what a window left without its job (a crash) may have started. */
  serveJobOf(adapterJobId: string): Promise<string | null>;
}

export type WindowRefusal = { ok: false; status: number; code: string; message: string; body?: Record<string, unknown> };
export type OpenResult = { ok: true; window: GlimmerWindow } | WindowRefusal;

const refuse = (status: number, code: string, message: string, body?: Record<string, unknown>): WindowRefusal => ({ ok: false, status, code, message, ...(body ? { body } : {}) });

const CTX: UsageContext = { source: "glimmer", endpoint: "/glimmer/windows" };
const money = (usd: number) => `$${usd.toFixed(2)}`;

/** Plain words for launchJob's refusals. A 400's code is already its sentence. */
function launchWords(code: string, status: number): string {
  if (status === 400) return code;
  const words: Record<string, string> = {
    too_many_active: "Another training or serving job is using the only slot. Wait for it, or stop it first.",
    daily_cap: "The lab's daily training cap wouldn't cover this window.",
    no_capacity: "Lambda has no free GPU in the adapter's region right now. Try again soon.",
    lambda_not_configured: "The lab's GPU account isn't set up here.",
    lambda_unavailable: "Lambda didn't answer. Try again soon.",
    platform_not_public: "This site has no public address, so a GPU couldn't report back to it.",
    sweep_not_configured: "The lab's safety sweep isn't set up here, so no GPU may start.",
    sweep_not_running: "The lab's safety sweep hasn't run lately, so no GPU may start.",
    start_failed: "The job couldn't start. Try again.",
  };
  return words[code] ?? "The GPU couldn't start.";
}

export async function openWindow(input: { adapterJobId?: unknown; minutes?: unknown; instanceType?: unknown }, caller: { userId: string }, deps: WindowDeps, now: Date = new Date()): Promise<OpenResult> {
  const dailyUsd = deps.dailyUsd();
  if (dailyUsd <= 0) return refuse(503, "caps_paused", "GPU_GLIMMER_DAILY_USD is 0, so demo windows are paused.");
  const recipe = recipeById(SERVE_RECIPE);
  if (!recipe) return refuse(500, "no_recipe", "The serving recipe is missing.");
  const params = validateParams(recipe, { [SERVE_ADAPTER_PARAM]: input.adapterJobId, ...(input.minutes === undefined ? {} : { [SERVE_MINUTES_PARAM]: input.minutes }) });
  if (!params.ok) return refuse(400, "invalid_arguments", params.error);
  if (!params.value[SERVE_ADAPTER_PARAM]) return refuse(400, "invalid_arguments", "Pick the trained adapter to serve.");
  if (input.instanceType !== undefined && typeof input.instanceType !== "string") return refuse(400, "invalid_arguments", "instanceType must be text.");
  const adapterJobId = String(params.value[SERVE_ADAPTER_PARAM]);
  const source = await deps.adapter(adapterJobId);
  if (!source) return refuse(400, "invalid_arguments", "That adapter's job doesn't exist.");

  // The job's own limits, as launchJob would set them, sent to it explicitly: it can't spend more than is reserved here.
  const limits = clampLimits(recipeDefaults(recipe, params.value), {}, deps.jobCeilings());
  const reserved = await deps.reservedToday(now);
  if (reserved + limits.maxUsd > dailyUsd) {
    return refuse(429, "budget_exceeded", `This window could cost ${money(limits.maxUsd)}, and today's windows already hold ${money(reserved)} of the ${money(dailyUsd)} a day.`);
  }
  const platform = await deps.platformSpendToday();
  if (platform + limits.maxUsd > deps.dailySpendCapUsd()) return refuse(429, "budget_exceeded", "The platform's daily spend cap wouldn't cover this window.");

  const minutes = serveMinutes(params.value);
  const reservationId = await deps.reserveSpend(CTX, WINDOW_MODEL, limits.maxUsd);
  let window: GlimmerWindow | null;
  try {
    window = await deps.insert({
      startsAt: now,
      endsAt: new Date(now.getTime() + (minutes + SERVE_BOOT_MINUTES) * 60_000),
      createdBy: caller.userId,
      capUsd: limits.maxUsd,
      adapterJobId,
      sparkOpen: isSparkOpenDerivative({ params: source.job.params, metrics: source.metrics }),
      reservationId,
    });
  } catch (err) {
    await deps.settleSpend(reservationId, null).catch((e) => console.error("[glimmer] giving a reservation back", e));
    throw err;
  }
  if (!window) {
    await deps.settleSpend(reservationId, null);
    return refuse(409, "window_open", "A demo window is already open. Close it first.");
  }

  const fail = async () => {
    await deps.move(window.id, { status: "failed", costUsd: 0 });
    await deps.settleSpend(reservationId, null);
  };
  let started: LaunchResult;
  try {
    started = await deps.launch(
      {
        recipe: SERVE_RECIPE,
        title: "Muse Glimmer demo window",
        params: params.value,
        maxMinutes: limits.maxMinutes,
        maxUsd: limits.maxUsd,
        ...(typeof input.instanceType === "string" ? { instanceType: input.instanceType } : {}),
      },
      caller,
    );
  } catch (err) {
    await fail();
    throw err;
  }
  if (!started.ok) {
    // The room's Try it live box already has this adapter's GPU up: the window shares it (one GPU, one lock).
    const shared = started.code === "demo_running" && typeof started.body?.serveJobId === "string" ? started.body.serveJobId : null;
    if (!shared) {
      await fail();
      return refuse(started.status, started.code, launchWords(started.code, started.status), started.body);
    }
    await deps.attach(window.id, shared);
    return { ok: true, window: { ...window, serveJobId: shared } };
  }
  await deps.attach(window.id, started.job.id);
  return { ok: true, window: { ...window, serveJobId: started.job.id } };
}

/** True once a job's GPU is down and its cost is final (isSettled in components/train/format.ts, the same rule). */
function jobDone(job: WindowJob): boolean {
  return isTrainTerminal(job.status as TrainStatus) && (Boolean(job.terminatedAt) || !job.instanceId);
}

/**
 * The window closed at what its job really cost. The spend first: it's the same write if two callers get here, and if it
 * fails the window is still unsettled, so the next sweep tries again, rather than its whole reservation staying on the books.
 */
async function settle(window: GlimmerWindow, job: WindowJob | null, deps: WindowDeps): Promise<GlimmerWindow> {
  const costUsd = job?.costUsd ?? 0;
  if (window.reservationId) {
    await deps.settleSpend(window.reservationId, { model: WINDOW_MODEL, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 1, costUsd });
  }
  return (await deps.move(window.id, { status: "closed", costUsd })) ?? window;
}

/** Closes a window now: products lose it at once, the GPU is asked to stop, and it settles when the GPU is down. */
export async function closeWindow(id: string, deps: WindowDeps): Promise<GlimmerWindow | null> {
  const window = await deps.get(id);
  if (!window) return null;
  if (window.status === "closed" || window.status === "failed") return window;
  const job = window.serveJobId ? await deps.job(window.serveJobId) : null;
  if (!job || jobDone(job)) return settle(window, job, deps);
  await deps.stop(window.serveJobId!);
  return (await deps.move(id, { status: "closing" })) ?? window;
}

/** The hourly sweep: a window past its end stops its GPU, and a window whose GPU is down settles. Returns how many moved. */
export async function sweepWindows(now: Date, deps: WindowDeps): Promise<number> {
  let moved = 0;
  for (const found of await deps.unsettled()) {
    let window = found;
    if (!window.serveJobId) {
      // A window opened in the last moments may not have its job attached yet.
      if (now.getTime() - window.createdAt.getTime() < 5 * 60_000) continue;
      // A crash between starting the job and attaching it: that GPU is running, so it isn't settled at $0.
      const orphan = await deps.serveJobOf(window.adapterJobId);
      if (orphan) {
        await deps.attach(window.id, orphan);
        window = { ...window, serveJobId: orphan };
      }
    }
    const job = window.serveJobId ? await deps.job(window.serveJobId) : null;
    if (!job || jobDone(job)) {
      await settle(window, job, deps);
      moved += 1;
    } else if (window.status === "open" && window.endsAt.getTime() <= now.getTime()) {
      if (!job.stopRequested) await deps.stop(window.serveJobId!);
      await deps.move(window.id, { status: "closing" });
      moved += 1;
    }
  }
  return moved;
}

/** What an admin sees of a window. Never the GPU's address, its key or a token. */
export function windowView(w: GlimmerWindow) {
  return {
    id: w.id,
    status: w.status,
    startsAt: w.startsAt.toISOString(),
    endsAt: w.endsAt.toISOString(),
    capUsd: w.capUsd,
    costUsd: w.costUsd,
    adapterJobId: w.adapterJobId,
    serveJobId: w.serveJobId,
  };
}
