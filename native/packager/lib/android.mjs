// The Android package: @expo/repack-app turns the shell's APK into one product's app.
//
// Three things it does that this file has to change:
// - It runs Metro when the APK has a JS bundle, which release APKs always do. Every product's JS is the same, so the shell's
//   own bundle goes back in instead. That's the difference between about 15 s and over a minute.
// - It writes the app's name into strings.xml unescaped, so "Fern & Moss" stops the build. Its config gets a placeholder and
//   the real name goes in here.
// - It signs with its debug key, which has no secret in it. The platform replaces that signature after the file leaves the
//   sandbox (lib/native/apk-sign.ts), so the real key never comes in here. apksigner still has to run, because it aligns the
//   files Android maps directly.
import { spawn } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { iconAt } from "./icons.mjs";
import { runOrThrow } from "./proc.mjs";

const NAME_PLACEHOLDER = "MuseProductPlaceholder";

/** Launcher icon pixels by density. */
export const ANDROID_ICON_SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
/** Phones are ARM. Leaving out the emulator-only ABIs takes about 30 MB off every download. */
export const DROPPED_ABIS = ["x86", "x86_64"];

/** A string as an Android resource needs it. */
export function escapeAndroidString(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/^([@?])/, "\\$1");
}

/** The expo config the package is made from. `updates.enabled: false` is what makes repack-app write ENABLED false. */
export function appJson(product, placeholderName = NAME_PLACEHOLDER) {
  return {
    expo: {
      name: placeholderName,
      slug: "muse-product",
      version: product.version,
      orientation: "default",
      scheme: "musemuse",
      userInterfaceStyle: "automatic",
      android: { package: product.packageId, versionCode: 1 },
      updates: { enabled: false },
      extra: {
        variant: "production",
        glasses: false,
        platformUrl: "https://muse-muse.vercel.app",
        productUrl: product.url,
        resolveStub: false,
      },
    },
  };
}

/**
 * Edits the decoded manifest. A product app opens one site for good, so:
 * - ENABLED is false, whatever repack-app did. A later production update must not replace its config, because that would turn
 *   it into the generic product list.
 * - The update URL and channel go too, so that no setting could make it look for updates.
 * - It doesn't take musemuse:// links. Those belong to the generic shell, and every product answering them would show a chooser.
 */
export function patchManifest(xml) {
  let out = xml;
  const enabled = /<meta-data\b[^>]*android:name="expo\.modules\.updates\.ENABLED"[^>]*\/>/;
  const line = '<meta-data android:name="expo.modules.updates.ENABLED" android:value="false"/>';
  if (enabled.test(out)) out = out.replace(enabled, line);
  else out = out.replace(/<application\b[^>]*>/, (open) => `${open}\n    ${line}`);
  out = out.replace(/\s*<meta-data\b[^>]*android:name="expo\.modules\.updates\.(EXPO_UPDATE_URL|UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY)"[^>]*\/>/g, "");
  out = out.replace(/\s*<intent-filter\b(?:(?!<\/intent-filter>)[\s\S])*?android:scheme="(?:musemuse[^"]*|exp\+[^"]*)"(?:(?!<\/intent-filter>)[\s\S])*?<\/intent-filter>/g, "");
  return out;
}

/** Replaces app_name in the decoded strings.xml. */
export function patchStrings(xml, name) {
  const pattern = /(<string name="app_name">)[\s\S]*?(<\/string>)/;
  if (!pattern.test(xml)) throw new Error("The shell has no app_name string.");
  return xml.replace(pattern, (_all, open, close) => `${open}${escapeAndroidString(name)}${close}`);
}

/** What goes in the APK just before it's rebuilt. */
async function patchDecoded(decoded, { product, master, sharp }) {
  const manifestPath = path.join(decoded, "AndroidManifest.xml");
  await writeFile(manifestPath, patchManifest(await readFile(manifestPath, "utf8")));
  const stringsPath = path.join(decoded, "res", "values", "strings.xml");
  await writeFile(stringsPath, patchStrings(await readFile(stringsPath, "utf8"), product.name));

  // expo-constants reads this file when updates are off, so settings.js sees productUrl and the real name.
  const configPath = path.join(decoded, "assets", "app.config");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(configPath, JSON.stringify({ ...config, name: product.name }));

  for (const abi of DROPPED_ABIS) await rm(path.join(decoded, "lib", abi), { recursive: true, force: true });

  for (const [density, size] of Object.entries(ANDROID_ICON_SIZES)) {
    const dir = path.join(decoded, "res", `mipmap-${density}`);
    await mkdir(dir, { recursive: true });
    for (const file of await readdir(dir)) if (/^ic_launcher(_round)?\.[a-z]+$/.test(file)) await rm(path.join(dir, file));
    await writeFile(path.join(dir, "ic_launcher.png"), await iconAt(sharp, master, size, "rounded"));
    await writeFile(path.join(dir, "ic_launcher_round.png"), await iconAt(sharp, master, size, "circle"));
  }
}

/** Runs a real tool the way repack-app expects: a promise for its result, with the child on it. */
function tool(command, args, options) {
  const child = spawn(command, args, { stdio: "pipe", ...options });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += chunk));
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  const finished = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => {
      const result = { pid: child.pid, stdout, stderr, output: [stdout, stderr], status, signal };
      if (status === 0) resolve(result);
      else reject(Object.assign(new Error(`${path.basename(command)} failed: ${stderr.slice(-1500)}`), result));
    });
  });
  return Object.assign(finished, { child });
}

