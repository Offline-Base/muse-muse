import { asObject } from "@/components/docs/playgrounds/cookbook-use-cases/lib/strict-json";

/**
 * cookbook/generating-slides: topic, then web search research, then a JSON outline, then a deck. The recipe
 * normalizes the outline because models vary the key names ("points" or "bullets", "heading" or "title"); this does
 * the same and says what it renamed. The prompts follow the recipe's three stages.
 */

export interface SlideSource {
  url: string;
  title: string;
}

export interface Slide {
  title: string;
  bullets: string[];
  code: { language: string; code: string } | null;
  notes: string;
  sources: SlideSource[];
}

export interface Outline {
  title: string;
  subtitle: string;
  slides: Slide[];
}

export const RESEARCH_INSTRUCTIONS =
  "You research a topic for a short slide deck. Use web search from 3 to 5 different angles (what it is, recent developments, numbers, real examples, risks and open problems); you decide the queries. Then write a research brief: 8 to 12 bullet facts, with numbers where you have them, each followed by its source URL.";

export const OUTLINE_INSTRUCTIONS = [
  "Turn the material into a slide deck outline. Return ONLY one JSON object, no markdown fences:",
  '{"title": string, "subtitle": string, "slides": [{"title": string, "bullets": [string], "code": {"language": string, "code": string} or null, "notes": string, "sources": [string]}]}',
  "Write 6 to 8 content slides (no title slide; the deck adds one). Bullets under 15 words, 3 to 5 per slide. Add a short code block only where it helps an engineer. sources are the URLs a slide's facts came from.",
].join("\n");

export const DESIGN_INSTRUCTIONS =
  "Generate the full HTML presentation for this outline: one self-contained file. You may load reveal.js 5 from https://cdn.jsdelivr.net/npm/reveal.js@5/dist/ (reveal.css, a theme, reveal.js) or write your own slides; arrow keys must move between slides. You have creative control over the visual design: layout, color, type, and how code and sources appear. Return only the HTML, starting with <!DOCTYPE html>.";

const pick = (o: Record<string, unknown>, keys: string[]): { key: string; value: unknown } | null => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return { key: k, value: o[k] };
  return null;
};

function strings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : asObject(x) ? String(asObject(x)!.text ?? asObject(x)!.point ?? JSON.stringify(x)) : String(x))).filter((s) => s.trim());
  if (typeof v === "string") return v.split(/\n+/).map((s) => s.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean);
  return [];
}

function sourcesOf(v: unknown): SlideSource[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\s+/) : [];
  const out: SlideSource[] = [];
  for (const s of list) {
    const o = asObject(s);
    const url = typeof s === "string" ? s : typeof o?.url === "string" ? o.url : "";
    if (!/^https?:\/\//.test(url)) continue;
    out.push({ url, title: typeof o?.title === "string" ? o.title : url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] });
  }
  return out;
}

/** The outline in one shape, with notes on every key it had to rename. */
export function normalizeOutline(value: unknown): { outline: Outline; renamed: string[] } {
  const renamed: string[] = [];
  const note = (found: string, wanted: string) => {
    if (found !== wanted && !renamed.includes(`${found} -> ${wanted}`)) renamed.push(`${found} -> ${wanted}`);
  };
  const root = asObject(value) ?? (Array.isArray(value) ? { slides: value } : {});
  const title = pick(root, ["title", "deck_title", "presentation_title", "topic", "name"]);
  if (title) note(title.key, "title");
  const subtitle = pick(root, ["subtitle", "tagline", "summary", "description"]);
  if (subtitle) note(subtitle.key, "subtitle");
  const slidesRaw = pick(root, ["slides", "sections", "outline", "content", "pages"]);
  if (slidesRaw) note(slidesRaw.key, "slides");
  const slides: Slide[] = (Array.isArray(slidesRaw?.value) ? slidesRaw.value : [])
    .map((raw) => asObject(raw))
    .filter((s): s is Record<string, unknown> => !!s)
    .map((s) => {
      const t = pick(s, ["title", "heading", "slide_title", "header", "name"]);
      if (t) note(t.key, "title");
      const b = pick(s, ["bullets", "points", "bullet_points", "key_points", "content", "body", "items"]);
      if (b) note(b.key, "bullets");
      const c = pick(s, ["code", "code_block", "codeBlock", "snippet", "example"]);
      if (c) note(c.key, "code");
      const n = pick(s, ["notes", "speaker_notes", "speakerNotes"]);
      if (n) note(n.key, "notes");
      const src = pick(s, ["sources", "citations", "references", "links", "urls"]);
      if (src) note(src.key, "sources");
      const co = asObject(c?.value);
      const code =
        typeof c?.value === "string" && c.value.trim()
          ? { language: "", code: c.value }
          : co && typeof (co.code ?? co.content) === "string"
            ? { language: String(co.language ?? co.lang ?? ""), code: String(co.code ?? co.content) }
            : null;
      return {
        title: String(t?.value ?? "Untitled"),
        bullets: strings(b?.value).slice(0, 8),
        code,
        notes: typeof n?.value === "string" ? n.value : "",
        sources: sourcesOf(src?.value),
      };
    });
  return { outline: { title: String(title?.value ?? "Untitled deck"), subtitle: String(subtitle?.value ?? ""), slides }, renamed };
}

/** Every source in the deck once, in the order they appear. */
export function deckSources(outline: Outline): SlideSource[] {
  const seen = new Set<string>();
  const out: SlideSource[] = [];
  for (const s of outline.slides) {
    for (const src of s.sources) {
      if (seen.has(src.url)) continue;
      seen.add(src.url);
      out.push(src);
    }
  }
  return out;
}

/** The `*_slides.html` file name the recipe writes for a topic. */
export function deckFileName(topic: string): string {
  return `${topic.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60) || "deck"}_slides.html`;
}
