// The generic shell must never carry the glasses SDK's native code, so the module is left out of autolinking by
// default. Only a MUSE_GLASSES=1 build links it. EAS runs this after installing packages, before the native build.
// Run it by hand before a local glasses prebuild. Its JavaScript stays installed either way, unused by other builds.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODULE = "@chrisgocode/expo-meta-wearables-dat";
const path = fileURLToPath(new URL("../package.json", import.meta.url));
const pkg = JSON.parse(readFileSync(path, "utf8"));

pkg.expo.autolinking.exclude = process.env.MUSE_GLASSES === "1" ? [] : [MODULE];

writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Glasses module ${process.env.MUSE_GLASSES === "1" ? "linked" : "not linked"} for this build.`);
