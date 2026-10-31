/**
 * Resumes a trial product's sandbox and starts its preview, then prints the URL; or stops the sandbox.
 *   npx tsx docs/spikes/ui-brand-2026-10-31/preview.ts <sandbox name> [stop]
 */
import { Sandbox } from "@vercel/sandbox";
import { startPreview } from "@/lib/sandbox/builder";

const [name, action] = process.argv.slice(2);
if (!name) throw new Error("usage: preview.ts <sandbox name> [stop]");
if (action === "stop") {
  const sb = await Sandbox.get({ name });
  await sb.stop();
  console.log(`stopped ${name}`);
} else {
  const { url } = await startPreview(name);
  console.log(`PREVIEW_URL=${url}`);
}
