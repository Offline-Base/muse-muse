/**
 * The connect cap's switches (docs/CAPABILITIES.md, section 5), read straight from process.env with no imports, so
 * lib/env.ts and the cap's prompt text can both read them without an import cycle. lib/env.ts's getters call these.
 */
const on = (name: string) => ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());

/** CONNECT_VAULT. */
export const connectVaultOn = (): boolean => on("CONNECT_VAULT");

/** CONNECT_SENDS with the vault; on production only with CONNECT_SENDS_PRODUCTION too (decision 8). */
export function connectSendsOn(): boolean {
  if (!on("CONNECT_SENDS") || !on("CONNECT_VAULT")) return false;
  return process.env.VERCEL_ENV !== "production" || on("CONNECT_SENDS_PRODUCTION");
}

/** CONNECT_MORE_TOOLS. */
export const connectMoreToolsOn = (): boolean => on("CONNECT_MORE_TOOLS");

/** What the brief writer may pick right now. */
export const connectOptions = () => ({ vault: connectVaultOn(), sends: connectSendsOn() });
