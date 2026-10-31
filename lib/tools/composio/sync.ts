/**
 * Builds the committed tool catalog from the curated policy and what Composio reports. Everything that talks to
 * Composio is injected, so the refusals can be tested without a network or a key.
 */
import {
  DENIED_CATEGORIES,
  denialOfSlug,
  denialOfToolkit,
  type FunctionPolicy,
  type OutputRule,
  type SourceRule,
  type ToolAccess,
  type ToolPolicy,
  type ToolTier,
} from "@/lib/tools/catalog.source";

/** The parts of `GET /api/v3.1/tools/{slug}` the sync reads. */
export type RemoteTool = {
  slug: string;
  version: string;
  toolkit: { slug: string };
  description?: string;
  input_parameters?: JsonSchema;
  tags?: string[];
  is_deprecated?: boolean;
  deprecated?: { is_deprecated?: boolean };
  instant?: { supported?: boolean; price?: { description?: string; discount?: string } };
};

export type RemoteToolkit = { slug: string; categories: string[] };

export type SyncDeps = {
  /** With no version, Composio answers with the latest. Instant metadata only appears on the latest. */
  fetchTool: (slug: string, version?: string) => Promise<RemoteTool>;
  fetchToolkit: (slug: string) => Promise<RemoteToolkit>;
};

export type JsonSchema = { [key: string]: unknown };

export type CatalogFunction = {
  type: "function";
  name: string;
  /** The schema was read at this toolkit version. Composio runs the latest, so never send it to session execute. */
  version: string;
  description: string;
  parameters: JsonSchema;
  strict: false;
  instant: boolean;
  /** List price, an upper bound for a reservation. Settle at the reply's instant charge. Excludes Composio's call fee. */
  estimateUsd: number;
  priceText: string | null;
  discountPercent: number | null;
  hints: string[];
  sample: unknown;
};

export type CatalogTool = {
  id: string;
  label: string;
  stepTitle: string;
  tier: ToolTier;
  access: ToolAccess;
  toolkit: string | null;
  builtin: boolean;
  perMinute: number | null;
  perDay: number | null;
  recipientFields: string[];
  sources: SourceRule[];
  output: OutputRule | null;
  outputVerified: boolean;
  functions: CatalogFunction[];
};

export type Catalog = {
  catalogVersion: 1;
  /** Pass as `instant.toolkits.enable` in sessions. */
  instantToolkits: string[];
  /** Used on the owner's own connection only. */
  personalToolkits: string[];
  toolkitVersions: Record<string, string>;
  tools: CatalogTool[];
};

export const MAX_DESCRIPTION_CHARS = 400;
export const MAX_PARAM_DESCRIPTION_CHARS = 240;
/** About 1,500 tokens at 4 characters each, for a function's name, description and parameters together. */
export const MAX_FUNCTION_CHARS = 6000;
const MAX_DEFAULT_CHARS = 32;

export const META_FUNCTION_NAME = /^[a-zA-Z0-9_.-]+$/;
/** Names Meta's web_search injects. A function tool reusing one gets HTTP 400. */
export const RESERVED_FUNCTION_NAMES: readonly string[] = ["browser.search", "browser.open", "browser.find"];

const HINT_TAGS = new Set(["readOnlyHint", "createHint", "updateHint", "destructiveHint", "idempotentHint", "openWorldHint"]);
const WRITE_NOTICE = "Needs the user's confirmation before it runs.";
const SCHEMA_KEYS = new Set(["type", "description", "enum", "items", "properties", "required", "anyOf", "oneOf", "format", "minimum", "maximum", "default", "additionalProperties"]);

export class CatalogRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogRefusal";
  }
}

const refuse = (message: string): never => {
  throw new CatalogRefusal(message);
};

/** Returns why a function name breaks Meta's rules, or null. */
export const functionNameProblem = (name: string): string | null => {
  if (!META_FUNCTION_NAME.test(name)) return `${name} doesn't match Meta's function name pattern`;
  if ((name.match(/\./g) ?? []).length > 1) return `${name} has more than one dot`;
  if (RESERVED_FUNCTION_NAMES.includes(name.toLowerCase())) return `${name} is reserved by Meta's web_search`;
  return null;
};

const plain = (text: string) => text.replace(/\s+/g, " ").replace(/[–—]/g, "-").trim();

/** Clips at a sentence end when one is near, otherwise at a word. */
export const clip = (text: string, max: number): string => {
  const clean = plain(text);
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max);
  const sentence = head.lastIndexOf(". ");
  if (sentence > max * 0.5) return head.slice(0, sentence + 1);
  return `${head.slice(0, head.lastIndexOf(" ")).replace(/[,;:]$/, "")}...`;
};

