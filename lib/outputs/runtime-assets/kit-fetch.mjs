// Part of a Muse Muse self-host kit. Downloads the product's larger public files, which the kit leaves out to stay small,
// from the live product, and checks each one's sha256 against musemuse-kit.json before saving it.
//   node scripts/kit-fetch.mjs
// No dependencies, Node 18 or newer. Built with Muse Muse, a hackathon concept. Not an official Meta product.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kit = JSON.parse(readFileSync(path.join(ROOT, "musemuse-kit.json"), "utf8"));
const SAFE = /^public\/[A-Za-z0-9._\-/ ]+$/;

let failed = 0;
for (const file of kit.fetch ?? []) {
  const where = path.join(ROOT, file.path);
  if (!SAFE.test(file.path) || file.path.split("/").some((s) => s === ".." || s === ".")) {
    console.error(`skipped ${file.path}: not a public file's path`);
    failed++;
    continue;
  }
  if (existsSync(where) && createHash("sha256").update(readFileSync(where)).digest("hex") === file.sha256) {
    console.log(`have ${file.path}`);
    continue;
  }
  try {
    const res = await fetch(file.url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (createHash("sha256").update(data).digest("hex") !== file.sha256) throw new Error("it doesn't match the kit's sha256, so it wasn't saved");
    mkdirSync(path.dirname(where), { recursive: true });
    writeFileSync(where, data);
    console.log(`got ${file.path}`);
  } catch (err) {
    console.error(`couldn't get ${file.path}: ${err.message}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
