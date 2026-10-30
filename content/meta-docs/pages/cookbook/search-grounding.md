# Search grounding {#search-grounding}

**What you'll build**: a Responses API call that searches the live web and answers with inline citations — then you turn those citations into rendered footnotes. No retrieval pipeline, search index, or RAG setup.

|                      |                                                                                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Section**          | [API fundamentals](https://dev.meta.ai/docs/cookbook#api-fundamentals)                                                                                                                                                                          |
| **Capabilities**     | [Search grounding](https://dev.meta.ai/docs/features/search-grounding)                                                                                                                                                                          |
| **Time to complete** | \~10 min                                                                                                                                                                                                                                        |
| **Model**            | `muse-spark-1.3`                                                                                                                                                                                                                                |
| **Language**         | Python                                                                                                                                                                                                                                          |
| **Prerequisites**    | the [chat completions recipe](https://dev.meta.ai/docs/cookbook/quickstart-chat-completions) and the [tool calling recipe](https://dev.meta.ai/docs/cookbook/tool-function-calling), Python 3.10+, the `openai` package, and a `MODEL_API_KEY`. |

Search grounding is a built-in tool on the [Responses API](https://dev.meta.ai/docs/features/responses). Add `tools=[{"type": "web_search"}]` and the model decides whether a search is needed, runs it server-side, and synthesizes a cited answer. Each supported passage comes back as a `url_citation` annotation that points at the exact characters it backs and the source URL — that mapping is the focus of this recipe. See the [search grounding guide](https://dev.meta.ai/docs/features/search-grounding).

Search grounding is **Responses API only** — it is not available on Chat Completions, which is why this recipe uses `client.responses.create()` rather than `client.chat.completions.create()`.

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
ping = client.responses.create(
    model="muse-spark-1.3", input="Reply with the single word: ready"
)
print(ping.output_text)
```

## Turn on web search {#turn-on-web-search}

Pass one tool and ask about something recent. The response `output` is a **list of items**, not a single message. Because `muse-spark-1.3` reasons before it answers, that list interleaves `reasoning` items with one or more `web_search_call` items (each search the model ran) and ends with a `message` item — the grounded answer. Don't rely on position; filter by `item.type`. `response.output_text` is the convenience accessor that concatenates the text blocks.

```python
research = client.responses.create(
    model="muse-spark-1.3",
    input="Summarize the latest developments in nuclear fusion energy research.",
    tools=[{"type": "web_search"}],
)

# The model handles the whole search-and-synthesize flow; inspect the item types.
for item in research.output:
    print("output item:", item.type)

print()
print(research.output_text)
```

## Citations arrive as annotations {#citations-arrive-as-annotations}

The grounded answer does not just cite sources in prose — every claim carries a machine-readable `url_citation` annotation attached to its `output_text` block. Each annotation ties a **character span of the answer** to the source it came from:

| Field         | Meaning                                                   |
| ------------- | --------------------------------------------------------- |
| `url`         | Source URL the model cited                                |
| `title`       | Page title of the source                                  |
| `start_index` | Character offset where the cited passage begins in `text` |
| `end_index`   | Character offset where the cited passage ends in `text`   |

Because `start_index`/`end_index` index into the block's `text`, you can slice out the exact passage each source supports — no parsing or guesswork.

```python
for item in research.output:
    if item.type != "message":
        continue
    for block in item.content:
        if block.type != "output_text" or not block.annotations:
            continue
        print(f"{len(block.annotations)} citations\n")
        for ann in block.annotations:
            if ann.type == "url_citation":
                # Slice the exact passage this source backs.
                passage = block.text[ann.start_index : ann.end_index]
                print(f'  supports: "{passage}"')
                print(f"    {ann.title}")
                print(f"    {ann.url}\n")
```

## Render citations as footnotes {#render-citations-as-footnotes}

The character spans let you rebuild the answer with inline footnote markers and a numbered source list — the standard way to surface citations in a UI. Two details make it correct:

- **Insert markers back-to-front.** Adding a `[1]` marker shifts every later offset, so process annotations from the highest `end_index` down and earlier offsets stay valid.
- **De-duplicate by URL.** The model often cites one source for several passages; give each unique URL a single stable number.

```python
def render_with_footnotes(text, annotations):
    """Insert [n] markers at each cited span and append a numbered source list."""
    citations = [a for a in annotations if a.type == "url_citation"]

    # One stable number per unique URL, in order of first appearance.
    numbers, order, titles = {}, [], {}
    for a in citations:
        if a.url not in numbers:
            numbers[a.url] = len(order) + 1
            order.append(a.url)
            titles[a.url] = a.title

    # Insert markers from the end so earlier offsets stay valid.
    marked = text
    for a in sorted(citations, key=lambda a: a.end_index, reverse=True):
        marker = f"[{numbers[a.url]}]"
        marked = marked[: a.end_index] + marker + marked[a.end_index :]

    sources = "\n".join(f"  [{numbers[u]}] {titles[u]} — {u}" for u in order)
    return f"{marked}\n\nSources:\n{sources}"


text_block = next(
    block
    for item in research.output
    if item.type == "message"
    for block in item.content
    if block.type == "output_text"
)
print(render_with_footnotes(text_block.text, text_block.annotations))
```

## Don't assume a search ran {#don-t-assume-a-search-ran}

Enabling `web_search` lets the model *decide* whether to search — it weighs the query and may answer from its training data instead. Whether any given question triggers a search is not guaranteed, so a robust client never assumes one did: check for a `web_search_call` item, and drive your citation rendering off the annotations that are actually present. A `message` with no `url_citation` annotations is a valid, ungrounded answer.

```python
question = client.responses.create(
    model="muse-spark-1.3",
    input="What is the capital of France?",
    tools=[{"type": "web_search"}],
)

searched = any(item.type == "web_search_call" for item in question.output)
citations = [
    ann
    for item in question.output
    if item.type == "message"
    for block in item.content
    if block.type == "output_text"
    for ann in (block.annotations or [])
    if ann.type == "url_citation"
]
print("performed a search:", searched)
print("citations:", len(citations))
print(question.output_text)
```

## Tune how much the model reads {#tune-how-much-the-model-reads}

The optional `search_context_size` field on the tool controls how much search context the model receives. More context means more sources to cite and better answers, at the cost of latency and tokens.

| Value      | Behavior                                                    |
| ---------- | ----------------------------------------------------------- |
| `"low"`    | Minimal context. Fastest, lowest token usage.               |
| `"medium"` | Balanced. Good default for most queries.                    |
| `"high"`   | Maximum context. Best for complex, citation-heavy research. |

```python
deep = client.responses.create(
    model="muse-spark-1.3",
    input="Summarize recent breakthroughs in fusion energy and cite your sources.",
    tools=[{"type": "web_search", "search_context_size": "high"}],
)

citation_count = sum(
    1
    for item in deep.output
    if item.type == "message"
    for block in item.content
    if block.type == "output_text"
    for ann in (block.annotations or [])
    if ann.type == "url_citation"
)
print(f"citations: {citation_count}")
print("tokens:", deep.usage.total_tokens)
```

## Citations survive streaming {#citations-survive-streaming}

Streaming search-grounded responses with `client.responses.stream()` renders the answer as it generates, but the citations are only complete once the stream finishes. Read them off `stream.get_final_response()` — the annotations are identical to the non-streaming shape.

```python
with client.responses.stream(
    model="muse-spark-1.3",
    input="What are the latest developments in AI regulation?",
    tools=[{"type": "web_search"}],
) as stream:
    for event in stream:
        if event.type == "response.output_text.delta":
            print(event.delta, end="", flush=True)
    print()
    final = stream.get_final_response()

# Citations are on the final response, same url_citation shape as before.
for item in final.output:
    if item.type == "message":
        for block in item.content:
            if block.type == "output_text" and block.annotations:
                print("\nSources:")
                for ann in block.annotations:
                    if ann.type == "url_citation":
                        print(f"  - [{ann.title}]({ann.url})")
```

## Summary {#summary}

| Pattern          | How                                                             |
| ---------------- | --------------------------------------------------------------- |
| Enable search    | `tools=[{"type": "web_search"}]` on `client.responses.create()` |
| Read the answer  | `response.output_text`, or iterate `response.output` items      |
| Detect a search  | look for a `web_search_call` item in `response.output`          |
| Read citations   | `url_citation` annotations on each `output_text` block          |
| Map to text      | slice `block.text[ann.start_index:ann.end_index]`               |
| Render footnotes | insert markers back-to-front; de-duplicate by `url`             |
| Control depth    | `search_context_size`: `low` / `medium` / `high`                |
| Streaming        | read citations from `stream.get_final_response()`               |

## Next steps {#next-steps}

- Let the model call your own functions: recipe [03 — Tool calling](https://dev.meta.ai/docs/cookbook/tool-function-calling).
- Stream tokens as they generate: recipe [02 — Streaming responses](https://dev.meta.ai/docs/cookbook/streaming-responses).
- Constrain the grounded answer to a schema: recipe [04 — Structured output](https://dev.meta.ai/docs/cookbook/structured-output).
- Read the [search grounding guide](https://dev.meta.ai/docs/features/search-grounding) and the [Responses API reference](https://dev.meta.ai/docs/api-reference/responses).
