import type { IconName } from "@/components/icons";
import type { ProductCardView } from "@/components/view-types";
import type { ProductGadgetTool } from "@/lib/gateway/gadget";

/**
 * What /gadgets says, as pure data and functions (docs/GADGETS.md). Only types come from the gateway, so the page never
 * loads the gateway or the simulated board's media.
 */

/** The gadget option's id in a brief's capabilities and a product's models: GADGET_ID in lib/gateway/gadget.ts. */
export const GADGET_OPTION = "muse-gadget";

/** The tools a product may call on a board, PRODUCT_GADGET_TOOLS in the gateway's order, as /gadgets explains them. */
export const GADGET_TOOLS: ReadonlyArray<{ name: ProductGadgetTool; icon: IconName; text: string }> = [
  { name: "describe_device", icon: "info", text: "Says which board it is and which cameras and microphones it has." },
  { name: "capture_image", icon: "camera", text: "Takes a photo with the board's camera." },
  { name: "record_audio", icon: "mic", text: "Records up to 30 seconds of sound with the board's microphone." },
];

/**
 * The boards Muse Muse has on hand (docs/PLATFORM_PLAN.md "The boards we have", docs/HANDOFF_HUSSAM.md "Hardware on
 * hand"), each with the owner's picture of the mascot holding it. Facts only, no addresses, names on the fleet or live
 * status: the page never contacts a board. The pictures are decorative; the board's name is in the text.
 */
export interface HouseBoard {
  key: "jetson" | "pi" | "coral";
  name: string;
  count: number;
  /** What the board does for Muse Muse, in two or three words. */
  role: string;
  text: string;
  /** Under public/, 564 by 640, white background, shown as given (no tile behind it, no cutout). */
  image: string;
}

export const HOUSE_BOARDS: readonly HouseBoard[] = [
  {
    key: "jetson",
    name: "Jetson Orin Nano 8 GB",
    count: 6,
    role: "Board server",
    text: "Runs muse-device, which gives a product the board's camera and microphone.",
    image: "/muse/muse-jetson.jpg",
  },
  {
    key: "pi",
    name: "Raspberry Pi 5",
    count: 2,
    role: "Planned gadget",
    text: "Meta lists the Pi 5 as a supported Muse gadget. One is planned as a real gadget on Meta's Linux Device SDK, paired to Muse Muse's own Muse account. Muse Muse never holds anyone else's gadget token.",
    image: "/muse/muse-pi.jpg",
  },
  {
    key: "coral",
    name: "Coral board",
    count: 2,
    role: "On-device vision",
    text: "A Synaptics Coralboard SL that runs vision on its own NPU, to compare its detectors with SAM 3.1 on the same pictures. It reaches the network only while plugged into a Mac.",
    image: "/muse/muse-coral.jpg",
  },
];

/** One status row on /gadgets: plain words only, never the board's address or key. */
export interface GadgetStatusRow {
  label: string;
  value: string;
  on: boolean;
  note: string;
}

/**
 * Whether new builds may pick the gadget option (env.gadgetsEnabled) and whether a live board is set up (deviceConfig()
 * isn't null). Set up isn't connected: the page never calls the board, so it can't say whether the board is online.
 */
export function gadgetStatusRows(s: { buildsOn: boolean; boardSetUp: boolean }): GadgetStatusRow[] {
  return [
    {
      label: "Gadgets for new builds",
      value: s.buildsOn ? "On" : "Off",
      on: s.buildsOn,
      note: s.buildsOn
        ? "The brief can add the gadget option when a muse asks for hardware."
        : "The brief doesn't offer the gadget option yet, so new builds don't use one.",
    },
    {
      label: "Live board",
      value: s.boardSetUp ? "Set up" : "Not set up",
      on: s.boardSetUp,
      note: s.boardSetUp
        ? "Live products with the option use the one board Muse Muse has set up. This page doesn't contact it, so it can't say whether the board is on right now."
        : "Live products with the option can't reach a board, so they say no gadget is connected.",
    },
  ];
}

/** Shipped products whose models include the gadget option. */
export function gadgetProducts(products: ProductCardView[]): ProductCardView[] {
  return products.filter((p) => p.models.includes(GADGET_OPTION));
}
