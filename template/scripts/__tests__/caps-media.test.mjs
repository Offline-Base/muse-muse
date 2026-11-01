// The media cap's overlay (docs/CAPABILITIES.md, section 14): MIDI bytes, pitch finding, tile math and merging, the MP4
// writer and reader, the speech tokenizer, the platform's checker (scripts/caps/media.mjs), and that the overlay writes
// no path anything else writes. Then, in a real Chromium: a video from 10 frames that plays and passes
// expectVideoPlays, a MIDI download that passes expectMidi, findAll on a fake SAM that passes expectTiles, and speech
// falling back to the browser's voice when the model can't load. The browser parts need template/node_modules,
// esbuild (the repo's) and Playwright's Chromium, and are skipped without them. With MEDIA_TEST_ASSETS_DIR set to a
// folder holding the vetted files by name, one more test reads aloud with the real model. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/caps-media.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CAPS = path.join(TEMPLATE, "caps");
const FILES = path.join(CAPS, "media", "files");
const PLATFORM = path.join(FILES, "lib", "platform");
const MODULES = path.join(TEMPLATE, "node_modules");
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const load = (f) => import(pathToFileURL(path.join(PLATFORM, f)).href);
const M = await load("midi.ts");
const T = await load("sam-tiles.ts");
const P = await load("mp4.ts");
const S = await load("speech.ts");
const C = await import(pathToFileURL(path.join(FILES, "scripts/caps/media.mjs")).href);

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : walk(path.join(dir, e.name), base)) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join("/")],
  );
}

// ---------------------------------------------------------------------------------------------------------------
// MIDI

