import { env } from "@/lib/env";
import { adjustCounter, reserveCounter } from "@/lib/gateway/store";
import { metaPlatform } from "@/lib/meta/platform";
import type { EditReply } from "@/lib/pipeline/plan-art";
import { putFile } from "@/lib/storage";
import type { ModelUsage } from "@/lib/types";
import { platformSpendToday, recordUsage } from "@/lib/usage";
import { LOOKALIKE_TIMEOUT_MS, type DistractorDeps } from "@/lib/train/sam/distractors";
import { LABEL_TIMEOUT_MS, type LabelDeps } from "@/lib/train/sam/label";
import { runCapUsd, type SpendDeps, type SpendLimits } from "@/lib/train/sam/spend";
import { SAMTUNE_PREFIX, samTuneDailyUsd, samTuneMaxUsd } from "@/lib/train/sam/u1-shim";
import { addDistractor, addRunCost, savePhoto, type UploadRun } from "@/lib/train/sam/uploads-store";

/**
 * The real dependencies of U6's paid calls (labels and look-alikes): the rate_limits counters, the platform's daily
 * spend, the platform's Meta client, Blob and the usage table. The routes build these; the tests pass fakes instead.
 */

export function spendDeps(): SpendDeps {
  return {
    reserveCounter,
    adjustCounter,
    platformSpendOk: async () => (await platformSpendToday()) < env.dailySpendCapUsd,
    now: () => new Date(),
  };
}

export function spendLimits(run: Pick<UploadRun, "id" | "maxUsd">): SpendLimits {
  return { runId: run.id, runMaxUsd: runCapUsd(run.maxUsd, samTuneMaxUsd()), dailyUsd: samTuneDailyUsd() };
}

/** A stored file's URL as Meta can fetch it: local runs give a path, which gets the platform's own address. */
export function fetchableUrl(url: string): string {
  return url.startsWith("/") ? `${env.platformUrl}${url}` : url;
}

function charge(runId: string, endpoint: string) {
  return async (usage: ModelUsage) => {
    await recordUsage({ source: "platform", endpoint }, [usage]);
    await addRunCost(runId, usage.costUsd);
  };
}

const log = (what: string, runId: string) => (message: string) => console.warn(`[sam tune ${what}] ${runId}: ${message}`);

export function labelDeps(run: UploadRun): LabelDeps {
  return {
    ...spendDeps(),
    segment: (body, signal) =>
      metaPlatform().post("/responses", { body: fetchableBody(body), signal, maxRetries: 0, timeout: LABEL_TIMEOUT_MS }),
    savePhoto: async (url, patch) => {
      if (!(await savePhoto(run.id, url, patch))) throw new Error("the run is no longer a draft");
    },
    charge: charge(run.id, "responses"),
    log: log("labels", run.id),
  };
}

/** A SAM request with any local path in its image_url made fetchable. */
function fetchableBody<T>(body: T): T {
  return JSON.parse(JSON.stringify(body), (key, value) => (key === "image_url" && typeof value === "string" ? fetchableUrl(value) : value)) as T;
}

export function distractorDeps(run: UploadRun): DistractorDeps {
  return {
    ...spendDeps(),
    draw: (request, signal) =>
      metaPlatform().post<EditReply>(request.path, { body: fetchableBody(request.body), signal, maxRetries: 0, timeout: LOOKALIKE_TIMEOUT_MS }),
    store: (bytes, type) => putFile(SAMTUNE_PREFIX, `${run.id}/lookalikes/muse-image.${type.ext}`, bytes, type.contentType),
    save: async (distractor) => (await addDistractor(run.id, distractor)) !== null,
    charge: charge(run.id, "images"),
    log: log("look-alikes", run.id),
  };
}
