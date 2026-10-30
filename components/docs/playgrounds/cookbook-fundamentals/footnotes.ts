/**
 * The search-grounding recipe's citation handling, in TypeScript: url_citation annotations tie a span of an
 * output_text block to a source, so the answer can be rebuilt with [n] markers (inserted back to front so earlier
 * offsets stay valid, one stable number per unique URL in order of first appearance) and a numbered source list, and
 * each span can be sliced out as the passage that source supports. Pure, so the demo and its tests share it.
 */

export interface UrlCitation {
  type?: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

export interface Source {
  n: number;
  url: string;
  title: string;
}

export interface Segment {
  text: string;
  /** Footnote numbers to show right after this text, in the order the recipe's function writes them. */
  marks: number[];
}

export interface Footnoted {
  /** The text with [n] markers, exactly what the recipe's render_with_footnotes builds before its source list. */
  marked: string;
  segments: Segment[];
  sources: Source[];
}

/** The url_citation annotations, with offsets clamped into the text. Others (and ones with no URL) are dropped. */
export function urlCitations(text: string, annotations: readonly unknown[] | null | undefined): Array<Required<Pick<UrlCitation, "url" | "title" | "start_index" | "end_index">>> {
  const out: Array<{ url: string; title: string; start_index: number; end_index: number }> = [];
  for (const raw of annotations ?? []) {
    const a = raw as UrlCitation | null;
    if (!a || a.type !== "url_citation" || typeof a.url !== "string" || !a.url) continue;
    const clamp = (n: unknown, fallback: number) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(text.length, Math.trunc(n))) : fallback);
    const end = clamp(a.end_index, text.length);
    const start = Math.min(clamp(a.start_index, end), end);
    out.push({ url: a.url, title: typeof a.title === "string" && a.title ? a.title : a.url, start_index: start, end_index: end });
  }
  return out;
}

export function renderWithFootnotes(text: string, annotations: readonly unknown[] | null | undefined): Footnoted {
  const citations = urlCitations(text, annotations);
  const numbers = new Map<string, number>();
  const sources: Source[] = [];
  for (const c of citations) {
    if (!numbers.has(c.url)) {
      numbers.set(c.url, sources.length + 1);
      sources.push({ n: sources.length + 1, url: c.url, title: c.title });
    }
  }
  // The recipe sorts by end_index, highest first (a stable sort), and inserts each marker at its end, so markers that
  // share an end come out in reverse of their citation order.
  const ordered = citations
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.end_index - a.c.end_index || a.i - b.i);
  let marked = text;
  for (const { c } of ordered) marked = `${marked.slice(0, c.end_index)}[${numbers.get(c.url)}]${marked.slice(c.end_index)}`;

  const at = new Map<number, number[]>();
  for (const { c } of ordered) {
    const list = at.get(c.end_index) ?? [];
    // Each insertion at the same offset lands before the ones already there.
    list.unshift(numbers.get(c.url)!);
    at.set(c.end_index, list);
  }
  const cuts = [...at.keys()].sort((a, b) => a - b);
  const segments: Segment[] = [];
  let from = 0;
  for (const cut of cuts) {
    segments.push({ text: text.slice(from, cut), marks: at.get(cut)! });
    from = cut;
  }
  if (from < text.length || !segments.length) segments.push({ text: text.slice(from), marks: [] });
  return { marked, segments, sources };
}

/** The recipe's source list under the marked text: "  [1] Title, https://..." (no em dash in ours). */
export function sourceList(sources: readonly Source[]): string {
  return sources.map((s) => `  [${s.n}] ${s.title}, ${s.url}`).join("\n");
}

/** Each citation's passage: the exact span of the answer that source backs. */
export function passages(text: string, annotations: readonly unknown[] | null | undefined): Array<{ passage: string; url: string; title: string }> {
  return urlCitations(text, annotations).map((c) => ({ passage: text.slice(c.start_index, c.end_index), url: c.url, title: c.title }));
}

/** The output_text blocks of a Responses object, with their annotations, in order. */
export function outputTextBlocks(response: unknown): Array<{ text: string; annotations: unknown[] }> {
  const out: Array<{ text: string; annotations: unknown[] }> = [];
  const items = (response as { output?: unknown } | null)?.output;
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    const it = item as { type?: unknown; content?: unknown } | null;
    if (it?.type !== "message" || !Array.isArray(it.content)) continue;
    for (const block of it.content) {
      const b = block as { type?: unknown; text?: unknown; annotations?: unknown } | null;
      if (b?.type === "output_text" && typeof b.text === "string") out.push({ text: b.text, annotations: Array.isArray(b.annotations) ? b.annotations : [] });
    }
  }
  return out;
}

