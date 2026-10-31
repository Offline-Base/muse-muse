import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A build's token for the build MCP server (lib/mcp/build-mcp.ts): the build's id and an HMAC of it, so it needs no
 * storage and can't be made for another build. builder.ts exports it to the build's Muse Code runner only.
 */

const TOKEN_PREFIX = "mm_build_mcp";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function mac(buildId: string, secret: string): string {
  return createHmac("sha256", secret).update(`build-mcp:${buildId}`).digest("hex");
}

export function buildMcpToken(buildId: string, secret: string): string {
  return `${TOKEN_PREFIX}.${buildId}.${mac(buildId, secret)}`;
}

/** The build a token was made for, or null. The HMAC is compared in constant time. */
export function buildIdFromToken(token: string, secret: string): string | null {
  const [prefix, buildId = "", given = "", ...extra] = token.trim().split(".");
  if (prefix !== TOKEN_PREFIX || extra.length || !UUID.test(buildId) || !/^[0-9a-f]{64}$/.test(given)) return null;
  const want = Buffer.from(mac(buildId, secret), "hex");
  const got = Buffer.from(given, "hex");
  return got.length === want.length && timingSafeEqual(got, want) ? buildId : null;
}
