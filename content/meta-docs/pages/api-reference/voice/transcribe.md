# Transcribe a recording {#transcribe-a-recording}

Transcribe one complete audio recording in a single request.

Send `multipart/form-data` with two parts: `request`, the transcription settings as JSON, and `audio`, the clip. The `Accept` header selects between a buffered JSON body, a server-sent event stream, and plain text.

## POST /asr/transcribe {#post-asrtranscribe}

Transcribe a complete audio recording.

### Parameters {#parameters}

#### Query parameters {#query-parameters}

| Field       | Type   | Required | Description                                                                                                 |
| ----------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------- |
| `sessionId` | string | No       | Correlation id used in server-side logs and echoed in the response. When omitted, the server generates one. |

### Request body {#request-body}

#### Content Type: multipart/form-data {#content-type-multipartform-data}

`object`

### Response {#response}

`HTTP 200` — The transcript, in the shape selected by `Accept`. `application/json`, `*/*`, or an absent header returns the buffered body. `text/event-stream` returns the realtime event stream, which ends after the last event and appends no summary. `text/plain` returns one turn per line in `ENDPOINTING`, or lines of the form `A:Hello` in `DIARIZATION` (a turn the model never attributed renders as `unknown:<transcript>`).

#### Content Type: application/json {#content-type-applicationjson}

[`TranscribeResponse`](https://dev.meta.ai/docs/api-reference/voice/schemas#transcribe-response)

#### Content Type: text/event-stream {#content-type-textevent-stream}

[`ServerMessage`](https://dev.meta.ai/docs/api-reference/voice/schemas#server-message)

### Response {#response-1}

`HTTP 400` — The audio is not a supported WAV file, the audio exceeds 10 minutes, or the body is not `multipart/form-data`.

### Response {#response-2}

`HTTP 406` — The `Accept` header requested a media type this endpoint does not produce.

### Response {#response-3}

`HTTP 413` — The request body exceeds the maximum of 32 MB.

### Response {#response-4}

`HTTP 429` — The caller reached its concurrency or hourly session limit. Retry with exponential backoff.

### Response {#response-5}

`HTTP 500` — Transcription failed, or processing exceeded the server budget. Once an event stream has started there is no status left to set, so the failure arrives as a terminal `error` event on the open stream under `HTTP 200`.

**curl**

```shell
curl -X POST "https://api.meta.ai/v1/asr/transcribe" \
  -H "Authorization: Bearer $MODEL_API_KEY" \
  -H "Accept: application/json" \
  -F 'request={"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV","mode":"PUSH_TO_TALK"};type=application/json' \
  -F "audio=@recording.wav;type=audio/wav"
```

**Python (requests)**

```python
import json
import os

import requests

with open("recording.wav", "rb") as audio:
    response = requests.post(
        "https://api.meta.ai/v1/asr/transcribe",
        headers={
            "Authorization": f"Bearer {os.environ['MODEL_API_KEY']}",
            "Accept": "application/json",
        },
        files={
            "request": (
                None,
                json.dumps(
                    {
                        "model": "muse-voice-transcribe-1.0",
                        "audioEncoding": "WAV",
                        "mode": "PUSH_TO_TALK",
                    }
                ),
                "application/json",
            ),
            "audio": ("recording.wav", audio, "audio/wav"),
        },
    )
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
```

Errors carry an HTTP status and a client-safe message with a `type`, plus `code` and `param` when the failure has them. On `text/event-stream` the failure arrives instead as a terminal `error` event carrying the same taxonomy. Retain the session id: it is the only correlation handle for a support request.

For audio conversion, modes, and worked examples, see the [Speech to text](https://dev.meta.ai/docs/speech-to-text) feature page.
