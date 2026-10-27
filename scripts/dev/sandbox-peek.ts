/**
 * Runs one bash command in a product sandbox and prints the result. For debugging.
 *   npx tsx --env-file=.env.local scripts/dev/sandbox-peek.ts <sandbox name> '<bash>'
 */
import { Sandbox } from "@vercel/sandbox";
import { sh } from "@/lib/sandbox/shell";

const [name, script] = process.argv.slice(2);
if (!name || !script) throw new Error("usage: sandbox-peek.ts <sandbox name> '<bash>'");
const sb = await Sandbox.get({ name, resume: true });
const r = await sh(sb, script, { allowFail: true, cwd: "/vercel/app" });
console.log(`exit ${r.exitCode}\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`);
