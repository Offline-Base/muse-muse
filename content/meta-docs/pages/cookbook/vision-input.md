# Vision input {#vision-input}

**What you'll build**: a chat completion that takes an image plus a question and returns an analysis, using the same endpoint you already know.

|                      |                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Section**          | [API fundamentals](https://dev.meta.ai/docs/cookbook#api-fundamentals)                                                                                   |
| **Capabilities**     | [Vision](https://dev.meta.ai/docs/features/image-understanding)                                                                                          |
| **Time to complete** | \~10 min                                                                                                                                                 |
| **Model**            | `muse-spark-1.3`                                                                                                                                         |
| **Language**         | Python                                                                                                                                                   |
| **Prerequisites**    | the [chat completions recipe](https://dev.meta.ai/docs/cookbook/quickstart-chat-completions), Python 3.10+, the `openai` package, and a `MODEL_API_KEY`. |

You send an image as a content part inside a `user` message. The image can be a public URL the server fetches, or a base64 data URL you inline. See the [image understanding guide](https://dev.meta.ai/docs/features/image-understanding).

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

## Send an image {#send-an-image}

A message's `content` becomes a list of parts: a `text` part for your question and an `image_url` part for the picture. Here the image is a base64 data URL, so the example runs with no external host.

```python
# A small, self-contained test image (256x256: red left half, blue right half),
# encoded as a base64 data URL so this recipe needs no external image host.
SAMPLE_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAC/0lEQVR42u3TsQkAAAzDsPz/dDvngiwCX2BQLtEwD8Z5AAAAAgAAAQCAAABAAAAgAAAQAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAA8AAAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAGQAAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAAAOABAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAADIAwAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAAACAAABAAAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAEAAACAAABAIAAAEAAACAAAADAAwAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgLoHSlsO8jZgvpcAAAAASUVORK5CYII="

response = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Describe this image in one short sentence."},
                {"type": "image_url", "image_url": {"url": SAMPLE_IMAGE}},
            ],
        }
    ],
)
print(response.choices[0].message.content)
```

## Compare several images in one request {#compare-several-images-in-one-request}

A single `user` message can hold multiple `image_url` parts, so you can compare or rank images in one call. The model sees them in the order you list them; the practical ceiling is about 50 images per request (also bounded by payload size and the context window). Here three solid-color swatches go in one request:

```python
# Generate a few small solid-color PNGs with the standard library (no extra
# dependencies), so the multi-image example needs no external image host.
import base64
import struct
import zlib


def solid_png(rgb, size=64):
    """Return a base64 PNG data URL for a size x size solid-color square."""

    def chunk(tag, data):
        body = tag + data
        return (
            struct.pack(">I", len(data))
            + body
            + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    row = b"\x00" + bytes(rgb) * size  # filter byte + one pixel row
    idat = zlib.compress(row * size)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )
    return "data:image/png;base64," + base64.b64encode(png).decode()


swatches = {
    "red": solid_png((220, 30, 30)),
    "green": solid_png((30, 200, 60)),
    "blue": solid_png((30, 60, 220)),
}

response = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "Each image is a solid-color swatch. List the colors in the order shown.",
                },
                *(
                    {"type": "image_url", "image_url": {"url": url}}
                    for url in swatches.values()
                ),
            ],
        }
    ],
)
print(response.choices[0].message.content)
```

## Send a hosted image by URL {#send-a-hosted-image-by-url}

Instead of inlining base64, you can point `image_url` at a public URL and the server fetches it. The request shape is identical:

```python
response = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "What animal is this?"},
                {"type": "image_url", "image_url": {"url": "https://example.com/cat.jpg"}},
            ],
        }
    ],
)
```

Use base64 for local or private images, and a URL when the image is already hosted somewhere the server can reach. See the [image understanding guide](https://dev.meta.ai/docs/features/image-understanding).

## Images go in user messages only {#images-go-in-user-messages-only}

Image content is accepted only on `user`-role messages. Put it in a `developer` or `system` message and the request is rejected with `HTTP 400` rather than silently dropped.

```python
from openai import BadRequestError

# Wrong: image content placed in a developer message
try:
    client.chat.completions.create(
        model="muse-spark-1.3",
        messages=[
            {
                "role": "developer",
                "content": [
                    {"type": "text", "text": "Reference image:"},
                    {"type": "image_url", "image_url": {"url": SAMPLE_IMAGE}},
                ],
            },
            {"role": "user", "content": "What colors are in the reference image?"},
        ],
    )
except BadRequestError as exc:
    print("HTTP 400:", str(exc)[:160])
```

The fix is the shape from the first example: keep the image in the `user` message.

## Measure image tokens before you send {#measure-image-tokens-before-you-send}

An image costs real input tokens, and the amount scales with resolution rather than a flat per-image fee. The image calls above use **Chat Completions**. To count tokens before you send, use the **Responses API** helper `POST /v1/responses/input_tokens`, which returns the token count without generating anything — it is a measurement utility, not a different way to send the image, and the cost it reports is the same on either endpoint. Note the Responses input shape differs: `input_text` and `input_image`, not the Chat `text` / `image_url`.

```python
def count_input_tokens(input_items):
    result = client.post(
        "/responses/input_tokens",
        body={"model": "muse-spark-1.3", "input": input_items},
        cast_to=object,
    )
    return result["input_tokens"]


text_only = [
    {
        "role": "user",
        "content": [{"type": "input_text", "text": "Describe this image."}],
    }
]
with_image = [
    {
        "role": "user",
        "content": [
            {"type": "input_text", "text": "Describe this image."},
            {"type": "input_image", "image_url": SAMPLE_IMAGE},
        ],
    }
]

print("text only: ", count_input_tokens(text_only), "tokens")
print("with image:", count_input_tokens(with_image), "tokens")
```

## Send images in production {#send-images-in-production}

- **Images go in `user` messages.** A `developer` or `system` message with image content returns `HTTP 400`.
- **URL or base64.** `image_url` accepts a public URL (the server fetches it) or a base64 data URL (inline, no hosting). Supported types: `jpeg`, `jpg`, `png`, `gif`, `webp`, `x-icon`.
- **Measure before sending.** Image token cost scales with resolution. Use `POST /v1/responses/input_tokens` to budget large or multi-image requests.
- **Know the limits.** Up to about 50 images per request (a model guideline, also bounded by payload size and the context window), 50 MB per inline image, or up to 1 GiB via the Files API. PDF page-images count toward the same image budget.

## Summary {#summary}

| Pattern       | How                                                               |
| ------------- | ----------------------------------------------------------------- |
| Send an image | an `image_url` content part inside a `user` message               |
| Source        | public URL (server fetches) or base64 data URL (inline)           |
| Roles         | image content only in `user` messages                             |
| Formats       | `jpeg`, `jpg`, `png`, `gif`, `webp`, `x-icon`                     |
| Token cost    | scales with resolution; measure with `/v1/responses/input_tokens` |
| Limits        | \~50 images/request, 50 MB inline, 1 GiB via Files API            |

## Next steps {#next-steps}

- Return image analysis as schema-valid JSON: recipe [04 — Structured output](https://dev.meta.ai/docs/cookbook/structured-output).
- Budget large inputs against the context window: recipe [08 — Long context](https://dev.meta.ai/docs/cookbook/long-context).
- Read the [image understanding guide](https://dev.meta.ai/docs/features/image-understanding) and the [API reference](https://dev.meta.ai/docs/api-reference/chat-completions).
