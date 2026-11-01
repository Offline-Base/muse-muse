import type { CapCatalogEntry } from "@/lib/caps/catalog";

/** The brief writer's catalog section for the extension cap (docs/CAPABILITIES.md, section 20). */
export const EXTENSION_CATALOG: CapCatalogEntry = {
  name: "a browser extension",
  block: [
    "- extension (browser extension): a Chrome extension (Manifest V3) beside the web product. Its popup, side panel or right-click item sends the page the person is on (its address and title, or text they selected) to the product's own actions and shows the answer. It can't read or change pages, reaches only the product's own link, and asks for at most activeTab, storage, contextMenus and sidePanel. People install it with Load unpacked in Chrome, Edge or Brave from the product's page. It isn't in any extension store.",
  ].join("\n"),
};
