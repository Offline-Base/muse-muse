// Platform file (Muse Muse platform services). Don't edit: call it from route handlers and server actions.
//
// This product's full-text index on the gateway ({GATEWAY_URL}/search). Add the text of a file right after it is kept
// (plain text as it is; text in a PDF or a photo from the product's own Muse Wonder call), or of a saved item, and
// search it. Every hit has a citation, { source, name, offset }: show it with <Citation> from
// components/platform/Citation.tsx beside any answer built from it. The index follows the files' scope.
import type { RequestLike } from "@/lib/meta/client";
import { gatewayCall, type FileScope } from "@/lib/platform/files";

export type SearchSource = { fileId: string } | { collection: string; docId: string };

export interface Citation {
  source: SearchSource;
  /** The file's name or the item's title, to show. */
  name: string;
  /** Where in the text the hit starts, in characters. */
  offset: number;
  /** For a dataset: its license, which the citation shows. */
  license?: string;
}

export interface SearchHit {
  source: SearchSource;
  title: string;
  /** About 30 words around the match, plain text. */
  snippet: string;
  score: number;
  citation: Citation;
}

export function search(request?: RequestLike | null) {
  return {
    /** Adds text to the index, replacing what the same source had. Up to 1 MB of text a document. */
    async index(doc: { source: SearchSource; text: string; title?: string; scope?: FileScope }): Promise<{ chunks: number }> {
      return gatewayCall(request, "POST", "/search/index", doc);
    },
    /** Ranked hits for what a person typed (quotes, OR and -word work), at most 10. */
    async query(q: string, opts: { scope?: FileScope; limit?: number } = {}): Promise<SearchHit[]> {
      const reply = await gatewayCall<{ hits: SearchHit[] }>(request, "POST", "/search/query", { q, ...opts });
      return reply.hits;
    },
    /** Takes a source's text out of the index. A deleted file's text goes by itself. */
    async remove(source: SearchSource, opts: { scope?: FileScope } = {}): Promise<boolean> {
      return (await gatewayCall<{ removed: boolean }>(request, "POST", "/search/remove", { source, ...opts })).removed;
    },
  };
}