/** repack-app's spawn option: real tools run as they are, with Metro skipped and our edits made before the rebuild. */
export function repackSpawn({ workDir, patch }) {
  const answer = (work, stdout = "") =>
    Object.assign(
      work.then(() => ({ stdout, stderr: "", output: [stdout, ""], status: 0, signal: null })),
      { child: null },
    );
  return function spawnAsync(command, args = [], options = {}) {
    // Where repack-app asks expo for the app's entry file. Only Metro would use the answer.
    if (command === "node" && args[0] === "-e") return answer(Promise.resolve(), "index.js\n");
    if (command === "npx" && args.includes("export:embed")) {
      const bundle = args[args.indexOf("--bundle-output") + 1];
      const assets = args[args.indexOf("--assets-dest") + 1];
      return answer(
        mkdir(assets, { recursive: true }).then(() => cp(path.join(workDir, "decoded-apk", "assets", "index.android.bundle"), bundle)),
      );
    }
    if (command === "java" && args.includes("build")) {
      return Object.assign(patch().then(() => tool(command, args, options)), { child: null });
    }
    return tool(command, args, options);
  };
}

/**
 * Native libraries a phone can't map straight from the APK. The manifest says extractNativeLibs is false, so each must be stored
 * and start on a 16 KB boundary, which also covers 4 KB phones. A wrong one only shows up at install.
 */
export function libraryProblems(apk) {
  let eocd = apk.length - 22;
  while (eocd >= 0 && apk.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) return ["this isn't a zip"];
  const problems = [];
  let at = apk.readUInt32LE(eocd + 16);
  for (let i = apk.readUInt16LE(eocd + 10); i > 0; i--) {
    const nameBytes = apk.readUInt16LE(at + 28);
    const name = apk.toString("utf8", at + 46, at + 46 + nameBytes);
    if (name.startsWith("lib/") && name.endsWith(".so")) {
      const local = apk.readUInt32LE(at + 42);
      const data = local + 30 + apk.readUInt16LE(local + 26) + apk.readUInt16LE(local + 28);
      if (apk.readUInt16LE(at + 10) !== 0) problems.push(`${name} is compressed`);
      else if (data % 16384 !== 0) problems.push(`${name} isn't aligned`);
    }
    at += 46 + nameBytes + apk.readUInt16LE(at + 30) + apk.readUInt16LE(at + 32);
  }
  return problems;
}

/** Reads the built APK back and throws unless it is what was asked for. This is the check S6 needs on every package. */
export async function checkApk(apk, product, aapt2 = "aapt2") {
  const badging = await runOrThrow([aapt2, "dump", "badging", apk], { maxBytes: 4_000_000 });
  const manifest = await runOrThrow([aapt2, "dump", "xmltree", "--file", "AndroidManifest.xml", apk], { maxBytes: 8_000_000 });
  const problems = [...manifestProblems(String(badging.stdout), String(manifest.stdout), product), ...libraryProblems(await readFile(apk))];
  if (problems.length) throw new Error(`The APK isn't right: ${problems.join("; ")}.`);
}

/** Why aapt2's view of an APK doesn't match the product. Empty when it does. */
export function manifestProblems(badging, xmltree, product) {
  const problems = [];
  if (!badging.includes(`package: name='${product.packageId}'`)) problems.push("wrong package");
  // aapt2 prints this with a double quote escaped and an apostrophe not, so the line's ends are the only safe delimiters.
  const label = /^application-label:'(.*)'$/m.exec(badging)?.[1];
  if (label === undefined) problems.push("no label");
  else if (label.replace(/\\(.)/g, "$1") !== product.name) problems.push("wrong name");
  // aapt2 prints this as android:value(0x01010024)=false, or with quotes or a type on some versions.
  const block = /android:name\([^)]*\)="expo\.modules\.updates\.ENABLED"[^\n]*\n\s*A: [^\n]*android:value\([^)]*\)=([^\n]*)/.exec(xmltree);
  if (!block) problems.push("expo.modules.updates.ENABLED is missing");
  else if (!/^(?:false|"false"|\(type 0x12\)0x0)/.test(block[1])) problems.push("expo.modules.updates.ENABLED isn't false");
  if (xmltree.includes("expo.modules.updates.EXPO_UPDATE_URL")) problems.push("the update URL is still there");
  // Two apps can't both hold a provider's authority, so one left on the shell's id stops the second product installing.
  if (/android:authorities[^\n]*"ai\.musemuse\.app\b/.test(xmltree)) problems.push("a provider still has the shell's id");
  return problems;
}

/** Makes the APK, without its real signature. Returns its path. */
export async function packageAndroid({ template, product, projectRoot, workDir, sharp, master, aapt2, androidBuildToolsDir, keepWork = false }) {
  const require = createRequire(import.meta.url);
  const { repackAppAndroidAsync } = require("@expo/repack-app");
  await mkdir(workDir, { recursive: true });
  await writeFile(path.join(projectRoot, "app.json"), JSON.stringify(appJson(product)));
  const repackDir = path.join(workDir, "repack");
  await rm(repackDir, { recursive: true, force: true });
  await mkdir(repackDir, { recursive: true });
  const outputPath = path.join(workDir, "product.apk");
  const decoded = path.join(repackDir, "decoded-apk");
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, time() {}, timeEnd() {} };
  await repackAppAndroidAsync({
    platform: "android",
    projectRoot,
    sourceAppPath: template,
    outputPath,
    workingDirectory: repackDir,
    androidBuildToolsDir,
    logger: quiet,
    skipWorkingDirCleanup: keepWork,
    spawnAsync: repackSpawn({ workDir: repackDir, patch: () => patchDecoded(decoded, { product, master, sharp }) }),
  });
  await checkApk(outputPath, product, aapt2);
  return outputPath;
}
