/**
 * Perception grounding results for overlays. Muse Spark reports positions on a 0 to 1000 grid of the image it got
 * (image-understanding, Localize objects), in the shapes the docs prompt for: `{label, box: [x_min, y_min, x_max,
 * y_max]}`, `{object_name, bbox: [{x_min, ...}]}`, `{object_name, x, y}` and `{object_name, points: [...], count}`.
 * This finds those in a reply and converts them to image pixels.
 */

export type GridShape =
  | { kind: "box"; label: string; x1: number; y1: number; x2: number; y2: number }
  | { kind: "point"; label: string; x: number; y: number };

/** A shape in image pixels, as MaskOverlay draws it. */
export type PixelShape =
  | { kind: "box"; label?: string; x1: number; y1: number; x2: number; y2: number; group?: string }
  | { kind: "point"; label?: string; x: number; y: number; negative?: boolean; group?: string };

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The first JSON value in a reply, allowing code fences and prose around it. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const trimmed = c.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall back to the outermost bracketed span.
    }
    // Try the bracket that opens first, so {"box": [...]} isn't read as just its inner array.
    const pairs = [
      ["[", "]"],
      ["{", "}"],
    ] as const;
    const firstOf = (open: string) => (trimmed.includes(open) ? trimmed.indexOf(open) : Infinity);
    for (const [open, close] of [...pairs].sort((a, b) => firstOf(a[0]) - firstOf(b[0]))) {
      const a = trimmed.indexOf(open);
      const b = trimmed.lastIndexOf(close);
      if (a >= 0 && b > a) {
        try {
          return JSON.parse(trimmed.slice(a, b + 1));
        } catch {
          // keep looking
        }
      }
    }
  }
  return null;
}

/** Every box and point in a grounding reply, still on the 0 to 1000 grid. */
export function groundingShapes(value: unknown): GridShape[] {
  const out: GridShape[] = [];
  const visit = (v: unknown, label: string) => {
    if (Array.isArray(v)) {
      if (v.length === 4 && v.every(num)) {
        const [x1, y1, x2, y2] = v as number[];
        out.push({ kind: "box", label, x1, y1, x2, y2 });
        return;
      }
      if (v.length === 2 && v.every(num)) {
        out.push({ kind: "point", label, x: v[0] as number, y: v[1] as number });
        return;
      }
      for (const item of v) visit(item, label);
      return;
    }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const name = [o.label, o.object_name, o.name, o.object].find((x) => typeof x === "string") as string | undefined;
    const here = name ?? label;
    if (num(o.x_min) && num(o.y_min) && num(o.x_max) && num(o.y_max)) {
      out.push({ kind: "box", label: here, x1: o.x_min, y1: o.y_min, x2: o.x_max, y2: o.y_max });
    } else if (num(o.x) && num(o.y)) {
      out.push({ kind: "point", label: here, x: o.x, y: o.y });
    }
    for (const key of ["box", "bbox", "boxes", "bbox_2d", "points", "point", "results", "objects", "items"]) {
      if (key in o) visit(o[key], here);
    }
  };
  visit(value, "");
  return out;
}

/** Grid values to pixels for the image that was sent, clamped (the model can return 1001 at an edge). */
export function gridToPixels(shapes: readonly GridShape[], width: number, height: number): PixelShape[] {
  const px = (v: number, size: number) => Math.round((Math.min(1000, Math.max(0, v)) * size) / 1000);
  return shapes.map((s) =>
    s.kind === "box"
      ? {
          kind: "box",
          label: s.label || undefined,
          x1: px(Math.min(s.x1, s.x2), width),
          y1: px(Math.min(s.y1, s.y2), height),
          x2: px(Math.max(s.x1, s.x2), width),
          y2: px(Math.max(s.y1, s.y2), height),
          group: s.label || undefined,
        }
      : { kind: "point", label: s.label || undefined, x: px(s.x, width), y: px(s.y, height), group: s.label || undefined },
  );
}
