import type { CapCatalogEntry } from "@/lib/caps/catalog";
import { jobsWebhooksOn } from "@/lib/caps/jobs/flags";

/** The brief writer's catalog section for the jobs cap (docs/CAPABILITIES.md, section 12), read per call. */
export const JOBS_CATALOG: CapCatalogEntry = {
  name: "scheduled jobs",
  get block() {
    const lines = [
      "- jobs (Background jobs): work that runs with nobody on the page, for products by signed-in builders. A schedule runs at most every 15 minutes, a long job goes on across up to 10 steps, and each run has a small dollar limit. A job can read, save to the collections the brief names, and leave the owner a notice in Muse Muse. It sends nothing by itself: a message it drafts waits for the owner to confirm. Schedules stop after 14 days with no visit from the owner. No always-on servers: nothing runs between steps.",
    ];
    if (jobsWebhooksOn()) lines.push("  Another service can start a job by posting to a private address the owner gets once (up to 2 per product).");
    return lines.join("\n");
  },
};