/** The output items' types in order, as the recipe prints them ("reasoning", "web_search_call", "message"). */
export function outputItemTypes(response: unknown): string[] {
  const items = (response as { output?: unknown } | null)?.output;
  return Array.isArray(items) ? items.map((i) => String((i as { type?: unknown } | null)?.type ?? "unknown")) : [];
}

/**
 * The reply Meta's search grounding guide shows as its example response (dev.meta.ai/docs/search-grounding, "Example
 * response"), verbatim except for its model field, left out here. Live replies carry no url_citation annotations
 * today, so the demo replays this one to show the footnotes being drawn. The offsets are the guide's own and look
 * illustrative: some end mid-phrase, and the markers land exactly where they point.
 */
export const DOCUMENTED_SEARCH_REPLY = {
  id: "resp_123",
  object: "response",
  created_at: 1778250764,
  status: "completed",
  output: [
    { id: "ws_789", type: "web_search_call", status: "completed" },
    {
      id: "msg_b4d6e9c2ff37410a",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "**Muse Spark** was announced by Meta on **Wednesday, April 8, 2026**.\n\n- It was unveiled as the first AI model from Meta's new \"Muse\" family, developed by Meta Superintelligence Labs \n- Meta described it as a \"small and fast by design\" multimodal model built for real-time reasoning across WhatsApp, Instagram, Facebook, and Meta's smart glasses \n\nThe announcement came in a blog post on April 8, kicking off the week of April 6–10 that TechTarget covered in its roundup published April 10, 2026 .",
          annotations: [
            {
              type: "url_citation",
              url: "https://www.techtarget.com/searchcio/feature/Weekly-news-roundup-Claude-Mythos-concerns-Muse-Spark-debut-and-US-infrastructure-disruption",
              title: "Weekly news roundup: Claude Mythos concerns, Muse Spark debut and U.S. infrastructure disruption | TechTarget",
              start_index: 38,
              end_index: 76,
            },
            {
              type: "url_citation",
              url: "https://www.thehindubusinessline.com/info-tech/meta-launches-muse-spark-1.1-ai-bets-big-on-superintelligence-push/article70840923.ece",
              title: "Meta unveils Muse Spark AI model to compete in superintelligence race",
              start_index: 175,
              end_index: 225,
            },
            {
              type: "url_citation",
              url: "https://www.techtarget.com/searchcio/feature/Weekly-news-roundup-Claude-Mythos-concerns-Muse-Spark-debut-and-US-infrastructure-disruption",
              title: "Weekly news roundup: Claude Mythos concerns, Muse Spark debut and U.S. infrastructure disruption | TechTarget",
              start_index: 380,
              end_index: 460,
            },
          ],
        },
      ],
    },
  ],
};

/** The grounded answer: the last message's output_text, since earlier messages are often narration before a search. */
export function finalAnswerBlock(response: unknown): { text: string; annotations: unknown[] } | null {
  const items = (response as { output?: unknown } | null)?.output;
  if (!Array.isArray(items)) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i] as { type?: unknown; content?: unknown } | null;
    if (it?.type !== "message" || !Array.isArray(it.content)) continue;
    const blocks = it.content
      .map((b) => b as { type?: unknown; text?: unknown; annotations?: unknown } | null)
      .filter((b): b is { type: string; text: string; annotations?: unknown } => b?.type === "output_text" && typeof b.text === "string");
    if (!blocks.length) continue;
    // Several blocks in one message: offsets are per block, so each block's annotations shift by the text before it.
    let text = "";
    const annotations: unknown[] = [];
    for (const b of blocks) {
      const shift = text.length;
      for (const a of Array.isArray(b.annotations) ? b.annotations : []) {
        const ann = a as UrlCitation;
        annotations.push({
          ...ann,
          ...(typeof ann.start_index === "number" ? { start_index: ann.start_index + shift } : {}),
          ...(typeof ann.end_index === "number" ? { end_index: ann.end_index + shift } : {}),
        });
      }
      text += b.text;
    }
    return { text, annotations };
  }
  return null;
}
