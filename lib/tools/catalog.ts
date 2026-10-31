import { hasAgentMarker } from "@/lib/gateway/policy";
import { denialOfSlug, denialOfToolkit } from "@/lib/tools/catalog.source";
import catalogJson from "@/lib/tools/composio/catalog.json";
import { META_FUNCTION_NAME, RESERVED_FUNCTION_NAMES, type Catalog, type CatalogFunction, type CatalogTool } from "@/lib/tools/composio/sync";
import { toolOfMarker, type ToolId } from "@/lib/tools/ids";

/** The generated catalog, read for the gateway. Products only ever see what it holds. */
export const CATALOG = catalogJson as unknown as Catalog;

/** Above this many functions, format=namespaced defers them behind Meta's tool_search. */
export const NAMESPACE_THRESHOLD = 8;

export const TOOLKIT_LABELS: Readonly<Record<string, string>> = { gmail: "Gmail", googlecalendar: "Google Calendar", slack: "Slack" };

export const toolkitLabel = (toolkit: string) => TOOLKIT_LABELS[toolkit] ?? toolkit;

const NAMESPACE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  serpapi: "Structured records of papers, places and events.",
  firecrawl: "Read one public web page at an address the user gave.",
  gmail: "Read, draft and send email in the connected Gmail account.",
  googlecalendar: "Read and add events on the connected Google Calendar.",
  slack: "Read, search and post in the connected Slack workspace.",
};

export function catalogTool(id: string): CatalogTool | null {
  return CATALOG.tools.find((t) => t.id === id) ?? null;
}

/** The reason a function may never run, whatever the catalog says. The catalog is checked at sync, and again here. */
export function denialOf(tool: CatalogTool, fn: CatalogFunction): string | null {
  return (
    denialOfSlug(fn.name) ??
    (tool.toolkit ? denialOfToolkit(tool.toolkit) : null) ??
    (fn.hints.includes("destructiveHint") ? `tool ${fn.name} is destructive` : null) ??
    (/DELETE|REMOVE|TRASH/.test(fn.name) ? `tool ${fn.name} deletes` : null)
  );
}

/** A function by its name, which is Composio's slug. Null for anything off the catalog, its finder and workbench included. */
export function findFunction(name: string): { tool: CatalogTool; fn: CatalogFunction } | null {
  for (const tool of CATALOG.tools) {
    const fn = tool.functions.find((f) => f.name === name);
    if (fn) return { tool, fn };
  }
  return null;
}

/** Null when Meta would accept this as a function name, else the reason it wouldn't. */
export function functionNameProblem(name: string): string | null {
  if (!META_FUNCTION_NAME.test(name)) return "it has characters Meta refuses";
  if ((name.match(/\./g) ?? []).length > 1) return "it has more than one dot";
  if (RESERVED_FUNCTION_NAMES.includes(name)) return "web_search reserves it";
  return null;
}

function manifestToolIds(manifest: unknown): Set<string> | null {
  const agent = (manifest as { agent?: { tools?: unknown } } | null | undefined)?.agent;
  if (!agent || !Array.isArray(agent.tools)) return null;
  return new Set(agent.tools.map((t: { id?: unknown }) => String(t?.id)));
}

/**
 * The tools a token may use: its brief's, narrowed by the live product's manifest. A manifest can't widen the list. A
 * refinement's build token skips it, because the stored manifest is the previous version's.
 */
export function allowedToolIds(token: { scope: string; allowedModels: readonly string[] }, manifest: unknown): ToolId[] {
  if (!hasAgentMarker(token.allowedModels)) return [];
  const ids = token.allowedModels.map(toolOfMarker).filter((id): id is ToolId => id !== null);
  const narrowed = token.scope === "build" ? null : manifestToolIds(manifest);
  const unique = [...new Set(ids)];
  return narrowed ? unique.filter((id) => narrowed.has(id)) : unique;
}

export interface ListedFunction {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
  strict: false;
  defer_loading?: true;
}

/** What Meta gets: never the version, the price or the canned sample. */
export function functionDefinition(fn: CatalogFunction, deferred: boolean): ListedFunction {
  return {
    type: "function",
    name: fn.name,
    description: fn.description,
    parameters: fn.parameters,
    strict: false,
    ...(deferred ? { defer_loading: true as const } : {}),
  };
}

/** One Meta namespace per toolkit, ready for the `tools` array, with its functions deferred. */
export function namespaceDefinition(toolkit: string, functions: ListedFunction[]) {
  return { type: "namespace" as const, name: toolkit, description: NAMESPACE_DESCRIPTIONS[toolkit] ?? toolkitLabel(toolkit), tools: functions };
}
