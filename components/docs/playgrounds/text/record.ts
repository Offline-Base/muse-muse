import type { RecordedRequest } from "@/components/docs/kit/DocsPageContext";
import type { DocsResult } from "@/lib/docs/client/api";
import { outcomeOfReply, trimForRecord } from "@/lib/docs/client/record";

/**
 * What a demo records for "Copy prompt for your coding agent" ("What I just ran"), built after the reply so the
 * Result line can carry the numbers the page is about: cached_tokens on prompt caching, reasoning tokens per effort,
 * the rule a check tested. useDocsRun fixes its record before the reply exists, and an `outcome` passed to it
 * replaces the start of the answer; these demos run with `record: false` and record through this instead. The shape
 * matches useDocsRun's own record (lib/docs/client/record trims the body the same way).
 */

/** The line a failed or stopped call records, as useDocsRun words it. */
export function failureOutcome(res: Pick<DocsResult, "status" | "error">): string {
  if (res.error?.code === "aborted") return "stopped before the reply finished";
  return outcomeOfReply(null, res.status, res.error?.message ?? "The request failed.");
}

export function recordOf(path: string, body: Record<string, unknown>, res: Pick<DocsResult, "status" | "model">, outcome: string): RecordedRequest {
  const bodyModel = typeof body.model === "string" ? body.model : undefined;
  return {
    method: "POST",
    path: path.replace(/^\/+/, "").replace(/^v1\//, ""),
    body: trimForRecord(body),
    ...(res.model && res.model !== bodyModel ? { model: res.model } : {}),
    status: res.status,
    outcome: outcome.replace(/\s+/g, " ").trim().slice(0, 300),
  };
}
