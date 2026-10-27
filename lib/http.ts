import { AuthError } from "@/lib/auth";

/** Standard reply for routes that are planned but not built yet. */
export function notImplemented(todo: string): Response {
  return Response.json({ error: "not_implemented", todo }, { status: 501 });
}

/** An error a route turns into a JSON reply with its status. `code` is the stable `error` value clients match on. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

/** `{ error, ...extra }` with a status. */
export function errorJson(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error, ...extra }, { status });
}

/** Maps AuthError to 401/403, HttpError to its status, and anything else to a logged 500. */
export function errorResponse(err: unknown): Response {
  if (err instanceof AuthError) return errorJson(err.status, err.message);
  if (err instanceof HttpError) return errorJson(err.status, err.code);
  console.error("[route]", err);
  return errorJson(500, "server_error");
}

/** Wraps a route handler so thrown AuthError and HttpError become JSON replies. */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Parses a JSON object body, refusing anything over `maxBytes`. */
export async function readJson(req: Request, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new HttpError(413, "body_too_large");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "body_too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw badRequest("Send a JSON body.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("Send a JSON object.");
  return body as Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
