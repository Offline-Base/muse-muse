import { z } from "zod";
import { CAP_BRIEF_FIELDS, writerBriefField } from "@/lib/caps/brief-fields";
import type { CapId } from "@/lib/caps/ids";
import { MilestonesSchema } from "@/lib/engine/milestones";
import { PERSONAL_TOOL_IDS, PUBLIC_TOOL_IDS } from "@/lib/tools/ids";

/**
 * What a product may call. muse-glimmer means a self-hosted Glimmer endpoint, not the Model API. muse-gadget means a
 * physical board's camera and microphone, through the gateway's /gadget route (docs/GADGETS.md).
 */
export const PRODUCT_MODELS = [
  "muse-spark-1.3",
  "muse-wonder-1.0",
  "muse-image-1.0",
  "sam-3.1",
  "muse-voice-transcribe-1.0",
  "muse-glimmer",
  "muse-gadget",
] as const;

/**
 * Where a product runs (docs/NATIVE.md). Every product is a web product, so "web" is always in; a brief adds the others,
 * each behind its flag (env.enabledTargets).
 */
export const TARGETS = ["web", "phone", "desktop", "vr", "glasses", "agent"] as const;
export type TargetId = (typeof TARGETS)[number];

const MediaKind = z.enum(["text", "image", "video", "audio", "pdf"]);

/** The fields of every brief. New briefs and stored briefs differ only in what is added to these below. */
const BriefFields = z.object({
  verdict: z.enum(["yes", "partly", "no"]),
  /** Set only when the request is refused under the policy in docs/DESIGN.md. */
  refusal: z.string().nullable(),
  name: z.string().min(1).max(60),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(40),
  tagline: z.string().min(1).max(120),
  user: z.string().min(1),
  /** How the inspo shapes the product. See "Inspired by, never a copy" in docs/DESIGN.md. */
  inspiration: z.object({
    summary: z.string().min(1),
    references: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        kind: z.enum(["image", "video", "audio", "pdf"]),
        describes: z.string().min(1),
      }),
    ),
    borrow: z.array(z.string()),
    dontCopy: z.array(z.string()),
  }),
  primaryFlow: z.array(z.string().min(1)).min(1).max(8),
  screens: z.array(z.object({ name: z.string(), purpose: z.string() })).max(5),
  capabilities: z
    .array(z.object({ need: z.string(), model: z.enum(PRODUCT_MODELS), why: z.string() }))
    .min(1),
  inputs: z.array(z.object({ kind: MediaKind, required: z.boolean(), notes: z.string() })),
  outputs: z.array(
    z.object({ kind: z.enum(["text", "image", "overlay", "video", "json", "file"]), notes: z.string() }),
  ),
  limits: z.array(z.string()),
  complexity: z.enum(["simple", "standard", "complex"]),
  estimatedCostPerRunUsd: z.number().nonnegative(),
  costNotes: z.string(),
  fixtures: z.array(
    z.object({
      kind: MediaKind,
      description: z.string(),
      fromUserSample: z.boolean(),
      /** Which reference (0-based) is the sample when fromUserSample is true. Optional for older briefs. */
      referenceIndex: z.number().int().nonnegative().nullable().optional(),
    }),
  ),
  actions: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/), description: z.string() })),
});

/** The brief's `targets` field, limited to these ids. */
const targetPicks = (ids: readonly [TargetId, ...TargetId[]]) =>
  z.array(z.object({ id: z.enum(ids), why: z.string().min(1).max(200) })).max(ids.length);

/** Most tools one agent may use (docs/AGENT_TOOLS.md). Fewer is better: each one is more for the model to read. */
export const MAX_AGENT_TOOLS = 6;

/** The longest askedLook a brief may carry. */
export const ASKED_LOOK_MAX = 400;
/** A live agent's run stops at 10 turns (RUN_LIMITS in lib/gateway/runs.ts), so a plan for more could never finish. */
export const MAX_AGENT_STEPS = 10;

/** The brief's `agent` field, limited to these tool ids. */
const agentFields = (toolIds: z.ZodType<string>) =>
  z.object({
    /** The job one run does, in one or two plain sentences. */
    task: z.string().min(1).max(400),
    tools: z.array(z.object({ id: toolIds, need: z.string().min(1), why: z.string().min(1) })).min(1).max(MAX_AGENT_TOOLS),
    /** "owner" when a personal tool needs the product's owner to connect an account. Settled by applyTargets. */
    connections: z.enum(["none", "owner"]),
    /** About how many model turns one run takes, for the cost arithmetic and the run's limits. */
    stepsPerRun: z.number().int().min(1).max(MAX_AGENT_STEPS),
  });

/**
 * The brief the brief model (env.briefModel, Muse Wonder by default) writes from a muse: the user's references plus an
 * optional note (docs/PROMPTS.md, prompt 1). It drives the build prompt, the gateway allowlist and the product page.
 * `targets` is optional, so older briefs still parse, and a brief without it runs on the web only (briefTargets in
 * lib/native/targets.ts). `agent` is set only when `targets` has agent. Its tool ids are plain strings here, since a tool
 * can leave the catalog after a brief was stored; the writer's schema below limits them.
 */
