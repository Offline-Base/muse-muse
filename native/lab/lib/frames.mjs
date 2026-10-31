// The clip's backdrop and generic device frames, drawn in code so no device maker's imagery ships with the lab. The
// result is one 1920x1080 RGBA layer: the Meta-blue backdrop, a soft shadow and the device body, with a transparent hole
// where the recording shows through. Pure.

export const CANVAS = { w: 1920, h: 1080 };

/** Where the two lines of the caption sit. */
export const CAPTION = { titleY: 954, titleSize: 42, noteY: 1012, noteSize: 22 };

const PHONE = { top: 36, maxHeight: 890, bezel: 14, screenRadius: 40 };
const DESKTOP = { top: 44, maxWidth: 1500, maxHeight: 850, bezel: 12, screenRadius: 10 };
const BODY_COLOR = [28, 30, 33];
const RIM_COLOR = [64, 68, 74];

const even = (v) => Math.max(2, Math.round(v / 2) * 2);

/**
 * Where the recording and the device body go.
 *
 * @param {"phone" | "desktop"} form
 * @param {number} srcW the recording's width
 * @param {number} srcH the recording's height
 */
export function layoutFor(form, srcW, srcH) {
  const aspect = srcW > 0 && srcH > 0 ? srcW / srcH : form === "phone" ? 9 / 19.5 : 16 / 10;
  const spec = form === "phone" ? PHONE : DESKTOP;
  const maxW = form === "phone" ? CANVAS.w - 2 * spec.bezel : DESKTOP.maxWidth;
  let h = spec.maxHeight - 2 * spec.bezel;
  let w = h * aspect;
  if (w > maxW) {
    w = maxW;
    h = w / aspect;
  }
  w = even(w);
  h = even(h);
  const bodyW = w + 2 * spec.bezel;
  const bodyH = h + 2 * spec.bezel;
  const bodyX = even((CANVAS.w - bodyW) / 2);
  const bodyY = spec.top + Math.max(0, even((spec.maxHeight - bodyH) / 2));
  return {
    form,
    screen: { x: bodyX + spec.bezel, y: bodyY + spec.bezel, w, h, radius: spec.screenRadius },
    body: { x: bodyX, y: bodyY, w: bodyW, h: bodyH, radius: spec.screenRadius + spec.bezel },
  };
}

/** Distance from a point to a rounded box. Negative inside. */
function roundedBoxDistance(px, py, box) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const qx = Math.abs(px - cx) - box.w / 2 + box.radius;
  const qy = Math.abs(py - cy) - box.h / 2 + box.radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - box.radius;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;

/** The Meta-blue backdrop at one pixel: a diagonal gradient with a soft light from the top. */
function backdropAt(x, y) {
  const t = clamp01((x / CANVAS.w) * 0.34 + (y / CANVAS.h) * 0.94 - 0.06);
  const stops = t < 0.52 ? [[0, 130, 251], [0, 100, 224], t / 0.52] : [[0, 100, 224], [0, 85, 196], (t - 0.52) / 0.48];
  const glow = 0.3 * clamp01(1 - Math.hypot((x - CANVAS.w / 2) / 1200, (y + 108) / 640));
  return [0, 1, 2].map((i) => lerp(stops[0][i], stops[1][i], stops[2]) + (255 - lerp(stops[0][i], stops[1][i], stops[2])) * glow);
}

/**
 * The layer, as raw RGBA, row by row. A little fixed grain keeps the gradient from banding in H.264.
 *
 * @param {ReturnType<typeof layoutFor>} layout
 * @returns {Buffer}
 */
export function renderFrameLayer(layout) {
  const { w, h } = CANVAS;
  const out = Buffer.alloc(w * h * 4);
  const shadowBox = { ...layout.body, y: layout.body.y + 22 };
  const reach = 70;
  let seed = 12345;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const grain = (seed >>> 24) / 255 - 0.5;
      const px = x + 0.5;
      const py = y + 0.5;
      let [r, g, b] = backdropAt(px, py);
      r += grain * 1.6;
      g += grain * 1.6;
      b += grain * 1.6;

      let alpha = 255;
      const nearBody =
        px > layout.body.x - reach &&
        px < layout.body.x + layout.body.w + reach &&
        py > layout.body.y - reach &&
        py < layout.body.y + layout.body.h + reach + 22;
      if (nearBody) {
        const shadow = clamp01(1 - roundedBoxDistance(px, py, shadowBox) / reach);
        const dim = 1 - 0.42 * shadow * shadow;
        r *= dim;
        g *= dim;
        b *= dim;
        const inBody = clamp01(0.5 - roundedBoxDistance(px, py, layout.body));
        if (inBody > 0) {
          const edge = clamp01(1 - Math.abs(roundedBoxDistance(px, py, layout.body) + 1.5) / 1.5);
          const color = BODY_COLOR.map((c, i) => lerp(c, RIM_COLOR[i], edge));
          r = lerp(r, color[0], inBody);
          g = lerp(g, color[1], inBody);
          b = lerp(b, color[2], inBody);
        }
        const hole = clamp01(0.5 - roundedBoxDistance(px, py, layout.screen));
        alpha = Math.round(255 * (1 - hole));
      }

      const at = (y * w + x) * 4;
      out[at] = Math.min(255, Math.max(0, Math.round(r)));
      out[at + 1] = Math.min(255, Math.max(0, Math.round(g)));
      out[at + 2] = Math.min(255, Math.max(0, Math.round(b)));
      out[at + 3] = alpha;
    }
  }
  return out;
}
