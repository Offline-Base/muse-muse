import type { Brief } from "@/lib/brief/schema";
import { FLEET_LABEL, usesFleet } from "@/lib/caps/fleet/marker";

/**
 * The catalog's line while FLEET_PRODUCTS is on (docs/CAPABILITIES.md, 17b). It names no model, since the platform's setting
 * chooses it and the owner hasn't yet. Whichever it is, it's a Meta model (lib/caps/fleet/settings.ts).
 */
export const FLEET_CATALOG_LINE =
  "- jetson-fleet: a Meta model on boards Muse Muse runs, reached through the gateway rather than Meta's API. Text only, one whole reply at a time, about 13 to 15 tokens a second, at most 100 answers a day per product. When the boards can't answer, the product says the fleet is offline: nothing answers in its place. The text passes through the product's server, Muse Muse, ngrok and the lead board. Pick it only when the muse asks for answers from Muse Muse's own boards. Never pick it for health, student, legal, money or other personal data.";

/** The build prompt's section for a brief that picks jetson-fleet while the endpoint is on. In capsBuildLines. */
export function fleetBuildLines(brief: Brief): string[] {
  if (!usesFleet(brief)) return [];
  return [
    "",
    "### The Jetson fleet",
    "",
    "- The brief picks jetson-fleet. Read `.agents/skills/jetson-fleet/SKILL.md` first.",
    "- Every answer goes through `askFleetOrMessage({ messages, request })` in `lib/meta/fleet.ts`, on the server. It returns `{ text, answered, label }`, it never throws, and no other model answers in its place. Don't write a fallback.",
    `- Show \`label\` with every answer, word for word, whenever it isn't null: "${FLEET_LABEL}"`,
    "- Text only. Don't offer it images or audio, and don't use it for health, student, legal, money or other personal data.",
    "- An answer can take over a minute. Show that it's working, and set the route's `maxDuration` to 120.",
    "- During this build the gateway answers with a simulated reply, not a model. Don't assert its words. The smoke test proves that a reply shows, with the label.",
    "- The line in `template/AGENTS.md` about reaching only the Meta API still holds for everything else: this goes through the Muse Muse gateway.",
  ];
}

/** What a change request adds for a product on the fleet. */
export function fleetRefineLines(brief: Brief): string[] {
  if (!usesFleet(brief)) return [];
  return ["", "Keep every Jetson fleet answer going through `askFleetOrMessage` in `lib/meta/fleet.ts`, and keep showing its `label` word for word."];
}

/** The judge's note for a product on the fleet. Empty otherwise, so the instructions are today's. */
export function fleetJudgeNote(brief: Partial<Brief>): string {
  return usesFleet(brief as Brief) ? "The Jetson fleet's answers in this test are simulated, so don't judge their words. Check that an answer shows, with the line saying it was answered on boards." : "";
}
