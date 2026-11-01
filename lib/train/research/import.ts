/**
 * Reads a picked source's rows (docs/TRAINING.md "Data research"), with the limits a person's upload has
 * (checkDecisionUpload's 4 MB and 3,000 rows) and the PII scan. Decides again from the stored source: nothing the page
 * sends can make a read-only source importable. Rows the personal-data scan flags are dropped and counted; the rest come in.
 */
import { env } from "@/lib/env";
import { DECISION_ROWS_MAX, DECISION_UPLOAD_MAX_BYTES } from "@/lib/train/decision-datasets";
import { DATASET_MAX_COUNT, dedupePrompts } from "@/lib/train/logic";
import { piiFindings } from "@/lib/train/public/content";
import { FetchRefused, realFetchDeps, safeGet, type FetchDeps } from "@/lib/train/research/fetch";
import { importability, licenseClass } from "@/lib/train/research/logic";
import type { ResearchSource } from "@/lib/train/research/types";
import { EXAMPLE_ANSWER_MAX, EXAMPLE_PROMPT_MAX, objectRow, parseExamples } from "@/lib/train/tune/examples";
import type { ExampleRow } from "@/lib/train/tune/types";

/** Enough to hold out eval items and still train (the fewest a run takes). */
export const IMPORT_MIN_ROWS = 40;
const DEADLINE_MS = 50_000;
const DATASETS_SERVER = "https://datasets-server.huggingface.co";
const HF_PAGE = 100;

export type ImportResult =
  | { ok: true; rows: ExampleRow[]; read: number; dropped: number; license: string; revision: string | null; note: string }
  | { ok: false; status: number; error: string; message: string };

const refuse = (status: number, error: string, message: string): ImportResult => ({ ok: false, status, error, message });

