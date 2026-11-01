import { registerCapCleanup } from "@/lib/caps/cleanup";
import { windowDeps } from "@/lib/caps/gpu/deps";
import { fillAllProductIds } from "@/lib/caps/gpu/store";
import { sweepWindows } from "@/lib/caps/gpu/windows";
import { env } from "@/lib/env";

/** A demo window past its end stops its GPU, and one whose GPU is down settles. Returns how many moved. */
export async function sweepGlimmerWindows(now: Date): Promise<number> {
  return sweepWindows(now, windowDeps());
}

/**
 * The hourly sweep's entry, which only the cron route imports: this reaches lib/train/launch and its workflow, which the
 * build's steps must not bundle (lib/caps/__tests__/build-steps-bundle.test.ts). Windows only while the shared endpoint is
 * on: one that outlives the flag still has its job's own deadline, and settles when it's back on. training_jobs.product_id
 * fills while either flag is on, so /models never has to write. With both off the cron's answer is today's.
 */
export function registerGpuSweep(): void {
  registerCapCleanup({
    cap: "gpu",
    get sweep() {
      if (!env.gpuGlimmerShared && !env.gpuTrainOnData) return undefined;
      return async (now: Date) => {
        await fillAllProductIds();
        return env.gpuGlimmerShared ? sweepGlimmerWindows(now) : 0;
      };
    },
  });
}
