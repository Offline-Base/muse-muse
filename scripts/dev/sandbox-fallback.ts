/**
 * Tests provisionSandbox without BUILDER_SNAPSHOT_ID: the slow path that installs everything in a fresh VM.
 *   npx tsx --env-file=.env.local scripts/dev/sandbox-fallback.ts
 * Deletes the sandbox afterwards.
 */
import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { provisionSandbox } from "@/lib/sandbox/builder";
import { sh } from "@/lib/sandbox/shell";

delete process.env.BUILDER_SNAPSHOT_ID;
const slug = `fallback-${Date.now().toString(36)}`;
const t0 = Date.now();
try {
  const { sandboxName } = await provisionSandbox({
    buildId: randomUUID(),
    productId: randomUUID(),
    slug,
    references: [],
    fixtures: [],
    promptMarkdown: "# Brief\n\nFallback test.\n",
    buildToken: "mm_build_test",
    gatewayUrl: "https://example.invalid/api/gateway",
  });
  console.log(`provisionSandbox without a snapshot: ${((Date.now() - t0) / 1000).toFixed(1)} s (${sandboxName})`);
  const sb = await Sandbox.get({ name: sandboxName, resume: true });
  const r = await sh(
    sb,
    [
      "cat /vercel/musemuse/builder.json",
      'echo "node_modules: $(ls /vercel/app/node_modules | wc -l)"',
      'echo "chromium: $(ls $HOME/.cache/ms-playwright | tr "\\n" " ")"',
      'echo "example.com: $(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://example.com/ || echo blocked)"',
      'echo "api.meta.ai: $(curl -s -o /dev/null -w "%{http_code}" --max-time 15 -H "Authorization: Bearer brokered" https://api.meta.ai/v1/models)"',
    ].join("; "),
    { allowFail: true },
  );
  console.log(r.stdout);
} finally {
  try {
    const sb = await Sandbox.get({ name: `product-${slug}` });
    await sb.delete({ deleteOrphanSnapshots: true });
    console.log(`deleted product-${slug}`);
  } catch (err) {
    console.log(`cleanup: ${String(err)}`);
  }
}
