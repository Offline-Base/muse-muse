# Status {#status}

Report overall API status and per-model availability. This endpoint is unauthenticated: no API key is required. Check it for service disruptions before retrying failed requests; see [error handling](https://dev.meta.ai/docs/error-handling) for retry guidance.

## GET /status {#get-status}

Get API status.

### Response {#response}

`HTTP 200` — OK

#### Content Type: application/json {#content-type-applicationjson}

`StatusResponse`

**Python (requests)**

```python
import json
import os

import requests

response = requests.get(
    "https://api.meta.ai/v1/status",
    headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
```

**curl**

```shell
curl -X GET "https://api.meta.ai/v1/status" \
  -H "Authorization: Bearer $MODEL_API_KEY"
```
