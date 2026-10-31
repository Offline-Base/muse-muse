// Unit tests for tests/xr.ts and scripts/xr-peek.mjs that need no browser. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const text = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/** The body of measureView, without the type annotations a .ts file has and a .mjs file can't. */
function measureBody(source) {
  const start = source.indexOf("const bytes = Uint8Array");
  const end = source.indexOf("blank: !sparse", start);
  assert.ok(start > 0 && end > start);
  return source.slice(start, end).replace(/: number\[\]/g, "").replace(/<number, number>/g, "");
}

test("xr-peek measures a view the same way the judge's check does", () => {
  assert.equal(measureBody(text("../xr-peek.mjs")), measureBody(text("../../tests/xr.ts")));
});

test("the blank rule is the design's: spread under 6, under 12 colors, or one color over 95%, unless a scene is in view", () => {
  for (const source of [text("../xr-peek.mjs"), text("../../tests/xr.ts")]) assert.match(source, /blank: !sparse && \(spread < 6 \|\| bins\.size < 12 \|\| top > 0\.95\)/);
});

/** Runs the real measureView on a 320x180 picture: `pixel(i)` gives pixel i's [r, g, b]. */
async function measure(pixel, sceneObjects) {
  const { measureView } = await import("../xr-peek.mjs");
  const data = new Uint8ClampedArray(320 * 180 * 4);
  for (let i = 0; i < 320 * 180; i++) data.set([...pixel(i), 255], i * 4);
  const context = { drawImage() {}, getImageData: () => ({ data }) };
  Object.assign(globalThis, { createImageBitmap: async () => ({}), OffscreenCanvas: class { getContext = () => context; } });
  try {
    return await measureView({ png: "", sceneObjects });
  } finally {
    delete globalThis.createImageBitmap;
    delete globalThis.OffscreenCanvas;
  }
}

test("a sparse night sky is a scene when its objects are in view, and blank when none are", async () => {
  const sky = (i) => (i % 500 === 0 ? [255, 255, 255] : [0, 0, 0]);
  assert.equal((await measure(sky, 40)).blank, false);
  assert.equal((await measure(sky, 0)).blank, true);
  assert.equal((await measure(sky, null)).blank, true, "a stage that doesn't report it keeps the plain rule");
});

test("a black or dim view is blank even with objects in view", async () => {
  assert.equal((await measure(() => [0, 0, 0], 5)).blank, true);
  assert.equal((await measure((i) => (i % 2 ? [20, 20, 20] : [30, 30, 30]), 5)).blank, true);
});

test("VR checks fail a view with nothing of the scene in it, before they look at its pixels", () => {
  const source = text("../../tests/xr.ts");
  for (const start of [source.indexOf("async enter(page"), source.indexOf("export async function xrJudgeShot")]) {
    assert.ok(start > 0);
    const check = source.indexOf("await expectSomethingInView(page", start);
    assert.ok(check > start && check < source.indexOf("await xr.viewStats(page)", start));
  }
  assert.match(source, /Nothing is in front of the person/);
  assert.match(source, /sceneObjects: stats\.sceneObjects, drawCalls, triangles/);
});

test("the stage reports the product's own objects, without the floor or controllers", () => {
  const stage = text("../../targets/vr/files/components/xr/XRStage.tsx");
  assert.match(stage, /<group ref=\{scene\} name="musemuse-scene">\s+\{children\}\s+<\/group>/);
  assert.ok(stage.indexOf("meshLambertMaterial") < stage.indexOf('name="musemuse-scene"'), "the floor is outside the group");
  assert.match(stage, /handle\.sceneObjects = \(\) => \(scene\.current \? countInView\(scene\.current, camera\) : null\)/);
});

test("a VR judge shot goes by three.js's own draws, which stop when the scene crashes", () => {
  assert.match(text("../../targets/vr/files/components/xr/XRStage.tsx"), /handle\.drawn = \(\) => gl\.info\.render\.frame/);
  const source = text("../../tests/xr.ts");
  assert.match(source, /__musemuseXR\.drawn\?\.\(\) \?\? window\.__musemuseXR\.frames\(\)/);
  assert.match(source, /if \(after\.f === before\.f\) throw new Error\(`\$\{name\}: The VR view stopped drawing\.`\)/);
});

