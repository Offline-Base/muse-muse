# End to end on the cloud backend

Command: `RUN_INTEGRATION=1 uv run pytest -q -s tests/test_e2e.py::test_e2e_cloud_grading`

Date: 2026-10-27 11:48. Device setting: laptop. Backend: openrouter (Glimmer `meta/muse-glimmer-30b` for answers and routing). Workspace: the invented demo folder (marked `.synthetic`). A fresh temporary BASE_HOME with one learned router rule, as a dreaming night writes it after the teacher asked three times to keep seeing per-student grades: `- Per-student results (kind: per_student; topics: grades, writing): ask first. You wanted to be asked 3 of 3 times, so keep asking.`

What ran: a simulated Muse called list_documents on `essays`, then run_private_task with "Grade each essay against rubric.md and write feedback for each student.", then get_result until the job finished. The router asked, so the test approved it on the approval page API (POST /api/approvals/<id>) and called get_result again. Every tool output was checked for roster names, nicknames, other_names values and identifiers from eval/tasks.jsonl, plus guard.leaks.

## Result

| Measure | Value |
|---|---|
| Time from run_private_task to the result Muse read (includes the 2 s get_result poll) | 84.9 s |
| Time for the job itself, jobs.created_at to finished_at (24 essays graded, files written) | 64.6 s |
| First get_result after the job | waiting |
| Router decision | ask_user (model) |
| Approved on the page | yes |
| Final status Muse saw | shared |
| Feedback files with real names | 24, all under BASE_HOME/output/<job id>/ |
| Leaks found in tool outputs | 0 |
| Glimmer calls | 28 |
| Tokens (prompt / completion / of which reasoning) | 32906 / 14593 / 9678 |

## Steps and the model that did each

| Step | Calls | Client role | Model | Backend | Device | Latency |
|---|---|---|---|---|---|---|
| Grade one essay | 24 | answer | meta/muse-glimmer-30b | openrouter | laptop | 9.8 s mean, 8.4 s median, 22.0 s max |
| Second pass for names | 2 | answer | meta/muse-glimmer-30b | openrouter | laptop | 2.6 s mean, 2.8 s median, 2.8 s max |
| Privacy router | 1 | router | meta/muse-glimmer-30b | openrouter | laptop | 7.0 s mean, 7.0 s median, 7.0 s max |
| Request topics | 1 | answer | meta/muse-glimmer-30b | openrouter | laptop | 8.3 s mean, 8.3 s median, 8.3 s max |

The agent's own step log (jobs.model_log) agrees: 24 grading steps, via ['local'], model ['meta/muse-glimmer-30b'], step latency 9.8 s mean, 8.4 s median, 22.0 s max.
Up to 4 grading steps run at once on the cloud backend.

## Timeline

| Point | Seconds after the call |
|---|---|
| list_documents | 2.4 |
| get_result after the job: waiting | 84.8 |
| approved on the page API, then get_result | 84.9 |

## Leaks

None.

Only the invented demo data was sent to OpenRouter. On the shipping backend (llama_server) the same calls go to Glimmer on the device.
Raw rows: raw/e2e_cloud.jsonl next to this report (call kinds, models, latencies, tokens and job times; no text).

## Against the last run

Against the run in commit 8afe137: Muse waited 84.9 s here against 30.1 s then, with about the same tokens (14593 completion tokens against 14307). The grading steps took 9.8 s mean against 4.1 s, because OpenRouter served Glimmer more slowly at this time (see final/cloud_speed.md), not because the job did more work.

## Cost

OpenRouter spend, from the API key's total usage read just before and just after the run (anything else billed to the key in that window would count too): $0.0231 for this test alone, run as its own pytest command (89 s of wall time, 11:47:12 to 11:48:41 ET). The key's usage rose another $0.0057 in the 5 s before the next test started, which may be late billing of this run. Between two runs, with none of them going, the key's usage still rose $0.0065 in 3 min 27 s (11:50:51 to 11:54:18 ET), so other use of the key or late billing can add a few cents to any window.
