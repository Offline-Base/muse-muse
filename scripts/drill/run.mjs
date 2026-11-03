#!/usr/bin/env node
/**
 * `npm run drill`: the eight simulated outage drills (four on the text answer, four on the photo look), with no key, no
 * build, no model and no network past loopback.
 * `npm run drill:all`: those eight and eight more scenarios (template/scripts/edge-drill.mjs lists all 16).
 *
 * It runs template/scripts/edge-drill.mjs, which starts the blackhole gateway (edge-blackhole.mjs, standing in for a
 * cloud that can't be reached) and the fake edge server (edge-fake.mjs, standing in for a board's model), then starts
 * scripts/drill/demo-product.ts, a tiny product that answers through template/lib/meta/edge.ts, and asks it one
 * question per drill:
 *
 *   1. cloud refused    2. cloud hung (waits out the real 10 s cloud deadline)    3. both down    4. tampered reply rejected
 *
 * and four on its photo route, which looks through segmentOrEdge() in the same file, with the fake edge server standing
 * in for Meta SAM 3.1 on a board:
 *
 *   12. SAM, cloud refused    13. SAM, cloud hung (the same 10 s)    14. SAM, both down    15. SAM, tampered board reply
 *   rejected
 *
 * and with --all:
 *
 *   5. cloud slow, inside the limit (about 8 s)    6. cloud flapping (503, OK, 503)    7. edge too slow as well (about
 *   15 s: the 10 s cloud limit plus the 5 s edge limit the runner gives the product)    8. truncated reply rejected
 *   9. injected text shown as data    10. gateway host not found (the product is restarted for it, with every dns.lookup
 *   of a .invalid name failing inside the product before any resolver is asked)    11. cloud model not found (the
 *   gateway answers 404 model_not_found)    16. SAM, cut-off board reply rejected
 *
 * Usage: npm run drill [-- --only 1,12], npm run drill:all [-- --only 5,9,16]
 * Output: each result on stdout, and JSON in .data/drill/ (git-ignored). Exit 0 when every drill run passes, 1 when
 * one fails, 2 when setup fails (a port, or the product never came up).
 *
 * What a pass shows, and only this: with the gateway cut on loopback, the product's fallback answered from a fake
 * server, labelled it, showed a plain message when both were down, and refused a reply with the wrong types, for its
 * text answer and for its look at a Simulated photo. With --all, also: it waited for a slow cloud, labelled each
 * answer while the cloud flapped, gave up on a slow edge in time, refused a cut-off reply, kept planted instructions as
 * data, fell back when the gateway's name didn't resolve or the gateway said model_not_found, and refused a cut-off
 * board reply. It says nothing about a real model, a real board or a real network.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, ".data", "drill");

/** A free loopback port, asked of the OS. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const quote = (p) => `"${p.replace(/(["\\$`])/g, "\\$1")}"`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const [productPort, fakePort, holePort] = [await freePort(), await freePort(), await freePort()];
  const env = { ...process.env };
  // Only the drill's own settings reach the product: nothing inherited can point it at a real gateway or model.
  for (const k of Object.keys(env)) if (k.startsWith("EDGE_") || ["GATEWAY_URL", "PRODUCT_TOKEN", "TEST_MODEL", "MODEL_API_KEY"].includes(k)) delete env[k];
  Object.assign(env, {
    MUSEMUSE_BASE_URL: `http://127.0.0.1:${productPort}`,
    EDGE_FAKE_PORT: String(fakePort),
    EDGE_BLACKHOLE_PORT: String(holePort),
    EDGE_DRILL_PATH: "/api/actions/status",
    EDGE_DRILL_BODY: "{}",
    EDGE_DRILL_SAM_PATH: "/api/actions/look",
    EDGE_DRILL_SAM_BODY: JSON.stringify({ photo: "SIMULATED_PHOTO", prompt: "open door" }),
    EDGE_DRILL_OUT: path.join(OUT, "edge-drill.json"),
    EDGE_BOARD: "a simulated board",
    EDGE_MODEL_NAME: "the fake edge server",
    EDGE_SAM_MODEL_NAME: "a fake SAM service",
    PRODUCT_TOKEN: "drill",
  });
  const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
  const product = `${quote(tsx)} ${quote(path.join(ROOT, "scripts", "drill", "demo-product.ts"))}`;
  console.log("Simulated outage drills: loopback only, invented data, no key, no model.");
  // cwd .data/drill, so the fake's and the blackhole's own logs land in .data/drill/test-results/caps/.
  const child = spawn(process.execPath, [path.join(ROOT, "template", "scripts", "edge-drill.mjs"), "--start", product, ...process.argv.slice(2)], {
    cwd: OUT,
    env,
    stdio: "inherit",
  });
  const code = await new Promise((resolve) => child.on("exit", (c, signal) => resolve(c ?? (signal ? 1 : 0))));
  if (code === 0) console.log(`Results: ${path.relative(process.cwd(), env.EDGE_DRILL_OUT)}`);
  return code;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.log(`drill: ${err?.message ?? err}`);
    process.exit(2);
  },
);
