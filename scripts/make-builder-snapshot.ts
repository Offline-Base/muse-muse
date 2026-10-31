/**
 * Creates the warm builder snapshot every product sandbox starts from. Run it again whenever template/ changes:
 *
 *   npm run snapshot
 *
 * It boots `vercel/sandbox/universal` with open egress, installs ffmpeg, fonts, espeak-ng, Playwright's Chromium and
 * Muse Code, turns off the bundled Muse Code skills that fight a headless build (DISABLED_BUNDLED_SKILLS in
 * lib/sandbox/setup.ts), copies template/ to /vercel/app, runs npm ci, commits the template, keeps a root-owned
 * read-only copy of the platform-owned verify files in /vercel/musemuse/pristine (startTask restores them before
 * every verify and demo) and of template/targets in /vercel/musemuse/targets (the overlays a brief can ask for, with their
 * deps warmed in npm's cache), checks those copies against template/, that those skills are off and that `muse exec --help`
 * lists every flag a build passes, then snapshots with no expiry. The builder marker records the Muse Code version.
 * Builds start from the snapshot and run with the locked-down policy in lib/sandbox/policy.ts.
 * Save the printed id as BUILDER_SNAPSHOT_ID.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { execFlags, flagsMissingFromHelp, SANDBOX_ENV } from "@/lib/sandbox/muse";
import { PLATFORM_FILES, PRISTINE_DIR, TARGET_OVERLAYS, TARGETS_DIR, WORK_DIR } from "@/lib/sandbox/paths";
import { SNAPSHOT_POLICY } from "@/lib/sandbox/policy";
import { DISABLED_BUNDLED_SKILLS, readTargetFiles, readTemplateFiles, setupBuilder, skillsNotOff, type TemplateFile, templateHash } from "@/lib/sandbox/setup";
import { q, sh } from "@/lib/sandbox/shell";

const MIN = 60_000;

/** Throws unless every platform file in PRISTINE_DIR matches template/ and is root-owned with no write bits. */
async function checkPristine(sandbox: Sandbox, files: TemplateFile[]): Promise<void> {
  const want = PLATFORM_FILES.map((f) => {
    const file = files.find((t) => t.path === f);
    if (!file) throw new Error(`template/${f} is missing, but PLATFORM_FILES in lib/sandbox/paths.ts lists it.`);
    return `${createHash("sha1").update(file.content).digest("hex")}  ${f}`;
  });
  const list = PLATFORM_FILES.map(q).join(" ");
  const sums = await sh(sandbox, `cd ${q(PRISTINE_DIR)} && sha1sum ${list}`);
  const got = sums.stdout.trim().split("\n");
  if (got.join("\n") !== want.join("\n")) throw new Error(`Pristine copy doesn't match template/:\n${sums.stdout}`);
  const perms = await sh(sandbox, `cd ${q(PRISTINE_DIR)} && stat -c '%U %A %n' . ${list}`);
  const bad = perms.stdout
    .trim()
    .split("\n")
    .filter((l) => {
      const [owner, mode = "w"] = l.split(" ");
      return owner !== "root" || mode.includes("w");
    });
  if (bad.length) throw new Error(`Pristine copy is writable or not owned by root:\n${bad.join("\n")}`);
}

/** Throws unless TARGETS_DIR has every overlay, matches template/targets, and is root-owned with no write bits. */
async function checkTargets(sandbox: Sandbox, targets: TemplateFile[]): Promise<void> {
  const missing = TARGET_OVERLAYS.filter((t) => !targets.some((f) => f.path === `targets/${t}/deps.json`));
  if (missing.length) throw new Error(`template/targets has no overlay for ${missing.join(", ")}, but TARGET_OVERLAYS in lib/sandbox/paths.ts lists it.`);
  const want = targets.map((f) => `${createHash("sha1").update(f.content).digest("hex")}  ${f.path.slice("targets/".length)}`).sort();
  const sums = await sh(sandbox, `cd ${q(TARGETS_DIR)} && find . -type f -printf '%P\\0' | xargs -0 sha1sum`);
  const got = sums.stdout.trim().split("\n").sort();
  if (got.join("\n") !== want.join("\n")) throw new Error(`The targets copy doesn't match template/targets:\n${sums.stdout.slice(0, 2000)}`);
  const perms = await sh(sandbox, `cd ${q(TARGETS_DIR)} && find . -printf '%u %M %p\\n'`);
  const bad = perms.stdout.trim().split("\n").filter((l) => {
    const [owner, mode = "w"] = l.split(" ");
    return owner !== "root" || mode.includes("w");
  });
  if (bad.length) throw new Error(`The targets copy is writable or not owned by root:\n${bad.slice(0, 10).join("\n")}`);
}

