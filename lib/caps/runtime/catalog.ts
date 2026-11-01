import type { CapCatalogEntry } from "@/lib/caps/catalog";

/** The brief writer's catalog section for the runtime cap (docs/CAPABILITIES.md, section 16). */
export const RUNTIME_CATALOG: CapCatalogEntry = {
  name: "small Python functions",
  block: [
    "- runtime (Python functions): an action may run a small Python function on the product's server, for work Python's libraries do best: numbers and tables (numpy, pandas), statistics and curve fitting (scipy), symbolic math (sympy), image processing (pillow). JSON in and JSON out, at most 4 functions, an answer within 10 seconds, packages from PyPI only. Python never calls a model or another service: the product's TypeScript does that and passes the results in. No web frameworks, no files kept between calls, and nothing that runs in the background.",
  ].join("\n"),
};
