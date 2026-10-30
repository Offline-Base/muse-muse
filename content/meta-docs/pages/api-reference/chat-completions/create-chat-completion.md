# Create a chat completion {#create-a-chat-completion}

Generate a model response from a conversation supplied as a list of messages.

## POST /chat/completions {#post-chatcompletions}

Generate a chat completion.

### Request body {#request-body}

#### Content Type: application/json {#content-type-applicationjson}

[`CreateChatCompletionRequest`](https://dev.meta.ai/docs/api-reference/chat-completions/schemas#create-chat-completion-request)

### Response {#response}

`HTTP 200` — OK

#### Content Type: application/json {#content-type-applicationjson-1}

[`CreateChatCompletionResponse`](https://dev.meta.ai/docs/api-reference/chat-completions/schemas#create-chat-completion-response)

#### Content Type: text/event-stream {#content-type-textevent-stream}

[`CreateChatCompletionStreamResponse`](https://dev.meta.ai/docs/api-reference/chat-completions/schemas#create-chat-completion-stream-response)

**Python (OpenAI SDK)**

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)

response = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[
        {
            "role": "user",
            "content": "What are three differences between TCP and UDP?",
        },
    ],
)

print(response.model_dump_json(indent=2))
```

**Python (requests)**

```python
import json
import os

import requests

response = requests.post(
    "https://api.meta.ai/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {os.environ['MODEL_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={
        "model": "muse-spark-1.3",
        "messages": [
            {
                "role": "user",
                "content": "What are three differences between TCP and UDP?",
            },
        ],
    },
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
```

**curl**

```shell
curl -X POST "https://api.meta.ai/v1/chat/completions" \
  -H "Authorization: Bearer $MODEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "muse-spark-1.3",
  "messages": [
    {
      "role": "user",
      "content": "What are three differences between TCP and UDP?"
    }
  ]
}'
```

For usage examples, streaming, multi-turn conversations, and parameter guidance, see the [Chat completion](https://dev.meta.ai/docs/protocols/chat-completions) feature page.
