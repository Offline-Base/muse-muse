/**
 * Creates the snapshot every packager sandbox starts from (docs/NATIVE_PACKAGER.md). Rerun it after release-shells.ts:
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/native/make-packager-snapshot.ts
 *
 * It installs Java, Debian's Apache-licensed apktool companions (dexdump, apksigner, aapt2), rcodesign and the Inter font,
 * copies native/packager with its node_modules, bakes in the templates lib/native/shells.json names, checks each tool
 * answers, and snapshots with no expiry. No Android SDK download and no SDK license: everything comes from Ubuntu's archive,
 * npm and rcodesign's GitHub release. There are no credentials in it. Save the printed id as PACKAGER_SNAPSHOT_ID.
 *
 * Templates come from native/shell-desktop/dist when they're there, since the Blob copy may not exist yet.
 *   --keep <name>   leaves the sandbox running under that name and makes no snapshot, for a spike.
 *   --from <id>     starts from an earlier snapshot and only replaces the packager's code, for a change that touches nothing
 *                   else. It takes seconds, where baking the templates from a laptop takes about 10 minutes.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { currentShells, SHELL_TEMPLATE_FILES, SHELL_TEMPLATE_KINDS, type ShellTemplateKind } from "@/lib/native/shells";
import { PACKAGER_DIR, PACKAGER_SHELLS_DIR, sandboxCredentials } from "@/lib/native/packager";
import { SNAPSHOT_POLICY } from "@/lib/sandbox/policy";
import { q, sh } from "@/lib/sandbox/shell";

const MIN = 60_000;
const RCODESIGN_VERSION = "0.29.0";
/** Of apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz, as first downloaded on Oct 31. */
const RCODESIGN_SHA256 = "dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002";
const APT = ["default-jre-headless", "dexdump", "apksigner", "aapt", "zipalign", "fonts-inter", "zip", "unzip"];
const CHUNK_BYTES = 48 * 1024 * 1024;

const ROOT = process.cwd();
const DIST = path.join(ROOT, "native", "shell-desktop", "dist");

/** What the sandbox needs from the repo, keeping native/'s layout so package.mjs can reach the lab's upload code. */
async function repoFiles(): Promise<Array<{ path: string; content: Buffer; mode?: number }>> {
  const files: Array<{ path: string; content: Buffer; mode?: number }> = [];
  const add = async (rel: string) => files.push({ path: `${PACKAGER_DIR}/${rel}`, content: await readFile(path.join(ROOT, "native", rel)) });
  for (const f of ["package.json", "package-lock.json", "package.mjs"]) await add(`packager/${f}`);
  for (const f of await readdir(path.join(ROOT, "native", "packager", "lib"))) await add(`packager/lib/${f}`);
  for (const f of ["blob.mjs", "proc.mjs"]) await add(`lab/lib/${f}`);
  return files;
}

/** Sends a file over the sandbox API in pieces, since one request can't carry 200 MB. */
async function sendLargeFile(sandbox: Sandbox, local: string, remote: string): Promise<void> {
  const { size } = await stat(local);
  const file = await open(local, "r");
  try {
    await sh(sandbox, `mkdir -p ${q(path.dirname(remote))} && : > ${q(remote)}`);
    for (let offset = 0, part = 0; offset < size; offset += CHUNK_BYTES, part++) {
      const length = Math.min(CHUNK_BYTES, size - offset);
      const chunk = Buffer.alloc(length);
      await file.read(chunk, 0, length, offset);
      const piece = `${remote}.part${part}`;
      await sandbox.writeFiles([{ path: piece, content: chunk }]);
      await sh(sandbox, `cat ${q(piece)} >> ${q(remote)} && rm ${q(piece)}`);
    }
  } finally {
    await file.close();
  }
}

/** Where this machine has the template, if it does. */
async function localTemplate(kind: ShellTemplateKind): Promise<string | null> {
  if (!existsSync(DIST)) return null;
  const names = await readdir(DIST);
  const name = kind === "android" ? "android-template.apk" : kind === "windows" ? "windows-template.zip" : names.find((f) => f.endsWith("-universal-mac.zip"));
  return name && names.includes(name) ? path.join(DIST, name) : null;
}

async function bakeTemplates(sandbox: Sandbox, log: (step: string, ms: number, detail?: string) => void): Promise<void> {
  const release = currentShells();
  for (const kind of SHELL_TEMPLATE_KINDS) {
    const template = release.templates[kind];
    if (!template) {
      console.warn(`  no ${kind} template in lib/native/shells.json`);
      continue;
    }
    const t = Date.now();
    const remote = `${PACKAGER_SHELLS_DIR}/${release.shellVersion}/${SHELL_TEMPLATE_FILES[kind]}`;
    const local = await localTemplate(kind);
    const localSha = local ? createHash("sha256").update(await readFile(local)).digest("hex") : null;
    if (local && localSha === template.sha256) await sendLargeFile(sandbox, local, remote);
    else if (template.url) await sh(sandbox, `mkdir -p ${q(path.dirname(remote))} && curl -fsSL -o ${q(remote)} ${q(template.url)}`, { timeoutMs: 10 * MIN });
    else throw new Error(`The ${kind} template isn't on this machine and has no link. Run release-shells.ts first.`);
    const sum = await sh(sandbox, `sha256sum ${q(remote)} | cut -d' ' -f1 | tee ${q(`${remote}.sha256`)}`);
    if (sum.stdout.trim() !== template.sha256) throw new Error(`The ${kind} template's checksum doesn't match in the sandbox.`);
    log(`bake ${kind}`, Date.now() - t, `${Math.round(template.bytes / 1e6)} MB`);
  }
}

