import type { LiveCaptionDeps } from "@/lib/caps/live/captions";
import { env } from "@/lib/env";

/** The Meta gateway's part of the live cap: only while it is served, so the gateway's deps are today's otherwise. */
export function liveCaptionDeps(): LiveCaptionDeps | null {
  return env.servedCaps.includes("live") ? { minutesPerDay: env.liveCaptionMinutes } : null;
}
