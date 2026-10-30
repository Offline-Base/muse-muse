import type { OutputItem, UrlAnnotation } from "@/components/docs/playgrounds/text/items";
import { CITE_CLOSE, CITE_OPEN, markerChar } from "@/components/docs/playgrounds/text/markdown-lite";

/**
 * Search grounding as a reader sees it (search-grounding page): the steps the model took (its preambles, the searches
 * it ran, the pages it opened), the answer with a numbered marker after each cited span, the sources those numbers
 * point to, and the raw results when the request included `web_search_call.results`. Pure, so it is tested against
 * real replies.
 */

type Json = Record<string, unknown>;

export interface SearchResultRow {
  url: string;
  title: string;
  snippet: string;
  type: string;
}

export type GroundingStep =
  | { kind: "note"; id: string; text: string }
  | { kind: "search"; id: string; status: string; queries: string[]; results: SearchResultRow[] | null }
  | { kind: "open"; id: string; status: string; url: string | null }
  | { kind: "find"; id: string; status: string; url: string | null; pattern: string | null };

export interface Source {
  /** The marker number, from 1, in the order sources are first cited. */
  n: number;
  url: string;
  title: string;
  host: string;
  /** How many spans of the answer cite it. */
  spans: number;
}

export interface Segment {
  text: string;
  /** True when some citation covers this stretch of text. */
  cited: boolean;
  /** Source numbers to show right after this stretch (the spans that end here). */
  markers: number[];
}

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** "formula1.com" for a URL, or "" when it doesn't parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

/** One key per page: the host is case-insensitive, a trailing slash and the fragment don't make a new source. */
export function sourceKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url.trim();
  }
}

function resultsOf(v: unknown): SearchResultRow[] | null {
  if (!Array.isArray(v)) return null;
  return v
    .map((r) => obj(r))
    .filter((r): r is Json => !!r && typeof r.url === "string")
    .map((r) => ({ url: r.url as string, title: str(r.title) || (r.url as string), snippet: str(r.snippet) ?? "", type: str(r.type) ?? "text_result" }));
}

/**
 * What the model did, in order: preambles as notes, and each web_search_call as a search (its queries, from
 * `action.queries` or the deprecated `action.query`), an opened page or a find in page.
 */
export function groundingSteps(items: readonly OutputItem[]): GroundingStep[] {
  const steps: GroundingStep[] = [];
  for (const it of items) {
    if (it.type === "message" && it.phase === "commentary") {
      if (it.text.trim()) steps.push({ kind: "note", id: it.id, text: it.text.trim() });
      continue;
    }
    if (it.type !== "web_search_call") continue;
    const action = obj(it.raw.action);
    const kind = str(action?.type);
    if (kind === "open_page") {
      steps.push({ kind: "open", id: it.id, status: it.status, url: str(action?.url) ?? null });
    } else if (kind === "find_in_page" || kind === "find") {
      steps.push({ kind: "find", id: it.id, status: it.status, url: str(action?.url) ?? null, pattern: str(action?.pattern) ?? null });
    } else {
      const queries = Array.isArray(action?.queries) ? (action.queries as unknown[]).filter((q): q is string => typeof q === "string") : [];
      const one = str(action?.query);
      steps.push({ kind: "search", id: it.id, status: it.status, queries: queries.length ? queries : one ? [one] : [], results: resultsOf(it.raw.results) });
    }
  }
  return steps;
}

/** Search queries the model ran (billed per query, pricing-rate-limits), and the pages it opened (not queries). */
export function searchCounts(steps: readonly GroundingStep[]): { calls: number; queries: number; opened: number } {
  let calls = 0;
  let queries = 0;
  let opened = 0;
  for (const s of steps) {
    if (s.kind === "note") continue;
    calls++;
    if (s.kind === "search") queries += Math.max(1, s.queries.length);
    else opened++;
  }
  return { calls, queries, opened };
}

/** Sources numbered in the order the answer first cites them, one per page. */
export function numberSources(answers: ReadonlyArray<{ annotations: readonly UrlAnnotation[] }>): Source[] {
  const out: Source[] = [];
  const byKey = new Map<string, Source>();
  for (const a of answers) {
    const sorted = [...a.annotations].sort((x, y) => x.start - y.start || x.end - y.end);
    for (const ann of sorted) {
      const key = sourceKey(ann.url);
      const known = byKey.get(key);
      if (known) {
        known.spans++;
        continue;
      }
      const s: Source = { n: out.length + 1, url: ann.url, title: ann.title || ann.url, host: hostOf(ann.url), spans: 1 };
      byKey.set(key, s);
      out.push(s);
    }
  }
  return out;
}

/** The marker number for a URL, given the numbered sources. */
export function markerFor(sources: readonly Source[], url: string): number | null {
  const key = sourceKey(url);
  return sources.find((s) => sourceKey(s.url) === key)?.n ?? null;
}