const trimNode = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(trimNode);
  if (!node || typeof node !== "object") return node;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    if (!SCHEMA_KEYS.has(key)) continue;
    if (key === "description" && typeof value === "string") out[key] = clip(value, MAX_PARAM_DESCRIPTION_CHARS);
    else if (key === "default") {
      if (value !== null && JSON.stringify(value).length <= MAX_DEFAULT_CHARS) out[key] = value;
    } else if (key === "properties" && value && typeof value === "object") {
      // Here the keys are parameter names, not schema keywords, so "title" or "format" as a parameter survives.
      out[key] = Object.fromEntries(Object.entries(value as JsonSchema).map(([name, prop]) => [name, trimNode(prop)]));
    } else if (key === "items" || key === "anyOf" || key === "oneOf" || key === "additionalProperties") {
      out[key] = trimNode(value);
    } else out[key] = value;
  }
  return out;
};

/** Keeps only the allowed parameters and the schema keywords a model needs. */
export const trimSchema = (fn: FunctionPolicy, input: JsonSchema | undefined): JsonSchema => {
  const properties = (input?.properties ?? {}) as JsonSchema;
  const kept: JsonSchema = {};
  for (const name of fn.keepParams) {
    if (!(name in properties)) refuse(`${fn.slug} has no parameter ${name}`);
    const prop = trimNode(fn.paramSchemas?.[name] ?? properties[name]) as JsonSchema;
    const override = fn.paramDescriptions?.[name];
    kept[name] = override ? { ...prop, description: plain(override) } : prop;
  }
  const upstream = Array.isArray(input?.required) ? (input.required as string[]) : [];
  const required = fn.required ?? upstream.filter((name) => fn.keepParams.includes(name));
  for (const name of required) {
    if (!fn.keepParams.includes(name)) refuse(`${fn.slug} requires ${name}, which isn't kept`);
  }
  return { type: "object", properties: kept, ...(required.length ? { required } : {}), additionalProperties: false };
};

const isDeprecated = (tool: RemoteTool) =>
  tool.is_deprecated === true || tool.deprecated?.is_deprecated === true || (tool.tags ?? []).includes("deprecated");

const tagsOf = (tool: RemoteTool) => tool.tags ?? [];

