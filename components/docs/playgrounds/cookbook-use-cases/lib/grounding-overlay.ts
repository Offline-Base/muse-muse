import { asObject } from "@/components/docs/playgrounds/cookbook-use-cases/lib/strict-json";

/**
 * cookbook/perception-grounding: one image and a dietary prompt in, a dot on every food out. Positions use Muse
 * Spark's normalized 0 to 1000 grid of the image it was sent (image-understanding, "Coordinate system"). This module
 * holds the schema the points call answers with, the clean-up the recipe's prompt asks for ("don't duplicate dots"),
 * where a tooltip goes so it stays inside the image, and the self-contained HTML overlay to download.
 */

export interface FoodPoint {
  name: string;
  x: number;
  y: number;
  recommended: boolean;
  health_score: number;
  justification: string;
  calories: number;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
}

/** The recipe's default prompt, word for word. */
export const DEFAULT_DIET_PROMPT =
  'I am pescatarian with high cholesterol. Put green dots on recommended food and red dots on not recommended food. Don\'t duplicate dots and make sure the dots are localized properly. When hovering over the dot, show personalized justification and "health score" out of 10, along with calories and carbs, protein, and fat. Health score numbers should appear right above the dot without hovering. The description that shows when hovering should go above all other dots.';

/** Strict JSON schema for the points call. */
export function foodSchema(): Record<string, unknown> {
  const num = { type: "number" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "x", "y", "recommended", "health_score", "justification", "calories", "carbs_g", "protein_g", "fat_g"],
          properties: {
            name: { type: "string" },
            x: { type: "integer", description: "0 to 1000, left to right" },
            y: { type: "integer", description: "0 to 1000, top to bottom" },
            recommended: { type: "boolean" },
            health_score: { type: "integer", description: "0 to 10" },
            justification: { type: "string" },
            calories: num,
            carbs_g: num,
            protein_g: num,
            fat_g: num,
          },
        },
      },
    },
  };
}

/** The instructions for the points call: the reader's dietary prompt, plus the output shape and the grid. */
export function pointsPrompt(diet: string): string {
  return [
    diet.trim(),
    "",
    "Find every distinct food item in the image and put one point at the center of each, on the normalized 0-1000 grid of this image ((0,0) top-left, (1000,1000) bottom-right).",
    "For each item give: name, x, y, recommended (true for a green dot, false for red), health_score out of 10 for this person, a one-sentence personalized justification, and calories, carbs_g, protein_g and fat_g for a typical serving.",
    "One point per item: don't duplicate items, and place each point on the item itself.",
  ].join("\n");
}

/** The instructions for the recipe's own one-call mode: the model writes the whole overlay page. */
export function htmlPrompt(diet: string, width: number, height: number): string {
  return [
    diet.trim(),
    "",
    `Generate one complete, self-contained HTML file with this ${width} x ${height} image and an interactive overlay. Show the image with <img src="IMAGE_SRC"> exactly (the script puts the photo there), in a container that keeps its aspect ratio.`,
    "Position each dot with left and top in percent of the image, from where the food is in the image. Use inline CSS and JavaScript only, no external files.",
    "Return only the HTML, starting with <!DOCTYPE html>.",
  ].join("\n");
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Items from a reply, sanitized and clamped to the grid. */
export function readFoodPoints(value: unknown): FoodPoint[] {
  const o = asObject(value);
  const list = Array.isArray(o?.items) ? o.items : Array.isArray(value) ? value : [];
  return list
    .map((raw) => asObject(raw))
    .filter((r): r is Record<string, unknown> => !!r && typeof r.name === "string")
    .map((r) => ({
      name: String(r.name).slice(0, 60),
      x: clamp(Math.round(num(r.x)), 0, 1000),
      y: clamp(Math.round(num(r.y)), 0, 1000),
      recommended: r.recommended === true || r.recommended === "true",
      health_score: clamp(Math.round(num(r.health_score, 5)), 0, 10),
      justification: String(r.justification ?? "").slice(0, 400),
      calories: Math.max(0, Math.round(num(r.calories))),
      carbs_g: Math.max(0, Math.round(num(r.carbs_g) * 10) / 10),
      protein_g: Math.max(0, Math.round(num(r.protein_g) * 10) / 10),
      fat_g: Math.max(0, Math.round(num(r.fat_g) * 10) / 10),
    }));
}

/**
 * Drops repeats the prompt asked the model not to make: the same name twice, or two points closer than `minGap` on
 * the grid with the same name stem. Returns what stayed and how many went.
 */
export function dedupePoints(points: FoodPoint[], minGap = 25): { points: FoodPoint[]; removed: number } {
  const kept: FoodPoint[] = [];
  const stem = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "").replace(/(es|s)$/, "");
  for (const p of points) {
    const dup = kept.some((k) => stem(k.name) === stem(p.name) && (Math.hypot(k.x - p.x, k.y - p.y) < minGap * 4 || k.name.toLowerCase() === p.name.toLowerCase()));
    if (!dup) kept.push(p);
  }
  return { points: kept, removed: points.length - kept.length };
}

