// Unit tests for lib/client/overlay.ts, the one helper for dots, boxes and masks over an image. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/overlay.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { maskTransform, overlayProblems, overlayScale, rectCenter, toPercent, toPercentRect, toPoint, toRect, viewBox } from "../../lib/client/overlay";

// The Nov 3 audit's fridge item: its dot and box, both on the model's 0 to 1000 grid.
const FRIDGE = { point: { x: 710, y: 706 }, box: { x1: 597, y1: 569, x2: 824, y2: 843 } };

test("a 0 to 1000 box lands at the same scale as its dot, in a 1000 viewBox and in the photo's own pixels", () => {
  const grid = { units: "1000", to: { width: 1000, height: 1000 } };
  assert.deepEqual(toRect(FRIDGE.box, grid), { x: 597, y: 569, width: 227, height: 274 });
  assert.deepEqual(toPoint(FRIDGE.point, grid), { x: 710, y: 706 });

  const photo = { units: "1000", to: { width: 1600, height: 1200 } };
  const r = toRect(FRIDGE.box, photo);
  assert.ok(Math.abs(r.x - 955.2) < 1e-9 && Math.abs(r.y - 682.8) < 1e-9 && Math.abs(r.width - 363.2) < 1e-9 && Math.abs(r.height - 328.8) < 1e-9);
  assert.deepEqual(overlayProblems(photo.to, [{ rect: r, dot: toPoint(FRIDGE.point, photo) }]), []);
  assert.equal(viewBox(photo.to), "0 0 1600 1200");
});

test("the audit's bug, a box divided by 10 a second time, is caught: its center is far from its dot", () => {
  const size = { width: 1000, height: 1000 };
  const shrunk = { x: 59.7, y: 56.9, width: 22.7, height: 27.4 };
  const problems = overlayProblems(size, [{ rect: shrunk, dot: { x: 710, y: 706 } }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^Box 1 is \d+ px from its dot\.$/);
});

test("0 to 1 fractions and percent positions agree with the 0 to 1000 grid", () => {
  const frac = { x1: 0.597, y1: 0.569, x2: 0.824, y2: 0.843 };
  const a = toRect(frac, { units: "1", to: { width: 800, height: 600 } });
  const b = toRect(FRIDGE.box, { units: "1000", to: { width: 800, height: 600 } });
  for (const k of ["x", "y", "width", "height"]) assert.ok(Math.abs(a[k] - b[k]) < 1e-9, k);
  assert.deepEqual(toPercent(FRIDGE.point, { units: "1000" }), { left: "71%", top: "70.6%" });
  assert.deepEqual(toPercentRect(FRIDGE.box, { units: "1000" }), { left: "59.7%", top: "56.9%", width: "22.7%", height: "27.4%" });
});

test("SAM pixel boxes map from the size that was sent to the size that is drawn", () => {
  // A box token from meta-sam: <|box;x1=510;y1=265;x2=674;y2=408;w=800;h=600|>, drawn over the 1600 x 1200 original.
  const r = toRect({ x1: 510, y1: 265, x2: 674, y2: 408 }, { units: "px", from: { width: 800, height: 600 }, to: { width: 1600, height: 1200 } });
  assert.deepEqual(r, { x: 1020, y: 530, width: 328, height: 286 });
  assert.deepEqual(rectCenter(r), { x: 1184, y: 673 });
  assert.equal(maskTransform({ width: 800, height: 600 }, { width: 1600, height: 1200 }), "scale(2 2)");
  assert.throws(() => overlayScale({ units: "px", to: { width: 10, height: 10 } }), /Pixel units/);
});

test("corners in either order come out right, and shapes a little past the edge are kept inside the image", () => {
  const space = { units: "1000", to: { width: 500, height: 500 } };
  assert.deepEqual(toRect({ x1: 800, y1: 900, x2: 200, y2: 100 }, space), { x: 100, y: 50, width: 300, height: 400 });
  assert.deepEqual(toRect({ x1: -5, y1: 0, x2: 1010, y2: 1000 }, space), { x: 0, y: 0, width: 500, height: 500 });
  assert.deepEqual(toPoint({ x: 1004, y: -3 }, space), { x: 500, y: 0 });
});

test("numbers that can't be in the stated units throw, so a wrong guess fails in a test, not on screen", () => {
  assert.throws(() => toRect(FRIDGE.box, { units: "1", to: { width: 100, height: 100 } }), /not a coordinate in units "1"/);
  assert.throws(() => toPoint({ x: 1600, y: 10 }, { units: "1000", to: { width: 100, height: 100 } }), /0 to 1000/);
  assert.throws(() => toPoint({ x: Number.NaN, y: 10 }, { units: "1000", to: { width: 100, height: 100 } }));
  assert.throws(() => toPoint({ x: 1, y: 1 }, { units: "1000", to: { width: 0, height: 100 } }), /width and height/);
});

test("overlayProblems names a box with no area, a box off the image and a dot off the image", () => {
  const size = { width: 100, height: 100 };
  assert.deepEqual(
    overlayProblems(size, [{ rect: { x: 10, y: 10, width: 0, height: 5 } }, { rect: { x: 150, y: 10, width: 20, height: 20 } }, { dot: { x: -4, y: 50 } }]),
    ["Box 1 has no area.", "Box 2's center is outside the image.", "Dot 3 is outside the image."],
  );
  // A dot just past its box's edge, within the slack, is fine: models' dots and boxes don't agree to the pixel.
  assert.deepEqual(overlayProblems(size, [{ rect: { x: 40, y: 40, width: 20, height: 20 }, dot: { x: 63, y: 50 } }]), []);
});