/** The first dollar figure in a price line such as "$0.008 per web search." */
export const listPriceUsd = (description: string | undefined): number | null => {
  const match = description?.match(/\$(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
};

const checkRemote = (policy: ToolPolicy, fn: FunctionPolicy, tool: RemoteTool, which: string) => {
  if (denialOfSlug(tool.slug)) refuse(denialOfSlug(tool.slug) as string);
  const toolkit = tool.toolkit?.slug?.toLowerCase();
  if (toolkit !== policy.toolkit) refuse(`${fn.slug} belongs to ${toolkit} at ${which}, not ${policy.toolkit}`);
  if (denialOfToolkit(toolkit)) refuse(denialOfToolkit(toolkit) as string);
  if (tagsOf(tool).includes("destructiveHint")) refuse(`${fn.slug} has destructiveHint at ${which}`);
  if (isDeprecated(tool)) refuse(`${fn.slug} is deprecated at ${which}`);
  if (/\bexa\b/i.test(tool.description ?? "")) refuse(`${fn.slug} mentions Exa at ${which}`);
};

const buildFunction = async (policy: ToolPolicy, fn: FunctionPolicy, pin: string, deps: SyncDeps, notes: string[]): Promise<CatalogFunction> => {
  // Refused from the policy alone, so a denied tool never costs even a lookup.
  const denied = denialOfSlug(fn.slug);
  if (denied) refuse(denied);
  const nameProblem = functionNameProblem(fn.slug);
  if (nameProblem) refuse(nameProblem);

  const pinned = await deps.fetchTool(fn.slug, pin);
  const latest = await deps.fetchTool(fn.slug);
  checkRemote(policy, fn, pinned, `version ${pin}`);
  checkRemote(policy, fn, latest, "the latest version");

  if (pinned.version !== pin) refuse(`${fn.slug} came back at ${pinned.version}, not the pinned ${pin}`);
  if (latest.version !== pin) notes.push(`${fn.slug}: pinned ${pin}, latest ${latest.version}`);

  // Composio always runs the latest version, so a schema that no longer fits it would fail in production.
  const latestProps = (latest.input_parameters?.properties ?? {}) as JsonSchema;
  for (const name of fn.keepParams) {
    if (!(name in latestProps)) refuse(`${fn.slug} no longer has ${name} at ${latest.version}. Update the policy and the pin`);
  }
  const latestRequired = Array.isArray(latest.input_parameters?.required) ? (latest.input_parameters.required as string[]) : [];
  for (const name of latestRequired) {
    if (!fn.keepParams.includes(name)) refuse(`${fn.slug} now requires ${name} at ${latest.version}, which isn't kept`);
  }

  const tags = tagsOf(latest);
  if (policy.access === "read" && !fn.readDespiteTags && (tags.includes("createHint") || tags.includes("updateHint"))) {
    refuse(`${fn.slug} is declared read, but Composio tags it ${tags.join(", ")}. Add readDespiteTags if that's wrong`);
  }

  const instant = latest.instant?.supported === true;
  let estimateUsd = 0;
  let priceText: string | null = null;
  let discountPercent: number | null = null;
  if (policy.tier === "public") {
    if (!instant) refuse(`${fn.slug} is public but isn't Instant-supported`);
    priceText = latest.instant?.price?.description ?? null;
    const price = listPriceUsd(priceText ?? undefined);
    // Composio warns that a missing price doesn't mean free, so no price means no entry.
    if (price === null || price <= 0) refuse(`${fn.slug} has no usable Instant price: ${priceText}`);
    estimateUsd = price as number;
    const discount = Number(latest.instant?.price?.discount);
    discountPercent = Number.isFinite(discount) ? discount : null;
  }

  const description = clip(policy.access === "read" ? fn.description : `${fn.description} ${WRITE_NOTICE}`, MAX_DESCRIPTION_CHARS);
  if (policy.access !== "read" && !description.endsWith(WRITE_NOTICE)) refuse(`${fn.slug}: the description is too long to keep the confirmation notice`);
  const parameters = trimSchema(fn, pinned.input_parameters);
  const size = JSON.stringify({ name: fn.slug, description, parameters }).length;
  if (size > MAX_FUNCTION_CHARS) refuse(`${fn.slug} is ${size} characters after trimming, over ${MAX_FUNCTION_CHARS}`);

  return {
    type: "function",
    name: fn.slug,
    version: pin,
    description,
    parameters,
    strict: false,
    instant,
    estimateUsd,
    priceText,
    discountPercent,
    hints: tags.filter((tag) => HINT_TAGS.has(tag)).sort(),
    sample: fn.sample,
  };
};

export type SyncResult = { catalog: Catalog; notes: string[] };

/** Throws CatalogRefusal on the first problem, so a bad policy never produces a file. */
export const buildCatalog = async (policies: ToolPolicy[], pins: Record<string, string>, deps: SyncDeps): Promise<SyncResult> => {
  const notes: string[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  // The whole policy is checked for denied names first, before any network call.
  for (const policy of policies) {
    if (policy.toolkit) {
      const denied = denialOfToolkit(policy.toolkit);
      if (denied) refuse(`${policy.id}: ${denied}`);
    }
    for (const fn of policy.functions) {
      const denied = denialOfSlug(fn.slug);
      if (denied) refuse(`${policy.id}: ${denied}`);
    }
  }

  const categoriesSeen = new Set<string>();
  const tools: CatalogTool[] = [];
  for (const policy of policies) {
    if (seenIds.has(policy.id)) refuse(`Duplicate tool id ${policy.id}`);
    seenIds.add(policy.id);

    if (policy.builtin) {
      if (policy.toolkit || policy.functions.length) refuse(`${policy.id} is built in, so it takes no toolkit or functions`);
    } else {
      if (!policy.toolkit) return refuse(`${policy.id} has no toolkit`);
      if (!policy.functions.length) refuse(`${policy.id} has no functions`);
      const pin = pins[policy.toolkit];
      if (!pin) return refuse(`No pinned version for toolkit ${policy.toolkit}`);
      if (!categoriesSeen.has(policy.toolkit)) {
        categoriesSeen.add(policy.toolkit);
        const { categories } = await deps.fetchToolkit(policy.toolkit);
        // Composio's slugs use hyphens ("team-chat") and its names use spaces ("Team Chat").
        const hit = categories.find((c) => DENIED_CATEGORIES.includes(c.toLowerCase().replace(/-/g, " ")));
        if (hit) refuse(`Toolkit ${policy.toolkit} is in the denied category "${hit}"`);
      }
    }

    const functions: CatalogFunction[] = [];
    for (const fn of policy.functions) {
      if (seenNames.has(fn.slug)) refuse(`${fn.slug} appears in two tools`);
      seenNames.add(fn.slug);
      functions.push(await buildFunction(policy, fn, pins[policy.toolkit as string], deps, notes));
    }
    tools.push({
      id: policy.id,
      label: plain(policy.label),
      stepTitle: plain(policy.stepTitle),
      tier: policy.tier,
      access: policy.access,
      toolkit: policy.toolkit ?? null,
      builtin: policy.builtin === true,
      perMinute: policy.perMinute ?? null,
      perDay: policy.perDay ?? null,
      recipientFields: policy.recipientFields ?? [],
      sources: policy.sources ?? [],
      output: policy.output ?? null,
      outputVerified: policy.outputVerified === true,
      functions,
    });
  }

  const toolkitsOf = (tier: ToolTier) => [...new Set(tools.filter((t) => t.tier === tier && t.toolkit).map((t) => t.toolkit as string))].sort();
  const used = [...toolkitsOf("public"), ...toolkitsOf("personal")];
  return {
    catalog: {
      catalogVersion: 1,
      instantToolkits: toolkitsOf("public"),
      personalToolkits: toolkitsOf("personal"),
      toolkitVersions: Object.fromEntries(used.map((slug) => [slug, pins[slug]])),
      tools,
    },
    notes,
  };
};

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as JsonSchema)
      .sort()
      .map((key) => [key, sortKeys((value as JsonSchema)[key])]),
  );
};

/** Sorted keys and no timestamp: the same inputs always give the same bytes. */
export const stableJson = (value: unknown): string => `${JSON.stringify(sortKeys(value), null, 2)}\n`;
