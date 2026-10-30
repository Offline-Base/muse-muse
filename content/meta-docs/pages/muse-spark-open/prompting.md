# Prompting guide {#prompting-guide}

Write requests that get the most out of Muse Spark Open: how a conversation is structured, how to write a system prompt, how to set reasoning strength, how to call tools, and how to send images, video, and audio.

Most requests go to an OpenAI-compatible server: SGLang or vLLM started with the `muse` reasoning and tool-call parsers, or a hosted provider. The server applies the model's chat template, returns the reasoning separately from the answer, and turns tool calls into standard `tool_calls`. Each section below starts with the request. Where it helps, it then shows what the chat template renders, which is what the model sees. You need the rendered form only if you render prompts yourself with `apply_chat_template` or debug a server.

## Structure a conversation {#chat}

Send a conversation as a list of messages with the roles `system`, `user`, `assistant`, and `tool`. The first message can be a `system` (or `developer`) message with your system prompt:

**JSON**

```json
{
  "model": "meta-models/Muse-Spark-Open-816B-A42B",
  "messages": [
    {"role": "system", "content": "You are a code reviewer. Flag correctness bugs before style issues."},
    {"role": "user", "content": "Review this function for off-by-one errors: ..."}
  ]
}
```

Your system prompt doesn't replace the template's own system block; the template adds it to that block. The rendered system message contains, in this order:

1. The default lines: `You are a helpful AI assistant.`, the knowledge cutoff (2026-01-04), and the current date
2. Your system prompt, if you send one
3. The tool definitions, if you pass `tools`
4. The reasoning strength, unless your system prompt sets one
5. The list of recipients the model can address its messages to

The current date defaults to today's date. To set it, pass `current_date` in `chat_template_kwargs`.

### What the model sees {#chat-rendered}

**Text**

```plaintext
<|begin_of_text|><|start|>system<|message|>You are a helpful AI assistant.

Knowledge cutoff: 2026-01-04.

Current date: 2026-10-15.

You are a code reviewer. Flag correctness bugs before style issues.

Reasoning strength: 512.

Use the appropriate recipient for each message:
...<|eot|><|start|>user<|message|>Review this function for off-by-one errors: ...<|eot|>
```

Every message starts with `<|start|>` and the role, and its content follows `<|message|>`. The model addresses each of its own messages to a recipient: `self` for reasoning, `commentary` for updates shown while it keeps working, a tool name for a tool call, and `user` for the final answer.

## Write a system prompt {#system-prompts}

Muse Spark Open pays more attention to the beginning of the system prompt, so put the rules that must always hold first. A structure that works well:

**Text**

```plaintext
You are [specific role].

## Objective
Produce [precise user-visible outcome].

## Priority rules
1. [Highest-severity invariant]
2. [Second priority]
3. [Tie-breaker]

## Scope check
Before detailed analysis, determine if in scope. If out of scope, return [exact behavior].

## Decision procedure
1. Identify [signals].
2. Apply rules in priority order.
3. Resolve ambiguity via [explicit criterion].
4. Do not infer [unsupported info].

## Tools
Use native tool calls. Use [tool] when [condition]. Do not invent results.

## Output
Return exactly: {"decision":"...","confidence":0.0,"evidence":["..."],"explanation":"..."}

## Completion
Stop when all fields supported. If evidence unavailable, return [explicit unknown].
```

You don't need to describe your tools in the system prompt. Pass them in `tools`, and the template adds their definitions; see [Call tools](https://dev.meta.ai/docs/muse-spark-open/prompting#tool-calling).

## Control reasoning {#reasoning}

Muse Spark Open always reasons before it answers. Set how much with `reasoning_effort` on the request:

**JSON**

```json
{
  "model": "meta-models/Muse-Spark-Open-816B-A42B",
  "messages": [
    {"role": "user", "content": "Find the race condition in this worker-pool design."}
  ],
  "reasoning_effort": "high"
}
```

| `reasoning_effort` | Reasoning strength |
| ------------------ | ------------------ |
| `low`              | 8                  |
| `medium`           | 32                 |
| `high`             | 256                |
| `xhigh` (default)  | 512                |

Reasoning can't be turned off. Any value other than these four, such as `none` or `max`, is rejected. [Recommended settings](https://dev.meta.ai/docs/muse-spark-open/settings#reasoning-strength) covers which strength to use for which task.

A server started with the `muse` reasoning parser returns the reasoning in its own field, separate from the answer in `content`. Higher strengths produce long reasoning, so request streaming (`stream: true`) to avoid timeouts.

To fix the strength for every request instead, set it in the system prompt with the number, not the level name, for example `Reasoning strength: 256.` A `Reasoning strength` line in the system prompt takes precedence over `reasoning_effort`.

## Call tools {#tool-calling}

