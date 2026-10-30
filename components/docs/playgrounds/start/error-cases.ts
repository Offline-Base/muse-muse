import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";

/**
 * The error lab's cases: real requests that fail, each sent through the docs proxy, with what the error-handling
 * page says about that failure. Most reach Meta, which validates and refuses them before any model runs, so they
 * cost nothing. A few never leave Muse Muse (bad JSON, an unknown path, a file id from elsewhere): the docs proxy
 * answers those itself, in Meta's error shape, and the lab says so. Meta's replies carry an x-request-id header; the
 * proxy's own don't, which is how a run tells them apart. A reply with neither a request id nor the error envelope
 * came from something in between (the docs' host, the network), and the lab says that too.
 *
 * The page's 413 is the one case shown as a recorded example: Meta accepted a 1.1 MB background request when we tried
 * (Oct 30, 2026), and a body over the docs' 4.5 MB cap is refused before it reaches Meta (on Vercel, by the platform
 * itself, in plain text), so no live request returns Meta's 413.
 */

export type Retry = "no" | "yes" | "differently";

export interface ErrorCase {
  id: string;
  /** The pill. */
  label: string;
  method: "GET" | "POST";
  path: string;
  /** The JSON body, when the case sends one. */
  body?: Record<string, unknown>;
  /** A body sent as raw text instead (malformed JSON). */
  raw?: string;
  /** Set when the live docs can't trigger this error: the page's own replies, shown instead of a run. */
  recorded?: RecordedError;
  /** What comes back, as seen through the proxy on Oct 30, 2026. */
  expect: { status: number; type: string; code: string | null; param?: string | null };
  /** Who writes the error the reader sees. */
  answeredBy: "meta" | "proxy";
  /** What it shows: the page's cause, in a sentence. */
  teaches: string;
  /** The page's fix. */
  fix: string;
  retry: Retry;
  /** The section on the error-handling page. */
  anchor: string;
  /** For proxy-answered cases: what Meta itself returns. */
  metaWouldSay?: string;
}

export interface RecordedError {
  /** Why no live request gets this error. */
  why: string;
  /** The request that would get it, as the page describes it. Shown, never sent. */
  request: string;
  /** The page's example replies, each with its cause. */
  replies: Array<{ cause: string; body: Record<string, unknown> }>;
}

const M = DEFAULT_TEXT_MODEL;

const envelope = (message: string, type: string, code: string | null, param: string | null = null) => ({ error: { message, type, param, code } });

/** The error-handling page's two 413 bodies. */
const PAYLOAD_TOO_LARGE_BACKGROUND = envelope(
  "request body too large for background mode (1300000 bytes, max 1048576)",
  "invalid_request_error",
  "payload_too_large",
);
const PAYLOAD_TOO_LARGE_STORE = envelope(
  "This response could not be stored because the request is too large (~16 MB) to persist with `store=true`. Upload large media via the Files API and reference it by `file_id` instead of inlining base64 data, or retry with `store=false`.",
  "invalid_request_error",
  "payload_too_large",
);