test("the session tracker sees a session from either way in", async () => {
  const { watchSessions } = await import("../../targets/vr/files/lib/xr/sessions.ts");
  const started = [];
  const xr = { requestSession: async (mode) => `requested ${mode}`, offerSession: async (mode) => `offered ${mode}` };
  watchSessions(xr, (session) => started.push(session));
  assert.equal(await xr.requestSession("immersive-vr"), "requested immersive-vr");
  assert.equal(await xr.offerSession("immersive-vr"), "offered immersive-vr");
  assert.deepEqual(started, ["requested immersive-vr", "offered immersive-vr"]);
  // Nothing happens on a refusal, and a browser without offerSession doesn't gain one.
  const refused = { requestSession: async () => Promise.reject(new Error("no")) };
  watchSessions(refused, () => assert.fail("no session started"));
  await assert.rejects(refused.requestSession("immersive-vr"), /no/);
  assert.equal(refused.offerSession, undefined);
  assert.ok(JSON.parse(text("../../targets/vr/platform-files.json")).includes("lib/xr/sessions.ts"));
  assert.match(text("../../targets/vr/files/lib/xr/emulator.ts"), /watchSessions\(navigator\.xr, /);
});

test("xr-peek ignores its own folder and leaves a product's .gitignore alone", async () => {
  const { savePeek } = await import("../xr-peek.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "peek-"));
  try {
    writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
    savePeek(path.join(dir, "root.png"), "png");
    assert.equal(readFileSync(path.join(dir, ".gitignore"), "utf8"), "node_modules\n");
    savePeek(path.join(dir, "public", "x.png"), "png");
    assert.ok(existsSync(path.join(dir, "public", "x.png")));
    assert.ok(!existsSync(path.join(dir, "public", ".gitignore")));
    savePeek(path.join(dir, ".muse-peek", "start.png"), "png");
    assert.equal(readFileSync(path.join(dir, ".muse-peek", ".gitignore"), "utf8"), "*\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("xr-peek reads the scene's numbers after the view has run, and its example stays where the person arrives", () => {
  const source = text("../xr-peek.mjs");
  assert.ok(source.indexOf("waitForTimeout(SETTLE_MS)") < source.indexOf("stats: window.__musemuseXR.info"));
  const skill = text("../../targets/vr/files/.agents/skills/muse-vr/SKILL.md");
  for (const doc of [source, skill]) {
    assert.match(doc, /xr-peek\.mjs --enter --look "Start game" --select "Start game" --out \.muse-peek\/start\.png/);
    assert.doesNotMatch(doc, /--look 0,1\.6,1\.5:/);
  }
  assert.match(skill, /Leave out `from` unless you are checking another spot/);
  assert.match(skill, /about 9k triangles/);
  assert.doesNotMatch(skill, /fails with the judge/);
});

test("a VR session doesn't ask for the room around the person", () => {
  const stage = text("../../targets/vr/files/components/xr/XRStage.tsx");
  for (const feature of ["anchors", "meshDetection", "planeDetection", "hitTest", "domOverlay"]) assert.match(stage, new RegExp(`^\\s+${feature}: false,$`, "m"), feature);
  assert.doesNotMatch(stage, /handTracking: false|layers: false/);
});

test("a failed Enter VR says so on the page, until the next press", () => {
  const button = text("../../targets/vr/files/components/xr/EnterVRButton.tsx");
  assert.match(button, /\{failed \? \(\s+<p className="error" role="alert">\s+VR didn&apos;t open\. Try again\.\s+<\/p>/);
  assert.ok(button.indexOf("setFailed(false)") < button.indexOf("await store?.enterVR()"));
  assert.ok(button.indexOf("await store?.enterVR()") < button.indexOf("setFailed(true)"));
});

test("the simulated headset's note is in the window, for the whole main part and the basic cut", async () => {
  const { windowHtml } = await import("../demo-studio.mjs");
  const note = "Recorded in a <simulated> headset.";
  assert.match(windowHtml("x.app", "T", note), /<div class="note">Recorded in a &lt;simulated&gt; headset\.<\/div>/);
  assert.doesNotMatch(windowHtml("x.app", "T"), /<div class="note">/);
  const source = text("../demo-studio.mjs");
  assert.match(source, /windowHtml\(hostOf\(spec\.url\), spec\.title, spec\.note\)/);
  // With no Chromium there's no window, so a video that must carry a note isn't made at all.
  assert.match(source, /if \(studio \|\| spec\.note\) throw err;/);
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
