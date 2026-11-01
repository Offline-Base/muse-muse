# Device smoke test: lfm_floors

Command: `uv run python -m scripts.device_smoke --name lfm_floors`

Date: 2026-10-31 11:53. Answer model: lfm3-vl-2b. Router mode: rules. Checker: lfm3-vl-2b. A copy of the invented demo class only, in a throwaway home.

## Toggles: none

| Step | Tool | Status | Seconds | Characters | Private values | Why it was kept |
|---|---|---|---|---|---|---|
| list the essays | list_documents | text | 1.3 | 2286 | none |  |
| search the rubric: start | search_documents | text | 4.7 | 857 | none |  |
| ask the device: start | ask_device | queued | 0.0 | 219 | none |  |
| ask the device: result | get_result | shared | 15.9 | 1992 | none |  |
| class average request: start | search_documents | text | 3.9 | 718 | none |  |
| who is this tag: start | search_documents | kept | 2.5 | 127 | none | Kept on your device. It mentions a topic you never share. Do not look for this another way. The user can open it on the device. |
| never-share topic: start | search_documents | kept | 1.8 | 290 | none | Kept on your device. It mentions a topic you never share.

Note: this request included a private detail, so Muse has already seen it. Use tags in requests, and turn off training under Data controls in your Muse settings. Do not look for this another way. The user can open it on the device. |
| raw name from Muse: start | search_documents | text | 2.1 | 1086 | none |  |
| grade 24 essays: start | run_private_task | queued | 0.0 | 235 | none |  |
| grade 24 essays: result | get_result | shared | 32.9 | 4136 | none |  |

- raw name warned: True
- image check: skipped, SAM_ENABLED is not 1
- grading seconds: 32.9
- grading status: shared
- feedback files: 24
- receipts: 8
- all device only: True

## Toggles: ferpa

| Step | Tool | Status | Seconds | Characters | Private values | Why it was kept |
|---|---|---|---|---|---|---|
| list the essays | list_documents | text | 1.2 | 2286 | none |  |
| search the rubric: start | search_documents | text | 4.6 | 864 | none |  |
| ask the device: start | ask_device | queued | 0.0 | 219 | none |  |
| ask the device: result | get_result | shared | 12.6 | 1547 | none |  |
| class average request: start | search_documents | text | 3.4 | 519 | none |  |
| who is this tag: start | search_documents | kept | 2.1 | 143 | none | Kept on your device. Your rules say results like this stay on the device. Do not look for this another way. The user can open it on the device. |
| never-share topic: start | search_documents | kept | 1.8 | 127 | none | Kept on your device. It mentions a topic you never share. Do not look for this another way. The user can open it on the device. |
| raw name from Muse: start | search_documents | waiting | 2.2 | 356 | none |  |
| raw name from Muse: result | get_result | shared | 1.0 | 2265 | none |  |
| grade 24 essays: start | run_private_task | running | 0.0 | 236 | none |  |
| grade 24 essays: result | get_result | refused | 32.8 | 259 | none | Kept on your device. It mentions a topic you never share. The full result is saved on the device in output/db0809a0b824442e. Do not look for this another way. The user can open it on the device. |

- raw name warned: True
- image check: skipped, SAM_ENABLED is not 1
- grading seconds: 32.8
- grading status: refused
- feedback files: 24
- receipts: 8
- all device only: True