export const ERROR_CASES: readonly ErrorCase[] = [
  {
    id: "missing-field",
    label: "Missing required field",
    method: "POST",
    path: "chat/completions",
    body: { model: M },
    expect: { status: 400, type: "invalid_request_error", code: null, param: "messages" },
    answeredBy: "meta",
    teaches: "A required parameter (here messages) is missing. Validation errors name the field in param and leave code null.",
    fix: "Read message and param to find the problem, then fix the request.",
    retry: "no",
    anchor: "400",
  },
  {
    id: "top-p",
    label: "top_p out of range",
    method: "POST",
    path: "responses",
    body: { model: M, input: "Hello", top_p: 1.5 },
    expect: { status: 400, type: "invalid_request_error", code: null, param: "top_p" },
    answeredBy: "meta",
    teaches: "top_p must satisfy 0 < top_p <= 1 (top_p: 0 fails too). The page's own example error.",
    fix: "Keep top_p in range. Check the API reference for valid parameter values.",
    retry: "no",
    anchor: "error-format",
  },
  {
    id: "temperature",
    label: "temperature over 2",
    method: "POST",
    path: "chat/completions",
    body: { model: M, messages: [{ role: "user", content: "Hello" }], temperature: 3 },
    expect: { status: 400, type: "invalid_request_error", code: null, param: "temperature" },
    answeredBy: "meta",
    teaches: "temperature outside the 0 to 2 range is rejected before the model runs.",
    fix: "Use a temperature from 0 to 2.",
    retry: "no",
    anchor: "400",
  },
  {
    id: "max-output",
    label: "max_output_tokens under 16",
    method: "POST",
    path: "responses",
    body: { model: M, input: "Hello", max_output_tokens: 10 },
    expect: { status: 400, type: "invalid_request_error", code: null, param: "max_output_tokens" },
    answeredBy: "meta",
    teaches: "The Responses API's max_output_tokens has a minimum of 16.",
    fix: "Ask for at least 16 output tokens. Reasoning counts toward them, so leave room.",
    retry: "no",
    anchor: "400",
  },
  {
    id: "empty-input",
    label: "Empty input",
    method: "POST",
    path: "responses",
    body: { model: M, input: "" },
    expect: { status: 400, type: "invalid_request_error", code: null, param: "input" },
    answeredBy: "meta",
    teaches: "An empty input is an invalid message structure.",
    fix: "Send at least one non-empty input item.",
    retry: "no",
    anchor: "400",
  },
  {
    id: "call-id",
    label: "Unmatched call_id",
    method: "POST",
    path: "responses",
    body: {
      model: M,
      input: [
        { type: "message", role: "user", content: "What's the weather in Paris?" },
        { type: "function_call_output", call_id: "call_xyz", output: '{"temperature_c": 18}' },
      ],
    },
    expect: { status: 400, type: "invalid_request_error", code: null, param: "call_id" },
    answeredBy: "meta",
    teaches: "A function_call_output whose call_id matches no function_call in the same request (with no previous_response_id).",
    fix: "Keep function_call and function_call_output pairs together and in order, or continue with previous_response_id.",
    retry: "no",
    anchor: "invalid-conversation-structure",
  },
  {
    id: "reasoning-id",
    label: "Invalid reasoning id",
    method: "POST",
    path: "responses",
    body: {
      model: M,
      input: [
        { type: "reasoning", id: "my-reasoning-1", summary: [] },
        { type: "message", role: "user", content: "Hello" },
      ],
    },
    expect: { status: 400, type: "invalid_request_error", code: null, param: "input" },
    answeredBy: "meta",
    teaches: "A replayed reasoning item whose id isn't one the API returned (they start with rs_).",
    fix: 'Pass reasoning ids back unchanged, or omit id and send encrypted_content (include: ["reasoning.encrypted_content"] with store: false).',
    retry: "no",
    anchor: "invalid-reasoning-id",
  },
  {
    id: "unknown-model",
    label: "Unknown model",
    method: "GET",
    path: "models/bogus-model",
    expect: { status: 404, type: "invalid_request_error", code: "model_not_found", param: null },
    answeredBy: "meta",
    teaches: "A model id that doesn't exist or that your team can't use. Not-found errors carry a populated code.",
    fix: "Check the id (lowercase, hyphenated) and list what your team has with GET /v1/models. A 503 here instead means the lookup was inconclusive: retry that one.",
    retry: "no",
    anchor: "404",
  },
  {
    id: "bad-json",
    label: "Malformed JSON",
    method: "POST",
    path: "responses",
    raw: `{"model": "${M}", "input": "Hello",}`,
    expect: { status: 400, type: "invalid_request_error", code: "invalid_body", param: null },
    answeredBy: "proxy",
    teaches: "Invalid JSON in the request body (a trailing comma here).",
    fix: "Serialize the body with a JSON library instead of building it by hand.",
    retry: "no",
    anchor: "400",
    metaWouldSay: "HTTP 400 with type invalid_request_error.",
  },
  {
    id: "unknown-file",
    label: "File not found",
    method: "GET",
    path: "files/file-nonexistent",
    expect: { status: 404, type: "not_found_error", code: "not_found", param: null },
    answeredBy: "proxy",
    teaches: "A file id that doesn't exist (or was deleted). The live docs only reach files uploaded from this browser.",
    fix: "List files with GET /v1/files to confirm the id still exists. File ids start with file-.",
    retry: "no",
    anchor: "404",
    metaWouldSay: "HTTP 404 with code file_not_found: \"No file found with id 'file-nonexistent'.\"",
  },
  {
    id: "unknown-path",
    label: "Typo in the path",
    method: "POST",
    path: "chat/completion",
    body: { model: M, messages: [{ role: "user", content: "Hello" }] },
    expect: { status: 404, type: "not_found_error", code: "unknown_endpoint", param: null },
    answeredBy: "proxy",
    teaches: "An endpoint that doesn't exist (chat/completion instead of chat/completions).",
    fix: "Detect routing mistakes from the status code: Meta's 404 for an unknown path has an empty body, no JSON error.",
    retry: "no",
    anchor: "error-format",
    metaWouldSay: "HTTP 404 with an empty body: no JSON error envelope at all.",
  },
  {
    id: "too-large",
    label: "Body too large",
    method: "POST",
    path: "responses",
    expect: { status: 413, type: "invalid_request_error", code: "payload_too_large", param: null },
    answeredBy: "meta",
    teaches:
      "A request body over a size limit: a background request whose JSON body is over 1 MiB, or a store: true request with inline media too large to persist.",
    fix: "Stay under the limit: for background mode keep the body under 1 MiB, upload large media through the Files API and send its file_id, or set store: false. Don't retry unchanged.",
    retry: "no",
    anchor: "413",
    recorded: {
      why: "Not sent: the live docs can't trigger this error. When we sent a 1.1 MB background request (Oct 30, 2026), Meta accepted it instead of answering 413, and a body over 4.5 MB is refused before it reaches Meta, by the docs' host or the docs proxy, so its reply wouldn't be Meta's.",
      request: `{"model": "${M}", "background": true, "store": true, "input": "<1.3 MB of text>"}`,
      replies: [
        { cause: "a background request over 1 MiB", body: PAYLOAD_TOO_LARGE_BACKGROUND },
        { cause: "a store: true request too large to persist", body: PAYLOAD_TOO_LARGE_STORE },
      ],
    },
  },
];

