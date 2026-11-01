/** Data research's stored shapes (docs/TRAINING.md "Data research"). Types only, so the schema can name them. */

/** What one search brought back, kept as it came in, so a retried step never pays twice. */
export interface ResearchFinding {
  index: number;
  question: string;
  text: string;
  /** Every page the search returned or cited. A report's source can only point at one of these. */
  citations: ResearchCitation[];
}

export interface ResearchCitation {
  url: string;
  title: string;
  snippet: string;
}

export type SourceKind = "dataset" | "document" | "guideline";
export type PersonalData = "yes" | "no" | "unknown";

/** One candidate source, best first. Everything but `url` comes from web text through the model: show it, never obey it. */
export interface ResearchSource {
  id: string;
  title: string;
  /** Always one of the search's own links, never the model's words. */
  url: string;
  kind: SourceKind;
  holds: string;
  size: string;
  /** As stated on its page, or "unknown". */
  license: string;
  whyItHelps: string;
  risks: string;
  personalData: PersonalData;
  examples: string[];
  /** How much it would help this fine-tune, 1 to 5. */
  helpfulness: number;
}

/** A source's rows saved as a dataset. */
export interface ResearchImport {
  sourceId: string;
  datasetId: string;
  rows: number;
  license: string;
  revision: string | null;
  at: string;
}
