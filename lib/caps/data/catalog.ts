import type { CapCatalogEntry } from "@/lib/caps/catalog";
import { dataSignInOn } from "@/lib/caps/data/types";

/** The brief writer's catalog section for the data cap (docs/CAPABILITIES.md, section 9). */
export const DATA_CATALOG: CapCatalogEntry = {
  name: "saved data",
  // Read per call, since it follows DATA_SIGN_IN.
  get block() {
    return dataSignInOn() ? SIGN_IN_BLOCK : NO_SIGN_IN_BLOCK;
  },
};

const SIGN_IN_BLOCK =
  "- data (Saving): a product can save items through the platform, so they survive a reload and others can see them. Shared items everyone sees; visitor items stay with one browser; owner items are the product owner's; user items follow a person who signs in with a passkey through Muse Muse, with no email and no password. Pick it only when the muse needs saved items. Personal details go only in visitor, owner or user collections. In a shared list anyone or signed-in people write, each of them can change or remove what others added. Up to 6 collections, 64 KB an item, 10,000 items and 50 MB a product, 200 items a visitor and 1,000 a signed-in person.";

const NO_SIGN_IN_BLOCK =
  "- data (Saving): a product can save items through the platform, so they survive a reload and others can see them. Shared items everyone sees; visitor items stay with one browser; owner items are the product owner's. People can't sign in to products yet. Pick it only when the muse needs saved items. Personal details go only in visitor or owner collections. In a shared list anyone writes, any visitor can change or remove what others added. Up to 6 collections, 64 KB an item, 10,000 items and 50 MB a product, 200 items a visitor.";
