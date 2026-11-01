import { parseKeyring } from "@/lib/secrets/box";

/**
 * The connect cap's switches (docs/CAPABILITIES.md, section 5), read straight from process.env, so lib/env.ts and the
 * cap's prompt text can both read them without an import cycle (lib/secrets/box.ts imports only node:crypto).
 * lib/env.ts's getters call these.
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

/** CONNECT_VAULT_KEY parses as a key ring. Never says anything about the key itself, and never logs. */
function vaultKeyParses(): boolean {
  try {
    return parseKeyring(process.env.CONNECT_VAULT_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * What the brief writer may pick right now, and what a build may use: keys need the vault on with a key ring that
 * parses (without one every save answers caps_paused), and sends need that too, since a live send uses the owner's key.
 */
export function connectOptions(): { vault: boolean; sends: boolean } {
  const vault = connectVaultOn() && vaultKeyParses();
  return { vault, sends: vault && connectSendsOn() };
}
