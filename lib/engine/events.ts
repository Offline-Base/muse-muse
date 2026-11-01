import type { BuildEventBody } from "@/lib/types";

/**
 * The build room's line for the engine's events (docs/CAPABILITIES.md, section 8): a platform service's fixed check, a
 * milestone's progress, and the live link's check. Plain words, no em dashes. The product page leaves them out.
 */
type EngineEvent = Extract<BuildEventBody, { type: "caps" | "milestone" | "live_check" }>;

const MILESTONE_WORDS = { planned: "planned", building: "building now", passed: "passed its check", failed: "failed its check", skipped: "skipped, the build ran out of time" } as const;

export function engineEventText(e: EngineEvent): string {
  switch (e.type) {
    case "caps":
      return `Platform service ${e.cap}, check ${e.check}: ${e.ok ? "passed" : "failed"}${e.detail ? `. ${e.detail}` : ""}`;
    case "milestone":
      return `Milestone ${e.index} of ${e.of}, ${e.title}: ${MILESTONE_WORDS[e.state] ?? e.state}.`;
    case "live_check":
      return e.ok ? `The live link passed its check: ${e.url}` : `The live link failed its check: ${e.reason ?? "it did not answer"}.`;
  }
}
