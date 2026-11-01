import type { CapCatalogEntry } from "@/lib/caps/catalog";
import { boardToolsUsable } from "@/lib/caps/hardware/flags";

/** The brief writer's catalog section for the hardware cap (docs/CAPABILITIES.md, section 19). */
export const HARDWARE_CATALOG: CapCatalogEntry = {
  name: "browser links to devices",
  get block() {
    return [
      "- hardware (browser links): the page talks to a device the visitor plugged in or paired, over Web Serial, WebUSB or Web Bluetooth. Browser links work in Chrome and Edge on a computer or Android, after a click. Not in Safari or on iPhone.",
      ...(boardToolsUsable() ? ["- hardware (board tools): the product's server reads a sensor on a board connected to Muse Muse, or shows up to 200 characters on it, 6 times a minute. Only after the board's owner links the board to the product, and only for that owner unless they open it to visitors. Boards do nothing else for a product, and never run commands."] : []),
    ].join("\n");
  },
};
