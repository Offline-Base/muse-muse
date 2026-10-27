# End to end on the cloud backend

Command: `RUN_INTEGRATION=1 uv run pytest -q -s tests/test_e2e.py::test_e2e_cloud_grading_no_rules`

Date: 2026-10-27 09:16. Device setting: laptop. Backend: openrouter (Glimmer `meta/muse-glimmer-30b` for answers and routing). Workspace: the invented demo folder (marked `.synthetic`). A fresh temporary BASE_HOME with no learned router rules (a first day).

What ran: a simulated Muse called list_documents on `essays`, then run_private_task with "Grade each essay against rubric.md and write feedback for each student.", then get_result until the job finished. The router asked, so the test approved it on the approval page API (POST /api/approvals/<id>) and called get_result again. Every tool output was checked for roster names, nicknames, other_names values and identifiers from eval/tasks.jsonl, plus guard.leaks.

## Result

| Measure | Value |
|---|---|
| Time from run_private_task to the result Muse read (includes the 2 s get_result poll) | 33.4 s |
| Time for the job itself, jobs.created_at to finished_at (24 essays graded, files written) | 26.0 s |
| First get_result after the job | waiting |
| Router decision | ask_user (model) |
| Approved on the page | yes |
| Final status Muse saw | shared |
| Feedback files with real names | 24, all under BASE_HOME/output/<job id>/ |
| Leaks found in tool outputs | 0 |
| Glimmer calls | 28 |
| Tokens (prompt / completion / of which reasoning) | 32681 / 14740 / 9971 |

## Steps and the model that did each

| Step | Calls | Client role | Model | Backend | Device | Latency |
|---|---|---|---|---|---|---|
| Grade one essay | 24 | answer | meta/muse-glimmer-30b | openrouter | laptop | 4.2 s mean, 4.1 s median, 5.5 s max |
| Second pass for names | 2 | answer | meta/muse-glimmer-30b | openrouter | laptop | 3.0 s mean, 4.3 s median, 4.3 s max |
| Privacy router | 1 | router | meta/muse-glimmer-30b | openrouter | laptop | 1.1 s mean, 1.1 s median, 1.1 s max |
| Request topics | 1 | answer | meta/muse-glimmer-30b | openrouter | laptop | 1.6 s mean, 1.6 s median, 1.6 s max |

The agent's own step log (jobs.model_log) agrees: 24 grading steps, via ['local'], model ['meta/muse-glimmer-30b'], step latency 4.2 s mean, 4.1 s median, 5.5 s max.
Up to 4 grading steps run at once on the cloud backend.

## Timeline

| Point | Seconds after the call |
|---|---|
| list_documents | 1.7 |
| get_result after the job: waiting | 33.3 |
| approved on the page API, then get_result | 33.4 |

## Leaks

None.

Only the invented demo data was sent to OpenRouter. On the shipping backend (llama_server) the same calls go to Glimmer on the device.
Raw rows: raw/e2e_cloud_no_rules.jsonl next to this report (call kinds, models, latencies, tokens and job times; no text).

## Cost

OpenRouter spend, from the API key's total usage read just before and just after the run (anything else billed to the key in that window would count too): $0.0317 for one pytest command that ran this test and test_e2e_cloud_grading together (67.5 s).
