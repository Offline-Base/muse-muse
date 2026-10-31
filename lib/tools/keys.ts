import { createHmac } from "node:crypto";
import { env } from "@/lib/env";

/**
 * The key for one use of signing in the tool gateway (Composio user ids, the owner pass, approvals, the connect state).
 * Each label gets its own, derived from TOOLS_SIGNING_SECRET when it is set and otherwise from GATEWAY_TOKEN_PEPPER, so
 * one key can never stand in for another.
 */
export function toolKey(label: string): Buffer {
  return createHmac("sha256", env.toolsSigningSecret ?? env.gatewayTokenPepper).update(`musemuse-tools:${label}`).digest();
}
