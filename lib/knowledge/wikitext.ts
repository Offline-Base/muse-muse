/**
 * Just enough wikitext handling to turn Wikipedia's current-events pages and article text into plain sentences, with
 * the article links and news sources pulled out. It isn't a full parser: templates it doesn't know are dropped.
 */

/** {{convert}} unit codes that don't read as words. Others (km, mi, kg) are left as written. */
const UNITS: Record<string, string> = {
  e6oilbbl: "million barrels",
  oilbbl: "barrels",
  km2: "square kilometres",
  sqmi: "square miles",
  "km/h": "km/h",
  mph: "mph",
  c: "°C",
  f: "°F",
  e3t: "thousand tonnes",
  e6t: "million tonnes",
  e6m3: "million cubic metres",
};

/** Templates whose text is kept: the last positional argument for wrappers, the number and unit for convert. */
function templateText(inner: string): string {
  const parts = inner.split("|").map((p) => p.trim());
  const name = parts[0].toLowerCase().replace(/_/g, " ");
  const positional = parts.slice(1).filter((p) => !/^[a-z_ -]+=/i.test(p));
  if (name === "convert" || name === "cvt") {
    const [value, unit = ""] = positional;
    return [value, UNITS[unit.toLowerCase()] ?? unit].filter(Boolean).join(" ");
  }
  if (["nowrap", "nobr", "lang", "transl", "small", "nobold", "noitalic", "smallcaps"].includes(name) || name.startsWith("lang-")) {
    return positional[positional.length - 1] ?? "";
  }
  if (name === "ill" || name === "interlanguage link") return positional[0] ?? "";
  if (name === "date" || name === "dts") return positional.join(" ");
  return "";
}

/** Removes templates, innermost first, so nested ones go cleanly. */
function stripTemplates(text: string): string {
  let out = text;
  for (let pass = 0; pass < 20; pass++) {
    const next = out.replace(/\{\{([^{}]*)\}\}/g, (_, inner: string) => templateText(inner));
    if (next === out) break;
    out = next;
  }
  return out.replace(/\{\{|\}\}/g, "");
}

const SKIPPED_NAMESPACES = /^(file|image|category|wikipedia|wp|template|help|portal|special|wikt|wiktionary|commons|:?[a-z]{2,3}):/i;

/** A link target as an article title: underscores to spaces, no section, first letter upper case. */
export function normalizeTitle(target: string): string {
  const title = target.split("#")[0].replace(/_/g, " ").replace(/\s+/g, " ").trim().replace(/^:/, "");
  return title ? title[0].toUpperCase() + title.slice(1) : "";
}

/** The article titles a piece of wikitext links to, in order, without repeats or non-article namespaces. */
export function linkTargets(wikitext: string): string[] {
  const seen = new Set<string>();
  for (const m of wikitext.matchAll(/\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g)) {
    if (SKIPPED_NAMESPACES.test(m[1].trim())) continue;
    const title = normalizeTitle(m[1]);
    if (title) seen.add(title);
  }
  return [...seen];
}

/** The outlet names in external links written the portal's way, `[https://... (Outlet)]`. */
export function sourceNames(wikitext: string): string[] {
  const names = new Set<string>();
  for (const m of wikitext.matchAll(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g)) {
    const label = m[1].replace(/'{2,}/g, "").trim();
    const outlet = label.match(/^\((.+)\)$/)?.[1] ?? label;
    if (outlet) names.add(outlet.trim());
  }
  return [...names];
}

/** Plain text from wikitext: no comments, references, templates, markup or external links. */
export function wikitextToPlain(wikitext: string): string {
  let text = wikitext
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  text = stripTemplates(text);
  text = text
    .replace(/\{\|[\s\S]*?\|\}/g, ""); // tables
  // Innermost links first, so a file caption's own links go before the file link itself.
  for (let pass = 0; pass < 10; pass++) {
    const next = text
      .replace(/\[\[([^\[\]|]+)\|([^\[\]]*)\]\]/g, (_, target: string, label: string) => (SKIPPED_NAMESPACES.test(target.trim()) ? "" : label))
      .replace(/\[\[([^\[\]]+)\]\]/g, (_, target: string) => (SKIPPED_NAMESPACES.test(target.trim()) ? "" : target));
    if (next === text) break;
    text = next;
  }
  text = text
    .replace(/\[https?:\/\/[^\]]*\]/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/'{2,}/g, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ ([,.;:])/g, "$1");
  return text.trim();
}
