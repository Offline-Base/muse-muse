/**
 * Publishes one shell version's templates, the files every product's downloads are patched from (docs/NATIVE_PACKAGER.md):
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/native/release-shells.ts [--local] [--only android,mac,windows] [--no-build]
 *
 * - Android: the production-android EAS build named in native/releases.json. EAS links expire after 14 days, so its APK is
 *   copied to Blob.
 * - Mac: the universal zip from electron-builder, ad hoc signed. About 215 MB.
 * - Windows: `electron-builder --win dir --x64`, zipped. No Wine: signAndEditExecutable is false.
 *
 * Files go to native/shells/<version>/ in Blob, or under .data/files with --local or with no Blob credential. Then this
 * writes lib/native/shells.json, which the platform deploys with: native/ itself stays out of the deployment. Rerun
 * scripts/native/make-packager-snapshot.ts afterward so the snapshot bakes the same files in.
 *
 * The live store isn't connected to a laptop's OIDC token, so `--via https://muse-muse.vercel.app` asks the live site for a
 * presigned upload per file (app/api/admin/native/shell-upload), with AUTOMATION_SECRET from the environment. A file that only
 * went to .data has no link in shells.json, and packaging then relies on the copy baked into the snapshot.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { uploadPresigned } from "@vercel/blob/client";
import { localFilesEnabled, type StoredPrefix } from "@/lib/local-files";
import { SHELL_TEMPLATE_FILES, type ShellRelease, type ShellTemplate, type ShellTemplateKind } from "@/lib/native/shells";
import { localFilePaths, putBlobAt } from "@/lib/storage";

const run = promisify(execFile);

const ROOT = process.cwd();
const DESKTOP = path.join(ROOT, "native", "shell-desktop");
const RELEASES = path.join(ROOT, "native", "releases.json");
const MANIFEST = path.join(ROOT, "lib", "native", "shells.json");
const CONTENT_TYPES: Record<ShellTemplateKind, string> = {
  android: "application/vnd.android.package-archive",
  mac: "application/zip",
  windows: "application/zip",
};
const PREFIX: StoredPrefix = "native";

function flag(name: string): string | null {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? "") : null;
}

/** electron-builder, with this machine's certificates kept out of it and a clean Electron environment. */
async function builder(args: string[]): Promise<void> {
  const { ELECTRON_RUN_AS_NODE: _drop, ...env } = process.env;
  await run("npx", ["electron-builder", ...args], {
    cwd: DESKTOP,
    env: { ...env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function macTemplate(build: boolean): Promise<string> {
  if (build) await builder(["--mac"]);
  const dist = path.join(DESKTOP, "dist");
  const zip = (await readdir(dist)).find((f) => f.endsWith("-universal-mac.zip"));
  if (!zip) throw new Error("No universal Mac zip in native/shell-desktop/dist.");
  return path.join(dist, zip);
}

async function windowsTemplate(build: boolean): Promise<string> {
  if (build) await builder(["--win", "dir", "--x64"]);
  const dist = path.join(DESKTOP, "dist");
  if (!existsSync(path.join(dist, "win-unpacked"))) throw new Error("No win-unpacked folder in native/shell-desktop/dist.");
  const zip = path.join(dist, "windows-template.zip");
  await rm(zip, { force: true });
  await run("zip", ["-r", "-q", "-X", zip, "win-unpacked"], { cwd: dist });
  return zip;
}

/** The production APK as EAS built it. A lab APK can't stand in: it allows cleartext and takes the lab's links. */
async function androidTemplate(): Promise<string> {
  const releases = JSON.parse(await readFile(RELEASES, "utf8"));
  const build = releases.builds?.["production-android"];
  if (!build?.artifactUrl) throw new Error("native/releases.json has no production-android build yet.");
  const res = await fetch(build.artifactUrl);
  if (!res.ok) throw new Error(`The EAS artifact didn't download (${res.status}). Its link lasts 14 days, so it may need a new build.`);
  const file = path.join(DESKTOP, "dist", "android-template.apk");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

type Destination = { how: "local" } | { how: "blob" } | { how: "via"; origin: string; secret: string };

async function publish(kind: ShellTemplateKind, file: string, version: string, to: Destination): Promise<ShellTemplate> {
  const bytes = await readFile(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const pathname = `${PREFIX}/shells/${version}/${SHELL_TEMPLATE_FILES[kind]}`;
  let url: string | null = null;
  if (to.how === "local") {
    const { file: target, type } = localFilePaths(pathname);
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(path.dirname(type), { recursive: true });
    await writeFile(target, bytes);
    await writeFile(type, CONTENT_TYPES[kind]);
  } else if (to.how === "blob") {
    url = await putBlobAt(pathname, bytes, CONTENT_TYPES[kind]);
  } else {
    const blob = await uploadPresigned(pathname, new Blob([new Uint8Array(bytes)], { type: CONTENT_TYPES[kind] }), {
      access: "public",
      handleUploadUrl: `${to.origin}/api/admin/native/shell-upload`,
      headers: { authorization: `Bearer ${to.secret}` },
      contentType: CONTENT_TYPES[kind],
      multipart: true,
    });
    url = blob.url;
  }
  console.log(`${kind}: ${(bytes.length / 1e6).toFixed(1)} MB, ${sha256.slice(0, 12)}, ${pathname}`);
  return { pathname, url, bytes: bytes.length, sha256 };
}

async function main() {
  const via = flag("--via");
  const secret = process.env.AUTOMATION_SECRET?.trim();
  if (via && !secret) throw new Error("AUTOMATION_SECRET isn't set. Put the live site's in .env.local.");
  const to: Destination = via
    ? { how: "via", origin: via.replace(/\/+$/, ""), secret: secret as string }
    : process.argv.includes("--local") || localFilesEnabled()
      ? { how: "local" }
      : { how: "blob" };
  const build = !process.argv.includes("--no-build");
  const only = (flag("--only") ?? "android,mac,windows").split(",").map((k) => k.trim()) as ShellTemplateKind[];

  const version: string = JSON.parse(await readFile(path.join(DESKTOP, "package.json"), "utf8")).version;
  const releases = JSON.parse(await readFile(RELEASES, "utf8"));
  if (releases.shellVersion !== version) throw new Error(`native/releases.json says ${releases.shellVersion}, but the desktop shell is ${version}.`);

  const previous: ShellRelease | null = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, "utf8")) : null;
  const templates: ShellRelease["templates"] = previous?.shellVersion === version ? { ...previous.templates } : {};
  for (const kind of only) {
    const file = kind === "android" ? await androidTemplate() : kind === "mac" ? await macTemplate(build) : await windowsTemplate(build);
    await stat(file);
    templates[kind] = await publish(kind, file, version, to);
  }
  const release: ShellRelease = { shellVersion: version, templates };
  await writeFile(MANIFEST, `${JSON.stringify(release, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, MANIFEST)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
