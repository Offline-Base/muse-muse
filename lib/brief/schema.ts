import { z } from "zod";

/** Models a product may call. muse-glimmer means a self-hosted Glimmer endpoint, not the Model API. */
export const PRODUCT_MODELS = [
  "muse-spark-1.3",
  "muse-wonder-1.0",
  "muse-image-1.0",
  "sam-3.1",
  "muse-voice-transcribe-1.0",
  "muse-glimmer",
] as const;

const MediaKind = z.enum(["text", "image", "video", "audio", "pdf"]);

/**
 * The page recipes in the template's `.agents/skills/product-ui/recipes/<layout>.md`, one per kind of product. The
 * build prompt names the brief's recipe and the product marks its main with it (`data-recipe`, verify C20).
 */
export const LAYOUTS = ["generate", "extract", "workspace", "steps", "compare", "find", "chat"] as const;
export type Layout = (typeof LAYOUTS)[number];

/**
 * The brief the brief model (env.briefModel, Muse Wonder by default) writes from a muse: the user's references plus an
 * optional note (docs/PROMPTS.md, prompt 1). It drives the build prompt, the gateway allowlist and the product page.
 */
export const BriefSchema = z.object({
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
  /** The page recipe. Optional so briefs stored before round 4 still parse; normalizeRawBrief fills it for new ones. */
  layout: z.enum(LAYOUTS).optional(),
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

export type Brief = z.infer<typeof BriefSchema>;
export type ProductModelId = (typeof PRODUCT_MODELS)[number];
