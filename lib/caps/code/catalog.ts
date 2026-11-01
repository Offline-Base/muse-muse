import type { CapCatalogEntry } from "@/lib/caps/catalog";
import { codePartsOn, type CodeParts } from "@/lib/caps/code/parts";

/** The code cap's catalog text, naming only the parts that are on (lib/caps/code/parts.ts). */
export function codeCatalogBlock(parts: CodeParts = codePartsOn()): string {
  const sentences = ["- code (running code): a product may run code a person writes or pastes. Python (Pyodide, standard library only) and JavaScript (QuickJS) run in the visitor's browser for anyone, at no cost."];
  if (parts.exec) {
    sentences.push(
      `Python or Node on a platform sandbox with no network, at most 15 seconds and 64 KB of output, is ${parts.visitors ? "for anyone using the product, a few runs a day each" : "for the product's owner only"}.`,
    );
  }
  if (parts.browse) sentences.push(`Opening a web page the person typed, one site and no logging in, is for the owner only${parts.exec && !parts.visitors ? " too" : ""}.`);
  sentences.push("Code never reaches a model or another service.");
  return sentences.join(" ");
}

/** The brief writer's catalog section for the code cap (docs/CAPABILITIES.md, section 15). */
export const CODE_CATALOG: CapCatalogEntry = {
  name: "running code",
  // Read per call, since it follows CODE_EXEC, CODE_BROWSE and CODE_EXEC_VISITORS.
  get block() {
    return codeCatalogBlock();
  },
};
