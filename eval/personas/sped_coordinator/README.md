# A simulated special education coordinator (invented)

Simulated persona, invented data. This is not a person: it is a policy file (policy.yaml) plus seeded answering habits (persona.yaml, read by eval/persona.py). Its judgment comes from those files, nothing else.

IEP results are her work, so `iep` is an ask_first topic: a result about an IEP waits for her OK instead of being refused, and she approves it each time without remembering. Medical, discipline and the other never-share topics are refused. Requests for other staff wait for her OK every time.

What it tests: the ask_first floor and the request:<topic> path, which the strict teacher never reaches, and that dreaming never learns a share rule that would skip them.

Items: eval/sim/days.jsonl, eval/sim/holdout.jsonl and eval/sim/unseen.jsonl (the SIM-1 split, invented items written by Muse Spark), relabeled with this persona's policy by `uv run python -m scripts.relabel_for_persona --persona eval/personas/{pid}/persona.yaml` into days.jsonl, holdout.jsonl and unseen.jsonl here. Until that split exists, the sets are not written.

Run: see eval/reports/sim/PLAN.md for the pre-registered command, seeds and nights.
