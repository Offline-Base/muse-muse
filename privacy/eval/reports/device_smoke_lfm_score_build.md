# Device smoke test: lfm_score_build

Command: `uv run python -m scripts.device_smoke --name lfm_score_build`

Date: 2026-10-31 01:53. Answer model: lfm3-vl-2b. Router mode: rules. Checker: lfm3-vl-2b. A copy of the invented demo class only, in a throwaway home.

## Toggles: none

| Step | Tool | Status | Seconds | Characters | Private values | Why it was kept |
|---|---|---|---|---|---|---|
| list the essays | list_documents | text | 1.4 | 2286 | none |  |
| search the rubric: start | search_documents | text | 9.4 | 3602 | none |  |
| ask the device: start | ask_device | queued | 0.0 | 219 | none |  |
| ask the device: result | get_result | shared | 16.7 | 1527 | none |  |
| class average request: start | search_documents | text | 4.7 | 282 | none |  |
| who is this tag: start | search_documents | kept | 2.4 | 127 | none | Kept on your device. It mentions a topic you never share. Do not look for this another way. The user can open it on the device. |
| never-share topic: start | search_documents | kept | 3.2 | 290 | none | Kept on your device. It mentions a topic you never share.

Note: this request included a private detail, so Muse has already seen it. Use tags in requests, and turn off training under Data controls in your Muse settings. Do not look for this another way. The user can open it on the device. |
| raw name from Muse: start | search_documents | text | 2.6 | 962 | none |  |
| grade 24 essays: start | run_private_task | running | 0.0 | 236 | none |  |
| grade 24 essays: result | get_result | refused | 40.1 | 259 | none | Kept on your device. It mentions a topic you never share. The full result is saved on the device in output/4764f33680fb4716. Do not look for this another way. The user can open it on the device. |

- raw name warned: True
- image check: skipped, SAM_ENABLED is not 1
- grading seconds: 40.2
- grading status: refused
- feedback files: 24
- receipts: 8
- all device only: True

## Toggles: ferpa

| Step | Tool | Status | Seconds | Characters | Private values | Why it was kept |
|---|---|---|---|---|---|---|
| list the essays | list_documents | text | 1.6 | 2286 | none |  |
| search the rubric: start | search_documents | waiting | 9.3 | 191 | none |  |
| search the rubric: result | get_result | shared | 1.0 | 3721 | none |  |
| ask the device: start | ask_device | queued | 0.0 | 219 | none |  |
| ask the device: result | get_result | shared | 16.7 | 1450 | none |  |
| class average request: start | search_documents | kept | 3.3 | 175 | none | Kept on your device. It describes fewer than 10 people, and your privacy toggles keep that on the device. Do not look for this another way. The user can open it on the device. |
| who is this tag: start | search_documents | kept | 3.0 | 127 | none | Kept on your device. It mentions a topic you never share. Do not look for this another way. The user can open it on the device. |
| never-share topic: start | search_documents | kept | 3.3 | 127 | none | Kept on your device. It mentions a topic you never share. Do not look for this another way. The user can open it on the device. |
| raw name from Muse: start | search_documents | waiting | 3.3 | 356 | none |  |
| raw name from Muse: result | get_result | shared | 1.0 | 3814 | none |  |
| grade 24 essays: start | run_private_task | queued | 0.0 | 235 | none |  |
| grade 24 essays: result | get_result | shared | 41.2 | 4123 | none |  |

- raw name warned: True
- image check: skipped, SAM_ENABLED is not 1
- grading seconds: 41.2
- grading status: shared
- feedback files: 24
- receipts: 8
- all device only: True