/** Parses JSON from a fixed host's answer, or null. */
function json(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The Hub's own word on a public dataset: its license from the card, and the commit read. */
export function hubLicense(info: Record<string, unknown>): { refusal: string | null; license: string; revision: string | null } {
  const card = info.cardData as { license?: unknown } | null | undefined;
  const raw = Array.isArray(card?.license) ? (card.license.length === 1 ? card.license[0] : "") : card?.license;
  const license = typeof raw === "string" ? raw : "unknown";
  const revision = typeof info.sha === "string" ? info.sha : null;
  if (info.private === true || (info.gated !== false && info.gated !== undefined)) {
    return { refusal: "It is private or gated on Hugging Face, so it is read only.", license, revision };
  }
  if (licenseClass(license) !== "open") {
    return { refusal: `Hugging Face lists its license as ${license}, which isn't one that clearly allows this.`, license, revision };
  }
  return { refusal: null, license, revision };
}

async function hubRows(repo: string, deps: FetchDeps, deadline: number): Promise<ImportResult | { rows: ExampleRow[]; read: number; license: string; revision: string | null }> {
  const budget = { maxBytes: DECISION_UPLOAD_MAX_BYTES, deadline };
  const info = json(await safeGet(`${env.hfEndpoint}/api/datasets/${repo}`, budget, deps));
  if (!info) return refuse(502, "source_unreadable", "Hugging Face didn't describe this dataset.");
  const hub = hubLicense(info);
  if (hub.refusal) return refuse(422, "not_importable", hub.refusal);

  const q = `dataset=${encodeURIComponent(repo)}`;
  const splits = json(await safeGet(`${DATASETS_SERVER}/splits?${q}`, budget, deps))?.splits;
  const list = Array.isArray(splits) ? (splits as Array<{ config?: unknown; split?: unknown }>) : [];
  const split = list.find((s) => s.split === "train") ?? list[0];
  if (typeof split?.config !== "string" || typeof split.split !== "string") {
    return refuse(422, "source_unreadable", "Hugging Face has no readable rows for this dataset.");
  }
  const rows: ExampleRow[] = [];
  let read = 0;
  let bytes = 0;
  for (let offset = 0; offset < DECISION_ROWS_MAX && Date.now() < deadline - 5_000; offset += HF_PAGE) {
    const url = `${DATASETS_SERVER}/rows?${q}&config=${encodeURIComponent(split.config)}&split=${encodeURIComponent(split.split)}&offset=${offset}&length=${HF_PAGE}`;
    const text = await safeGet(url, budget, deps);
    bytes += text.length;
    const page = json(text)?.rows;
    const got = Array.isArray(page) ? (page as Array<{ row?: unknown }>) : [];
    for (const r of got) {
      read++;
      const row = objectRow(r.row);
      if (row) rows.push(row);
    }
    if (got.length < HF_PAGE || bytes > DECISION_UPLOAD_MAX_BYTES) break;
  }
  return { rows, read, license: hub.license, revision: hub.revision };
}

/** Rows a parser cut at its limit read as broken, so they are dropped rather than taught. */
function usable(r: ExampleRow): boolean {
  return r.prompt.length < EXAMPLE_PROMPT_MAX && r.answer.length < EXAMPLE_ANSWER_MAX;
}

/**
 * The source's rows, checked, or why not. `licenseConfirmed` is the admin's statement that they read a plain file's
 * license on its page: nothing but the model's reading of the page says what it is, unlike the Hub's own field.
 */
export async function importSource(source: ResearchSource, licenseConfirmed: boolean, deps: FetchDeps = realFetchDeps): Promise<ImportResult> {
  const can = importability(source);
  if (!can.ok) return refuse(422, "not_importable", can.reason);
  const deadline = Date.now() + DEADLINE_MS;
  let raw: ExampleRow[];
  let read: number;
  let license = source.license;
  let revision: string | null = null;
  try {
    if (can.target.kind === "hf") {
      const got = await hubRows(can.target.repo, deps, deadline);
      if ("ok" in got) return got;
      ({ rows: raw, read, license, revision } = got);
    } else {
      if (!licenseConfirmed) return refuse(400, "confirm_license", "Confirm you read the license on its page first.");
      const parsed = parseExamples(await safeGet(can.target.url, { maxBytes: DECISION_UPLOAD_MAX_BYTES, deadline }, deps), can.target.name, DECISION_ROWS_MAX);
      if (parsed.format === "text") return refuse(422, "source_unreadable", "It didn't read as rows of a prompt and an answer.");
      raw = parsed.rows;
      read = parsed.total;
    }
  } catch (err) {
    if (err instanceof FetchRefused) return refuse(422, "source_unreadable", err.message);
    console.error("[train/research] read", err);
    return refuse(502, "source_unreadable", "The source couldn't be read.");
  }

  const fit = raw.filter(usable);
  const byPrompt = new Map(fit.map((r) => [r.prompt, r]));
  const prompts = dedupePrompts([], fit.map((r) => r.prompt), DATASET_MAX_COUNT);
  const unique = prompts.map((p) => byPrompt.get(p)!);
  // The owner's call (Nov 1): one stray phone number shouldn't block a large dataset, so only the flagged rows go.
  const rows = unique.filter((row) => piiFindings({ rows: [row] }).length === 0);
  const flagged = unique.length - rows.length;
  if (rows.length < IMPORT_MIN_ROWS) {
    return refuse(422, "too_few_rows", `It has ${rows.length} usable rows with a prompt and an answer, and an import needs ${IMPORT_MIN_ROWS}.`);
  }

  const at = revision ? ` at ${revision.slice(0, 12)}` : "";
  return {
    ok: true,
    rows,
    read,
    dropped: read - rows.length,
    license,
    revision,
    note: `Imported from ${source.url}${at}, license ${license}. ${rows.length} of ${read} rows kept${flagged ? `, ${flagged} dropped for what looked like personal data` : ""}. Keep its license and attribution with anything made from it.`,
  };
}
