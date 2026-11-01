import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";
import { trustGeoRewrites } from "./lib/trust/geo-config";

// PGlite (local runs only, lib/db/client.ts) loads its WebAssembly from node_modules, so it must not be bundled. The
// Composio SDK (lib/tools/composio/client.ts) stays out too: it is imported lazily, only when a live tool runs.
// The dev indicator is off because it sits on top of the sidebar's account chip.
// The docs pages, the docs Ask route and the build MCP read Meta's mirrored Markdown from disk at request time
// (docsMarkdown in lib/docs/pages.ts builds the path from the slug, which file tracing can't follow), so the pages are
// traced in by hand. Keys are route globs: "/docs/**" covers /docs/[...slug] and the docs routes under it.
const DOCS_MARKDOWN = ["./content/meta-docs/pages/**/*.md"];

// Wave 3, unit 1 (TRUST_GEO_BLOCK, docs/CAPABILITIES.md, section 7): requests from restricted territories get a 451 page.
// No rules at all with the flag off, so the config is what it was.
const GEO_REWRITES = trustGeoRewrites(process.env);

const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite", "@composio/core"],
  devIndicators: false,
  // Muse Privacy's files never ship with the site. .vercelignore keeps them out on Vercel; this keeps them out of any other
  // build, since a few routes' createReadStream calls make the tracer take in the whole project.
  outputFileTracingExcludes: { "/**": ["./privacy/**/*"] },
  outputFileTracingIncludes: {
    "/docs/**": DOCS_MARKDOWN,
    "/api/docs/ask": DOCS_MARKDOWN,
    "/api/build-mcp": DOCS_MARKDOWN,
    // Drive export builds a drive's pages from drive/ and the kit's list at request time (docs/DRIVE_EXPORT.md).
    "/api/device/drive": ["./drive/**/*", "./lib/drive/kit-files.json"],
    "/api/gateway/gadget": ["./drive/**/*", "./lib/drive/kit-files.json"],
  },
  ...(GEO_REWRITES.length ? { rewrites: async () => ({ beforeFiles: GEO_REWRITES, afterFiles: [], fallback: [] }) } : {}),
};

// Compiles "use workflow" and "use step" (lib/pipeline/workflow.ts, lib/pipeline/build-steps.ts, lib/pipeline/prove.ts,
// lib/pipeline/prove-steps.ts, lib/pipeline/prove-start.ts, lib/promote/workflow.ts,
// lib/promote/steps.ts, lib/board-loop/workflow.ts, lib/board-loop/steps.ts, lib/train/workflow.ts, lib/train/steps.ts, lib/train/judge.ts, lib/train/hub-steps.ts, and
// lib/train/datasets.ts, which holds both). Workflows are found through the start() calls in app/api/inspirations,
// app/api/builds/[buildId]/messages, app/api/rebuilds, app/api/admin/import-product, app/api/train/jobs,
// app/api/train/jobs/[id]/publish, app/api/train/datasets and app/api/cron/prove-nightly.
export default withWorkflow(nextConfig);
