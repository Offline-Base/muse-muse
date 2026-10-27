# End to end on the cloud backend

Command: `RUN_INTEGRATION=1 uv run pytest -q -s tests/test_e2e.py::test_e2e_cloud_grading_no_rules`

Date: 2026-10-27 02:33. Device setting: laptop. Backend: openrouter (Glimmer `meta/muse-glimmer-30b` for answers and routing). Workspace: the invented demo folder (marked `.synthetic`). A fresh temporary BASE_HOME with no learned router rules (a first day).

What ran: a simulated Muse called list_documents on `essays`, then run_private_task with "Grade each essay against rubric.md and write feedback for each student.", then get_result until the job finished. The router did not ask, so there was nothing to approve. Every tool output was checked for roster names, nicknames, other_names values and identifiers from eval/tasks.jsonl, plus guard.leaks.

## Result

| Measure | Value |
|---|---|
| Time from run_private_task to the result Muse read | 35.7 s |
| Time for the job itself (24 essays graded, files written, result released) | 35.7 s |
| First get_result after the job | shared |
| Router decision | share_tagged (model) |
| Approved on the page | no, not asked |
| Final status Muse saw | shared |
| Feedback files with real names | 24, all under BASE_HOME/output/<job id>/ |
| Leaks found in tool outputs | 0 |
| Glimmer calls | 26 |
| Tokens (prompt / completion / of which reasoning) | 31401 / 14287 / 9670 |

## Steps and the model that did each

| Step | Calls | Client role | Model | Backend | Device | Latency |
|---|---|---|---|---|---|---|
| Grade one essay | 24 | answer | meta/muse-glimmer-30b | openrouter | laptop | 4.8 s mean, 4.6 s median, 6.6 s max |
| Second pass for names | 1 | answer | meta/muse-glimmer-30b | openrouter | laptop | 1.9 s mean, 1.9 s median, 1.9 s max |
| Privacy router | 1 | router | meta/muse-glimmer-30b | openrouter | laptop | 3.5 s mean, 3.5 s median, 3.5 s max |

The agent's own step log (jobs.model_log) agrees: 24 grading steps, via ['local'], model ['meta/muse-glimmer-30b'], step latency 4.8 s mean, 4.6 s median, 6.6 s max.
Up to 4 grading steps run at once on the cloud backend.

## Timeline

| Point | Seconds after the call |
|---|---|
| list_documents | 0.0 |
| get_result after the job: shared | 35.7 |

## Leaks

None.

Only the invented demo data was sent to OpenRouter. On the shipping backend (llama_server) the same calls go to Glimmer on the device.