/**
 * Throws unless `muse exec --help` lists every flag a build may pass (execFlags in lib/sandbox/muse.ts). A flag Muse
 * Code doesn't know exits 2, so a snapshot without one would fail every build. The runner still checks the optional
 * ones itself, for product sandboxes made from an older snapshot.
 */
async function checkExecFlags(sandbox: Sandbox, muse: string): Promise<void> {
  const help = await sh(sandbox, 'PATH="$HOME/.local/bin:$PATH" muse exec --help 2>&1', {
    cwd: WORK_DIR,
    env: { ...SANDBOX_ENV },
    allowFail: true,
  });
  const missing = flagsMissingFromHelp(help.stdout);
  if (missing.length) throw new Error(`muse exec --help (${muse}) doesn't list ${missing.join(", ")}:\n${help.stdout.slice(0, 3000)}`);
}

/**
 * Throws unless Muse Code lists every skill setupBuilder turned off as off. Settings are keyed by skill path, so a
 * Muse Code update that moves a skill would turn it back on without any error from `muse skills disable`.
 */
async function checkSkills(sandbox: Sandbox): Promise<void> {
  const list = await sh(sandbox, 'PATH="$HOME/.local/bin:$PATH" muse skills list --json', { cwd: WORK_DIR, env: { ...SANDBOX_ENV } });
  const notOff = skillsNotOff(list.stdout);
  if (notOff.length) throw new Error(`These bundled Muse Code skills are still on after muse skills disable: ${notOff.join(", ")}`);
}

async function main() {
  const started = Date.now();
  const timings: Array<{ step: string; ms: number; detail?: string }> = [];
  const log = (step: string, ms: number, detail?: string) => {
    timings.push({ step, ms, detail });
    console.log(`  ${(ms / 1000).toFixed(1).padStart(6)} s  ${step}${detail ? `  (${detail})` : ""}`);
  };

  const files = await readTemplateFiles(path.join(process.cwd(), "template"));
  const targets = await readTargetFiles(path.join(process.cwd(), "template"));
  console.log(`template: ${files.length} files, ${targets.length} in targets/, hash ${templateHash([...files, ...targets])}`);

  let t = Date.now();
  const sandbox = await Sandbox.create({
    name: `musemuse-builder-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`,
    persistent: false,
    resources: { vcpus: 4 },
    timeout: 30 * MIN,
    ports: [3000],
    networkPolicy: SNAPSHOT_POLICY,
    tags: { app: "musemuse", role: "builder-snapshot" },
  });
  log("create sandbox", Date.now() - t, sandbox.name);

  let snapshotId: string | null = null;
  try {
    const info = await setupBuilder(sandbox, files, log, targets);
    console.log("builder:", JSON.stringify(info));
    await checkPristine(sandbox, files);
    console.log(`pristine: ${PLATFORM_FILES.join(", ")} match template/`);
    await checkTargets(sandbox, targets);
    console.log(`targets: ${targets.length} files match template/targets`);
    await checkSkills(sandbox);
    console.log(`skills off: ${DISABLED_BUNDLED_SKILLS.join(", ")}`);
    await checkExecFlags(sandbox, info.muse);
    console.log(`muse exec --help (${info.muse}) lists ${execFlags().join(" ")}`);

    t = Date.now();
    const snapshot = await sandbox.snapshot({ expiration: 0 });
    snapshotId = snapshot.snapshotId;
    log("snapshot", Date.now() - t, `${snapshot.snapshotId}, ${Math.round(snapshot.sizeBytes / 1e6)} MB, ${snapshot.status}`);
  } finally {
    // Snapshotting stops the VM. Delete the builder sandbox either way; the snapshot outlives it.
    await sandbox.stop().catch(() => {});
    await sandbox.delete({ deleteOrphanSnapshots: false }).catch((err) => console.warn("delete builder sandbox:", String(err)));
  }

  console.log(`\nTotal ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log(`BUILDER_SNAPSHOT_ID=${snapshotId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
