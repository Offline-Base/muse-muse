// The Windows package: unzip the x64 template, set the exe's icon and version text with resedit, rename it, and zip it. No
// Wine, and nothing that runs Windows code. It isn't signed, so SmartScreen warns and the page says how to get past that.
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { icoFile, ICO_SIZES, iconAt } from "./icons.mjs";
import { OUTPUT_ZIP, productConfig, TEMPLATE_NAME } from "./mac.mjs";
import { runOrThrow } from "./proc.mjs";
import { markUtf8Names } from "./zip.mjs";

const TEMPLATE_DIR = "win-unpacked";

/** Sets the exe's icon and version text. Takes and returns bytes, so a test can read them back. */
export async function patchExe(exeBytes, ico, product, resedit) {
  const { NtExecutable, NtExecutableResource, Data, Resource } = resedit;
  const exe = NtExecutable.from(exeBytes, { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  const iconFile = Data.IconFile.from(ico);
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  if (!groups.length) throw new Error("The Windows template has no icon to replace.");
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, groups[0].id, groups[0].lang, iconFile.icons.map((icon) => icon.data));

  const versions = Resource.VersionInfo.fromEntries(res.entries);
  if (!versions.length) throw new Error("The Windows template has no version information.");
  const version = versions[0];
  const [major = 1, minor = 0, patch = 0] = product.version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const lang = version.getAllLanguagesForStringValues()[0] ?? { lang: 1033, codepage: 1200 };
  version.setFileVersion(major, minor, patch, 0, lang.lang);
  version.setProductVersion(major, minor, patch, 0, lang.lang);
  version.setStringValues(lang, {
    ProductName: product.name,
    FileDescription: product.name,
    OriginalFilename: `${product.fileName}.exe`,
    InternalName: product.fileName,
    CompanyName: "Muse Muse",
    LegalCopyright: "",
    FileVersion: product.version,
    ProductVersion: product.version,
  });
  version.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

/** Reads back what patchExe wrote. The spike and the tests compare this with what was asked for. */
export function readExe(exeBytes, resedit) {
  const { NtExecutable, NtExecutableResource, Resource } = resedit;
  const res = NtExecutableResource.from(NtExecutable.from(exeBytes, { ignoreCert: true }));
  const version = Resource.VersionInfo.fromEntries(res.entries)[0];
  const group = Resource.IconGroupEntry.fromEntries(res.entries)[0];
  return {
    strings: version.getStringValues(version.getAllLanguagesForStringValues()[0]),
    fileVersion: version.getFileVersion?.() ?? version.fixedInfo,
    iconSizes: group.icons.map((icon) => icon.width || 256),
    iconImages: group.getIconItemsFromEntries(res.entries).map((item) => Buffer.from(item.bin ?? [])),
  };
}

/** Makes the Windows zip. Returns its path and how long each step took. */
export async function packageWindows({ template, product, workDir, sharp, master }) {
  const resedit = await import("resedit");
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

  const folder = path.join(workDir, product.fileName);
  await lap("patch", async () => {
    const dir = path.join(workDir, TEMPLATE_DIR);
    await writeFile(path.join(dir, "resources", "muse-product.json"), productConfig(product));
    const pngs = new Map();
    for (const size of ICO_SIZES) pngs.set(size, await iconAt(sharp, master, size, "rounded"));
    const exePath = path.join(dir, `${TEMPLATE_NAME}.exe`);
    const patched = await patchExe(await readFile(exePath), icoFile(pngs), product, resedit);
    await writeFile(path.join(dir, `${product.fileName}.exe`), patched);
    if (product.fileName !== TEMPLATE_NAME) {
      await rm(exePath);
      // electron-builder names Electron's crash reporter DLL after the exe, so it follows the rename.
      await rename(path.join(dir, `${TEMPLATE_NAME}_wer.dll`), path.join(dir, `${product.fileName}_wer.dll`)).catch(() => {});
    }
    await rename(dir, folder);
  });

  const zip = path.join(workDir, OUTPUT_ZIP);
  await lap("zip", async () => {
    await runOrThrow(["zip", "-r", "-q", zip, path.basename(folder)], { cwd: workDir });
    await markUtf8Names(zip);
  });
  const { size } = await stat(zip);
  return { path: zip, bytes: size, timings };
}
