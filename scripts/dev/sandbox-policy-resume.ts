/**
 * Checks that the locked egress policy is saved on the sandbox (a plain resume after hibernate is still locked,
 * without reopenSandbox re-applying it), and that extendTimeout works on this plan.
 *   npx tsx --env-file=.env.local scripts/dev/sandbox-policy-resume.ts <snapshotId>
 */
import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { hibernate, provisionSandbox } from "@/lib/sandbox/builder";
import { sh } from "@/lib/sandbox/shell";

const snapshotId = process.argv[2];
if (!snapshotId?.startsWith("snap_")) throw new Error("usage: sandbox-policy-resume.ts <snapshotId>");
process.env.BUILDER_SNAPSHOT_ID = snapshotId;

const probe = [
  'echo "  example.com: $(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://example.com/ || echo blocked)"',
  'echo "  api.meta.ai: $(curl -s -o /dev/null -w "%{http_code}" --max-time 15 -H "Authorization: Bearer brokered" https://api.meta.ai/v1/models)"',
].join("; ");

const { sandboxName } = await provisionSandbox({
  buildId: randomUUID(),
  productId: randomUUID(),
  slug: `policy-${Date.now().toString(36)}`,
  references: [],
  fixtures: [],
  promptMarkdown: "# Brief\n",
  buildToken: "mm_build_test",
  gatewayUrl: "https://example.invalid/api/gateway",
});
try {
  let sb = await Sandbox.get({ name: sandboxName, resume: true });
  const before = sb.expiresAt?.getTime() ?? 0;
  await sb.extendTimeout(5 * 60_000);
  sb = await Sandbox.get({ name: sandboxName, resume: true });
  console.log(`timeout ${sb.timeout} ms; extendTimeout(5 min) moved expiresAt by ${Math.round(((sb.expiresAt?.getTime() ?? 0) - before) / 1000)} s`);
  console.log(`saved policy on the sandbox: ${JSON.stringify(sb.networkPolicy, (k, v) => (k.toLowerCase() === "authorization" ? "<redacted>" : v))}`);

  await hibernate(sandboxName);
  sb = await Sandbox.get({ name: sandboxName, resume: true });
  console.log("after hibernate and a plain resume (no reopenSandbox):");
  console.log((await sh(sb, probe, { allowFail: true })).stdout.trimEnd());
} finally {
  const sb = await Sandbox.get({ name: sandboxName });
  await sb.delete({ deleteOrphanSnapshots: true });
  console.log(`deleted ${sandboxName}`);
}
