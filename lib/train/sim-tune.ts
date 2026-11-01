/**
 * A tuned model on a simulated device (docs/TRAINING.md "Emulator runs"): which local file can go on the lab's Android
 * emulator, the fixed prompts it gets, the measurements the box reports and the view the model's page shows. Pure, so the
 * finish route, the page's card and the tests all share it. The queue side is in lib/train/sim-tune-server.ts.
 */
import { z } from "zod";
import type { LocalFile, LocalFiles } from "@/lib/train/local-files";

/** The whole job's limit: the queue's maximum, since the download, copy and load all come out of it. */
export const SIM_TUNE_LIMIT_SECONDS = 900;
export const SIM_TUNE_MAX_TOKENS = 256;
export const SIM_TUNE_KIND = "gguf_emu" as const;

/** The same prompts for every model, so two models' numbers and answers can be read side by side. */
export const SIM_TUNE_PROMPTS: ReadonlyArray<{ id: string; text: string }> = [
  { id: "explain", text: "Explain what a fine-tuned model is to someone who has never used AI, in two sentences." },
  { id: "list", text: "List three things to pack for a day hike." },
  { id: "math", text: "A train leaves at 2:15 PM and the trip takes 95 minutes. When does it arrive?" },
  { id: "rewrite", text: "Rewrite this to sound friendlier: Send me the report by Friday." },
  { id: "open", text: "I don't know what to ask you. What are you good at?" },
];

const shortText = (max: number) => z.string().transform((s) => s.slice(0, max));
const count = z.number().finite().min(0).nullable().catch(null);

/** What the box sends in its finish call. It's a claim from a box, so it's cut to size and only ever shown as text. */
export const SimTuneMeasured = z.object({
  loadMs: count,
  memory: z.object({ peakKb: count, rssKb: count, totalKb: count }).catch({ peakKb: null, rssKb: null, totalKb: null }),
  runs: z
    .array(
      z.object({
        id: shortText(40),
        answer: shortText(2000).catch(""),
        tokens: z.number().finite().min(0).catch(0),
        generateMs: z.number().finite().min(0).catch(0),
        tokensPerSecond: z.number().finite().min(0).catch(0),
        finish: shortText(20).nullable().catch(null),
        error: shortText(200).nullable().catch(null),
      }),
    )
    .max(10)
    .catch([]),
  stoppedEarly: z.boolean().catch(false),
});
export type SimTuneMeasured = z.infer<typeof SimTuneMeasured>;

export type SimTunePick = { ok: true; file: LocalFile; repo: string; commit: string; systemLine: string } | { ok: false; problem: string };

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/**
 * The smallest local file that can go on the emulator, or a plain sentence saying why none can. The lab box holds no Hub
 * token, so the repo must be public. A model that needs tuned.jinja would answer wrongly under the embedded template.
 */
export function pickSimTuneFile(files: LocalFiles | null, maxBytes: number): SimTunePick {
  if (!files || files.files.length === 0) return { ok: false, problem: "This model has no local files yet. Make them first." };
  if (!files.public || !files.repo || !files.commit) return { ok: false, problem: "The local files have to be public on Hugging Face: the device lab holds no Hugging Face token." };
  if (files.needsTunedTemplate) return { ok: false, problem: "This model was trained before trainChannel and needs its repo's tuned.jinja, which an emulator run doesn't load yet." };
  const smallest = [...files.files].sort((a, b) => a.bytes - b.bytes)[0];
  if (smallest.bytes > maxBytes) {
    return { ok: false, problem: `The smallest build, ${smallest.level}, is ${gb(smallest.bytes)}. The emulator run takes files up to ${gb(maxBytes)}, so this model is too big to run there.` };
  }
  return { ok: true, file: smallest, repo: files.repo, commit: files.commit, systemLine: files.systemLine };
}

export interface SimTuneRunView {
  jobId: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  file: { name: string; bytes: number } | null;
  summary: string | null;
  reasons: string[];
  device: string | null;
  /** The lab couldn't run it, so nothing is known about the model. */
  labError: boolean;
  loadMs: number | null;
  /** Every token generated, over the time spent generating them. Null before any were. */
  tokensPerSecond: number | null;
  peakMemoryKb: number | null;
  totalMemoryKb: number | null;
  stoppedEarly: boolean;
  answers: Array<{ id: string; prompt: string; answer: string; tokens: number; tokensPerSecond: number; error: string | null }>;
}

/** The columns of a native_jobs row this reads. */
export interface SimTuneJobRow {
  id: string;
  status: string;
  createdAt: Date;
  finishedAt: Date | null;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
}

const StoredInput = z.object({
  gguf: z.object({ name: z.string(), bytes: z.number() }).nullable().catch(null),
  prompts: z.array(z.object({ id: z.string(), text: z.string() })).catch([]),
});

/** One job as the model's page shows it. A result that doesn't parse reads as no measurements, never as a crash. */
export function simTuneRunView(row: SimTuneJobRow): SimTuneRunView {
  const input = StoredInput.safeParse(row.input);
  const prompts = input.success ? input.data.prompts : [];
  const result = row.result ?? {};
  const measured = SimTuneMeasured.safeParse(result.simTune);
  const m = measured.success ? measured.data : null;
  const tokens = m?.runs.reduce((sum, r) => sum + r.tokens, 0) ?? 0;
  const ms = m?.runs.reduce((sum, r) => sum + r.generateMs, 0) ?? 0;
  const device = result.device as { name?: unknown; os?: unknown } | null | undefined;
  return {
    jobId: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    file: input.success ? input.data.gguf : null,
    summary: typeof result.summary === "string" ? result.summary : null,
    reasons: Array.isArray(result.reasons) ? result.reasons.filter((r): r is string => typeof r === "string") : [],
    device: device ? [device.name, device.os && `Android ${String(device.os)}`].filter((p) => typeof p === "string" && p).join(", ") || null : null,
    labError: result.outcome === "lab_error",
    loadMs: m?.loadMs ?? null,
    tokensPerSecond: tokens > 0 && ms > 0 ? (tokens * 1000) / ms : null,
    peakMemoryKb: m?.memory.peakKb ?? null,
    totalMemoryKb: m?.memory.totalKb ?? null,
    stoppedEarly: m?.stoppedEarly ?? false,
    answers: (m?.runs ?? []).map((r) => ({
      id: r.id,
      prompt: prompts.find((p) => p.id === r.id)?.text ?? r.id,
      answer: r.answer,
      tokens: r.tokens,
      tokensPerSecond: r.tokensPerSecond,
      error: r.error,
    })),
  };
}

/** Queued or running, so a second run of this model isn't started and the card keeps looking. */
export const simTuneActive = (status: string): boolean => status === "queued" || status === "claimed";
