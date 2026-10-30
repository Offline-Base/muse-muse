/**
 * The SAM recipes' logic on real replies: fixtures/sam-street-person.txt (SAM 3.1, "person" on the street photo,
 * seven people, one_bit masks) and fixtures/sam-street-pan-dog-12f.txt (the first 12 frames of "dog" on the street
 * clip, two tracked dogs), plus fixtures/transcribe-two-voices-diarization.json (asr/transcribe in DIARIZATION mode on
 * the two-voice call). Masks decode with Meta's codec, as on the page.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-media/__tests__/sam-media.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import "@/components/docs/media/mask-decoder";
import { parseSamOutput } from "@/lib/docs/media/sam";
import { decodeMaskRaster } from "@/lib/docs/media/sam-mask";
import {
  frameRanges,
  maskFileName,
  maskSvg,
  samOutcome,
  samRunOutcome,
  summarizeConcept,
  validateSummary,
  wroteLine,
} from "@/components/docs/playgrounds/cookbook-media/sam-summary";
import {
  anchorNear,
  captionChunks,
  chunkAt,
  defaultMapping,
  faceRect,
  headAnchor,
  peopleOf,
  placeBubble,
  smoothAnchors,
  speakersOf,
  speechTurns,
  wrapText,
} from "@/components/docs/playgrounds/cookbook-media/captions";
import { capFrameRate, motionBetween, packManifest, pickWindows, smoothCrops, stickerLength, tracksOf } from "@/components/docs/playgrounds/cookbook-media/sticker";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const PEOPLE = parseSamOutput(fixture("sam-street-person.txt"));
const DOGS = parseSamOutput(fixture("sam-street-pan-dog-12f.txt"));
const DIARIZED = JSON.parse(fixture("transcribe-two-voices-diarization.json"));

describe("SAM summary (the recipe's summary.json)", () => {
  it("summarizes an image: boxes half-open, masks decoded, no tracks", () => {
    const s = summarizeConcept("person", "image", "completed", PEOPLE.records, PEOPLE.diagnostics);
    assert.equal(s.masks.length, 7);
    assert.equal(s.records, 14, "a box record and a mask record per object");
    const front = s.boxes.find((b) => b.object_id === "6")!;
    assert.deepEqual([front.left, front.top, front.right, front.bottom], [261, 239, 445, 755]);
    const mask = s.masks.find((m) => m.object_id === "6")!;
    assert.equal(mask.width, 184);
    assert.equal(mask.height, 516);
    assert.equal(mask.encoding, "one_bit");
    assert.ok(mask.foreground_pixels! > 10_000 && mask.foreground_pixels! < 184 * 516);
    assert.deepEqual(s.tracks, []);
    assert.deepEqual(validateSummary(s), { ok: true, message: '"person": 7 masks.' });
    assert.equal(wroteLine([s]), "Wrote 1 result(s) and 7 mask(s)");
  });

  it("summarizes video tracks with their visibility ranges", () => {
    const s = summarizeConcept("dog", "video", "completed", DOGS.records, DOGS.diagnostics);
    assert.deepEqual(s.tracks.map((t) => [t.object_id, t.first_frame, t.last_frame, t.frames]), [
      ["0", 0, 11, 12],
      ["1", 0, 11, 12],
    ]);
    assert.deepEqual(s.tracks[0].ranges, [[0, 11]]);
    assert.equal(s.masks.length, 24);
    assert.equal(s.boxes[0].frame, 0);
    assert.match(validateSummary(s).message, /2 objects tracked across 12 frames, 24 masks/);
  });

  it("treats zero masks as a valid empty match and failures as failures", () => {
    const empty = summarizeConcept("unicorn", "image", "completed", []);
    assert.deepEqual(validateSummary(empty), { ok: true, message: '"unicorn": a valid empty match (no objects), not an error.' });
    assert.equal(validateSummary(summarizeConcept("dog", "image", "incomplete", PEOPLE.records)).ok, false);
    const broken = parseSamOutput("<0f>0<|box;x1=1;y1=1|>");
    const bad = summarizeConcept("dog", "image", "completed", broken.records, broken.diagnostics);
    assert.match(validateSummary(bad).message, /1 malformed record/);
  });

  it("reads the outcome the way the recipe's validate_result does", () => {
    assert.equal(samOutcome({ httpOk: false, final: null }).outcome, "http_error");
    assert.equal(samOutcome({ httpOk: true, aborted: true, final: null }).outcome, "stopped");
    assert.equal(samOutcome({ httpOk: true, final: null }).outcome, "incomplete");
    assert.equal(samOutcome({ httpOk: true, final: { status: "completed", output: [] } }).outcome, "completed");
    assert.equal(samOutcome({ httpOk: true, final: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }).problem?.includes("max_output_tokens"), true);
    assert.equal(samOutcome({ httpOk: true, final: { status: "failed", error: { message: "boom" } } }).problem, "The response failed: boom.");
    assert.equal(samOutcome({ httpOk: true, final: { status: "completed", output: [{ content: [{ type: "refusal", refusal: "no" }] }] } }).outcome, "refused");
  });

  it("writes a browser-viewable SVG per mask on its frame", () => {
    const r = PEOPLE.records.find((x) => x.objectId === "6")!;
    const svg = maskSvg(r)!;
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1280" height="853" viewBox="0 0 1280 853">/);
    assert.match(svg, /<path d="M[^"]+" transform="translate\(261\.5 239\.5\)"/);
    assert.equal(maskFileName("image", r, "person"), "mask-person-6.svg");
    assert.equal(maskFileName("video", DOGS.records[3]), `mask-${DOGS.records[3].objectId}-f1.svg`);
  });

  it("decodes the default lossless masks too", () => {
    // fixtures/sam-street-dog-lossless.txt: "dog" on the street photo with no metadata, so masks are lossless (~).
    const dogs = parseSamOutput(fixture("sam-street-dog-lossless.txt"));
    const s = summarizeConcept("dog", "image", "completed", dogs.records, dogs.diagnostics);
    assert.deepEqual(s.masks.map((m) => m.encoding), ["lossless", "lossless"]);
    for (const m of s.masks) assert.ok(m.foreground_pixels! > 1000 && m.foreground_pixels! < m.width * m.height);
    assert.ok(maskSvg(dogs.records[0])!.length > 1000);
  });

  it("records what a run found in one line, for the copy prompt", () => {
    assert.equal(samRunOutcome({ ok: true, status: 200, media: "image", records: PEOPLE.records }), "7 matches, each a box and a one_bit mask");
    assert.equal(samRunOutcome({ ok: true, status: 200, media: "image", records: PEOPLE.records.slice(0, 1) }), "1 match, each a box and a one_bit mask");
    assert.equal(samRunOutcome({ ok: true, status: 200, media: "video", records: DOGS.records }), "2 tracked objects across 12 frames, 24 one_bit masks");
    assert.equal(samRunOutcome({ ok: true, status: 200, media: "image", records: [] }), "completed with no matches, a valid empty result");
    assert.equal(samRunOutcome({ ok: false, status: 429, error: "Live demos are limited to 20 runs a minute.", media: "image", records: [] }), "error 429: Live demos are limited to 20 runs a minute.");
    assert.equal(samRunOutcome({ ok: false, status: 0, aborted: true, media: "video", records: DOGS.records }), "stopped before the reply finished");
  });

  it("merges frame numbers into ranges", () => {
    assert.deepEqual(frameRanges([5, 0, 1, 2, 6, 9]), [
      [0, 2],
      [5, 6],
      [9, 9],
    ]);
  });
});

describe("headlocked captions", () => {
  const turns = speechTurns(DIARIZED.turns);

  it("keeps the diarized turns with text and a speaker", () => {
    assert.equal(turns.length, 6);
    assert.deepEqual(speakersOf(turns), ["A", "B"]);
    assert.equal(turns[0].text.startsWith("Hi, thanks for calling Riverside Bikes."), true);
    assert.equal(speechTurns([{ turnId: 1, startMs: 4700, endMs: 4860, transcript: "" }]).length, 0, "empty turns drop out");
  });

  it("splits turns into balanced, timed chunks", () => {
    const chunks = captionChunks(turns, 7);
    const first = chunks.filter((c) => c.turnId === turns[0].turnId);
    assert.ok(first.length >= 2);
    assert.equal(first[0].startMs, turns[0].startMs);
    assert.equal(first.at(-1)!.endMs, turns[0].endMs);
    for (const c of chunks) assert.ok(c.text.split(" ").length <= 7, c.text);
    const at = chunkAt(chunks, turns[1].startMs + 10)!;
    assert.equal(at.speaker, "B");
    assert.equal(chunkAt(chunks, 100), null, "nothing before the first word");
  });

  it("picks the people big enough to caption, largest first, and maps speakers to them", () => {
    const people = peopleOf(PEOPLE.records);
    assert.equal(people[0].id, "6", "the woman in front is the largest");
    assert.ok(people.length >= 3 && people.length <= 7);
    assert.deepEqual(defaultMapping(["A", "B"], people), { A: "6", B: people[1].id });
    assert.equal(peopleOf(PEOPLE.records, 0.05).length, 1, "a higher minimum area keeps only the front person");
  });

  it("finds the head at the top of the mask", () => {
    const r = PEOPLE.records.find((x) => x.objectId === "6")!;
    const decoded = decodeMaskRaster(r.mask);
    assert.ok(decoded.ok);
    const a = headAnchor(decoded.ok ? decoded.raster : null, r.box);
    assert.ok(a.y >= r.box.y1 && a.y < r.box.y1 + 30, `head y ${a.y}`);
    assert.ok(a.x > r.box.x1 && a.x < r.box.x2);
    assert.deepEqual(headAnchor(null, { x1: 10, y1: 20, x2: 30, y2: 80 }), { x: 20, y: 20 });
  });

  it("places a bubble off the speaker's face and clear of others, keeping its side", () => {
    const anchor = { x: 350, y: 240 };
    const box = { x1: 261, y1: 239, x2: 444, y2: 754 };
    const face = faceRect(anchor, box);
    const others = [{ x: 162, y: 277, w: 70, h: 195 }];
    const p = placeBubble({ anchor, size: { w: 220, h: 70 }, frame: { w: 1280, h: 853 }, face, others });
    const hit = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    assert.equal(hit(p.rect, face), false);
    assert.ok(p.rect.x >= 0 && p.rect.y >= 0 && p.rect.x + p.rect.w <= 1280);
    assert.deepEqual(p.tail[2], anchor);
    const again = placeBubble({ anchor: { x: 352, y: 242 }, size: { w: 220, h: 70 }, frame: { w: 1280, h: 853 }, face, others, prefer: p.side });
    assert.equal(again.side, p.side);
  });

  it("follows a tracked person's head across frames of the clip", () => {
    // fixtures/sam-street-pan-people-3f.txt: SAM 3.1 "people" on the street clip, frames 0 to 2, objects 0 and 5 kept.
    const clip = parseSamOutput(fixture("sam-street-pan-people-3f.txt"));
    assert.equal(clip.diagnostics.filter((d) => d.code === "malformed_record").length, 0);
    const woman = clip.records.filter((r) => r.objectId === "5");
    assert.ok(woman.length >= 2, "the woman is tracked on several frames");
    const anchors = new Map(
      woman.map((r) => {
        const res = decodeMaskRaster(r.mask);
        return [r.frame, headAnchor(res.ok ? res.raster : null, r.box)] as const;
      }),
    );
    for (const r of woman) {
      const a = anchors.get(r.frame)!;
      assert.ok(a.x >= r.box.x1 && a.x <= r.box.x2 && a.y >= r.box.y1 && a.y < r.box.y1 + 40, `frame ${r.frame}`);
    }
    const smooth = smoothAnchors(anchors, 1);
    const frames = [...anchors.keys()].sort((x, y) => x - y);
    assert.ok(Math.abs(smooth.get(frames[0])!.x - anchors.get(frames[0])!.x) < 20, "smoothing keeps the bubble near the head");
    assert.deepEqual(peopleOf(clip.records).map((p) => p.id).sort(), ["0", "5"]);
  });

  it("wraps text and smooths anchors across frames", () => {
    assert.deepEqual(wrapText("one two three four", 9, (s) => s.length), ["one two", "three", "four"]);
    const anchors = new Map([
      [0, { x: 0, y: 0 }],
      [1, { x: 10, y: 0 }],
      [2, { x: 20, y: 0 }],
    ]);
    assert.deepEqual(smoothAnchors(anchors, 1).get(1), { x: 10, y: 0 });
    assert.deepEqual(anchorNear(anchors, 5, 3), { x: 20, y: 0 });
    assert.equal(anchorNear(anchors, 50, 3), null);
  });
});

describe("sticker pack", () => {
  it("picks the longest-lived track, ties to the bigger subject", () => {
    const tracks = tracksOf(DOGS.records);
    assert.equal(tracks.length, 2);
    assert.equal(tracks[0].frames, 12);
    assert.ok(tracks[0].meanArea >= tracks[1].meanArea);
    const short = tracksOf([...DOGS.records.filter((r) => r.objectId === "1"), ...DOGS.records.filter((r) => r.objectId === "0" && r.frame < 4)]);
    assert.equal(short[0].id, "1");
  });

  it("smooths square crops around the track", () => {
    const crops = smoothCrops(DOGS.records, "0", { pad: 0.1, smooth: 2 });
    assert.equal(crops.length, 12);
    for (const c of crops) assert.ok(c.side >= 260, `side ${c.side}`);
    const jumps = crops.slice(1).map((c, i) => Math.abs(c.cx - crops[i].cx));
    assert.ok(Math.max(...jumps) < 20, "the crop glides");
  });

  it("caps the frame rate", () => {
    const frames = Array.from({ length: 120 }, (_, i) => i);
    assert.deepEqual(capFrameRate(frames, 24, 15).fps, 12);
    assert.equal(capFrameRate(frames, 24, 15).frames.length, 60);
    assert.equal(capFrameRate(frames, 12, 15).step, 1);
  });

  it("scores motion and picks the busiest window in each third", () => {
    const a = new Uint8ClampedArray([10, 10, 10, 255, 0, 0, 0, 0]);
    const b = new Uint8ClampedArray([30, 10, 10, 255, 0, 0, 0, 0]);
    assert.equal(motionBetween(a, b), 5);
    assert.equal(motionBetween(a, a), 0);
    const scores = [0, 1, 1, 9, 9, 1, 1, 1, 1, 5, 5, 1];
    const w = pickWindows(scores, 3, 3);
    assert.deepEqual(w.map((x) => [x.start, x.end, x.third]), [
      [1, 4, 0],
      [4, 7, 1],
      [8, 11, 2],
    ]);
    assert.equal(w[0].motion, 10);
  });

  it("keeps each sticker short enough that every third still has windows to choose from", () => {
    // The sample: 120 source frames at 24 fps, capped to 60 at 12 fps. A 2.5 s sticker (30 frames) would fill the
    // 20-frame third, so the motion score couldn't pick anything; it gets 15 frames, leaving 6 windows per third.
    const sample = stickerLength(60, 12, 2.5);
    assert.deepEqual(sample, { frames: 15, shortened: true });
    const scores = Array.from({ length: 60 }, (_, i) => (i % 20 === 17 ? 50 : 1));
    const windows = pickWindows(scores, 3, sample.frames);
    assert.ok(windows.every((w) => w.end - w.start === 15));
    assert.deepEqual(windows.map((w) => w.start), [3, 23, 43], "each window moves to take its third's burst of motion");
    // The recipe's 10 s clip (120 kept frames at 12 fps) keeps full 2.5 s stickers.
    assert.deepEqual(stickerLength(120, 12, 2.5), { frames: 30, shortened: false });
  });

  it("writes a WhatsApp-style manifest", () => {
    const m = packManifest({ name: "Dog stickers", stickers: [{ file: "sticker-01.webp" }], tray: "tray.png" });
    assert.equal(m.identifier, "dog-stickers");
    assert.equal(m.animated_sticker_pack, true);
    assert.deepEqual(m.stickers[0].image_file, "sticker-01.webp");
  });
});
