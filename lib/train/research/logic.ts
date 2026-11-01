/**
 * Data research's rules (docs/TRAINING.md "Data research"), pure so the tests run them directly: which links count, how
 * a source's license reads, what may be imported, and the notes a pick gives the writer. Server only (lib/tools/args
 * uses node:net).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isPublicHttpUrl } from "@/lib/tools/args";
import type { ResearchCitation, ResearchFinding, ResearchSource } from "@/lib/train/research/types";

export const RESEARCH_SOURCES_MAX = 15;
/** Citations a finding keeps, and how much of a snippet. */
const CITATIONS_MAX = 30;
const SNIPPET_MAX = 500;
/** The notes a dataset's writer reads at most. */
export const GROUNDING_MAX = 4000;

// ---------------------------------------------------------------------------------------------------------------
// Links

/** The address with no fragment, or null for anything but public http(s): no logins, no local names, no private IPs. */
export function publicUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000 || !isPublicHttpUrl(raw)) return null;
  const u = new URL(raw);
  u.hash = "";
  return u.href;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The links a Responses output holds: each web_search_call's results (asked for with include, every page the search
 * returned) and the url_citation annotations on its text. Nothing else counts as coming from the search, so a link the
 * model only wrote in its prose never gets in.
 */
export function searchCitations(output: unknown): ResearchCitation[] {
  const byUrl = new Map<string, ResearchCitation>();
  const add = (url: unknown, title: unknown, snippet: unknown) => {
    const u = publicUrl(url);
    if (!u) return;
    const seen = byUrl.get(u);
    if (seen) {
      if (!seen.title) seen.title = str(title).slice(0, 200);
      if (!seen.snippet) seen.snippet = str(snippet).slice(0, SNIPPET_MAX);
    } else if (byUrl.size < CITATIONS_MAX) {
      byUrl.set(u, { url: u, title: str(title).slice(0, 200), snippet: str(snippet).slice(0, SNIPPET_MAX) });
    }
  };
  for (const raw of Array.isArray(output) ? output : []) {
    const item = obj(raw);
    if (item?.type === "web_search_call") {
      for (const hit of Array.isArray(item.results) ? item.results : []) {
        const h = obj(hit);
        if (h) add(h.url, h.title, h.snippet);
      }
    } else if (item?.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        for (const note of Array.isArray(obj(part)?.annotations) ? (obj(part)!.annotations as unknown[]) : []) {
          const a = obj(note);
          // Chat Completions nests the details; Responses puts them on the annotation.
          if (a?.type === "url_citation") add(obj(a.url_citation)?.url ?? a.url, obj(a.url_citation)?.title ?? a.title, "");
        }
      }
    }
  }
  return [...byUrl.values()];
}

/** Every distinct link the searches found, in order. The report names sources by their place in this list. */
export function reportLinks(findings: readonly ResearchFinding[]): ResearchCitation[] {
  const byUrl = new Map<string, ResearchCitation>();
  for (const f of findings) for (const c of f.citations) if (!byUrl.has(c.url)) byUrl.set(c.url, c);
  return [...byUrl.values()];
}

// ---------------------------------------------------------------------------------------------------------------
// The report

export const QuestionsSchema = z.object({ questions: z.array(z.string().min(1).max(300)).min(1).max(6) });

/** `link` is a place in the numbered list: the model can't write an address, so it can't invent one. */
export const ReportSchema = z.object({
  sources: z
    .array(
      z.object({
        link: z.number().int(),
        title: z.string().min(1),
        kind: z.enum(["dataset", "document", "guideline"]),
        holds: z.string().min(1),
        size: z.string().min(1),
        license: z.string().min(1),
        whyItHelps: z.string().min(1),
        risks: z.string().min(1),
        personalData: z.enum(["yes", "no", "unknown"]),
        examples: z.array(z.string().min(1)).max(5),
        helpfulness: z.number().int().min(1).max(5),
      }),
    )
    .max(RESEARCH_SOURCES_MAX * 2),
});
export type ReportReply = z.infer<typeof ReportSchema>;

const cut = (text: string, max: number) => text.trim().slice(0, max);

/**
 * The report's sources, most helpful first: one per link, and only with a link the searches found. A source pointing
 * anywhere else is dropped and counted, never shown, so nothing in a report is uncited.
 */
