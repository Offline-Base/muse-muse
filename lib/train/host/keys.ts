/** The key vLLM checks on Modal for one endpoint. Derived from the session secret, so it is never stored. Server only. */
import { createHmac } from "node:crypto";
import { env } from "@/lib/env";

export function hostKeyFor(endpointId: string): string {
  return createHmac("sha256", env.sessionSecret).update(`host-endpoint:${endpointId}`).digest("hex");
}
