# Retrieve a response {#retrieve-a-response}

Retrieve a previously created response by its ID.

## GET /responses/{response\_id} {#get-responsesresponse_id}

Retrieve a stored model response by ID.

### Parameters {#parameters}

#### Path parameters {#path-parameters}

| Field         | Type   | Required | Description                         |
| ------------- | ------ | -------- | ----------------------------------- |
| `response_id` | string | Yes      | The ID of the response to retrieve. |

#### Query parameters {#query-parameters}

| Field            | Type    | Required | Description                                                                                                                                                                                                    |
| ---------------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stream`         | boolean | No       | If set to true, the response is streamed back as server-sent events as its events become available, terminated by a `data: [DONE]` sentinel. Streaming is only available for in-progress background responses. |
| `starting_after` | integer | No       | When streaming, only events with a sequence number greater than this value are sent (used to resume a stream). Defaults to streaming from the first event.                                                     |

### Response {#response}

`HTTP 200` — OK

#### Content Type: application/json {#content-type-applicationjson}

[`Response`](https://dev.meta.ai/docs/api-reference/responses/schemas#response)

#### Content Type: text/event-stream {#content-type-textevent-stream}

[`ResponseStreamEvent`](https://dev.meta.ai/docs/api-reference/responses/schemas#response-stream-event)

**Python (OpenAI SDK)**

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)

response = client.responses.retrieve("resp_abc123")

print(response.model_dump_json(indent=2))
```

**Python (requests)**

```python
import json
import os

import requests

response = requests.get(
    "https://api.meta.ai/v1/responses/resp_abc123",
    headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
```

**curl**

```shell
curl -X GET "https://api.meta.ai/v1/responses/resp_abc123" \
  -H "Authorization: Bearer $MODEL_API_KEY"
```

For usage examples and `previous_response_id` patterns, see the [Responses](https://dev.meta.ai/docs/protocols/responses) feature page.
