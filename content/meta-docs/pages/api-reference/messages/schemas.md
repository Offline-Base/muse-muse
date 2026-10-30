# Messages schemas {#messages-schemas}

The full schema and model definitions referenced by the [Messages](https://dev.meta.ai/docs/api-reference/messages/create-message) endpoints. Each endpoint page links here for the detailed shape of its request and response objects.

## Schemas {#schemas}

### Anthropic Base64 Source Param {#anthropic-base64-source-param}

Inline base64-encoded media.

| Field        | Type              | Required | Description                                                      |
| ------------ | ----------------- | -------- | ---------------------------------------------------------------- |
| `type`       | `enum ('base64')` | No       |                                                                  |
| `media_type` | `string`          | Yes      | MIME type of the data, such as `image/png` or `application/pdf`. |
| `data`       | `string`          | Yes      | Base64-encoded bytes.                                            |

### Anthropic Cache Control Ephemeral Param {#anthropic-cache-control-ephemeral-param}

Prompt-cache breakpoint. Accepted to improve cache hit rates. Only the `5m` TTL is supported.

| Field  | Type                 | Required | Description |
| ------ | -------------------- | -------- | ----------- |
| `type` | `enum ('ephemeral')` | Yes      |             |
| `ttl`  | `enum ('5m')`        | No       |             |

### Anthropic Citations Config Param {#anthropic-citations-config-param}

Document citation settings. Enabling citations is not supported.

| Field     | Type             | Required | Description |
| --------- | ---------------- | -------- | ----------- |
| `enabled` | `enum ('false')` | No       |             |

### Anthropic Content Block {#anthropic-content-block}

Anthropic Messages content block. Supported block types are `text`, `image`, `video` (Meta extension), `document`, `tool_use`, `tool_result`, `server_tool_use`, `thinking`, and `redacted_thinking`. `cache_control` prompt-cache controls are accepted to improve cache hit rates. Unsupported block types return an `invalid_request_error`.

| Field  | Type     | Required | Description                                                                                              |
| ------ | -------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `type` | `string` | Yes      | Content block discriminator, such as `text`, `image`, `video`, `document`, `tool_use`, or `tool_result`. |

### Anthropic Content Block Param {#anthropic-content-block-param}

Input content block. A block type that a role does not support returns an `invalid_request_error`.

Type: [`AnthropicTextBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-text-block-param) | [`AnthropicImageBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-image-block-param) | [`AnthropicVideoBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-video-block-param) | [`AnthropicDocumentBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-document-block-param) | [`AnthropicSearchResultBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-search-result-block-param) | [`AnthropicToolUseBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-tool-use-block-param) | [`AnthropicToolResultBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-tool-result-block-param) | [`AnthropicServerToolUseBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-server-tool-use-block-param) | [`AnthropicThinkingBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-thinking-block-param) | [`AnthropicRedactedThinkingBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-redacted-thinking-block-param)

### Anthropic Content Source Block Param {#anthropic-content-source-block-param}

A block of an inline-content document.

Type: [`AnthropicContentSourceTextBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-content-source-text-block-param) | [`AnthropicContentSourceOtherBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-content-source-other-block-param)

### Anthropic Content Source Other Block Param {#anthropic-content-source-other-block-param}

Any other block of an inline-content document, passed as its JSON text.

| Field  | Type     | Required | Description                   |
| ------ | -------- | -------- | ----------------------------- |
| `type` | `string` | Yes      | Any block type except `text`. |

### Anthropic Content Source Param {#anthropic-content-source-param}

Document built from inline content blocks.

| Field     | Type                                                                                                                                                    | Required | Description                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `type`    | `enum ('content')`                                                                                                                                      | No       |                                                                                         |
| `content` | `string` \| array of [`AnthropicContentSourceBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-content-source-block-param) | Yes      | A string, or an array of content blocks. Non-text blocks are passed as their JSON text. |

### Anthropic Content Source Text Block Param {#anthropic-content-source-text-block-param}

A text block of an inline-content document.

| Field  | Type            | Required | Description |
| ------ | --------------- | -------- | ----------- |
| `type` | `enum ('text')` | Yes      |             |
| `text` | `string`        | Yes      |             |

### Anthropic Count Tokens Request {#anthropic-count-tokens-request}

| Field           | Type                                                                                                                                              | Required | Description              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------ |
| `model`         | `string`                                                                                                                                          | Yes      | (minLength: 1)           |
| `messages`      | array of [`AnthropicInputMessage`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-input-message)                               | Yes      | (minItems: 1)            |
| `system`        | `string` \| array of [`AnthropicSystemTextBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-system-text-block-param) | No       |                          |
| `tools`         | array of [`AnthropicTool`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-tool)                                                | No       |                          |
| `tool_choice`   | [`AnthropicToolChoice`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-tool-choice)                                            | No       |                          |
| `metadata`      | [`AnthropicMetadataParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-metadata-param)                                      | No       |                          |
| `temperature`   | `number`                                                                                                                                          | No       | (minimum: 0, maximum: 1) |
| `top_p`         | `number`                                                                                                                                          | No       | (minimum: 0, maximum: 1) |
| `thinking`      | [`AnthropicThinkingConfigParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-thinking-config-param)                         | No       |                          |
| `service_tier`  | `enum ('auto', 'standard_only')`                                                                                                                  | No       |                          |
| `cache_control` | [`AnthropicCacheControlEphemeralParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-cache-control-ephemeral-param)          | No       |                          |
| `output_config` | [`AnthropicOutputConfig`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-output-config)                                        | No       |                          |
| `max_tokens`    |                                                                                                                                                   | No       | Ignored.                 |
| `stream`        |                                                                                                                                                   | No       | Ignored.                 |

### Anthropic Count Tokens Response {#anthropic-count-tokens-response}

| Field          | Type      | Required | Description                                              |
| -------------- | --------- | -------- | -------------------------------------------------------- |
| `input_tokens` | `integer` | Yes      | Number of input tokens in the supplied Messages request. |

### Anthropic Custom Tool Param {#anthropic-custom-tool-param}

A developer tool. `type` is omitted or `custom`.

| Field           | Type                                                                                                                                     | Required | Description                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| `type`          | `enum ('custom')`                                                                                                                        | No       |                                                                                 |
| `name`          | `string`                                                                                                                                 | Yes      |                                                                                 |
| `description`   | `string` \| `null`                                                                                                                       | No       |                                                                                 |
| `input_schema`  | `object` \| `null`                                                                                                                       | No       | JSON Schema for the tool's input.                                               |
| `parameters`    |                                                                                                                                          | No       | Parameter schema, read only for the client tool search tool named `ToolSearch`. |
| `strict`        | `boolean` \| `null`                                                                                                                      | No       |                                                                                 |
| `defer_loading` | `boolean` \| `null`                                                                                                                      | No       |                                                                                 |
| `cache_control` | [`AnthropicCacheControlEphemeralParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-cache-control-ephemeral-param) | No       |                                                                                 |

### Anthropic Direct Caller Param {#anthropic-direct-caller-param}

The model invoked the tool directly.

| Field  | Type              | Required | Description |
| ------ | ----------------- | -------- | ----------- |
| `type` | `enum ('direct')` | Yes      |             |

### Anthropic Document Block Param {#anthropic-document-block-param}

Document input.

| Field           | Type                                                                                                                                     | Required | Description |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `type`          | `enum ('document')`                                                                                                                      | No       |             |
| `source`        | [`AnthropicDocumentSourceParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-document-source-param)                | Yes      |             |
| `title`         | `string` \| `null`                                                                                                                       | No       |             |
| `context`       | `string` \| `null`                                                                                                                       | No       |             |
| `citations`     | [`AnthropicCitationsConfigParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-citations-config-param)              | No       |             |
| `cache_control` | [`AnthropicCacheControlEphemeralParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-cache-control-ephemeral-param) | No       |             |

### Anthropic Document Source Param {#anthropic-document-source-param}

Document source.

Type: [`AnthropicBase64SourceParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-base64-source-param) | [`AnthropicPlainTextSourceParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-plain-text-source-param) | [`AnthropicContentSourceParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-content-source-param) | [`AnthropicUrlSourceParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-url-source-param) | [`AnthropicFileSourceParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-file-source-param)

### Anthropic File Source Param {#anthropic-file-source-param}

Media referenced by an uploaded file ID.

| Field     | Type            | Required | Description |
| --------- | --------------- | -------- | ----------- |
| `type`    | `enum ('file')` | No       |             |
| `file_id` | `string`        | Yes      |             |

### Anthropic Image Block Param {#anthropic-image-block-param}

Image input.

| Field           | Type                                                                                                                                     | Required | Description |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `type`          | `enum ('image')`                                                                                                                         | No       |             |
| `source`        | [`AnthropicMediaSourceParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-media-source-param)                      | Yes      |             |
| `cache_control` | [`AnthropicCacheControlEphemeralParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-cache-control-ephemeral-param) | No       |             |

### Anthropic Input Message {#anthropic-input-message}

Anthropic Messages input message.

| Field     | Type                                                                                                                                       | Required | Description |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------- |
| `role`    | `enum ('user', 'assistant', 'system', 'developer')`                                                                                        | Yes      |             |
| `content` | `string` \| array of [`AnthropicContentBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-content-block-param) | Yes      |             |

### Anthropic Json Output Format {#anthropic-json-output-format}

Anthropic JSON structured-output format.

| Field    | Type                   | Required | Description |
| -------- | ---------------------- | -------- | ----------- |
| `type`   | `enum ('json_schema')` | Yes      |             |
| `schema` | `object`               | Yes      |             |

### Anthropic Media Source Param {#anthropic-media-source-param}

Image or video source.

Type: [`AnthropicBase64SourceParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-base64-source-param) | [`AnthropicUrlSourceParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-url-source-param) | [`AnthropicFileSourceParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-file-source-param)

### Anthropic Message {#anthropic-message}

Anthropic-compatible assistant message response.

| Field           | Type                                                                                                                | Required | Description |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `id`            | `string`                                                                                                            | Yes      |             |
| `type`          | `enum ('message')`                                                                                                  | Yes      |             |
| `role`          | `enum ('assistant')`                                                                                                | Yes      |             |
| `content`       | array of [`AnthropicContentBlock`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-content-block) | Yes      |             |
| `model`         | `string`                                                                                                            | Yes      |             |
| `stop_reason`   | `enum ('end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal')`                             | Yes      |             |
| `stop_sequence` | `string` \| `null`                                                                                                  | Yes      |             |
| `usage`         | [`AnthropicUsage`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-usage)                         | Yes      |             |

### Anthropic Message Request {#anthropic-message-request}

| Field           | Type                                                                                                                                              | Required | Description              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------ |
| `model`         | `string`                                                                                                                                          | Yes      | (minLength: 1)           |
| `messages`      | array of [`AnthropicInputMessage`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-input-message)                               | Yes      | (minItems: 1)            |
| `system`        | `string` \| array of [`AnthropicSystemTextBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-system-text-block-param) | No       |                          |
| `tools`         | array of [`AnthropicTool`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-tool)                                                | No       |                          |
| `tool_choice`   | [`AnthropicToolChoice`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-tool-choice)                                            | No       |                          |
| `metadata`      | [`AnthropicMetadataParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-metadata-param)                                      | No       |                          |
| `temperature`   | `number`                                                                                                                                          | No       | (minimum: 0, maximum: 1) |
| `top_p`         | `number`                                                                                                                                          | No       | (minimum: 0, maximum: 1) |
| `thinking`      | [`AnthropicThinkingConfigParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-thinking-config-param)                         | No       |                          |
| `service_tier`  | `enum ('auto', 'standard_only')`                                                                                                                  | No       |                          |
| `cache_control` | [`AnthropicCacheControlEphemeralParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-cache-control-ephemeral-param)          | No       |                          |
| `output_config` | [`AnthropicOutputConfig`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-output-config)                                        | No       |                          |
| `max_tokens`    | `integer`                                                                                                                                         | Yes      | (minimum: 1)             |
| `stream`        | `boolean`                                                                                                                                         | No       | (default: false)         |

### Anthropic Message Request Base {#anthropic-message-request-base}

Anthropic Messages request accepted at `/v1/messages`. `top_k`, `stop_sequences` and `inference_geo` are not supported, so a request that sets them is rejected.

| Field           | Type                                                                                                                                              | Required | Description              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------ |
| `model`         | `string`                                                                                                                                          | Yes      | (minLength: 1)           |
| `messages`      | array of [`AnthropicInputMessage`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-input-message)                               | Yes      | (minItems: 1)            |
| `system`        | `string` \| array of [`AnthropicSystemTextBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-system-text-block-param) | No       |                          |
| `tools`         | array of [`AnthropicTool`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-tool)                                                | No       |                          |
| `tool_choice`   | [`AnthropicToolChoice`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-tool-choice)                                            | No       |                          |
| `metadata`      | [`AnthropicMetadataParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-metadata-param)                                      | No       |                          |
| `temperature`   | `number`                                                                                                                                          | No       | (minimum: 0, maximum: 1) |
| `top_p`         | `number`                                                                                                                                          | No       | (minimum: 0, maximum: 1) |
| `thinking`      | [`AnthropicThinkingConfigParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-thinking-config-param)                         | No       |                          |
| `service_tier`  | `enum ('auto', 'standard_only')`                                                                                                                  | No       |                          |
| `cache_control` | [`AnthropicCacheControlEphemeralParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-cache-control-ephemeral-param)          | No       |                          |
| `output_config` | [`AnthropicOutputConfig`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-output-config)                                        | No       |                          |

### Anthropic Metadata Param {#anthropic-metadata-param}

Request metadata. `user_id` identifies the end user; other string values are passed through.

| Field     | Type     | Required | Description |
| --------- | -------- | -------- | ----------- |
| `user_id` | `string` | No       |             |

### Anthropic Output Config {#anthropic-output-config}

Anthropic output controls. `effort` sets the reasoning effort; `max` selects the strongest available effort.

| Field    | Type                                                                                                                | Required | Description |
| -------- | ------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `effort` | `enum ('low', 'medium', 'high', 'xhigh', 'max')`                                                                    | No       |             |
| `format` | [`AnthropicJsonOutputFormat`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-json-output-format) | No       |             |

### Anthropic Plain Text Source Param {#anthropic-plain-text-source-param}

Plain-text document.

| Field        | Type            | Required | Description                                 |
| ------------ | --------------- | -------- | ------------------------------------------- |
| `type`       | `enum ('text')` | No       |                                             |
| `media_type` |                 | No       | Ignored. Plain text is always `text/plain`. |
| `data`       | `string`        | Yes      |                                             |

### Anthropic Redacted Thinking Block Param {#anthropic-redacted-thinking-block-param}

Encrypted reasoning returned by an earlier response, replayed as is.

| Field               | Type                         | Required | Description                                        |
| ------------------- | ---------------------------- | -------- | -------------------------------------------------- |
| `type`              | `enum ('redacted_thinking')` | No       |                                                    |
| `data`              |                              | No       | The encrypted reasoning, as returned.              |
| `redacted_thinking` |                              | No       | Older name for `data`, read when `data` is absent. |

### Anthropic Search Result Block Param {#anthropic-search-result-block-param}

Search result passed to the model as its JSON text.

| Field           | Type                                                                                                                                     | Required | Description                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------ |
| `type`          | `enum ('search_result')`                                                                                                                 | No       |                                      |
| `source`        |                                                                                                                                          | No       | Where the result came from.          |
| `title`         |                                                                                                                                          | No       | Result title.                        |
| `content`       |                                                                                                                                          | No       | Text blocks with the result content. |
| `cache_control` | [`AnthropicCacheControlEphemeralParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-cache-control-ephemeral-param) | No       |                                      |

### Anthropic Server Tool Caller Param {#anthropic-server-tool-caller-param}

What invoked the tool. Accepted and ignored.

Type: [`AnthropicDirectCallerParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-direct-caller-param)

### Anthropic Server Tool Use Block Param {#anthropic-server-tool-use-block-param}

Earlier server tool call, replayed. Supported names are `web_search` and `tool_search`.

| Field           | Type                                                                                                                                     | Required | Description |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `type`          | `enum ('server_tool_use')`                                                                                                               | No       |             |
| `id`            | `string`                                                                                                                                 | Yes      |             |
| `name`          | `enum ('web_search', 'tool_search')`                                                                                                     | Yes      |             |
| `input`         | [`AnthropicServerToolUseInputParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-server-tool-use-input-param)      | Yes      |             |
| `cache_control` | [`AnthropicCacheControlEphemeralParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-cache-control-ephemeral-param) | No       |             |
| `caller`        | [`AnthropicServerToolCallerParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-server-tool-caller-param)           | No       |             |

### Anthropic Server Tool Use Input Param {#anthropic-server-tool-use-input-param}

The call input, as returned.

| Field   | Type | Required | Description       |
| ------- | ---- | -------- | ----------------- |
| `query` |      | No       | The search query. |

### Anthropic Stream Event {#anthropic-stream-event}

Anthropic Messages server-sent event. Stream event names include `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, and `error`.

Type: `object`

### Anthropic System Text Block Param {#anthropic-system-text-block-param}

A system prompt text block.

| Field           | Type                                                                                                                                     | Required | Description           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- |
| `type`          | `enum ('text')`                                                                                                                          | Yes      |                       |
| `text`          | `string`                                                                                                                                 | Yes      |                       |
| `citations`     |                                                                                                                                          | No       | Accepted and ignored. |
| `cache_control` | [`AnthropicCacheControlEphemeralParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-cache-control-ephemeral-param) | No       |                       |

### Anthropic Text Block Param {#anthropic-text-block-param}

Text content.

| Field           | Type                                                                                                                                     | Required | Description           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- |
| `type`          | `enum ('text')`                                                                                                                          | No       |                       |
| `text`          | `string`                                                                                                                                 | Yes      |                       |
| `citations`     |                                                                                                                                          | No       | Accepted and ignored. |
| `cache_control` | [`AnthropicCacheControlEphemeralParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-cache-control-ephemeral-param) | No       |                       |

### Anthropic Thinking Block Param {#anthropic-thinking-block-param}

Earlier reasoning summary, replayed.

| Field       | Type                | Required | Description           |
| ----------- | ------------------- | -------- | --------------------- |
| `type`      | `enum ('thinking')` | No       |                       |
| `thinking`  | `string`            | Yes      |                       |
| `signature` |                     | No       | Accepted and ignored. |

### Anthropic Thinking Config Adaptive Param {#anthropic-thinking-config-adaptive-param}

The model decides how much to reason.

| Field     | Type                             | Required | Description |
| --------- | -------------------------------- | -------- | ----------- |
| `type`    | `enum ('adaptive')`              | No       |             |
| `display` | `enum ('summarized', 'omitted')` | No       |             |

### Anthropic Thinking Config Disabled Param {#anthropic-thinking-config-disabled-param}

Reasoning off, where the model supports it.

| Field  | Type                | Required | Description |
| ------ | ------------------- | -------- | ----------- |
| `type` | `enum ('disabled')` | No       |             |

### Anthropic Thinking Config Enabled Param {#anthropic-thinking-config-enabled-param}

Reasoning with a token budget.

| Field           | Type                             | Required | Description                                                             |
| --------------- | -------------------------------- | -------- | ----------------------------------------------------------------------- |
| `type`          | `enum ('enabled')`               | No       |                                                                         |
| `budget_tokens` | `integer (int64)`                | Yes      | Reasoning token budget. Must be less than `max_tokens`. (minimum: 1024) |
| `display`       | `enum ('summarized', 'omitted')` | No       |                                                                         |

### Anthropic Thinking Config Param {#anthropic-thinking-config-param}

Extended reasoning settings.

Type: [`AnthropicThinkingConfigEnabledParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-thinking-config-enabled-param) | [`AnthropicThinkingConfigAdaptiveParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-thinking-config-adaptive-param) | [`AnthropicThinkingConfigDisabledParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-thinking-config-disabled-param)

### Anthropic Tool {#anthropic-tool}

Anthropic tool definition. Custom (developer) tools are supported; supported hosted tools are accepted, and unsupported hosted tools return an `invalid_request_error`.

Type: [`AnthropicWebSearchToolParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-web-search-tool-param) | [`AnthropicToolSearchToolParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-tool-search-tool-param) | [`AnthropicCustomToolParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-custom-tool-param)

### Anthropic Tool Choice {#anthropic-tool-choice}

| Field                       | Type                           | Required | Description |
| --------------------------- | ------------------------------ | -------- | ----------- |
| `type`                      | `enum ('auto', 'any', 'none')` | Yes      |             |
| `name`                      |                                | No       | Ignored.    |
| `disable_parallel_tool_use` | `boolean`                      | No       |             |

### Anthropic Tool Result Block Param {#anthropic-tool-result-block-param}

Result of an earlier tool call.

| Field           | Type                                                                                                                                                             | Required | Description                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `type`          | `enum ('tool_result')`                                                                                                                                           | No       |                                                                                      |
| `tool_use_id`   | `string`                                                                                                                                                         | Yes      |                                                                                      |
| `content`       | `string` \| array of [`AnthropicToolResultContentBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-tool-result-content-block-param) | No       | A string, or an array of content blocks. Any other value is passed as its JSON text. |
| `is_error`      |                                                                                                                                                                  | No       | `true` marks the result as an error.                                                 |
| `cache_control` | [`AnthropicCacheControlEphemeralParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-cache-control-ephemeral-param)                         | No       |                                                                                      |

### Anthropic Tool Result Content Block Param {#anthropic-tool-result-content-block-param}

A block of a tool result. Blocks other than `text`, `image` and `document` are passed as their JSON text.

Type: [`AnthropicContentSourceTextBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-content-source-text-block-param) | [`AnthropicToolResultImageBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-tool-result-image-block-param) | [`AnthropicToolResultDocumentBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-tool-result-document-block-param) | [`AnthropicToolResultOtherBlockParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-tool-result-other-block-param)

### Anthropic Tool Result Document Block Param {#anthropic-tool-result-document-block-param}

A document in a tool result.

| Field       | Type                                                                                                                        | Required | Description |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `type`      | `enum ('document')`                                                                                                         | Yes      |             |
| `source`    | [`AnthropicDocumentSourceParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-document-source-param)   | Yes      |             |
| `title`     | `string` \| `null`                                                                                                          | No       |             |
| `context`   | `string` \| `null`                                                                                                          | No       |             |
| `citations` | [`AnthropicCitationsConfigParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-citations-config-param) | No       |             |

### Anthropic Tool Result Image Block Param {#anthropic-tool-result-image-block-param}

An image in a tool result.

| Field    | Type                                                                                                                | Required | Description |
| -------- | ------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `type`   | `enum ('image')`                                                                                                    | Yes      |             |
| `source` | [`AnthropicMediaSourceParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-media-source-param) | Yes      |             |

### Anthropic Tool Result Other Block Param {#anthropic-tool-result-other-block-param}

Any other block of a tool result, passed as its JSON text.

| Field  | Type     | Required | Description                                           |
| ------ | -------- | -------- | ----------------------------------------------------- |
| `type` | `string` | No       | Any block type except `text`, `image` and `document`. |

### Anthropic Tool Search Tool Param {#anthropic-tool-search-tool-param}

The hosted tool search tool.

| Field           | Type                                                                                                                                     | Required | Description                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------- |
| `type`          | `enum ('tool_search', 'tool_search_20250305')`                                                                                           | Yes      |                                                          |
| `execution`     | `enum ('server', 'client')` \| `null`                                                                                                    | No       |                                                          |
| `description`   | `string` \| `null`                                                                                                                       | No       |                                                          |
| `parameters`    | `object` \| `null`                                                                                                                       | No       | Parameter schema for a client-executed tool search tool. |
| `input_schema`  |                                                                                                                                          | No       | Used as `parameters` when `parameters` is omitted.       |
| `cache_control` | [`AnthropicCacheControlEphemeralParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-cache-control-ephemeral-param) | No       |                                                          |

### Anthropic Tool Use Block Param {#anthropic-tool-use-block-param}

Earlier tool call, replayed.

| Field           | Type                                                                                                                                     | Required | Description                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------- |
| `type`          | `enum ('tool_use')`                                                                                                                      | No       |                               |
| `id`            | `string`                                                                                                                                 | Yes      |                               |
| `name`          | `string`                                                                                                                                 | Yes      |                               |
| `input`         |                                                                                                                                          | No       | Tool arguments, as an object. |
| `cache_control` | [`AnthropicCacheControlEphemeralParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-cache-control-ephemeral-param) | No       |                               |

### Anthropic Url Source Param {#anthropic-url-source-param}

Media fetched from a URL.

| Field  | Type           | Required | Description |
| ------ | -------------- | -------- | ----------- |
| `type` | `enum ('url')` | No       |             |
| `url`  | `string`       | Yes      |             |

### Anthropic Usage {#anthropic-usage}

| Field                                   | Type      | Required | Description |
| --------------------------------------- | --------- | -------- | ----------- |
| `input_tokens`                          | `integer` | Yes      |             |
| `output_tokens`                         | `integer` | Yes      |             |
| `cache_creation_input_tokens`           | `integer` | No       |             |
| `cache_read_input_tokens`               | `integer` | No       |             |
| `output_tokens_details`                 | `object`  | No       |             |
| `output_tokens_details.thinking_tokens` | `integer` | No       |             |

### Anthropic User Location Param {#anthropic-user-location-param}

Approximate user location for web search.

| Field      | Type                   | Required | Description |
| ---------- | ---------------------- | -------- | ----------- |
| `type`     | `enum ('approximate')` | No       |             |
| `city`     | `string` \| `null`     | No       |             |
| `region`   | `string` \| `null`     | No       |             |
| `country`  | `string` \| `null`     | No       |             |
| `timezone` | `string` \| `null`     | No       |             |

### Anthropic Video Block Param {#anthropic-video-block-param}

Video input (Meta extension).

| Field           | Type                                                                                                                                     | Required | Description                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------- |
| `type`          | `enum ('video')`                                                                                                                         | No       |                              |
| `source`        | [`AnthropicMediaSourceParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-media-source-param)                      | Yes      |                              |
| `fps`           | `number` \| `null`                                                                                                                       | No       | Frames per second to sample. |
| `cache_control` | [`AnthropicCacheControlEphemeralParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-cache-control-ephemeral-param) | No       |                              |

### Anthropic Web Search Tool Param {#anthropic-web-search-tool-param}

The hosted web search tool.

| Field           | Type                                                                                                                                     | Required | Description |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| `type`          | `enum ('web_search', 'web_search_20250305', 'web_search_20250305_15')`                                                                   | Yes      |             |
| `user_location` | [`AnthropicUserLocationParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-user-location-param)                    | No       |             |
| `cache_control` | [`AnthropicCacheControlEphemeralParam`](https://dev.meta.ai/docs/api-reference/messages/schemas#anthropic-cache-control-ephemeral-param) | No       |             |
