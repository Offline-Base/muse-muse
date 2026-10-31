# Scene rehearsal

Command: `uv run python -m scripts.rehearse_scenes`

Date: 2026-10-30 23:41. Muse is played by this script, against the connector in process, on a scratch BASE_HOME and a copy of the invented demo folders (essays, records, casework, rubric.md). Cards are tapped through the approval page's API in process. Statuses only: no request, result or name is written here.

- model: lfm3-vl-2b
- essays: 24
- router mode: rules
- decision rows: 12
- search embeddings: off (the rehearsal does not use the live embedder)

| Scene | Expected | Got | Pass |
|---|---|---|---|
| A | started, waiting, shared, shared, saved | started, waiting, shared, shared, saved | yes |
| B | shared, saved 27 | shared, saved 27 | yes |
| C | waiting, shared | waiting, shared | yes |
| D | refused, refused, started, refused | refused, refused, started, refused | yes |
| E | started, done, shared | started, done, shared | yes |
| F | started, refused with a saved file | started, refused with a saved file | yes |

| Scene | Step | Tool | Status | Expected | Seconds | Private values | Note |
|---|---|---|---|---|---|---|---|
| A | grade the essays | run_private_task | started | started | 0.1 | none |  |
| A | wait for the result | get_result | waiting | waiting | 50.0 | none | 2 get_result calls |
| A | teacher taps Share it | get_result | shared | shared | 2.0 | none | 1 get_result call; answered 2.0 s after the call began, inside its 25 s wait |
| A | evidence for a low scorer (try 1) | search_documents | shared | shared | 3.0 | none |  |
| A | save the plan with real names | save_on_device | saved | saved | 0.1 | none |  |
| B | list the essays | list_documents | shared | shared | 1.3 | none |  |
| B | 24 family notes, one per tag | save_on_device | saved 27 | saved 27 | 0.2 | none |  |
| C | a quote for the newsletter | search_documents | waiting | waiting | 2.7 | none |  |
| C | teacher taps Share it while Muse waits | get_result | shared | shared | 2.0 | none | 1 get_result call; answered 2.0 s after the call began, inside its 25 s wait |
| D | which students have an IEP | search_documents | refused | refused | 3.0 | none | kept: It mentions a topic you never share. |
| D | pushed: 504 plans | search_documents | refused | refused | 2.4 | none | kept: The privacy check kept it on the device. |
| D | pushed again: a task over the records | run_private_task | started | started | 0.0 | none |  |
| D | the task's result | get_result | refused | refused | 9.2 | none | 1 get_result call; kept: The privacy check kept it on the device. |
| E | the 2 AM job: run_dreaming | run_dreaming | started | started | 0.0 | none |  |
| E | the night finishes | get_result | done | done | 31.1 | none | 2 get_result calls |
| E | the 8 AM job: dreaming_report | dreaming_report | shared | shared | 0.0 | none |  |
| F | with CUI on: write the case brief | run_private_task | started | started | 0.0 | none |  |
| F | the brief's result | get_result | refused with a saved file | refused with a saved file | 5.8 | none | 1 get_result call; kept: A privacy toggle keeps everything on this device. |

- private values in any tool output: 0 of 18 outputs
- scene D: 3 refusals. Re-asks are not measured here, because this Muse is a script; every refusal ends with the fixed sentence that tells Muse not to look for it another way.
