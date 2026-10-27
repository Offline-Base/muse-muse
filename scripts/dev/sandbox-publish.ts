/**
 * Publish test for lib/publish/vercel.ts.
 *   npx tsx --env-file=.env.local scripts/dev/sandbox-publish.ts <snapshotId | product sandbox name>
 *
 * Always tests the file collection against a real sandbox: either an existing product sandbox, or a throwaway one
 * created from a builder snapshot (deleted afterwards). When VERCEL_TOKEN is set it also runs the real thing:
 * creates or reuses the project musemuse-publish-test, sets env vars, deploys, and polls until READY or ERROR.
 */
import { Sandbox } from "@vercel/sandbox";
import { collectDeployFiles, pollDeploy, startDeployFromSandbox } from "@/lib/publish/vercel";

const arg = process.argv[2];
if (!arg) throw new Error("usage: sandbox-publish.ts <snapshotId | sandbox name>");

const t0 = Date.now();
const s = (t = t0) => `${((Date.now() - t) / 1000).toFixed(1)} s`;

let sandboxName = arg;
let throwaway: Sandbox | null = null;
if (arg.startsWith("snap_")) {
  throwaway = await Sandbox.create({
    name: `product-publish-test-${Date.now().toString(36)}`,
    source: { type: "snapshot", snapshotId: arg },
    persistent: false,
    resources: { vcpus: 2 },
    timeout: 10 * 60_000,
    tags: { app: "musemuse", role: "publish-test" },
  });
  sandboxName = throwaway.name;
  console.log(`created ${sandboxName} from ${arg} in ${s()}`);
}

try {
  let t = Date.now();
  const { files, skipped } = await collectDeployFiles(sandboxName);
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const leaked = files.filter((f) => /(^|\/)(node_modules|\.next|test-results|playwright-report|inspo|\.git)\//.test(f.file) || /(^|\/)\.env/.test(f.file));
  console.log(`collectDeployFiles: ${files.length} files, ${bytes} bytes, ${skipped.length} skipped, ${leaked.length} excluded paths leaked, ${s(t)}`);
  console.log(files.map((f) => `  ${f.sha.slice(0, 10)} ${String(f.size).padStart(7)} ${f.file}`).join("\n"));

  if (!process.env.VERCEL_TOKEN) {
    console.log("\nVERCEL_TOKEN is not set, so the deploy itself was skipped.");
  } else {
    t = Date.now();
    const started = await startDeployFromSandbox({
      sandboxName,
      slug: "publish-test",
      productName: "Publish test",
      env: { GATEWAY_URL: "https://example.invalid/api/gateway", PRODUCT_TOKEN: "mm_live_publish_test" },
    });
    console.log(`startDeployFromSandbox: ${JSON.stringify(started)} in ${s(t)}`);
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const p = await pollDeploy(started.deploymentId);
      console.log(`  ${s(t)} ${p.state} ${p.url}${p.errorMessage ? `\n${p.errorMessage}` : ""}`);
      if (p.state === "READY" || p.state === "ERROR" || p.state === "CANCELED") {
        if (p.state === "READY") {
          const res = await fetch(p.url);
          const html = await res.text();
          console.log(`  GET ${p.url} -> ${res.status}, footer present: ${html.includes("Built with Muse Muse")}`);
        }
        break;
      }
    }
  }
} finally {
  if (throwaway) {
    await throwaway.stop().catch(() => {});
    await throwaway.delete().catch((e) => console.warn("delete:", String(e)));
    console.log(`deleted ${sandboxName}`);
  }
}
