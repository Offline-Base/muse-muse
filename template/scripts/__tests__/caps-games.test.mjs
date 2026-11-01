// The games cap's overlays (docs/CAPABILITIES.md, section 20): expectGameResponds in a real Chromium against canvases
// that draw and move, draw nothing, or never respond; the CC0 asset manifest v1 helper (lib/platform/assets3d.ts) with
// GLB files made here; the fixed checks (scripts/caps/games.mjs); and that no cap overlay of unit 14 writes a path the
// template, a target overlay or another cap overlay writes. The browser parts need template/node_modules and
// Playwright's Chromium, and are skipped without them. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/caps-games.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CAPS = path.join(TEMPLATE, "caps");
const MODULES = path.join(TEMPLATE, "node_modules");
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : walk(path.join(dir, e.name), base)) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join("/")],
  );
}

/** A product folder with core and the games overlays applied, and the template's test helpers. */
function product(engine = "games-phaser") {
  const dir = mkdtempSync(path.join(tmpdir(), "mm-games-"));
  dirs.push(dir);
  for (const o of ["core", "games", engine]) cpSync(path.join(CAPS, o, "files"), dir, { recursive: true });
  mkdirSync(path.join(dir, "tests"), { recursive: true });
  for (const f of ["judge-shot.ts", "xr.ts", "demo-fixtures.ts"]) cpSync(path.join(TEMPLATE, "tests", f), path.join(dir, "tests", f));
  writeFileSync(path.join(dir, "musemuse.caps.json"), `${JSON.stringify({ caps: ["games"], overlays: ["core", "games", engine] })}\n`);
  if (existsSync(MODULES)) symlinkSync(MODULES, path.join(dir, "node_modules"));
  return dir;
}

// ---------------------------------------------------------------------------------------------------------------
// GLB files made here: one quad, with optional extensions, outside URIs or many triangles

function makeGlb({ extensionsUsed, externalUri, quads = 1, version = 2 } = {}) {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const idx = new Uint16Array(Array.from({ length: quads }, () => [0, 1, 2, 0, 2, 3]).flat());
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  const json = {
    asset: { version: "2.0" },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length, ...(externalUri ? { uri: externalUri } : {}) }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: idx.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: idx.length, type: "SCALAR" },
    ],
    ...(extensionsUsed ? { extensionsUsed } : {}),
  };
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const b = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(version, 4);
  head.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8);
  const chunk = (len, type) => {
    const c = Buffer.alloc(8);
    c.writeUInt32LE(len, 0);
    c.writeUInt32LE(type, 4);
    return c;
  };
  const glb = Buffer.concat([head, chunk(j.length, 0x4e4f534a), j, chunk(b.length, 0x004e4942), b]);
  return glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
}

