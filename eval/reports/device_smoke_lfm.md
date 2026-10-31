# Device smoke test: lfm

Command: `uv run python -m scripts.device_smoke --name lfm`

Date: 2026-10-30 15:41. Answer model: lfm3-vl-2b. Router mode: rules. Checker: lfm3-vl-2b. A copy of the invented demo class only, in a throwaway home.

## Toggles: none

| Step | Tool | Status | Seconds | Characters | Private values | Why it was kept |
|---|---|---|---|---|---|---|
| list the essays | list_documents | text | 1.3 | 2286 | none |  |
| search the rubric: start | search_documents | text | 7.7 | 3680 | none |  |
| ask the device: start | ask_device | queued | 0.0 | 179 | none |  |
| ask the device: result | get_result | shared | 18.6 | 1104 | none |  |
| class average request: start | search_documents | text | 3.6 | 359 | none |  |
| who is this tag: start | search_documents | kept | 2.3 | 57 | none | Kept on your device. It mentions a topic you never share. |
| never-share topic: start | search_documents | kept | 2.4 | 220 | none | Kept on your device. It mentions a topic you never share.

Note: this request included a private detail, so Muse has already seen it. Use tags in requests, and turn off training under Data controls in your Muse settings. |
| raw name from Muse: start | search_documents | text | 2.4 | 3108 | none |  |
| grade 24 essays: start | run_private_task | queued | 0.0 | 50 | none |  |
| grade 24 essays: result | get_result | shared | 35.1 | 4060 | none |  |

- raw name warned: True
- grading seconds: 35.2
- grading status: shared
- feedback files: 24
- receipts: 8
- all device only: True

## Toggles: ferpa

| Step | Tool | Status | Seconds | Characters | Private values | Why it was kept |
|---|---|---|---|---|---|---|
| list the essays | list_documents | text | 1.2 | 2286 | none |  |
| search the rubric: start | search_documents | text | 8.2 | 3712 | none |  |
| ask the device: start | ask_device | queued | 0.0 | 179 | none |  |
| ask the device: result | get_result | shared | 16.6 | 1528 | none |  |
| class average request: start | search_documents | kept | 2.8 | 105 | none | Kept on your device. It describes fewer than 10 people, and your privacy toggles keep that on the device. |
| who is this tag: start | search_documents | kept | 2.4 | 73 | none | Kept on your device. Your rules say results like this stay on the device. |
| never-share topic: start | search_documents | kept | 2.5 | 57 | none | Kept on your device. It mentions a topic you never share. |
| raw name from Muse: start | search_documents | text | 2.7 | 3720 | none |  |
| grade 24 essays: start | run_private_task | running | 0.0 | 51 | none |  |
| grade 24 essays: result | get_result | refused | 34.9 | 122 | none | Kept on your device. It mentions a topic you never share. |

- raw name warned: True
- grading seconds: 34.9
- grading status: refused
- feedback files: 24
- receipts: 8
- all device only: True
