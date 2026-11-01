import type { DataCollectionRule } from "@/lib/caps/data/types";
import { jobsBlock } from "@/lib/caps/jobs/brief";

/**
 * Marks the collections a job may save to: the brief's jobs.results, which the platform wrote. A live product's manifest
 * can then only take that away (narrowCollectionRules). Anything else stays closed to jobs, and a stored brief with no
 * jobs block leaves the rules as they are.
 */
export function withJobWrites(rules: DataCollectionRule[] | null, brief: object | null): DataCollectionRule[] | null {
  const results = jobsBlock(brief)?.results;
  if (!rules || !results?.length) return rules;
  return rules.map((r) => (results.includes(r.name) ? { ...r, jobWrites: true } : r));
}
