/**
 * Footnotes for a web-searched Responses reply, from what the reply really holds. Pure, with no imports.
 * Ask with `tools: [{ type: "web_search" }], include: ["web_search_call.results"]`, then `footnotes(res.output)`.
 */
export interface Source {
  n: number;
  url: string;
  title: string;
}

export interface Footnoted {
  /** The answer, with [n] after each cited span when annotations came back. */
  text: string;
  sources: Source[];
  /** "cited": the reply tied spans to sources. "searched": only the search results are known. "none": nothing to show. */
  kind: "cited" | "searched" | "none";
  /** How many searches ran. 0 means the model answered from what it knew. */
  searches: number;
  /** The plain line to show under the answer. */
  note: string;
}

type Item = { type?: string; content?: unknown; results?: unknown; action?: { sources?: unknown } | null };
type Block = { type?: string; text?: unknown; annotations?: unknown };
type Cite = { type?: string; url?: unknown; title?: unknown; end_index?: unknown };

const isHttp = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);

export function footnotes(output: readonly unknown[]): Footnoted {
  const items = output as Item[];
  const searchCalls = items.filter((i) => i?.type === "web_search_call");
  const blocks = items.filter((i) => i?.type === "message" && Array.isArray(i.content)).flatMap((i) => i.content as Block[]).filter((b) => b?.type === "output_text" && typeof b.text === "string");
  const numbers = new Map<string, Source>();
  const number = (url: string, title: unknown) => {
    if (!numbers.has(url)) numbers.set(url, { n: numbers.size + 1, url, title: typeof title === "string" && title.trim() ? title.trim() : url });
    return numbers.get(url)!.n;
  };
  let cited = false;
  const texts = blocks.map((b) => {
    let text = b.text as string;
    const cites = (Array.isArray(b.annotations) ? (b.annotations as Cite[]) : []).filter((a) => a?.type === "url_citation" && isHttp(a.url) && typeof a.end_index === "number");
    // Number in reading order, then insert back to front so earlier offsets stay right.
    const sorted = [...cites].sort((a, b2) => (a.end_index as number) - (b2.end_index as number)).map((a) => ({ at: Math.min(text.length, a.end_index as number), n: number(a.url as string, a.title) }));
    for (const c of sorted.reverse()) text = `${text.slice(0, c.at)}[${c.n}]${text.slice(c.at)}`;
    if (cites.length) cited = true;
    return text;
  });
  if (!cited) {
    for (const call of searchCalls) {
      const list = Array.isArray(call.results) ? call.results : Array.isArray(call.action?.sources) ? (call.action?.sources as unknown[]) : [];
      for (const r of list as Array<{ url?: unknown; title?: unknown }>) if (isHttp(r?.url)) number(r.url, r.title);
    }
  }
  const sources = [...numbers.values()];
  const kind = cited ? "cited" : sources.length ? "searched" : "none";
  const note =
    kind === "cited"
      ? `Each [n] links the sentence before it to a source the search returned.`
      : kind === "searched"
        ? `The search read these pages. The reply didn't say which sentence each one supports.`
        : searchCalls.length
          ? "No sources were returned for this answer."
          : "No search ran: the model answered from what it already knew.";
  return { text: texts.join("\n\n"), sources, kind, searches: searchCalls.length, note };
}
