/**
 * Edge builds (docs/EDGE_DEMO.md): a brief with the edge target, while EDGE_ENABLED is on. Pure, so the workflow and its
 * tests share it. With the flag off nothing here is used: no extra file, no drill, no change to a verify summary.
 *
 * An edge build gets its Next config with output "standalone" (the board kit runs .next/standalone/server.js), and after
 * a verify that passed it runs the outage drill kit's four simulated drills (template/scripts/edge-drill.mjs) against a
 * second `next start` on loopback, with GATEWAY_URL at the blackhole and EDGE_URL at the fake edge server. Nothing in
 * the drill can reach Meta. Each drill becomes one of verify's steps, so a failed drill is a failed check in the build
 * room, the fix round and the product page's "What was checked".
 */
import { briefTargets } from "@/lib/native/targets";
import { env } from "@/lib/env";
import { EDGE_TEMPLATE_FILES } from "@/lib/edge/template-source";
import { freeProductPortsScript } from "@/lib/sandbox/tasks";
import { q } from "@/lib/sandbox/shell";
import type { VerifySummary } from "@/lib/types";
import { EDGE_DRILL_CAP_MS } from "@/lib/pipeline/steps";
import { EDGE_DRILL_STEP, EDGE_DRILLS } from "@/lib/edge/drills";

/** True for a brief with the edge target while EDGE_ENABLED is on. */
export function isEdgeBuild(brief: Parameters<typeof briefTargets>[0]): boolean {
  return env.edgeEnabled && briefTargets(brief).includes("edge");
}

// ---------- The Next config ----------

/** template/next.config.ts as the snapshot has it. A test holds the two the same. */
export const TEMPLATE_NEXT_CONFIG = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Products run behind their own Vercel deployment. Keep this file small so Muse Code rarely needs to touch it.
  // Sandbox previews open from *.vercel.run. Without this, next dev refuses its dev socket there and buttons stay dead.
  allowedDevOrigins: ["*.vercel.run"],
};

export default nextConfig;
`;

const STANDALONE = /output:\s*["']standalone["']/;

/**
 * A Next config with output "standalone" added after `NextConfig = {`, or the same text when it has it. Null when there
 * is no such line to add it after, so a caller can say so instead of guessing (scripts/edge/build-arm64.sh does the same).
 */
export function withStandaloneOutput(src: string): string | null {
  if (STANDALONE.test(src)) return src;
  const next = src.replace(/(NextConfig\s*=\s*\{)/, '$1\n  // An edge build: the board kit runs .next/standalone/server.js (docs/EDGE_DEMO.md).\n  output: "standalone",');
  return next === src ? null : next;
}

/** The files an edge build gets on top of edgeExtraFiles (the helper, the skill, the drill kit): its Next config. Empty for any other build. */
export function edgeBuildFiles(brief: Parameters<typeof briefTargets>[0]): Array<{ path: string; content: string }> {
  if (!isEdgeBuild(brief)) return [];
  const config = withStandaloneOutput(TEMPLATE_NEXT_CONFIG);
  return config ? [{ path: "next.config.ts", content: config }] : [];
}

// ---------- The drill ----------

/** The second server's port: in the product range, which verify has finished with by now. */
export const EDGE_DRILL_PORT = 3188;
/** Where the drill writes its results, from the product's root. */
export const EDGE_DRILL_OUT = "test-results/caps/edge-drill.json";
/** The longest the drill may take: the server's start, about 12 s for the hang drill and the other three. */
export { EDGE_DRILL_CAP_MS };
/** The drill's step names start with this, so the fix prompt and the product page show them as one group. */
export { EDGE_DRILL_STEP };

/** The drill kit's scripts. They are written fresh before each drill, so an edit in the build can't change what runs. */
export const EDGE_DRILL_KIT = EDGE_TEMPLATE_FILES.filter((f) => f.path.startsWith("scripts/edge-"));

/**
 * The drill's env. GATEWAY_URL, EDGE_URL and PRODUCT_TOKEN are set by edge-drill.mjs for the server it starts, and
 * process env wins over .env.local in Next, so the build's token and the real gateway are never used. The label names
 * say plainly that the board is simulated.
 */
export function edgeDrillEnv(): Record<string, string> {
  return {
    MUSEMUSE_BASE_URL: `http://127.0.0.1:${EDGE_DRILL_PORT}`,
    EDGE_DRILL_OUT,
    EDGE_BOARD: "a simulated board",
    EDGE_MODEL_NAME: "simulated model",
    EDGE_FIRST: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    FORCE_COLOR: "0",
  };
}

