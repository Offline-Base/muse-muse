/**
 * Compiles the build workflow with the Workflow SDK's own builder, without `next build` in the repo root.
 *
 *   npx tsx scripts/dev/pipeline-workflow-compile.ts [workDir]
 *
 * Copies lib/, catalog/ and tsconfig.json into workDir (default: $TMPDIR/musemuse-wfcheck), links node_modules, and
 * runs StandaloneBuilder there. That applies the same SWC transform and flow-bundle safety checks withWorkflow runs
 * in `next build`: the workflow bundle must not pull in Node modules, and every step must register. Prints the
 * workflow and step ids from the manifest.
 */
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StandaloneBuilder } from "@workflow/builders";

const repo = resolve(import.meta.dirname, "../..");
const work = resolve(process.argv[2] ?? join(tmpdir(), "musemuse-wfcheck"));

async function main() {
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  for (const dir of ["lib", "catalog"]) {
    await cp(join(repo, dir), join(work, dir), {
      recursive: true,
      filter: (src) => !src.includes("__tests__"),
    });
  }
  await cp(join(repo, "tsconfig.json"), join(work, "tsconfig.json"));
  await writeFile(join(work, "package.json"), JSON.stringify({ name: "wfcheck", private: true, type: "module" }));
  await symlink(join(repo, "node_modules"), join(work, "node_modules"), "dir");

  // The SWC plugin caches into ./.swc, so build from inside the copy to keep the repo clean.
  process.chdir(work);
  const builder = new StandaloneBuilder({
    dirs: ["."],
    workingDir: work,
    buildTarget: "standalone",
    stepsBundlePath: "./.well-known/workflow/v1/__step_registrations.mjs",
    workflowsBundlePath: "./.well-known/workflow/v1/flow.mjs",
    webhookBundlePath: "./.well-known/workflow/v1/webhook.mjs",
    workflowManifestPath: join(work, "workflow-manifest.json"),
  } as ConstructorParameters<typeof StandaloneBuilder>[0]);
  await builder.build();

  const outDir = join(work, ".well-known/workflow/v1");
  console.log("Built:", (await readdir(outDir)).join(", "));
  const manifestRaw = await readFile(join(work, "workflow-manifest.json"), "utf8").catch(() => null);
  if (manifestRaw) {
    const manifest = JSON.parse(manifestRaw) as Record<string, Record<string, Record<string, unknown>>>;
    for (const kind of ["workflows", "steps"]) {
      const ids = Object.entries(manifest[kind] ?? {}).flatMap(([file, fns]) =>
        Object.keys(fns).map((fn) => `${file}#${fn}`),
      );
      console.log(`${kind} (${ids.length}):\n  ${ids.join("\n  ")}`);
    }
  }
}

main().catch((err) => {
  console.error("Workflow compile failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
