import type { Brief } from "@/lib/brief/schema";
import { filesBlock } from "@/lib/caps/files/brief";

/** The judge's note for a product that keeps files or searches them (docs/CAPABILITIES.md, section 10). */
export function filesJudgeNote(brief: Brief): string {
  const block = filesBlock(brief);
  if (!block) return "";
  const sources = block.search || block.datasets.length > 0;
  return [
    "This product keeps files. The screenshot captioned 'After a reload' shows the uploaded file still listed.",
    sources
      ? "Answers built from the person's files or a dataset show where they came from. Fail it when an answer that says it comes from a file or a dataset shows no source, or a dataset is shown without its license."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}