Pass your tools in `tools`, in the OpenAI function-calling format. When the model wants a tool, the response has `tool_calls` instead of an answer. Run each call, add the result as a `tool` message with the call's `id` as `tool_call_id`, and send the conversation again. Repeat until the response has no `tool_calls`; its `content` is the answer.

This script runs that loop against a local [SGLang](https://dev.meta.ai/docs/muse-spark-open/deploy#sglang) or [vLLM](https://dev.meta.ai/docs/muse-spark-open/deploy#vllm) server. It uses SGLang's port, 30000; for vLLM, change it to 8000.

**Python**

```python
import json

from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:30000/v1", api_key="null")  # a local server doesn't check the key
MODEL = client.models.list().data[0].id  # the model the server is serving


def get_weather(city):
    return {"Paris": "sunny", "Rome": "rain", "Tokyo": "cloudy"}.get(city, "unknown")


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

messages = [{"role": "user", "content": "What's the weather in Paris, Rome, and Tokyo?"}]

while True:
    message = client.chat.completions.create(model=MODEL, messages=messages, tools=tools).choices[0].message
    if not message.tool_calls:
        print(message.content)
        break
    messages.append(message)
    for call in message.tool_calls:
        args = json.loads(call.function.arguments)
        messages.append({"role": "tool", "tool_call_id": call.id, "content": get_weather(**args)})
```

### Parallel tool calls {#parallel-tool-calls}

The model can ask for several tools in one response, as it does here with one `get_weather` call per city. Answer every call with its own `tool` message before you send the next request, as the loop does.

### What the model sees {#tool-calling-rendered}

You only need this if you render prompts yourself with `apply_chat_template`.

The template lists your `tools` in the system message. When the model calls a tool, it writes the call in ATEM format, and the template wraps each result in `<tool_output>`. The three calls from the script above and their results render as:

**Text**

```plaintext
<|start|>assistant to=get_weather<|message|><atem:function_calls>
<atem:invoke name="get_weather">
<atem:parameter name="city">Paris</atem:parameter>
</atem:invoke>
</atem:function_calls><|eom|><|start|>assistant to=get_weather<|message|><atem:function_calls>
<atem:invoke name="get_weather">
<atem:parameter name="city">Rome</atem:parameter>
</atem:invoke>
</atem:function_calls><|eom|><|start|>assistant to=get_weather<|message|><atem:function_calls>
<atem:invoke name="get_weather">
<atem:parameter name="city">Tokyo</atem:parameter>
</atem:invoke>
</atem:function_calls><|eot|><|start|>tool get_weather<|message|><tool_output name="get_weather">
sunny
</tool_output><|eot|><|start|>tool get_weather<|message|><tool_output name="get_weather">
cloudy
</tool_output><|eot|><|start|>tool get_weather<|message|><tool_output name="get_weather">
rainy
</tool_output><|eot|>
```

Each call but the last in a turn ends with `<|eom|>`, and the last ends with `<|eot|>`. If you set stop tokens yourself, never stop on `<|eom|>`; see [Stop tokens](https://dev.meta.ai/docs/muse-spark-open/settings#stop-tokens).

The `tool_call_id` is not rendered into the prompt. The template uses it to find the matching call and writes that call's function name into the result's header. A result carries only the function name, so when several calls use the same tool, send the results in the order of the calls, as the script does.

Pass each call's `arguments` to `apply_chat_template` as a dictionary, not a JSON string. Parse the string with `json.loads` first.

## Send images, video, and audio {#multimodal}

Pass media as typed content parts in a `user` message, alongside text:

**JSON**

```json
{
  "role": "user",
  "content": [
    {"type": "image_url", "image_url": {"url": "https://example.com/chart.png"}},
    {"type": "video_url", "video_url": {"url": "https://example.com/demo.mp4"}},
    {"type": "audio_url", "audio_url": {"url": "https://example.com/question.wav"}},
    {"type": "text", "text": "Answer the question in the recording."}
  ]
}
```

The model sees the parts in the order you send them, so put each piece of media where it belongs relative to the text that refers to it.

For video, use clips longer than a few seconds at 448 px or more on the short side. On very short or low-resolution clips, such as a few seconds at around 100 px, the model can reply that it can't view the video.

### What the model sees {#multimodal-rendered}

The template writes a placeholder for each media part, `<|patch|>` for an image, `<|video|>` for a video, and `<|audio|>` for audio, and the multimodal processor replaces each one with that media's tokens:

**Text**

```plaintext
<|start|>user<|message|><|patch|><|video|><|audio|>Answer the question in the recording.<|eot|>
```

## Next steps {#next-steps}

Serve the model with a runtime from [Run inference](https://dev.meta.ai/docs/muse-spark-open/deploy), then tune sampling, context length, and parallelism with the [recommended settings](https://dev.meta.ai/docs/muse-spark-open/settings).
