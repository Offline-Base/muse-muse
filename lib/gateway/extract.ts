import { isIP } from "node:net";
import { GATEWAY_ENDPOINTS } from "@/lib/gateway/policy";
import type { GatewayEndpoint } from "@/lib/types";
import type { SparkOpenEndpoint } from "@/lib/gateway/spark-open";

/** The mirrored endpoint for a /v1/<path> request, or null when the gateway doesn't serve it. */
export function parseEndpoint(path: readonly string[]): GatewayEndpoint | null {
  const joined = path.join("/");
  return GATEWAY_ENDPOINTS.find((e) => e === joined) ?? null;
}

/** The token from "Authorization: Bearer <token>", or null. */
export function parseBearer(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}

/** The first four groups of an IPv6 address, written as its /64. One person usually holds a whole /64. */
function ipv6Prefix64(ip: string): string {
  const parts = ip.toLowerCase().split("::");
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(":") : [];
  const tailGroups = tail.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const groups = parts.length > 1 ? [...head, ...Array(Math.max(0, 8 - head.length - tailGroups)).fill("0"), ...tail] : head;
  return `${groups
    .slice(0, 4)
    .map((g) => (parseInt(g, 16) || 0).toString(16))
    .join(":")}::/64`;
}

/**
 * The rate-limit key for the end user's IP that a product forwards in x-musemuse-client-ip, or null when the header is
 * missing or malformed. It is only ever a rate-limit key, never auth, since a product can send anything there. Takes
 * the first entry of a forwarded list; IPv6 addresses count by their /64.
 */
export function clientIpKey(header: string | null): string | null {
  const first = header?.split(",")[0]?.trim().slice(0, 64).split("%")[0];
  if (!first) return null;
  const version = isIP(first);
  if (version === 4) return first;
  if (version !== 6) return null;
  const mapped = first.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped && isIP(mapped[1]) === 4 ? mapped[1] : ipv6Prefix64(first);
}

export function isJsonContentType(contentType: string | null): boolean {
  const media = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return media === "application/json" || media.endsWith("+json");
}

export function isMultipartContentType(contentType: string | null): boolean {
  return (contentType ?? "").split(";")[0].trim().toLowerCase() === "multipart/form-data";
}

export type ParsedRequest =
  | { kind: "json"; json: Record<string, unknown>; model: string | null }
  | { kind: "multipart"; form: FormData; model: string | null }
  | { kind: "raw"; model: null };

export class BadRequestError extends Error {}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Reads a multipart field that may arrive as a plain string or as a file part (asr/transcribe's `request` JSON). */
async function fieldText(value: FormDataEntryValue | null): Promise<string | null> {
  if (value === null) return null;
  return typeof value === "string" ? value : await value.text();
}

/**
 * Parses the request body far enough to find the model:
 *   JSON bodies: the "model" field (asr/transcribe's JSON extension included).
 *   images/edits multipart: the "model" field.
 *   asr/transcribe multipart: "model" inside the "request" JSON part (falling back to a plain "model" field).
 *   files: no model.
 * Throws BadRequestError for a body that doesn't parse.
 */
export async function parseGatewayRequest(
  endpoint: GatewayEndpoint | SparkOpenEndpoint,
  contentType: string | null,
  body: Uint8Array<ArrayBuffer>,
): Promise<ParsedRequest> {
  if (endpoint === "files") return { kind: "raw", model: null };

  if (isJsonContentType(contentType)) {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new BadRequestError("The request body is not valid JSON.");
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new BadRequestError("The request body must be a JSON object.");
    }
    const obj = json as Record<string, unknown>;
    return { kind: "json", json: obj, model: stringOrNull(obj.model) };
  }

  if (isMultipartContentType(contentType)) {
    let form: FormData;
    try {
      form = await new Response(body, { headers: { "content-type": contentType ?? "" } }).formData();
    } catch {
      throw new BadRequestError("The multipart body could not be parsed.");
    }
    let model = stringOrNull(form.get("model"));
    if (endpoint === "asr/transcribe") {
      const request = await fieldText(form.get("request"));
      if (request !== null) {
        try {
          const parsed = JSON.parse(request) as unknown;
          if (parsed && typeof parsed === "object") model = stringOrNull((parsed as { model?: unknown }).model) ?? model;
        } catch {
          throw new BadRequestError('The "request" part must be a JSON string.');
        }
      }
    }
    return { kind: "multipart", form, model };
  }

  return { kind: "raw", model: null };
}

/** True when the token and the endpoint both allow the model. */
export function modelAllowed(
  endpoint: GatewayEndpoint | SparkOpenEndpoint,
  model: string,
  tokenModels: readonly string[],
  endpointModels: readonly string[],
): boolean {
  if (endpoint === "files") return true;
  return tokenModels.includes(model) && endpointModels.includes(model);
}