describe("toMidi and parseMidi (lib/platform/midi.ts)", () => {
  test("writes a format 0 file: header, tempo, program, then note on and off with running times", () => {
    const bytes = M.toMidi([{ pitch: 60, startBeat: 0, beats: 1 }, { pitch: 64, startBeat: 1, beats: 0.5, velocity: 100 }], { bpm: 120, name: "T" });
    const hex = Buffer.from(bytes).toString("hex");
    // MThd, length 6, format 0, 1 track, 480 ticks a beat.
    assert.equal(hex.slice(0, 28), "4d546864000000060000000101e0");
    assert.equal(Buffer.from(bytes.subarray(14, 18)).toString("latin1"), "MTrk");
    const track = hex.slice(44);
    assert.ok(track.startsWith("00ff030154"), "track name T");
    assert.ok(track.includes("00ff510307a120"), "tempo 500000 us a beat (120 bpm)");
    assert.ok(track.includes("00c000"), "program 0");
    // C4 on at 0, off at 480 (83 60 as a variable length number), E4 on at once, off 240 later (81 70), end of track.
    assert.ok(track.endsWith("00903c60" + "8360803c00" + "00904064" + "8170804000" + "00ff2f00"), track);
    assert.equal(Buffer.from(bytes).readUInt32BE(18), bytes.length - 22, "the track length is right");
  });

  test("reads back what it wrote, puts a repeated note's off before its next on, and refuses what isn't MIDI", () => {
    const tune = [0, 1, 2].map((i) => ({ pitch: 67, startBeat: i, beats: 1 }));
    const back = M.parseMidi(M.toMidi(tune, { bpm: 90 }));
    assert.equal(back.format, 0);
    assert.equal(back.ticksPerBeat, 480);
    assert.equal(back.bpm, 90);
    assert.deepEqual(back.notes.map((n) => [n.pitch, n.startBeat, n.beats]), [[67, 0, 1], [67, 1, 1], [67, 2, 1]]);
    assert.equal(C.midiNoteCount(Buffer.from(M.toMidi(tune))), 3, "the platform's checker counts the same notes");
    assert.throws(() => M.parseMidi(new TextEncoder().encode("not midi at all")), /isn't a MIDI file/);
    assert.equal(C.midiNoteCount(Buffer.from("RIFF0000WAVE")), -1);
    assert.equal(C.midiNoteCount(Buffer.from(M.toMidi([]))), 0);
    assert.throws(() => M.toMidi(Array.from({ length: M.NOTES_MAX + 1 }, (_, i) => ({ pitch: 60, startBeat: i, beats: 1 }))), /at most 2000 notes/);
  });

  test("names notes and converts pitches", () => {
    assert.equal(M.noteName(60), "C4");
    assert.equal(M.noteName(69), "A4");
    assert.equal(M.noteName(61), "C#4");
    assert.equal(Math.round(M.pitchHz(69)), 440);
    assert.equal(Math.round(M.hzPitch(261.63)), 60);
  });

  test("notesFromAudio turns a hummed C, E, G into those three notes", () => {
    const rate = 16000;
    const tone = (hz, seconds) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => 0.4 * Math.sin((2 * Math.PI * hz * i) / rate) + 0.1 * Math.sin((4 * Math.PI * hz * i) / rate));
    const gap = new Float32Array(Math.round(rate * 0.1));
    const parts = [tone(261.63, 0.5), gap, tone(329.63, 0.5), gap, tone(392.0, 0.5)];
    const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      samples.set(p, at);
      at += p.length;
    }
    const notes = M.notesFromAudio(samples, rate, { bpm: 120 });
    assert.deepEqual(notes.map((n) => n.pitch), [60, 64, 67]);
    for (const n of notes) assert.ok(n.beats > 0.7 && n.beats < 1.1, `${n.pitch} lasts ${n.beats} beats`);
    assert.deepEqual(M.notesFromAudio(new Float32Array(rate), rate), [], "silence has no notes");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Tiles

describe("tile math and merging (lib/platform/sam-tiles.ts)", () => {
  test("tileGrid covers the photo with overlapping, near-square tiles, at most 16", () => {
    const tiles = T.tileGrid(1600, 800, { tiles: 4, overlap: 0.15 });
    assert.equal(tiles.length, 4, "a 2:1 photo gets 4 tiles");
    // Every pixel is in some tile, and neighbors share a band.
    for (const [x, y] of [[0, 0], [799, 399], [800, 400], [1599, 799]]) assert.ok(tiles.some((t) => x >= t.left && x < t.left + t.width && y >= t.top && y < t.top + t.height), `${x},${y}`);
    const [a, b] = tiles;
    assert.ok(a.left + a.width > b.left, "neighbors overlap");
    assert.equal(T.tileGrid(1000, 1000, { tiles: 1 }).length, 1);
    assert.equal(T.tileGrid(1000, 1000, { tiles: 40 }).length, 16, "capped at 16");
    assert.equal(T.tileGrid(900, 900, { tiles: 9 }).length, 9);
    assert.throws(() => T.tileGrid(0, 10), /no size/);
  });

  test("an object in the band two tiles share counts once, and so does one cut by a tile's edge", () => {
    const [left, right] = T.tileGrid(1000, 500, { tiles: 2, overlap: 0.2 });
    // left covers 0 to 600, right 400 to 1000. A bird at 450 to 500 is whole in both.
    const whole = { left: 450, top: 100, right: 500, bottom: 150, confidence: 0.9 };
    const inRight = (b) => ({ ...b, left: b.left - right.left, right: b.right - right.left });
    const merged = T.mergeTileBoxes([
      { tile: left, boxes: [whole, { left: 100, top: 100, right: 150, bottom: 150 }] },
      { tile: right, boxes: [inRight({ ...whole, confidence: 0.95 }), inRight({ left: 800, top: 300, right: 850, bottom: 350 })] },
    ]);
    assert.equal(merged.length, 3);
    const bird = merged.find((m) => m.left === 450);
    assert.equal(bird.seenIn, 2);
    assert.equal(bird.confidence, 0.95, "the higher confidence is kept");
    // A box cut at the left tile's right edge (580 to 600) beside the whole one the right tile saw (580 to 640).
    const cut = T.mergeTileBoxes([
      { tile: left, boxes: [{ left: 580, top: 200, right: 600, bottom: 260 }] },
      { tile: right, boxes: [inRight({ left: 580, top: 200, right: 640, bottom: 260 })] },
    ]);
    assert.equal(cut.length, 1);
    assert.deepEqual([cut[0].left, cut[0].right], [580, 640]);
  });

  test("two halves of an object wider than the overlap join, and two neighbors at a seam stay two", () => {
    const [left, right] = T.tileGrid(1000, 500, { tiles: 2, overlap: 0.05 });
    // left covers 0 to 525, right 475 to 1000. A bus from 300 to 800 is cut in both.
    const inRight = (b) => ({ ...b, left: b.left - right.left, right: b.right - right.left });
    const bus = T.mergeTileBoxes([
      { tile: left, boxes: [{ left: 300, top: 100, right: 525, bottom: 300 }] },
      { tile: right, boxes: [inRight({ left: 475, top: 102, right: 800, bottom: 298 })] },
    ]);
    assert.equal(bus.length, 1);
    assert.deepEqual([bus[0].left, bus[0].right], [300, 800]);
    // Two people side by side, each whole in its own tile, near the seam: no tile cut either one.
    const people = T.mergeTileBoxes([
      { tile: left, boxes: [{ left: 430, top: 100, right: 470, bottom: 200 }] },
      { tile: right, boxes: [inRight({ left: 480, top: 100, right: 520, bottom: 200 })] },
    ]);
    assert.equal(people.length, 2);
    // Two boxes one tile found are never merged with each other, however close.
    assert.equal(T.mergeTileBoxes([{ tile: left, boxes: [{ left: 10, top: 10, right: 50, bottom: 50 }, { left: 12, top: 12, right: 52, bottom: 52 }] }]).length, 2);
  });

  test("scales a resized tile's boxes back to the photo", () => {
    const [tile] = T.tileGrid(2000, 1000, { tiles: 1 });
    const [b] = T.mergeTileBoxes([{ tile, scale: 0.5, boxes: [{ left: 10, top: 20, right: 30, bottom: 40 }] }]);
    assert.deepEqual([b.left, b.top, b.right, b.bottom], [20, 40, 60, 80]);
  });

  test("a full tile is split again while calls are left, else the count is marked capped", async () => {
    // A fake SAM: every object is a 10 px square on a 40 px grid over a 1200x600 photo, 450 in all.
    const objects = [];
    for (let y = 10; y < 600; y += 40) for (let x = 10; x < 1200; x += 40) objects.push({ left: x, top: y, right: x + 10, bottom: y + 10 });
    const sam = async (tile) => ({
      tile,
      boxes: objects
        .filter((o) => o.left >= tile.left && o.right <= tile.left + tile.width && o.top >= tile.top && o.bottom <= tile.top + tile.height)
        .slice(0, T.SAM_OBJECTS_PER_CALL)
        .map((o) => ({ left: o.left - tile.left, top: o.top - tile.top, right: o.right - tile.left, bottom: o.bottom - tile.top })),
    });
    const four = await T.runTiles(1200, 600, sam, { tiles: 4, maxTiles: 4 });
    assert.equal(four.tiles, 4);
    assert.equal(four.saturated, 4);
    assert.equal(four.capped, true, "four full tiles with no calls left");
    const sixteen = await T.runTiles(1200, 600, sam, { tiles: 4, maxTiles: 16 });
    assert.equal(sixteen.tiles, 16);
    assert.ok(sixteen.boxes.length > four.boxes.length, `${sixteen.boxes.length} > ${four.boxes.length}`);
    assert.ok(sixteen.boxes.length <= sixteen.rawBoxes);
    // Each object seen in several tiles counts once, and no two objects were joined into one box.
    for (const r of [four, sixteen]) {
      for (const b of r.boxes) assert.deepEqual([b.right - b.left, b.bottom - b.top], [10, 10]);
      assert.equal(new Set(r.boxes.map((b) => `${b.left},${b.top}`)).size, r.boxes.length);
    }
    // A sparse photo needs no split.
    const sparse = await T.runTiles(1200, 600, async (tile) => ({ tile, boxes: [] }), { tiles: 4 });
    assert.deepEqual([sparse.tiles, sparse.capped, sparse.boxes.length], [4, false, 0]);
  });

  test("planVideoChunks keeps 5 frames a second, chunks of at most 300 and 900 in all, and prices them", () => {
    const short = T.planVideoChunks(20_000);
    assert.deepEqual(short.chunks, [{ index: 0, startMs: 0, endMs: 20000, frames: 100 }]);
    assert.equal(short.capped, false);
    const long = T.planVideoChunks(10 * 60_000);
    assert.equal(long.chunks.length, 3);
    assert.deepEqual(long.chunks.map((c) => [c.startMs, c.frames]), [[0, 300], [60000, 300], [120000, 300]]);
    assert.equal(long.capped, true);
    assert.equal(+long.costUsd.toFixed(4), 0.18);
    assert.equal(+T.planVideoChunks(2_000).costUsd.toFixed(4), 0.01, "a 10-frame clip is billed for 50");
    assert.throws(() => T.planVideoChunks(0), /no length/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// MP4

describe("muxMp4 and readMp4Info (lib/platform/mp4.ts)", () => {
  const avcC = Uint8Array.from([1, 0x42, 0xe0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0xe0, 0x1f, 1, 0, 4, 0x68, 0xce, 0x3c, 0x80]);
  const samples = (n, fps, keyEvery = 4) => Array.from({ length: n }, (_, i) => ({ data: Uint8Array.from([0, 0, 0, 2, 0x65, i]), timestampUs: Math.round((i * 1e6) / fps), durationUs: Math.round(1e6 / fps), key: i % keyEvery === 0 }));

  test("writes ftyp, moov before mdat, and an index a reader agrees with", () => {
    const bytes = P.muxMp4({ codec: "avc", width: 320, height: 240, description: avcC, samples: samples(10, 5) });
    const top = [];
    for (let at = 0; at < bytes.length; ) {
      const size = Buffer.from(bytes).readUInt32BE(at);
      top.push(Buffer.from(bytes.subarray(at + 4, at + 8)).toString("latin1"));
      at += size;
    }
    assert.deepEqual(top, ["ftyp", "moov", "mdat"]);
    const info = P.readMp4Info(bytes);
    assert.deepEqual(info, { brand: "isom", durationMs: 2000, width: 320, height: 240, codec: "avc1", samples: 10, keyFrames: 3, complete: true });
    assert.deepEqual(C.mp4Info(Buffer.from(bytes)), { durationMs: 2000, codec: "avc1", samples: 10 }, "the platform's checker reads the same");
  });

  test("writes VP9 with a vpcC record, leaves out stss when every frame is a key frame, and refuses bad input", () => {
    const vp9 = P.muxMp4({ codec: "vp9", width: 64, height: 64, vp9: { profile: 0, level: 31 }, samples: samples(3, 2, 1) });
    const info = P.readMp4Info(vp9);
    assert.equal(info.codec, "vp09");
    assert.equal(info.keyFrames, 3);
    assert.equal(info.durationMs, 1500);
    assert.ok(Buffer.from(vp9).includes(Buffer.from("vpcC")));
    assert.ok(!Buffer.from(vp9).includes(Buffer.from("stss")));
    assert.throws(() => P.muxMp4({ codec: "avc", width: 2, height: 2, description: avcC, samples: [] }), /at least one frame/);
    assert.throws(() => P.muxMp4({ codec: "avc", width: 2, height: 2, samples: samples(1, 1) }), /avcC/);
    assert.throws(() => P.muxMp4({ codec: "avc", width: 2, height: 2, description: avcC, samples: samples(2, 1).map((s) => ({ ...s, key: false })) }), /key frame/);
    assert.equal(P.readMp4Info(new TextEncoder().encode("not an mp4 file at all")), null);
    assert.equal(C.mp4Info(Buffer.from("not an mp4 file at all")), null);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Speech text

describe("the speech tokenizer (lib/platform/speech.ts)", () => {
  test("matches SpeechT5's own tokenizer on a sample, with numbers read as words", () => {
    // From Xenova/speecht5_tts tokenizer.json at 1723781b, for "Hello! The library opens at nine today, and the story
    // hour starts at ten." (Metaspace, one id per character, then </s>).
    const want = [4, 35, 5, 15, 15, 8, 44, 4, 32, 11, 5, 4, 15, 10, 25, 13, 7, 13, 22, 4, 8, 24, 5, 9, 12, 4, 7, 6, 4, 9, 10, 9, 5, 4, 6, 8, 14, 7, 22, 23, 4, 7, 9, 14, 4, 6, 11, 5, 4, 12, 6, 8, 13, 22, 4, 11, 8, 16, 13, 4, 12, 6, 7, 13, 6, 12, 4, 7, 6, 4, 6, 5, 9, 26, 2];
    assert.deepEqual(S.speechTokens("Hello! The library opens at 9 today, and the story hour starts at 10."), want);
    assert.equal(S.numberWords("1984"), "one thousand nine hundred eighty four");
    assert.equal(S.numberWords("0"), "zero");
    assert.equal(S.numberWords("12345678901"), "one two three four five six seven eight nine zero one");
    assert.equal(S.speechText("It’s 3.5 km — 50% off & more"), "It's three point five km, fifty percent off and more");
    assert.deepEqual(S.speechTokens(""), [2]);
    assert.equal(S.speechTokens("ç").at(0), 4);
    assert.equal(S.speechTokens("ç").at(1), 3, "a character outside the alphabet is <unk>");
  });

  test("splits long text into pieces the model takes, and carries the MIT x-vector voice", () => {
    const text = `${"A short sentence. ".repeat(3)}${"word ".repeat(80)}end.`;
    const pieces = S.speechPieces(text, 200);
    assert.ok(pieces.length >= 4);
    for (const p of pieces) assert.ok(p.length <= 200, p);
    const voice = S.speakerEmbedding();
    assert.equal(voice.length, 512);
    // The same 2,048 bytes as cmu_us_slt_arctic-wav-arctic_a0508.npy in Matthijs/cmu-arctic-xvectors (MIT).
    assert.equal(createHash("sha256").update(Buffer.from(voice.buffer)).digest("hex"), "7384027325428d6eda21f47213572541443f5864044295a2e5c07fbaaf372bb3");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The platform's checker

describe("the media checker (scripts/caps/media.mjs)", () => {
  const rec = (...checks) => ({ cap: "media", checks });
  const good = {
    video: { id: "video", ok: true, detail: "played" },
    music: { id: "music", ok: true, detail: "notes" },
    speech: { id: "speech", ok: true, detail: "read [by=browser]" },
    tiles: { id: "tiles", ok: true, detail: "tiles=4 raw=20 merged=17 saturated=0 capped=0" },
  };
  function product({ parts = "speech, video, music, samTiling", files = {}, link = true } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-media-check-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "brief.md"), `# A product\n\n### Media in the browser\n\n${parts === null ? "" : `- Media parts: ${parts}\n`}`);
    cpSync(path.join(FILES, "public"), path.join(dir, "public"), { recursive: true });
    mkdirSync(path.join(dir, "app"), { recursive: true });
    writeFileSync(path.join(dir, "app", "page.tsx"), `export default function Page() { return ${link ? '<a href="/notices/media.txt">Open source notices</a>' : "null"}; }\n`);
    const media = path.join(dir, "test-results", "caps", "media");
    mkdirSync(media, { recursive: true });
    const avcC = Uint8Array.from([1, 0x42, 0xe0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0xe0, 0x1f, 1, 0, 4, 0x68, 0xce, 0x3c, 0x80]);
    const mp4 = P.muxMp4({ codec: "avc", width: 64, height: 64, description: avcC, samples: [0, 1, 2].map((i) => ({ data: Uint8Array.from([0, 0, 0, 1, i]), timestampUs: i * 500000, durationUs: 500000, key: i === 0 })) });
    const defaults = { "video.mp4": Buffer.from(mp4), "tune.mid": Buffer.from(M.toMidi([{ pitch: 60, startBeat: 0, beats: 1 }])) };
    for (const [name, bytes] of Object.entries({ ...defaults, ...files })) if (bytes !== null) writeFileSync(path.join(media, name), bytes);
    return dir;
  }
  const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c.ok]));

  test("passes every part with its record, the saved files, the notices link and nothing from another site", async () => {
    const checks = await C.check({ record: rec(...Object.values(good)), root: product() });
    assert.deepEqual(byId(checks), { video: true, music: true, speech: true, tiles: true, "no-cdn": true, notices: true });
    assert.match(checks.find((c) => c.id === "video").detail, /avc1 MP4, 1\.5 seconds, 3 frames/);
    assert.match(checks.find((c) => c.id === "music").detail, /1 notes/);
  });

  test("checks only the parts brief.md lists", async () => {
    const checks = await C.check({ record: rec(good.video), root: product({ parts: "video" }) });
    assert.deepEqual(byId(checks), { video: true, "no-cdn": true, notices: true });
    const none = await C.check({ record: rec(good.video), root: product({ parts: null }) });
    assert.deepEqual(byId(none), { parts: false });
  });

  test("fails a fake or missing file, a missing record, too many tiles, a CDN and a missing notices link", async () => {
    const fake = await C.check({ record: rec(...Object.values(good)), root: product({ files: { "video.mp4": Buffer.from("not a video"), "tune.mid": Buffer.from("MThd but not really") } }) });
    assert.equal(byId(fake).video, false);
    assert.equal(byId(fake).music, false);
    const missing = await C.check({ record: rec(...Object.values(good)), root: product({ files: { "video.mp4": null, "tune.mid": null } }) });
    assert.match(missing.find((c) => c.id === "video").detail, /saved no video file/);
    assert.match(missing.find((c) => c.id === "music").detail, /saved no MIDI file/);
    const silent = await C.check({ record: rec(...Object.values(good)), root: product({ files: { "tune.mid": Buffer.from(M.toMidi([])) } }) });
    assert.equal(byId(silent).music, false);
    const noRecord = await C.check({ record: rec(), root: product() });
    assert.deepEqual([byId(noRecord).video, byId(noRecord).speech, byId(noRecord).tiles], [false, false, false]);
    const many = await C.check({ record: rec(...Object.values(good).filter((c) => c.id !== "tiles"), { id: "tiles", ok: true, detail: "tiles=9 raw=40 merged=30 saturated=2 capped=0" }), root: product() });
    assert.equal(byId(many).tiles, false);
    assert.match(many.find((c) => c.id === "tiles").detail, /at most 4/);
    const one = await C.check({ record: rec(...Object.values(good).filter((c) => c.id !== "tiles"), { id: "tiles", ok: true, detail: "tiles=1 raw=3 merged=3" }), root: product() });
    assert.equal(byId(one).tiles, false);
    const dir = product();
    writeFileSync(path.join(dir, "app", "voice.ts"), 'export const MODEL = "https://huggingface.co/x/resolve/main/model.onnx";\n');
    assert.equal(byId(await C.check({ record: rec(...Object.values(good)), root: dir }))["no-cdn"], false);
    assert.equal(byId(await C.check({ record: rec(...Object.values(good)), root: product({ link: false }) })).notices, false);
    const noOrt = product();
    rmSync(path.join(noOrt, "public/notices/onnxruntime.txt"));
    const ort = (await C.check({ record: rec(...Object.values(good)), root: noOrt })).find((c) => c.id === "notices");
    assert.equal(ort.ok, false);
    assert.match(ort.detail, /onnxruntime\.txt is missing/);
  });
});

describe("the open source notices (public/notices)", () => {
  test("carry ONNX Runtime 1.30.0's third-party notices for the code built into its wasm, linked from media.txt", () => {
    const media = readFileSync(path.join(FILES, "public/notices/media.txt"), "utf8");
    assert.match(media, /\/notices\/onnxruntime\.txt/);
    const ort = readFileSync(path.join(FILES, "public/notices/onnxruntime.txt"), "utf8");
    assert.match(ort, /blob\/v1\.30\.0\/ThirdPartyNotices\.txt/);
    for (const part of ["protocolbuffers/protobuf", "abseil-cpp", "google/flatbuffers", "Eigen", "SafeInt"]) assert.ok(ort.includes(part), part);
    assert.ok(ort.length > 300_000, "the whole upstream file");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The overlay

describe("the media overlay", () => {
  test("writes no path the template, a target overlay or another cap overlay writes", () => {
    const owners = new Map();
    const add = (owner, files) => files.forEach((f) => owners.set(f, [...(owners.get(f) ?? []), owner]));
    add("template", walk(TEMPLATE).filter((f) => !f.startsWith("caps/") && !f.startsWith("targets/") && !f.startsWith("scripts/__tests__/")));
    for (const t of readdirSync(path.join(TEMPLATE, "targets"))) add(`targets/${t}`, walk(path.join(TEMPLATE, "targets", t, "files")));
    for (const c of readdirSync(CAPS)) add(`caps/${c}`, walk(path.join(CAPS, c, "files")));
    assert.deepEqual([...owners].filter(([, who]) => who.length > 1 && who.includes("caps/media")), []);
  });

  test("lists every file it ships as a platform file, adds no packages, and has no em dash", () => {
    const files = walk(FILES);
    assert.deepEqual([...JSON.parse(readFileSync(path.join(CAPS, "media", "platform-files.json"), "utf8"))].sort(), [...files].sort());
    assert.deepEqual(JSON.parse(readFileSync(path.join(CAPS, "media", "deps.json"), "utf8")), { dependencies: {}, devDependencies: {} });
    for (const f of files) assert.ok(!readFileSync(path.join(FILES, f), "utf8").includes("—"), f);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// In Chromium

const playwright = existsSync(MODULES) ? await import("@playwright/test").catch(() => null) : null;
const esbuild = await import("esbuild").catch(() => null);
let browserProblem = !playwright ? "template/node_modules isn't installed" : !esbuild ? "esbuild isn't installed" : null;
let browser = null;
if (!browserProblem) {
  browser = await playwright.chromium.launch().catch((err) => {
    browserProblem = `Playwright's Chromium didn't start (${String(err?.message ?? err).split("\n")[0]})`;
    return null;
  });
}
after(async () => {
  await browser?.close();
});

const ORIGIN = "https://media.test";

async function bundle(assetsUrl) {
  const entry = `
    import { imagesToVideo } from "./video.ts";
    import { midiBlob, toMidi } from "./midi.ts";
    import { findAll, videoChunks } from "./sam-tiles.ts";
    import { readMp4Info } from "./mp4.ts";
    import { playSamples, speak } from "./speech.ts";
    window.Media = { imagesToVideo, midiBlob, toMidi, findAll, videoChunks, readMp4Info, playSamples, speak };
  `;
  const out = await esbuild.build({
    stdin: { contents: entry, resolveDir: PLATFORM, loader: "ts" },
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
    define: { "process.env.NEXT_PUBLIC_MUSEMUSE_ASSETS_URL": JSON.stringify(assetsUrl ?? ""), "process.env.NEXT_PUBLIC_MUSEMUSE_MEDIA_SMOKE": '"1"' },
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

const PAGE = (js) => `<!doctype html><meta charset=utf-8><body>
<button id=make>Make video</button><video controls playsinline muted></video>
<a id=save download="tune.mid">Save MIDI file</a>
<button id=count>Count</button><p id=count-out></p>
<button id=read>Read aloud</button><p id=read-out></p>
<script>${js}</script>
<script>
  document.getElementById("make").onclick = async () => {
    const frames = [];
    for (let i = 0; i < 10; i++) {
      const c = document.createElement("canvas"); c.width = 320; c.height = 240;
      const x = c.getContext("2d"); x.fillStyle = "hsl(" + i * 36 + " 70% 50%)"; x.fillRect(0, 0, 320, 240);
      x.fillStyle = "#fff"; x.font = "64px sans-serif"; x.fillText(String(i), 140, 140); frames.push(c);
    }
    const v = await Media.imagesToVideo(frames, { fps: 5 });
    document.querySelector("video").src = v.url;
  };
  document.getElementById("save").href = URL.createObjectURL(Media.midiBlob(Media.toMidi([{ pitch: 60, startBeat: 0, beats: 1 }, { pitch: 67, startBeat: 1, beats: 1 }])));
  document.getElementById("count").onclick = async () => {
    const c = document.createElement("canvas"); c.width = 800; c.height = 400;
    const x = c.getContext("2d"); x.fillStyle = "#eee"; x.fillRect(0, 0, 800, 400);
    const r = await Media.findAll(c, "dot", { tiles: 4, segment: async (tile, phrase, info) => [{ left: 5, top: 5, right: 25, bottom: 25, confidence: 0.9 }] });
    document.getElementById("count-out").textContent = r.boxes.length + " found in " + r.tiles + " tiles";
  };
  document.getElementById("read").onclick = async () => {
    const r = await Media.speak("Hello there. This is a short test.");
    document.getElementById("read-out").textContent = r.by + " " + (r.note ?? "");
  };
</script>`;

describe("the media helpers in Chromium", { skip: browserProblem ?? false }, () => {
  let dir;
  let H;
  let js;
  const startDir = process.cwd();
  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-media-"));
    dirs.push(dir);
    for (const o of ["core", "media"]) cpSync(path.join(CAPS, o, "files"), dir, { recursive: true });
    mkdirSync(path.join(dir, "tests"), { recursive: true });
    for (const f of ["judge-shot.ts", "xr.ts", "demo-fixtures.ts"]) if (existsSync(path.join(TEMPLATE, "tests", f))) cpSync(path.join(TEMPLATE, "tests", f), path.join(dir, "tests", f));
    symlinkSync(MODULES, path.join(dir, "node_modules"));
    process.chdir(dir);
    H = await import(pathToFileURL(path.join(dir, "tests/caps/media.ts")).href);
    js = await bundle(null);
  });
  after(() => process.chdir(startDir));

  async function open(script = js, route) {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await page.route(`${ORIGIN}/**`, (r) => (route?.(r) ?? r.fulfill({ contentType: "text/html", body: PAGE(script) })));
    await page.goto(`${ORIGIN}/`);
    return { page, close: () => context.close() };
  }
  const recorded = () => Object.fromEntries(JSON.parse(readFileSync(path.join(dir, "test-results/caps/media.json"), "utf8")).checks.map((c) => [c.id, c]));

  test("a video from 10 frames plays, passes expectVideoPlays and is saved as an MP4 the checker reads", async () => {
    const { page, close } = await open();
    try {
      await H.expectVideoPlays(page, { make: "#make" });
    } finally {
      await close();
    }
    assert.equal(recorded().video.ok, true);
    assert.match(recorded().video.detail, /2\.0 seconds at 320x240 and played/);
    const info = C.mp4Info(readFileSync(path.join(dir, "test-results/caps/media/video.mp4")));
    assert.equal(info.durationMs, 2000);
    assert.equal(info.samples, 10);
  });

  test("a MIDI download passes expectMidi, and findAll on 4 tiles passes expectTiles with the seam duplicates merged", async () => {
    const { page, close } = await open();
    try {
      await H.expectMidi(page, { click: "#save" });
      await page.click("#count");
      await H.expectTiles(page);
      assert.match(await page.textContent("#count-out"), /found in 4 tiles/);
    } finally {
      await close();
    }
    assert.equal(recorded().music.ok, true);
    assert.match(recorded().music.detail, /2 notes/);
    assert.equal(recorded().tiles.ok, true);
    assert.match(recorded().tiles.detail, /^tiles=4 raw=4 merged=4 /);
  });

  test("in a build's test run, findAll holds the page to 4 SAM calls in all", async () => {
    const { page, close } = await open();
    try {
      await page.click("#count");
      await page.waitForFunction(() => document.getElementById("count-out").textContent);
      const second = await page.evaluate(() => Media.findAll(document.createElement("canvas"), "dot", { tiles: 4, segment: async () => [] }).then(() => "ran", (e) => e.message));
      assert.match(second, /already used its 4 photo pieces/);
    } finally {
      await close();
    }
  });

  test("findAll's 4 test calls hold across a reload of the page", async () => {
    const { page, close } = await open();
    try {
      await page.click("#count");
      await page.waitForFunction(() => document.getElementById("count-out").textContent);
      await page.reload();
      const again = await page.evaluate(() => Media.findAll(document.createElement("canvas"), "dot", { tiles: 4, segment: async () => [] }).then(() => "ran", (e) => e.message));
      assert.match(again, /already used its 4 photo pieces/);
    } finally {
      await close();
    }
  });

  test("videoChunks cuts an 80 second clip into H.264 chunks of 300 and 100 frames, one frame held at a time", async () => {
    const { page, close } = await open();
    try {
      const got = await page.evaluate(async () => {
        // The clip: 120 pictures at 1.5 a second is 80 seconds, VP9 when the browser has it.
        const pics = [];
        for (let i = 0; i < 120; i++) {
          const c = document.createElement("canvas"); c.width = 160; c.height = 120;
          const x = c.getContext("2d"); x.fillStyle = "hsl(" + i * 3 + " 70% 50%)"; x.fillRect(0, 0, 160, 120);
          x.fillStyle = "#fff"; x.fillRect((i * 7) % 140, 50, 20, 20); pics.push(c);
        }
        const clip = await Media.imagesToVideo(pics, { fps: 1.5, codec: "vp9" }).catch(() => Media.imagesToVideo(pics, { fps: 1.5 }));
        const make = document.createElement.bind(document);
        let canvases = 0;
        document.createElement = (tag, o) => (String(tag).toLowerCase() === "canvas" && canvases++, make(tag, o));
        try {
          const r = await Media.videoChunks(clip.blob);
          const infos = await Promise.all(r.chunks.map(async (c) => Media.readMp4Info(new Uint8Array(await c.blob.arrayBuffer()))));
          return { source: clip.codec, sourceMs: clip.durationMs, chunks: r.chunks.map((c) => [c.frames, c.startMs, c.endMs]), infos: infos.map((i) => [i.codec, i.samples, i.durationMs, i.complete]), capped: r.capped, costUsd: r.costUsd, canvases };
        } finally {
          document.createElement = make;
        }
      });
      assert.equal(got.sourceMs, 80000);
      assert.deepEqual(got.chunks, [[300, 0, 60000], [100, 60000, 80000]]);
      assert.deepEqual(got.infos.map((i) => i[1]), [300, 100], "each chunk's own index has its frames");
      assert.ok(got.infos.every((i) => i[0]?.startsWith("avc1") && i[3]), JSON.stringify(got.infos));
      assert.deepEqual(got.infos.map((i) => i[2]), [60000, 20000]);
      assert.equal(got.capped, false);
      assert.ok(Math.abs(got.costUsd - 0.08) < 1e-9, String(got.costUsd));
      assert.ok(got.canvases <= 1, `${got.canvases} canvases made for 400 frames`);
    } finally {
      await close();
    }
  });

  test("video: Baseline first, and an encoder that reorders frames is swapped, never written out of order", async () => {
    // A stand-in encoder: Main and High give frames back in pairs swapped, as B-frames would; others in order.
    const fake = `
      window.__configured = [];
      window.__unsupported = () => false;
      class FakeEncoder {
        static async isConfigSupported(c) { return { supported: !window.__unsupported(c.codec), config: c }; }
        constructor(init) { this.init = init; this.q = []; this.state = "unconfigured"; }
        get encodeQueueSize() { return 0; }
        configure(c) { this.c = c; this.state = "configured"; window.__configured.push(c.codec); }
        encode(frame, o) { this.q.push({ timestamp: frame.timestamp, duration: frame.duration, key: !!o?.keyFrame }); }
        async flush() {
          const order = this.q.map((_, i) => i);
          if (/^avc1\.(4D|64)/.test(this.c.codec)) for (let i = 1; i + 1 < order.length; i += 2) [order[i], order[i + 1]] = [order[i + 1], order[i]];
          order.forEach((n, k) => {
            const f = this.q[n];
            this.init.output({ byteLength: 5, copyTo: (d) => d.set([0, 0, 0, 1, n]), timestamp: f.timestamp, duration: f.duration, type: f.key ? "key" : "delta" },
              k === 0 ? { decoderConfig: { description: new Uint8Array([1, 0x42, 0xe0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0xe0, 0x1f, 1, 0, 4, 0x68, 0xce, 0x3c, 0x80]) } } : undefined);
          });
        }
        close() { this.state = "closed"; }
      }
      window.VideoEncoder = FakeEncoder;`;
    const { page, close } = await open(js);
    try {
      await page.evaluate(fake);
      const run = (unsupported, codec) =>
        page.evaluate(async ([u, codec]) => {
          window.__configured = [];
          window.__unsupported = (c) => new RegExp(u).test(c);
          const pics = Array.from({ length: 6 }, () => { const c = document.createElement("canvas"); c.width = 1280; c.height = 960; return c; });
          try {
            const v = await Media.imagesToVideo(pics, { fps: 2, ...(codec ? { codec } : {}) });
            return { codec: v.codec, configured: window.__configured, frames: v.frames };
          } catch (e) {
            return { error: e.message, configured: window.__configured };
          }
        }, [unsupported, codec]);
      // 1280x960 is past level 3.1: Baseline at level 4.0, not Main, which the old order chose.
      const baseline = await run("^$");
      assert.deepEqual(baseline.configured, ["avc1.42E028"]);
      assert.equal(baseline.codec, "avc");
      // No Baseline here: Main reorders, so the video is made with VP9 instead of being written out of order.
      const swapped = await run("^avc1\\.42");
      assert.deepEqual(swapped.configured, ["avc1.4D0028", "vp09.00.31.08"]);
      assert.equal(swapped.codec, "vp9");
      // H.264 only (as for SAM) and no Baseline: a plain error, no file.
      const refused = await run("^avc1\\.42", "avc");
      assert.match(refused.error, /out of order/);
      assert.deepEqual(refused.configured, ["avc1.4D0028"]);
    } finally {
      await close();
    }
  });

  test("speech: one sound context made during the tap, and a context the browser won't start falls back in time", async () => {
    const { page, close } = await open();
    try {
      const made = await page.evaluate(async () => {
        const Real = window.AudioContext;
        let n = 0;
        window.AudioContext = class extends Real { constructor(o) { super(o); n++; } };
        const p = Media.speak("Hello there.");
        const during = n;
        await p;
        window.AudioContext = Real;
        return during;
      });
      assert.equal(made, 1, "the AudioContext exists before speak() first waits");
      const stuck = await page.evaluate(async () => {
        const ctx = { state: "suspended", currentTime: 0, sampleRate: 16000, resume: () => new Promise(() => {}), createBuffer: () => ({ duration: 1, getChannelData: () => new Float32Array(16000) }), createBufferSource: () => ({ connect() {}, start() {}, stop() {}, disconnect() {} }), destination: {} };
        async function* one() { yield new Float32Array(16000).fill(0.1); }
        const started = performance.now();
        const out = await Promise.race([
          Media.playSamples(one(), new AbortController(), ctx).then(() => "played", (e) => e.message),
          new Promise((r) => setTimeout(() => r("hung"), 5000)),
        ]);
        return { out, ms: performance.now() - started };
      });
      assert.match(stuck.out, /didn't let the page play sound/);
      assert.ok(stuck.ms < 3000, `${Math.round(stuck.ms)} ms`);
    } finally {
      await close();
    }
  });

  test("speech falls back to the browser's voice when the model's files can't be reached, and says so", async () => {
    const { page, close } = await open();
    try {
      const res = await page.evaluate(() => Media.speak("Hello there."));
      assert.ok(["browser", "none"].includes(res.by), res.by);
      if (res.by === "browser") assert.match(res.note, /couldn't|can't/);
      const recordedBy = await page.evaluate(() => window.__musemuseMedia.speech.by);
      assert.equal(recordedBy, res.by);
      await assert.rejects(page.evaluate(() => Media.speak("x".repeat(601))), /too long to read aloud/);
    } finally {
      await close();
    }
  });

  test("speech reads aloud with the real model from the gateway's files", { skip: process.env.MEDIA_TEST_ASSETS_DIR ? false : "set MEDIA_TEST_ASSETS_DIR to a folder with the vetted files" }, async () => {
    // A real HTTP server for the files (Playwright's route can't carry files this big) and the page, on 127.0.0.1,
    // which the browser treats as a secure origin.
    const http = await import("node:http");
    const { createReadStream, statSync } = await import("node:fs");
    const A = await load("media-assets.ts");
    const byHash = new Map(A.MEDIA_ASSETS.map((a) => [a.sha256, path.join(process.env.MEDIA_TEST_ASSETS_DIR, a.name)]));
    let served = 0;
    const server = http.createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const script = await bundle(`${origin}/assets`);
    server.on("request", (req, res) => {
      const m = req.url.match(/^\/assets\/([0-9a-f]{64})$/);
      if (m && byHash.has(m[1])) {
        served++;
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": statSync(byHash.get(m[1])).size, "access-control-allow-origin": "*" });
        return createReadStream(byHash.get(m[1])).pipe(res);
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE(script));
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/`);
      const started = Date.now();
      await H.expectSpeech(page, { click: "#read", timeoutMs: 300_000 });
      const first = Date.now() - started;
      const s = await page.evaluate(() => window.__musemuseMedia.speech);
      assert.equal(s.by, "model");
      assert.ok(s.samples > 16000, "over a second of audio");
      // The second read comes from the browser's cache: nothing more is downloaded.
      const before = served;
      const again = Date.now();
      await H.expectSpeech(page, { click: "#read", timeoutMs: 120_000 });
      console.log(`speech with the model: ${JSON.stringify(s)}; first read ${first} ms with the download, second ${Date.now() - again} ms; ${served} files served`);
      assert.equal(served, before);
    } finally {
      await context.close();
      server.close();
    }
  });
});
