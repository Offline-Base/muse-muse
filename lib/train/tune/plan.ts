/**
 * The plan of a run started like a build (docs/TRAINING.md "Fine-tune like a build"): one respondStructured call on
 * Muse Wonder names the model, sums it up and checks the task against the brief writer's refusal policy, and the
 * platform fills in everything else from fixed defaults. The plan is signed for its caller, so Start (POST
 * /api/train/runs) never asks Muse Wonder again and can't start a task the card didn't show. Costs are recomputed on the
 * server from the settings (planCost), never taken from the browser.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { textPart } from "@/lib/brief/media";
import { cleanStrings } from "@/lib/brief/normalize";
import { respondStructured, StructuredOutputError, type StructuredOptions, type StructuredResult } from "@/lib/brief/structured";
import { testModel } from "@/lib/env";
import { REFUSE_WHEN } from "@/lib/prompts/brief";
import { canonicalJson, mac, sameMac } from "@/lib/tools/sign";
import { DATASET_TASK_MAX } from "@/lib/train/logic";
import { planCost, planSettings, TUNE_MAX_EXAMPLES, TUNE_MIN_EXAMPLES } from "@/lib/train/tune/cost";
import { foldExamples } from "@/lib/train/tune/examples";
import type { ExampleRow, TrainPlan, TrainPlanBody, TrainPlanSource } from "@/lib/train/tune/types";
import type { ModelUsage } from "@/lib/types";

/** The model that drafts plans in production. TEST_MODEL (Spark 1.3 Contributor, never on production) stands in for tests. */
export const PLAN_MODEL = "muse-wonder-1.0";

export function planModel(): string {
  return testModel() ?? PLAN_MODEL;
}

// ---------------------------------------------------------------------------------------------------------------
// The signed plan

/** How long a drafted plan can be started. */
export const PLAN_VALID_MS = 2 * 60 * 60_000;

