/**
 * Which parts of the code cap are switched on (docs/CAPABILITIES.md, 15a), read as lib/env.ts reads a flag so the brief
 * block, the writer's rules, the catalog and the build prompt can follow them without importing env (which imports the
 * brief schema). Pyodide and QuickJS need only CODE_ENABLED; each server part needs its own route switched on too.
 *
 *   exec      CODE_EXEC: {GATEWAY_URL}/exec answers.
 *   browse    CODE_BROWSE, and BUILDER_SNAPSHOT_ID set: a live page opens from the builder snapshot, which has Chromium.
 *   visitors  CODE_EXEC_VISITORS with CODE_EXEC: visitors and signed-in end users may run /exec too.
 */
export interface CodeParts {
  exec: boolean;
  browse: boolean;
  visitors: boolean;
}

function flag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
}

export function codePartsOn(): CodeParts {
  const exec = flag("CODE_EXEC");
  return { exec, browse: flag("CODE_BROWSE") && Boolean(process.env.BUILDER_SNAPSHOT_ID), visitors: exec && flag("CODE_EXEC_VISITORS") };
}

/** A short key for caches of text that follows the parts. */
export function codePartsKey(parts: CodeParts = codePartsOn()): string {
  return `${parts.exec ? "e" : ""}${parts.browse ? "b" : ""}${parts.visitors ? "v" : ""}`;
}
