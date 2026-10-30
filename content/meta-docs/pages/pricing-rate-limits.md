# Pricing and rate limits {#pricing-and-rate-limits}

Use our models with pay-as-you-go billing on Meta Model API and in [Muse Code](https://dev.meta.ai/docs/muse-code), or in Muse Code with a monthly [subscription](https://dev.meta.ai/docs/muse-code/subscriptions). This page covers pay-as-you-go: Model API bills text models per token, image generation per image, Muse Voice Transcribe by the hour of audio processed, and Segment Anything Model (SAM) per image or video frame segmented, with no minimums or upfront commitment.

## Pricing modes {#pricing-modes}

Some models can be used in two modes. Standard mode uses standard pricing. Contributor mode offers discounted pricing or more usage in exchange for permission to use your content — the prompts, code, files, and context you send, plus the model responses you get back — to train future Meta models.

### Standard mode {#standard-mode}

In Standard mode, you pay standard prices and your content is not used to train Meta models. Every model on this page is available in Standard mode.

### Contributor mode {#contributor-mode}

On Model API, Contributor mode runs the same models at heavily discounted token prices, in exchange for permission to use your content to train future Meta models. It lowers the barrier to entry for prototyping, testing integrations, and scaling experiments where it's acceptable for Meta to use your content to train future Meta models.

On Model API, use Contributor mode with Muse Spark 1.3 or 1.2 by calling its Contributor-mode variant: `muse-spark-1.3-contributor` or `muse-spark-1.2-contributor`. Contributor mode isn't available for Muse Wonder on Model API.

In [Muse Code](https://dev.meta.ai/docs/muse-code), subscriptions default to Contributor mode, and you can turn it on or off in settings; see [Contributor mode in Muse Code](https://dev.meta.ai/docs/muse-code/subscriptions#contributor-mode).

## Model pricing {#pricing}

### Muse Wonder {#muse-wonder-pricing}

Model: `muse-wonder-1.0`.

| Usage        | Standard mode (per 1M tokens) | Contributor mode (per 1M tokens) |
| :----------- | :---------------------------- | :------------------------------- |
| Cached input | $0.20                         | Not available                    |
| Input        | $4.00                         | Not available                    |
| Output       | $20.00                        | Not available                    |

### Muse Spark {#muse-spark-pricing}

Models: `muse-spark-1.3`, `muse-spark-1.2`, and `muse-spark-1.1` in Standard mode; `muse-spark-1.3-contributor` and `muse-spark-1.2-contributor` in Contributor mode. Muse Spark 1.1 is Standard mode only.

| Usage        | Standard mode (per 1M tokens) | Contributor mode (per 1M tokens) |
| :----------- | :---------------------------- | :------------------------------- |
| Cached input | $0.15                         | $0.002                           |
| Input        | $1.25                         | $0.10                            |
| Output       | $4.25                         | $0.20                            |

### Token pricing notes {#token-pricing-notes}

These apply to the token-priced models above, Muse Wonder and Muse Spark.

- **Cached input costs less**: When part of your prompt matches a [cached prefix](https://dev.meta.ai/docs/prompt-caching), you pay the cached-input rate for those tokens. Check `cached_tokens` in the response to see how many were served from cache.
- **No long-context premium**: you pay the same rate whether your context window is mostly empty or almost full.
- **Web search grounding**: **$2.50 per 1,000 search queries**, in addition to the request's token cost. This applies to the [`web_search` tool](https://dev.meta.ai/docs/search-grounding) on text models such as [Muse Wonder](https://dev.meta.ai/docs/models#muse-wonder) and [Muse Spark](https://dev.meta.ai/docs/models#muse-spark).

> **NOTE: Muse Image search is included**
>
> [Muse Image](https://dev.meta.ai/docs/models#muse-image)'s built-in web and image search is part of its per-image price and isn't charged separately. See [Muse Image pricing](https://dev.meta.ai/docs/pricing-rate-limits#image-generation).

### Muse Image {#image-generation}

| Usage           | Price           |
| :-------------- | :-------------- |
| Generated image | $0.01 per image |

[Muse Image](https://dev.meta.ai/docs/models#muse-image) is billed at a flat rate per generated image. The price is the same regardless of prompt length, `reasoning_strength`, or the tools the model uses during generation, including its built-in web and image search, which isn't charged separately. A request that returns `n` images is billed for `n` images. You're billed only for images the model successfully generates and returns: images that fail to generate, or that are removed by safety filtering before they're returned, aren't counted. Image responses still include a `usage` object with token counts for reference, but image generation tokens are not included in token-based pricing for other models. See the [Image generation](https://dev.meta.ai/docs/image-generation#images-response) guide for the response shape.

### Muse Voice Transcribe {#muse-voice-transcribe-pricing}

[Muse Voice Transcribe](https://dev.meta.ai/docs/speech-to-text) is billed by audio processed, metered in whole seconds.

| Usage           | Price          |
| :-------------- | :------------- |
| Audio processed | $0.18 per hour |

Streaming and non-streaming transcription are priced the same. Zero data retention (ZDR) is priced at parity with Standard mode. Contributor mode isn't available for Muse Voice Transcribe. Audio time is billed as a separate line item from token usage, rounded down to whole seconds; other endpoints aren't billed for audio time.

### Segment Anything Model 3.1 {#sam-pricing}

[SAM 3.1](https://dev.meta.ai/docs/models#sam-3) segmentation is billed per image and per video frame, not per token. The same prices apply to streaming and non-streaming requests. Each video request is billed for at least 50 frames, so a clip or tracking range shorter than 50 frames is billed as 50. The response's `usage.video_frames_processed` reports the frames billed for that request.

| Usage              | Price                  |
| :----------------- | :--------------------- |
| Image segmentation | $2.50 per 1,000 images |
| Video segmentation | $0.20 per 1,000 frames |

## Rate limits {#rate-limits}

Rate limits apply **per team, not per API key**: requests, tokens, and streams from every key in a team count toward the same limits. Each model below has its own limits, so traffic to one model doesn't use up another's.

| Model                        | Requests per minute (RPM) | Tokens per minute (TPM) | Other limits                                    |
| :--------------------------- | :------------------------ | :---------------------- | :---------------------------------------------- |
| `muse-wonder-1.0`            | 3,000                     | 4,000,000               |                                                 |
| `muse-spark-1.3`             | 3,000                     | 4,000,000               |                                                 |
| `muse-spark-1.2`             | 3,000                     | 4,000,000               |                                                 |
| `muse-spark-1.3-contributor` | 150                       | 3,000,000               |                                                 |
| `muse-spark-1.2-contributor` | 150                       | 3,000,000               |                                                 |
| `muse-spark-1.1`             | 3,000                     | 4,000,000               |                                                 |
| `sam-3.1`                    | 3,000                     | None                    |                                                 |
| `muse-image-1.0`             | 150                       | None                    |                                                 |
| `muse-voice-transcribe-1.0`  | None                      | None                    | 256 concurrent streams; 16,000 streams per hour |

[SAM 3.1](https://dev.meta.ai/docs/models#sam-3) is [billed per image or frame](https://dev.meta.ai/docs/pricing-rate-limits#sam-pricing) and [Muse Image](https://dev.meta.ai/docs/models#muse-image) is [priced per image](https://dev.meta.ai/docs/pricing-rate-limits#image-generation), so neither has a TPM limit.

[Muse Voice Transcribe](https://dev.meta.ai/docs/speech-to-text) is [billed by audio processed](https://dev.meta.ai/docs/pricing-rate-limits#muse-voice-transcribe-pricing), so it's limited by streams rather than requests or tokens. **Concurrent streams** caps how many transcription sessions you hold open at once; **streams per hour** caps how many you start. Realtime and file transcription share the same budget.

Token usage counts only **your** input and output tokens. Meta injects a small amount of steering context into every prompt (a system prompt and related scaffolding); those injected tokens are not billed and are excluded from the token counts reported in your `usage` and by the [token-counting endpoints](https://dev.meta.ai/docs/token-counting#injected-tokens).

### Background responses {#background-rate-limit}

Creating [background responses](https://dev.meta.ai/docs/protocols/responses#using-with-other-features) (`background: true`) is limited to **600 submissions per minute, per team**, in addition to the limits above. The cap applies only to starting new background responses: over it, new submissions return `HTTP 429 Too Many Requests` with a `Retry-After` header, and responses already running continue unaffected.

## Handle rate limits {#handle-rate-limits}

When you exceed a limit, the API rejects the request. Requests succeed again once usage drops below the limit.

### Retry on 429 responses {#rate-limit-behavior}

**Retry strategy:** Use exponential backoff with jitter. Start with a short delay such as 500 ms, double it after each consecutive rate-limit response, and add random jitter so concurrent clients don't all retry at the same moment. If the response includes a `Retry-After` header, wait at least that long.

### Read rate-limit headers {#rate-limit-headers}

Every successful token-based response includes headers that report your current limit and remaining quota:

| Header                           | Description                                  |
| :------------------------------- | :------------------------------------------- |
| `x-ratelimit-limit-tokens`       | Total token budget for the current window.   |
| `x-ratelimit-remaining-tokens`   | Tokens remaining before you hit the limit.   |
| `x-ratelimit-limit-requests`     | Total request budget for the current window. |
| `x-ratelimit-remaining-requests` | Requests remaining before you hit the limit. |

Read these headers and slow down before you hit a rate limit instead of reacting after one.

### Handle Muse Voice Transcribe rejections {#muse-voice-transcribe-rate-limits}

A realtime stream rejected for exceeding a stream limit closes with `1013`. A rejected file-transcription request returns `HTTP 429 Too Many Requests`. Transcription responses don't include the `x-ratelimit-*` headers.

## See also {#see-also}

- [Models](https://dev.meta.ai/docs/models): every model line, its versions, and where each one is available
- [Subscriptions](https://dev.meta.ai/docs/muse-code/subscriptions): Muse Code plans, an alternative to pay-as-you-go
