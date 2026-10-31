/**
 * Words and a time limit the Prove it stage shares between the server and the browser, with no server-only imports.
 */
import type { ProductOutput } from "@/lib/native/targets";
import { PROVE_UNSETTLED, condenseProveEvents, type ProveView } from "@/lib/types";

export const OUTPUT_LABEL: Record<ProductOutput, string> = {
  mcp: "MCP server",
  cli: "CLI",
  skill: "Skill file",
  claude_plugin: "Claude plugin",
  chatgpt: "ChatGPT",
};

/** A stage still "running" with no news for this long is gone: its workflow died or its events stopped. */
export const PROVE_STALE_MS = 45 * 60_000;

/** True while a Prove it run can still change. A run with no news for PROVE_STALE_MS is over, whatever it last said. */
export function proveStillActive(view: ProveView | null, now: number): boolean {
  if (!view?.active) return false;
  if (!view.lastAt) return true;
  return now - new Date(view.lastAt).getTime() < PROVE_STALE_MS;
}

/** A run as it stands now: once it can't change, a part it never finished says so instead of "testing it now". */
export function settleProveView(view: ProveView | null, now: number): ProveView | null {
  if (!view) return null;
  if (proveStillActive(view, now)) return view;
  return {
    ...view,
    active: false,
    items: view.items.map((i) =>
      PROVE_UNSETTLED.includes(i.state)
        ? { ...i, state: "failed", title: i.item === "stage" ? "Prove it didn't finish" : `${OUTPUT_LABEL[i.item]}: the check never finished` }
        : i,
    ),
  };
}

/** True while a build's log has a Prove it run still going. */
export function proveRunning(events: ReadonlyArray<{ type: string; at?: string }>, now: number): boolean {
  return proveStillActive(condenseProveEvents(events), now);
}
