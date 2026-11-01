// Platform file (Muse Muse platform services). Don't edit. verify's caps step runs it through scripts/caps-check.mjs.
//
// The fixed checks for a game on a game engine:
//   engine     the engine is installed at the platform's exact version, and the product's code imports it
//   no-cdn     nothing in the product loads the engine, a decoder, a model or a script from another site
//   notices    the engine's license notice is in public/notices/ and the product links to it
//   canvas     the smoke test saw the game's canvas draw something (tests/caps/games.ts, expectGameResponds)
//   key-press  the smoke test saw the canvas change after one key press
//
// What these rest on: engine, no-cdn and notices read the product's files as they are now. Which engine to check comes
// from the platform's record (CAPS_DIR/active.json) when this is its read-only copy, never from the product's
// musemuse.caps.json, which a product test can rewrite. canvas and key-press read the smoke test's record, which a
// product test could write itself. Games make no gateway calls of their own.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The engine overlays and what each installs. A template test keeps this in step with their deps.json. */
export const ENGINES = {
  "games-phaser": {
    name: "Phaser",
    packages: { phaser: "4.2.1" },
    imports: [/\bfrom\s*["']phaser["']/, /\bimport\s*\(\s*["']phaser["']\s*\)/],
    notice: "public/notices/phaser.txt",
  },
  "games-babylon": {
    name: "Babylon.js",
    packages: { "@babylonjs/core": "9.29.0", "@babylonjs/loaders": "9.29.0" },
    imports: [/\bfrom\s*["']@babylonjs\/core(\/[^"']*)?["']/, /\bimport\s*\(\s*["']@babylonjs\/core(\/[^"']*)?["']\s*\)/],
    notice: "public/notices/babylonjs.txt",
  },
};

/** Other sites a game must not load from: engine and decoder CDNs, and any remote model or script file. */
const REMOTE = [
  /\b(?:cdn|preview|assets|playground)\.babylonjs\.com\b/i,
  /\b(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|skypack\.dev|labs\.phaser\.io)\b/i,
  /["'`]https?:\/\/[^"'`\s]+\.(?:glb|gltf|babylon|obj|fbx|ktx2|basis|wasm|js|mjs)(?:\?[^"'`\s]*)?["'`]/i,
];

const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|css|html)$/;

function walk(dir, base) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : SOURCE.test(e.name) ? [path.relative(base, full).split(path.sep).join("/")] : [];
  });
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The product's own source files: app/, components/, lib/ and public/ pages, without the platform's helpers. */
function productSources(root) {
  return ["app", "components", "lib", "public"].flatMap((d) => walk(path.join(root, d), root)).filter((f) => !f.startsWith("lib/platform/"));
}

/**
 * The platform's record of the product's caps (CAPS_DIR/active.json) when this file is the read-only copy in a build
 * sandbox (CAPS_DIR/games/files/scripts/caps), else null: a copy in a product folder, for tests and local use.
 */
export function platformActiveFile(here = HERE) {
  const file = path.join(path.resolve(here, "../../../.."), "active.json");
  return path.basename(path.resolve(here, "../../..")) === "games" && existsSync(file) ? file : null;
}

export async function check({ record, root }) {
  const active = platformActiveFile();
  const caps = readJson(active ?? path.join(root, "musemuse.caps.json"));
  const overlay = Object.keys(ENGINES).find((o) => (caps?.overlays ?? []).includes(o));
  const checks = [];
  if (!overlay) {
    checks.push({ id: "engine", ok: false, detail: `${active ? "The platform's record of this product's caps" : "musemuse.caps.json"} names no game engine overlay` });
  } else {
    const engine = ENGINES[overlay];
    const pkg = readJson(path.join(root, "package.json")) ?? {};
    const wrong = Object.entries(engine.packages).filter(([name, version]) => {
      const declared = pkg.dependencies?.[name];
      const installed = readJson(path.join(root, "node_modules", name, "package.json"))?.version;
      return declared !== version || installed !== version;
    });
    const sources = productSources(root);
    const text = (f) => {
      try {
        return readFileSync(path.join(root, f), "utf8");
      } catch {
        return "";
      }
    };
    const uses = sources.some((f) => engine.imports.some((re) => re.test(text(f))));
    checks.push({
      id: "engine",
      ok: !wrong.length && uses,
      detail: wrong.length
        ? `${wrong.map(([n, v]) => `${n} must be ${v} in package.json and node_modules`).join("; ")}`
        : uses
          ? `${engine.name} ${Object.values(engine.packages)[0]} is installed and the game imports it`
          : `${engine.name} is installed, but no file in app/, components/ or lib/ imports it`,
    });
    const remote = sources.flatMap((f) => (REMOTE.some((re) => re.test(text(f))) ? [f] : []));
    checks.push({
      id: "no-cdn",
      ok: !remote.length,
      detail: remote.length ? `${remote.slice(0, 3).join(", ")} load${remote.length === 1 ? "s" : ""} something from another site. Ship it with the product` : "Nothing loads from another site",
    });
    const href = `/${engine.notice.replace(/^public\//, "")}`;
    const linked = sources.some((f) => !f.startsWith("public/") && text(f).includes(href));
    checks.push({
      id: "notices",
      ok: existsSync(path.join(root, engine.notice)) && linked,
      detail: !existsSync(path.join(root, engine.notice)) ? `${engine.notice} is missing` : linked ? `${engine.name}'s license notice is linked at ${href}` : `Link "Open source notices" to ${href} from the game's page`,
    });
  }
  for (const id of ["canvas", "key-press"]) {
    const seen = (record?.checks ?? []).find((c) => c?.id === id);
    checks.push({
      id,
      ok: seen?.ok === true,
      detail: seen ? String(seen.detail ?? "").slice(0, 200) : "The smoke test didn't run expectGameResponds from tests/caps/games.ts",
    });
  }
  return checks;
}