/** sha256 of the plan's canonical JSON, without its token and expiry. */
export function planHash(body: TrainPlanBody): string {
  const { token: _t, exp: _e, ...rest } = body as TrainPlanBody & { token?: string; exp?: string };
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

function planMac(callerId: string, body: TrainPlanBody, exp: string): string {
  return mac("train-plan", [callerId, planHash(body), exp]);
}

/** The plan with its token, good for PLAN_VALID_MS for this caller only. */
export function signPlan(body: TrainPlanBody, callerId: string, now: Date): TrainPlan {
  const exp = new Date(now.getTime() + PLAN_VALID_MS).toISOString();
  return { ...body, token: planMac(callerId, body, exp), exp };
}

const money = z.number().finite().min(0).max(100_000);
const SettingsSchema = z.object({
  examples: z.number().int().min(TUNE_MIN_EXAMPLES).max(TUNE_MAX_EXAMPLES),
  recipe: z.literal("glimmer-lora"),
  steps: z.number().int().min(1).max(10_000),
  loraRank: z.number().int().min(1).max(1024),
  learningRate: z.number().finite().positive().max(1),
  studentPrompt: z.literal("short"),
  publish: z.literal(0),
  gpu: z.string().min(1).max(64),
  maxMinutes: z.number().int().min(1).max(10_000),
  maxUsd: money,
});
const SourceSchema = z.union([
  z.object({ kind: z.literal("task") }),
  z.object({ kind: z.literal("dataset"), datasetId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("build"), buildId: z.string().min(1).max(64), productId: z.string().min(1).max(64) }),
]);
/** A plan as the browser sends it back. Unknown keys are dropped, so they can't change the hash. */
const PlanSchema = z.object({
  v: z.literal(1),
  kind: z.enum(["chat", "decision"]),
  name: z.string().min(1).max(200),
  tagline: z.string().max(400),
  task: z.string().min(1).max(DATASET_TASK_MAX),
  samples: z.array(z.string().max(400)).max(3),
  examples: z.object({ given: z.number().int().min(0).max(100_000), used: z.number().int().min(0).max(100_000) }),
  settings: SettingsSchema,
  cost: z.object({
    metaLowUsd: money,
    metaHighUsd: money,
    gpuMaxUsd: money,
    scoreLowUsd: money,
    scoreHighUsd: money,
    minutes: z.number().finite().min(0).max(100_000),
    trainMinutes: z.number().finite().min(0).max(100_000),
  }),
  source: SourceSchema,
  token: z.string().min(1).max(200),
  exp: z.string().min(1).max(40),
});

export type PlanCheck = { ok: true; plan: TrainPlanBody } | { ok: false; reason: "malformed" | "expired" | "bad_token" };

/**
 * The plan's body when its token is this caller's, for exactly this plan, and hasn't expired. A plan whose task,
 * name, settings or cost were changed after it was signed, or signed for someone else, is refused ("bad_token").
 */
export function verifyPlan(raw: unknown, callerId: string, now: Date): PlanCheck {
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const { token, exp, ...body } = parsed.data;
  const expMs = Date.parse(exp);
  if (!Number.isFinite(expMs) || new Date(expMs).toISOString() !== exp) return { ok: false, reason: "malformed" };
  if (!sameMac(token, planMac(callerId, body as TrainPlanBody, exp))) return { ok: false, reason: "bad_token" };
  if (expMs <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, plan: body as TrainPlanBody };
}

// ---------------------------------------------------------------------------------------------------------------
// Drafting

/** Field order puts the reasoning and the decision first, as the brief writer's checks do. */
const DraftSchema = z.object({
  reason: z.string().min(1),
  refuse: z.boolean(),
  refusal: z.string().nullable(),
  kind: z.enum(["chat", "decision"]),
  name: z.string().min(1).max(80),
  tagline: z.string().min(1).max(160),
  samples: z.array(z.string().min(1).max(300)).min(1).max(3),
});
export type PlanDraft = z.infer<typeof DraftSchema>;

export const DEFAULT_TUNE_REFUSAL = "Muse Muse can't train a model for this.";

export function planInstructions(): string {
  return `You plan a fine-tuning run on Muse Muse. A person describes what a small model should do, sometimes with a few of their own examples. Muse Wonder will write about 200 examples of the task, Muse Glimmer 30B with 2026 knowledge trains on them on one GPU, and the tuned model is scored against the 2026 Glimmer it started from on prompts kept aside.

Decide first
- refuse is true when the task involves ${REFUSE_WHEN}, or when it would train on real people's private details (names with contact details, health, money or school records). Teaching a model to talk about a public topic is fine.
- refusal is null unless refuse is true. Then it tells the person why in one or two plain sentences and suggests a safe alternative when there is one. Still fill every other field briefly.

Writing the plan
- kind is "decision" when the model's whole job is to pick one of a few fixed labels for each input (sorting tickets, approve or flag). Anything that answers in its own words is "chat".
- name is the model's role, 2 to 6 words, at most 60 characters, written so "You are " followed by it reads well, like "a bakery's counter helper" or "a friendly plant care coach". Never a real product's or company's name, and never Meta, Muse or Llama.
- tagline is one line, at most 100 characters, saying what it does for whom.
- samples are 2 or 3 short, realistic messages someone might send it, each under 120 characters, in their own words.
- Don't use em dashes.`;
}

function draftText(task: string, rows: number): string {
  const own = rows ? `\n\nThe person gave ${rows} of their own examples; they are folded into the task above.` : "";
  return `What the model should do:\n${task}${own}`;
}

/** The person's refusal message: null when the plan may go on, else the model's own words or a plain fallback. */
export function draftRefusal(d: Pick<PlanDraft, "refuse" | "refusal">): string | null {
  if (!d.refuse) return null;
  return d.refusal?.trim() || DEFAULT_TUNE_REFUSAL;
}

/**
 * TODO(open-train U3): open-train's piiFindings(task, rows) pattern scan goes here once it lands. Until then nothing
 * extra is scanned: the plan's own refusal (REFUSE_WHEN plus real people's private details) is the only content check,
 * as for the datasets route, which has none. Each finding is a plain sentence; any finding refuses the plan with a 422.
 */
export function contentFindings(_input: { note: string; rows: readonly ExampleRow[] }): string[] {
  return [];
}

export interface DraftInput {
  note: string;
  rows: readonly ExampleRow[];
  callerId: string;
  /** How many examples the plan asks for (env.tuneDefaultExamples unless Advanced changed it). */
  examples: number;
  ceilings: { maxMinutes: number; maxUsd: number };
  source?: TrainPlanSource;
  now?: Date;
}

export interface DraftDeps {
  respond: <T>(opts: StructuredOptions<T>) => Promise<StructuredResult<T>>;
  model: () => string;
}

const defaultDeps: DraftDeps = { respond: respondStructured, model: planModel };

export type DraftResult =
  | { ok: true; plan: TrainPlan; usage: ModelUsage[] }
  | { ok: false; refusal: string; usage: ModelUsage[] };

/**
 * One structured call on the plan model, then the signed plan. Throws StructuredOutputError (with the usage it billed)
 * when neither attempt matched the schema, so a plan is never made from an unchecked task.
 */
export async function draftPlan(input: DraftInput, deps: DraftDeps = defaultDeps): Promise<DraftResult> {
  const folded = foldExamples(input.note, input.rows, DATASET_TASK_MAX);
  const result = await deps.respond({
    model: deps.model(),
    instructions: planInstructions(),
    content: [textPart(draftText(folded.task, folded.used))],
    schema: DraftSchema,
    schemaName: "training_plan",
    effort: "low",
    normalize: (raw) => cleanStrings(raw),
  });
  const refusal = draftRefusal(result.data);
  if (refusal) return { ok: false, refusal, usage: result.usage };
  const settings = planSettings(input.examples, input.ceilings);
  const d = result.data;
  const body: TrainPlanBody = {
    v: 1,
    kind: d.kind,
    name: d.name.replace(/^you are\s+/i, "").replace(/[.!]+$/, "").trim().slice(0, 60) || "Tuned helper",
    tagline: d.tagline.trim().slice(0, 120),
    task: folded.task,
    samples: d.samples.map((s) => s.trim().slice(0, 200)).filter(Boolean).slice(0, 3),
    examples: { given: input.rows.length, used: folded.used },
    settings,
    cost: planCost(settings),
    source: input.source ?? { kind: "task" },
  };
  return { ok: true, plan: signPlan(body, input.callerId, input.now ?? new Date()), usage: result.usage };
}

export { StructuredOutputError };
export { askedExamples, clampExamples, NOTE_MAX, NOTE_MIN, planCost, planMaxUsd, planSettings, TUNE_GPU, TUNE_LEARNING_RATE, TUNE_LORA_RANK, TUNE_MAX_EXAMPLES, TUNE_MAX_MINUTES, TUNE_MIN_EXAMPLES, TUNE_STEPS } from "@/lib/train/tune/cost";
