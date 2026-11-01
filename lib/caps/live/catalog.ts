import type { CapCatalogEntry } from "@/lib/caps/catalog";
import { LIVE_LIMITS } from "@/lib/caps/live/limits";
import { liveUpdatesOn } from "@/lib/caps/live/parts";

/** The brief writer's catalog section for the live cap (docs/CAPABILITIES.md, section 13). */
export function liveCatalog(updatesOn: boolean): CapCatalogEntry {
  return {
    name: updatesOn ? "near-live captions and live shared updates" : "near-live captions",
    block: [
      "- live: for a product whose main work happens as it's said or as others change it:",
      "  captions: Near-live captions: the browser sends 2 to 3 second pieces, so text appears a few seconds behind. No two-way voice conversation yet. About $0.18 an hour of audio, a limited number of minutes per person per day.",
      ...(updatesOn
        ? [`  updates: changes to a saved collection show in every open browser within a few seconds, with no reload, for at most ${LIVE_LIMITS.streamsPerProduct} people watching at once. Needs the data service for that collection.`]
        : []),
    ].join("\n"),
  };
}

/** Read when the catalog is built, so it names what's on at the time. */
export const LIVE_CATALOG: CapCatalogEntry = {
  get name() {
    return liveCatalog(liveUpdatesOn()).name;
  },
  get block() {
    return liveCatalog(liveUpdatesOn()).block;
  },
};
