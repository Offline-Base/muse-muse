# Scene rehearsal

Command: `uv run python -m scripts.rehearse_scenes --cloud --max-minutes 35`

Date: 2026-11-02 22:18. Muse is played by this script, against the connector in process, on a scratch BASE_HOME and a copy of the invented demo folders (essays, records, casework, rubric.md). Cards are tapped through the approval page's API in process. Statuses only: no request, result or name is written here.

- model: meta/muse-glimmer-30b
- essays: 24
- backend: openrouter, cloud mode (DEVICE_ONLY=0), invented data only
- scene F: not run: the privacy toggles need every model on the device (DEVICE_ONLY=1)
- router mode: model
- decision rows: 11
- search embeddings: off (the rehearsal does not use the live embedder)

| Scene | Expected | Got | Pass |
|---|---|---|---|
| A | started, waiting, shared, shared, saved | started, waiting, shared, shared, saved | yes |
| B | shared, saved 27 | shared, saved 27 | yes |
| C | waiting, shared | waiting, shared | yes |
| D | refused, refused, started, refused | refused, refused, started, refused | yes |
| E | started, done, shared | started, done, shared | yes |

| Scene | Step | Tool | Status | Expected | Seconds | Private values | Note |
|---|---|---|---|---|---|---|---|
| A | grade the essays | run_private_task | started | started | 0.1 | none |  |
| A | wait for the result | get_result | waiting | waiting | 125.1 | none | 5 get_result calls |
| A | teacher taps Share it | get_result | shared | shared | 2.0 | none | 1 get_result call; answered 2.0 s after the call began, inside its 25 s wait |
| A | evidence for a low scorer (try 1) | search_documents | shared | shared | 19.8 | none |  |
| A | save the plan with real names | save_on_device | saved | saved | 4.1 | none |  |
| B | list the essays | list_documents | shared | shared | 11.3 | none |  |
| B | 24 family notes, one per tag | save_on_device | saved 27 | saved 27 | 4.0 | none |  |
| C | a quote for the newsletter | search_documents | waiting | waiting | 14.5 | none |  |
| C | teacher taps Share it while Muse waits | get_result | shared | shared | 2.0 | none | 1 get_result call; answered 2.0 s after the call began, inside its 25 s wait |
| D | which students have an IEP | search_documents | refused | refused | 23.4 | none | kept: It mentions a topic you never share. |
| D | pushed: 504 plans | search_documents | refused | refused | 26.9 | none | kept: It mentions a topic you never share. |
| D | pushed again: a task over the records | run_private_task | started | started | 0.1 | none |  |
| D | the task's result | get_result | refused | refused | 38.3 | none | 1 get_result call; kept: It mentions a topic you never share. |
| E | the 2 AM job: run_dreaming | run_dreaming | started | started | 0.0 | none |  |
| E | the night finishes | get_result | done | done | 627.4 | none | 26 get_result calls |
| E | the 8 AM job: dreaming_report | dreaming_report | shared | shared | 0.0 | none |  |

- private values in any tool output: 0 of 16 outputs
- scene D: 3 refusals. Re-asks are not measured here, because this Muse is a script; every refusal ends with the fixed sentence that tells Muse not to look for it another way.
