/**
 * Places a model's dots, boxes and masks on an image. Use it for every shape you draw over a photo, so nothing is
 * scaled twice. Pure math with no imports: it runs in the browser, on the server and in unit tests.
 *
 *   Muse Spark or Muse Wonder points and boxes are usually on a 0 to 1000 grid: units "1000".
 *   Some schemas use 0 to 1 fractions: units "1".
 *   SAM boxes are pixels of the image you sent (the box token's w and h): units "px" with `from` set to that size.
 *
 * Draw in one space and convert once:
 *
 *   const space = { units: "1000", to: natural };          // natural = imageSize(img) after it loads
 *   <svg className="overlay" viewBox={viewBox(natural)}>
 *     {items.map((it) => { const r = toRect(it.box, space); return <rect x={r.x} y={r.y} width={r.width} height={r.height} />; })}
 *   </svg>
 *
 * For dots that are HTML buttons over the image, use `toPercent`, so they stay right at any width.
 */

/** The unit a shape's numbers are in. */
export type OverlayUnits = "1000" | "1" | "px";

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A box as two corners, the way models and SAM return it. */
export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A box ready for an SVG `<rect>` or a CSS frame. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlaySpace {
  /** What the numbers you have are in. */
  units: OverlayUnits;
  /** The pixel size the numbers were given against. Needed for "px" (a SAM box's w and h). */
  from?: Size;
  /** The pixel size you draw in: the image's natural size for an SVG viewBox, or its displayed size. */
  to: Size;
}

function checkSize(size: Size | undefined, what: string): Size {
  if (!size || !(size.width > 0) || !(size.height > 0)) throw new RangeError(`${what} needs a width and height above 0.`);
  return size;
}

/** How many target pixels one unit is, across and down. */
export function overlayScale(space: OverlaySpace): { sx: number; sy: number } {
  const to = checkSize(space.to, "The size to draw in");
  if (space.units === "1000") return { sx: to.width / 1000, sy: to.height / 1000 };
  if (space.units === "1") return { sx: to.width, sy: to.height };
  if (space.units === "px") {
    const from = checkSize(space.from, 'Pixel units ("px")');
    return { sx: to.width / from.width, sy: to.height / from.height };
  }
  throw new RangeError(`Unknown overlay units "${String(space.units)}". Use "1000", "1" or "px".`);
}

/** The largest number a coordinate may be in these units, across and down. */
function unitMax(space: Omit<OverlaySpace, "to">): { mx: number; my: number } {
  if (space.units === "1000") return { mx: 1000, my: 1000 };
  if (space.units === "1") return { mx: 1, my: 1 };
  const from = checkSize(space.from, 'Pixel units ("px")');
  return { mx: from.width, my: from.height };
}

/**
 * Throws when a coordinate can't be in these units, like 597 given as a 0 to 1 fraction. A little past the edge is
 * allowed (models round), and is clamped when drawn.
 */
function checkInUnits(values: number[], space: Omit<OverlaySpace, "to">): void {
  const { mx, my } = unitMax(space);
  values.forEach((v, i) => {
    const max = i % 2 === 0 ? mx : my;
    if (!Number.isFinite(v) || v < -0.02 * max || v > 1.02 * max) {
      throw new RangeError(`${v} is not a coordinate in units "${space.units}" (0 to ${max}). Check which units the model returned.`);
    }
  });
}

const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));

/** A point in target pixels, kept inside the image. */
export function toPoint(point: Point, space: OverlaySpace): Point {
  checkInUnits([point.x, point.y], space);
  const { sx, sy } = overlayScale(space);
  return { x: clamp(point.x * sx, space.to.width), y: clamp(point.y * sy, space.to.height) };
}

