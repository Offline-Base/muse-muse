/**
 * Everything the brief writer and Muse Code are given that a target could change, as text, for flags-off.test.ts (not a
 * test file). Each entry is a file in golden/, written from the code as it stood before targets existed.
 */
import { NewBriefSchema, NewBriefSchemaNoGadget } from "@/lib/brief/schema";
import { renderBuildPrompt, renderFixPrompt, renderRefinePrompt, briefToMarkdown } from "@/lib/brief/render";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { briefInstructions, briefRequestText, changeCheckInstructions } from "@/lib/prompts/brief";
import { catalogSummary } from "@/lib/prompts/catalog";
import { JUDGE_INSTRUCTIONS } from "@/lib/prompts/judge";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** What each is today, for one sample brief, with whatever GADGETS_ENABLED says when it is called. */
export function flagsOffSurface(): Record<string, string> {
  const render = { inspoFiles: ["feeder.jpg"], fixtures: [{ fileName: "feeder.jpg", description: "The person's feeder photo", fromUserSample: true }], maxModelSteps: 40 };
  return {
    "new-brief.schema.json": json(strictJsonSchema(NewBriefSchema)),
    "new-brief-no-gadget.schema.json": json(strictJsonSchema(NewBriefSchemaNoGadget)),
    "brief-instructions.txt": briefInstructions(),
    "brief-request.txt": briefRequestText("Count the birds at my feeder.", []),
    "change-check-instructions.txt": changeCheckInstructions(),
    "catalog-summary.txt": catalogSummary(),
    "judge-instructions.txt": JUDGE_INSTRUCTIONS,
    "build-prompt.txt": renderBuildPrompt(BRIEF, render),
    "fix-prompt.txt": renderFixPrompt({ verify: null, judge: { pass: false, reasons: ["The count is missing."], mismatches: [] }, round: 1 }),
    "refine-prompt.txt": renderRefinePrompt({ message: "Add a dark theme.", newReferences: [] }),
    "brief.md": briefToMarkdown(BRIEF),
  };
}
