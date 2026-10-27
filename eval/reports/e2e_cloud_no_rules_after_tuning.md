# End to end on the cloud backend

Command: `RUN_INTEGRATION=1 uv run pytest -q -s tests/test_e2e.py::test_e2e_cloud_grading_no_rules`

Date: 2026-10-27 03:45. Device setting: laptop. Backend: openrouter (Glimmer `meta/muse-glimmer-30b` for answers and routing). Workspace: the invented demo folder (marked `.synthetic`). A fresh temporary BASE_HOME with no learned router rules (a first day).

What ran: a simulated Muse called list_documents on `essays`, then run_private_task with "Grade each essay against rubric.md and write feedback for each student.", then get_result until the job finished. The router asked, so the test approved it on the approval page API (POST /api/approvals/<id>) and called get_result again. Every tool output was checked for roster names, nicknames, other_names values and identifiers from eval/tasks.jsonl, plus guard.leaks.

## Result

| Measure | Value |
|---|---|
| Time from run_private_task to the result Muse read | 38.3 s |
| Time for the job itself (24 essays graded, files written, result released) | 38.2 s |
| First get_result after the job | waiting |
| Router decision | ask_user (model) |
| Approved on the page | yes |
| Final status Muse saw | shared |
| Feedback files with real names | 24, all under BASE_HOME/output/<job id>/ |
| Leaks found in tool outputs | 0 |
| Glimmer calls | 26 |
| Tokens (prompt / completion / of which reasoning) | 31581 / 13590 / 9089 |

## Steps and the model that did each

| Step | Calls | Client role | Model | Backend | Device | Latency |
|---|---|---|---|---|---|---|
| Grade one essay | 24 | answer | meta/muse-glimmer-30b | openrouter | laptop | 5.4 s mean, 5.3 s median, 6.9 s max |
| Second pass for names | 1 | answer | meta/muse-glimmer-30b | openrouter | laptop | 2.1 s mean, 2.1 s median, 2.1 s max |
| Privacy router | 1 | router | meta/muse-glimmer-30b | openrouter | laptop | 1.7 s mean, 1.7 s median, 1.7 s max |

The agent's own step log (jobs.model_log) agrees: 24 grading steps, via ['local'], model ['meta/muse-glimmer-30b'], step latency 5.4 s mean, 5.3 s median, 6.9 s max.
Up to 4 grading steps run at once on the cloud backend.

## Timeline

| Point | Seconds after the call |
|---|---|
| list_documents | 0.0 |
| get_result after the job: waiting | 38.2 |
| approved on the page API, then get_result | 38.3 |

## Leaks

None.

Only the invented demo data was sent to OpenRouter. On the shipping backend (llama_server) the same calls go to Glimmer on the device.
