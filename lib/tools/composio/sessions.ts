import { createHash } from "node:crypto";
import type { ComposioApi, ComposioSessionConfig } from "@/lib/tools/composio/client";
import type { CatalogTool } from "@/lib/tools/composio/sync";
import { CATALOG } from "@/lib/tools/catalog";
import { canonicalJson } from "@/lib/tools/sign";

/**
 * A session's config, enabled only for the tools this product uses, as a second guard after the catalog: anything else
 * comes back 4310. Tag filters aren't used, because Composio ignores them for a tool `tools.enable` names (spike item 4),
 * and its finder, workbench and proxy tools stay off.
 */
export function sessionConfigFor(tools: readonly CatalogTool[]): ComposioSessionConfig {
  const byToolkit = new Map<string, Set<string>>();
  for (const tool of tools) {
    if (!tool.toolkit || !tool.functions.length) continue;
    const slugs = byToolkit.get(tool.toolkit) ?? new Set<string>();
    for (const fn of tool.functions) slugs.add(fn.name);
    byToolkit.set(tool.toolkit, slugs);
  }
  const toolkits = [...byToolkit.keys()].sort();
  const instant = toolkits.filter((t) => CATALOG.instantToolkits.includes(t));
  return {
    sessionPreset: "direct_tools",
    toolkits: { enable: toolkits },
    tools: Object.fromEntries(toolkits.map((t) => [t, { enable: [...(byToolkit.get(t) as Set<string>)].sort() }])),
    ...(instant.length ? { instant: { toolkits: { enable: instant }, returnInstantCharge: true as const } } : {}),
    manageConnections: { enable: false },
    sandbox: { enable: false, enableProxyExecution: false },
  };
}

export function sessionConfigHash(config: ComposioSessionConfig): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

export interface SessionStore {
  findToolSession(productId: string, composioUserId: string): Promise<{ sessionId: string; configHash: string } | null>;
  saveToolSession(row: { productId: string; composioUserId: string; sessionId: string; configHash: string }): Promise<void>;
}

/** The session for this product and user: cached in tool_sessions, updated when the tools changed (a refinement). */
export async function ensureToolSession(
  api: ComposioApi,
  store: SessionStore,
  o: { productId: string; composioUserId: string; config: ComposioSessionConfig },
): Promise<string> {
  const configHash = sessionConfigHash(o.config);
  const existing = await store.findToolSession(o.productId, o.composioUserId);
  if (existing?.configHash === configHash) return existing.sessionId;
  if (existing) {
    await api.updateSession(existing.sessionId, o.config);
    await store.saveToolSession({ productId: o.productId, composioUserId: o.composioUserId, sessionId: existing.sessionId, configHash });
    return existing.sessionId;
  }
  const { sessionId } = await api.createSession(o.composioUserId, o.config);
  await store.saveToolSession({ productId: o.productId, composioUserId: o.composioUserId, sessionId, configHash });
  return sessionId;
}
