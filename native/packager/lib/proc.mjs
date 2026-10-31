// Tools run from argv arrays only, so nothing in a job can become a command. The lab's runner does the same.
import { run } from "../../lab/lib/proc.mjs";

export { run };

/** Runs a tool and throws with the end of its output when it fails. */
export async function runOrThrow(argv, opts = {}) {
  const result = await run(argv, { timeoutMs: 5 * 60_000, ...opts });
  if (result.code !== 0 || result.timedOut) {
    const reason = result.timedOut ? "timed out" : result.spawnError ?? `exit ${result.code}`;
    throw new Error(`${argv[0].split("/").pop()} ${argv[1] ?? ""}: ${reason}. ${String(result.stderr).slice(-800)}`);
  }
  return result;
}