async function main() {
  const keepAt = process.argv.indexOf("--keep");
  const keepName = keepAt >= 0 ? process.argv[keepAt + 1] : null;
  const fromAt = process.argv.indexOf("--from");
  const fromSnapshot = fromAt >= 0 ? process.argv[fromAt + 1] : null;
  const started = Date.now();
  const log = (step: string, ms: number, detail?: string) => console.log(`  ${(ms / 1000).toFixed(1).padStart(6)} s  ${step}${detail ? `  (${detail})` : ""}`);

  let t = Date.now();
  const options = {
    ...sandboxCredentials(),
    name: keepName ?? `musemuse-packager-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`,
    persistent: false,
    resources: { vcpus: 4 },
    timeout: 30 * MIN,
    networkPolicy: SNAPSHOT_POLICY,
    tags: { app: "musemuse", role: "packager-snapshot" },
  };
  const sandbox = await (fromSnapshot ? Sandbox.create({ ...options, source: { type: "snapshot", snapshotId: fromSnapshot } }) : Sandbox.create(options));
  log("create sandbox", Date.now() - t, sandbox.name);

  try {
    t = Date.now();
    if (!fromSnapshot) {
      await sh(sandbox, "apt-get update -qq", { sudo: true, env: { DEBIAN_FRONTEND: "noninteractive" }, timeoutMs: 5 * MIN });
      await sh(sandbox, `apt-get install -y -qq --no-install-recommends ${APT.join(" ")}`, { sudo: true, env: { DEBIAN_FRONTEND: "noninteractive" }, timeoutMs: 10 * MIN });
      log("apt", Date.now() - t, APT.join(" "));

      t = Date.now();
      const tarball = `apple-codesign-${RCODESIGN_VERSION}-x86_64-unknown-linux-musl`;
      const check = `echo ${q(`${RCODESIGN_SHA256}  /tmp/rcodesign.tgz`)} | sha256sum -c -`;
      const rcode = await sh(
        sandbox,
        `curl -fsSL -o /tmp/rcodesign.tgz https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${RCODESIGN_VERSION}/${tarball}.tar.gz && ${check} && tar xzf /tmp/rcodesign.tgz -C /tmp && sudo install -m 0755 /tmp/${tarball}/rcodesign /usr/local/bin/rcodesign && rm -rf /tmp/rcodesign.tgz /tmp/${tarball}`,
      );
      log("rcodesign", Date.now() - t, rcode.stdout.trim().slice(0, 100));
    }

    t = Date.now();
    await sandbox.writeFiles(await repoFiles());
    await sh(sandbox, `npm ci --omit=dev --no-audit --no-fund --silent`, { cwd: `${PACKAGER_DIR}/packager`, timeoutMs: 5 * MIN });
    // repack-app reads the expo config from a project: an app.json it's given, and @expo/config found through expo's folder.
    // Metro is never run (lib/android.mjs), so a package.json is all of expo it needs.
    await sh(
      sandbox,
      `mkdir -p project/node_modules/expo && echo '{"name":"muse-product","version":"1.0.0","private":true}' > project/package.json && echo '{"name":"expo","version":"58.0.21"}' > project/node_modules/expo/package.json && ln -sfn ../../node_modules/@expo project/node_modules/@expo`,
      { cwd: `${PACKAGER_DIR}/packager` },
    );
    log("packager code", Date.now() - t);

    if (!fromSnapshot) await bakeTemplates(sandbox, log);

    const versions = await sh(sandbox, "java -version 2>&1 | head -1; rcodesign --version; aapt2 version 2>&1; apksigner version; dexdump 2>&1 | head -1; fc-list | grep -c Inter; which zip unzip");
    console.log(versions.stdout);

    if (keepName) {
      console.log(`Kept sandbox ${sandbox.name} running. Delete it when you're done.`);
      return;
    }
    t = Date.now();
    const snapshot = await sandbox.snapshot({ expiration: 0 });
    log("snapshot", Date.now() - t, `${Math.round(snapshot.sizeBytes / 1e6)} MB`);
    console.log(`\nTotal ${((Date.now() - started) / 1000).toFixed(1)} s`);
    console.log(`PACKAGER_SNAPSHOT_ID=${snapshot.snapshotId}`);
  } finally {
    if (!keepName) {
      await sandbox.stop().catch(() => {});
      await sandbox.delete({ deleteOrphanSnapshots: false }).catch((err) => console.warn("delete packager sandbox:", String(err)));
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
