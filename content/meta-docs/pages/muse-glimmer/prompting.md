# Prompting guide {#prompting-guide}

Get the most out of Muse Glimmer by using the correct chat template and following these prompting best practices. Small format details — special tokens, role headers, turn separators — have a measurable impact on output quality.

## Chat template {#chat-template}

Muse Glimmer uses a structured chat template with explicit role markers. Always apply it with the tokenizer's built-in `apply_chat_template` method — it inserts the special tokens and turn separators for you:

**Python**

```python
from transformers import AutoTokenizer

tokenizer = AutoTokenizer.from_pretrained("meta-models/Muse-Glimmer-30B")

messages = [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Explain speculative decoding in two sentences."},
]

prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
print(prompt)
```

The rendered prompt uses Muse Glimmer's role-tagged format. Each turn opens with `<|start|>`, names its role, opens the content with `<|message|>`, and ends with `<|eot|>` (end of turn):

**Rendered prompt**

```text
<|begin_of_text|><|start|>system<|message|>You are a helpful assistant.

Reasoning strength: high.

# Valid recipients: "self", "user".<|eot|><|start|>user<|message|>Explain speculative decoding in two sentences.<|eot|><|start|>assistant
```

> **NOTE: Always use apply\_chat\_template**
>
> Constructing the prompt string by hand is error-prone. Muse Glimmer's format has details — the system-metadata block, the reasoning-strength line, `<|eom|>` vs `<|eot|>` for consecutive same-role turns — that `apply_chat_template` handles for you.

## Special tokens {#special-tokens}

| Token                 | Purpose                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `<\|begin_of_text\|>` | Start of sequence (BOS)                                             |
| `<\|end_of_text\|>`   | End of sequence (EOS)                                               |
| `<\|start\|>`         | Opens a turn; followed by the role and optional `to=` recipient     |
| `<\|message\|>`       | Separates the role header from the message content                  |
| `<\|eot\|>`           | End of turn (the model stops here when replying to the user)        |
| `<\|eom\|>`           | End of message (turn continues — e.g. reasoning before a tool call) |
| `<\|image\|>`         | Image sentinel in multimodal content                                |

## Roles and recipients {#roles-and-recipients}

Muse Glimmer turns carry a **role** (`system`, `user`, `assistant`, `tool`) and, for assistant turns, an optional **recipient** set with `to=`:

- `to=user` — a normal reply to the user (the default; ends with `<|eot|>`).
- `to=self` — private reasoning the model writes to itself before answering (see [Reasoning](https://dev.meta.ai/docs/muse-glimmer/prompting#reasoning)).
- `to=<tool_name>` — a tool call directed at a named tool (see [Tool calling](https://dev.meta.ai/docs/muse-glimmer/prompting#tool-calling)).

The system turn declares which recipients are valid for the conversation, so you rarely set recipients by hand — the template derives them from your `messages` and `tools`.

## System prompts {#system-prompts}

A system prompt sets the model's behavior for the entire conversation. Place it as the first message with `role: "system"`. If you don't provide one, Muse Glimmer's template inserts a short default system turn (with a knowledge-cutoff line and the reasoning-strength setting).

### Effective system prompts {#effective-system-prompts}

- Be specific about the task. "You are a Python code reviewer" outperforms "You are a helpful assistant."
- State constraints upfront: output format, length limits, tone.
- Avoid meta-instructions about how the model works internally.

**Python**

````python
messages = [
    {
        "role": "system",
        "content": (
            "You are a senior Python engineer conducting code review. "
            "For each issue, state the line, the problem, and a fix. "
            "Respond in markdown with one H2 per issue."
        ),
    },
    {"role": "user", "content": "Review this function:\n\n```python\ndef fetch(url):\n    import requests\n    r = requests.get(url)\n    return r.json()\n```"},
]
````

## Reasoning and chain-of-thought {#reasoning}

Muse Glimmer is a reasoning model: before its final answer it writes a private chain of thought to itself in an `assistant to=self` turn, then emits the user-facing answer in a separate `assistant to=user` turn. You don't prompt this into existence — it's built into the format.

Control how much the model reasons with the `reasoning_strength` template argument (`xhigh`, `high`, `medium`, or `low`; defaults to `high`):

**Python**

```python
prompt = tokenizer.apply_chat_template(
    messages,
    tokenize=False,
    add_generation_prompt=True,
    reasoning_strength="medium",
)
```

To feed a prior reasoning trace back on a later turn, put it on the assistant message's `reasoning_content` field; the template renders it as the `to=self` turn.

> **NOTE: Reasoning traces can be long**
>
> Muse Glimmer routinely produces multi-thousand-token chains of thought, and its default context window is 128K tokens. The model supports longer contexts. When serving reasoning workloads, request streaming so long generations don't hit request timeouts. See [Run inference](https://dev.meta.ai/docs/muse-glimmer/deploy).

## Tool calling {#tool-calling}

Muse Glimmer calls tools using its native **ATEM** format. Pass your tool definitions to `apply_chat_template` via the `tools` argument (OpenAI-style function schemas) and the template renders the tool catalog into the system turn:

**Python**

```python
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather for a city.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }
]

prompt = tokenizer.apply_chat_template(
    messages, tokenize=False, add_generation_prompt=True, tools=tools
)
```

The model emits a call as an `assistant to=get_weather` turn whose body is an ATEM block:

**Tool call (model output)**

```text
<|start|>assistant to=get_weather<|message|><atem:function_calls>
<atem:invoke name="get_weather">
<atem:parameter name="city">Tokyo</atem:parameter>
</atem:invoke>
</atem:function_calls><|eot|>
```

Return the result as a `tool` message; the template wraps it in a `<tool_output>` block on a `tool` turn so the model can read it and continue.

Muse Glimmer supports one tool call per turn. It does not support parallel tool calls; return each tool result before asking the model to select the next tool.

> **NOTE: Servers expose standard tool\_calls**
>
> If you serve Muse Glimmer behind an OpenAI-compatible server (vLLM or llama.cpp), the server parses ATEM and exposes standard `tool_calls` in the JSON response — you work with the usual OpenAI tool-calling shape and never touch ATEM directly.

## Multimodal input {#multimodal-input}

Muse Glimmer reads images. Provide content as a list of parts; use the `AutoProcessor` (not the bare tokenizer) so images are preprocessed:

**Python**

```python
from transformers import AutoProcessor

processor = AutoProcessor.from_pretrained("meta-models/Muse-Glimmer-30B")

messages = [
    {
        "role": "user",
        "content": [
            {"type": "image", "url": "https://example.com/chart.png"},
            {"type": "text", "text": "What trend does this chart show?"},
        ],
    }
]

inputs = processor.apply_chat_template(
    messages, add_generation_prompt=True, tokenize=True, return_tensors="pt"
)
```

The template inserts an `<|image|>` sentinel where each media part appears, and the processor expands it into the vision tokens the model consumes.

## Multi-turn conversations {#multi-turn-conversations}

Muse Glimmer maintains context across turns. Append each assistant response and new user message to the same `messages` list:

**Python**

```python
messages = [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "What is the capital of France?"},
    {"role": "assistant", "content": "The capital of France is Paris."},
    {"role": "user", "content": "What is its population?"},
]
```

The full conversation, including any reasoning you replay via `reasoning_content`, must fit within the configured context window. Muse Glimmer's default context window is 128K tokens, and the model supports longer contexts. For long agentic loops, prune or summarize old turns before you hit the configured limit.

## Temperature and sampling {#temperature-and-sampling}

Use the model-card recommended sampling configuration:

**Python**

```python
generation_config = {
    "temperature": 1.0,
    "top_p": 0.95,
    "top_k": 64,
}
```

## Common pitfalls {#common-pitfalls}

- **Wrong chat template**: manually formatting the prompt without `apply_chat_template` leads to degraded output quality. Muse Glimmer was trained with specific special tokens (`<|start|>`, `<|message|>`, `<|eot|>`); skipping them confuses turn boundaries.
- **Bare tokenizer for images**: pass multimodal content through `AutoProcessor`, not `AutoTokenizer` — the tokenizer alone won't preprocess images.
- **Missing generation prompt**: set `add_generation_prompt=True` when calling `apply_chat_template` for inference. Without it, the model doesn't receive the cue to start generating.
- **Truncating reasoning**: cutting `max_tokens` too low clips the model mid-reasoning before it reaches the final answer. Give reasoning workloads generous headroom.

## Next steps {#next-steps}

With your prompts tuned, [run inference](https://dev.meta.ai/docs/muse-glimmer/deploy) with vLLM, SGLang, llama.cpp, Ollama, or another runtime. For smaller hardware, see [quantization](https://dev.meta.ai/docs/muse-glimmer/quantization) to reduce memory requirements, or [post-train](https://dev.meta.ai/docs/muse-glimmer/post-training) Muse Glimmer for your domain.
