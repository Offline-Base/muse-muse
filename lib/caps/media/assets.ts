import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { CapId } from "@/lib/caps/ids";
import list from "@/lib/caps/assets.json";
import { clientIpKey } from "@/lib/gateway/extract";
import { gatewayError } from "@/lib/gateway/errors";

/**
 * GET {GATEWAY_URL}/assets/<sha256> (docs/CAPABILITIES.md, section 14): a vetted large file (wasm, model weights) a
 * product's page loads, from the Blob mirror. Public and immutable, since a sha256 names exactly one file: no token, any
 * origin may read it, 120 a minute per address for each file. Only files in lib/caps/assets.json are served, and only while a cap that
 * lists them is on; with none on the route answers 404 unknown_endpoint and touches nothing.
 *
 * On Vercel it redirects to the file's Blob URL (filled in by scripts/caps/mirror-assets.ts), so the bytes never pass
 * through a function. On a local run (no Blob store) it streams the copy the mirror script put in .data/files.
 */

export interface VettedAsset {
  name: string;
  cap: CapId;
  bytes: number;
  sha256: string;
  contentType: string;
  license: string;
  source: string;
  /** The Blob URL of the mirrored copy, or null until it is mirrored. */
  mirror: string | null;
}

export const ASSETS_PER_MINUTE = 120;

const SHA = /^[0-9a-f]{64}$/;
const LICENSES = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "CC0-1.0", "ISC", "MPL-2.0"]);

/** The list, checked: every entry has a sha256, a size, a known permissive license and an https source, each once. */
export function vettedAssets(raw: unknown = list): VettedAsset[] {
  const assets = (raw as { assets?: unknown[] })?.assets;
  if ((raw as { version?: unknown })?.version !== 1 || !Array.isArray(assets)) throw new Error("lib/caps/assets.json isn't a version 1 list.");
  const seen = new Set<string>();
  return assets.map((a, i) => {
    const x = a as VettedAsset;
    const where = `lib/caps/assets.json entry ${i} (${String(x?.name)})`;
    if (typeof x?.name !== "string" || !x.name || x.name.includes("..")) throw new Error(`${where} has no plain name.`);
    if (typeof x.sha256 !== "string" || !SHA.test(x.sha256)) throw new Error(`${where} has no sha256.`);
    if (seen.has(x.sha256)) throw new Error(`${where} lists a sha256 twice.`);
    seen.add(x.sha256);
    if (!Number.isInteger(x.bytes) || x.bytes <= 0) throw new Error(`${where} has no size.`);
    if (!LICENSES.has(x.license)) throw new Error(`${where} has a license that isn't on the permissive list.`);
    if (typeof x.source !== "string" || !x.source.startsWith("https://")) throw new Error(`${where} has no https source.`);
    if (x.mirror !== null && (typeof x.mirror !== "string" || !x.mirror.startsWith("https://"))) throw new Error(`${where} has a mirror that isn't an https URL.`);
    if (typeof x.contentType !== "string" || !/^[a-z]+\/[a-z0-9.+-]+$/.test(x.contentType)) throw new Error(`${where} has no content type.`);
    return x;
  });
}

/** The Blob path of a mirrored asset. */
export const assetBlobPath = (sha256: string) => `assets/${sha256}`;

export interface AssetsDeps {
  enabledCaps(): readonly CapId[];
  /** The gateway's rate limit counters (lib/gateway/store.ts). */
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  /** The list, vettedAssets() by default. */
  assets?: readonly VettedAsset[];
  /** The local copy's path on a local run, or null on Vercel (where the mirror URL is used). */
  localPath?(sha256: string): string | null;
  now?(): Date;
}

const CORS = {
  "access-control-allow-origin": "*",
  "cross-origin-resource-policy": "cross-origin",
  "timing-allow-origin": "*",
} as const;

function clientKey(req: Request): string {
  return clientIpKey(req.headers.get("x-real-ip")) ?? clientIpKey(req.headers.get("x-forwarded-for")) ?? "unknown";
}

function refuse(status: number, type: Parameters<typeof gatewayError>[1], code: string, message: string, headers: Record<string, string> = {}) {
  return gatewayError(status, type, code, message, { retry: false, headers: { ...CORS, ...headers } });
}

export async function handleAsset(req: Request, sha256: string, deps: AssetsDeps): Promise<Response> {
  const enabled = deps.enabledCaps();
  const assets = deps.assets ?? vettedAssets();
  // Off unless a cap that lists files is on: nothing else is read.
  if (!assets.some((a) => enabled.includes(a.cap))) {
    return gatewayError(404, "not_found_error", "unknown_endpoint", "The gateway does not serve /assets.", { retry: false });
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET, HEAD", "access-control-max-age": "86400" } });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return refuse(405, "invalid_request_error", "method_not_allowed", "Use GET for /assets.", { allow: "GET, HEAD" });
  }
  const asset = SHA.test(sha256) ? assets.find((a) => a.sha256 === sha256 && enabled.includes(a.cap)) : undefined;
  if (!asset) return refuse(404, "not_found_error", "asset_not_found", "No such file on the gateway's list.");
  const now = deps.now?.() ?? new Date();
  // Counted per file: one page load fetches several files (the speech model is five), so a classroom behind one school
  // address uses one count of each file per student, not five of one shared count.
  const key = `assets:ip:${clientKey(req)}:${asset.sha256.slice(0, 16)}`;
  const counts = await deps.hitRateLimits([key], new Date(Math.floor(now.getTime() / 60_000) * 60_000));
  if ((counts[key] ?? 0) > ASSETS_PER_MINUTE) {
    return gatewayError(429, "rate_limit_error", "rate_limited", `Too many file requests: the limit is ${ASSETS_PER_MINUTE} a minute.`, { headers: { ...CORS, "retry-after": "60" } });
  }
  const headers = { ...CORS, "x-content-sha256": asset.sha256 };
  const local = deps.localPath?.(asset.sha256) ?? null;
  if (local && existsSync(local) && statSync(local).size === asset.bytes) {
    const common = { ...headers, "content-type": asset.contentType, "content-length": String(asset.bytes), "cache-control": "public, max-age=31536000, immutable" };
    if (req.method === "HEAD") return new Response(null, { status: 200, headers: common });
    return new Response(Readable.toWeb(createReadStream(local)) as ReadableStream, { status: 200, headers: common });
  }
  if (!asset.mirror) return refuse(503, "server_error", "asset_unavailable", "This file isn't on the gateway's mirror yet.");
  // The redirect is cached for an hour, not a year: the mirror's address could move and the cap can be switched off,
  // while the bytes never change (the page keeps them in its own cache after the first load anyway).
  return new Response(null, { status: 302, headers: { ...headers, location: asset.mirror, "cache-control": "public, max-age=3600" } });
}
