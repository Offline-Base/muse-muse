// Platform file (Muse Muse platform services). Keep this file as it is.
//
// Where an answer came from: the file's name or the item's title, where in its text, and for a dataset its license.
// Show one beside every answer built from a person's files or a dataset. The platform's tests look for data-citation.
import type { Citation as CitationData } from "@/lib/platform/search";

/** What datasetCitation needs from dataset(request, id).info(). */
export interface DatasetSummary {
  id: string;
  title: string;
  license: { spdx: string; url: string };
}

/** A dataset's citation: its title and its license, linked. */
export function datasetCitation(info: DatasetSummary): CitationData & { href: string } {
  return { source: { collection: "datasets", docId: info.id }, name: info.title, offset: 0, license: info.license.spdx, href: info.license.url };
}

export function Citation({ citation }: { citation: CitationData & { href?: string } }) {
  const where = citation.license ? `${citation.license} license` : citation.offset > 0 ? `from character ${citation.offset.toLocaleString("en-US")}` : "from the start";
  const kind = "fileId" in citation.source ? "file" : citation.license ? "dataset" : "item";
  return (
    <span data-citation={kind} className="meta">
      Source: <cite>{citation.name}</cite> (
      {citation.href ? (
        <a href={citation.href} target="_blank" rel="noreferrer">
          {where}
        </a>
      ) : (
        where
      )}
      )
    </span>
  );
}
