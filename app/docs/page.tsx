import { redirect } from "next/navigation";
import { DOCS_HOME } from "@/lib/docs/pages";

/** /docs opens the overview, like dev.meta.ai/docs. */
export default function DocsIndex(): never {
  redirect(DOCS_HOME);
}
