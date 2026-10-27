import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {};

// Compiles "use workflow" and "use step" (lib/pipeline/workflow.ts, lib/pipeline/build-steps.ts). Workflows are found
// through the start() calls in app/api/inspirations, app/api/builds/[buildId]/messages and app/api/rebuilds.
export default withWorkflow(nextConfig);
