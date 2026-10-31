import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

// PGlite (local runs only, lib/db/client.ts) loads its WebAssembly from node_modules, so it must not be bundled. The
// Composio SDK (lib/tools/composio/client.ts) stays out too: it is imported lazily, only when a live tool runs.
// The dev indicator is off because it sits on top of the sidebar's account chip.
// The docs pages, the docs Ask route and the build MCP read Meta's mirrored Markdown from disk at request time
// (docsMarkdown in lib/docs/pages.ts builds the path from the slug, which file tracing can't follow), so the pages are
// traced in by hand. Keys are route globs: "/docs/**" covers /docs/[...slug] and the docs routes under it.
const DOCS_MARKDOWN = ["./content/meta-docs/pages/**/*.md"];

const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite", "@composio/core"],
  devIndicators: false,
  outputFileTracingIncludes: {
    "/docs/**": DOCS_MARKDOWN,
    "/api/docs/ask": DOCS_MARKDOWN,
    "/api/build-mcp": DOCS_MARKDOWN,
  },
};

// Compiles "use workflow" and "use step" (lib/pipeline/workflow.ts, lib/pipeline/build-steps.ts, lib/promote/workflow.ts,
// lib/promote/steps.ts, lib/train/workflow.ts, lib/train/steps.ts, lib/train/judge.ts, lib/train/hub-steps.ts, and
// lib/train/datasets.ts, which holds both). Workflows are found through the start() calls in app/api/inspirations,
// app/api/builds/[buildId]/messages, app/api/rebuilds, app/api/admin/import-product, app/api/train/jobs,
// app/api/train/jobs/[id]/publish and app/api/train/datasets.
export default withWorkflow(nextConfig);
