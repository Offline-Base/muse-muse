import { z } from "zod";
import { boardToolsOn } from "@/lib/caps/hardware/flags";

/**
 * The hardware cap's brief block (docs/CAPABILITIES.md, section 19):
 *   links       the browser talks to a device the visitor plugged in or paired: Web Serial, WebUSB or Web Bluetooth
 *   boardTools  the product's server reads a board's sensors or shows text on it, through the gateway's /gadget route
 */
export const HARDWARE_LINKS = ["serial", "usb", "bluetooth"] as const;
export type HardwareLink = (typeof HARDWARE_LINKS)[number];

export const HardwareBriefBlock = z.object({
  links: z.array(z.enum(HARDWARE_LINKS)).max(3),
  boardTools: z.boolean(),
  /** What the device does for this product, in one plain sentence. */
  why: z.string().min(1).max(200),
});

export type HardwareBrief = z.infer<typeof HardwareBriefBlock>;

/**
 * The brief's hardware block as this platform can serve it, or null. Board tools go when HARDWARE_BOARD_TOOLS is off, so
 * the prompt, the judge and the checks never ask for a tool the gateway refuses. A block left with nothing is null, and
 * capsForBuild drops the cap.
 */
export function hardwareBlock(brief: object | null | undefined, boardTools: boolean = boardToolsOn()): HardwareBrief | null {
  const parsed = HardwareBriefBlock.safeParse((brief as { hardware?: unknown } | null | undefined)?.hardware);
  if (!parsed.success) return null;
  const tools = parsed.data.boardTools && boardTools;
  return parsed.data.links.length || tools ? { ...parsed.data, boardTools: tools } : null;
}

const LINK_NAMES: Record<string, HardwareLink> = {
  serial: "serial",
  webserial: "serial",
  usb: "usb",
  webusb: "usb",
  bluetooth: "bluetooth",
  ble: "bluetooth",
  webbluetooth: "bluetooth",
};

/**
 * The writer's raw hardware block, cleaned before zod (normalizeRawBrief): links in their plain ids, each once, board tools
 * only while the flag is on, `why` clipped. A block that asks for nothing isn't a hardware block, so it becomes null.
 * Anything else is left for zod to report.
 */
export function normalizeHardwareBlock(raw: unknown, boardTools: boolean = boardToolsOn()): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const b = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(b.links)) {
    const named = b.links.map((l) => (typeof l === "string" ? LINK_NAMES[l.trim().toLowerCase().replace(/[\s_-]+/g, "")] : undefined));
    b.links = [...new Set(named.filter((l): l is HardwareLink => Boolean(l)))];
  }
  if (typeof b.boardTools === "string") b.boardTools = ["true", "yes", "1"].includes(b.boardTools.trim().toLowerCase());
  if (!boardTools) b.boardTools = false;
  if (typeof b.why === "string" && b.why.length > 200) b.why = b.why.slice(0, 200).replace(/\s+\S*$/, "").trim();
  const links = Array.isArray(b.links) ? b.links : null;
  return links && !links.length && b.boardTools === false ? null : b;
}

/** The block the writer answers in: no board tools while their flag is off. */
export function hardwareWriterBlock(boardTools: boolean = boardToolsOn()) {
  return boardTools ? HardwareBriefBlock : HardwareBriefBlock.extend({ boardTools: z.literal(false) });
}

/** The writer's rules for the block (lib/caps/brief-fields.ts, CAP_WRITER_RULES). */
export function hardwareWriterRules(boardTools: boolean = boardToolsOn()): string[] {
  return [
    `hardware: fill it only when the muse asks for a physical device${boardTools ? " or a board" : ""}: a thermometer, a scale, a microcontroller, a Bluetooth sensor. Otherwise null. A camera or microphone in the browser needs no hardware block.`,
    "hardware.links: serial for a device on a USB cable that shows up as a serial port (Arduino, most microcontrollers); usb only for a device with its own USB protocol; bluetooth for a Bluetooth Low Energy sensor. Pick as few as the muse needs. Say in limits that these work in Chrome and Edge on a computer or Android, after a click, and not in Safari or on iPhone.",
    boardTools
      ? "hardware.boardTools: true only when the product reads a sensor on a board connected to Muse Muse or shows a short message on it. The board's owner has to link it, so a product must still work with a clear message when no board is linked. Otherwise false."
      : "hardware.boardTools: always false.",
    "hardware.why: what the device does for this product, in one plain sentence.",
  ];
}
