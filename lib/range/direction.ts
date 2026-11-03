import { z } from "zod";

/**
 * BUILD_RANGE (docs/BUILD_RANGE.md): the design direction a brief picks for its own product, and the checks on it. Only
 * zod here, so lib/brief/schema.ts can import it. The strings are clamped by normalizeDirection, so a long answer doesn't
 * fail the brief.
 */

/** The most screens and flow steps a range brief may have without FULL_BUILDS, which has its own higher limits. */
export const RANGE_LIMITS = { primaryFlow: 12, screens: 12 } as const;

const TEXT_MAX = 300;
const text = z.string().min(1).max(TEXT_MAX);

const FontSchema = z.object({
  /** An npm package of self-hosted fonts, like @fontsource-variable/fraunces. Build machines can reach npm, not Google. */
  package: z.string().min(1).max(100),
  /** The CSS font-family name it installs. */
  family: z.string().min(1).max(60),
});

export const DirectionSchema = z.object({
  /** The idea in one or two plain sentences, and why it fits this product. */
  summary: text,
  scheme: z.enum(["light", "dark", "both"]),
  /** Colors as #rrggbb. Checked by directionProblems. */
  palette: z.object({
    background: z.string(),
    surface: z.string(),
    text: z.string(),
    mutedText: z.string(),
    accent: z.string(),
    onAccent: z.string(),
    secondary: z.string(),
  }),
  displayFont: FontSchema,
  bodyFont: FontSchema,
  density: text,
  layout: text,
  shape: text,
  motion: text,
  imagery: text,
});

export type Direction = z.infer<typeof DirectionSchema>;

/** What a later brief needs to know about an earlier product's direction to look different from it. No product text. */
export interface RecentDirection {
  background: string;
  accent: string;
  displayFamily: string;
}

/**
 * Starting points the brief writer is handed one of, so two similar muses don't land on the same look. A starting point
 * only: the product and its inspo can pull the direction anywhere.
 */
export const DIRECTION_STARTS = [
  "printed editorial: a serif display face on warm paper, a strong column grid, rules and big type instead of cards",
  "dark instrument panel: a near-black ground, a mono or grotesque face, dense data, one vivid signal color",
  "bold poster: large color blocks, a heavy condensed display face, big numbers, sharp corners",
  "soft and tactile: rounded shapes, a friendly rounded face, muted earthy colors, gentle layered shadows",
  "field notebook: an off-white or kraft ground, a slab or typewriter face, tabs and labels, hand-ruled lines",
  "night garden: a deep green, plum or navy ground, an elegant high-contrast serif, a glowing accent",
  "playful stickers: a saturated ground, a chunky display face, tilted tiles, springy motion",
  "calm studio: a stone or sand ground, a humanist sans with a light display weight, wide margins, a two-pane layout",
  "retro terminal or arcade: a dark ground, a pixel or mono face, hard edges, stepped motion",
  "gallery wall: a neutral ground that lets images lead, an elegant small display face, a full-bleed media grid",
  "sunlit market: warm yellows, corals and teals, a bouncy display serif, a dense board of tiles",
  "technical drawing: a blueprint or graph-paper ground, a narrow sans, thin lines, wide tables on desktop",
  // The design-looks skill (template/targets/build-range/files/.agents/skills/design-looks) holds each of these in full.
  "Look: typeset. A terminal printed on paper: monochrome ink on near-white, hairline borders, a light geometric sans with mono labels",
  "Look: notebook. A warm paper notebook: soft hairline cards, one blue action, pastel panels used like sticky notes",
  "Look: journal. A literary journal: cream paper, light tightly tracked display type, a serif for prose, sharp corners, one ember color for links",
  "Look: research-desk. A calm research desk: parchment, a roomy sans, one teal, the main input as the centerpiece, sources shown inline",
  "Look: ledger. A finance ledger: black and white pages, big plain numbers, one highlighter color only where action happens",
  "Look: voltage. Deep forest green and electric lime: heavy display type, pills everywhere, sections that flip dark",
  "Look: classroom. A storybook classroom: chubby rounded type, thick outlines, sticker-like buttons, one green for correct",
  "Look: showcase. A white gallery: the product's output huge in the middle, quiet type around it, big rounded frames",
] as const;

/** The same seed gets the same starting point, and different seeds spread out over the list. */
export function directionStart(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return DIRECTION_STARTS[(h >>> 0) % DIRECTION_STARTS.length];
}

function rgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG contrast of two #rrggbb colors, or null when one isn't. */
export function contrast(a: string, b: string): number | null {
  const lum = (hex: string) => {
    const c = rgb(hex);
    if (!c) return null;
    const [r, g, bl] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [la, lb] = [lum(a), lum(b)];
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function hsl(hex: string): { h: number; s: number; l: number } | null {
  const c = rgb(hex);
  if (!c) return null;
  const [r, g, b] = c.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/** A white or nearly white page with a blue accent: the default look a direction is there to move away from. */
export function isDefaultLook(d: Pick<Direction, "palette">): boolean {
  const bg = hsl(d.palette.background);
  const accent = hsl(d.palette.accent);
  return Boolean(bg && accent && bg.l > 0.96 && accent.h >= 195 && accent.h <= 245 && accent.s > 0.3);
}

const FONT_PACKAGE = /^@fontsource(-variable)?\/[a-z0-9-]+$/;
/** Text pairs below this don't pass WCAG AA for normal text. */
const AA = 4.5;

/**
 * What's worth one repair call. `asked` is the person's own askedLook, which may well be white and blue; a recent product
 * only counts as too close when the display face and the accent both match, so colors alone never block a brief.
 */
export function directionProblems(direction: Direction | null | undefined, opts: { asked?: string | null; recent?: readonly RecentDirection[] } = {}): string[] {
  if (!direction) return ["direction is required: pick one for this product."];
  const out: string[] = [];
  const p = direction.palette;
  for (const [name, value] of Object.entries(p)) if (!rgb(value)) out.push(`direction.palette.${name} must be a #rrggbb color, not "${value}".`);
  if (out.length) return out;
  for (const font of [direction.displayFont, direction.bodyFont]) {
    if (!FONT_PACKAGE.test(font.package)) out.push(`"${font.package}" must be an npm package named @fontsource/<name> or @fontsource-variable/<name>.`);
  }
  for (const [what, a, b] of [["text on background", p.text, p.background], ["text on surface", p.text, p.surface], ["mutedText on background", p.mutedText, p.background], ["onAccent on accent", p.onAccent, p.accent]] as const) {
    const ratio = contrast(a, b);
    if (ratio !== null && ratio < AA) out.push(`direction.palette ${what} has contrast ${ratio.toFixed(1)}, under ${AA}. Change the colors.`);
  }
  if (!opts.asked?.trim() && isDefaultLook(direction)) out.push("direction is the default white page with a blue accent. Pick a palette that belongs to this product.");
  if (!opts.asked?.trim()) {
    const accent = hsl(p.accent);
    const close = (opts.recent ?? []).find((r) => {
      const other = hsl(r.accent);
      return accent && other && r.displayFamily.trim().toLowerCase() === direction.displayFont.family.trim().toLowerCase() && hueGap(accent.h, other.h) < 20;
    });
    if (close) out.push(`direction is too close to a recent product (${close.displayFamily}, accent ${close.accent}). Pick another display face and accent.`);
  }
  return out;
}

const clampText = (v: unknown, max: number) => (typeof v === "string" && v.length > max ? v.slice(0, max).trim() : v);

/** Cuts long strings to the schema's limits and lowercases colors, on the raw JSON before zod. */
export function normalizeDirection(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const d = { ...(raw as Record<string, unknown>) };
  for (const key of ["summary", "density", "layout", "shape", "motion", "imagery"]) d[key] = clampText(d[key], TEXT_MAX);
  if (d.palette && typeof d.palette === "object") {
    d.palette = Object.fromEntries(Object.entries(d.palette).map(([k, v]) => [k, typeof v === "string" ? v.trim().toLowerCase() : v]));
  }
  for (const key of ["displayFont", "bodyFont"]) {
    const font = d[key];
    if (font && typeof font === "object") {
      const f = font as Record<string, unknown>;
      d[key] = { ...f, package: typeof f.package === "string" ? f.package.trim().toLowerCase() : f.package, family: clampText(f.family, 60) };
    }
  }
  return d;
}

/** The earlier products' colors and face, from their stored directions. Anything that doesn't parse is left out. */
export function recentFrom(rows: readonly unknown[]): RecentDirection[] {
  return rows.flatMap((row) => {
    const parsed = DirectionSchema.safeParse(row);
    return parsed.success ? [{ background: parsed.data.palette.background, accent: parsed.data.palette.accent, displayFamily: parsed.data.displayFont.family }] : [];
  });
}
