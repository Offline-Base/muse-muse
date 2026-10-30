# Choosing an API {#choosing-an-api}

Model API speaks three request formats — the [Responses API](https://dev.meta.ai/docs/protocols/responses), [Chat Completions](https://dev.meta.ai/docs/protocols/chat-completions), and the [Messages API](https://dev.meta.ai/docs/protocols/messages). All three run the same models, use the same bearer-token auth, and cost the same per token. Pick the format your code already speaks; the model and features underneath are identical.

## At a glance {#at-a-glance}

| Format               | Endpoint                    | Best for                                               | Reasoning across turns                           |
| -------------------- | --------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| **Responses**        | `POST /v1/responses`        | Agents and multi-step tool loops; the full feature set | Yes — encrypted replay or `previous_response_id` |
| **Chat Completions** | `POST /v1/chat/completions` | Dropping into existing OpenAI messages-array code      | No (reasoning is not carried between turns)      |
| **Messages**         | `POST /v1/messages`         | Anthropic-format tools such as Claude Code             | Yes — via Anthropic `thinking` replay            |

## Responses API {#responses}

The recommended default for new work. It is OpenAI-compatible and exposes the full feature set: cross-turn reasoning replay (stateless encrypted items or server-managed `previous_response_id`), [search grounding](https://dev.meta.ai/docs/search-grounding), [tool search](https://dev.meta.ai/docs/tool-search), background execution, and [file inputs](https://dev.meta.ai/docs/file-handling). Reach for it for agentic and coding workloads where reasoning continuity across tool turns matters. Use the OpenAI SDK pointed at `https://api.meta.ai/v1`. See the [Responses API guide](https://dev.meta.ai/docs/protocols/responses).

## Chat Completions {#chat-completions}

The classic OpenAI messages-array endpoint. It is the simplest drop-in if your code already calls `/v1/chat/completions`: point the client at the base URL, swap the key, and keep the rest. It does not carry reasoning across turns for external keys, and [search grounding](https://dev.meta.ai/docs/search-grounding) and [tool search](https://dev.meta.ai/docs/tool-search) run only on the Responses and Messages APIs. [Tool calling](https://dev.meta.ai/docs/tool-calling) with `function` tools is fully supported. See the [Chat Completions guide](https://dev.meta.ai/docs/protocols/chat-completions).

## Messages API {#messages}

An Anthropic Messages-compatible wire format over the same inference pipeline as Responses. Use it for Claude-oriented tools and the Anthropic SDK — point the SDK at the base host `https://api.meta.ai` (it appends `/v1/messages`) with your `MODEL_API_KEY`. It is stateless, so replay history client-side. See the [Messages API guide](https://dev.meta.ai/docs/protocols/messages).

## How to choose {#how-to-choose}

- **Building an agent or coding workflow**: use the **Responses API** for reasoning continuity, search grounding, and background execution.
- **Already have OpenAI `chat.completions` code**: start with **Chat Completions** for the fastest drop-in, and move to Responses when you need reasoning replay or search grounding.
- **Using Claude Code or the Anthropic SDK**: use the **Messages API** and keep your existing Anthropic-format requests.

## Next steps {#next-steps}

- Make your first call in the [Quickstart](https://dev.meta.ai/docs/quickstart).
- Wire the model into your editor with the [coding agents guide](https://dev.meta.ai/docs/coding-agents).
- Verify request and response schemas in the [API reference](https://dev.meta.ai/docs/api-reference).
