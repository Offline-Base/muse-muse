# Error handling & retry patterns {#error-handling--retry-patterns}

**What you'll build**: a client that tells transient failures apart from permanent ones, retries the transient ones with backoff, and surfaces the permanent ones.

|                      |                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Section**          | [API fundamentals](https://dev.meta.ai/docs/cookbook#api-fundamentals)                                                                                   |
| **Capabilities**     | —                                                                                                                                                        |
| **Time to complete** | \~10 min                                                                                                                                                 |
| **Model**            | `muse-spark-1.3`                                                                                                                                         |
| **Language**         | Python                                                                                                                                                   |
| **Prerequisites**    | the [chat completions recipe](https://dev.meta.ai/docs/cookbook/quickstart-chat-completions), Python 3.10+, the `openai` package, and a `MODEL_API_KEY`. |

The API returns standard HTTP status codes with an OpenAI-style error envelope. Production code handles those codes: it backs off on the temporary ones and surfaces the permanent ones. See [error handling](https://dev.meta.ai/docs/getting-started/error-handling) and [rate limits](https://dev.meta.ai/docs/getting-started/pricing-rate-limits).

## Setup {#setup}

One cell wires up the client: it reads your key from the environment and falls back to Colab secrets when you run in a notebook.

```python
import os

from openai import OpenAI

# Auth: in Colab, read the key from the secrets manager (the key icon in the
# left sidebar); otherwise read the MODEL_API_KEY environment variable.
try:
    from google.colab import userdata

    api_key = userdata.get("MODEL_API_KEY")
except Exception:
    api_key = os.environ.get("MODEL_API_KEY")

if not api_key:
    raise RuntimeError(
        "Set MODEL_API_KEY in your environment (or add it to Colab secrets)."
    )

# The OpenAI SDK does not auto-read MODEL_API_KEY, so pass it explicitly.
client = OpenAI(base_url="https://api.meta.ai/v1", api_key=api_key)

# Connectivity check: a one-line call that confirms the key and endpoint work.
ping = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[{"role": "user", "content": "Reply with the single word: ready"}],
)
print(ping.choices[0].message.content)
```

## Read the error envelope {#read-the-error-envelope}

Errors arrive as `{"error": {"message", "type", "param", "code"}}`. Branch on `type` and the HTTP `status_code`, not `code` — `code` is often `null` on validation errors. The SDK raises typed exceptions (`BadRequestError`, `RateLimitError`, and so on); the envelope is on `exc.body`.

```python
from openai import BadRequestError

try:
    # n must be 1; this is a malformed request
    client.chat.completions.create(
        model="muse-spark-1.3",
        messages=[{"role": "user", "content": "hi"}],
        n=2,
    )
except BadRequestError as exc:
    body = exc.body or {}
    print("status_code:", exc.status_code)
    print("type:", body.get("type"))
    print("param:", body.get("param"))
    print("message:", body.get("message"))
```

## Which errors to retry {#which-errors-to-retry}

| Status               | Exception                               | Retry?                     |
| -------------------- | --------------------------------------- | -------------------------- |
| 429                  | `RateLimitError`                        | Yes, with backoff          |
| 500-599              | `APIStatusError`                        | Yes, with backoff          |
| timeout / connection | `APITimeoutError`, `APIConnectionError` | Yes, with backoff          |
| 400                  | `BadRequestError`                       | No — fix the request       |
| 401                  | `AuthenticationError`                   | No — fix the key           |
| 404                  | `NotFoundError`                         | No — fix the model or path |

Retrying a permanent error wastes attempts and adds latency.

## Retrying a 400 never succeeds {#retrying-a-400-never-succeeds}

A loop that retries every exception treats a malformed request as if it were temporary. It never succeeds, because the request is invalid on every attempt.

```python
import time

attempts = 0
for attempt in range(4):
    attempts += 1
    try:
        client.chat.completions.create(
            model="muse-spark-1.3",
            messages=[{"role": "user", "content": "hi"}],
            n=2,  # permanently invalid
        )
        break
    except Exception as exc:
        print(f"attempt {attempt + 1} failed: {type(exc).__name__}; retrying...")
        time.sleep(0.3)

print(f"gave up after {attempts} attempts — the request was malformed, not transient")
```

## Classify errors, then back off with jitter {#classify-errors-then-back-off-with-jitter}

Retry only the transient classes. Use exponential backoff (double the delay each time) plus random jitter (so concurrent clients don't retry in lockstep), and cap the attempts. Re-raise everything else immediately.

```python
import random

from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    RateLimitError,
)

RETRYABLE = (RateLimitError, APITimeoutError, APIConnectionError)


def complete_with_retry(messages, *, max_retries=5, **kwargs):
    """Retry 429 / 5xx / timeout with exponential backoff and jitter; surface the rest."""
    if max_retries < 1:
        raise ValueError("max_retries must be at least 1")
    delay = 0.5
    for attempt in range(max_retries):
        try:
            return client.chat.completions.create(
                model="muse-spark-1.3", messages=messages, **kwargs
            )
        except RETRYABLE as exc:
            if attempt == max_retries - 1:
                raise
            wait = delay * (2**attempt) + random.uniform(0, 0.5)
            print(f"transient {type(exc).__name__}; retrying in {wait:.1f}s")
            time.sleep(wait)
        except APIStatusError as exc:
            if exc.status_code >= 500 and attempt < max_retries - 1:
                wait = delay * (2**attempt) + random.uniform(0, 0.5)
                print(f"server error {exc.status_code}; retrying in {wait:.1f}s")
                time.sleep(wait)
                continue
            raise  # 4xx: not retryable


# A valid call succeeds through the wrapper
print(
    complete_with_retry([{"role": "user", "content": "Say hi in one word."}])
    .choices[0]
    .message.content
)

# A 400 is surfaced immediately, with no wasted retries
try:
    complete_with_retry([{"role": "user", "content": "hi"}], n=2)
except BadRequestError as exc:
    print(
        "surfaced immediately (not retried):",
        exc.status_code,
        "-",
        (exc.body or {}).get("message"),
    )
```

## Throttle before you hit a 429 {#throttle-before-you-hit-a-429}

Every response carries your current rate-limit budget in headers. Read them with `with_raw_response` and slow down as `remaining` drops, instead of waiting for the 429.

```python
raw = client.chat.completions.with_raw_response.create(
    model="muse-spark-1.3",
    messages=[{"role": "user", "content": "Say hi."}],
)

for header in (
    "x-ratelimit-remaining-requests",
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-limit-tokens",
):
    print(f"{header}: {raw.headers.get(header)}")

completion = raw.parse()  # the usual completion object is still available
print("->", completion.choices[0].message.content)
```

## Stop hammering a failing dependency {#stop-hammering-a-failing-dependency}

When failures persist past a threshold, a circuit breaker stops sending calls for a cooldown, then lets one through to test recovery. This protects both your latency budget and the upstream service.

```python
class CircuitBreaker:
    """Open after `threshold` consecutive failures; allow one trial call after `cooldown`."""

    def __init__(self, threshold=3, cooldown=30.0):
        self.threshold = threshold
        self.cooldown = cooldown
        self.failures = 0
        self.opened_at = None

    def allow(self):
        if self.opened_at is None:
            return True
        if time.monotonic() - self.opened_at >= self.cooldown:
            # Half-open: let one trial call through. `failures` stays at the
            # threshold, so a failed trial re-opens the circuit immediately; a
            # successful trial calls record(ok=True), which resets the count.
            self.opened_at = None
            return True
        return False

    def record(self, *, ok):
        if ok:
            self.failures = 0
        else:
            self.failures += 1
            if self.failures >= self.threshold:
                self.opened_at = time.monotonic()


breaker = CircuitBreaker(threshold=2, cooldown=30.0)


def call(label, *, ok):
    if not breaker.allow():
        print(f"{label}: circuit open -> skipped")
        return
    breaker.record(ok=ok)
    state = "open" if breaker.opened_at else "closed"
    print(f"{label}: ok={ok} -> failures={breaker.failures}, circuit {state}")


call("call 1", ok=False)  # first failure
call("call 2", ok=False)  # second failure -> circuit opens
call("call 3", ok=True)  # skipped while the circuit is open

# Simulate the cooldown elapsing instead of sleeping 30s
breaker.opened_at -= breaker.cooldown
print("-- cooldown elapsed --")

call("call 4", ok=True)  # half-open trial succeeds -> circuit closes
```

## Handle errors in production {#handle-errors-in-production}

- **Branch on `type` and `status_code`, not `code`.** `code` is frequently `null` on validation errors.
- **Retry only transient classes** (429, 5xx, timeouts) with exponential backoff plus jitter, and cap the attempts.
- **Never retry 4xx.** A `400` means the request is malformed, `401` the key is wrong, `404` the model or path is wrong. Fix it.
- **Unsupported OpenAI parameters return `400`.** `stop`, `n > 1`, `logit_bias`, `verbosity`, and a few others aren't supported on this reasoning model — see [OpenAI compatibility](https://dev.meta.ai/docs/features/chat-completion#openai-compatibility).
- **Throttle from the rate-limit headers** and add a circuit breaker for sustained failures.

## Summary {#summary}

| Pattern        | How                                                            |
| -------------- | -------------------------------------------------------------- |
| Read the error | `exc.status_code` and `exc.body` (`type`, `param`, `message`)  |
| Retry          | 429 / 5xx / timeout, with exponential backoff + jitter, capped |
| Don't retry    | 400 / 401 / 404 — fix the request, key, or model               |
| Throttle       | read `x-ratelimit-remaining-*` via `with_raw_response`         |
| Protect        | a circuit breaker stops calls after repeated failures          |

## Next steps {#next-steps}

- Apply the retry wrapper to every recipe's calls: start with [01 — Chat completions](https://dev.meta.ai/docs/cookbook/quickstart-chat-completions).
- Handle errors mid-stream: recipe [02 — Streaming responses](https://dev.meta.ai/docs/cookbook/streaming-responses).
- Read [error handling](https://dev.meta.ai/docs/getting-started/error-handling) and [rate limits](https://dev.meta.ai/docs/getting-started/pricing-rate-limits).
