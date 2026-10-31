// The Mac package: unzip the universal template, make it this product's app, sign it ad hoc, zip it with symlinks kept.
//
// Ad hoc signing is not optional: the template's fuses and every edit below change what the signature covers, and macOS
// kills an arm64 app with a broken signature at launch (exit 137). rcodesign with no certificate does what
// `codesign --sign -` and electron-builder's `identity: "-"` do. The template carries allow-jit and friends as entitlements,
// and rcodesign keeps those from the existing signature.
//
// Electron finds its helpers as "<CFBundleName> Helper.app" at launch, so the helpers are renamed with the bundle.
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { icnsFile, ICNS_TYPES, macIconAt } from "./icons.mjs";
import { getString, setString } from "./plist.mjs";
import { runOrThrow } from "./proc.mjs";
import { markUtf8Names } from "./zip.mjs";

export const TEMPLATE_NAME = "Muse Muse";
/** fileName strips leading dots, so a product can't be named this. */
export const OUTPUT_ZIP = ".muse-output.zip";
const TEMPLATE_APP = `${TEMPLATE_NAME}.app`;

/** The settings file the shell reads (native/shell-desktop/src/config.js). */
export function productConfig(product) {
  return `${JSON.stringify({ name: product.name, url: product.url, shellVersion: product.version }, null, 2)}\n`;
}

/**
 * The name inside the bundle: the executable, CFBundleName and the helpers Electron finds by it. Plain ASCII, because on the
 * Oct 31 spike a helper named with "日本語" and "é" failed `codesign --verify --strict` after rcodesign signed it. The real name
 * stays on the .app folder and in CFBundleDisplayName, which is what Finder and the Dock show.
 */
export function innerName(name) {
  const plain = String(name)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain || "Muse App";
}

export function patchMainPlist(xml, product) {
  const inner = innerName(product.name);
  let out = setString(xml, "CFBundleName", inner);
  out = setString(out, "CFBundleDisplayName", product.name);
  out = setString(out, "CFBundleExecutable", inner);
  out = setString(out, "CFBundleIdentifier", product.packageId);
  return out;
}

/** A helper's plist. Its suffix ("", " (GPU)") stays, since Chromium looks for those exact names. */
export function patchHelperPlist(xml, product, suffix) {
  const name = `${innerName(product.name)} Helper${suffix}`;
  const idSuffix = suffix ? `.${suffix.trim().slice(1, -1).toLowerCase()}` : "";
  let out = setString(xml, "CFBundleName", name);
  if (getString(out, "CFBundleDisplayName") !== null) out = setString(out, "CFBundleDisplayName", name);
  out = setString(out, "CFBundleExecutable", name);
  out = setString(out, "CFBundleIdentifier", `${product.packageId}.helper${idSuffix}`);
  return out;
}

async function renameHelpers(contents, product) {
  const frameworks = path.join(contents, "Frameworks");
  const prefix = `${TEMPLATE_NAME} Helper`;
  const helpers = (await readdir(frameworks)).filter((entry) => entry.startsWith(prefix) && entry.endsWith(".app"));
  if (!helpers.length) throw new Error("The Mac template has no helpers.");
  for (const helper of helpers) {
    const suffix = helper.slice(prefix.length, -".app".length);
    const dir = path.join(frameworks, helper);
    const plistPath = path.join(dir, "Contents", "Info.plist");
    await writeFile(plistPath, patchHelperPlist(await readFile(plistPath, "utf8"), product, suffix));
    const newName = `${innerName(product.name)} Helper${suffix}`;
    await rename(path.join(dir, "Contents", "MacOS", `${prefix}${suffix}`), path.join(dir, "Contents", "MacOS", newName));
    await rename(dir, path.join(frameworks, `${newName}.app`));
  }
  return helpers.length;
}

/** Makes the Mac zip. Returns its path and how long each step took. */
export async function packageMac({ template, product, workDir, sharp, master, rcodesign = "rcodesign" }) {
  const timings = {};
  const lap = async (step, work) => {
    const started = Date.now();
    const value = await work();
    timings[step] = Date.now() - started;
    return value;
  };
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await lap("unzip", () => runOrThrow(["unzip", "-q", template, "-d", workDir]));

  const bundle = path.join(workDir, `${product.fileName}.app`);
  await lap("patch", async () => {
    const contents = path.join(workDir, TEMPLATE_APP, "Contents");
    await writeFile(path.join(contents, "Resources", "muse-product.json"), productConfig(product));

    const plistPath = path.join(contents, "Info.plist");
    const plist = await readFile(plistPath, "utf8");
    const iconFile = getString(plist, "CFBundleIconFile") ?? "electron.icns";
    await writeFile(plistPath, patchMainPlist(plist, product));

    const pngs = new Map();
    for (const [, size] of ICNS_TYPES) if (!pngs.has(size)) pngs.set(size, await macIconAt(sharp, master, size));
    await writeFile(path.join(contents, "Resources", iconFile.endsWith(".icns") ? iconFile : `${iconFile}.icns`), icnsFile(pngs));

    await rename(path.join(contents, "MacOS", TEMPLATE_NAME), path.join(contents, "MacOS", innerName(product.name)));
    await renameHelpers(contents, product);
    if (product.fileName !== TEMPLATE_NAME) await rename(path.join(workDir, TEMPLATE_APP), bundle);
  });

  await lap("sign", () => runOrThrow([rcodesign, "sign", bundle], { maxBytes: 200_000 }));

  const zip = path.join(workDir, OUTPUT_ZIP);
  await lap("zip", async () => {
    await runOrThrow(["zip", "-y", "-r", "-q", zip, path.basename(bundle)], { cwd: workDir });
    await markUtf8Names(zip);
  });
  const { size } = await stat(zip);
  return { path: zip, bytes: size, timings };
}