export const BriefSchema = BriefFields.extend({
  targets: targetPicks(TARGETS).optional(),
  agent: agentFields(z.string().min(1)).nullable().optional(),
  /**
   * The look the person asked for in their own words, or null (MUSE_APP_LOOK, docs/BRAND.md "Unless the person asks").
   * Unset or null, the product follows the muse-app UI guidelines as they are.
   */
  askedLook: z.string().max(ASKED_LOOK_MAX).nullable().optional(),
  ...wave3StoredFields(),
});

/**
 * Wave 3 (docs/CAPABILITIES.md, 2.6): every registered cap block and the engine's milestones, as optional and nullable
 * fields of the stored brief, so briefs written before them still parse.
 */
function wave3StoredFields() {
  const caps = Object.fromEntries(Object.entries(CAP_BRIEF_FIELDS).map(([key, schema]) => [key, (schema as z.ZodTypeAny).nullable().optional()])) as {
    [K in keyof typeof CAP_BRIEF_FIELDS]: z.ZodOptional<z.ZodNullable<(typeof CAP_BRIEF_FIELDS)[K]>>;
  };
  return { ...caps, milestones: MilestonesSchema.nullable().optional() };
}

export type Brief = z.infer<typeof BriefSchema>;

/** The models a new brief may pick: every product model but Muse Spark 1.3, which the platform never uses. */
export const NEW_PRODUCT_MODELS = PRODUCT_MODELS.filter(
  (m): m is Exclude<(typeof PRODUCT_MODELS)[number], "muse-spark-1.3"> => m !== "muse-spark-1.3",
) as [Exclude<(typeof PRODUCT_MODELS)[number], "muse-spark-1.3">, ...Exclude<(typeof PRODUCT_MODELS)[number], "muse-spark-1.3">[]];

/**
 * The schema the brief writer answers in: BriefSchema without Muse Spark 1.3. Briefs stored before keep their Spark
 * capabilities (the Brief type still allows it), and the gateway serves those products with Spark 1.3 Contributor.
 */
export const NewBriefSchema = BriefFields.extend({
  capabilities: z
    .array(z.object({ need: z.string(), model: z.enum(NEW_PRODUCT_MODELS), why: z.string() }))
    .min(1),
});

const NEW_PRODUCT_MODELS_NO_GADGET = NEW_PRODUCT_MODELS.filter((m) => m !== "muse-gadget") as unknown as typeof NEW_PRODUCT_MODELS;

/** NewBriefSchema without muse-gadget, for when GADGETS_ENABLED is off. */
export const NewBriefSchemaNoGadget = BriefFields.extend({
  capabilities: z
    .array(z.object({ need: z.string(), model: z.enum(NEW_PRODUCT_MODELS_NO_GADGET), why: z.string() }))
    .min(1),
});

/**
 * The schema the brief writer answers in for these flags. With no targets, no caps, no milestones and no MUSE_APP_LOOK
 * it is exactly NewBriefSchema or NewBriefSchemaNoGadget, the same objects. With targets it also requires `targets`,
 * limited to web and those. With the agent target it also requires `agent`, which is null for a product that isn't one,
 * limited to the public tools unless personal tools are on (COMPOSIO_PERSONAL_ENABLED). With MUSE_APP_LOOK it also
 * requires `askedLook`, null unless the person asked for a look. Each enabled cap with a registered block, and milestones
 * when ENGINE_MILESTONES is on, add a required but nullable field, since Meta's strict output needs every property.
 */
export function newBriefSchemaFor(opts: {
  gadgets: boolean;
  targets: readonly TargetId[];
  personalTools?: boolean;
  caps?: readonly CapId[];
  milestones?: boolean;
  museAppLook?: boolean;
}): z.ZodType<Brief> {
  const base = opts.gadgets ? NewBriefSchema : NewBriefSchemaNoGadget;
  const look = opts.museAppLook ? { askedLook: z.string().max(ASKED_LOOK_MAX).nullable() } : {};
  const ids = TARGETS.filter((t) => t === "web" || opts.targets.includes(t));
  const extra: Record<string, z.ZodTypeAny> = {};
  for (const cap of opts.caps ?? []) {
    // Wave 3, unit 3: a cap's writer block can differ from its stored one while a setting is off (DATA_SIGN_IN).
    const block = writerBriefField(cap);
    if (block) extra[cap] = block.nullable();
  }
  if (opts.milestones) extra.milestones = MilestonesSchema.nullable();
  if (ids.length === 1 && !Object.keys(extra).length && !opts.museAppLook) return base;
  const shape: Record<string, z.ZodTypeAny> = {};
  if (ids.length > 1) {
    shape.targets = targetPicks(ids as [TargetId, ...TargetId[]]).min(1);
    if (ids.includes("agent")) {
      const tools = (opts.personalTools ? [...PUBLIC_TOOL_IDS, ...PERSONAL_TOOL_IDS] : PUBLIC_TOOL_IDS) as [string, ...string[]];
      shape.agent = agentFields(z.enum(tools)).nullable();
    }
  }
  return base.extend({ ...shape, ...look, ...extra }) as unknown as z.ZodType<Brief>;
}

export type ProductModelId = (typeof PRODUCT_MODELS)[number];
