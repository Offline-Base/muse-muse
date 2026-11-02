# Simulate a policy, then observe it, before you enforce it

A policy change is a privacy change. Before a new policy file decides what reaches Muse, Muse Privacy can show what it would do in two steps: replay saved items through egress under both policies (simulate), then watch it beside the enforced policy on live results without letting it decide anything (observe). The idea follows Meta Engineering's post "PrivacyLib: Privacy Controls at the Data Access Boundary" (Oct 27, 2026): check the policy where the data leaves, simulate before release, and roll out in stages. Meta Engineering has not reviewed Muse Privacy; this is our version of the idea.

## 1. Simulate: `scripts/simulate_policy.py`

```
uv run python -m scripts.simulate_policy --proposed eval/personas/relaxed_teacher/policy.yaml --set eval/fresh_200.jsonl
```

`--current` defaults to `eval/user_policy.yaml`; `--out` defaults to `eval/reports/policy_sim/<folder>_<policy>__<set>.md`; `--ids` picks items.

What it does. Each item goes through the real exit, `Egress.release`, twice in one throwaway home: once under the current policy, once under the proposed one. Both runs share one tag map, so a difference comes from the policy and not from tags. No model runs: the harness is `scripts/replay_null_names.py`'s, so every call to the device model gets a fixed fake reply (no names found, no request labels), any other network request fails, the repo's `.env` is not read, and routing is `DEVICE_ONLY=1` in rules mode.

What it reports, item by item and in totals. Each item gets an outcome per policy: allow (shared at once, tagged or as a summary), ask (held for the user's OK) or block (kept on the device). A changed item is one of: now allowed, now asks, now blocked, redacted differently (both share it, but the text sent differs, such as a summary in place of the tagged text), or the same outcome for another reason code. The report also counts items with a leak in what Muse got under each policy, and, for eval items, how many of the looser items the hand labels say should be asked about or kept. It holds ids, outcomes, fixed reason codes and leak kinds, never an item's text.

What has run (Nov 2, Simulated, invented data, no model). The eval teacher's policy against the relaxed teacher persona's policy:

- `eval/fresh_200.jsonl`: 42 of 200 items go from ask to allow, none get stricter, no leaks under either policy. 34 of those 42 have a hand label of ask_user or refuse. Report: [eval/reports/policy_sim/relaxed_teacher_policy__fresh_200.md](../eval/reports/policy_sim/relaxed_teacher_policy__fresh_200.md).
- `eval/tasks.jsonl`: 8 of 100 go from ask to allow, all 8 labeled ask_user or refuse. Report: [eval/reports/policy_sim/relaxed_teacher_policy__tasks.md](../eval/reports/policy_sim/relaxed_teacher_policy__tasks.md).

`tests/test_simulate_policy.py` runs it on four invented items with a known diff (one now allowed, one now blocked by a new never-share topic, two the same).

## 2. Observe: `mode: observe` and `OBSERVE_POLICY`

A policy file may say `mode: observe` (the default, and the only mode `USER_POLICY` accepts, is `enforce`). Set `OBSERVE_POLICY` to such a file and, for each result egress releases, the device works out what that candidate would decide and appends one line to `BASE_HOME/observe.jsonl`: the enforced decision, what the current policy decides on the rules path, what the candidate decides, their reason codes, whether the change is stricter or looser, and whether the candidate would block or allow what the enforced decision did not. `later_checks` marks a line where egress's own checks after the router (a privacy toggle, Prompt Guard, SAM, the summary) were on or changed the enforced decision; those checks would hold the candidate's result too, so such a line never counts as would_allow. `base/observe.py` `totals()` counts a log. Unset, nothing is loaded and nothing is written.

How it is built so it cannot loosen anything:

- `Egress._observe` returns nothing. The enforced decision, the text Muse gets and the decision rows are made before and after it exactly as without it (`tests/test_observe.py::test_observe_changes_nothing_muse_gets_or_the_decision_rows`, with a candidate that shares everything and one that refuses everything).
- Any error in the observe step is logged and skipped; the result goes on as enforced (`test_a_broken_observe_step_changes_nothing`).
- The candidate never sees a model: its router is a rules-only router with a client that raises if called.
- `USER_POLICY` with `mode: observe` is refused at start, so a candidate cannot become the enforced policy by mistake, and `OBSERVE_POLICY` without `mode: observe` is refused too.
- A line holds kinds, decisions and fixed codes only, never the result, the request, a tag or a value (`test_an_observe_line_holds_no_text`).

The intended rollout: simulate on saved items, then observe on real use for a while, read the log, and only then copy the candidate into `USER_POLICY` (removing `mode: observe`). Observe has run only in tests, on invented results; it has not run on a device in use.

## Honest limits

- **No model, so no request labels.** The device model labels who a request is for (parents, third_party, full_text, deanonymize). Simulate gets none, so a rule that waits on one of those labels fires only where a code floor (`router._OUTSIDE`, `_CONTACT`, `_NARROWED`) catches the wording. Observe reuses the labels the device model gave for the enforced policy, so a request topic only the candidate defines is never labeled.
- **Rules path only.** Both tools decide in code (the policy, learned rules and floors). If the device routes with a model (`ROUTER_TRUST=decide` or tighten, or not device-only), its live decisions can differ; observe's lines compare the two policies on the rules path and also record what was enforced.
- **The name pass finds nothing in simulate.** That is the worst case for leaks, which the guard and the final check must still catch; it is not how the device behaves with a model up.
- **Not every hold is covered.** Results egress holds on its own (a privacy toggle without device-only, a failed name, topic or summary check) get no observe line. Simulate runs with the toggles off and answers no approval card, so it says nothing about what happens after the user taps Share.
- **The observe log is not purged.** BASE_HOME/observe.jsonl holds no text, but it keeps a time, a tool and decisions for every result, and the retention toggles (base/retention.py) do not delete it. Delete it by hand when the trial ends.
- **Saved items, not a saved egress log.** Simulate reads JSONL items in the eval format. The device's decision log keeps only tagged text, never the raw result, so replaying it would route already-tagged text rather than what the device saw; that import is not built.
- **Sealed sets are refused** (`eval/splits/fresh_200_c.jsonl` and the pool it is drawn from), as in `scripts/replay_null_names.py`.
- The numbers above are from invented items and two invented policies. They describe those files, not any real teacher's use.
