import type { Brief } from "@/lib/brief/schema";
import { hardwareBlock } from "@/lib/caps/hardware/brief";

/** The judge's note for device links and board tools (docs/CAPABILITIES.md, section 19). */
export function hardwareJudgeNote(brief: Brief): string {
  const block = hardwareBlock(brief);
  if (!block) return "";
  const said = "Device readings in this test come from a simulated device.";
  return block.driveExport ? `${said} Exporting a model to a drive must wait for a person to press confirm on a card that shows every line.` : said;
}
