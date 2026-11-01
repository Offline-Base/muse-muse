import type { CapCatalogEntry } from "@/lib/caps/catalog";

/** The brief writer's catalog section for the data cap (docs/CAPABILITIES.md, section 9). */
export const DATA_CATALOG: CapCatalogEntry = {
  name: "saved data",
  block: [
    "- data (Saving): a product can save items through the platform, so they survive a reload and others can see them. Shared items everyone sees; visitor items stay with one browser; owner items are the product owner's; user items follow a person who signs in with a passkey through Muse Muse, with no email and no password. Pick it only when the muse needs saved items. Personal details go only in visitor, owner or user collections. Up to 6 collections, 64 KB an item, 10,000 items and 50 MB a product, 200 items a visitor and 1,000 a signed-in person.",
  ].join("\n"),
};
