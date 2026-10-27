/**
 * Errors in OpenAI's shape, so the OpenAI SDK in products surfaces them as APIError with a readable message.
 * `x-should-retry: false` stops the SDK from retrying errors that won't go away (budget, kill switch, bad model).
 */
export type GatewayErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "insufficient_quota"
  | "server_error";

export function gatewayError(
  status: number,
  type: GatewayErrorType,
  code: string,
  message: string,
  opts: { retry?: boolean; headers?: Record<string, string> } = {},
): Response {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.retry === false) headers["x-should-retry"] = "false";
  return Response.json({ error: { type, code, message, param: null } }, { status, headers });
}