const sha = (buf) => createHash("sha256").update(Buffer.from(buf)).digest("hex");
const asset = (over = {}) => ({
  id: "quad",
  title: "Quad",
  kind: "model",
  tags: ["test"],
  files: [{ role: "glb", path: "3d/quad/model.glb", bytes: 100, sha256: "a".repeat(64) }],
  triangles: 2,
  units: "m",
  upAxis: "Y",
  license: { spdx: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
  source: { name: "Made up for a test", url: "https://example.invalid" },
  attribution: "Quad (CC0)",
  ...over,
});

describe("the CC0 asset manifest, v1 (lib/platform/assets3d.ts)", async () => {
  const A = await import(pathToFileURL(path.join(CAPS, "games/files/lib/platform/assets3d.ts")).href);

  test("keeps CC0 assets within the limits and lists the rest with a reason", () => {
    const m = A.parseAssetManifest({
      version: 1,
      assets: [
        asset(),
        asset({ id: "by", license: { spdx: "CC-BY-4.0", url: "x" } }),
        asset({ id: "big", files: [{ role: "glb", path: "3d/big.glb", bytes: 6 * 1024 * 1024, sha256: "b".repeat(64) }] }),
        asset({ id: "dense", triangles: 60_000 }),
        asset({ id: "escape", files: [{ role: "glb", path: "../secrets.glb", bytes: 10, sha256: "c".repeat(64) }] }),
        asset({ id: "nohash", files: [{ role: "glb", path: "3d/x.glb", bytes: 10, sha256: "nope" }] }),
        asset({ id: "role", files: [{ role: "script", path: "3d/x.js", bytes: 10, sha256: "d".repeat(64) }] }),
        asset(),
      ],
    });
    assert.deepEqual(m.assets.map((a) => a.id), ["quad"]);
    assert.deepEqual(
      m.skipped.map((s) => [s.id, s.reason]),
      [
        ["by", "it isn't CC0-1.0"],
        ["big", "its GLB is over 5 MB"],
        ["dense", "its triangle count is missing or over 50k"],
        ["escape", "a file's path isn't a plain relative path"],
        ["nohash", "a file has no sha256"],
        ["role", "a file's role isn't one of glb, preview"],
        ["quad", "its id is listed twice"],
      ],
    );
    assert.throws(() => A.parseAssetManifest({ version: 2, assets: [] }), /version 1 asset manifest/);
    assert.equal(A.assetUrl("/assets/", { path: "3d/quad/model.glb" }), "/assets/3d/quad/model.glb");
  });

  test("fetchVerified checks size and sha256 before anything uses the file", async () => {
    const glb = makeGlb();
    const file = { bytes: glb.byteLength, sha256: sha(glb) };
    const fetchImpl = async () => new Response(glb);
    assert.equal((await A.fetchVerified("/x.glb", file, { fetchImpl })).byteLength, glb.byteLength);
    await assert.rejects(A.fetchVerified("/x.glb", { ...file, sha256: "0".repeat(64) }, { fetchImpl }), /checksum/);
    await assert.rejects(A.fetchVerified("/x.glb", { ...file, bytes: file.bytes + 1 }, { fetchImpl }), /isn't the size/);
    await assert.rejects(A.fetchVerified("/x.glb", file, { fetchImpl: async () => new Response("no", { status: 404 }) }), /answered 404/);
    await assert.rejects(A.fetchVerified("/x.glb", file, { fetchImpl: async () => { throw new TypeError("offline"); } }), /couldn't be downloaded/);
  });

  test("glbInfo reads the header and JSON, and checkGlb refuses decoders from elsewhere, outside files and too many triangles", () => {
    const info = A.glbInfo(makeGlb());
    assert.deepEqual({ version: info.version, meshes: info.meshes, triangles: info.triangles, uris: info.externalUris }, { version: 2, meshes: 1, triangles: 2, uris: [] });
    assert.equal(A.checkGlb(makeGlb()).triangles, 2);
    for (const ext of ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"]) {
      assert.throws(() => A.checkGlb(makeGlb({ extensionsUsed: [ext] })), /needs a decoder from another site/, ext);
    }
    assert.throws(() => A.checkGlb(makeGlb({ externalUri: "https://elsewhere.example/a.bin" })), /outside files/);
    assert.throws(() => A.checkGlb(makeGlb({ quads: 30 }), { maxTriangles: 50 }), /more than 50 triangles/);
    assert.throws(() => A.checkGlb(makeGlb(), { maxBytes: 10 }), /over 0 MB/);
    assert.throws(() => A.glbInfo(makeGlb({ version: 1 })), /glTF 1/);
    assert.throws(() => A.glbInfo(new TextEncoder().encode("not a glb at all, just text").buffer), /isn't a GLB/);
    const cut = makeGlb().slice(0, 60);
    assert.throws(() => A.glbInfo(cut), /cut short/);
  });
});

describe("the games checker (scripts/caps/games.mjs)", async () => {
  const { check, ENGINES } = await import(pathToFileURL(path.join(CAPS, "games/files/scripts/caps/games.mjs")).href);
  const okRecord = { cap: "games", checks: [{ id: "canvas", ok: true, detail: "drew" }, { id: "key-press", ok: true, detail: "moved" }] };

  function gameProduct({ engine = "games-phaser", version, page, extra } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-games-check-"));
    dirs.push(dir);
    const packages = ENGINES[engine].packages;
    writeFileSync(path.join(dir, "musemuse.caps.json"), JSON.stringify({ caps: ["games"], overlays: ["core", "games", engine] }));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: Object.fromEntries(Object.entries(packages).map(([n, v]) => [n, version ?? v])) }));
    for (const [n, v] of Object.entries(packages)) {
      mkdirSync(path.join(dir, "node_modules", n), { recursive: true });
      writeFileSync(path.join(dir, "node_modules", n, "package.json"), JSON.stringify({ name: n, version: v }));
    }
    cpSync(path.join(CAPS, engine, "files", "public"), path.join(dir, "public"), { recursive: true });
    mkdirSync(path.join(dir, "app"), { recursive: true });
    const imp = engine === "games-phaser" ? 'import("phaser")' : 'import("@babylonjs/core/Engines/engine")';
    const notice = ENGINES[engine].notice.replace(/^public/, "");
    writeFileSync(path.join(dir, "app", "page.tsx"), page ?? `export default function Page() { void ${imp}; return <a href="${notice}">Open source notices</a>; }\n`);
    for (const [f, text] of Object.entries(extra ?? {})) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), text);
    }
    return dir;
  }
  const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c.ok]));

  test("passes a game on each engine that imports it, links its notice, loads nothing from elsewhere and recorded both checks", async () => {
    for (const engine of Object.keys(ENGINES)) {
      const checks = await check({ record: okRecord, root: gameProduct({ engine }) });
      assert.deepEqual(byId(checks), { engine: true, "no-cdn": true, notices: true, canvas: true, "key-press": true }, engine);
    }
  });

  test("fails a wrong engine version, an engine nobody imports, a CDN, a missing notice link and a missing record", async () => {
    assert.equal(byId(await check({ record: okRecord, root: gameProduct({ version: "3.90.0" }) })).engine, false);
    assert.equal(byId(await check({ record: okRecord, root: gameProduct({ page: 'export default function Page() { return <a href="/notices/phaser.txt">n</a>; }\n' }) })).engine, false);
    const cdn = await check({ record: okRecord, root: gameProduct({ engine: "games-babylon", extra: { "components/Scene.tsx": 'const decoder = "https://cdn.babylonjs.com/meshopt_decoder.js";\n' } }) });
    assert.equal(byId(cdn)["no-cdn"], false);
    assert.match(cdn.find((c) => c.id === "no-cdn").detail, /components\/Scene\.tsx/);
    const model = await check({ record: okRecord, root: gameProduct({ extra: { "lib/levels.ts": 'export const SHIP = "https://models.example/ship.glb";\n' } }) });
    assert.equal(byId(model)["no-cdn"], false);
    assert.equal(byId(await check({ record: okRecord, root: gameProduct({ page: 'export default function Page() { void import("phaser"); return null; }\n' }) })).notices, false);
    const none = await check({ record: null, root: gameProduct() });
    assert.deepEqual([byId(none).canvas, byId(none)["key-press"]], [false, false]);
    assert.match(none.find((c) => c.id === "canvas").detail, /expectGameResponds/);
  });
});

