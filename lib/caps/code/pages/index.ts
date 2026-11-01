import { createHash } from "node:crypto";
import type { BrowsePage } from "@/lib/caps/code/browse";
import { canonicalJson } from "@/lib/tools/sign";
import type { ToolFixtures } from "@/lib/tools/ids";
import sample1 from "./sample-1.json";
import sample2 from "./sample-2.json";
import sample3 from "./sample-3.json";

/**
 * The pages a build's /browse gets instead of the web (docs/CAPABILITIES.md, 2.7): a build's sandbox can't reach other
 * sites, and its tests must pass the same way every time. Picked by hash(normalized arguments) % n, as cannedOutput
 * does, or from the build's own `cap:code:browse` fixtures. Each page's text ends with its marker, which the fixed
 * check looks for on the product's screen.
 */
export interface SamplePage {
  marker: string;
  title: string;
  text: string;
}

export const SAMPLE_PAGES: readonly SamplePage[] = [sample1, sample2, sample3];
export const SAMPLE_MARKERS: readonly string[] = SAMPLE_PAGES.map((p) => p.marker);
export const BROWSE_FIXTURE_KEY = "cap:code:browse";

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** A plain picture of a sample page, as an SVG data URL, so the product has a screenshot to show. */
export function sampleScreenshot(page: Pick<SamplePage, "title" | "text">): string {
  const lines = page.text.split("\n").slice(0, 8).map((l) => (l.length > 90 ? `${l.slice(0, 89)}…` : l));
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">',
    '<rect width="1280" height="800" fill="#ffffff"/>',
    '<rect width="1280" height="64" fill="#f1f3f5"/>',
    `<text x="40" y="42" font-family="sans-serif" font-size="22" fill="#5f6b7a">Sample page</text>`,
    `<text x="40" y="140" font-family="sans-serif" font-size="40" font-weight="700" fill="#14171a">${escapeXml(page.title.slice(0, 60))}</text>`,
    ...lines.map((l, i) => `<text x="40" y="${210 + i * 44}" font-family="sans-serif" font-size="24" fill="#33393f">${escapeXml(l)}</text>`),
    "</svg>",
  ].join("");
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function usable(list: unknown): SamplePage[] {
  if (!Array.isArray(list)) return [];
  return list.filter((p): p is SamplePage => Boolean(p) && typeof p === "object" && typeof (p as SamplePage).title === "string" && typeof (p as SamplePage).text === "string").map((p) => ({ marker: typeof p.marker === "string" ? p.marker : "", title: p.title.slice(0, 300), text: p.text.slice(0, 20_000) }));
}

/** The sample page a build gets for these arguments: the same one on every verify run. */
export function samplePageFor(args: { url: string; actions: unknown[] }, fixtures?: ToolFixtures | null): BrowsePage & { marker: string } {
  const own = usable(fixtures?.[BROWSE_FIXTURE_KEY]);
  const list = own.length ? own : SAMPLE_PAGES;
  const hash = createHash("sha256").update(canonicalJson({ url: args.url, actions: args.actions })).digest();
  const page = list[hash.readUInt32BE(0) % list.length]!;
  return { url: args.url, title: page.title, text: page.text, screenshot: sampleScreenshot(page), marker: page.marker };
}
