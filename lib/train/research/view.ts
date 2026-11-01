/** A research run as its page shows it: each source says for itself whether it can be imported, from the server's rules. */
import { importability, licenseClass, type LicenseClass } from "@/lib/train/research/logic";
import type { ResearchRow } from "@/lib/train/research/store";
import type { ResearchSource } from "@/lib/train/research/types";

export interface ResearchSourceView extends ResearchSource {
  licenseClass: LicenseClass;
  /** "hf", "file", or null when it's read only. */
  importAs: "hf" | "file" | null;
  readOnlyReason: string | null;
  datasetId: string | null;
}

export interface ResearchView {
  id: string;
  task: string;
  status: ResearchRow["status"];
  questions: string[];
  searched: number;
  note: string | null;
  error: string | null;
  costUsd: number;
  maxUsd: number;
  sources: ResearchSourceView[];
}

export function toResearchView(row: ResearchRow): ResearchView {
  const imported = new Map(row.imports.map((i) => [i.sourceId, i.datasetId]));
  return {
    id: row.id,
    task: row.task,
    status: row.status,
    questions: row.questions,
    searched: row.findings.length,
    note: row.note,
    error: row.error,
    costUsd: row.costUsd,
    maxUsd: row.maxUsd,
    sources: row.sources.map((s) => {
      const can = importability(s);
      return {
        ...s,
        licenseClass: licenseClass(s.license),
        importAs: can.ok ? can.target.kind : null,
        readOnlyReason: can.ok ? null : can.reason,
        datasetId: imported.get(s.id) ?? null,
      };
    }),
  };
}
