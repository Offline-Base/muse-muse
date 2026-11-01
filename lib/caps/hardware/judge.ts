import type { Brief } from "@/lib/brief/schema";
import { hardwareBlock } from "@/lib/caps/hardware/brief";

/** The judge's note for device links and board tools (docs/CAPABILITIES.md, section 19). */
export function hardwareJudgeNote(brief: Brief): string {
  return hardwareBlock(brief) ? "Device readings in this test come from a simulated device." : "";
}
