# Messages (Anthropic-compatible) {#messages-anthropic-compatible}

The messages endpoints provide an Anthropic Messages-compatible surface over Meta Model API. Supply requests in the Anthropic wire format — `POST /v1/messages` generates an assistant message and `POST /v1/messages/count_tokens` counts input tokens without generating. Authentication, rate limits, and billing match the other Model API endpoints; supported tools are developer-defined (`custom`) functions and built-in `web_search`.

- [Create a message](https://dev.meta.ai/docs/api-reference/messages/create-message)
- [Count tokens](https://dev.meta.ai/docs/api-reference/messages/count-tokens)
- [Schemas](https://dev.meta.ai/docs/api-reference/messages/schemas)

For guidance on reasoning replay, tool calling, and structured output that also applies to the shared inference pipeline, see the [Responses](https://dev.meta.ai/docs/protocols/responses) feature page.
