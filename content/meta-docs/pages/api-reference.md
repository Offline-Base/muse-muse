# API reference {#api-reference}

Meta Model API is an HTTP API served at `https://api.meta.ai/v1` and authenticated with a bearer token. This reference documents each resource's request and response schema. For a task-oriented introduction, start with the [Quickstart](https://dev.meta.ai/docs/quickstart); to choose a request format, see [Choosing an API](https://dev.meta.ai/docs/protocols).

## Base URL and authentication {#base-url-and-authentication}

|                 |                                        |
| --------------- | -------------------------------------- |
| **Base URL**    | `https://api.meta.ai/v1`               |
| **Auth header** | `Authorization: Bearer $MODEL_API_KEY` |
| **Env var**     | `MODEL_API_KEY`                        |

Create and manage keys in the [Model API dashboard](https://dev.meta.ai/); see the [Authentication guide](https://dev.meta.ai/docs/authentication) for storage and rotation.

## Resources {#resources}

- **[Responses](https://dev.meta.ai/docs/api-reference/responses)**: `POST /v1/responses` and related endpoints — server-managed, agentic generation with reasoning replay. OpenAI-compatible.
- **[Chat completions](https://dev.meta.ai/docs/api-reference/chat-completions)**: `POST /v1/chat/completions` — the OpenAI-compatible messages-array endpoint.
- **[Messages](https://dev.meta.ai/docs/api-reference/messages)**: `POST /v1/messages` — the Anthropic Messages-compatible endpoint.
- **[Files](https://dev.meta.ai/docs/api-reference/files)**: `POST /v1/files` (upload), `GET /v1/files` (list), `GET`/`DELETE /v1/files/{file_id}` (retrieve/delete a single file) — upload and manage files referenced in requests.
- **[Models](https://dev.meta.ai/docs/api-reference/models)**: `GET /v1/models` — list available models and retrieve model details.
- **[Status](https://dev.meta.ai/docs/api-reference/status)**: `GET /v1/status` — unauthenticated service-health endpoint.

## Errors and rate limits {#errors-and-rate-limits}

Errors use an OpenAI-style envelope — `{ "error": { "message", "type", "param", "code" } }`. Branch on `type` and `message`. See [Error handling](https://dev.meta.ai/docs/error-handling) for the full list of types, status codes, and retry guidance.

Rate limits apply per team. See [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits) for the current limits and headers.
