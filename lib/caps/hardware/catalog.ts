import type { CapCatalogEntry } from "@/lib/caps/catalog";
import { boardToolsUsable, driveToolsUsable, gadgetConnectUsable } from "@/lib/caps/hardware/flags";

/** The brief writer's catalog section for the hardware cap (docs/CAPABILITIES.md, section 19). */
export const HARDWARE_CATALOG: CapCatalogEntry = {
  name: "browser links to devices",
  get block() {
    return [
      "- hardware (browser links): the page talks to a device the visitor plugged in or paired, over Web Serial, WebUSB or Web Bluetooth. Browser links work in Chrome and Edge on a computer or Android, after a click. Not in Safari or on iPhone.",
      ...(boardToolsUsable() ? ["- hardware (board tools): the product's server reads a sensor on a board connected to Muse Muse, or shows up to 200 characters on it, 6 times a minute. Only after the board's owner links the board to the product, and only for that owner unless they open it to visitors. Boards do nothing else for a product, and never run commands."] : []),
      ...(gadgetConnectUsable() ? ["- hardware (board tools) also gives a product the model running on its owner's own paired board, and, only if the muse asks for a robot, a simulated board's sensors and a few allow-listed actions (fan, pump, light) with a hard stop, each action confirmed by the owner. Set boardTools. The product must still work when the board is off, with a clear message."] : []),
      ...(driveToolsUsable() ? ["- hardware (drive export): the product's owner puts the product's own fine-tuned model on a USB drive plugged into their own board. The owner confirms each export on a card. Never for visitors, and it never erases a drive."] : []),
    ].join("\n");
  },
};
