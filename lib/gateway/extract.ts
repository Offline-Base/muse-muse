import { GATEWAY_ENDPOINTS } from "@/lib/gateway/policy";
import type { GatewayEndpoint } from "@/lib/types";

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
  endpoint: GatewayEndpoint,
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
  endpoint: GatewayEndpoint,
  model: string,
  tokenModels: readonly string[],
  endpointModels: readonly string[],
): boolean {
  if (endpoint === "files") return true;
  return tokenModels.includes(model) && endpointModels.includes(model);
}
