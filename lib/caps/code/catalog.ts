import type { CapCatalogEntry } from "@/lib/caps/catalog";

/** The brief writer's catalog section for the code cap (docs/CAPABILITIES.md, section 15). */
export const CODE_CATALOG: CapCatalogEntry = {
  name: "running code",
  block: [
    "- code (running code): a product may run code a person writes or pastes. Python (Pyodide, standard library only) and JavaScript (QuickJS) run in the visitor's browser for anyone, at no cost. Python or Node on a platform sandbox with no network, at most 15 seconds and 64 KB of output, is for the product's owner only. Opening a web page the person typed, one site and no logging in, is for the owner only too. Code never reaches a model or another service.",
  ].join("\n"),
};
