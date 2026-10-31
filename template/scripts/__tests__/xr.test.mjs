// Unit tests for tests/xr.ts and scripts/xr-peek.mjs that need no browser. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const text = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/** The body of measureView, without the type annotations a .ts file has and a .mjs file can't. */
function measureBody(source) {
  const start = source.indexOf("const bytes = Uint8Array");
  const end = source.indexOf("blank: spread < 6", start);
  assert.ok(start > 0 && end > start);
  return source.slice(start, end).replace(/: number\[\]/g, "").replace(/<number, number>/g, "");
}

test("xr-peek measures a view the same way the judge's check does", () => {
  assert.equal(measureBody(text("../xr-peek.mjs")), measureBody(text("../../tests/xr.ts")));
});

test("the blank rule is the design's: spread under 6, under 12 colors, or one color over 95%", () => {
  for (const source of [text("../xr-peek.mjs"), text("../../tests/xr.ts")]) assert.match(source, /blank: spread < 6 \|\| bins\.size < 12 \|\| top > 0\.95/);
});

test("xr-peek reads its flags in order", async () => {
  const { parseArgs, parseLook } = await import("../xr-peek.mjs");
  assert.deepEqual(parseLook("0,1.6,1.5:0,1.2,-1"), { from: { x: 0, y: 1.6, z: 1.5 }, to: { x: 0, y: 1.2, z: -1 } });
  assert.deepEqual(parseLook("0,1.2,-1"), { from: null, to: { x: 0, y: 1.2, z: -1 } });
  assert.deepEqual(parseLook("Start game"), { from: null, to: "Start game" });
  assert.deepEqual(parseLook("0,1.6,1.5:Start: the game"), { from: { x: 0, y: 1.6, z: 1.5 }, to: "Start: the game" });
  assert.deepEqual(parseLook("Start: the game"), { from: null, to: "Start: the game" });
  const args = parseArgs(["--enter", "--look", "Start", "--select", "Start", "--wait", "Score 0", "--out", "a.png", "--hand", "left", "--url", "http://x/"]);
  assert.deepEqual(args.steps.map((s) => s.kind), ["enter", "look", "select", "wait"]);
  assert.deepEqual([args.out, args.hand, args.url], ["a.png", "left", "http://x/"]);
  assert.throws(() => parseArgs(["--nope"]), /Unknown flag/);
});

test("a web product's judgeShot never loads the headset's helpers", () => {
  const judge = text("../../tests/judge-shot.ts");
  assert.doesNotMatch(judge, /^import .*"\.\/xr"/m);
  assert.match(judge, /if \(isVRProduct\(\)\) \{[^]*?await import\("\.\/xr"\)/);
});

test("a web product keeps its test settings", () => {
  const config = text("../../playwright.config.ts");
  assert.match(config, /vr \? \{ viewport: vr\.viewport, launchOptions: \{ args: vr\.args \} \} : \{ viewport: \{ width: 390, height: 844 \} \}/);
  assert.match(config, /deviceScaleFactor: vr \? 1 : 2/);
  assert.match(config, /args: vr \? vr\.args : \["--force-device-scale-factor=2"\]/);
});

test("the VR overlay ships its fixes", () => {
  const dir = "../../targets/vr/files/";
  const emulator = text(`${dir}lib/xr/emulator.ts`);
  assert.match(emulator, /installRuntime\(\{ forceInstall: true \}\)/);
  assert.match(emulator, /oneView\(\)/);
  assert.match(emulator, /width: 100% !important; height: 100% !important/);
  assert.match(emulator, /installDevUI\(DevUI\)/);
  const stage = text(`${dir}components/xr/XRStage.tsx`);
  assert.match(stage, /baseAssetPath: `\$\{location\.origin\}\/xr\/profiles\/`/);
  assert.match(stage, /emulate: false/);
  assert.match(stage, /rotation: \[0, 0, 0\]/);
  assert.match(stage, /antialias: ready\.handle\.mode === "native"/);
  assert.match(text(`${dir}components/xr/Panel.tsx`), /pixelSize=\{PIXEL_SIZE\}/);
  assert.match(text(`${dir}.agents/skills/muse-vr/SKILL.md`), /At most 50 draw calls and 30k triangles/);
  // Only the profiles that ship, or a headset with another controller asks for a model that isn't there instead of the fallback.
  const profiles = JSON.parse(text(`${dir}public/xr/profiles/profilesList.json`));
  assert.deepEqual(Object.keys(profiles).sort(), ["generic-hand", "generic-trigger", "meta-quest-touch-plus"]);
});

test("a VR judge shot waits while the status says a model is working", () => {
  const source = text("../../tests/xr.ts");
  const start = source.indexOf("export async function xrJudgeShot");
  assert.ok(start > 0);
  assert.ok(source.indexOf('[data-xr-status][aria-busy="true"]', start) > start);
  assert.ok(source.indexOf('[data-xr-status][aria-busy="true"]', start) < source.indexOf("xr.viewStats(page)", start));
});

test("the demo's camera and poster stay inside VR", () => {
  const source = text("../../tests/demo-fixtures.ts");
  // The preview on the page is never a result, what changes behind the view isn't activity, and the summary card can't take the poster.
  assert.match(source, /if \(vr && \(el\.matches\("canvas"\) \|\| el\.querySelector\("canvas"\)\)\) return null;/);
  assert.match(source, /if \(!vr \|\| [^\n]*__musemuseXR[^\n]*inSession\(\) !== true\) \{\n\s+queue\.activity\.push/);
  assert.match(source, /scrollY, waited: 0, busy: false, media: 0, heads: \[\], blanks: \[\], pressed: null/);
});
