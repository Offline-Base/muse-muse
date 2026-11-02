/**
 * Starts an edge build's outage drill in its sandbox, detached, the way lib/sandbox/builder.ts starts verify: a runner
 * script, a command record so pollTask and killCommand find its log by id. Only called for an edge build
 * (isEdgeBuild in lib/pipeline/edge-build.ts), so with EDGE_ENABLED off nothing here runs.
 *
 * It lives here rather than in builder.ts so the edge work stays in its own files. It uses only builder's public pieces:
 * the runner (lib/sandbox/shell.ts) and the run folder layout (lib/sandbox/paths.ts).
 */
import { Sandbox } from "@vercel/sandbox";
import { EDGE_DRILL_KIT, EDGE_DRILL_OUT, edgeDrillEnv, edgeDrillScript } from "@/lib/pipeline/edge-build";
import { LOG_DIR, PRODUCT_DIR, RUN_DIR } from "@/lib/sandbox/paths";
import { writeRunner } from "@/lib/sandbox/shell";

const TAG = "edge-drill";

/** Writes the drill kit fresh, then starts the drill. Returns the command id for pollTask. */
export async function startEdgeDrill(sandboxName: string): Promise<{ cmdId: string }> {
  const sandbox = await Sandbox.get({ name: sandboxName, resume: true });
  await sandbox.writeFiles(EDGE_DRILL_KIT.map((f) => ({ path: `${PRODUCT_DIR}/${f.path}`, content: Buffer.from(f.content) })));
  const logPath = `${LOG_DIR}/${TAG}.log`;
  const script = await writeRunner(sandbox, { name: TAG, cwd: PRODUCT_DIR, env: edgeDrillEnv(), argv: ["bash", "-c", edgeDrillScript()], stdoutPath: logPath });
  const cmd = await sandbox.runCommand({ cmd: "bash", args: [script], detached: true });
  await sandbox.writeFiles([
    { path: `${RUN_DIR}/${TAG}.cmd`, content: Buffer.from(cmd.cmdId) },
    { path: `${RUN_DIR}/by-id/${cmd.cmdId}`, content: Buffer.from(logPath) },
  ]);
  return { cmdId: cmd.cmdId };
}

/** Where the drill's results are in the sandbox. */
export const EDGE_DRILL_RESULTS = `${PRODUCT_DIR}/${EDGE_DRILL_OUT}`;
