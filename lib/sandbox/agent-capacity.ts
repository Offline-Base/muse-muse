/**
 * Muse Code's agent capacity. Apart from muse-config.ts because lib/env.ts needs it and workflows import lib/env.ts: the
 * hook scripts in muse-config.ts are strings holding Node imports, which Workflow's bundle check can't tell from real ones.
 */
export const DEFAULT_AGENT_CAPACITY = 6;
/** agents.execution_capacity outside this range makes Muse Code's settings malformed. */
const CAPACITY_RANGE = { min: 1, max: 64 } as const;

/** MUSE_AGENT_CAPACITY as Muse Code takes it: a whole number held to 1 through 64, and the default when unset or not a number. */
export function agentCapacity(raw: string | undefined): number {
  const text = raw?.trim();
  const value = text ? Math.floor(Number(text)) : NaN;
  if (!Number.isFinite(value)) return DEFAULT_AGENT_CAPACITY;
  return Math.min(CAPACITY_RANGE.max, Math.max(CAPACITY_RANGE.min, value));
}