/**
 * Where a tooltip of size w x h goes for a dot at (px, py) in a frame of fw x fh pixels: above the dot when it fits,
 * else below, and slid sideways so it stays inside the frame (the recipe's "smart" tooltips).
 */
export function tooltipBox(px: number, py: number, w: number, h: number, fw: number, fh: number, gap = 16): { left: number; top: number } {
  const left = clamp(px - w / 2, 4, Math.max(4, fw - w - 4));
  const above = py - h - gap;
  const top = above >= 4 ? above : clamp(py + gap, 4, Math.max(4, fh - h - 4));
  return { left: Math.round(left), top: Math.round(top) };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** The self-contained overlay page: the photo as a data URL, one dot per item, scores above, tooltips on hover. */
export function overlayHtml(points: FoodPoint[], imageDataUrl: string, title = "Food overlay"): string {
  const dots = points
    .map((p, i) => {
      const color = p.recommended ? "#1f9d55" : "#d93025";
      const flip = p.y < 260 ? " below" : "";
      const side = p.x < 180 ? " left" : p.x > 820 ? " right" : "";
      return `<div class="dot" style="left:${p.x / 10}%;top:${p.y / 10}%;background:${color}" tabindex="0" aria-label="${esc(p.name)}, health score ${p.health_score} of 10">
  <span class="score">${p.health_score}/10</span>
  <div class="tip${flip}${side}" role="tooltip" id="tip${i}"><strong>${esc(p.name)}</strong>${esc(p.justification)}<br><span>${p.calories} kcal · ${p.carbs_g} g carbs · ${p.protein_g} g protein · ${p.fat_g} g fat</span></div>
</div>`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { margin: 0; padding: 24px; background: #111; font-family: system-ui, sans-serif; color: #fff; }
  .frame { position: relative; display: inline-block; max-width: 100%; }
  .frame img { display: block; max-width: 100%; height: auto; border-radius: 10px; }
  .dot { position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 1px 4px rgba(0,0,0,.5); cursor: pointer; z-index: 1; }
  .dot:hover, .dot:focus { z-index: 10; outline: none; }
  .score { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); padding: 0 6px; border-radius: 6px; background: rgba(17,17,18,.8); font-size: 12px; font-weight: 700; white-space: nowrap; }
  .tip { display: none; position: absolute; left: 50%; bottom: 44px; transform: translateX(-50%); width: 240px; padding: 10px 12px; border-radius: 10px; background: rgba(17,17,18,.94); font-size: 13px; line-height: 1.45; }
  .tip strong { display: block; margin-bottom: 4px; font-size: 14px; }
  .tip span { opacity: .8; font-size: 12px; }
  .tip.below { bottom: auto; top: 26px; }
  .tip.left { left: -4px; transform: none; }
  .tip.right { left: auto; right: -4px; transform: none; }
  .dot:hover .tip, .dot:focus .tip { display: block; }
  p { opacity: .7; font-size: 13px; }
</style>
</head>
<body>
<div class="frame">
<img src="${imageDataUrl}" alt="${esc(title)}">
${dots}
</div>
<p>Green: recommended. Red: maybe skip. Hover or focus a dot for the details. Made with Muse Spark perception grounding.</p>
</body>
</html>
`;
}
