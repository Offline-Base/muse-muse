# Device smoke test: lfm_loosen_default

Command: `uv run python -m scripts.device_smoke --name lfm_loosen_default`

Date: 2026-10-31 02:42. Answer model: lfm3-vl-2b. Router mode: rules. Checker: lfm3-vl-2b. A copy of the invented demo class only, in a throwaway home.

## Toggles: none

| Step | Tool | Status | Seconds | Characters | Private values | Why it was kept |
|---|---|---|---|---|---|---|
| list the essays | list_documents | text | 1.3 | 2286 | none |  |
| search the rubric: start | search_documents | text | 8.4 | 3705 | none |  |
| ask the device: start | ask_device | queued | 0.0 | 219 | none |  |
| ask the device: result | get_result | shared | 16.7 | 1425 | none |  |
| class average request: start | search_documents | text | 4.2 | 451 | none |  |
| who is this tag: start | search_documents | kept | 2.8 | 127 | none | Kept on your device. It mentions a topic you never share. Do not look for this another way. The user can open it on the device. |
| never-share topic: start | search_documents | kept | 3.0 | 290 | none | Kept on your device. It mentions a topic you never share.

Note: this request included a private detail, so Muse has already seen it. Use tags in requests, and turn off training under Data controls in your Muse settings. Do not look for this another way. The user can open it on the device. |
| raw name from Muse: start | search_documents | text | 2.9 | 3207 | none |  |
| grade 24 essays: start | run_private_task | running | 0.0 | 236 | none |  |
| grade 24 essays: result | get_result | shared | 41.1 | 4226 | none |  |

- raw name warned: True
- image check: skipped, SAM_ENABLED is not 1
- grading seconds: 41.1
- grading status: shared
- feedback files: 24
- receipts: 8
- all device only: True

## Toggles: ferpa

| Step | Tool | Status | Seconds | Characters | Private values | Why it was kept |
|---|---|---|---|---|---|---|
| list the essays | list_documents | text | 1.4 | 2286 | none |  |
| search the rubric: start | search_documents | waiting | 8.6 | 191 | none |  |
| search the rubric: result | get_result | shared | 1.0 | 3639 | none |  |
| ask the device: start | ask_device | queued | 0.0 | 219 | none |  |
| ask the device: result | get_result | shared | 17.6 | 1293 | none |  |
| class average request: start | search_documents | kept | 3.1 | 175 | none | Kept on your device. It describes fewer than 10 people, and your privacy toggles keep that on the device. Do not look for this another way. The user can open it on the device. |
| who is this tag: start | search_documents | kept | 2.9 | 127 | none | Kept on your device. It mentions a topic you never share. Do not look for this another way. The user can open it on the device. |
| never-share topic: start | search_documents | kept | 2.5 | 127 | none | Kept on your device. It mentions a topic you never share. Do not look for this another way. The user can open it on the device. |
| raw name from Muse: start | search_documents | waiting | 2.8 | 356 | none |  |
| raw name from Muse: result | get_result | shared | 1.0 | 3000 | none |  |
| grade 24 essays: start | run_private_task | running | 0.0 | 236 | none |  |
| grade 24 essays: result | get_result | shared | 35.9 | 4105 | none |  |

- raw name warned: True
- image check: skipped, SAM_ENABLED is not 1
- grading seconds: 35.9
- grading status: shared
- feedback files: 24
- receipts: 8
- all device only: True