export function reportSources(reply: ReportReply, links: readonly ResearchCitation[]): { sources: ResearchSource[]; dropped: number } {
  const sources: ResearchSource[] = [];
  const used = new Set<number>();
  let dropped = 0;
  for (const s of reply.sources) {
    const link = links[s.link - 1];
    if (!link) {
      dropped++;
      continue;
    }
    if (used.has(s.link)) continue;
    used.add(s.link);
    sources.push({
      id: randomUUID(),
      title: cut(s.title, 200),
      url: link.url,
      kind: s.kind,
      holds: cut(s.holds, 800),
      size: cut(s.size, 120),
      license: cut(s.license, 120) || "unknown",
      whyItHelps: cut(s.whyItHelps, 800),
      risks: cut(s.risks, 800),
      personalData: s.personalData,
      examples: s.examples.slice(0, 5).map((e) => cut(e, 300)),
      helpfulness: s.helpfulness,
    });
  }
  sources.sort((a, b) => b.helpfulness - a.helpfulness);
  return { sources: sources.slice(0, RESEARCH_SOURCES_MAX), dropped };
}

// ---------------------------------------------------------------------------------------------------------------
// Licenses and imports

/**
 * Licenses that let rows train a model and be kept, with attribution at most. An exact list, so "CC BY-NC" or "MIT-like"
 * never passes by containing a good word. Share-alike isn't here: whether a fine-tune is an adaptation isn't settled.
 */
const OPEN_LICENSES = new Set([
  "cc0",
  "cc0-1.0",
  "cc-by",
  "cc-by-3.0",
  "cc-by-4.0",
  "mit",
  "apache-2.0",
  "bsd-2-clause",
  "bsd-3-clause",
  "unlicense",
  "odc-by",
  "pddl",
  "cdla-permissive-1.0",
  "cdla-permissive-2.0",
  "public-domain",
]);

export type LicenseClass = "open" | "restrictive" | "unknown";

/** How a stated license reads: "MIT License" and "cc by 4.0" read as their ids, and anything not listed isn't open. */
export function licenseClass(stated: string | null | undefined): LicenseClass {
  const id = (stated ?? "")
    .trim()
    .toLowerCase()
    .replace(/\b(the|license|licence)\b/g, " ")
    .replace(/creative commons attribution|creative commons/g, (m) => (m.endsWith("attribution") ? "cc by" : "cc"))
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/^apache-(\d)$/, "apache-$1.0");
  if (!id || id === "unknown" || id === "not-stated" || id === "none" || id === "other") return "unknown";
  return OPEN_LICENSES.has(id) ? "open" : "restrictive";
}

export type ImportTarget = { kind: "hf"; repo: string } | { kind: "file"; url: string; name: string };

const HF_REPO = /^\/datasets\/([A-Za-z0-9][\w.-]{0,95})\/([A-Za-z0-9][\w.-]{0,95})\/?$/;

/** What can be read from a link: a Hugging Face dataset's page, or an https CSV or JSONL file. Null for anything else. */
export function importTarget(url: string): ImportTarget | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.hostname === "huggingface.co") {
    const m = HF_REPO.exec(u.pathname);
    if (m) return { kind: "hf", repo: `${m[1]}/${m[2]}` };
  }
  const name = u.pathname.split("/").pop() ?? "";
  return /\.(csv|jsonl)$/i.test(name) ? { kind: "file", url, name } : null;
}

export type Importability = { ok: true; target: ImportTarget } | { ok: false; reason: string };

/**
 * Whether a source may be imported or only read, decided here and again on the server at import. Personal data first,
 * then the license: restrictive never, unknown only for a Hugging Face dataset, whose license the Hub states and the
 * import checks (importSource refuses it unless that is open).
 */
export function importability(s: Pick<ResearchSource, "kind" | "license" | "personalData" | "url">): Importability {
  if (s.personalData !== "no") return { ok: false, reason: "Read only: it may hold personal data." };
  const target = importTarget(s.url);
  const license = licenseClass(s.license);
  if (license === "restrictive") return { ok: false, reason: "Read only: its license isn't one that clearly allows this." };
  if (!target) return { ok: false, reason: "Read only: it isn't a Hugging Face dataset or a CSV or JSONL file." };
  if (license === "unknown" && target.kind !== "hf") return { ok: false, reason: "Read only: its license is unknown." };
  return { ok: true, target };
}

// ---------------------------------------------------------------------------------------------------------------
// Picks

/** The writer's background from the sources picked, cut to GROUNDING_MAX on a whole source. */
export function groundingNotes(picked: readonly ResearchSource[]): string {
  let out = "";
  for (const s of picked) {
    const examples = s.examples.length ? ` Questions it could teach: ${s.examples.join(" | ")}` : "";
    const line = `- ${s.title} (${s.url}): ${s.holds} Why it helps: ${s.whyItHelps}${examples}`.replace(/\s*\n\s*/g, " ");
    if (out.length + line.length + 1 > GROUNDING_MAX) break;
    out += (out ? "\n" : "") + line;
  }
  return out;
}