/**
 * The answer split where citations start and end, with markers after each cited span. Meta's offsets count code
 * points (they index Python strings), so they are mapped onto JavaScript's UTF-16 string before slicing: an emoji
 * earlier in the text would otherwise shift every marker after it. Offsets outside the text are clamped; empty or
 * reversed spans still get their marker, at their end.
 */
export function segmentCitations(text: string, annotations: readonly UrlAnnotation[], sources: readonly Source[]): Segment[] {
  const points = [...text];
  const utf16At: number[] = [0];
  for (const ch of points) utf16At.push(utf16At[utf16At.length - 1] + ch.length);
  const clamp = (n: number) => Math.max(0, Math.min(points.length, Math.round(n)));
  const spans = annotations
    .map((a) => {
      const start = clamp(a.start);
      const end = clamp(a.end);
      return { start: Math.min(start, end), end: Math.max(start, end), n: markerFor(sources, a.url) };
    })
    .filter((s): s is { start: number; end: number; n: number } => s.n !== null);
  if (!spans.length) return text ? [{ text, cited: false, markers: [] }] : [];

  const cuts = [...new Set([0, points.length, ...spans.flatMap((s) => [s.start, s.end])])].sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let i = 0; i < cuts.length; i++) {
    const from = cuts[i];
    const to = cuts[i + 1] ?? from;
    const piece = to > from ? text.slice(utf16At[from], utf16At[to]) : "";
    const cited = to > from && spans.some((s) => s.start <= from && s.end >= to);
    const markers = [...new Set(spans.filter((s) => s.end === to && to > from).map((s) => s.n))].sort((a, b) => a - b);
    if (i === 0) {
      // Spans that are empty at the very start still show their marker.
      const atZero = [...new Set(spans.filter((s) => s.start === 0 && s.end === 0).map((s) => s.n))];
      if (atZero.length) segments.push({ text: "", cited: false, markers: atZero });
    }
    if (!piece && !markers.length) continue;
    // A marker goes after trailing spaces or newlines of its span would look detached, so keep them after it.
    const trail = /\s+$/.exec(piece)?.[0] ?? "";
    if (markers.length && trail && trail.length < piece.length) {
      segments.push({ text: piece.slice(0, piece.length - trail.length), cited, markers });
      segments.push({ text: trail, cited: false, markers: [] });
    } else {
      segments.push({ text: piece, cited, markers });
    }
  }
  return segments;
}

/**
 * The segments as one text for AnswerText: each cited stretch between CITE_OPEN and CITE_CLOSE, each marker as its
 * private-use character. Markdown is read after this, so a span that ends inside "**bold**" keeps its marker there.
 */
export function encodeCitations(segments: readonly Segment[]): string {
  return segments.map((s) => (s.cited && s.text ? `${CITE_OPEN}${s.text}${CITE_CLOSE}` : s.text) + s.markers.map(markerChar).join("")).join("");
}

/** Which results the answer cited, by page. */
export function citedKeys(sources: readonly Source[]): Set<string> {
  return new Set(sources.map((s) => sourceKey(s.url)));
}

export interface GroundingLocationInput {
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
}

export interface GroundingRequest {
  model: string;
  prompt: string;
  /** search_context_size, or "default" to leave it out (the API's default is medium). */
  context: "default" | "low" | "medium" | "high";
  /** user_location's fields, sent with type "approximate" when any is filled in; null to send none. */
  location: GroundingLocationInput | null;
  /** include web_search_call.results. */
  include: boolean;
  effort: string | null;
  maxOutputTokens?: number;
  stream: boolean;
}

/** The location as sent: trimmed, empty fields left out, the country code upper-cased. */
export function cleanLocation(l: GroundingLocationInput): GroundingLocationInput {
  const out: GroundingLocationInput = {};
  for (const k of ["country", "region", "city", "timezone"] as const) {
    const v = l[k]?.trim();
    if (v) out[k] = k === "country" ? v.toUpperCase() : v;
  }
  return out;
}

/** The Responses request the search grounding demo sends: the web_search tool with the page's options. */
export function groundingBody(r: GroundingRequest): Record<string, unknown> {
  const tool: Record<string, unknown> = { type: "web_search" };
  if (r.context !== "default") tool.search_context_size = r.context;
  const loc = r.location ? cleanLocation(r.location) : {};
  if (r.location && Object.keys(loc).length) tool.user_location = { type: "approximate", ...loc };
  const b: Record<string, unknown> = { model: r.model, input: r.prompt.trim() || "...", tools: [tool] };
  if (r.include) b.include = ["web_search_call.results"];
  if (r.effort) b.reasoning = { effort: r.effort };
  if (r.maxOutputTokens) b.max_output_tokens = r.maxOutputTokens;
  if (r.stream) b.stream = true;
  return b;
}