describe("unit 14's overlays", () => {
  const OVERLAYS = ["extension", "games", "games-phaser", "games-babylon"];

  test("write no path the template, a target overlay or another cap overlay writes", () => {
    const owners = new Map();
    const add = (owner, files) => files.forEach((f) => owners.set(f, [...(owners.get(f) ?? []), owner]));
    add("template", walk(TEMPLATE).filter((f) => !f.startsWith("caps/") && !f.startsWith("targets/") && !f.startsWith("scripts/__tests__/")));
    for (const t of readdirSync(path.join(TEMPLATE, "targets"))) add(`targets/${t}`, walk(path.join(TEMPLATE, "targets", t, "files")));
    for (const c of readdirSync(CAPS)) add(`caps/${c}`, walk(path.join(CAPS, c, "files")));
    const clashes = [...owners].filter(([, who]) => who.length > 1 && who.some((w) => OVERLAYS.includes(w.replace(/^caps\//, ""))));
    assert.deepEqual(clashes, []);
  });

  test("list only platform files they ship, and ship exact versions only", () => {
    for (const o of OVERLAYS) {
      const files = new Set(walk(path.join(CAPS, o, "files")));
      for (const p of JSON.parse(readFileSync(path.join(CAPS, o, "platform-files.json"), "utf8"))) assert.ok(files.has(p), `${o}: ${p}`);
      const deps = JSON.parse(readFileSync(path.join(CAPS, o, "deps.json"), "utf8"));
      for (const v of [...Object.values(deps.dependencies ?? {}), ...Object.values(deps.devDependencies ?? {})]) assert.match(v, /^\d+\.\d+\.\d+$/, o);
    }
  });

  test("ship no em dashes in anything a person or Muse Code reads", () => {
    for (const o of OVERLAYS) {
      for (const f of walk(path.join(CAPS, o, "files")).filter((f) => !f.startsWith("public/notices/"))) {
        assert.ok(!readFileSync(path.join(CAPS, o, "files", f), "utf8").includes("—"), `${o}/${f}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// expectGameResponds in Chromium

const playwright = existsSync(MODULES) ? await import("@playwright/test").catch(() => null) : null;
let browserProblem = playwright ? null : "template/node_modules isn't installed";
let browser = null;
if (playwright) {
  browser = await playwright.chromium.launch().catch((err) => {
    browserProblem = `Playwright's Chromium didn't start (${String(err?.message ?? err).split("\n")[0]})`;
    return null;
  });
}
after(async () => {
  await browser?.close();
});

const PAGES = {
  // A square that moves while ArrowRight is held, drawn every frame.
  moves: `<canvas width=390 height=520 tabindex=0></canvas><script>
    const c = document.querySelector("canvas"), x = c.getContext("2d"); let px = 100, held = false;
    addEventListener("keydown", (e) => { if (e.key === "ArrowRight") held = true; });
    addEventListener("keyup", (e) => { if (e.key === "ArrowRight") held = false; });
    (function frame() { if (held) px = Math.min(330, px + 4); x.fillStyle = "#f0f2f5"; x.fillRect(0, 0, 390, 520); x.fillStyle = "#0064e0"; x.fillRect(px, 300, 40, 40); x.fillStyle = "#080809"; x.fillRect(0, 470, 390, 50); requestAnimationFrame(frame); })();
  </script>`,
  blank: `<canvas width=390 height=520></canvas><script>const x = document.querySelector("canvas").getContext("2d"); x.fillStyle = "#f0f2f5"; x.fillRect(0, 0, 390, 520);</script>`,
  still: `<canvas width=390 height=520></canvas><script>const x = document.querySelector("canvas").getContext("2d"); x.fillStyle = "#f0f2f5"; x.fillRect(0, 0, 390, 520); x.fillStyle = "#0064e0"; x.fillRect(100, 300, 40, 40); x.fillStyle = "#080809"; x.fillRect(0, 470, 390, 50);</script>`,
};

describe("expectGameResponds in Chromium", { skip: browserProblem ?? false }, () => {
  let dir;
  let G;
  const startDir = process.cwd();
  before(async () => {
    dir = product();
    // recordCapCheck writes to test-results/ under the working folder. Each test file gets its own process.
    process.chdir(dir);
    G = await import(pathToFileURL(path.join(dir, "tests/caps/games.ts")).href);
  });
  after(() => process.chdir(startDir));

  async function run(name, opts = {}) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.setContent(PAGES[name]);
      const err = await G.expectGameResponds(page, { key: "ArrowRight", ...opts }).then(() => null, (e) => e);
      const record = JSON.parse(readFileSync(path.join(dir, "test-results/caps/games.json"), "utf8"));
      return { err, checks: Object.fromEntries(record.checks.map((c) => [c.id, c])) };
    } finally {
      await page.close();
      rmSync(path.join(dir, "test-results"), { recursive: true, force: true });
    }
  }

  test("passes a canvas that draws and moves on the key, recording both checks", async () => {
    const { err, checks } = await run("moves");
    assert.equal(err, null);
    assert.equal(checks.canvas.ok, true);
    assert.equal(checks["key-press"].ok, true);
    assert.match(checks["key-press"].detail, /of the canvas changed after ArrowRight/);
  });

  test("fails a blank canvas before pressing anything", async () => {
    const { err, checks } = await run("blank");
    assert.match(String(err?.message), /blank: it drew nothing/);
    assert.equal(checks.canvas.ok, false);
    assert.equal(checks["key-press"], undefined);
  });

  test("fails a canvas that draws but never responds", async () => {
    const { err, checks } = await run("still");
    assert.match(String(err?.message), /nothing on the game's canvas changed after pressing ArrowRight/);
    assert.equal(checks.canvas.ok, true);
    assert.equal(checks["key-press"].ok, false);
  });

  test("reads Playwright's screenshots: sizes, colors and changes", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.setContent(PAGES.still);
      const img = G.readPng(await page.locator("canvas").screenshot());
      assert.deepEqual([img.width, img.height], [390, 520]);
      assert.equal(G.variety(img).colors, 3);
      assert.equal(G.changedShare(img, img), 0);
      await page.setContent(PAGES.blank);
      const blank = G.readPng(await page.locator("canvas").screenshot());
      assert.equal(G.variety(blank).colors, 1);
      assert.ok(G.changedShare(img, blank) > G.MIN_CHANGED);
    } finally {
      await page.close();
    }
  });
});
