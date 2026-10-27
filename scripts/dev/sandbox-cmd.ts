/**
 * Prints what the Sandbox API reports for a command, with and without wait=true. For debugging.
 *   npx tsx --env-file=.env.local scripts/dev/sandbox-cmd.ts <sandbox name> <cmdId>
 */
import { Sandbox } from "@vercel/sandbox";

const [name, cmdId] = process.argv.slice(2);
const sb = await Sandbox.get({ name, resume: true });
const cmd = await sb.getCommand(cmdId);
console.log(`getCommand: exitCode ${cmd.exitCode}`);
const t = Date.now();
try {
  const done = await cmd.wait({ signal: AbortSignal.timeout(5000) });
  console.log(`wait: exitCode ${done.exitCode} after ${Date.now() - t} ms`);
} catch (err) {
  console.log(`wait: ${String(err)} after ${Date.now() - t} ms`);
}
const again = await sb.getCommand(cmdId);
console.log(`getCommand after wait: exitCode ${again.exitCode}`);