/**
 * The drill's bash, run in the product's root: free the product ports, clear the last results, run the four drills
 * against a second `next start` on loopback (exec, so stopping it stops the server), then free the ports again.
 */
export function edgeDrillScript(): string {
  const start = `exec ./node_modules/.bin/next start -p ${EDGE_DRILL_PORT} -H 127.0.0.1`;
  return [
    freeProductPortsScript(),
    `rm -f ${q(EDGE_DRILL_OUT)}`,
    `node scripts/edge-drill.mjs --start ${q(start)}`,
    "code=$?",
    freeProductPortsScript(),
    'exit "$code"',
  ].join("\n");
}

interface DrillResult {
  id: number;
  name: string;
  pass: boolean;
  ms?: number;
  why?: string | null;
}

/** The four drills, by id, so a drill missing from the results still shows as failed. */
const DRILLS = EDGE_DRILLS;

function readResults(json: string | null): DrillResult[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { results?: unknown };
    if (!Array.isArray(parsed.results)) return null;
    return parsed.results.filter((r): r is DrillResult => !!r && typeof r === "object" && typeof (r as DrillResult).id === "number" && typeof (r as DrillResult).pass === "boolean");
  } catch {
    return null;
  }
}

export interface EdgeDrillRun {
  exitCode: number | null;
  timedOut: boolean;
  /** The end of the drill's output, for a drill that wrote no results. */
  outputTail: string;
  /** edge-drill.json as the drill wrote it, or null. */
  json: string | null;
}

/**
 * The drill as verify steps. A drill passes only when its own result says so. A run that timed out or wrote nothing
 * fails all four, and so does one whose results all passed but that didn't exit 0, since then something else broke.
 */
export function edgeDrillSteps(run: EdgeDrillRun): { steps: VerifySummary["steps"]; failureOutput: string } {
  const results = readResults(run.json);
  const allPassed = !!results && DRILLS.every((d) => results.some((r) => r.id === d.id && r.pass));
  const why = run.timedOut
    ? `the drill didn't finish within ${Math.round(EDGE_DRILL_CAP_MS / 60_000)} minutes`
    : !results
      ? `the drill wrote no results (exit ${run.exitCode ?? "unknown"})`
      : allPassed && run.exitCode !== 0
        ? `the drill exited ${run.exitCode ?? "unknown"}`
        : null;
  const steps = DRILLS.map((d) => {
    const r = results?.find((x) => x.id === d.id);
    const ok = !why && r?.pass === true;
    const detail = why ?? (!r ? "this drill didn't run" : r.pass ? undefined : (r.why ?? "failed"));
    return { name: `${EDGE_DRILL_STEP} ${d.id}: ${d.name}`, ok, ...(r?.ms !== undefined ? { ms: r.ms } : {}), ...(detail ? { detail } : {}) };
  });
  const failed = steps.filter((s) => !s.ok);
  const tail = why && run.outputTail.trim() ? `\n${run.outputTail.trim().slice(-2000)}` : "";
  const failureOutput = failed.length
    ? `The simulated outage drills failed (scripts/edge-drill.mjs, with a blackhole gateway and a fake edge server):\n${failed.map((s) => `- ${s.name}: ${s.detail}`).join("\n")}${tail}`
    : "";
  return { steps, failureOutput };
}

/** A verify summary with the drill's steps added. A failed drill fails it. */
export function withEdgeDrill(summary: VerifySummary, run: EdgeDrillRun): VerifySummary {
  const drill = edgeDrillSteps(run);
  const passed = summary.passed && drill.steps.every((s) => s.ok);
  const failureOutput = [summary.failureOutput, drill.failureOutput].filter((t) => t.trim()).join("\n\n");
  return { ...summary, passed, steps: [...summary.steps, ...drill.steps], failureOutput };
}
