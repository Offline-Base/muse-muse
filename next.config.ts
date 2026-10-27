import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

// PGlite (local runs only, lib/db/client.ts) loads its WebAssembly from node_modules, so it must not be bundled.
const nextConfig: NextConfig = { serverExternalPackages: ["@electric-sql/pglite"] };

// Compiles "use workflow" and "use step" (lib/pipeline/workflow.ts, lib/pipeline/build-steps.ts). Workflows are found
// through the start() calls in app/api/inspirations, app/api/builds/[buildId]/messages and app/api/rebuilds.
export default withWorkflow(nextConfig);
