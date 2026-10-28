// Unit tests for the pure helpers in tests/demo-fixtures.ts, the demo video's recorder. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
// or, since Node 22 strips the types itself, from template/: node --test scripts/__tests__/demo-fixtures.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { aimPoint, clampRect, easeInOut, glideMs, jpegSize, typingPlan, uploadNames } from "../../tests/demo-fixtures.ts";

test("easeInOut starts and ends slowly and passes the middle at half", () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(0.5), 0.5);
  assert.equal(easeInOut(1), 1);
  assert.ok(easeInOut(0.1) < 0.1 && easeInOut(0.9) > 0.9);
  for (let p = 0; p < 1; p += 0.05) assert.ok(easeInOut(p + 0.05) >= easeInOut(p));
});

test("glides take 450 to 750 ms by distance", () => {
  assert.equal(glideMs(0), 450);
  assert.equal(glideMs(450), 600);
  assert.equal(glideMs(900), 750);
  assert.equal(glideMs(5000), 750);
  assert.equal(glideMs(-10), 450);
});

test("typing stays near 1.6 s: short text at 45 ms a key, long text faster, never under 8 ms", () => {
  assert.deepEqual(typingPlan("Corner Bakery"), { text: "Corner Bakery", delay: 45 });
  assert.deepEqual(typingPlan("x".repeat(100)), { text: "x".repeat(100), delay: 16 });
  assert.equal(typingPlan("x".repeat(160)).delay, 10);
  assert.deepEqual(typingPlan(""), { text: "", delay: 0 });
});

test("text over 160 characters draws its first 60, and the drawing stops at a line break or a tab", () => {
  const long = `${"a".repeat(100)}${"b".repeat(100)}`;
  assert.equal(typingPlan(long).text, "a".repeat(60));
  assert.equal(typingPlan(long).delay, 1600 / 60);
  assert.equal(typingPlan("first line\nsecond line").text, "first line");
  assert.equal(typingPlan("name\tvalue").text, "name");
  assert.equal(typingPlan("\nstarts with a break").text, "");
});

test("typing counts characters, not UTF-16 units, so an emoji is never cut in half", () => {
  const value = "🥯".repeat(170);
  assert.equal(Array.from(typingPlan(value).text).length, 60);
  assert.equal(typingPlan(value).text, "🥯".repeat(60));
});

test("upload names come from paths, file payloads and lists of either", () => {
  assert.deepEqual(uploadNames("fixtures/receipt.jpg"), ["receipt.jpg"]);
  assert.deepEqual(uploadNames(["fixtures/a.png", { name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("") }]), ["a.png", "b.txt"]);
  assert.deepEqual(uploadNames([]), []);
  assert.deepEqual(uploadNames(null), []);
});

test("clampRect cuts a box to the viewport and rounds it, or gives nothing when it is off screen", () => {
  const vp = { width: 1280, height: 720 };
  assert.deepEqual(clampRect({ x: 10.4, y: 20.6, w: 100.2, h: 40 }, vp), { x: 10, y: 21, w: 100, h: 40 });
  assert.deepEqual(clampRect({ x: -50, y: 600, w: 200, h: 300 }, vp), { x: 0, y: 600, w: 150, h: 120 });
  assert.equal(clampRect({ x: 0, y: 800, w: 100, h: 40 }, vp), undefined);
  assert.equal(clampRect({ x: 1300, y: 0, w: 100, h: 40 }, vp), undefined);
});

/** JPEG markers as Chrome writes them: start of image, an APP0 header, a Huffman table, then the start of frame. */
function jpeg(sof, width, height) {
  const segment = (marker, body) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
  return Uint8Array.from([
    0xff, 0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xc4, new Array(20).fill(0)),
    ...segment(sof, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    0xff, 0xd9,
  ]);
}

test("jpegSize reads the start-of-frame marker, skipping the Huffman table that shares its range", () => {
  assert.deepEqual(jpegSize(jpeg(0xc0, 2560, 1440)), { width: 2560, height: 1440 });
  assert.deepEqual(jpegSize(jpeg(0xc2, 1280, 720)), { width: 1280, height: 720 });
  assert.equal(jpegSize(Buffer.from("not a jpeg at all")), null);
  assert.equal(jpegSize(new Uint8Array([0xff, 0xd8])), null);
});

test("the cursor aims at a box's middle, or at a native file input's button at its left end", () => {
  const vp = { width: 1280, height: 720 };
  assert.deepEqual(aimPoint({ x: 100, y: 200, w: 300, h: 40 }, vp), { x: 250, y: 220 });
  assert.deepEqual(aimPoint({ x: 100, y: 200, w: 300, h: 40 }, vp, true), { x: 148, y: 220 });
  assert.deepEqual(aimPoint({ x: 100, y: 200, w: 60, h: 40 }, vp, true), { x: 130, y: 220 }, "a narrow one at its middle");
  assert.deepEqual(aimPoint({ x: 1200, y: 700, w: 200, h: 40 }, vp), { x: 1240, y: 710 }, "the part on screen");
});
