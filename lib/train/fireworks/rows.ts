/** A run's rows in Fireworks' formats, and its resource names. Pure. */
import type { EvalExample, TrainExample } from "@/lib/train/types";

/** Longer conversations are left out, as the Lambda path's GPU drops them. */
const MAX_CHARS = 2048 * 4;

/** Names Fireworks' resources by job, so a step that runs again finds the same ones. */
export function fwNames(jobId: string) {
  return {
    trainDataset: `mm-t-${jobId}`,
    evalDataset: `mm-e-${jobId}`,
    job: `mm-j-${jobId}`,
    model: `mm-m-${jobId}`,
    baseBatch: `mm-bb-${jobId}`,
    tunedBatch: `mm-bt-${jobId}`,
    baseOut: `mm-ob-${jobId}`,
    tunedOut: `mm-ot-${jobId}`,
  };
}

/** Chat JSONL under the run's one-line system message, as the Lambda path's short student prompt trains. */
export function trainJsonl(rows: readonly TrainExample[], system: string): { jsonl: string; count: number } {
  const lines: string[] = [];
  for (const row of rows) {
    const turns = (row.messages ?? []).filter((m) => m.role !== "system" && typeof m.content === "string");
    if (!turns.some((m) => m.role === "assistant" && m.content.trim())) continue;
    if (turns.reduce((n, m) => n + m.content.length, 0) > MAX_CHARS) continue;
    lines.push(JSON.stringify({ messages: [{ role: "system", content: system }, ...turns] }));
  }
  return { jsonl: lines.join("\n"), count: lines.length };
}

/** The kept-aside prompts as a batch job's input. custom_id carries the prompt's index. */
export function batchJsonl(rows: readonly EvalExample[], system: string, maxTokens: number): string {
  return rows
    .map((row, index) =>
      JSON.stringify({ custom_id: String(index), body: { messages: [{ role: "system", content: system }, { role: "user", content: row.prompt }], max_tokens: maxTokens, temperature: 0 } }),
    )
    .join("\n");
}

export interface BatchAnswers {
  answers: Map<number, string>;
  tokens: number;
}

/**
 * A batch job's results file. Fireworks' docs don't pin the row's shape, so it reads an OpenAI-style `response`, with or
 * without its `body`. Rows it can't read count as no answer, which leaves that prompt out of the scores.
 */
export function parseBatchOutput(text: string): BatchAnswers {
  const answers = new Map<number, string>();
  let tokens = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: { custom_id?: unknown; response?: { body?: unknown } & Record<string, unknown> };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const body = (row.response?.body ?? row.response) as { choices?: { message?: { content?: unknown } }[]; usage?: { total_tokens?: unknown } } | undefined;
    const index = Number(row.custom_id);
    const content = body?.choices?.[0]?.message?.content;
    tokens += Number(body?.usage?.total_tokens) || 0;
    if (Number.isInteger(index) && typeof content === "string") answers.set(index, content.trim());
  }
  return { answers, tokens };
}
