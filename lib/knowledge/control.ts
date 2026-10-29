import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Pause and resume for the knowledge scripts. A run stops taking new work when the PAUSE file exists or on Ctrl+C,
 * finishes what's in flight, writes everything it has and exits. Every stage caches its work, so running the same
 * command again carries on from there.
 *
 *   npm run knowledge:pause    (or Ctrl+C in the running terminal)
 *   npm run knowledge:resume   (removes the PAUSE file; then rerun the stage's command)
 *   npm run knowledge:status
 */

export const KNOWLEDGE_DIR = path.join(process.cwd(), ".data/knowledge");
export const PAUSE_FILE = path.join(KNOWLEDGE_DIR, "PAUSE");

let interrupted = false;
let hooked = false;

/** Ctrl+C asks for a clean stop once; a second Ctrl+C quits at once. */
export function stopOnInterrupt(): void {
  if (hooked) return;
  hooked = true;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log("\nPausing: finishing the requests in flight and saving. Ctrl+C again to quit now.");
  });
}

/** True once a pause was asked for, by the PAUSE file or Ctrl+C. */
export function pauseRequested(): boolean {
  return interrupted || existsSync(PAUSE_FILE);
}

export async function requestPause(): Promise<void> {
  await writeFile(PAUSE_FILE, `${new Date().toISOString()}\n`);
}

export async function clearPause(): Promise<void> {
  await rm(PAUSE_FILE, { force: true });
}