export function errorCase(id: string): ErrorCase | null {
  return ERROR_CASES.find((c) => c.id === id) ?? null;
}

/** The body as the lab shows it: the raw text of the malformed case, the request a recorded case describes, or the JSON. */
export function displayCaseBody(c: ErrorCase): string | null {
  if (c.raw !== undefined) return c.raw;
  if (c.recorded) return c.recorded.request;
  return c.body ? JSON.stringify(c.body, null, 2) : null;
}

export interface ErrorParts {
  status: number;
  type: string | null;
  code: string | null;
  param: string | null;
  message: string | null;
  /** True when the body is Meta's { error: {...} } envelope (or the proxy's copy of it). */
  envelope: boolean;
}

/** The fields of an error reply, as the page's table names them. Tolerates a non-JSON body. */
export function errorParts(status: number, json: unknown, text: string): ErrorParts {
  const err = json && typeof json === "object" ? (json as { error?: unknown }).error : undefined;
  const e = err && typeof err === "object" ? (err as Record<string, unknown>) : null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    status,
    type: str(e?.type),
    code: str(e?.code),
    param: str(e?.param),
    message: str(e?.message) ?? (text ? text.slice(0, 300) : null),
    envelope: !!e,
  };
}

/** Meta's replies carry a request id; the docs proxy's own errors don't. */
export function answeredByMeta(headers: Record<string, string>): boolean {
  return Boolean(headers["x-request-id"] || headers["request-id"]);
}

export type Answerer = "meta" | "proxy" | "other";

/**
 * Who wrote an error reply: Meta (it carries a request id), the docs proxy (Meta's envelope without a request id), or
 * neither, such as a hosting platform's or a network's own page, which has no JSON error envelope at all.
 */
export function whoAnswered(headers: Record<string, string>, parts: Pick<ErrorParts, "envelope">): Answerer {
  if (answeredByMeta(headers)) return "meta";
  return parts.envelope ? "proxy" : "other";
}

/** True when a failed reply isn't the error a case aims for: another status, another code, or no error envelope. */
export function missesTarget(c: ErrorCase, parts: ErrorParts): boolean {
  if (parts.status !== c.expect.status || !parts.envelope) return true;
  return c.expect.code !== null && parts.code !== c.expect.code;
}

export interface StatusAdvice {
  status: number;
  name: string;
  /** The page's common causes, shortened. */
  causes: string[];
  /** One of the page's example bodies. */
  example: Record<string, unknown> | null;
  fix: string;
  retry: Retry;
  anchor: string;
  /** The lab case for it: one that triggers it live, or the recorded example when none can. */
  liveCase?: string;
}

