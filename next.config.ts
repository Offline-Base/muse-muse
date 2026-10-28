import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

// PGlite (local runs only, lib/db/client.ts) loads its WebAssembly from node_modules, so it must not be bundled.
// The dev indicator is off because it sits on top of the sidebar's account chip.
const nextConfig: NextConfig = { serverExternalPackages: ["@electric-sql/pglite"], devIndicators: false };

// Compiles "use workflow" and "use step" (lib/pipeline/workflow.ts, lib/pipeline/build-steps.ts, lib/train/workflow.ts,
// lib/train/steps.ts, lib/train/judge.ts, and lib/train/datasets.ts, which holds both). Workflows are found through the
// start() calls in app/api/inspirations, app/api/builds/[buildId]/messages, app/api/rebuilds, app/api/train/jobs and
// app/api/train/datasets.
export default withWorkflow(nextConfig);