/** A box in target pixels, kept inside the image. Corners given in either order come out the right way round. */
export function toRect(box: Box, space: OverlaySpace): Rect {
  checkInUnits([box.x1, box.y1, box.x2, box.y2], space);
  const { sx, sy } = overlayScale(space);
  const left = clamp(Math.min(box.x1, box.x2) * sx, space.to.width);
  const right = clamp(Math.max(box.x1, box.x2) * sx, space.to.width);
  const top = clamp(Math.min(box.y1, box.y2) * sy, space.to.height);
  const bottom = clamp(Math.max(box.y1, box.y2) * sy, space.to.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** CSS `left` and `top` for an element over the image (with `position: absolute` and `translate(-50%, -50%)`). */
export function toPercent(point: Point, space: Omit<OverlaySpace, "to">): { left: string; top: string } {
  const p = toPoint(point, { ...space, to: { width: 100, height: 100 } });
  return { left: `${round(p.x)}%`, top: `${round(p.y)}%` };
}

/** CSS `left`, `top`, `width` and `height` in percent for a box drawn as an HTML element over the image. */
export function toPercentRect(box: Box, space: Omit<OverlaySpace, "to">): { left: string; top: string; width: string; height: string } {
  const r = toRect(box, { ...space, to: { width: 100, height: 100 } });
  return { left: `${round(r.x)}%`, top: `${round(r.y)}%`, width: `${round(r.width)}%`, height: `${round(r.height)}%` };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** The viewBox for an `svg.overlay` drawn in this pixel size, usually the image's natural size. */
export function viewBox(size: Size): string {
  const s = checkSize(size, "A viewBox");
  return `0 0 ${s.width} ${s.height}`;
}

/**
 * A transform for a `<g>` around a SAM mask path, which comes at the mask's own width and height (`decodeMaskToSVGPath`),
 * so it lines up in an overlay drawn at `to`.
 */
export function maskTransform(mask: Size, to: Size): string {
  const { sx, sy } = overlayScale({ units: "px", from: mask, to });
  return `scale(${round(sx)} ${round(sy)})`;
}

/** The middle of a rect. */
export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** An image's natural pixel size (after it has loaded) or the size it is shown at now. Browser only. */
export function imageSize(img: HTMLImageElement, which: "natural" | "displayed" = "natural"): Size {
  if (which === "natural") return { width: img.naturalWidth, height: img.naturalHeight };
  const r = img.getBoundingClientRect();
  return { width: r.width, height: r.height };
}

/**
 * Checks shapes already in pixels of `size`: each box's center is inside the image, has some area, and holds its dot
 * (with `slack`, a share of the image's shorter side, default 5%). Returns plain problems, or [] when all is well.
 * Use it in a unit test on the sample's real output:
 *   assert.deepEqual(overlayProblems(natural, items.map((it) => ({ rect: toRect(it.box, space), dot: toPoint(it.point, space) }))), []);
 */
export function overlayProblems(size: Size, shapes: Array<{ rect?: Rect; dot?: Point }>, slack = 0.05): string[] {
  const s = checkSize(size, "The image size");
  const pad = Math.min(s.width, s.height) * slack;
  const problems: string[] = [];
  shapes.forEach(({ rect, dot }, i) => {
    const n = i + 1;
    if (dot && (dot.x < 0 || dot.y < 0 || dot.x > s.width || dot.y > s.height)) problems.push(`Dot ${n} is outside the image.`);
    if (!rect) return;
    const c = rectCenter(rect);
    if (c.x < 0 || c.y < 0 || c.x > s.width || c.y > s.height) problems.push(`Box ${n}'s center is outside the image.`);
    if (!(rect.width > 0) || !(rect.height > 0)) problems.push(`Box ${n} has no area.`);
    if (dot) {
      const inside = dot.x >= rect.x - pad && dot.x <= rect.x + rect.width + pad && dot.y >= rect.y - pad && dot.y <= rect.y + rect.height + pad;
      if (!inside) problems.push(`Box ${n} is ${Math.round(Math.hypot(c.x - dot.x, c.y - dot.y))} px from its dot.`);
    }
  });
  return problems;
}