/** Every status the error-handling page covers, with its causes, an example body, the fix and whether to retry. */
export const STATUS_ADVICE: readonly StatusAdvice[] = [
  {
    status: 400,
    name: "Bad Request",
    causes: [
      "A missing or invalid parameter (temperature outside 0 to 2, top_p outside 0 < top_p <= 1, max_output_tokens under 16)",
      "Input plus max_output_tokens over the context window",
      "Invalid JSON, invalid conversation structure, empty input, a duplicate reasoning_id",
      "Media that can't be fetched or decoded, or that breaks the content policy (content_policy_violation)",
    ],
    example: envelope("`top_p`: The number must be `<= 1.0`.", "invalid_request_error", null, "top_p"),
    fix: "Read message and param. code is usually null for validation errors.",
    retry: "no",
    anchor: "400",
    liveCase: "top-p",
  },
  {
    status: 401,
    name: "Unauthorized",
    causes: ["A missing Authorization header", "A malformed key (not LLM_{id}_{secret})", "A revoked or deleted key, or a typo"],
    example: envelope("Unauthorized", "authentication_error", "invalid_api_key"),
    fix: "Send a valid Authorization: Bearer $MODEL_API_KEY header, and check the key in the dashboard.",
    retry: "no",
    anchor: "401",
  },
  {
    status: 402,
    name: "Payment Required",
    causes: ["Insufficient balance or a lapsed payment method", "A billing account issue"],
    example: envelope("Billing account issue. Please check your account status.", "billing_error", "billing_not_configured"),
    fix: "Check account status and billing details in the Model API dashboard.",
    retry: "no",
    anchor: "402",
  },
  {
    status: 403,
    name: "Forbidden",
    causes: ["The key lacks permission for the model or feature", "Team restrictions on specific endpoints"],
    example: null,
    fix: "Verify the key's access to the model and features in the dashboard.",
    retry: "no",
    anchor: "403",
  },
  {
    status: 404,
    name: "Not Found",
    causes: ["A typo in the endpoint path (empty body)", "A file id that doesn't exist", "A model that doesn't exist"],
    example: envelope("The model `bogus-model` does not exist or is not available", "invalid_request_error", "model_not_found"),
    fix: "Verify the id. Branch on status and type, which are stable, rather than parsing message.",
    retry: "no",
    anchor: "404",
    liveCase: "unknown-model",
  },
  {
    status: 413,
    name: "Payload Too Large",
    causes: ["A background request body over 1 MiB", "A store: true request with large inline base64 media that can't be persisted"],
    example: PAYLOAD_TOO_LARGE_BACKGROUND,
    fix: "Stay under the limit: upload media with the Files API and send its file_id, or set store: false.",
    retry: "no",
    anchor: "413",
    liveCase: "too-large",
  },
  {
    status: 429,
    name: "Too Many Requests",
    causes: ["Over your team's requests per minute (RPM)", "Over your team's tokens per minute (TPM)"],
    example: envelope("Rate limit exceeded. Please retry after 15 seconds.", "rate_limit_error", "rate_limit_exceeded"),
    fix: "Exponential backoff with jitter, waiting at least the Retry-After header.",
    retry: "yes",
    anchor: "429",
  },
  {
    status: 500,
    name: "Internal Server Error",
    causes: ["A temporary service disruption", "Model output parsing failure (not caused by your input)"],
    example: null,
    fix: "Retry with exponential backoff. If 500s persist, check the status page or contact support.",
    retry: "yes",
    anchor: "500",
  },
  {
    status: 503,
    name: "Service Unavailable",
    causes: [
      "A rolling deploy: server_shutting_down (Retry-After of a few seconds)",
      "Backend overload: service_overloaded (Retry-After: 60)",
      "Backend unavailable: backend_unavailable (Retry-After: 60)",
      "A transient image-generation failure: server_error with no stable code",
    ],
    example: envelope("The backend is temporarily overloaded. Please retry.", "server_error", "service_overloaded"),
    fix: "Always retryable: honor Retry-After, else back off. A shutdown mid-stream arrives as an error event: retry the full request.",
    retry: "yes",
    anchor: "503",
  },
  {
    status: 504,
    name: "Gateway Timeout",
    causes: ["A non-streaming request ran past the server time limit", "A stream whose first event didn't arrive in time"],
    example: envelope(
      'Request exceeded the non-streaming server time limit before a response was produced. For large or slow requests, use the streaming API by setting "stream": true.',
      "server_error",
      "gateway_timeout",
    ),
    fix: "Don't simply retry: run it with background: true, stream it, or make it smaller.",
    retry: "differently",
    anchor: "504",
  },
];
